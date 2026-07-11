// WebDAV → LDP bridge as a #206 loader plugin (issue #507).
//
//   plugins: [{ module: 'webdav/plugin.js', prefix: '/webdav',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// Mount a pod as a network drive: WebDAV clients (Finder, Nautilus/gvfs,
// Windows Explorer, cadaver, rclone…) hit /webdav/<path> and every request
// is translated to a Solid/LDP request against the host itself, performed
// over LOOPBACK HTTP carrying the client's own credentials — the same
// pattern notifications/ established for WAC checks. The bridge therefore
// has NO authority of its own: if the server would refuse the operation,
// the bridge refuses it, because the bridge literally asks the server.
//
// Method map (WebDAV → LDP over loopback):
//
//   OPTIONS          → answered locally: DAV: 1, Allow list
//   PROPFIND 0|1     → GET (Accept: application/ld+json); ldp:contains →
//                      hand-rolled 207 multistatus XML
//   GET / HEAD       → GET / HEAD, body streamed through
//   PUT              → PUT (201 created / 204 overwritten, passed through)
//   DELETE           → DELETE (204)
//   MKCOL            → PUT to the trailing-slash URL (JSS creates a
//                      BasicContainer for any PUT on a '/'-terminated
//                      path; 409 "exists" is mapped to WebDAV's 405)
//   LOCK/UNLOCK/COPY/MOVE/PROPPATCH → 501 (class 1 only; see README)
//
// Auth: the incoming Authorization header is forwarded on every loopback
// call. Bearer goes through verbatim. Because most OS WebDAV clients can
// only speak HTTP Basic, `Basic user:password` is bridged to
// `Bearer <password>` — configure the mount with any username and the pod
// token as the password.

import { Readable } from 'node:stream';

const DAV_ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL';
const XML_TYPE = 'application/xml; charset=utf-8';

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

/** RFC 4918 propstat for one resource, from whatever props we could learn. */
function davResponse({ href, displayname, collection, size, modified, contentType }) {
  const props = [
    `<D:displayname>${xmlEscape(displayname)}</D:displayname>`,
    `<D:resourcetype>${collection ? '<D:collection/>' : ''}</D:resourcetype>`,
  ];
  if (!collection && size != null && size !== '') {
    props.push(`<D:getcontentlength>${xmlEscape(size)}</D:getcontentlength>`);
  }
  if (!collection && contentType) {
    props.push(`<D:getcontenttype>${xmlEscape(contentType)}</D:getcontenttype>`);
  }
  if (modified) {
    const date = new Date(modified);
    if (!Number.isNaN(date.getTime())) {
      props.push(`<D:getlastmodified>${date.toUTCString()}</D:getlastmodified>`);
    }
  }
  return '<D:response>'
    + `<D:href>${xmlEscape(href)}</D:href>`
    + `<D:propstat><D:prop>${props.join('')}</D:prop>`
    + '<D:status>HTTP/1.1 200 OK</D:status></D:propstat>'
    + '</D:response>';
}

function multistatus(responses) {
  return '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<D:multistatus xmlns:D="DAV:">\n'
    + responses.join('\n')
    + '\n</D:multistatus>';
}

/** Last path segment, decoded for display ('/a/b/' -> 'b', '/' -> '/'). */
function displayName(path) {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(base) || '/';
  } catch {
    return base || '/';
  }
}

