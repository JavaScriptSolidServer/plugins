// CalDAV (RFC 4791) over a pod calendar as a #206 loader plugin (issue: the DAV
// family — webdav → carddav → caldav).
//
//   plugins: [{ module: 'caldav/plugin.js', prefix: '/caldav',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000',
//                         calendar: 'calendar' } }]
//
// CalDAV is WebDAV (RFC 4918) plus calendar semantics (RFC 4791), so this port
// is the webdav/ bridge specialised for events — the *exact* sibling of
// carddav/, with calendar semantics substituted for addressbook ones. Every
// request under the prefix is replayed as a Solid/LDP request against the host
// itself over LOOPBACK HTTP, carrying the client's own Authorization — so the
// host's real auth + WAC decide every call and the bridge holds no authority of
// its own (the loopback pattern from notifications/, generalised to the data
// plane by webdav/, then carddav/, now caldav/). What CalDAV adds on top of the
// plain WebDAV bridge:
//
//   - each event is a `.ics` resource (iCalendar VEVENT, stored verbatim) under
//     a calendar container (e.g. `<pod>/calendar/`);
//   - PROPFIND marks that container with `<CAL:calendar/>` resourcetype and
//     serves per-event `getetag` + `getcontenttype: text/calendar`, plus the
//     calendar props (`supported-calendar-component-set` = VEVENT, displayname,
//     optional `calendar-color`);
//   - REPORT `calendar-query` / `calendar-multiget` return the VCALENDAR bodies
//     inside `<CAL:calendar-data>`;
//   - REPORT `free-busy-query` (RFC 4791 §7.10) computes merged busy periods
//     from the VEVENTs in range and answers 200 `text/calendar` with a
//     VFREEBUSY; events the caller cannot read are simply not busy-counted
//     (WAC over loopback = privacy for free). A non-standard convenience
//     `GET <prefix>/freebusy/<pod>?start=…&end=…` returns the same VFREEBUSY;
//   - discovery props (`current-user-principal`, `calendar-home-set`) point a
//     phone/Thunderbird at the calendar; `/.well-known/caldav` 301s to it;
//   - MKCALENDAR (RFC 4791's extended MKCOL) creates the calendar collection.
//
// ETags are content hashes computed by the bridge (sha256 of the iCalendar
// bytes): clients need a strong ETag for every sync round-trip, and the plugin
// api exposes no hook onto whatever ETag core may or may not emit — so the
// bridge owns the ETag, deterministically, and GET / PUT / PROPFIND / REPORT all
// agree because identical bytes hash identically. See README "Findings".
//
// Auth: the incoming Authorization is forwarded verbatim on every loopback
// call. Bearer passes through; because the calendar account dialog on iOS /
// macOS / Thunderbird only prompts for user + password, `Basic user:password`
// is bridged to `Bearer <password>` — use any username and a pod token as the
// password.

import { createHash, randomUUID } from 'node:crypto';

const CAL_NS = 'urn:ietf:params:xml:ns:caldav';
const CS_NS = 'http://calendarserver.org/ns/';
const ICAL_NS = 'http://apple.com/ns/ical/';
const DAV_ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT, MKCOL, MKCALENDAR';
const XML_TYPE = 'application/xml; charset=utf-8';
const ICAL_TYPE = 'text/calendar';

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

/** Strong ETag = quoted sha256 (first 32 hex) of the exact stored bytes. */
function etagFor(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  return `"${createHash('sha256').update(buf).digest('hex').slice(0, 32)}"`;
}

/** Last path segment, decoded ('/a/b.ics' -> 'b.ics', '/a/b/' -> 'b'). */
function displayName(path) {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(base) || '/';
  } catch {
    return base || '/';
  }
}

function multistatus(responses) {
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + `<D:multistatus xmlns:D="DAV:" xmlns:CAL="${CAL_NS}" xmlns:CS="${CS_NS}" xmlns:IC="${ICAL_NS}">\n`
    + responses.join('\n')
    + '\n</D:multistatus>';
}

