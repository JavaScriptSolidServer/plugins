// Mastodon-API shim (JSS issues #515 / #516) as a #206 loader plugin.
//
//   plugins: [{ module: 'mastodon/plugin.js',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000',
//                         podsRoot: './data',        // optional: local-user discovery
//                         apRoot: '/ap' } }]         // optional: where activitypub/ lives
//
// Phase 2 of #515 — "Phanpy-grade parity, local-only". Point a real Mastodon
// web client (Phanpy, Elk) at this server: log in (auth-code + PKCE or
// password grant), home timeline renders, post (with a photo), reply and see
// the thread, favourite/boost, and the notifications tab shows follows/
// likes/mentions read from the ActivityPub inbox that the activitypub/
// plugin persists. Still NO federation from this plugin: every byte moves
// over the existing loopback pattern, and Like/Announce/Follow delivery to
// remote servers is Wave B (see README Findings).
//
// -------------------------------------------------------------- the shape
//
// Mastodon clients hit FIXED ABSOLUTE paths — `/api/v1/instance`,
// `/oauth/token`, `/api/v1/statuses`, … — that no single plugin `prefix`
// can own. So, exactly like nip05/ claims `/.well-known/nostr.json`, this
// plugin registers those absolute routes straight on `api.fastify`; as of
// JSS 0.0.219 it claims + WAC-exempts both roots itself via api.reservePath
// (#602). Phase 2 adds DELETE (status delete) and PUT (media description
// update) routes, so the /api reservation is widened to exactly those verbs
// — and because an exempted verb with NO matching route falls through to
// core's LDP write wildcards as an unauthenticated storage write (core's
// documented trap), catch-all PUT/DELETE /api/* handlers answer 404 for
// every path the plugin does not implement.
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
// and every pod write is a loopback LDP PUT/DELETE carrying that same
// bearer, so real WAC — not this shim — decides what the caller may touch.
//
// --------------------------------------------------------- object mapping
//
// Mastodon Status      = one ActivityStreams Note at
//                        <pod>/public/statuses/<snowflake>.jsonld
//                        (layout shared with activitypub/ — that is why
//                        mastodon-posted statuses appear in the AP outbox)
// Status.id            = base64url of the Note's AS2 `id` URL (opaque to
//                        clients; both directions via b64id/decodeStatusId)
// Account.id           = the username (first pod path segment)
// MediaAttachment.id   = base64url of the media URL in the pod
// created_at           = the Note's `published` (ISO 8601)
// favourite / reblog / follow = plugin-local state in pluginDir/state.json
//                        (Wave B will also deliver Like/Announce upstream)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MASTODON_VERSION = '4.2.0'; // what we claim to clients (feature-gating)
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const STATUS_DIR = 'public/statuses'; // where Notes live inside a pod
const MEDIA_DIR = 'public/media'; //    where uploaded attachments land
const CODE_TTL_MS = 10 * 60 * 1000; // authorization_code lifetime

// Pagination: Mastodon's documented defaults (Phanpy paginates via the
// Link header, so every list endpoint emits rel=next/prev).
const PAGE_DEFAULT = 20;
const PAGE_MAX = 40;
// Bound for the read-time walks (context descendants / public timeline):
// at most this many Note bodies are fetched per request.
const MAX_WALK = 200;

// Multipart parser bounds (see parseMultipart): the whole body is already
// capped by the server bodyLimit (20 MiB default), these bound the parse.
const MP_MAX_PARTS = 32;
const MP_MAX_PART_HEADER = 8 * 1024;
const MP_MAX_BOUNDARY = 200;

const escapeHtml = (s) => String(s).replace(/[<>&"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
));

// A sortable, numeric-string snowflake — the Note FILENAME (ordering), not
// the client-visible Status.id (which is base64url of the Note URL).
let lastMs = 0;
let seq = 0;
function mintStatusId() {
  const ms = Date.now();
  if (ms === lastMs) seq += 1;
  else { lastMs = ms; seq = 0; }
  return (BigInt(ms) * 1000n + BigInt(seq)).toString();
}

// ---- id helpers (both directions; ids are opaque base64url to clients) ----
const b64id = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
function unb64id(id) {
  // Strict gate: Buffer.from(_, 'base64url') silently skips junk chars, so
  // validate the alphabet first — malformed ids must 404, never 500.
  if (typeof id !== 'string' || id.length === 0 || id.length > 2048) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try { return Buffer.from(id, 'base64url').toString('utf8'); } catch { return null; }
}

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/opus',
};
const MIME_EXT = Object.fromEntries(Object.entries(EXT_MIME).map(([e, m]) => [m, e]));
function attachmentKind(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'unknown';
}

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
 * parser), so decode those here. Keys ending in `[]` (Mastodon's array
 * convention: `id[]=…&id[]=…`, `media_ids[]=…`) collapse to plain-named
 * arrays; repeated keys become arrays too.
 */
function readParams(request) {
  const out = {};
  const put = (k, v) => {
    const arrayKey = k.endsWith('[]');
    const key = arrayKey ? k.slice(0, -2) : k;
    if (arrayKey) out[key] = [].concat(out[key] ?? [], v);
    else if (key in out) out[key] = [].concat(out[key], v);
    else out[key] = v;
  };
  for (const [k, v] of Object.entries(request.query || {})) {
    for (const each of [].concat(v)) put(k, each);
  }
  let body = request.body;
  const ct = (request.headers['content-type'] || '').toLowerCase();
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string' && body.length) {
    if (ct.includes('application/json')) {
      try { body = JSON.parse(body); } catch { body = {}; }
    } else {
      const sp = new URLSearchParams(body);
      for (const [k, v] of sp) put(k, v);
      body = null;
    }
  }
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) put(k, Array.isArray(v) ? v : v);
  }
  return out;
}