export async function activate(api) {
  const prefix = api.prefix || '/webdav';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'webdav plugin requires config.baseUrl — the plugin api exposes no server origin '
      + '(same finding as notifications/); optional config.loopbackUrl overrides where '
      + 'the bridge reaches the host',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');

  // ---------------------------------------------------------------- auth
  // Bearer forwards verbatim; Basic is bridged (password = pod token)
  // because Finder / gvfs / Windows can only prompt for user + password.
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
  /** The LDP path this WebDAV request addresses ('/', '/alice/', …). */
  function hostPath(request) {
    let rest = request.raw.url.split('?')[0].slice(prefix.length);
    if (!rest.startsWith('/')) rest = '/' + rest;
    // The host guards traversal itself; refusing '..' here just keeps the
    // bridge from ever emitting a loopback URL outside the mount.
    if (rest.split('/').includes('..')) return null;
    return rest;
  }

  function lb(path, { method = 'GET', headers = {}, body } = {}, auth) {
    return fetch(loopback + path, {
      method,
      redirect: 'manual',
      headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
  }

  const isContainerLink = (link) => /ldp#(Basic)?Container>;\s*rel="type"/.test(link || '');

  /** Map a loopback failure onto the WebDAV response; false = success. */
  function relayError(res, reply) {
    if (res.status === 401) { unauthorized(reply); return true; }
    if (res.ok || res.status === 304) return false;
    reply.code(res.status).send();
    return true;
  }

  /** GET a container listing as JSON-LD; null when not a parseable listing. */
  async function fetchListing(containerPath, auth) {
    const res = await lb(containerPath, { headers: { accept: 'application/ld+json' } }, auth);
    if (!res.ok) return { res, listing: null };
    if (!(res.headers.get('content-type') || '').includes('json')) {
      return { res, listing: null }; // e.g. index.html container — see README
    }
    try {
      return { res, listing: await res.json() };
    } catch {
      return { res, listing: null };
    }
  }

  // ------------------------------------------------------------- methods
  async function handleOptions(request, reply) {
    // Answered locally — clients probe OPTIONS before offering credentials.
    return reply.code(200)
      .header('DAV', '1')
      .header('MS-Author-Via', 'DAV')
      .header('Allow', DAV_ALLOW)
      .send();
  }

  async function handlePropfind(request, reply) {
    const auth = bridgeAuth(request);
    let path = hostPath(request);
    if (!path) return reply.code(400).send();
    // Depth: 0 stays 0; 1/infinity/missing all serve one level (RFC 4918
    // lets servers refuse infinity; serving depth 1 keeps gvfs happy).
    const depth = String(request.headers.depth ?? '1').trim() === '0' ? 0 : 1;

    // A slash-less path may still be a container (Finder PROPFINDs
    // /webdav/alice first) — ask the host, its Link header knows.
    let head = null;
    if (!path.endsWith('/')) {
      head = await lb(path, { method: 'HEAD' }, auth);
      if (relayError(head, reply)) return reply;
      if (isContainerLink(head.headers.get('link'))) path += '/';
    }

    const responses = [];
    if (path.endsWith('/')) {
      const { res, listing } = await fetchListing(path, auth);
      if (relayError(res, reply)) return reply;
      responses.push(davResponse({
        href: prefix + path, displayname: displayName(path), collection: true,
      }));
      if (depth > 0 && listing) {
        for (const child of [].concat(listing.contains ?? [])) {
          const id = typeof child === 'string' ? child : child['@id'];
          if (!id) continue;
          let childPath;
          try {
            childPath = new URL(id, baseUrl + path).pathname; // keeps trailing '/'
          } catch { continue; }
          responses.push(davResponse({
            href: prefix + childPath,
            displayname: displayName(childPath),
            collection: childPath.endsWith('/'),
            size: child['stat:size'],
            modified: child['dcterms:modified'],
          }));
        }
      }
    } else {
      // Plain resource: content-type/length from the HEAD; mtime lives only
      // in the parent's listing (JSS sends no Last-Modified), so enrich
      // best-effort from there.
      let size = head.headers.get('content-length');
      let modified = null;
      const parent = path.slice(0, path.lastIndexOf('/') + 1);
      try {
        const { listing } = await fetchListing(parent, auth);
        const entry = [].concat(listing?.contains ?? []).find((c) => {
          try { return c['@id'] && new URL(c['@id'], baseUrl).pathname === path; } catch { return false; }
        });
        if (entry) {
          modified = entry['dcterms:modified'] ?? null;
          if (entry['stat:size'] != null) size = entry['stat:size'];
        }
      } catch { /* parent unreadable — serve what HEAD gave us */ }
      responses.push(davResponse({
        href: prefix + path,
        displayname: displayName(path),
        collection: false,
        size,
        modified,
        contentType: head.headers.get('content-type'),
      }));
    }
    return reply.code(207).header('content-type', XML_TYPE).send(multistatus(responses));
  }

  async function handleGetHead(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request);
    if (!path) return reply.code(400).send();
    const fwd = {};
    for (const h of ['range', 'if-match', 'if-none-match', 'if-modified-since']) {
      if (request.headers[h]) fwd[h] = request.headers[h];
    }
    const res = await lb(path, { method: request.raw.method, headers: fwd }, auth);
    if (res.status === 401) return unauthorized(reply);
    reply.code(res.status);
    // content-length deliberately not forwarded: fetch may have decoded the
    // body; let fastify frame the stream itself.
    for (const h of ['content-type', 'etag', 'content-range', 'accept-ranges']) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    if (request.raw.method === 'HEAD' || !res.body || res.status === 304) {
      return reply.send();
    }
    return reply.send(Readable.fromWeb(res.body));
  }

  async function handlePut(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request);
    if (!path) return reply.code(400).send();
    let body = request.body;
    if (body == null) body = Buffer.alloc(0);
    else if (typeof body === 'object' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
    const headers = {};
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
    if (request.headers['if-match']) headers['if-match'] = request.headers['if-match'];
    if (request.headers['if-none-match']) headers['if-none-match'] = request.headers['if-none-match'];
    const res = await lb(path, { method: 'PUT', headers, body }, auth);
    if (res.status === 401) return unauthorized(reply);
    return reply.code(res.status).send(); // 201 created / 204 overwritten pass through
  }

  async function handleDelete(request, reply) {
    const auth = bridgeAuth(request);
    const path = hostPath(request);
    if (!path) return reply.code(400).send();
    const res = await lb(path, { method: 'DELETE' }, auth);
    if (res.status === 401) return unauthorized(reply);
    return reply.code(res.ok ? 204 : res.status).send();
  }

  async function handleMkcol(request, reply) {
    const auth = bridgeAuth(request);
    let path = hostPath(request);
    if (!path) return reply.code(400).send();
    // RFC 4918: MKCOL with a body the server doesn't understand → 415.
    if (request.body && (!Buffer.isBuffer(request.body) || request.body.length > 0)) {
      return reply.code(415).send();
    }
    if (!path.endsWith('/')) path += '/';
    // JSS creates a BasicContainer for a PUT on any '/'-terminated path.
    const res = await lb(path, { method: 'PUT' }, auth);
    if (res.status === 401) return unauthorized(reply);
    if (res.status === 409) return reply.code(405).send(); // exists → MKCOL not allowed
    return reply.code(res.status).send(); // 201 on success
  }

  async function handleNotImplemented(request, reply) {
    // Class 1 only: no locks (OPTIONS advertises DAV: 1, so honest clients
    // never send these; Windows write-mode wants class 2 — see README).
    return reply.code(501).header('Allow', DAV_ALLOW).send();
  }

  // -------------------------------------------------------------- routes
  const handlers = {
    OPTIONS: handleOptions,
    PROPFIND: handlePropfind,
    GET: handleGetHead,
    HEAD: handleGetHead,
    PUT: handlePut,
    DELETE: handleDelete,
    MKCOL: handleMkcol,
    PROPPATCH: handleNotImplemented,
    LOCK: handleNotImplemented,
    UNLOCK: handleNotImplemented,
    COPY: handleNotImplemented,
    MOVE: handleNotImplemented,
  };
  const dispatch = (request, reply) => handlers[request.raw.method](request, reply);
  for (const url of [prefix, `${prefix}/*`]) {
    api.fastify.route({
      method: Object.keys(handlers),
      url,
      exposeHeadRoutes: false, // HEAD is declared explicitly above
      handler: dispatch,
    });
  }

  api.log.info(`webdav: LDP bridge at ${prefix} → ${loopback} (class 1, no locks)`);
}
