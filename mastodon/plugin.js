// Mastodon-API shim (JSS issues #515 / #516) as a #206 loader plugin.
//
//   plugins: [{ module: 'mastodon/plugin.js',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// Phase 1 of #515 — "a personal client over your own pod". Point a real
// Mastodon client (Phanpy, Elk, a mobile app) at this server and it can
// log in, post, and read its own posts back — no federation, no timeline
// of other people. "Home timeline" == the posts YOU wrote, stored as
// ActivityStreams Notes in your own pod.
//
// -------------------------------------------------------------- the shape
//
// Mastodon clients hit FIXED ABSOLUTE paths — `/api/v1/instance`,
// `/oauth/token`, `/api/v1/statuses`, … — that no single plugin `prefix`
// can own. So, exactly like nip05/ claims `/.well-known/nostr.json`, this
// plugin registers those absolute routes straight on `api.fastify`. The
// loader does not confine a plugin's routes to its prefix, and each of
// these is a static (or param) route that outranks core's LDP `GET /*`
// wildcard on Fastify's route-specificity ordering. That the whole
// Mastodon surface lives OUTSIDE the one-prefix model is the headline
// finding (README "Findings" — same reserved-path seam as nip05); as of
// JSS 0.0.219 the plugin claims + WAC-exempts both roots itself via
// api.reservePath (#602), so the operator no longer touches appPaths.
//
// --------------------------------------------------------- the token bridge
//
// Mastodon's OAuth access_token IS just a bearer the client resends on
// every call. A Solid pod's access token is *also* just a bearer. So the
// bridge is direct: `POST /oauth/token` with grant_type=password takes the
// pod owner's username+password, calls the host's own `POST /idp/credentials`
// over loopback (the CTH programmatic-credentials endpoint), and hands the
// resulting pod Bearer back as the Mastodon `access_token`. From then on
// the client's `Authorization: Bearer <pod-token>` authenticates directly
// against the pod — `api.auth.getAgent(request)` resolves it to the WebID,
// and status writes are loopback LDP PUTs carrying that same bearer, so
// real WAC — not this shim — decides what the caller may write.
//
// --------------------------------------------------------- object mapping
//
// Mastodon Account.id  = short hash of the WebID (opaque string; clients
//                        treat ids as opaque)
// Mastodon Status      = one ActivityStreams Note resource in the pod at
//                        <pod>/public/statuses/<id>.jsonld
// Status.id            = a sortable numeric snowflake, also the filename
// created_at           = the Note's `published` (ISO 8601)
// home timeline        = GET the statuses container (ldp:contains), map each

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MASTODON_VERSION = '4.2.0'; // what we claim to clients (feature-gating)
const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const STATUS_DIR = 'public/statuses'; // where Notes live inside a pod
const CODE_TTL_MS = 10 * 60 * 1000; // authorization_code lifetime

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
));

// A sortable, numeric-string id (Mastodon sorts timelines by id desc).
let lastMs = 0;
let seq = 0;
function mintStatusId() {
  const ms = Date.now();
  if (ms === lastMs) seq += 1;
  else { lastMs = ms; seq = 0; }
  return (BigInt(ms) * 1000n + BigInt(seq)).toString();
}

const accountId = (webid) => crypto.createHash('sha256').update(webid).digest('hex').slice(0, 16);

/**
 * Derive the pod root path and a display username from a WebID.
 * Path-mode WebID:   http://host/alice/profile/card.jsonld#me → { alice, /alice/ }
 * Single-user WebID: http://host/profile/card.jsonld#me       → { host label, / }
 */
function podFromWebid(webid) {
  const u = new URL(webid);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length >= 2 && segs[0] !== 'profile') {
    return { username: segs[0], podPath: `/${segs[0]}/`, origin: u.origin };
  }
  return { username: u.hostname.split('.')[0] || 'user', podPath: '/', origin: u.origin };
}

/**
 * Merge a request's query with its parsed body into one flat object.
 * JSS parses application/json into an object but hands every other body
 * (form-encoded, no content-type) through as a Buffer (server.js wildcard
 * parser), so decode those here.
 */
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