/** One <D:response> with a 200 propstat carrying `props`, and optional 404 set. */
function response(href, props, notFound = []) {
  let out = `<D:response><D:href>${xmlEscape(href)}</D:href>`;
  if (props.length) {
    out += `<D:propstat><D:prop>${props.join('')}</D:prop>`
      + '<D:status>HTTP/1.1 200 OK</D:status></D:propstat>';
  }
  if (notFound.length) {
    out += `<D:propstat><D:prop>${notFound.join('')}</D:prop>`
      + '<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>';
  }
  return out + '</D:response>';
}

// ------------------------------------------------------------------ iCalendar
// Free-busy is the first place the bridge *reads* the iCalendar bytes it
// otherwise stores verbatim; the parser below is deliberately minimal — just
// enough of RFC 5545 to compute busy periods (unfold, VEVENT properties,
// date/date-time, DURATION, DAILY/WEEKLY RRULE). See README "Findings".

/** RFC 5545 §3.1 unfolding: a line starting with SP/HTAB continues the previous. */
function unfoldIcal(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Parse an iCalendar DATE ('20260720') or DATE-TIME ('20260720T090000[Z]').
 * TZID-qualified and floating times are treated as UTC — the bridge does not
 * evaluate VTIMEZONE (documented limitation). Returns { ms, dateOnly } | null.
 */
function parseIcalStamp(value) {
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(value || '');
  if (m) return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3]), dateOnly: true };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value || '');
  if (m) return { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), dateOnly: false };
  return null;
}

