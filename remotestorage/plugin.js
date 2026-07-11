// remoteStorage (draft-dejong-remotestorage-22, https://remotestorage.io/)
// as a #206 loader plugin — the out-of-tree port of the bundled feature on
// #564's migration list (core ships src/remotestorage.js at /storage/:user/*,
// always on; this plugin is the same protocol rebuilt on the public api).
//
//   plugins: [{ module: 'remotestorage/plugin.js', prefix: '/remotestorage',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// Storage API (the protocol's core):
//
//   GET/HEAD/PUT/DELETE <prefix>/<user>/<category>/<path>
//     → loopback LDP request to /<user>/remotestorage/<category>/<path>
//       forwarding the caller's Authorization, so the host's real WAC
//       decides — the webdav/ data-plane pattern. The plugin has no
//       authority of its own.
//
//   - Document GET/HEAD: host response relayed, ETag passed through (the
//     host's own md5(mtime+size) ETag — never hand-rolled here).
//     If-None-Match forwarded; the host's LDP GET answers 304 itself.
//   - PUT/DELETE: If-Match / If-None-Match forwarded verbatim; the host's
//     LDP handlers implement both (412 on failure) — measured, see README
//     "conditional-write pass-through". The host's PUT/DELETE responses
//     carry NO ETag header, and the rS spec requires one, so the plugin
//     does a follow-up (PUT) / preceding (DELETE) loopback HEAD to fetch
//     it — see README "ETag provenance".
//   - Folder GET (trailing slash): loopback container listing
//     (Accept: application/ld+json) mapped to the rS folder-description
//     JSON. The LDP listing carries no per-item ETags, so the plugin HEADs
//     each child over loopback (with the caller's auth) — O(N) loopback
//     calls per listing; the item ETag is therefore byte-identical to the
//     ETag a direct GET of that document returns, which rS sync depends on.
//     The folder's own ETag is hand-rolled (hash of the items map) because
//     the host's directory ETag is mtime-based and does not change when an
//     existing child is overwritten — see README findings.
//   - Public reads: GET/HEAD under a user's public/ category work
//     anonymously iff the pod grants public read — the anonymous loopback
//     GET decides, for free. No plugin-side ACL logic at all.
//
// Auth endpoint: rS clients expect an OAuth implicit-grant dialog
// (rfc6749 §4.2). A login UI is product-scale; this plugin implements the
// mastodon/-style shortcut instead: POST <prefix>/token with
// {username,password} bridges to the host's POST /idp/credentials over
// loopback and returns the pod bearer verbatim as the rS token. Documented
// deviation.
//
// WebFinger: rS clients discover the storage via a link in
// /.well-known/webfinger. This repo's webfinger/ plugin ALREADY serves that
// route; this plugin registers it too — DELIBERATELY unguarded (no
// try/catch), so loading both plugins is a boot failure
// (FST_ERR_DUPLICATED_ROUTE), witnessed in test.js. A deployment must
// choose ONE webfinger owner: set config.claimWellKnown: false here to
// stand down (the JRD is always also served at the contract-safe
// <prefix>/webfinger). The missing seam is a link registry
// (api.webfinger.addLink) that would let both plugins contribute links to
// one document — see README findings.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const RS_CONTEXT = 'http://remotestorage.io/spec/folder-description';
const RS_VERSION = 'draft-dejong-remotestorage-22';
const RS_REL = 'http://tools.ietf.org/id/draft-dejong-remotestorage';

/** Pod-name grammar (also blocks traversal); same as webfinger/'s. */
const LOCAL_PART = /^[a-zA-Z0-9._-]+$/;

/** Strip W/ prefix and surrounding quotes from an ETag value. */
const bare = (etag) => String(etag || '').replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

/** Parse an If-(None-)Match header into bare tags (or ['*']). */
function parseEtags(header) {
  if (!header) return [];
  if (header.trim() === '*') return ['*'];
  return header.split(',').map((t) => bare(t.trim()));
}

/** acct:alice@host → 'alice'; https://host/alice/… → 'alice'; else null. */
export function userFromResource(resource) {
  if (typeof resource !== 'string' || resource === '') return null;
  if (resource.startsWith('acct:')) {
    const acct = resource.slice('acct:'.length);
    const at = acct.lastIndexOf('@');
    const user = at >= 0 ? acct.slice(0, at) : acct;
    return user || null;
  }
  try {
    const segs = new URL(resource).pathname.split('/').filter(Boolean);
    return segs[0] || null;
  } catch {
    return null;
  }
}

