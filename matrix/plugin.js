// Matrix Client-Server API shim (a chat protocol) as a #206 loader plugin.
//
//   plugins: [{ module: 'matrix/plugin.js',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// Phase 1 — "a personal Matrix client over your own pod". Point a Matrix
// client (Element, or a raw Client-Server API caller) at this server and it
// can log in with its pod credentials, create a room, send a message, and
// read the room's timeline back. No federation, no /sync since-tokens, no
// other homeservers: a room is a JSON resource in YOUR pod and its timeline
// is the events you appended to it.
//
// -------------------------------------------------------------- the shape
//
// Matrix clients speak the Client-Server API at FIXED absolute endpoints
// under `/_matrix/client/...` — `/_matrix/client/versions`,
// `/_matrix/client/v3/login`, `/_matrix/client/v3/createRoom`, … — that no
// single plugin `prefix` can own. So, exactly like mastodon/ registers
// `/api` + `/oauth`, bluesky/ registers `/xrpc`, and nip05/ claims
// `/.well-known/nostr.json`, this plugin registers the `/_matrix/*` routes
// straight on `api.fastify`. The loader does not confine a plugin's routes
// to its prefix, and each `/_matrix/client/...` route outranks core's LDP
// `GET /*` wildcard on Fastify's route-specificity ordering. That the whole
// Matrix Client-Server surface lives at ONE fixed root OUTSIDE the plugin's
// own prefix — which the plugin cannot WAC-exempt itself — is the headline
// finding (README "Findings"): the Nth independent confirmation of the
// mastodon/bluesky reserved-path seam, now for a CHAT protocol.
//
// --------------------------------------------------------- the token bridge
//
// Matrix's `access_token` IS just a bearer the client resends on every call
// (`Authorization: Bearer <token>`). A Solid pod's access token is *also*
// just a bearer. So the bridge is direct, exactly as in mastodon/bluesky/:
// `POST /_matrix/client/v3/login` with `m.login.password` calls the host's
// own `POST /idp/credentials` over loopback (the CTH programmatic-credentials
// endpoint) and hands the resulting pod Bearer back as the Matrix
// `access_token`. From then on the client's `Authorization: Bearer <token>`
// authenticates directly against the pod: `api.auth.getAgent(request)`
// resolves it to the WebID, and room/message writes are loopback LDP PUTs
// carrying that same bearer, so real WAC — not this shim — decides what the
// caller may write. A 4th protocol proving the same bridge (after the two
// microblog shims and their OAuth/XRPC session models).
//
// --------------------------------------------------------- object mapping
//
// Matrix user_id   = `@<pod>:<host>` — pod = first WebID path segment, host =
//                    the homeserver's server_name (new URL(baseUrl).host).
// Matrix room      = one JSON resource in the pod at
//                    <pod>/matrix/rooms/<localpart>.json holding room state
//                    plus the full event timeline (`events: [...]`).
// Matrix room_id   = `!<localpart>:<host>`; <localpart> is the filename.
// Matrix event_id  = `$<opaque>` (an event id, v3+ grammar — no domain part).
// timeline event   = `{ event_id, type, sender, content, origin_server_ts,
//                    room_id, txn_id }` appended to the room resource.

import crypto from 'node:crypto';

const ROOM_DIR = 'matrix/rooms'; // where room resources live inside a pod
const MATRIX_VERSIONS = ['r0.6.1', 'v1.1', 'v1.6', 'v1.10']; // what we advertise

// ---------------------------------------------------------------- id minting
const opaque = (n = 18) => crypto.randomBytes(n).toString('base64url');

/**
 * Derive the pod root path and a display username from a WebID.
 * Path-mode WebID:   http://host/alice/profile/card.jsonld#me → { alice, /alice/ }
 * Single-user WebID: http://host/profile/card.jsonld#me       → { host label, / }
 * (Copied from mastodon/bluesky — the same WebID→pod convention.)
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
 * Merge a request's query with its parsed body into one flat object. JSS
 * parses application/json into an object but hands other bodies through as a
 * Buffer (server.js wildcard parser), so decode those here. Matrix is all
 * JSON, but be forgiving. (Copied from mastodon/.)
 */
