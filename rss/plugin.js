// RSS/Atom syndication feed over a pod container, as a #206 loader plugin.
//
//   plugins: [{ module: 'rss/plugin.js', prefix: '/feed',
//               config: { baseUrl: 'http://localhost:3000',
//                         defaultContainer: '/alice/blog/',
//                         title: "Alice's blog", maxItems: 50 } }]
//
// New feature built straight onto the plugin api: turn any LDP container of
// resources into a subscribable feed. Three read endpoints:
//
//   GET /feed/atom?container=/path/   → application/atom+xml (Atom 1.0)
//   GET /feed/rss?container=/path/    → application/rss+xml  (RSS 2.0)
//   GET /feed?container=/path/        → content-negotiated on Accept
//                                       (application/atom+xml | application/rss+xml,
//                                        default Atom)
//
// The container is walked over LOOPBACK HTTP carrying the CALLER'S OWN
// Authorization header — the same pattern notifications/, sparql/ and
// webdav/ established. A private feed therefore respects WAC by
// construction: the plugin has no authority of its own, it just asks the
// server as the caller. A public container needs no credentials, which is
// the common feed-reader case.
//
// Per container: GET the container as JSON-LD, read ldp:contains, GET each
// member (bounded by maxItems, newest-first when a date is available), and
// map each resource to an entry. Property mapping (matched by the LOCAL
// NAME of each key, so any prefix — schema:, dcterms:, dc:, or a bare term —
// works; see README):
//
//   title    ← title | name | headline | label            (else the filename)
//   updated  ← published|datePublished | modified|updated
//              | created|dateCreated | issued | date       (else the
//              container listing's dcterms:modified, else now)
//   content  ← content | articleBody | text | description
//              | body | summary | abstract                 (escaped)
//   id/link  ← the resource URL
//
// A plain text/html member (no JSON to parse) uses its filename as the title
// and its body as the content. Everything below is hand-rolled on node
// builtins — no XML/feed library, text escaped by hand.

const DEFAULT_MAX_ITEMS = 50;

// --------------------------------------------------------------- utilities

const xmlEscape = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

/** Local name of a JSON-LD key: strip everything up to the last # / or :. */
function localName(key) {
  const m = /[^#/:]*$/.exec(key);
  return (m ? m[0] : key).toLowerCase();
}

/** Parse a value into epoch millis, or 0 when it is missing/unparseable. */
function dateMillis(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** RFC 822 date for RSS <pubDate>; falsy/invalid → now. */
function toRfc822(iso) {
  const d = new Date(iso);
  return (Number.isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

/** Decoded filename without its extension, for a fallback title. */
function filenameTitle(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  let name = base;
  try { name = decodeURIComponent(base); } catch { /* keep raw */ }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name || base;
}

// ------------------------------------------------- JSON-LD property mapping
//
// Deliberately shallow: match a key by its LOCAL NAME so callers can use any
// vocabulary (schema.org, Dublin Core, a bare term…) without configuration.
// @graph / arrays are searched too; @value / @id objects are unwrapped.

const TITLE_KEYS = ['title', 'name', 'headline', 'label'];
const DATE_KEYS = [
  'published', 'datepublished', 'modified', 'updated', 'datemodified',
  'created', 'datecreated', 'issued', 'date',
];
const CONTENT_KEYS = ['content', 'articlebody', 'text', 'description', 'body', 'summary', 'abstract'];

/** Every object node worth reading props off (the doc, its @graph, arrays). */
function collectNodes(doc) {
  const nodes = [];
  const push = (n) => { if (n && typeof n === 'object' && !Array.isArray(n)) nodes.push(n); };
  for (const top of Array.isArray(doc) ? doc : [doc]) {
    push(top);
    if (top && Array.isArray(top['@graph'])) for (const g of top['@graph']) push(g);
  }
  return nodes;
}

/** Flatten a JSON-LD value (array / @value / @id / scalar) to a string. */
function unwrap(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    for (const item of v) { const s = unwrap(item); if (s != null && s !== '') return s; }
    return null;
  }
  if (typeof v === 'object') {
    if ('@value' in v) return v['@value'] == null ? null : String(v['@value']);
    if ('@id' in v) return String(v['@id']);
    return null;
  }
  return String(v);
}

/** First value across `nodes` whose key's local name is in `wanted` (in order). */
function pickProp(nodes, wanted) {
  for (const want of wanted) {
    for (const node of nodes) {
      for (const [key, raw] of Object.entries(node)) {
        if (key.startsWith('@')) continue;
        if (localName(key) === want) {
          const s = unwrap(raw);
          if (s != null && s !== '') return s;
        }
      }
    }
  }
  return null;
}

/** Map one fetched member into a feed entry. */
function mapEntry({ url, path }, contentType, bodyText, listingModified) {
  const ct = (contentType || '').toLowerCase();
  let title = null;
  let date = null;
  let content = null;
  let isHtml = ct.includes('html');

  if (ct.includes('json')) {
    let doc = null;
    try { doc = JSON.parse(bodyText); } catch { /* not JSON after all */ }
    if (doc && typeof doc === 'object') {
      const nodes = collectNodes(doc);
      title = pickProp(nodes, TITLE_KEYS);
      date = pickProp(nodes, DATE_KEYS);
      content = pickProp(nodes, CONTENT_KEYS);
    }
    isHtml = false; // rendered content is escaped text, not markup
  } else {
    // Plain text / html member: the body IS the content, filename the title.
    content = bodyText;
  }

  const updated = new Date(dateMillis(date) || dateMillis(listingModified) || Date.now()).toISOString();
  return {
    url,
    title: title || filenameTitle(path),
    updated,
    content: content || '',
    contentType: isHtml ? 'html' : 'text',
  };
}

// ----------------------------------------------------------- feed rendering

function renderAtom({ feedTitle, feedAuthor, feedId, selfUrl, updated, entries }) {
  const parts = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xmlEscape(feedTitle)}</title>`,
    `  <id>${xmlEscape(feedId)}</id>`,
    `  <updated>${xmlEscape(updated)}</updated>`,
    // RFC 4287 §4.1.1: a feed-level author satisfies the "≥1 author" rule for
    // every entry at once (RSS 2.0 has no equivalent requirement).
    `  <author><name>${xmlEscape(feedAuthor)}</name></author>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlEscape(selfUrl)}"/>`,
    `  <link rel="alternate" href="${xmlEscape(feedId)}"/>`,
  ];
  for (const e of entries) {
    parts.push(
      '  <entry>',
      `    <title>${xmlEscape(e.title)}</title>`,
      `    <id>${xmlEscape(e.url)}</id>`,
      `    <updated>${xmlEscape(e.updated)}</updated>`,
      `    <link rel="alternate" href="${xmlEscape(e.url)}"/>`,
      `    <content type="${e.contentType}">${xmlEscape(e.content)}</content>`,
      '  </entry>',
    );
  }
  parts.push('</feed>');
  return parts.join('\n');
}