export async function activate(api) {
  const prefix = api.prefix || '/remotestorage';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  const loopbackUrl = (api.config.loopbackUrl || '').replace(/\/$/, '');
  if (!baseUrl || !loopbackUrl) {
    throw new Error(
      'remotestorage plugin requires config.baseUrl and config.loopbackUrl — '
      + 'the plugin api exposes no server origin (api.serverInfo finding, same '
      + 'as webdav/mastodon/webfinger); the JRD needs absolute URLs and the '
      + 'data plane reaches the host over loopback.',
    );
  }
  // Pod subfolder the rS tree lives in: /<user>/<dataDir>/<category>/…
  const dataDir = api.config.dataDir || 'remotestorage';
  const claimWellKnown = api.config.claimWellKnown !== false;

  // ----------------------------------------------------------------- misc
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type, if-match, if-none-match, origin')
    .header('access-control-allow-methods', 'GET, HEAD, PUT, DELETE, OPTIONS')
    .header('access-control-expose-headers', 'etag, content-type, content-length, www-authenticate');

  const jsonReply = (reply, code, obj) => cors(reply)
    .code(code).header('content-type', 'application/json; charset=utf-8').send(obj);

  /** Loopback to the host, forwarding the caller's Authorization. */
  const lb = (p, { method = 'GET', headers = {}, body, auth } = {}) => fetch(loopbackUrl + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
  });

  const unauthorized = (reply) => cors(reply)
    .code(401).header('www-authenticate', 'Bearer realm="remotestorage"')
    .send({ error: 'Unauthorized' });

  /** Relay a loopback auth refusal; false when the caller may proceed. */
  function relayRefusal(res, reply) {
    if (res.status === 401) { unauthorized(reply); return true; }
    if (res.status === 403) { jsonReply(reply, 403, { error: 'Forbidden' }); return true; }
    return false;
  }

  /**
   * <prefix>/<user>/<rest> → { user, rest, podPath } or null when the path
   * is outside the storage grammar (bad user, '..', dotfile segment).
   * `rest` keeps the client's own percent-encoding for the loopback call.
   */
  function parseStoragePath(request) {
    let raw = request.raw.url.split('?')[0].slice(prefix.length);
    if (!raw.startsWith('/')) raw = '/' + raw;
    const segs = raw.split('/').slice(1); // drop leading ''
    const user = segs.shift() ?? '';
    if (!LOCAL_PART.test(user) || user.startsWith('.')) return null;
    for (const seg of segs) {
      if (seg === '..' || (seg.startsWith('.') && seg.length > 1)) return null;
    }
    const rest = '/' + segs.join('/'); // '' user root → '/'
    return { user, rest, podPath: `/${user}/${dataDir}${rest}` };
  }

  // -------------------------------------------------------------- folders
  /** Child name from a listing @id, relative to the container URL. */
  function childName(id, isDir) {
    const s = String(id);
    const trimmed = s.endsWith('/') ? s.slice(0, -1) : s;
    const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return isDir ? `${name}/` : name;
  }

  async function handleFolder(request, reply, { user, rest, podPath }) {
    const auth = request.headers.authorization;
    const res = await lb(podPath, { headers: { accept: 'application/ld+json' }, auth });
    if (relayRefusal(res, reply)) return reply;
    if (res.status === 404) {
      // rS spec: a folder that does not exist yet is an empty listing, so
      // clients can start syncing into it. No ETag (mirrors core's bundled
      // implementation: a 304 here would skip the client's push logic).
      return cors(reply).code(200)
        .header('content-type', 'application/ld+json')
        .header('cache-control', 'no-cache')
        .send({ '@context': RS_CONTEXT, items: {} });
    }
    if (!res.ok) return jsonReply(reply, res.status, { error: `pod refused the listing (${res.status})` });

    let listing = {};
    try { listing = await res.json(); } catch { /* non-JSON container → empty */ }

    // The LDP listing has per-child stat:size and dcterms:modified but NO
    // ETags; HEAD each child over loopback (caller's auth) so item ETags are
    // the host's own — identical to what a direct document GET returns.
    const items = {};
    for (const child of [].concat(listing.contains ?? [])) {
      const id = typeof child === 'string' ? child : child['@id'];
      if (!id) continue;
      const isDir = Array.isArray(child['@type'])
        ? child['@type'].some((t) => /Container$/.test(t))
        : String(id).endsWith('/');
      const name = childName(id, isDir);
      if (name.startsWith('.')) continue; // .acl/.meta never surface in rS
      const childUrl = podPath + encodeURIComponent(isDir ? name.slice(0, -1) : name) + (isDir ? '/' : '');
      const head = await lb(childUrl, { method: 'HEAD', headers: { accept: 'application/ld+json' }, auth });
      const etag = head.ok ? bare(head.headers.get('etag')) : '';
      if (isDir) {
        items[name] = { ETag: etag };
      } else {
        items[name] = {
          ETag: etag,
          'Content-Type': head.headers.get('content-type') || 'application/octet-stream',
          'Content-Length': Number(child['stat:size'] ?? head.headers.get('content-length') ?? 0),
        };
      }
    }

    // Folder ETag is hand-rolled from the items map: the host's directory
    // ETag is mtime-based and does NOT change when an existing child is
    // overwritten (writes touch the file's mtime, not the directory's), so
    // passing it through would break rS sync. Hashing name→ETag pairs is
    // correct for direct children; see README for the depth ≥ 2 gap.
    const folderEtag = `"rs-${crypto.createHash('sha256')
      .update(JSON.stringify(Object.keys(items).sort().map((k) => [k, items[k].ETag])))
      .digest('hex').slice(0, 32)}"`;

    // If-None-Match checked plugin-side (our ETag differs from the host's).
    const inm = parseEtags(request.headers['if-none-match']);
    if (inm.includes('*') || inm.includes(bare(folderEtag))) {
      return cors(reply).code(304).header('etag', folderEtag).send();
    }

    cors(reply)
      .header('content-type', 'application/ld+json')
      .header('etag', folderEtag)
      .header('cache-control', 'no-cache');
    if (request.raw.method === 'HEAD') return reply.code(200).send();
    return reply.code(200).send({ '@context': RS_CONTEXT, items });
  }

  // ------------------------------------------------------------ documents
  async function handleGetHead(request, reply, parsed) {
    if (parsed.rest.endsWith('/')) return handleFolder(request, reply, parsed);
    const fwd = { accept: '*/*' };
    for (const h of ['if-none-match', 'if-match', 'range']) {
      if (request.headers[h]) fwd[h] = request.headers[h];
    }
    const res = await lb(parsed.podPath, {
      method: request.raw.method, headers: fwd, auth: request.headers.authorization,
    });
    if (relayRefusal(res, reply)) return reply;
    if (res.status === 404) return jsonReply(reply, 404, { error: 'Not found' });
    cors(reply).code(res.status).header('cache-control', 'no-cache');
    for (const h of ['content-type', 'etag', 'content-range', 'content-length']) {
      const v = res.headers.get(h);
      if (v) reply.header(h, v);
    }
    if (request.raw.method === 'HEAD' || res.status === 304 || !res.body) return reply.send();
    return reply.send(Readable.fromWeb(res.body));
  }

  async function handlePut(request, reply, parsed) {
    if (parsed.rest.endsWith('/')) {
      return jsonReply(reply, 400, { error: 'Cannot PUT to a folder path' });
    }
    const auth = request.headers.authorization;
    let body = request.body;
    if (body == null) body = Buffer.alloc(0);
    else if (typeof body === 'object' && !Buffer.isBuffer(body)) body = JSON.stringify(body);
    const headers = {};
    for (const h of ['content-type', 'if-match', 'if-none-match']) {
      if (request.headers[h]) headers[h] = request.headers[h];
    }
    // If-Match / If-None-Match forwarded VERBATIM: the host's LDP PUT
    // implements both against its own ETag (412 on failure) — measured in
    // test.js, so no plugin-side re-check is needed.
    const res = await lb(parsed.podPath, { method: 'PUT', headers, body, auth });
    if (relayRefusal(res, reply)) return reply;
    if (res.status === 412) return jsonReply(reply, 412, { error: 'Precondition Failed' });
    if (!(res.ok || res.status === 204)) {
      return jsonReply(reply, res.status, { error: `pod storage rejected the write (${res.status})` });
    }
    // The host's PUT response carries no ETag (LDP omits it); rS requires
    // one, so fetch it with a follow-up HEAD. Not atomic — a concurrent
    // write between PUT and HEAD yields the newer ETag (see README).
    const head = await lb(parsed.podPath, { method: 'HEAD', headers: { accept: '*/*' }, auth });
    return cors(reply)
      .code(res.status === 201 ? 201 : 200)
      .header('etag', head.headers.get('etag') || '')
      .send();
  }

  async function handleDelete(request, reply, parsed) {
    if (parsed.rest.endsWith('/')) {
      return jsonReply(reply, 400, { error: 'Cannot DELETE a folder' });
    }
    const auth = request.headers.authorization;
    // HEAD first: rS wants the deleted revision's ETag in the response, and
    // the host's DELETE response carries none.
    const head = await lb(parsed.podPath, { method: 'HEAD', headers: { accept: '*/*' }, auth });
    if (relayRefusal(head, reply)) return reply;
    if (head.status === 404) return jsonReply(reply, 404, { error: 'Not found' });
    const headers = {};
    if (request.headers['if-match']) headers['if-match'] = request.headers['if-match'];
    // If-Match forwarded verbatim — the host's LDP DELETE checks it (412).
    const res = await lb(parsed.podPath, { method: 'DELETE', headers, auth });
    if (relayRefusal(res, reply)) return reply;
    if (res.status === 412) return jsonReply(reply, 412, { error: 'Precondition Failed' });
    if (!res.ok) return jsonReply(reply, res.status, { error: `pod storage rejected the delete (${res.status})` });
    return cors(reply).code(200).header('etag', head.headers.get('etag') || '').send();
  }

  // --------------------------------------------------------- token bridge
  /** Query + parsed body → one flat params object (mastodon/'s readParams). */
  function readParams(request) {
    const out = { ...(request.query || {}) };
    let body = request.body;
    const ct = (request.headers['content-type'] || '').toLowerCase();
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string' && body.length) {
      if (ct.includes('application/json')) {
        try { body = JSON.parse(body); } catch { body = {}; }
      } else {
        body = Object.fromEntries(new URLSearchParams(body));
      }
    }
    if (body && typeof body === 'object') Object.assign(out, body);
    return out;
  }

  async function handleToken(request, reply) {
    const p = readParams(request);
    if (!p.username || !p.password) {
      return jsonReply(reply, 400, { error: 'invalid_request', error_description: 'username and password required' });
    }
    const res = await lb('/idp/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: p.username, password: p.password }),
    });
    if (!res.ok) {
      return jsonReply(reply, 401, { error: 'invalid_grant', error_description: 'invalid username or password' });
    }
    const body = await res.json();
    // The pod bearer IS the rS token (mastodon/'s bridge): later storage
    // calls forward it over loopback and real WAC decides.
    return jsonReply(reply, 200, {
      access_token: body.access_token,
      token_type: 'bearer',
      webid: body.webid,
    });
  }

  // ------------------------------------------------------------ webfinger
  function handleWebfinger(request, reply) {
    cors(reply);
    const resource = request.query?.resource;
    if (typeof resource !== 'string' || resource === '') {
      return jsonReply(reply, 400, { error: 'the "resource" query parameter is required' });
    }
    const user = userFromResource(resource);
    if (!user || !LOCAL_PART.test(user) || user.startsWith('.')) {
      return jsonReply(reply, 404, { error: 'no such resource' });
    }
    // No podsRoot scan: the JRD is served for any well-formed local part —
    // the storage href behind it 401/404s for pods that don't exist, and
    // duplicating webfinger/'s filesystem scan here would double the code
    // this plugin exists to show colliding (see README).
    const storage = `${baseUrl}${prefix}/${user}`;
    return reply
      .header('content-type', 'application/jrd+json; charset=utf-8')
      .send({
        subject: resource,
        links: [
          {
            rel: RS_REL,
            href: storage,
            properties: {
              'http://remotestorage.io/spec/version': RS_VERSION,
              // Deviation: this is a POST token bridge, not an implicit-
              // grant dialog — a real rS client redirecting a browser here
              // will not get a login UI (documented in README).
              'http://tools.ietf.org/html/rfc6749#section-4.2': `${baseUrl}${prefix}/token`,
              'http://tools.ietf.org/html/rfc6750#section-2.3': null,
              'http://remotestorage.io/spec/web-authoring': null,
            },
          },
          // Legacy rel some older clients look up.
          { rel: 'remotestorage', href: storage, type: RS_VERSION },
        ],
      });
  }

  // --------------------------------------------------------------- routes
  api.fastify.get(`${prefix}/webfinger`, handleWebfinger);
  api.fastify.post(`${prefix}/token`, handleToken);
  api.fastify.options(`${prefix}/*`, (request, reply) => cors(reply).code(204).send());

  const handlers = { GET: handleGetHead, HEAD: handleGetHead, PUT: handlePut, DELETE: handleDelete };
  api.fastify.route({
    method: Object.keys(handlers),
    url: `${prefix}/*`,
    exposeHeadRoutes: false,
    handler: (request, reply) => {
      const parsed = parseStoragePath(request);
      if (!parsed) return jsonReply(reply, request.raw.method === 'GET' || request.raw.method === 'HEAD' ? 404 : 403, { error: 'invalid storage path' });
      return handlers[request.raw.method](request, reply, parsed);
    },
  });

  // The headline experiment: claim the REAL WebFinger location, unguarded.
  // If another plugin (this repo's webfinger/) got there first, this throw
  // fails the boot — deliberately: two owners of one discovery document is
  // a deployment error until a link-registry seam (api.webfinger.addLink)
  // exists. Set config.claimWellKnown: false to stand down and serve only
  // the contract-safe <prefix>/webfinger.
  if (claimWellKnown) {
    api.fastify.get('/.well-known/webfinger', handleWebfinger);
  }

  api.log.info(`remotestorage: ${RS_VERSION} at ${prefix}/<user>/… → pods via ${loopbackUrl}`
    + ` (webfinger at ${prefix}/webfinger${claimWellKnown ? ' and /.well-known/webfinger' : ''})`);
}
