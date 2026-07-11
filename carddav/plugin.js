// CardDAV (RFC 6352) over a pod addressbook as a #206 loader plugin (issue #157).
//
//   plugins: [{ module: 'carddav/plugin.js', prefix: '/carddav',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000',
//                         addressbook: 'contacts' } }]
//
// CardDAV is WebDAV (RFC 4918) plus addressbook semantics (RFC 6352), so this
// port is the webdav/ bridge specialised for contacts: every request under the
// prefix is replayed as a Solid/LDP request against the host itself over
// LOOPBACK HTTP, carrying the client's own Authorization — so the host's real
// auth + WAC decide every call and the bridge holds no authority of its own
// (the loopback pattern from notifications/, generalised to the data plane by
// webdav/). What CardDAV adds on top of the plain WebDAV bridge:
//
//   - each contact is a `.vcf` resource (vCard 3.0/4.0, stored verbatim) under
//     an addressbook container (e.g. `<pod>/contacts/`);
//   - PROPFIND marks that container with `<CARD:addressbook/>` resourcetype and
//     serves per-contact `getetag` + `getcontenttype: text/vcard`;
//   - REPORT `addressbook-query` / `addressbook-multiget` return the vCard
//     bodies inside `<CARD:address-data>`;
//   - discovery props (`current-user-principal`, `addressbook-home-set`) point a
//     phone/Thunderbird at the addressbook; `/.well-known/carddav` 301s to it.
//
// ETags are content hashes computed by the bridge (sha256 of the vCard bytes):
// clients need a strong ETag for every sync round-trip, and the plugin api
// exposes no hook onto whatever ETag core may or may not emit — so the bridge
// owns the ETag, deterministically, and GET / PUT / PROPFIND / REPORT all agree
// because identical bytes hash identically. See README "Findings".
//
// Auth: the incoming Authorization is forwarded verbatim on every loopback
// call. Bearer passes through; because the CardDAV account dialog on iOS /
// macOS / Thunderbird / DAVx5 only prompts for user + password, `Basic
// user:password` is bridged to `Bearer <password>` — use any username and a pod
// token as the password.

import { createHash } from 'node:crypto';

const CARD_NS = 'urn:ietf:params:xml:ns:carddav';
const CS_NS = 'http://calendarserver.org/ns/';
const DAV_ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT, MKCOL';
const XML_TYPE = 'application/xml; charset=utf-8';
const VCARD_TYPE = 'text/vcard';

// Cap the number of members a single member-walk / multiget touches, to bound
// the loopback fan-out: each member is a full-body loopback GET, so an uncapped
// walk over an attacker-grown collection (or a multiget with an arbitrarily
// long <href> list) drives N fetches + N full-body buffers per request. A
// collection larger than the cap gets a truncated but valid multistatus rather
// than unbounded work — the same maxResources cap backup/, sparql/, rss/ and
// search/ apply to their loopback walks. Config-overridable via
// config.maxResources.
const DEFAULT_MAX_RESOURCES = 10000;

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

/** Strong ETag = quoted sha256 (first 32 hex) of the exact stored bytes. */
function etagFor(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  return `"${createHash('sha256').update(buf).digest('hex').slice(0, 32)}"`;
}

/** Last path segment, decoded ('/a/b.vcf' -> 'b.vcf', '/a/b/' -> 'b'). */
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
    + `<D:multistatus xmlns:D="DAV:" xmlns:CARD="${CARD_NS}" xmlns:CS="${CS_NS}">\n`
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