function renderRss({ feedTitle, feedId, selfUrl, updated, entries }) {
  const parts = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${xmlEscape(feedTitle)}</title>`,
    `    <link>${xmlEscape(feedId)}</link>`,
    `    <description>${xmlEscape(feedTitle)}</description>`,
    `    <lastBuildDate>${xmlEscape(toRfc822(updated))}</lastBuildDate>`,
    `    <atom:link rel="self" type="application/rss+xml" href="${xmlEscape(selfUrl)}"/>`,
  ];
  for (const e of entries) {
    parts.push(
      '    <item>',
      `      <title>${xmlEscape(e.title)}</title>`,
      `      <link>${xmlEscape(e.url)}</link>`,
      `      <guid isPermaLink="true">${xmlEscape(e.url)}</guid>`,
      `      <pubDate>${xmlEscape(toRfc822(e.updated))}</pubDate>`,
      `      <description>${xmlEscape(e.content)}</description>`,
      '    </item>',
    );
  }
  parts.push('  </channel>', '</rss>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- activate

export async function activate(api) {
  const prefix = api.prefix || '/feed';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'rss plugin requires config.baseUrl — the plugin api exposes no server '
      + 'origin (same api.serverInfo finding as notifications/sparql/webdav); '
      + 'optional config.loopbackUrl overrides where the feed reaches the host',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  const origin = new URL(baseUrl).origin;
  const defaultContainer = api.config.defaultContainer || null;
  const maxItems = api.config.maxItems ?? DEFAULT_MAX_ITEMS;
  const feedTitle = api.config.title || 'Solid pod feed';
  // RFC 4287 §4.1.1 requires an atom:feed to carry ≥1 atom:author. Derive the
  // name from config.author, else the feed title, else a sensible default.
  const feedAuthor = api.config.author || feedTitle || 'Solid pod feed';

  /** Which container path this request addresses ('/alice/blog/'), or null. */
  function resolveContainer(request) {
    const c = request.query?.container;
    if (typeof c === 'string' && c) {
      if (c.startsWith('/')) return c;
      try { const u = new URL(c); if (u.origin === origin) return u.pathname; } catch { /* not a URL */ }
      return null; // off-origin or junk
    }
    return defaultContainer;
  }

  /** One loopback GET carrying the caller's own Authorization. */
  function lb(path, accept, auth) {
    return fetch(loopback + path, {
      redirect: 'manual',
      headers: { accept, ...(auth ? { authorization: auth } : {}) },
    });
  }

  /**
   * Walk the container over loopback as the caller and build feed entries.
   * Returns { entries, containerUrl } on success, or { error, status } when
   * the container itself is unreadable (WAC refusal, 404, …) — the feed then
   * reflects exactly what the caller could GET.
   */
  async function collectEntries(containerPath, auth) {
    const path = containerPath.endsWith('/') ? containerPath : `${containerPath}/`;
    let res;
    try {
      res = await lb(path, 'application/ld+json', auth);
    } catch {
      return { error: true, status: 502 };
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* already drained */ }
      return { error: true, status: res.status };
    }
    if (!(res.headers.get('content-type') || '').toLowerCase().includes('json')) {
      try { await res.body?.cancel(); } catch { /* already drained */ }
      return { error: true, status: 415 }; // not an LDP container listing
    }
    let listing;
    try { listing = await res.json(); } catch { return { error: true, status: 502 }; }

    const containerUrl = baseUrl + path;

    // Members: leaf resources only (skip sub-containers, .acl, .meta).
    const members = [];
    for (const child of [].concat(listing.contains ?? [])) {
      const id = typeof child === 'string' ? child : child?.['@id'];
      if (!id) continue;
      let u;
      try { u = new URL(id, containerUrl); } catch { continue; }
      if (u.origin !== origin) continue;
      if (u.pathname.endsWith('/')) continue;
      if (/\.(acl|meta)$/i.test(u.pathname)) continue;
      const modified = typeof child === 'object'
        ? (child['dcterms:modified'] ?? child.modified ?? null)
        : null;
      members.push({ path: u.pathname, url: baseUrl + u.pathname, modified });
    }

    // Cheap pre-sort on the listing's own dcterms:modified so, when there are
    // more members than maxItems, we fetch the newest ones. (Without a
    // write-time index — no api.events — there is no cheaper way; see README.)
    members.sort((a, b) => dateMillis(b.modified) - dateMillis(a.modified));

    const entries = [];
    for (const m of members.slice(0, maxItems)) {
      let mres;
      try {
        mres = await lb(m.path, 'application/ld+json, text/*;q=0.9, */*;q=0.5', auth);
      } catch { continue; }
      if (!mres.ok) { try { await mres.body?.cancel(); } catch { /* */ } continue; }
      const ct = mres.headers.get('content-type') || '';
      let body;
      try { body = await mres.text(); } catch { continue; }
      entries.push(mapEntry(m, ct, body, m.modified));
    }

    // Authoritative newest-first on the real per-member date.
    entries.sort((a, b) => dateMillis(b.updated) - dateMillis(a.updated));
    return { entries: entries.slice(0, maxItems), containerUrl };
  }

  async function serve(request, reply, format) {
    const containerPath = resolveContainer(request);
    if (!containerPath) {
      return reply.code(400).send({
        error: 'name a container: ?container=/path/ (this server) or set config.defaultContainer',
      });
    }
    const auth = request.headers.authorization ?? null;
    const result = await collectEntries(containerPath, auth);
    if (result.error) {
      if (result.status === 401) reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(result.status || 502).send();
    }
    const updated = result.entries.length ? result.entries[0].updated : new Date().toISOString();
    const model = {
      feedTitle,
      feedAuthor,
      feedId: result.containerUrl,
      selfUrl: baseUrl + request.raw.url,
      updated,
      entries: result.entries,
    };
    const isRss = format === 'rss';
    reply.header('content-type',
      isRss ? 'application/rss+xml; charset=utf-8' : 'application/atom+xml; charset=utf-8');
    return isRss ? renderRss(model) : renderAtom(model);
  }

  api.fastify.get(`${prefix}/atom`, (request, reply) => serve(request, reply, 'atom'));
  api.fastify.get(`${prefix}/rss`, (request, reply) => serve(request, reply, 'rss'));
  api.fastify.get(prefix, (request, reply) => {
    // Content negotiation: rss only when it clearly outranks atom.
    const accept = (request.headers.accept || '').toLowerCase();
    const format = accept.includes('application/rss+xml') && !accept.includes('application/atom+xml')
      ? 'rss' : 'atom';
    return serve(request, reply, format);
  });

  api.log.info(`rss: Atom + RSS feeds at ${prefix}/atom, ${prefix}/rss (loopback container walk; WAC-respecting)`);
}