function readParams(request) {
  const out = { ...(request.query || {}) };
  let body = request.body;
  const ct = (request.headers['content-type'] || '').toLowerCase();
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string' && body.length) {
    if (ct.includes('application/json') || body.trim().startsWith('{')) {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
  }
  if (body && typeof body === 'object') Object.assign(out, body);
  return out;
}

export async function activate(api) {
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'matrix plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin (same finding as notifications/, mastodon/, bluesky/). It '
      + 'is needed to build the homeserver server_name (user_id/room_id host) and '
      + 'to reach the host over loopback.',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  const serverName = new URL(baseUrl).host; // Matrix server_name for @user:host / !room:host

  // ----------------------------------------------------------------- helpers
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type')
    .header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  const json = (reply, code, obj) => cors(reply)
    .code(code).header('content-type', 'application/json; charset=utf-8').send(obj);
  // A Matrix standard error body { errcode, error }.
  const err = (reply, code, errcode, error) => json(reply, code, { errcode, error });

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

  const userIdFromWebid = (webid) => `@${podFromWebid(webid).username}:${serverName}`;

  // A room_id's localpart is the pod filename. `!local:host` → `local`.
  const roomLocalpart = (roomId) => String(roomId || '').replace(/^!/, '').split(':')[0];
  const roomIdFor = (local) => `!${local}:${serverName}`;

  /** Read a room resource (JSON) from the caller's pod. null if absent. */
  async function readRoom(podPath, local, auth) {
    const res = await lb(`${podPath}${ROOM_DIR}/${local}.json`, {
      headers: { accept: 'application/json' }, auth,
    });
    if (!res.ok) return { status: res.status, room: null };
    try { return { status: 200, room: await res.json() }; } catch { return { status: 500, room: null }; }
  }

  /** Write a room resource (JSON) to the caller's pod under their bearer. */
  async function writeRoom(podPath, local, room, auth) {
    return lb(`${podPath}${ROOM_DIR}/${local}.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(room, null, 2),
      auth,
    });
  }

  // Shape a stored timeline event for a Client-Server response.
  const toEvent = (e, roomId) => ({
    type: e.type,
    sender: e.sender,
    content: e.content,
    event_id: e.event_id,
    origin_server_ts: e.origin_server_ts,
    room_id: roomId,
    unsigned: { transaction_id: e.txn_id },
  });

  // =================================================================== routes

  // Preflight for the whole shim surface (Element is a browser app).
  api.fastify.options('/_matrix/*', (request, reply) => cors(reply).code(204).send());

  // ------------------------------------------------------------- versions
  // Public: the very first call every Matrix client makes.
  api.fastify.get('/_matrix/client/versions', (request, reply) => json(reply, 200, {
    versions: MATRIX_VERSIONS,
    unstable_features: {},
  }));

  // Some clients probe the homeserver's well-known too; harmless to answer.
  api.fastify.get('/.well-known/matrix/client', (request, reply) => json(reply, 200, {
    'm.homeserver': { base_url: baseUrl },
  }));

  // ------------------------------------------------------------- login
  // GET advertises the supported flows; POST performs m.login.password.
  api.fastify.get('/_matrix/client/v3/login', (request, reply) => json(reply, 200, {
    flows: [{ type: 'm.login.password' }],
  }));

  api.fastify.post('/_matrix/client/v3/login', async (request, reply) => {
    const p = readParams(request);
    if (p.type && p.type !== 'm.login.password') {
      return err(reply, 400, 'M_UNKNOWN', `login type ${p.type} not supported (only m.login.password)`);
    }
    // identifier can be { type: 'm.id.user', user } or the legacy top-level `user`.
    const id = p.identifier || {};
    const user = id.user || p.user || (typeof id.address === 'string' ? id.address : undefined);
    const mint = await mintPodToken(user, p.password);
    if (!mint) return err(reply, 403, 'M_FORBIDDEN', 'Invalid username or password');

    const userId = mint.webid ? userIdFromWebid(mint.webid) : `@${user}:${serverName}`;
    const deviceId = p.device_id || `JSS_${opaque(6)}`;
    return json(reply, 200, {
      user_id: userId,
      access_token: mint.access_token, // the pod bearer, verbatim
      device_id: deviceId,
      home_server: serverName,         // deprecated field, but clients still read it
      well_known: { 'm.homeserver': { base_url: baseUrl } },
    });
  });

  // ------------------------------------------------------------- whoami
  api.fastify.get('/_matrix/client/v3/account/whoami', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'M_UNKNOWN_TOKEN', 'Unrecognised access token');
    return json(reply, 200, { user_id: userIdFromWebid(webid) });
  });

  // ------------------------------------------------------------- createRoom
  api.fastify.post('/_matrix/client/v3/createRoom', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'M_MISSING_TOKEN', 'Missing access token');
    const p = readParams(request);
    const { podPath } = podFromWebid(webid);
    const auth = request.headers.authorization;
    const creator = userIdFromWebid(webid);

    const local = opaque(16);
    const roomId = roomIdFor(local);
    const now = Date.now();
    const room = {
      room_id: roomId,
      creator,
      name: typeof p.name === 'string' ? p.name : '',
      topic: typeof p.topic === 'string' ? p.topic : '',
      visibility: p.visibility === 'public' ? 'public' : 'private',
      preset: p.preset || null,
      created: now,
      // m.room.create is the first timeline event, by Matrix convention.
      events: [{
        event_id: `$${opaque(18)}`,
        type: 'm.room.create',
        sender: creator,
        content: { creator, room_version: '10' },
        origin_server_ts: now,
        txn_id: null,
      }],
    };

    const put = await writeRoom(podPath, local, room, auth);
    if (put.status === 401 || put.status === 403) {
      return err(reply, 403, 'M_FORBIDDEN', 'You are not allowed to create a room in this pod');
    }
    if (!(put.ok || put.status === 204)) {
      return err(reply, 500, 'M_UNKNOWN', `Pod storage rejected the room (${put.status})`);
    }
    return json(reply, 200, { room_id: roomId });
  });

  // ------------------------------------------------ send m.room.message event
  api.fastify.put('/_matrix/client/v3/rooms/:roomId/send/:eventType/:txnId', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'M_MISSING_TOKEN', 'Missing access token');
    const eventType = request.params.eventType;
    const txnId = request.params.txnId;
    const roomId = roomIdFor(roomLocalpart(request.params.roomId)); // normalise to our server_name
    const local = roomLocalpart(request.params.roomId);
    const { podPath } = podFromWebid(webid);
    const auth = request.headers.authorization;
    const content = readParams(request);

    const { status, room } = await readRoom(podPath, local, auth);
    if (status === 401 || status === 403) return err(reply, 403, 'M_FORBIDDEN', 'Not allowed');
    if (!room) return err(reply, 404, 'M_NOT_FOUND', `Unknown room ${roomId}`);

    room.events = Array.isArray(room.events) ? room.events : [];
    // Idempotency: a re-sent txnId returns the same event_id, no duplicate.
    const existing = room.events.find((e) => e.txn_id && e.txn_id === txnId);
    if (existing) return json(reply, 200, { event_id: existing.event_id });

    const eventId = `$${opaque(18)}`;
    room.events.push({
      event_id: eventId,
      type: eventType,
      sender: userIdFromWebid(webid),
      content,
      origin_server_ts: Date.now(),
      txn_id: txnId,
    });

    const put = await writeRoom(podPath, local, room, auth);
    if (!(put.ok || put.status === 204)) {
      return err(reply, 500, 'M_UNKNOWN', `Pod storage rejected the event (${put.status})`);
    }
    return json(reply, 200, { event_id: eventId });
  });

  // ----------------------------------------------------- room messages (read)
  api.fastify.get('/_matrix/client/v3/rooms/:roomId/messages', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'M_MISSING_TOKEN', 'Missing access token');
    const local = roomLocalpart(request.params.roomId);
    const roomId = roomIdFor(local);
    const { podPath } = podFromWebid(webid);
    const auth = request.headers.authorization;

    const { room } = await readRoom(podPath, local, auth);
    if (!room) return err(reply, 404, 'M_NOT_FOUND', `Unknown room ${roomId}`);
    const events = (Array.isArray(room.events) ? room.events : []).map((e) => toEvent(e, roomId));
    // `dir=b` (default, newest-first) vs `dir=f` (oldest-first).
    const chunk = request.query?.dir === 'f' ? events : [...events].reverse();
    return json(reply, 200, {
      chunk,
      start: 't0',
      end: `t${events.length}`,
    });
  });

  // ---------------------------------------------------------- joined_rooms
  api.fastify.get('/_matrix/client/v3/joined_rooms', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'M_MISSING_TOKEN', 'Missing access token');
    const { podPath } = podFromWebid(webid);
    const auth = request.headers.authorization;

    const list = await lb(`${podPath}${ROOM_DIR}/`, {
      headers: { accept: 'application/ld+json' }, auth,
    });
    if (list.status === 404 || !list.ok) return json(reply, 200, { joined_rooms: [] });
    let container;
    try { container = await list.json(); } catch { return json(reply, 200, { joined_rooms: [] }); }

    const contains = [].concat(container.contains ?? []);
    const rooms = [];
    for (const child of contains) {
      const cid = typeof child === 'string' ? child : child['@id'];
      if (!cid) continue;
      const m = /\/([^/]+)\.json$/.exec(cid);
      if (m) rooms.push(roomIdFor(m[1]));
    }
    return json(reply, 200, { joined_rooms: rooms });
  });

  // ------------------------------------------------------------- sync (STUB)
  // Minimal full-state /sync: no since-token support, no incremental deltas,
  // no typing/receipts/presence. It walks the caller's rooms and returns each
  // room's whole timeline every time. `next_batch` is a placeholder; a client
  // that resends it as `since` still gets the full state back (documented
  // Phase-2 gap — a real /sync needs SERVER-SIDE per-device sync state and a
  // live push channel, which relates to the missing api.events seam).
  api.fastify.get('/_matrix/client/v3/sync', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'M_MISSING_TOKEN', 'Missing access token');
    const { podPath } = podFromWebid(webid);
    const auth = request.headers.authorization;

    const join = {};
    const list = await lb(`${podPath}${ROOM_DIR}/`, {
      headers: { accept: 'application/ld+json' }, auth,
    });
    if (list.ok) {
      let container;
      try { container = await list.json(); } catch { container = {}; }
      const contains = [].concat(container.contains ?? []);
      for (const child of contains) {
        const cid = typeof child === 'string' ? child : child['@id'];
        const m = cid && /\/([^/]+)\.json$/.exec(cid);
        if (!m) continue;
        const local = m[1];
        const { room } = await readRoom(podPath, local, auth);
        if (!room) continue;
        const roomId = roomIdFor(local);
        const events = (Array.isArray(room.events) ? room.events : []).map((e) => toEvent(e, roomId));
        join[roomId] = {
          timeline: { events, limited: false, prev_batch: 't0' },
          state: { events: [] },
          account_data: { events: [] },
          ephemeral: { events: [] },
          unread_notifications: { notification_count: 0, highlight_count: 0 },
        };
      }
    }
    return json(reply, 200, {
      next_batch: `s${Date.now()}`,
      rooms: { join, invite: {}, leave: {} },
      account_data: { events: [] },
      presence: { events: [] },
    });
  });

  api.log.info(`matrix: Client-Server shim at /_matrix/client/* → pods via ${loopback} (Phase 1)`);
  // The load-bearing caveat (see README "Findings"): these absolute routes
  // register fine, but they are only reachable if the operator has WAC-
  // exempted the /_matrix root. A plugin gets ONE prefix pushed to appPaths
  // and cannot self-exempt a fixed protocol root — so the operator must pass
  // `appPaths: ['/_matrix']` to createServer. Same seam as mastodon/bluesky/.
  api.log.warn('matrix: /_matrix must be in appPaths or WAC will 401 every client '
    + 'request — the one-prefix plugin model cannot self-exempt a fixed protocol root');
}
