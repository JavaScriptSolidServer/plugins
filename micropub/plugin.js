// Micropub server (https://micropub.spec.indieweb.org/) as a #206 loader
// plugin.
//
//   plugins: [{ module: 'micropub/plugin.js', prefix: '/micropub',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// An IndieWeb Micropub client (Quill, Indigenous, Micropublish, a plain
// curl) POSTs h-entries to ONE endpoint and the posts become resources in
// the author's own pod. Everything fits under the single plugin `prefix`
// — unlike mastodon/ and bluesky/ there are no fixed absolute roots, so no
// `appPaths` hand-widening is needed: Micropub is the rare protocol shim
// that the one-prefix plugin model fits exactly.
//
// --------------------------------------------------------- the token bridge
//
// Micropub says clients authenticate with `Authorization: Bearer <token>`
// obtained from an IndieAuth token endpoint. A Solid pod's access token is
// *also* just a bearer resent on every call — so, exactly as mastodon/ and
// bluesky/ found for OAuth and ATProto, the bridge is the identity
// function: a pod bearer IS a Micropub token. `api.auth.getAgent(request)`
// resolves it to the WebID, and every pod write is a loopback LDP call
// carrying that same bearer, so real WAC — not this shim — decides what
// the caller may create, update, or delete.
//
// --------------------------------------------------------- object mapping
//
// h-entry            = one JSON resource in the author's pod at
//                      <pod>/public/posts/<yyyy>/<mm>/<slug>.json
// stored shape       = Micropub JSON verbatim: {"type":["h-entry"],
//                      "properties":{...}} (+ `published` added if absent)
// permalink          = the pod resource URL (returned in `Location:`)
// q=source           = loopback GET of that resource, returned as-is
// update (replace)   = loopback GET → merge → PUT
// delete             = loopback DELETE

import crypto from 'node:crypto';

const POSTS_DIR = 'public/posts'; // where h-entries live inside a pod

/**
 * Derive the pod root path from a WebID (same mapping as mastodon/).
 * Path-mode WebID:   http://host/alice/profile/card.jsonld#me → /alice/
 * Single-user WebID: http://host/profile/card.jsonld#me       → /
 */
function podFromWebid(webid) {
  const u = new URL(webid);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length >= 2 && segs[0] !== 'profile') return `/${segs[0]}/`;
  return '/';
}

/** Slugify a post name; empty string if nothing survives. */
function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/[\s-]+/g, '-').slice(0, 64).replace(/^-|-$/g, '');
}

/** A timestamp+random fallback slug (node:crypto). */
function randomSlug() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Parse a request body. JSS's wildcard parser hands non-JSON bodies through
 * as a Buffer, so decode form-encoded ones here — keeping ARRAYS: Micropub
 * form posts repeat `category[]=a&category[]=b`.
 * Returns { kind: 'form'|'json'|'none', params } where form params map
 * key → [values...] (the `[]` suffix stripped) and json is the parsed body.
 */
function readBody(request) {
  const ct = (request.headers['content-type'] || '').toLowerCase();
  let body = request.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (ct.includes('application/json')) {
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return { kind: 'json', params: null }; }
    }
    return { kind: 'json', params: (body && typeof body === 'object') ? body : null };
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = {};
    for (const [rawKey, value] of new URLSearchParams(typeof body === 'string' ? body : '')) {
      const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey;
      (params[key] ??= []).push(value);
    }
    return { kind: 'form', params };
  }
  return { kind: 'none', params: null };
}

/** Normalize a Micropub property value to the canonical array-of-values. */
const asArray = (v) => (Array.isArray(v) ? v : [v]);