export async function activate(api) {
  const prefix = api.prefix || '/carddav';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'carddav plugin requires config.baseUrl — the plugin api exposes no server origin '
      + '(same finding as webdav/ and notifications/); optional config.loopbackUrl overrides '
      + 'where the bridge reaches the host',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  // The container name that carries the addressbook resourcetype. A collection
  // whose final segment is this is advertised as a CARD:addressbook.
  const bookName = api.config.addressbook || 'contacts';
  // Upper bound on members touched by any single member-walk / multiget.
  const maxResources = api.config.maxResources ?? DEFAULT_MAX_RESOURCES;
  /** Truncate a member/href list to the cap, bounding loopback fan-out. */
  const capMembers = (arr) => (arr.length > maxResources ? arr.slice(0, maxResources) : arr);

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
  /** The LDP path a URL under the prefix addresses ('/', '/alice/contacts/', …). */
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
    const res = await lb(path, { headers: { accept: VCARD_TYPE } }, auth);
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

  const isAddressbook = (path) => {
    const p = path.endsWith('/') ? path.slice(0, -1) : path;
    return p.slice(p.lastIndexOf('/') + 1) === bookName;
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
      'current-user-principal', 'principal-URL', 'addressbook-home-set',
      'address-data', 'addressbook-description', 'supported-address-data',
      'getctag', 'sync-token',
    ]) {
      if (new RegExp(`[:<]${p}\\b`, 'i').test(xml)) want.add(p);
    }
    if (want.size === 0) want.add('resourcetype');
    return { want, all: false };
  }

  // ------------------------------------------------------------- methods
  function handleOptions(request, reply) {
    return reply.code(200)
      .header('DAV', '1, 3, addressbook')
      .header('MS-Author-Via', 'DAV')
      .header('Allow', DAV_ALLOW)
      .send();
  }

  /** Build the prop XML for a collection at `path`, honouring `want`. */
  function collectionProps(path, want, pod) {
    const props = [];
    const found = [];
    const missing = [];
    if (want.has('resourcetype')) {
      const kinds = '<D:collection/>' + (isAddressbook(path) ? '<CARD:addressbook/>' : '');
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
    if (want.has('addressbook-home-set')) {
      const home = pod ? `${prefix}/${pod}/` : `${prefix}${path}`;
      found.push(`<CARD:addressbook-home-set><D:href>${xmlEscape(home)}</D:href></CARD:addressbook-home-set>`);
    }
    if (want.has('addressbook-description') && isAddressbook(path)) {
      found.push(`<CARD:addressbook-description>${xmlEscape(displayName(path))}</CARD:addressbook-description>`);
    }
    if (want.has('supported-address-data') && isAddressbook(path)) {
      found.push('<CARD:supported-address-data>'
        + '<CARD:address-data-type content-type="text/vcard" version="3.0"/>'
        + '<CARD:address-data-type content-type="text/vcard" version="4.0"/>'
        + '</CARD:supported-address-data>');
    }
    // A container has no body, hence no ETag; treat getetag as "not found".
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
    if (want.has('current-user-principal') || want.has('principal-URL') || want.has('addressbook-home-set')) {
      const agent = await api.auth.getAgent(request);
      if (!agent) return unauthorized(reply);
      try {
        const seg = new URL(agent).pathname.split('/').filter(Boolean)[0];
        if (seg) pod = seg;
      } catch { /* did:… WebID — leave pod null, echo request path */ }
    }

    // A slash-less path may still be a container (client probing the book).
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
        for (const childPath of capMembers(childPaths(listing, path))) {
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
    if (want.has('getetag') || want.has('getcontentlength') || includeData || want.has('address-data')) {
      const got = await getResource(path, auth);
      if (got.body) {
        body = got.body;
        if (want.has('getetag')) props.push(`<D:getetag>${got.etag}</D:getetag>`);
        if (want.has('getcontentlength')) props.push(`<D:getcontentlength>${body.length}</D:getcontentlength>`);
        if (includeData || want.has('address-data')) {
          props.push(`<CARD:address-data>${xmlEscape(body.toString('utf8'))}</CARD:address-data>`);
        }
      } else if (want.has('getetag')) {
        missing.push('<D:getetag/>');
      }
    }
    if (want.has('resourcetype')) props.push('<D:resourcetype/>');
    if (want.has('getcontenttype')) props.push(`<D:getcontenttype>${VCARD_TYPE}</D:getcontenttype>`);
    if (want.has('displayname')) props.push(`<D:displayname>${xmlEscape(displayName(path))}</D:displayname>`);
    return response(prefix + path, props, missing);
  }

  async function handleReport(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    const xml = readBody(request);
    const multiget = /<[A-Za-z:]*addressbook-multiget\b/i.test(xml);
    // Both report types return address-data + getetag for the matched vCards.
    const want = new Set(['getetag', 'getcontenttype']);

    const responses = [];
    if (multiget) {
      // multiget: the client lists exactly the hrefs it wants back.
      const hrefs = [...xml.matchAll(/<[A-Za-z]*:?href>\s*([^<]+?)\s*<\/[A-Za-z]*:?href>/gi)].map((m) => m[1]);
      for (const href of capMembers(hrefs)) {
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
            `<D:getcontenttype>${VCARD_TYPE}</D:getcontenttype>`,
            `<CARD:address-data>${xmlEscape(got.body.toString('utf8'))}</CARD:address-data>`,
          ]));
        } else {
          responses.push(`<D:response><D:href>${xmlEscape(prefix + hp)}</D:href>`
            + '<D:status>HTTP/1.1 404 Not Found</D:status></D:response>');
        }
      }
    } else {
      // addressbook-query: MVP returns every vCard in the collection (the
      // <CARD:filter> subset is not evaluated — see README).
      let coll = path.endsWith('/') ? path : path + '/';
      const { res, listing } = await fetchListing(coll, auth);
      if (res.status === 401) return unauthorized(reply);
      if (!res.ok) return reply.code(res.status).send();
      for (const childPath of capMembers(childPaths(listing, coll))) {
        if (childPath.endsWith('/') || !childPath.endsWith('.vcf')) continue;
        const got = await getResource(childPath, auth);
        if (!got.body) continue;
        responses.push(response(prefix + childPath, [
          `<D:getetag>${got.etag}</D:getetag>`,
          `<D:getcontenttype>${VCARD_TYPE}</D:getcontenttype>`,
          `<CARD:address-data>${xmlEscape(got.body.toString('utf8'))}</CARD:address-data>`,
        ]));
      }
    }
    return reply.code(207).header('content-type', XML_TYPE).send(multistatus(responses));
  }

  async function handleGetHead(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    const fwd = {};
    for (const h of ['if-match', 'if-none-match']) {
      if (request.headers[h]) fwd[h] = request.headers[h];
    }
    const res = await lb(path, { method: request.raw.method, headers: fwd }, auth);
    if (res.status === 401) return unauthorized(reply);
    if (!res.ok) return reply.code(res.status).send();
    const body = Buffer.from(await res.arrayBuffer());
    reply.code(res.status)
      .header('content-type', path.endsWith('.vcf') ? VCARD_TYPE : (res.headers.get('content-type') || VCARD_TYPE))
      .header('etag', etagFor(body));
    return reply.send(request.raw.method === 'HEAD' ? undefined : body);
  }

  /** Ensure the addressbook container exists (idempotent; 409 = already there). */
  async function ensureContainer(vcfPath, auth) {
    const container = vcfPath.slice(0, vcfPath.lastIndexOf('/') + 1);
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

    // Auto-create the addressbook on first contact (per the issue's MKCOL-or-
    // auto-create). Best-effort: if it fails, let the PUT report the real error.
    if (path.endsWith('.vcf')) await ensureContainer(path, auth);

    const headers = { 'content-type': request.headers['content-type'] || VCARD_TYPE };
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

  async function handleMkcol(request, reply) {
    const auth = bridgeAuth(request);
    let path = hostPath(request.raw.url);
    if (!path) return reply.code(400).send();
    // Extended MKCOL (RFC 5689) carries a body of props (resourcetype
    // addressbook, displayname…). JSS has no place for those props, so we
    // accept the body and create the plain LDP container — the addressbook
    // resourcetype is derived from the container name at PROPFIND time.
    if (!path.endsWith('/')) path += '/';
    const res = await lb(path, { method: 'PUT' }, auth);
    if (res.status === 401) return unauthorized(reply);
    if (res.status === 409) return reply.code(405).send(); // exists → MKCOL not allowed
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

  // Attempt the reserved discovery path. Same guarded attempt nip05/ and
  // webdav-adjacent ports make: core does NOT confine plugin routes to the
  // prefix and blanket-exempts /.well-known/* from WAC, so an exact-path
  // registration works today and outranks the LDP GET wildcard — but nothing
  // in the plugin CONTRACT promises it, so a failure is degraded, not fatal.
  let wellKnown = false;
  try {
    api.fastify.route({
      method: ['GET', 'PROPFIND', 'HEAD'],
      url: '/.well-known/carddav',
      handler: handleWellKnown,
    });
    wellKnown = true;
  } catch (err) {
    api.log.warn(`carddav: could not claim /.well-known/carddav (${err.message}); `
      + `clients must be pointed straight at ${prefix}/<pod>/${bookName}/`);
  }

  api.log.info(`carddav: RFC 6352 addressbook bridge at ${prefix} → ${loopback}`
    + (wellKnown ? ' (+ /.well-known/carddav)' : ''));
}