export async function activate(api) {
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'mastodon plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin (same finding as notifications/ and webdav/). It is needed '
      + 'to build absolute status URIs and to reach the host over loopback.',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  const instanceTitle = api.config.title || 'JSS (Mastodon-compatible)';

  // App registrations persist across restarts; issued auth codes are short
  // lived and stay in memory.
  const dir = api.storage.pluginDir();
  const appsFile = path.join(dir, 'apps.json');
  const codes = new Map(); // code -> { access_token, webid, exp }

  const loadApps = () => {
    try { return JSON.parse(fs.readFileSync(appsFile, 'utf8')); } catch { return {}; }
  };
  const saveApps = (apps) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(appsFile, JSON.stringify(apps, null, 2));
  };

  // ----------------------------------------------------------------- helpers
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type, idempotency-key')
    .header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  const json = (reply, code, obj) => cors(reply)
    .code(code).header('content-type', 'application/json; charset=utf-8').send(obj);

  /** Reach the host over loopback, forwarding the caller's Authorization. */
  const lb = (p, { method = 'GET', headers = {}, body, auth } = {}) => fetch(loopback + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
  });

  /** Bridge username+password to a pod Bearer via the host's IdP. */
  async function mintPodToken(username, password) {
    if (!username || !password) return null;
    try {
      const res = await lb('/idp/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      return body.access_token ? { access_token: body.access_token, webid: body.webid } : null;
    } catch {
      return null;
    }
  }

  /** A Mastodon Account object derived purely from a WebID. */
  function buildAccount(webid) {
    const { username } = podFromWebid(webid);
    const id = accountId(webid);
    // Profile page is the WebID document without the fragment.
    const url = webid.split('#')[0];
    return {
      id,
      username,
      acct: username,
      display_name: username,
      // created_at isn't tracked by the shim; a stable placeholder keeps
      // clients from choking on a missing field (see README findings).
      created_at: '1970-01-01T00:00:00.000Z',
      note: '',
      url,
      uri: webid,
      avatar: '', avatar_static: '', header: '', header_static: '',
      locked: false, bot: false, discoverable: true, group: false,
      followers_count: 0, following_count: 0, statuses_count: 0,
      last_status_at: null, fields: [], emojis: [],
    };
  }

  /** Map a stored ActivityStreams Note (+ its id) to a Mastodon Status. */
  function noteToStatus(note, id, webid) {
    const created = note.published || new Date().toISOString();
    const text = typeof note.content === 'string' ? note.content : '';
    const owner = note.attributedTo || webid;
    const uri = note.id || `${baseUrl}${podFromWebid(owner).podPath}${STATUS_DIR}/${id}.jsonld`;
    return {
      id,
      created_at: created,
      in_reply_to_id: null, in_reply_to_account_id: null,
      sensitive: false, spoiler_text: '',
      visibility: 'public',
      language: 'en',
      uri,
      url: uri,
      replies_count: 0, reblogs_count: 0, favourites_count: 0,
      favourited: false, reblogged: false, muted: false, bookmarked: false, pinned: false,
      content: `<p>${escapeHtml(text)}</p>`,
      reblog: null, application: null,
      account: buildAccount(owner),
      media_attachments: [], mentions: [], tags: [], emojis: [], card: null, poll: null,
    };
  }

  // =================================================================== routes

  // Claim + WAC-exempt the two fixed Mastodon roots (#602, JSS 0.0.219).
  // Literal reservations exempt the whole subtree but are READ-ONLY by
  // default, so widen to POST — the only write verb any route below
  // implements (/api/v1/apps, /api/v1/statuses; /oauth/authorize,
  // /oauth/token). PUT/DELETE/PATCH stay gated on purpose: exempting a
  // verb no route implements would let it fall through to core's LDP
  // write wildcards as an unauthenticated storage write.
  api.reservePath('/api', { methods: ['GET', 'HEAD', 'OPTIONS', 'POST'] });
  api.reservePath('/oauth', { methods: ['GET', 'HEAD', 'OPTIONS', 'POST'] });

  // Preflight for the whole shim surface.
  for (const p of ['/api/*', '/oauth/*']) {
    api.fastify.options(p, (request, reply) => cors(reply).code(204).send());
  }

  // ------------------------------------------------------------- instance
  const instanceConfig = {
    statuses: { max_characters: 5000, max_media_attachments: 0, characters_reserved_per_url: 23 },
    media_attachments: { supported_mime_types: [] },
    polls: { max_options: 0 },
  };
  api.fastify.get('/api/v1/instance', (request, reply) => json(reply, 200, {
    uri: new URL(baseUrl).host,
    title: instanceTitle,
    short_description: 'A JavaScript Solid Server pod, spoken to over the Mastodon API.',
    description: 'JSS-backed Mastodon API shim (issue #515, Phase 1). Your posts are '
      + 'ActivityStreams Notes stored in your own Solid pod.',
    email: '', version: MASTODON_VERSION,
    urls: {}, languages: ['en'],
    registrations: false, approval_required: false, invites_enabled: false,
    configuration: instanceConfig,
    stats: { user_count: 0, status_count: 0, domain_count: 0 },
    thumbnail: null, contact_account: null, rules: [],
  }));
  api.fastify.get('/api/v2/instance', (request, reply) => json(reply, 200, {
    domain: new URL(baseUrl).host,
    title: instanceTitle,
    version: MASTODON_VERSION,
    source_url: 'https://github.com/JavaScriptSolidServer/JavaScriptSolidServer',
    description: 'JSS-backed Mastodon API shim (issue #515, Phase 1).',
    usage: { users: { active_month: 0 } },
    thumbnail: { url: '' },
    languages: ['en'],
    configuration: instanceConfig,
    registrations: { enabled: false, approval_required: false, message: null },
    contact: { email: '', account: null },
    rules: [],
  }));

  // --------------------------------------------------------------- apps
  api.fastify.post('/api/v1/apps', (request, reply) => {
    const p = readParams(request);
    const name = p.client_name || p.name || 'Mastodon client';
    const redirectUris = p.redirect_uris || p.redirect_uri || 'urn:ietf:wg:oauth:2.0:oob';
    const clientId = crypto.randomBytes(24).toString('base64url');
    const clientSecret = crypto.randomBytes(32).toString('base64url');
    const id = String(Date.now());
    const apps = loadApps();
    apps[clientId] = {
      id, client_id: clientId, client_secret: clientSecret, name,
      redirect_uris: redirectUris, scopes: p.scopes || 'read write', website: p.website || null,
      created_at: new Date().toISOString(),
    };
    saveApps(apps);
    return json(reply, 200, {
      id, name, website: p.website || null,
      redirect_uri: Array.isArray(redirectUris) ? redirectUris[0] : redirectUris,
      client_id: clientId, client_secret: clientSecret, vapid_key: '',
    });
  });

  // --------------------------------------------------------- oauth/authorize
  // A minimal login page (real browsers) plus a headless shortcut: pass
  // username+password as params and we mint + redirect straight away.
  function issueCode(mint, redirectUri, state, reply) {
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, { ...mint, exp: Date.now() + CODE_TTL_MS });
    if (!redirectUri || redirectUri === 'urn:ietf:wg:oauth:2.0:oob') {
      return cors(reply).code(200).type('text/html')
        .send(`<!doctype html><title>Authorized</title><p>Authorization code:</p>`
          + `<code id="code">${escapeHtml(code)}</code>`);
    }
    const sep = redirectUri.includes('?') ? '&' : '?';
    const location = `${redirectUri}${sep}code=${encodeURIComponent(code)}`
      + (state ? `&state=${encodeURIComponent(state)}` : '');
    return cors(reply).code(302).header('location', location).send();
  }

  function loginPage(p) {
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state']
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p[k] || '')}">`).join('');
    return `<!doctype html><meta charset="utf-8"><title>Sign in</title>`
      + `<form method="post" action="/oauth/authorize">${hidden}`
      + `<p><label>Username <input name="username" autocomplete="username"></label></p>`
      + `<p><label>Password <input type="password" name="password" autocomplete="current-password"></label></p>`
      + `<button type="submit">Authorize</button></form>`;
  }

  async function authorize(request, reply) {
    const p = readParams(request);
    if (p.username && p.password) {
      const mint = await mintPodToken(p.username, p.password);
      if (!mint) return cors(reply).code(200).type('text/html').send(loginPage(p));
      return issueCode(mint, p.redirect_uri, p.state, reply);
    }
    return cors(reply).code(200).type('text/html').send(loginPage(p));
  }
  api.fastify.get('/oauth/authorize', authorize);
  api.fastify.post('/oauth/authorize', authorize);

  // ------------------------------------------------------------- oauth/token
  api.fastify.post('/oauth/token', async (request, reply) => {
    const p = readParams(request);
    const grant = p.grant_type || 'authorization_code';
    const scope = p.scope || 'read write';
    const now = Math.floor(Date.now() / 1000);

    if (grant === 'password') {
      const mint = await mintPodToken(p.username, p.password);
      if (!mint) return json(reply, 401, { error: 'invalid_grant', error_description: 'Invalid username or password' });
      return json(reply, 200, {
        access_token: mint.access_token, token_type: 'Bearer', scope, created_at: now,
      });
    }

    if (grant === 'authorization_code') {
      const entry = p.code && codes.get(p.code);
      if (!entry || entry.exp < Date.now()) {
        return json(reply, 400, { error: 'invalid_grant', error_description: 'Unknown or expired authorization code' });
      }
      codes.delete(p.code); // one-time
      return json(reply, 200, {
        access_token: entry.access_token, token_type: 'Bearer', scope, created_at: now,
      });
    }

    if (grant === 'client_credentials') {
      // App-only token: authenticates the app to public endpoints, but
      // carries NO pod identity, so getAgent() will resolve it to nobody
      // and any /statuses write is refused. Documented limitation.
      return json(reply, 200, {
        access_token: `app.${crypto.randomBytes(24).toString('base64url')}`,
        token_type: 'Bearer', scope: 'read', created_at: now,
      });
    }

    return json(reply, 400, { error: 'unsupported_grant_type', error_description: `grant_type ${grant} not supported` });
  });

  // ----------------------------------------------- accounts/verify_credentials
  api.fastify.get('/api/v1/accounts/verify_credentials', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const account = buildAccount(webid);
    account.source = { note: '', fields: [], privacy: 'public', sensitive: false, language: 'en' };
    return json(reply, 200, account);
  });

  // ---------------------------------------------------------- statuses (post)
  api.fastify.post('/api/v1/statuses', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const p = readParams(request);
    const text = typeof p.status === 'string' ? p.status : '';
    if (!text.trim()) return json(reply, 422, { error: 'Validation failed: Text can\'t be blank' });

    const { podPath } = podFromWebid(webid);
    const id = mintStatusId();
    const resourcePath = `${podPath}${STATUS_DIR}/${id}.jsonld`;
    const published = new Date().toISOString();
    const note = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${baseUrl}${resourcePath}`,
      type: 'Note',
      attributedTo: webid,
      content: text,
      published,
      to: [AS_PUBLIC],
    };
    // Store it in the pod under the caller's OWN credentials — real WAC
    // decides whether this write is allowed.
    const put = await lb(resourcePath, {
      method: 'PUT',
      headers: { 'content-type': 'application/ld+json' },
      body: JSON.stringify(note),
      auth: request.headers.authorization,
    });
    if (put.status === 401 || put.status === 403) {
      return json(reply, 403, { error: 'This action is not allowed' });
    }
    if (!(put.ok || put.status === 204)) {
      return json(reply, 500, { error: `Pod storage rejected the status (${put.status})` });
    }
    return json(reply, 200, noteToStatus(note, id, webid));
  });

  // ----------------------------------------------------- statuses (read one)
  api.fastify.get('/api/v1/statuses/:id', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const id = String(request.params.id).replace(/[^0-9]/g, '');
    if (!id) return json(reply, 404, { error: 'Record not found' });
    const { podPath } = podFromWebid(webid);
    const res = await lb(`${podPath}${STATUS_DIR}/${id}.jsonld`, {
      headers: { accept: 'application/ld+json' }, auth: request.headers.authorization,
    });
    if (!res.ok) return json(reply, 404, { error: 'Record not found' });
    let note;
    try { note = await res.json(); } catch { return json(reply, 404, { error: 'Record not found' }); }
    return json(reply, 200, noteToStatus(note, id, webid));
  });

  // -------------------------------------------------------- timelines/home
  // No federation, so home == your own posts: list the statuses container.
  api.fastify.get('/api/v1/timelines/home', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { podPath } = podFromWebid(webid);
    const auth = request.headers.authorization;
    const list = await lb(`${podPath}${STATUS_DIR}/`, {
      headers: { accept: 'application/ld+json' }, auth,
    });
    if (list.status === 404) return json(reply, 200, []); // no posts yet
    if (!list.ok) return json(reply, 200, []);
    let container;
    try { container = await list.json(); } catch { return json(reply, 200, []); }

    const contains = [].concat(container.contains ?? []);
    const ids = [];
    for (const child of contains) {
      const cid = typeof child === 'string' ? child : child['@id'];
      if (!cid) continue;
      const m = /\/([0-9]+)\.jsonld$/.exec(cid);
      if (m) ids.push(m[1]);
    }
    ids.sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1)); // newest first

    const limit = Math.min(Number(request.query?.limit) || 40, 80);
    const statuses = [];
    for (const id of ids.slice(0, limit)) {
      const res = await lb(`${podPath}${STATUS_DIR}/${id}.jsonld`, {
        headers: { accept: 'application/ld+json' }, auth,
      });
      if (!res.ok) continue;
      try { statuses.push(noteToStatus(await res.json(), id, webid)); } catch { /* skip */ }
    }
    return json(reply, 200, statuses);
  });

  api.log.info(`mastodon: shim at /api/v1|v2 + /oauth/* → pods via ${loopback} (issue #515 Phase 1)`);
  // The former load-bearing caveat is closed: /api and /oauth are
  // self-reserved above via api.reservePath (#602), so no operator
  // appPaths are needed since JSS 0.0.219 (see README "Findings").
}