/**
 * Minimal, bounded multipart/form-data parser — enough for a Mastodon media
 * upload (one `file` part + small text fields), hand-rolled because JSS's
 * wildcard content parser hands the raw buffered body over and no multipart
 * dependency is allowed. Bounds: ≤ MP_MAX_PARTS parts, part header block ≤
 * MP_MAX_PART_HEADER bytes, boundary ≤ MP_MAX_BOUNDARY chars, and nested
 * multipart parts are rejected outright. Returns { file?, fields } or
 * { error } (callers map error → 422).
 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]{1,200})"|([^;\s"]{1,200}))/i.exec(contentType || '');
  const boundary = m && (m[1] || m[2]);
  if (!boundary || boundary.length > MP_MAX_BOUNDARY) return { error: 'missing or oversized multipart boundary' };
  if (!Buffer.isBuffer(buf)) return { error: 'no request body' };

  const delim = Buffer.from(`--${boundary}`);
  const marks = [];
  for (let i = buf.indexOf(delim); i !== -1; i = buf.indexOf(delim, i + delim.length)) {
    marks.push(i);
    if (marks.length > MP_MAX_PARTS + 1) return { error: `more than ${MP_MAX_PARTS} multipart parts` };
  }
  if (marks.length < 2) return { error: 'malformed multipart body (no closing boundary)' };

  const fields = {};
  let file = null;
  for (let p = 0; p < marks.length - 1; p++) {
    let start = marks[p] + delim.length;
    // The final delimiter is `--boundary--`.
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1 || headerEnd - start > MP_MAX_PART_HEADER) {
      return { error: 'malformed or oversized multipart part header' };
    }
    const headerBlock = buf.slice(start, headerEnd).toString('utf8');
    const headers = {};
    for (const line of headerBlock.split('\r\n')) {
      const c = line.indexOf(':');
      if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    const partCt = headers['content-type'] || '';
    if (/multipart\//i.test(partCt)) return { error: 'nested multipart is not supported' };
    const cd = headers['content-disposition'] || '';
    const nameM = /name="([^"]{1,200})"/.exec(cd);
    const fileM = /filename="([^"]{0,300})"/.exec(cd);
    // Part data runs to the next delimiter, minus its preceding CRLF.
    let end = marks[p + 1];
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    const data = buf.slice(headerEnd + 4, end);
    const name = nameM ? nameM[1] : null;
    if (fileM && name === 'file' && !file) {
      file = { filename: fileM[1] || 'upload', contentType: partCt || 'application/octet-stream', data };
    } else if (name) {
      fields[name] = data.toString('utf8');
    }
  }
  return { file, fields };
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
  // Where the activitypub/ plugin mounts its surface (notifications read
  // `GET {apRoot}/<user>/inbox?page=true` over loopback — the integration
  // contract; a 404 there just means "no notifications yet").
  const apRoot = (api.config.apRoot || '/ap').replace(/\/$/, '');
  // OPTIONAL pod discovery for the local public timeline: the LDP root
  // serves an HTML landing page, not a container listing (probed), so
  // enumerating pods needs a filesystem hint — the same config.podsRoot
  // webfinger/ and nip05/ take. Without it the public timeline degrades to
  // the caller's own posts (documented in README Findings).
  const podsRoot = api.config.podsRoot ? String(api.config.podsRoot) : null;
  const origin = new URL(baseUrl).origin;

  // App registrations + social state persist across restarts; issued auth
  // codes are short-lived and stay in memory.
  const dir = api.storage.pluginDir();
  const appsFile = path.join(dir, 'apps.json');
  const stateFile = path.join(dir, 'state.json');
  const codes = new Map(); // code -> { access_token, webid, exp, code_challenge, code_challenge_method }
  const refreshTokens = new Map(); // refresh_token -> { access_token }

  const loadApps = () => {
    try { return JSON.parse(fs.readFileSync(appsFile, 'utf8')); } catch { return {}; }
  };
  const saveApps = (apps) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(appsFile, JSON.stringify(apps, null, 2));
  };

  // ---- plugin-local social state (jss-style JSON file, atomic writes) ----
  // favourites/reblogs: { [username]: { [noteUrl]: isoTimestamp } }
  // following:          { [username]: [username, …] }   (local follows)
  // media:              { [mediaUrl]: { description } }
  const emptyState = () => ({ favourites: {}, reblogs: {}, following: {}, media: {} });
  function loadState() {
    try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; }
    catch { return emptyState(); }
  }
  function saveState(st) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }
  const usersWith = (bucket, url) => Object.keys(bucket || {}).filter((u) => bucket[u] && bucket[u][url]);

  // ----------------------------------------------------------------- helpers
  // EVERY /api and /oauth response — including 4xx — goes through cors()/
  // json(), so browser clients on another origin (Phanpy) always see real
  // statuses instead of CORS-shaped "network errors". Deliberately a shared
  // helper, NOT a fastify hook: plugin hooks fire for ALL plugin routes in
  // the loader scope (metrics/ finding).
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type, idempotency-key')
    .header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH')
    .header('access-control-expose-headers', 'link');
  const json = (reply, code, obj, extraHeaders = {}) => {
    cors(reply).code(code).header('content-type', 'application/json; charset=utf-8');
    for (const [k, v] of Object.entries(extraHeaders)) reply.header(k, v);
    return reply.send(obj);
  };

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

  // ---- URL ↔ id decoding (the other direction of b64id) -------------------
  /** A local status URL → { url, path, user, sortKey } (null = not local). */
  function decodeStatusUrl(u) {
    let url;
    try { url = new URL(String(u)); } catch { return null; }
    if (url.origin !== origin) return null;
    const m = /^\/([A-Za-z0-9][A-Za-z0-9._~-]*)\/public\/statuses\/([0-9]+)\.jsonld$/.exec(url.pathname);
    if (!m) return null;
    return { url: `${baseUrl}${url.pathname}`, path: url.pathname, user: m[1], sortKey: BigInt(m[2]) };
  }
  const decodeStatusId = (id) => {
    const u = unb64id(id);
    return u === null ? null : decodeStatusUrl(u);
  };
  /** A local media URL → { url, path, user, name } (null = not local). */
  function decodeMediaUrl(u) {
    let url;
    try { url = new URL(String(u)); } catch { return null; }
    if (url.origin !== origin) return null;
    const m = /^\/([A-Za-z0-9][A-Za-z0-9._~-]*)\/public\/media\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})$/.exec(url.pathname);
    if (!m) return null;
    return { url: `${baseUrl}${url.pathname}`, path: url.pathname, user: m[1], name: m[2] };
  }
  const decodeMediaId = (id) => {
    const u = unb64id(id);
    return u === null ? null : decodeMediaUrl(u);
  };

  // ---- entity builders -----------------------------------------------------
  /** A Mastodon Account for a LOCAL user (Account.id == the username). */
  function accountFor(username) {
    const url = `${baseUrl}/${username}/profile/card.jsonld`;
    return {
      id: username,
      username,
      acct: username,
      display_name: username,
      // created_at isn't tracked by the shim; a stable placeholder keeps
      // clients from choking on a missing field (see README findings).
      created_at: '1970-01-01T00:00:00.000Z',
      note: '',
      url,
      uri: `${url}#me`,
      avatar: '', avatar_static: '', header: '', header_static: '',
      locked: false, bot: false, discoverable: true, group: false,
      followers_count: 0, following_count: 0, statuses_count: 0,
      last_status_at: null, fields: [], emojis: [],
    };
  }

  /**
   * A Mastodon Account for an AP `actor` URL — built from the URL ALONE
   * (no remote fetch; resolving remote actors is Wave B). Local shapes
   * ({apRoot}/<user>/actor, /<user>/profile/…) map back to the local
   * account; anything else becomes user@host parsed from the URL.
   */
  function accountForActor(actorUrl) {
    let u;
    try { u = new URL(String(actorUrl)); } catch {
      return { ...accountFor('unknown'), id: b64id(String(actorUrl || 'unknown')), acct: String(actorUrl || 'unknown') };
    }
    const segs = u.pathname.split('/').filter(Boolean);
    if (u.origin === origin) {
      const apSeg = apRoot.split('/').filter(Boolean);
      if (segs.length === apSeg.length + 2 && apSeg.every((s, i) => segs[i] === s) && segs.at(-1) === 'actor') {
        return accountFor(segs[apSeg.length]);
      }
      if (segs.length >= 1) return accountFor(segs[0]);
    }
    const username = (segs.at(-1) || u.hostname).replace(/^@/, '');
    return {
      ...accountFor(username),
      id: b64id(u.href), // remote: opaque, stable, decodable
      acct: `${username}@${u.hostname}`,
      url: u.href,
      uri: u.href,
    };
  }

  function attachmentEntity(url, mediaType, description, st) {
    const stored = st.media[url] || {};
    const decoded = decodeMediaUrl(url);
    const ext = decoded ? decoded.name.slice(decoded.name.lastIndexOf('.') + 1).toLowerCase() : '';
    const mime = mediaType || EXT_MIME[ext] || 'application/octet-stream';
    return {
      id: b64id(url),
      type: attachmentKind(mime),
      url,
      preview_url: url,
      remote_url: null,
      text_url: null,
      meta: {},
      description: stored.description ?? description ?? null,
      blurhash: null,
    };
  }

  /** Map a stored ActivityStreams Note (+ its canonical URL) to a Status. */
  function noteToStatus(note, canonicalUrl, viewer, st = loadState()) {
    const noteUrl = note.id || canonicalUrl;
    const created = note.published || new Date().toISOString();
    const text = typeof note.content === 'string' ? note.content : '';
    const local = decodeStatusUrl(noteUrl);
    const account = local ? accountFor(local.user) : accountForActor(note.attributedTo);
    const replyTo = typeof note.inReplyTo === 'string' ? note.inReplyTo : null;
    const replyLocal = replyTo ? decodeStatusUrl(replyTo) : null;
    const attachments = [].concat(note.attachment ?? [])
      .filter((a) => a && typeof a.url === 'string')
      .map((a) => attachmentEntity(a.url, a.mediaType, a.name, st));
    return {
      id: b64id(noteUrl),
      created_at: created,
      in_reply_to_id: replyTo ? b64id(replyTo) : null,
      in_reply_to_account_id: replyLocal ? replyLocal.user : null,
      sensitive: false, spoiler_text: '',
      visibility: 'public',
      language: 'en',
      uri: noteUrl,
      url: noteUrl,
      replies_count: 0,
      reblogs_count: usersWith(st.reblogs, noteUrl).length,
      favourites_count: usersWith(st.favourites, noteUrl).length,
      favourited: !!(viewer && st.favourites[viewer]?.[noteUrl]),
      reblogged: !!(viewer && st.reblogs[viewer]?.[noteUrl]),
      muted: false, bookmarked: false, pinned: false,
      content: `<p>${escapeHtml(text)}</p>`,
      reblog: null, application: null,
      account,
      media_attachments: attachments,
      mentions: [], tags: [], emojis: [], card: null, poll: null,
    };
  }

  /** Fetch one Note body over loopback. null on any failure. */
  async function fetchNote(notePath, auth) {
    try {
      const res = await lb(notePath, { headers: { accept: 'application/ld+json' }, auth });
      if (!res.ok) { try { await res.body?.cancel(); } catch { /* drained */ } return null; }
      return await res.json();
    } catch { return null; }
  }

  /** List one user's status refs (no bodies): [{ user, path, sortKey }]. */
  async function listStatusRefs(user, auth) {
    let container;
    try {
      const res = await lb(`/${user}/${STATUS_DIR}/`, { headers: { accept: 'application/ld+json' }, auth });
      if (!res.ok) { try { await res.body?.cancel(); } catch { /* drained */ } return []; }
      container = await res.json();
    } catch { return []; }
    const refs = [];
    for (const child of [].concat(container.contains ?? [])) {
      const cid = typeof child === 'string' ? child : child['@id'];
      const m = cid && /\/([0-9]+)\.jsonld$/.exec(cid);
      if (m) refs.push({ user, path: `/${user}/${STATUS_DIR}/${m[1]}.jsonld`, sortKey: BigInt(m[1]) });
    }
    return refs;
  }

  /**
   * The set of local users. With config.podsRoot: every directory that
   * looks like a pod (has a profile/ dir). Without it: just the fallback
   * (the caller), because the LDP root exposes no listing (probed — it
   * serves an HTML landing page). README Findings.
   */
  function localUsers(fallbackUser) {
    if (podsRoot) {
      try {
        return fs.readdirSync(podsRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .filter((d) => fs.existsSync(path.join(podsRoot, d.name, 'profile')))
          .map((d) => d.name);
      } catch { /* fall through */ }
    }
    return fallbackUser ? [fallbackUser] : [];
  }

  /** Does a local account exist? (Profile cards are world-readable.) */
  async function accountExists(username) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(username)) return false;
    if (podsRoot && fs.existsSync(path.join(podsRoot, username, 'profile'))) return true;
    try {
      const res = await lb(`/${username}/profile/card.jsonld`);
      try { await res.body?.cancel(); } catch { /* drained */ }
      return res.ok;
    } catch { return false; }
  }

  // ---- pagination ----------------------------------------------------------
  function pageArgs(query) {
    let limit = Number(query?.limit);
    limit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), PAGE_MAX) : PAGE_DEFAULT;
    return { limit, maxId: query?.max_id, sinceId: query?.since_id || query?.min_id };
  }

  /** Build the Link header for a page (rel=next → older, rel=prev → newer). */
  function linkHeader(selfPath, limit, page, hasMore, idOf) {
    const links = [];
    const mk = (params) => `${baseUrl}${selfPath}?${new URLSearchParams({ limit: String(limit), ...params })}`;
    if (hasMore && page.length) links.push(`<${mk({ max_id: idOf(page.at(-1)) })}>; rel="next"`);
    if (page.length) links.push(`<${mk({ min_id: idOf(page[0]) })}>; rel="prev"`);
    return links.length ? { link: links.join(', ') } : {};
  }

  /** Sort refs newest-first, filter by max_id/since_id, page, fetch, send. */
  async function respondStatusPage(request, reply, refs, viewer, auth, selfPath) {
    const { limit, maxId, sinceId } = pageArgs(request.query);
    refs.sort((a, b) => (a.sortKey === b.sortKey ? 0 : (a.sortKey < b.sortKey ? 1 : -1)));
    const maxK = maxId ? decodeStatusId(maxId)?.sortKey : undefined;
    const sinceK = sinceId ? decodeStatusId(sinceId)?.sortKey : undefined;
    let filtered = refs;
    if (maxK !== undefined && maxK !== null) filtered = filtered.filter((r) => r.sortKey < maxK);
    if (sinceK !== undefined && sinceK !== null) filtered = filtered.filter((r) => r.sortKey > sinceK);
    const page = filtered.slice(0, limit);
    const st = loadState();
    const statuses = [];
    for (const r of page) {
      const note = await fetchNote(r.path, auth);
      if (note) statuses.push(noteToStatus(note, `${baseUrl}${r.path}`, viewer, st));
    }
    const headers = linkHeader(selfPath, limit, page, filtered.length > limit, (r) => b64id(`${baseUrl}${r.path}`));
    return json(reply, 200, statuses, headers);
  }

  // =================================================================== routes

  // Claim + WAC-exempt the two fixed Mastodon roots (#602, JSS 0.0.219).
  // Literal reservations exempt the whole subtree but are READ-ONLY by
  // default. /api is widened to POST (statuses, media, actions), PUT (media
  // description update) and DELETE (status delete) — EXACTLY the verbs the
  // routes below implement. Because an exempted verb with no matching route
  // would fall through to core's LDP write wildcards as an unauthenticated
  // storage write (the documented trap), catch-all PUT/DELETE /api/*
  // handlers below answer 404 for everything unimplemented. /oauth stays
  // GET/HEAD/OPTIONS/POST — its only write routes are POSTs.
  api.reservePath('/api', { methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'] });
  api.reservePath('/oauth', { methods: ['GET', 'HEAD', 'OPTIONS', 'POST'] });

  // Preflight for the whole shim surface.
  for (const p of ['/api/*', '/oauth/*']) {
    api.fastify.options(p, (request, reply) => cors(reply).code(204).send());
  }
  // The trap-closers: any PUT/DELETE under /api that no specific route
  // claims is answered HERE (404 + CORS), never by LDP's write wildcards.
  const notFound = (request, reply) => json(reply, 404, { error: 'Record not found' });
  api.fastify.put('/api/*', notFound);
  api.fastify.delete('/api/*', notFound);

  // ------------------------------------------------------------- instance
  const instanceConfig = {
    statuses: { max_characters: 5000, max_media_attachments: 4, characters_reserved_per_url: 23 },
    media_attachments: {
      supported_mime_types: Object.values(EXT_MIME),
      image_size_limit: 16 * 1024 * 1024,
      video_size_limit: 16 * 1024 * 1024,
      image_matrix_limit: 33177600,
      video_matrix_limit: 8294400,
      video_frame_rate_limit: 120,
    },
    polls: { max_options: 0 },
  };
  api.fastify.get('/api/v1/instance', (request, reply) => json(reply, 200, {
    uri: new URL(baseUrl).host,
    title: instanceTitle,
    short_description: 'A JavaScript Solid Server pod, spoken to over the Mastodon API.',
    description: 'JSS-backed Mastodon API shim (issue #515). Your posts are '
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
    description: 'JSS-backed Mastodon API shim (issue #515).',
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
  // App-token introspection — Phanpy calls it right after registration.
  // Tokens aren't bound to apps in this shim, so answer with a sane stub.
  api.fastify.get('/api/v1/apps/verify_credentials', (request, reply) => json(reply, 200, {
    name: 'Mastodon client', website: null, vapid_key: '',
  }));

  // --------------------------------------------------------- oauth/authorize
  // A minimal login page (real browsers) plus a headless shortcut: pass
  // username+password as params and we mint + redirect straight away.
  // PKCE (Phanpy sends S256): the challenge is stashed with the code and
  // verified at token time.
  function issueCode(mint, p, reply) {
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, {
      ...mint,
      exp: Date.now() + CODE_TTL_MS,
      code_challenge: p.code_challenge || null,
      code_challenge_method: (p.code_challenge_method || 'S256').toUpperCase(),
    });
    const redirectUri = p.redirect_uri;
    if (!redirectUri || redirectUri === 'urn:ietf:wg:oauth:2.0:oob') {
      return cors(reply).code(200).type('text/html')
        .send(`<!doctype html><title>Authorized</title><p>Authorization code:</p>`
          + `<code id="code">${escapeHtml(code)}</code>`);
    }
    const sep = redirectUri.includes('?') ? '&' : '?';
    const location = `${redirectUri}${sep}code=${encodeURIComponent(code)}`
      + (p.state ? `&state=${encodeURIComponent(p.state)}` : '');
    return cors(reply).code(302).header('location', location).send();
  }

  function loginPage(p) {
    const hidden = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state',
      'code_challenge', 'code_challenge_method']
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
      return issueCode(mint, p, reply);
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
    const tokenResponse = (accessToken) => {
      const refresh = crypto.randomBytes(24).toString('base64url');
      refreshTokens.set(refresh, { access_token: accessToken });
      return {
        access_token: accessToken, token_type: 'Bearer', scope,
        refresh_token: refresh, created_at: now,
      };
    };

    if (grant === 'password') {
      const mint = await mintPodToken(p.username, p.password);
      if (!mint) return json(reply, 401, { error: 'invalid_grant', error_description: 'Invalid username or password' });
      return json(reply, 200, tokenResponse(mint.access_token));
    }

    if (grant === 'authorization_code') {
      const entry = p.code && codes.get(p.code);
      if (!entry || entry.exp < Date.now()) {
        return json(reply, 400, { error: 'invalid_grant', error_description: 'Unknown or expired authorization code' });
      }
      // PKCE: when the client sent a challenge at authorize time AND a
      // verifier now, check them (S256 or plain). A missing verifier is
      // tolerated — some clients send the challenge but downgrade.
      if (entry.code_challenge && p.code_verifier) {
        const derived = entry.code_challenge_method === 'PLAIN'
          ? String(p.code_verifier)
          : crypto.createHash('sha256').update(String(p.code_verifier)).digest('base64url');
        if (derived !== entry.code_challenge) {
          return json(reply, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
      }
      codes.delete(p.code); // one-time
      return json(reply, 200, tokenResponse(entry.access_token));
    }

    if (grant === 'refresh_token') {
      const entry = p.refresh_token && refreshTokens.get(p.refresh_token);
      if (!entry) return json(reply, 400, { error: 'invalid_grant', error_description: 'Unknown refresh token' });
      return json(reply, 200, {
        access_token: entry.access_token, token_type: 'Bearer', scope,
        refresh_token: p.refresh_token, created_at: now,
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

  api.fastify.post('/oauth/revoke', (request, reply) => {
    const p = readParams(request);
    if (p.token) refreshTokens.delete(p.token);
    // The pod bearer itself is the IdP's to revoke; acknowledging is the
    // whole Mastodon contract here.
    return json(reply, 200, {});
  });

  // ----------------------------------------------- accounts/verify_credentials
  api.fastify.get('/api/v1/accounts/verify_credentials', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const account = accountFor(username);
    account.url = webid.split('#')[0];
    account.uri = webid;
    // CredentialAccount: Phanpy reads source.privacy for the compose box.
    account.source = {
      note: '', fields: [], privacy: 'public', sensitive: false, language: 'en',
      follow_requests_count: 0,
    };
    return json(reply, 200, account);
  });

  // ------------------------------------------------------ accounts (static)
  // NOTE: static segments (relationships, lookup, search) outrank :id on
  // Fastify's router, so these are safe beside /accounts/:id.
  api.fastify.get('/api/v1/accounts/relationships', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const p = readParams(request);
    const ids = [].concat(p.id ?? []);
    const st = loadState();
    const mine = new Set(st.following[username] || []);
    return json(reply, 200, ids.map((id) => relationship(String(id), mine.has(String(id)))));
  });

  api.fastify.get('/api/v1/accounts/lookup', async (request, reply) => {
    const p = readParams(request);
    const raw = String(p.acct || '').replace(/^@/, '');
    const [name, host] = raw.split('@');
    if (!name || (host && host !== new URL(baseUrl).host)) {
      return json(reply, 404, { error: 'Record not found' });
    }
    if (!(await accountExists(name))) return json(reply, 404, { error: 'Record not found' });
    return json(reply, 200, accountFor(name));
  });

  api.fastify.get('/api/v1/accounts/search', (request, reply) => json(reply, 200, []));

  const relationship = (id, following) => ({
    id, following, showing_reblogs: true, notifying: false, languages: null,
    followed_by: false, blocking: false, blocked_by: false, muting: false,
    muting_notifications: false, requested: false, domain_blocking: false,
    endorsed: false, note: '',
  });

  // ------------------------------------------------------- accounts (by id)
  api.fastify.get('/api/v1/accounts/:id', async (request, reply) => {
    const id = String(request.params.id);
    if (!(await accountExists(id))) return json(reply, 404, { error: 'Record not found' });
    return json(reply, 200, accountFor(id));
  });

  api.fastify.get('/api/v1/accounts/:id/statuses', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    const viewer = webid ? podFromWebid(webid).username : null;
    const user = String(request.params.id);
    if (!(await accountExists(user))) return json(reply, 404, { error: 'Record not found' });
    if (String(request.query?.pinned) === 'true') return json(reply, 200, []);
    let refs = await listStatusRefs(user, request.headers.authorization);
    if (String(request.query?.only_media) === 'true' || String(request.query?.exclude_replies) === 'true') {
      // These filters need bodies; fetch bounded and filter.
      const auth = request.headers.authorization;
      const filtered = [];
      for (const r of refs.slice(0, MAX_WALK)) {
        const note = await fetchNote(r.path, auth);
        if (!note) continue;
        if (String(request.query?.exclude_replies) === 'true' && note.inReplyTo) continue;
        if (String(request.query?.only_media) === 'true' && ![].concat(note.attachment ?? []).length) continue;
        filtered.push(r);
      }
      refs = filtered;
    }
    return respondStatusPage(request, reply, refs, viewer, request.headers.authorization,
      `/api/v1/accounts/${user}/statuses`);
  });

  api.fastify.get('/api/v1/accounts/:id/followers', (request, reply) => json(reply, 200, []));
  api.fastify.get('/api/v1/accounts/:id/following', (request, reply) => {
    const st = loadState();
    return json(reply, 200, (st.following[String(request.params.id)] || []).map(accountFor));
  });

  async function setFollow(request, reply, on) {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const target = String(request.params.id);
    if (!(await accountExists(target))) return json(reply, 404, { error: 'Record not found' });
    const st = loadState();
    const list = new Set(st.following[username] || []);
    if (on) list.add(target);
    else list.delete(target);
    st.following[username] = [...list];
    saveState(st);
    // Recording is local-only; DELIVERING the Follow/Undo to the target's
    // AP inbox is Wave B (README Findings).
    return json(reply, 200, relationship(target, on));
  }
  api.fastify.post('/api/v1/accounts/:id/follow', (request, reply) => setFollow(request, reply, true));
  api.fastify.post('/api/v1/accounts/:id/unfollow', (request, reply) => setFollow(request, reply, false));

  // ---------------------------------------------------------- statuses (post)
  api.fastify.post('/api/v1/statuses', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const p = readParams(request);
    const text = typeof p.status === 'string' ? p.status : '';
    const mediaIds = [].concat(p.media_ids ?? []).filter(Boolean);
    if (!text.trim() && !mediaIds.length) {
      return json(reply, 422, { error: 'Validation failed: Text can\'t be blank' });
    }

    // media_ids → the already-uploaded pod URLs; unknown/malformed ids 422.
    const st = loadState();
    const attachments = [];
    for (const mid of mediaIds.slice(0, instanceConfig.statuses.max_media_attachments)) {
      const media = decodeMediaId(String(mid));
      if (!media) return json(reply, 422, { error: `Unknown media id ${String(mid).slice(0, 64)}` });
      const ext = media.name.slice(media.name.lastIndexOf('.') + 1).toLowerCase();
      const mime = EXT_MIME[ext] || 'application/octet-stream';
      attachments.push({
        type: attachmentKind(mime) === 'image' ? 'Image' : attachmentKind(mime) === 'video' ? 'Video' : 'Document',
        mediaType: mime,
        url: media.url,
        ...(st.media[media.url]?.description ? { name: st.media[media.url].description } : {}),
      });
    }

    // in_reply_to_id → the parent Note's URL on the Note itself (this is
    // what context/ threads walk, and what federates later).
    let inReplyTo;
    if (p.in_reply_to_id) {
      const parent = decodeStatusId(String(p.in_reply_to_id));
      if (!parent) return json(reply, 404, { error: 'Record not found' });
      inReplyTo = parent.url;
    }

    const { podPath, username } = podFromWebid(webid);
    const id = mintStatusId();
    const resourcePath = `${podPath}${STATUS_DIR}/${id}.jsonld`;
    const published = new Date().toISOString();
    const note = {
      '@context': AS_CONTEXT,
      id: `${baseUrl}${resourcePath}`,
      type: 'Note',
      attributedTo: webid,
      content: text,
      published,
      to: [AS_PUBLIC],
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(attachments.length ? { attachment: attachments } : {}),
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
    return json(reply, 200, noteToStatus(note, note.id, username, st));
  });

  // ---------------------------------------------- statuses (id-addressed)
  // NOTE on routing: these ids are base64url of full URLs and can exceed
  // find-my-way's maxParamLength (100 chars — a `:id` param then silently
  // stops matching). Wildcard segments are exempt from that limit, so every
  // id-addressed status/media route goes through a small dispatcher on
  // `/api/v1/statuses/*` instead of `:id` params (README Findings).
  const splitRest = (rest) => {
    const s = String(rest || '');
    const i = s.indexOf('/');
    return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
  };

  // Public statuses are world-readable in the pod, so no auth demanded here
  // — WAC decides via the (forwarded) Authorization, like everywhere else.
  async function showStatus(request, reply, id) {
    const decoded = decodeStatusId(id);
    if (!decoded) return json(reply, 404, { error: 'Record not found' });
    const note = await fetchNote(decoded.path, request.headers.authorization);
    if (!note) return json(reply, 404, { error: 'Record not found' });
    const webid = await api.auth.getAgent(request);
    const viewer = webid ? podFromWebid(webid).username : null;
    return json(reply, 200, noteToStatus(note, decoded.url, viewer));
  }

  async function deleteStatus(request, reply, id) {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const decoded = decodeStatusId(id);
    if (!decoded) return json(reply, 404, { error: 'Record not found' });
    if (decoded.user !== username) return json(reply, 403, { error: 'This action is not allowed' });
    const note = await fetchNote(decoded.path, request.headers.authorization);
    if (!note) return json(reply, 404, { error: 'Record not found' });
    const del = await lb(decoded.path, { method: 'DELETE', auth: request.headers.authorization });
    try { await del.body?.cancel(); } catch { /* drained */ }
    if (del.status === 401 || del.status === 403) {
      return json(reply, 403, { error: 'This action is not allowed' });
    }
    if (!(del.ok || del.status === 204)) {
      return json(reply, 500, { error: `Pod storage rejected the delete (${del.status})` });
    }
    // Mastodon returns the deleted status with `text` (the raw source).
    const status = noteToStatus(note, decoded.url, username);
    status.text = typeof note.content === 'string' ? note.content : '';
    return json(reply, 200, status);
  }

  async function statusContext(request, reply, id) {
    const decoded = decodeStatusId(id);
    if (!decoded) return json(reply, 404, { error: 'Record not found' });
    const auth = request.headers.authorization;
    const target = await fetchNote(decoded.path, auth);
    if (!target) return json(reply, 404, { error: 'Record not found' });
    const webid = await api.auth.getAgent(request);
    const viewer = webid ? podFromWebid(webid).username : null;
    const st = loadState();

    // Ancestors: walk the inReplyTo chain upward through LOCAL statuses.
    const ancestors = [];
    let cursor = target;
    for (let depth = 0; depth < 50; depth++) {
      const up = typeof cursor.inReplyTo === 'string' ? decodeStatusUrl(cursor.inReplyTo) : null;
      if (!up) break;
      const parent = await fetchNote(up.path, auth);
      if (!parent) break;
      ancestors.unshift(noteToStatus(parent, up.url, viewer, st));
      cursor = parent;
    }

    // Descendants: bounded walk over local statuses, collecting everything
    // whose inReplyTo chain reaches the target.
    const users = localUsers(viewer || decoded.user);
    const refs = [];
    for (const u of users) refs.push(...await listStatusRefs(u, auth));
    refs.sort((a, b) => (a.sortKey === b.sortKey ? 0 : (a.sortKey < b.sortKey ? 1 : -1)));
    const notes = [];
    for (const r of refs.slice(0, MAX_WALK)) {
      if (r.path === decoded.path) continue;
      const note = await fetchNote(r.path, auth);
      if (note && typeof note.inReplyTo === 'string') notes.push({ ref: r, note });
    }
    const inThread = new Set([decoded.url]);
    const descendants = [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const { ref, note } of notes) {
        const url = note.id || `${baseUrl}${ref.path}`;
        if (inThread.has(url)) continue;
        if (inThread.has(note.inReplyTo)) {
          inThread.add(url);
          descendants.push({ ref, note });
          grew = true;
        }
      }
    }
    descendants.sort((a, b) => (a.ref.sortKey === b.ref.sortKey ? 0 : (a.ref.sortKey < b.ref.sortKey ? -1 : 1)));
    return json(reply, 200, {
      ancestors,
      descendants: descendants.map(({ ref, note }) => noteToStatus(note, `${baseUrl}${ref.path}`, viewer, st)),
    });
  }

  // -------------------------------------------- favourite / reblog (local)
  async function setFlag(request, reply, id, bucket, on) {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const decoded = decodeStatusId(id);
    if (!decoded) return json(reply, 404, { error: 'Record not found' });
    const note = await fetchNote(decoded.path, request.headers.authorization);
    if (!note) return json(reply, 404, { error: 'Record not found' });
    const st = loadState();
    st[bucket][username] = st[bucket][username] || {};
    if (on) st[bucket][username][decoded.url] = new Date().toISOString();
    else delete st[bucket][username][decoded.url];
    saveState(st);
    // Local record only — delivering the Like/Announce to the author's AP
    // inbox is Wave B (README Findings).
    return json(reply, 200, noteToStatus(note, decoded.url, username, st));
  }

  function flagAccounts(request, reply, id, bucket) {
    const decoded = decodeStatusId(id);
    if (!decoded) return json(reply, 404, { error: 'Record not found' });
    const st = loadState();
    return json(reply, 200, usersWith(st[bucket], decoded.url).map(accountFor));
  }

  // The wildcard dispatchers (maxParamLength exemption — see NOTE above).
  api.fastify.get('/api/v1/statuses/*', (request, reply) => {
    const [id, sub] = splitRest(request.params['*']);
    if (!id) return json(reply, 404, { error: 'Record not found' });
    if (sub === '') return showStatus(request, reply, id);
    if (sub === 'context') return statusContext(request, reply, id);
    if (sub === 'favourited_by') return flagAccounts(request, reply, id, 'favourites');
    if (sub === 'reblogged_by') return flagAccounts(request, reply, id, 'reblogs');
    return json(reply, 404, { error: 'Record not found' });
  });
  api.fastify.post('/api/v1/statuses/*', (request, reply) => {
    const [id, sub] = splitRest(request.params['*']);
    if (!id) return json(reply, 404, { error: 'Record not found' });
    if (sub === 'favourite') return setFlag(request, reply, id, 'favourites', true);
    if (sub === 'unfavourite') return setFlag(request, reply, id, 'favourites', false);
    if (sub === 'reblog') return setFlag(request, reply, id, 'reblogs', true);
    if (sub === 'unreblog') return setFlag(request, reply, id, 'reblogs', false);
    return json(reply, 404, { error: 'Record not found' });
  });
  api.fastify.delete('/api/v1/statuses/*', (request, reply) => {
    const [id, sub] = splitRest(request.params['*']);
    if (!id || sub !== '') return json(reply, 404, { error: 'Record not found' });
    return deleteStatus(request, reply, id);
  });

  // The caller's favourites, newest-fav-first, as real statuses.
  api.fastify.get('/api/v1/favourites', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const st = loadState();
    const mine = st.favourites[username] || {};
    const urls = Object.keys(mine).sort((a, b) => (mine[a] < mine[b] ? 1 : -1));
    const { limit } = pageArgs(request.query);
    const statuses = [];
    for (const url of urls.slice(0, limit)) {
      const d = decodeStatusUrl(url);
      if (!d) continue;
      const note = await fetchNote(d.path, request.headers.authorization);
      if (note) statuses.push(noteToStatus(note, d.url, username, st));
    }
    return json(reply, 200, statuses);
  });

  // -------------------------------------------------------- timelines
  // Home: your own posts + the local users you follow (recorded in state).
  api.fastify.get('/api/v1/timelines/home', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const st = loadState();
    const users = [...new Set([username, ...(st.following[username] || [])])];
    const refs = [];
    for (const u of users) refs.push(...await listStatusRefs(u, request.headers.authorization));
    return respondStatusPage(request, reply, refs, username, request.headers.authorization, '/api/v1/timelines/home');
  });

  // Public (local): all local users' public statuses. Pod enumeration needs
  // config.podsRoot (the LDP root serves HTML, not a listing — probed);
  // without it this degrades to the caller's own posts.
  api.fastify.get('/api/v1/timelines/public', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    const viewer = webid ? podFromWebid(webid).username : null;
    const users = localUsers(viewer);
    const refs = [];
    for (const u of users.slice(0, 100)) refs.push(...await listStatusRefs(u, request.headers.authorization));
    return respondStatusPage(request, reply, refs, viewer, request.headers.authorization, '/api/v1/timelines/public');
  });

  // No hashtag index locally — an empty, well-formed timeline.
  api.fastify.get('/api/v1/timelines/tag/:tag', (request, reply) => json(reply, 200, []));

  // ------------------------------------------------------------- media
  async function handleMediaUpload(request, reply) {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const ct = request.headers['content-type'] || '';
    if (!/multipart\/form-data/i.test(ct)) {
      return json(reply, 422, { error: 'Expected multipart/form-data with a file part' });
    }
    const parsed = parseMultipart(request.body, ct);
    if (parsed.error) return json(reply, 422, { error: `Validation failed: ${parsed.error}` });
    if (!parsed.file || !parsed.file.data.length) {
      return json(reply, 422, { error: 'Validation failed: File can\'t be blank' });
    }
    const { podPath } = podFromWebid(webid);
    const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(parsed.file.filename || '');
    const declaredMime = parsed.file.contentType.split(';')[0].trim().toLowerCase();
    const ext = (fromName && fromName[1].toLowerCase()) || MIME_EXT[declaredMime] || 'bin';
    const name = `${crypto.randomUUID()}.${ext}`;
    const resourcePath = `${podPath}${MEDIA_DIR}/${name}`;
    // Store via loopback PUT under the caller's OWN bearer — WAC decides.
    const put = await lb(resourcePath, {
      method: 'PUT',
      headers: { 'content-type': EXT_MIME[ext] || declaredMime || 'application/octet-stream' },
      body: parsed.file.data,
      auth: request.headers.authorization,
    });
    try { await put.body?.cancel(); } catch { /* drained */ }
    if (put.status === 401 || put.status === 403) {
      return json(reply, 403, { error: 'This action is not allowed' });
    }
    if (!(put.ok || put.status === 204)) {
      return json(reply, 500, { error: `Pod storage rejected the upload (${put.status})` });
    }
    const url = `${baseUrl}${resourcePath}`;
    const st = loadState();
    if (parsed.fields.description) {
      st.media[url] = { description: parsed.fields.description };
      saveState(st);
    }
    return json(reply, 200, attachmentEntity(url, EXT_MIME[ext] || declaredMime, parsed.fields.description || null, st));
  }
  api.fastify.post('/api/v2/media', handleMediaUpload);
  api.fastify.post('/api/v1/media', handleMediaUpload); // older clients

  // Wildcard, not :id — the base64url-of-URL ids exceed maxParamLength.
  api.fastify.get('/api/v1/media/*', (request, reply) => {
    const [id, sub] = splitRest(request.params['*']);
    const media = sub === '' ? decodeMediaId(id) : null;
    if (!media) return json(reply, 404, { error: 'Record not found' });
    return json(reply, 200, attachmentEntity(media.url, null, null, loadState()));
  });

  // Alt-text editing (Phanpy PUTs an updated description).
  api.fastify.put('/api/v1/media/*', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const [id, sub] = splitRest(request.params['*']);
    const media = sub === '' ? decodeMediaId(id) : null;
    if (!media) return json(reply, 404, { error: 'Record not found' });
    const p = readParams(request);
    const st = loadState();
    if (typeof p.description === 'string') {
      st.media[media.url] = { ...(st.media[media.url] || {}), description: p.description };
      saveState(st);
    }
    return json(reply, 200, attachmentEntity(media.url, null, null, st));
  });

  // -------------------------------------------------------- notifications
  // Read the AP inbox the activitypub/ plugin persists — over loopback,
  // with the caller's own Bearer forwarded (the integration contract:
  // GET {apRoot}/<user>/inbox?page=true → OrderedCollectionPage of raw AS2
  // activities, newest first). Unresolvable items are skipped, never 500s;
  // remote actors are rendered from the actor URL alone (Wave B fetches).
  api.fastify.get('/api/v1/notifications', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return json(reply, 401, { error: 'The access token is invalid' });
    const { username } = podFromWebid(webid);
    const auth = request.headers.authorization;
    let items = [];
    try {
      const res = await lb(`${apRoot}/${username}/inbox?page=true`, {
        headers: { accept: 'application/activity+json, application/ld+json, application/json' },
        auth,
      });
      if (res.ok) {
        const page = await res.json();
        items = [].concat(page.orderedItems ?? []);
      } else {
        try { await res.body?.cancel(); } catch { /* drained */ }
      }
    } catch { /* inbox unavailable → empty tab, not an error */ }

    const st = loadState();
    const notifs = [];
    for (const item of items) {
      // Tolerate both the raw-activity contract and a {receivedAt, activity}
      // wrapper, so a partially-updated activitypub/ doesn't blank the tab.
      const act = item && item.type ? item : (item?.activity || null);
      if (!act || typeof act !== 'object') continue;
      const created = act.published || item?.receivedAt || new Date().toISOString();
      const account = accountForActor(typeof act.actor === 'string' ? act.actor : act.actor?.id);
      const nid = b64id(act.id || `${act.type}:${act.actor}:${created}`);
      const objUrl = typeof act.object === 'string' ? act.object : act.object?.id;

      if (act.type === 'Follow') {
        notifs.push({ id: nid, type: 'follow', created_at: created, account });
      } else if (act.type === 'Like' || act.type === 'Announce') {
        const d = objUrl ? decodeStatusUrl(objUrl) : null;
        if (!d) continue; // not one of our statuses — skip, don't 500
        const note = await fetchNote(d.path, auth);
        if (!note) continue;
        notifs.push({
          id: nid,
          type: act.type === 'Like' ? 'favourite' : 'reblog',
          created_at: created,
          account,
          status: noteToStatus(note, d.url, username, st),
        });
      } else if (act.type === 'Create' && act.object && typeof act.object === 'object'
        && act.object.type === 'Note') {
        const obj = act.object;
        const tags = [].concat(obj.tag ?? []);
        const mentioned = tags.some((t) => t && t.type === 'Mention'
          && (String(t.href || '').includes(`/${username}/`) || String(t.href || '').includes(`/${username}`)
            || String(t.name || '').includes(username)));
        const replyTo = typeof obj.inReplyTo === 'string' ? decodeStatusUrl(obj.inReplyTo) : null;
        if (!mentioned && !(replyTo && replyTo.user === username)) continue;
        notifs.push({
          id: nid,
          type: 'mention',
          created_at: created,
          account,
          status: noteToStatus(obj, obj.id || '', username, st),
        });
      }
      // Undo / anything else: skipped.
    }

    notifs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    // Positional pagination (notification ids aren't time-sortable keys).
    const { limit, maxId, sinceId } = pageArgs(request.query);
    let list = notifs;
    if (maxId) {
      const i = list.findIndex((n) => n.id === maxId);
      if (i !== -1) list = list.slice(i + 1);
    }
    if (sinceId) {
      const i = list.findIndex((n) => n.id === sinceId);
      if (i !== -1) list = list.slice(0, i);
    }
    const page = list.slice(0, limit);
    const headers = linkHeader('/api/v1/notifications', limit, page, list.length > limit, (n) => n.id);
    return json(reply, 200, page, headers);
  });
  api.fastify.post('/api/v1/notifications/clear', (request, reply) => json(reply, 200, {}));

  // ------------------------------------------------------------- stubs
  // Everything Phanpy touches that has no local meaning yet answers its
  // EMPTY shape with CORS, so the client renders instead of erroring.
  const EMPTY_ARRAYS = [
    '/api/v1/custom_emojis',
    '/api/v1/filters', '/api/v2/filters',
    '/api/v1/lists',
    '/api/v1/bookmarks',
    '/api/v1/follow_requests',
    '/api/v1/conversations',
    '/api/v1/scheduled_statuses',
    '/api/v1/announcements',
    '/api/v1/mutes', '/api/v1/blocks', '/api/v1/domain_blocks',
    '/api/v1/endorsements',
    '/api/v1/instance/peers', '/api/v1/instance/activity',
    '/api/v1/trends', '/api/v1/trends/tags', '/api/v1/trends/statuses', '/api/v1/trends/links',
    '/api/v2/trends/tags', '/api/v2/trends/statuses', '/api/v2/trends/links',
    '/api/v1/directory',
  ];
  for (const p of EMPTY_ARRAYS) {
    api.fastify.get(p, (request, reply) => json(reply, 200, []));
  }
  const emptySearch = (request, reply) => json(reply, 200, { accounts: [], statuses: [], hashtags: [] });
  api.fastify.get('/api/v1/search', emptySearch);
  api.fastify.get('/api/v2/search', emptySearch);
  api.fastify.get('/api/v1/markers', (request, reply) => json(reply, 200, {}));
  api.fastify.post('/api/v1/markers', (request, reply) => json(reply, 200, {}));
  api.fastify.get('/api/v1/preferences', (request, reply) => json(reply, 200, {
    'posting:default:visibility': 'public',
    'posting:default:sensitive': false,
    'posting:default:language': 'en',
    'reading:expand:media': 'default',
    'reading:expand:spoilers': false,
  }));
  // No ws streaming (a /api ws upgrade would fight the HTTP reservation;
  // Phanpy falls back to polling) — but the health probe answers.
  api.fastify.get('/api/v1/streaming/health', (request, reply) => cors(reply)
    .code(200).type('text/plain').send('OK'));

  api.log.info(`mastodon: shim at /api/v1|v2 + /oauth/* → pods via ${loopback} `
    + `(#515 Phase 2: timelines, media, favourites/boosts, notifications via ${apRoot}; `
    + `podsRoot ${podsRoot ? 'set' : 'unset — public timeline degrades to own posts'})`);
}