/** RFC 5545 DURATION ('P1DT2H30M', 'PT1H', 'P2W', '-PT15M') → milliseconds | null. */
function parseIcalDuration(value) {
  const m = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value || '');
  if (!m || /^[+-]?P$/.test(value)) return null;
  const [, sign, w, d, h, min, s] = m;
  const ms = ((+(w || 0) * 7 + +(d || 0)) * 86400 + +(h || 0) * 3600 + +(min || 0) * 60 + +(s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** RRULE value ('FREQ=DAILY;COUNT=3') → uppercased { FREQ, COUNT, … }. */
function parseRrule(value) {
  const rule = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) rule[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim();
  }
  return rule;
}

/** Every VEVENT in an iCalendar body as [{ name, value }] property lists. */
function parseVevents(ics) {
  const events = [];
  let current = null;
  for (const line of unfoldIcal(ics)) {
    if (/^BEGIN:VEVENT$/i.test(line.trim())) {
      current = [];
      continue;
    }
    if (/^END:VEVENT$/i.test(line.trim())) {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    // NAME[;param=value…]:VALUE — params (TZID, VALUE=DATE) are not needed:
    // the stamp grammar distinguishes DATE from DATE-TIME by shape.
    const m = /^([A-Za-z0-9-]+)(?:;[^:]*)?:(.*)$/.exec(line);
    if (m) current.push({ name: m[1].toUpperCase(), value: m[2] });
  }
  return events;
}

/**
 * Busy periods (clamped to [rangeStart, rangeEnd) ms) contributed by one
 * VEVENT. Transparent and cancelled events are free (RFC 4791 §7.10).
 * Recurrence: FREQ=DAILY|WEEKLY with INTERVAL/COUNT/UNTIL is expanded; any
 * other FREQ or a BY* part falls back to the master occurrence only — an
 * honest under-report, documented in the README.
 */
function veventBusyPeriods(props, rangeStart, rangeEnd) {
  const get = (name) => props.find((p) => p.name === name);
  if ((get('TRANSP')?.value || '').trim().toUpperCase() === 'TRANSPARENT') return [];
  if ((get('STATUS')?.value || '').trim().toUpperCase() === 'CANCELLED') return [];
  const start = parseIcalStamp(get('DTSTART')?.value);
  if (!start) return [];

  let durMs = null;
  const end = parseIcalStamp(get('DTEND')?.value);
  if (end) durMs = end.ms - start.ms;
  else if (get('DURATION')) durMs = parseIcalDuration(get('DURATION').value);
  if (durMs == null) durMs = start.dateOnly ? 86400000 : 0; // RFC 5545 §3.6.1 defaults
  if (durMs <= 0) return [];

  const starts = [];
  const rrule = get('RRULE') ? parseRrule(get('RRULE').value) : null;
  const expandable = rrule
    && (rrule.FREQ === 'DAILY' || rrule.FREQ === 'WEEKLY')
    && !Object.keys(rrule).some((k) => k.startsWith('BY'));
  if (expandable) {
    const interval = Math.max(1, parseInt(rrule.INTERVAL || '1', 10) || 1);
    const stepMs = (rrule.FREQ === 'WEEKLY' ? 7 : 1) * 86400000 * interval;
    const count = rrule.COUNT ? parseInt(rrule.COUNT, 10) : Infinity;
    const until = rrule.UNTIL ? (parseIcalStamp(rrule.UNTIL)?.ms ?? -Infinity) : Infinity;
    for (let i = 0, t = start.ms; i < count && t <= until && t < rangeEnd && i < 10000; i += 1, t += stepMs) {
      starts.push(t);
    }
  } else {
    starts.push(start.ms);
  }

  const periods = [];
  for (const s of starts) {
    const cs = Math.max(s, rangeStart);
    const ce = Math.min(s + durMs, rangeEnd);
    if (cs < ce) periods.push([cs, ce]);
  }
  return periods;
}

/** Sort + merge overlapping/adjacent [startMs, endMs] periods. */
function mergePeriods(periods) {
  const sorted = [...periods].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length && s <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

/** ms epoch → iCalendar UTC date-time ('20260720T090000Z'). */
function fmtIcalUtc(ms) {
  return new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '');
}

/** The VFREEBUSY response body (CRLF, RFC 4791 §7.10.8-style). */
function buildVfreebusy(rangeStart, rangeEnd, merged) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JSS caldav bridge//EN',
    'BEGIN:VFREEBUSY',
    `UID:${randomUUID()}`,
    `DTSTAMP:${fmtIcalUtc(Date.now())}`,
    `DTSTART:${fmtIcalUtc(rangeStart)}`,
    `DTEND:${fmtIcalUtc(rangeEnd)}`,
    ...merged.map(([s, e]) => `FREEBUSY:${fmtIcalUtc(s)}/${fmtIcalUtc(e)}`),
    'END:VFREEBUSY',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

export async function activate(api) {
  const prefix = api.prefix || '/caldav';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'caldav plugin requires config.baseUrl — the plugin api exposes no server origin '
      + '(same finding as webdav/, carddav/ and notifications/); optional config.loopbackUrl '
      + 'overrides where the bridge reaches the host',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  // The container name that carries the calendar resourcetype. A collection
  // whose final segment is this is advertised as a CAL:calendar.
  const calName = api.config.calendar || 'calendar';
  // Optional Apple calendar colour, echoed as IC:calendar-color.
  const calColor = api.config.color || null;

  // ---------------------------------------------------------------- auth
  function bridgeAuth(request) {
    const raw = request.headers.authorization;
    if (!raw) return null;
    if (/^basic\s/i.test(raw)) {
      try {
        const decoded = Buffer.from(raw.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        const password = colon === -1 ? decoded : decoded.slice(colon + 1);
        if (password) return `Bearer ${password}`;
      } catch { /* fall through, forward as-is */ }
    }
    return raw;
  }

  function unauthorized(reply) {
    return reply.code(401)
      .header('WWW-Authenticate', 'Basic realm="Solid pod (any username, pod token as password)"')
      .send();
  }

  // ------------------------------------------------------------ loopback
  /** The LDP path a URL under the prefix addresses ('/', '/alice/calendar/', …). */
  function hostPath(url) {
    let rest = url.split('?')[0].slice(prefix.length);
    if (!rest.startsWith('/')) rest = '/' + rest;
    if (rest.split('/').includes('..')) return null;
    return rest;
  }

  /** Map a client-sent href (absolute path or full URL) to an LDP path. */
  function hrefToHostPath(href) {
    let pathname = href;
    try {
      pathname = new URL(href, baseUrl).pathname;
    } catch { /* already a path */ }
    if (!pathname.startsWith(prefix)) return null;
    return hostPath(pathname);
  }

  function lb(path, { method = 'GET', headers = {}, body } = {}, auth) {
    return fetch(loopback + path, {
      method,
      redirect: 'manual',
      headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
  }

  /** GET a resource; returns { res, body:Buffer|null, etag }. */
  async function getResource(path, auth) {
    const res = await lb(path, { headers: { accept: ICAL_TYPE } }, auth);
    if (!res.ok) return { res, body: null, etag: null };
    const body = Buffer.from(await res.arrayBuffer());
    return { res, body, etag: etagFor(body) };
  }

  /** GET a container listing as JSON-LD; { res, listing|null }. */
  async function fetchListing(containerPath, auth) {
    const res = await lb(containerPath, { headers: { accept: 'application/ld+json' } }, auth);
    if (!res.ok) return { res, listing: null };
    if (!(res.headers.get('content-type') || '').includes('json')) return { res, listing: null };
    try {
      return { res, listing: await res.json() };
    } catch {
      return { res, listing: null };
    }
  }

  /** LDP paths of a container's children, resolved against baseUrl+path. */
  function childPaths(listing, path) {
    const out = [];
    for (const child of [].concat(listing?.contains ?? [])) {
      const id = typeof child === 'string' ? child : child['@id'];
      if (!id) continue;
      try {
        out.push(new URL(id, baseUrl + path).pathname);
      } catch { /* skip unparseable */ }
    }
    return out;
  }

  const isCalendar = (path) => {
    const p = path.endsWith('/') ? path.slice(0, -1) : path;
    return p.slice(p.lastIndexOf('/') + 1) === calName;
  };

  const readBody = (request) => {
    const b = request.body;
    if (b == null) return '';
    if (Buffer.isBuffer(b)) return b.toString('utf8');
    if (typeof b === 'string') return b;
    return String(b);
  };

  /** Which props a PROPFIND/REPORT body asked for (empty body => allprop). */
  function requestedProps(xml) {
    const want = new Set();
    if (!xml || /<[A-Za-z:]*allprop\b/.test(xml)) {
      ['resourcetype', 'getetag', 'getcontenttype', 'displayname'].forEach((p) => want.add(p));
      return { want, all: true };
    }
    for (const p of [
      'resourcetype', 'getetag', 'getcontenttype', 'getcontentlength', 'displayname',
      'current-user-principal', 'principal-URL', 'calendar-home-set',
      'calendar-data', 'calendar-description', 'supported-calendar-component-set',
      'supported-calendar-data', 'calendar-color', 'calendar-timezone',
      'getctag', 'sync-token', 'supported-report-set',
    ]) {
      if (new RegExp(`[:<]${p}\\b`, 'i').test(xml)) want.add(p);
    }
    if (want.size === 0) want.add('resourcetype');
    return { want, all: false };
  }

  // ------------------------------------------------------------- methods
  function handleOptions(request, reply) {
    return reply.code(200)
      .header('DAV', '1, 3, calendar-access')
      .header('MS-Author-Via', 'DAV')
      .header('Allow', DAV_ALLOW)
      .send();
  }

  /** Build the prop XML for a collection at `path`, honouring `want`. */
  function collectionProps(path, want, pod) {
    const props = [];
    const found = [];
    const cal = isCalendar(path);
    if (want.has('resourcetype')) {
      const kinds = '<D:collection/>' + (cal ? '<CAL:calendar/>' : '');
      found.push(`<D:resourcetype>${kinds}</D:resourcetype>`);
    }
    if (want.has('displayname')) {
      found.push(`<D:displayname>${xmlEscape(displayName(path))}</D:displayname>`);
    }
    if (want.has('getcontenttype')) found.push('<D:getcontenttype>httpd/unix-directory</D:getcontenttype>');
    if (want.has('current-user-principal') || want.has('principal-URL')) {
      const href = pod ? `${prefix}/${pod}/` : `${prefix}${path}`;
      if (want.has('current-user-principal')) {
        found.push(`<D:current-user-principal><D:href>${xmlEscape(href)}</D:href></D:current-user-principal>`);
      }
      if (want.has('principal-URL')) {
        found.push(`<D:principal-URL><D:href>${xmlEscape(href)}</D:href></D:principal-URL>`);
      }
    }
    if (want.has('calendar-home-set')) {
      const home = pod ? `${prefix}/${pod}/` : `${prefix}${path}`;
      found.push(`<CAL:calendar-home-set><D:href>${xmlEscape(home)}</D:href></CAL:calendar-home-set>`);
    }
    if (want.has('calendar-description') && cal) {
      found.push(`<CAL:calendar-description>${xmlEscape(displayName(path))}</CAL:calendar-description>`);
    }
    if (want.has('supported-calendar-component-set') && cal) {
      found.push('<CAL:supported-calendar-component-set>'
        + '<CAL:comp name="VEVENT"/>'
        + '</CAL:supported-calendar-component-set>');
    }
    if (want.has('supported-calendar-data') && cal) {
      found.push('<CAL:supported-calendar-data>'
        + '<CAL:calendar-data content-type="text/calendar" version="2.0"/>'
        + '</CAL:supported-calendar-data>');
    }
    if (want.has('calendar-color') && cal && calColor) {
      found.push(`<IC:calendar-color>${xmlEscape(calColor)}</IC:calendar-color>`);
    }
    if (want.has('supported-report-set')) {
      const reports = ['<CAL:calendar-query/>', '<CAL:calendar-multiget/>', '<CAL:free-busy-query/>'];
      found.push('<D:supported-report-set>'
        + reports.map((r) => `<D:supported-report><D:report>${r}</D:report></D:supported-report>`).join('')
        + '</D:supported-report-set>');
    }
    // A container has no body, hence no ETag; treat getetag as "not found".
    const missing = [];
    if (want.has('getetag')) missing.push('<D:getetag/>');
    props.push(...found);
    return { props, missing };
  }

  async function handlePropfind(request, reply, pathOverride) {
    const auth = bridgeAuth(request);
    let path = pathOverride ?? hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    const depth = String(request.headers.depth ?? '0').trim() === '1' ? 1 : 0;
    const { want } = requestedProps(readBody(request));

    // Discovery props need the pod (first path segment of the caller's WebID).
    let pod = null;
    if (want.has('current-user-principal') || want.has('principal-URL') || want.has('calendar-home-set')) {
      const agent = await api.auth.getAgent(request);
      if (!agent) return unauthorized(reply);
      try {
        const seg = new URL(agent).pathname.split('/').filter(Boolean)[0];
        if (seg) pod = seg;
      } catch { /* did:… WebID — leave pod null, echo request path */ }
    }

    // A slash-less path may still be a container (client probing the calendar).
    if (path !== '/' && !path.endsWith('/')) {
      const head = await lb(path, { method: 'HEAD' }, auth);
      if (head.status === 401) return unauthorized(reply);
      if (/ldp#(Basic)?Container>;\s*rel="type"/.test(head.headers.get('link') || '')) {
        path += '/';
      }
    }

    const responses = [];
    if (path === '/' || path.endsWith('/')) {
      const { res, listing } = await fetchListing(path, auth);
      if (res.status === 401) return unauthorized(reply);
      if (!res.ok && res.status !== 404) return reply.code(res.status).send();
      const { props, missing } = collectionProps(path, want, pod);
      responses.push(response(prefix + path, props, missing));
      if (depth === 1 && listing) {
        for (const childPath of childPaths(listing, path)) {
          if (childPath === path) continue;
          if (childPath.endsWith('/')) {
            const { props: cp, missing: cm } = collectionProps(childPath, want, pod);
            responses.push(response(prefix + childPath, cp, cm));
          } else {
            responses.push(await resourceResponse(childPath, want, auth));
          }
        }
      }
    } else {
      responses.push(await resourceResponse(path, want, auth));
    }
    return reply.code(207).header('content-type', XML_TYPE).send(multistatus(responses));
  }

  /** <D:response> for a single (non-collection) resource, fetched for its ETag. */
  async function resourceResponse(path, want, auth, includeData = false) {
    const props = [];
    const missing = [];
    let body = null;
    if (want.has('getetag') || want.has('getcontentlength') || includeData || want.has('calendar-data')) {
      const got = await getResource(path, auth);
      if (got.body) {
        body = got.body;
        if (want.has('getetag')) props.push(`<D:getetag>${got.etag}</D:getetag>`);
        if (want.has('getcontentlength')) props.push(`<D:getcontentlength>${body.length}</D:getcontentlength>`);
        if (includeData || want.has('calendar-data')) {
          props.push(`<CAL:calendar-data>${xmlEscape(body.toString('utf8'))}</CAL:calendar-data>`);
        }
      } else if (want.has('getetag')) {
        missing.push('<D:getetag/>');
      }
    }
    if (want.has('resourcetype')) props.push('<D:resourcetype/>');
    if (want.has('getcontenttype')) props.push(`<D:getcontenttype>${ICAL_TYPE}</D:getcontenttype>`);
    if (want.has('displayname')) props.push(`<D:displayname>${xmlEscape(displayName(path))}</D:displayname>`);
    return response(prefix + path, props, missing);
  }

  /**
   * Compute merged busy periods over every readable VEVENT in `collPath` and
   * answer 200 text/calendar with a VFREEBUSY (RFC 4791 §7.10). Each event is
   * fetched over loopback with the CALLER's credentials, so an event WAC hides
   * from the caller is skipped — invisible, not busy (correct privacy).
   */
  async function handleFreeBusy(reply, collPath, rangeStart, rangeEnd, auth) {
    const coll = collPath.endsWith('/') ? collPath : collPath + '/';
    const { res, listing } = await fetchListing(coll, auth);
    if (res.status === 401) return unauthorized(reply);
    if (!res.ok) return reply.code(res.status).send();
    const periods = [];
    for (const childPath of childPaths(listing, coll)) {
      if (childPath.endsWith('/') || !childPath.endsWith('.ics')) continue;
      const got = await getResource(childPath, auth); // unreadable → skipped, not busy
      if (!got.body) continue;
      for (const props of parseVevents(got.body.toString('utf8'))) {
        periods.push(...veventBusyPeriods(props, rangeStart, rangeEnd));
      }
    }
    return reply.code(200)
      .header('content-type', ICAL_TYPE)
      .send(buildVfreebusy(rangeStart, rangeEnd, mergePeriods(periods)));
  }

  /** The <CAL:time-range start end/> of a free-busy-query; null if malformed. */
  function freeBusyRange(xml) {
    const tr = /<[A-Za-z]*:?time-range\b([^>]*)\/?>/i.exec(xml);
    if (!tr) return null;
    const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tr[1])?.[1];
    const rawStart = attr('start');
    const rawEnd = attr('end');
    // RFC 4791 §9.9: start/end MUST be UTC date-times.
    if (!/Z$/.test(rawStart || '') || !/Z$/.test(rawEnd || '')) return null;
    const start = parseIcalStamp(rawStart);
    const end = parseIcalStamp(rawEnd);
    if (!start || !end || start.dateOnly || end.dateOnly || start.ms >= end.ms) return null;
    return { start: start.ms, end: end.ms };
  }

  async function handleReport(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    const xml = readBody(request);

    if (/<[A-Za-z]*:?free-busy-query\b/i.test(xml)) {
      const range = freeBusyRange(xml);
      if (!range) return reply.code(400).send(); // missing/malformed time-range
      return handleFreeBusy(reply, path, range.start, range.end, auth);
    }

    const multiget = /<[A-Za-z:]*calendar-multiget\b/i.test(xml);
    // Both report types return calendar-data + getetag for the matched events.

    const responses = [];
    if (multiget) {
      // multiget: the client lists exactly the hrefs it wants back.
      const hrefs = [...xml.matchAll(/<[A-Za-z]*:?href>\s*([^<]+?)\s*<\/[A-Za-z]*:?href>/gi)].map((m) => m[1]);
      for (const href of hrefs) {
        const hp = hrefToHostPath(href.trim());
        if (!hp) {
          responses.push(`<D:response><D:href>${xmlEscape(href.trim())}</D:href>`
            + '<D:status>HTTP/1.1 404 Not Found</D:status></D:response>');
          continue;
        }
        const got = await getResource(hp, auth);
        if (got.body) {
          responses.push(response(prefix + hp, [
            `<D:getetag>${got.etag}</D:getetag>`,
            `<D:getcontenttype>${ICAL_TYPE}</D:getcontenttype>`,
            `<CAL:calendar-data>${xmlEscape(got.body.toString('utf8'))}</CAL:calendar-data>`,
          ]));
        } else {
          responses.push(`<D:response><D:href>${xmlEscape(prefix + hp)}</D:href>`
            + '<D:status>HTTP/1.1 404 Not Found</D:status></D:response>');
        }
      }
    } else {
      // calendar-query: MVP returns every event in the collection (the
      // <CAL:filter> comp/time-range grammar is not evaluated — see README).
      let coll = path.endsWith('/') ? path : path + '/';
      const { res, listing } = await fetchListing(coll, auth);
      if (res.status === 401) return unauthorized(reply);
      if (!res.ok) return reply.code(res.status).send();
      for (const childPath of childPaths(listing, coll)) {
        if (childPath.endsWith('/') || !childPath.endsWith('.ics')) continue;
        const got = await getResource(childPath, auth);
        if (!got.body) continue;
        responses.push(response(prefix + childPath, [
          `<D:getetag>${got.etag}</D:getetag>`,
          `<D:getcontenttype>${ICAL_TYPE}</D:getcontenttype>`,
          `<CAL:calendar-data>${xmlEscape(got.body.toString('utf8'))}</CAL:calendar-data>`,
        ]));
      }
    }
    return reply.code(207).header('content-type', XML_TYPE).send(multistatus(responses));
  }

  async function handleGetHead(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();

    // Non-standard convenience (documented extension): GET
    // <prefix>/freebusy/<pod>?start=…&end=… returns the same VFREEBUSY as the
    // free-busy-query REPORT over <pod>/<calName>/. Stamps accept iCalendar
    // basic ('20260720T000000Z') or anything Date.parse takes (ISO 8601).
    // Only intercepts when a start/end param is present, so a pod literally
    // named 'freebusy' keeps its plain GETs.
    const fb = /^\/freebusy\/([^/]+)\/?$/.exec(path);
    if (request.raw.method === 'GET' && fb && (request.query?.start || request.query?.end)) {
      const stamp = (v) => {
        const p = typeof v === 'string' ? parseIcalStamp(v) : null;
        if (p) return p.ms;
        const t = typeof v === 'string' ? Date.parse(v) : NaN;
        return Number.isNaN(t) ? null : t;
      };
      const start = stamp(request.query.start);
      const end = stamp(request.query.end);
      if (start == null || end == null || start >= end) return reply.code(400).send();
      return handleFreeBusy(reply, `/${fb[1]}/${calName}/`, start, end, auth);
    }

    const fwd = {};
    for (const h of ['if-match', 'if-none-match']) {
      if (request.headers[h]) fwd[h] = request.headers[h];
    }
    const res = await lb(path, { method: request.raw.method, headers: fwd }, auth);
    if (res.status === 401) return unauthorized(reply);
    if (!res.ok) return reply.code(res.status).send();
    const body = Buffer.from(await res.arrayBuffer());
    reply.code(res.status)
      .header('content-type', path.endsWith('.ics') ? ICAL_TYPE : (res.headers.get('content-type') || ICAL_TYPE))
      .header('etag', etagFor(body));
    return reply.send(request.raw.method === 'HEAD' ? undefined : body);
  }

  /** Ensure the calendar container exists (idempotent; 409 = already there). */
  async function ensureContainer(icsPath, auth) {
    const container = icsPath.slice(0, icsPath.lastIndexOf('/') + 1);
    const head = await lb(container, { method: 'HEAD' }, auth);
    if (head.ok) return true;
    if (head.status === 401 || head.status === 403) return false;
    const mk = await lb(container, { method: 'PUT' }, auth);
    return mk.ok || mk.status === 409;
  }

  async function handlePut(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    let body = request.body;
    if (body == null) body = Buffer.alloc(0);
    else if (typeof body === 'string') body = Buffer.from(body, 'utf8');
    else if (!Buffer.isBuffer(body)) body = Buffer.from(String(body), 'utf8');

    // Auto-create the calendar on first event (per the MKCALENDAR-or-auto-
    // create option). Best-effort: if it fails, let the PUT report the real error.
    if (path.endsWith('.ics')) await ensureContainer(path, auth);

    const headers = { 'content-type': request.headers['content-type'] || ICAL_TYPE };
    if (request.headers['if-match']) headers['if-match'] = request.headers['if-match'];
    if (request.headers['if-none-match']) headers['if-none-match'] = request.headers['if-none-match'];
    const res = await lb(path, { method: 'PUT', headers, body }, auth);
    if (res.status === 401) return unauthorized(reply);
    if (!res.ok) return reply.code(res.status).send();
    // Clients key their sync on the ETag returned here; hand back the content
    // hash of exactly what we stored.
    return reply.code(res.status).header('etag', etagFor(body)).send();
  }

  async function handleDelete(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    const res = await lb(path, { method: 'DELETE' }, auth);
    if (res.status === 401) return unauthorized(reply);
    return reply.code(res.ok ? 204 : res.status).send();
  }

  /** MKCOL / MKCALENDAR: create the (calendar) container. */
  async function handleMkcol(request, reply) {
    const auth = bridgeAuth(request);
    let path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    // MKCALENDAR (RFC 4791) and extended MKCOL (RFC 5689) carry a body of props
    // (resourcetype calendar, displayname, supported-calendar-component-set,
    // calendar-color…). JSS has no place for those props, so we accept the body
    // and create the plain LDP container — the calendar resourcetype is derived
    // from the container name at PROPFIND time.
    if (!path.endsWith('/')) path += '/';
    const res = await lb(path, { method: 'PUT' }, auth);
    if (res.status === 401) return unauthorized(reply);
    if (res.status === 409) return reply.code(405).send(); // exists → MKCOL/MKCALENDAR not allowed
    return reply.code(res.status).send(); // 201 on success
  }

  // -------------------------------------------------- well-known discovery
  async function handleWellKnown(request, reply) {
    if (request.raw.method === 'PROPFIND') {
      // Some clients PROPFIND the well-known path directly for
      // current-user-principal; serve it as a discovery PROPFIND at root.
      return handlePropfind(request, reply, '/');
    }
    // GET/others: 301 to the prefix root, where discovery PROPFIND lives.
    return reply.code(301).header('location', `${prefix}/`).send();
  }

  // -------------------------------------------------------------- routes
  const handlers = {
    OPTIONS: handleOptions,
    PROPFIND: (req, rep) => handlePropfind(req, rep),
    REPORT: handleReport,
    GET: handleGetHead,
    HEAD: handleGetHead,
    PUT: handlePut,
    DELETE: handleDelete,
    MKCOL: handleMkcol,
    MKCALENDAR: handleMkcol,
  };
  const dispatch = (request, reply) => handlers[request.raw.method](request, reply);
  for (const url of [prefix, `${prefix}/*`]) {
    api.fastify.route({
      method: Object.keys(handlers),
      url,
      exposeHeadRoutes: false,
      handler: dispatch,
    });
  }

  // Attempt the reserved discovery path. Same guarded attempt nip05/, carddav/
  // and webdav-adjacent ports make: core does NOT confine plugin routes to the
  // prefix and blanket-exempts /.well-known/* from WAC, so an exact-path
  // registration works today and outranks the LDP GET wildcard — but nothing
  // in the plugin CONTRACT promises it, so a failure is degraded, not fatal.
  let wellKnown = false;
  try {
    api.fastify.route({
      method: ['GET', 'PROPFIND', 'HEAD'],
      url: '/.well-known/caldav',
      handler: handleWellKnown,
    });
    wellKnown = true;
  } catch (err) {
    api.log.warn(`caldav: could not claim /.well-known/caldav (${err.message}); `
      + `clients must be pointed straight at ${prefix}/<pod>/${calName}/`);
  }

  api.log.info(`caldav: RFC 4791 calendar bridge at ${prefix} → ${loopback}`
    + (wellKnown ? ' (+ /.well-known/caldav)' : ''));
}