export async function activate(api) {
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'micropub plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin (same finding as notifications/, webdav/, mastodon/). '
      + 'It is needed to mint post permalinks and validate q=source URLs.',
    );
  }
  const loopback = (api.config.loopbackUrl || '').replace(/\/$/, '');
  if (!loopback) {
    throw new Error(
      'micropub plugin requires config.loopbackUrl — pod reads/writes go '
      + 'over loopback HTTP with the client\'s own Authorization forwarded, '
      + 'so real WAC decides every operation.',
    );
  }
  const prefix = api.prefix || '/micropub';

  // ----------------------------------------------------------------- helpers
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS');
  const json = (reply, code, obj) => cors(reply)
    .code(code).header('content-type', 'application/json; charset=utf-8').send(obj);
  const invalid = (reply, description) => json(reply, 400, {
    error: 'invalid_request', ...(description ? { error_description: description } : {}),
  });

  /** Reach the host over loopback, forwarding the caller's Authorization. */
  const lb = (p, { method = 'GET', headers = {}, body, auth } = {}) => fetch(loopback + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
  });

  /** A post URL is ours iff it lives under baseUrl; return its path or null. */
  function localPath(url) {
    if (typeof url !== 'string' || !url.startsWith(`${baseUrl}/`)) return null;
    try { return new URL(url).pathname; } catch { return null; }
  }

  // ================================================================== routes

  api.fastify.options(prefix, (request, reply) => cors(reply).code(204).send());

  // ------------------------------------------------------------ GET (queries)
  api.fastify.get(prefix, async (request, reply) => {
    const q = request.query?.q;

    // q=config: what this endpoint supports. No media-endpoint (finding:
    // multipart upload needs the raw body stream — issue-#583 seam), no
    // syndication targets (no external network calls by design).
    if (q === 'config') {
      return json(reply, 200, { 'syndicate-to': [] });
    }
    if (q === 'syndicate-to') {
      return json(reply, 200, { 'syndicate-to': [] });
    }

    // q=source&url=…: return the stored post's Micropub JSON. Only for URLs
    // under THIS server's baseUrl — never fetch externally.
    if (q === 'source') {
      const agent = await api.auth.getAgent(request);
      if (!agent) return json(reply, 401, { error: 'unauthorized' });
      const p = localPath(request.query?.url);
      if (!p) return invalid(reply, 'q=source requires a url under this server');
      const res = await lb(p, {
        headers: { accept: 'application/json' },
        auth: request.headers.authorization,
      });
      if (res.status === 401 || res.status === 403) return json(reply, 403, { error: 'forbidden' });
      if (!res.ok) return invalid(reply, `no post at ${request.query.url} (${res.status})`);
      let post;
      try { post = await res.json(); } catch { return invalid(reply, 'stored resource is not Micropub JSON'); }
      if (!post || !Array.isArray(post.type) || typeof post.properties !== 'object') {
        return invalid(reply, 'stored resource is not Micropub JSON');
      }
      // Optional property filter: ?properties[]=content&properties[]=category
      const want = [].concat(request.query['properties[]'] ?? request.query.properties ?? []);
      if (want.length) {
        const filtered = {};
        for (const k of want) if (post.properties[k] !== undefined) filtered[k] = post.properties[k];
        return json(reply, 200, { properties: filtered });
      }
      return json(reply, 200, { type: post.type, properties: post.properties });
    }

    return invalid(reply, 'unsupported query — try q=config, q=source, q=syndicate-to');
  });

  // ------------------------------------------------- POST (create/update/delete)
  api.fastify.post(prefix, async (request, reply) => {
    const agent = await api.auth.getAgent(request);
    if (!agent) return json(reply, 401, { error: 'unauthorized' });
    const auth = request.headers.authorization;

    const { kind, params } = readBody(request);
    if (kind === 'none' || params === null) {
      return invalid(reply, 'send application/x-www-form-urlencoded or application/json');
    }
    const scalar = (k) => (kind === 'form' ? params[k]?.[0] : params[k]);
    const action = scalar('action');

    // ------------------------------------------------------------- delete
    if (action === 'delete') {
      const p = localPath(scalar('url'));
      if (!p) return invalid(reply, 'action=delete requires a url under this server');
      const res = await lb(p, { method: 'DELETE', auth });
      if (res.status === 401 || res.status === 403) return json(reply, 403, { error: 'forbidden' });
      if (res.status === 404 || res.status === 410) return invalid(reply, 'no such post');
      if (!(res.ok || res.status === 204)) {
        return json(reply, 500, { error: 'server_error', error_description: `pod delete failed (${res.status})` });
      }
      return cors(reply).code(204).send();
    }

    // ------------------------------------------------------------- update
    // Per spec, updates are JSON-only. `replace` is implemented; `add` /
    // `delete` property operations are not (documented in the README).
    if (action === 'update') {
      if (kind !== 'json') return invalid(reply, 'updates must be application/json (per spec)');
      const p = localPath(params.url);
      if (!p) return invalid(reply, 'action=update requires a url under this server');
      const replace = params.replace;
      if (!replace || typeof replace !== 'object' || Array.isArray(replace)) {
        return invalid(reply, 'only `replace` updates are supported');
      }
      const res = await lb(p, { headers: { accept: 'application/json' }, auth });
      if (res.status === 401 || res.status === 403) return json(reply, 403, { error: 'forbidden' });
      if (!res.ok) return invalid(reply, 'no such post');
      let post;
      try { post = await res.json(); } catch { return invalid(reply, 'stored resource is not Micropub JSON'); }
      if (!post || typeof post.properties !== 'object') return invalid(reply, 'stored resource is not Micropub JSON');
      for (const [k, v] of Object.entries(replace)) post.properties[k] = asArray(v);
      const put = await lb(p, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(post),
        auth,
      });
      if (put.status === 401 || put.status === 403) return json(reply, 403, { error: 'forbidden' });
      if (!(put.ok || put.status === 204)) {
        return json(reply, 500, { error: 'server_error', error_description: `pod update failed (${put.status})` });
      }
      return cors(reply).code(204).send();
    }

    if (action !== undefined) return invalid(reply, `unsupported action "${action}"`);

    // ------------------------------------------------------------- create
    let properties;
    let mpSlug;
    if (kind === 'json') {
      const type = params.type;
      if (!Array.isArray(type) || !type.includes('h-entry')) {
        return invalid(reply, 'only h-entry posts are supported');
      }
      if (!params.properties || typeof params.properties !== 'object') {
        return invalid(reply, 'missing properties');
      }
      properties = {};
      for (const [k, v] of Object.entries(params.properties)) {
        if (k === 'mp-slug') { mpSlug = asArray(v)[0]; continue; }
        if (k.startsWith('mp-')) continue; // server commands, not content
        properties[k] = asArray(v);
      }
    } else {
      const h = scalar('h') || 'entry';
      if (h !== 'entry') return invalid(reply, 'only h=entry posts are supported');
      properties = {};
      for (const [k, values] of Object.entries(params)) {
        if (k === 'h' || k === 'access_token') continue;
        if (k === 'mp-slug') { mpSlug = values[0]; continue; }
        if (k.startsWith('mp-')) continue;
        properties[k] = values;
      }
    }
    if (!Object.keys(properties).length) return invalid(reply, 'the post has no properties');
    if (!properties.published) properties.published = [new Date().toISOString()];

    // Permalink: <pod>/public/posts/<yyyy>/<mm>/<slug>.json — slug from
    // mp-slug, then the post name, then timestamp+random (node:crypto).
    const podPath = podFromWebid(agent);
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    let slug = slugify(mpSlug || properties.name?.[0] || '') || randomSlug();
    let resourcePath = `${podPath}${POSTS_DIR}/${yyyy}/${mm}/${slug}.json`;
    // Never silently overwrite an existing post with the same slug.
    const head = await lb(resourcePath, { method: 'HEAD', auth });
    if (head.ok) {
      slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
      resourcePath = `${podPath}${POSTS_DIR}/${yyyy}/${mm}/${slug}.json`;
    }

    // Store the Micropub JSON verbatim in the pod under the caller's OWN
    // credentials — real WAC decides whether this write is allowed.
    const put = await lb(resourcePath, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: ['h-entry'], properties }, null, 2),
      auth,
    });
    if (put.status === 401 || put.status === 403) return json(reply, 403, { error: 'forbidden' });
    if (!(put.ok || put.status === 204)) {
      return json(reply, 500, { error: 'server_error', error_description: `pod storage rejected the post (${put.status})` });
    }
    const permalink = `${baseUrl}${resourcePath}`;
    return cors(reply).code(201).header('location', permalink)
      .header('content-type', 'application/json; charset=utf-8')
      .send({ url: permalink });
  });

  api.log.info(`micropub: endpoint at ${prefix} → posts in <pod>/${POSTS_DIR}/ via ${loopback}`);
  // Discovery caveat (see README "Findings"): clients find a Micropub
  // endpoint via <link rel="micropub"> on the user's homepage — a resource
  // this plugin does not own and cannot decorate (no response-header hook).
  // The operator (or pod owner) must advertise the endpoint themselves.
}
