// Bluesky / AT-Protocol shim (JSS issue #211) as a #206 loader plugin.
//
//   plugins: [{ module: 'bluesky/plugin.js',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// Phase 1 of #211 — "a personal AT-Protocol client over your own pod".
// Point a Bluesky client (or the `@atproto/api` XRPC client) at this server
// and it can log in, post an `app.bsky.feed.post`, and read its own posts
// back. No federation, no relay, no other people's feeds: your author feed
// IS the posts you wrote, stored as AT records in your own Solid pod.
//
// -------------------------------------------------------------- the shape
//
// AT-Protocol clients speak XRPC over HTTP at FIXED absolute endpoints
// `/xrpc/<nsid>` — `/xrpc/com.atproto.server.createSession`,
// `/xrpc/com.atproto.repo.createRecord`, … — that no single plugin `prefix`
// can own. So, exactly like mastodon/ registers `/api` + `/oauth` and nip05/
// claims `/.well-known/nostr.json`, this plugin registers the `/xrpc/*`
// routes straight on `api.fastify`. The loader does not confine a plugin's
// routes to its prefix, and each `/xrpc/<nsid>` static route outranks core's
// LDP `GET /*` wildcard on Fastify's route-specificity ordering. That the
// whole XRPC surface lives at ONE fixed root OUTSIDE the plugin's own prefix
// — which the plugin cannot WAC-exempt itself — is the headline finding
// (README "Findings"): a SECOND independent confirmation of mastodon's
// reserved-path/multi-prefix seam.
//
// --------------------------------------------------------- the token bridge
//
// AT-Protocol's `accessJwt` IS just a bearer the client resends on every
// call. A Solid pod's access token is *also* just a bearer. So the bridge is
// direct, exactly as in mastodon/: `com.atproto.server.createSession` with
// `{ identifier, password }` calls the host's own `POST /idp/credentials`
// over loopback (the CTH programmatic-credentials endpoint) and hands the
// resulting pod Bearer back as the `accessJwt` (and `refreshJwt` — the shim
// has no refresh cycle of its own). From then on the client's
// `Authorization: Bearer <pod-token>` authenticates directly against the pod:
// `api.auth.getAgent(request)` resolves it to the WebID, and record writes
// are loopback LDP PUTs carrying that same bearer, so real WAC — not this
// shim — decides what the caller may write.
//
// --------------------------------------------------------- object mapping
//
// AT `did`         = a synthetic `did:web:<host>[:<user>]` derived from the
//                    WebID (see didFromWebid) — opaque to clients, decodable
//                    back to a pod path by the shim.
// AT `handle`      = the pod name (first WebID path segment).
// AT record        = one JSON resource in the pod at
//                    <pod>/public/bsky/<rkey>.json holding the AT record
//                    `{ $type:'app.bsky.feed.post', text, createdAt }`.
// AT `rkey`        = a TID (timestamp id, base32-sortable) minted at write
//                    time; also the filename, so feeds sort chronologically.
// AT `cid`         = a content hash of the record (sha256 → base32), NOT a
//                    real dag-cbor CIDv1 — clients treat cids as opaque.
// AT `uri`         = at://<did>/app.bsky.feed.post/<rkey>.

import crypto from 'node:crypto';

const POST_NSID = 'app.bsky.feed.post';
const RECORD_DIR = 'public/bsky'; // where AT records live inside a pod

// -------------------------------------------------------------- base32 (lower, rfc4648, no pad)
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const byte of buf) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

// -------------------------------------------------------------- TID rkeys
// AT TIDs are 64-bit (microsecond clock + a clock-id), encoded 13 chars in a
// sortable base32 alphabet, so lexical order == chronological order.
const TID_B32 = '234567abcdefghijklmnopqrstuvwxyz';
let lastTid = 0n;
function mintTid() {
  let t = (BigInt(Date.now()) * 1000n) << 10n; // micros in the clock field, clockid 0
  if (t <= lastTid) t = lastTid + 1n; // strictly monotonic within a process
  lastTid = t;
  let n = t & ((1n << 65n) - 1n);
  let s = '';
  for (let i = 0; i < 13; i += 1) {
    s = TID_B32[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}

// A stable content hash for a post record. Not a dag-cbor CIDv1; a plausible,
// opaque, deterministic "bafyrei…"-shaped string over the record's fields.
function cidFor(record) {
  const canon = `${record.$type}\n${record.createdAt}\n${record.text || ''}`;
  const h = crypto.createHash('sha256').update(canon).digest();
  return `bafyrei${base32(h).slice(0, 52)}`;
}

/**
 * Derive the pod root path + display handle from a WebID.
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

/** WebID → synthetic did:web. Path-mode encodes the user as a path segment. */
function didFromWebid(webid) {
  const { origin, username, podPath } = podFromWebid(webid);
  const encHost = new URL(origin).host.replace(/:/g, '%3A'); // did:web encodes ':' as %3A
  return podPath === '/' ? `did:web:${encHost}` : `did:web:${encHost}:${username}`;
}

/** Decode one of OUR did:web values back to a pod location (best effort). */
function podFromDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:web:')) return null;
  const parts = did.slice('did:web:'.length).split(':');
  const host = (parts[0] || '').replace(/%3A/gi, ':');
  if (!host) return null;
  const scheme = /^(127\.0\.0\.1|localhost|\[::1\])/.test(host) ? 'http' : 'https';
  const origin = `${scheme}://${host}`;
  const username = parts[1];
  return username
    ? { origin, username, podPath: `/${username}/` }
    : { origin, username: host.split('.')[0], podPath: '/' };
}

/**
 * Merge a request's query with its parsed body into one flat object. JSS
 * parses application/json into an object but hands other bodies through as a
 * Buffer (server.js wildcard parser), so decode those here. XRPC is JSON, but
 * being liberal keeps curl/form callers working too.
 */
function readParams(request) {
  const out = { ...(request.query || {}) };
  let body = request.body;
  const ct = (request.headers['content-type'] || '').toLowerCase();
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string' && body.length) {
    if (ct.includes('application/json') || body.trimStart().startsWith('{')) {
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
      'bluesky plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin (same finding as mastodon/, notifications/ and webdav/). '
      + 'It is needed to derive the service DID and to reach the host over loopback.',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  const serviceHost = new URL(baseUrl).host;
  const serviceDid = `did:web:${serviceHost.replace(/:/g, '%3A')}`;

  // ----------------------------------------------------------------- helpers
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type, dpop, atproto-accept-labelers')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS');
  const json = (reply, code, obj) => cors(reply)
    .code(code).header('content-type', 'application/json; charset=utf-8').send(obj);
  const xrpcErr = (reply, code, error, message) => json(reply, code, { error, message: message || error });

  /** Reach the host over loopback, forwarding the caller's Authorization. */
  const lb = (p, { method = 'GET', headers = {}, body, auth } = {}) => fetch(loopback + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
  });

  /** Bridge identifier+password to a pod Bearer + WebID via the host's IdP. */
  async function mintPodToken(identifier, password) {
    if (!identifier || !password) return null;
    try {
      const res = await lb('/idp/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: identifier, password }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      return body.access_token ? { access_token: body.access_token, webid: body.webid } : null;
    } catch {
      return null;
    }
  }

  /** Build an AT profile-ish actor object from a WebID. */
  function actorFromWebid(webid) {
    const { username } = podFromWebid(webid);
    return {
      did: didFromWebid(webid),
      handle: username,
      displayName: username,
      avatar: undefined,
      viewer: { muted: false, blockedBy: false },
      labels: [],
    };
  }

  /** Map a stored AT record + its rkey to a post view for a feed. */
  function recordToPostView(record, rkey, webid) {
    const did = didFromWebid(webid);
    const uri = `at://${did}/${POST_NSID}/${rkey}`;
    const createdAt = record.createdAt || new Date().toISOString();
    return {
      post: {
        uri,
        cid: cidFor(record),
        author: actorFromWebid(webid),
        record: { $type: POST_NSID, text: record.text || '', createdAt },
        replyCount: 0,
        repostCount: 0,
        likeCount: 0,
        quoteCount: 0,
        indexedAt: createdAt,
        labels: [],
        viewer: {},
      },
    };
  }

  /**
   * List a pod's app.bsky.feed.post records (newest first) by reading the
   * public/bsky/ container and each contained resource. Forwards the caller's
   * bearer, so real WAC governs the read.
   */
  async function listPosts(podPath, auth) {
    const list = await lb(`${podPath}${RECORD_DIR}/`, {
      headers: { accept: 'application/ld+json' }, auth,
    });
    if (!list.ok) return []; // 404 (no posts yet) or WAC refusal → empty feed
    let container;
    try { container = await list.json(); } catch { return []; }

    const contains = [].concat(container.contains ?? []);
    const rkeys = [];
    for (const child of contains) {
      const cid = typeof child === 'string' ? child : child['@id'];
      if (!cid) continue;
      const m = /\/([^/]+)\.json$/.exec(cid);
      if (m) rkeys.push(m[1]);
    }
    rkeys.sort().reverse(); // TIDs sort chronologically; newest first

    const out = [];
    for (const rkey of rkeys) {
      const res = await lb(`${podPath}${RECORD_DIR}/${rkey}.json`, {
        headers: { accept: 'application/json' }, auth,
      });
      if (!res.ok) continue;
      try { out.push({ rkey, record: await res.json() }); } catch { /* skip */ }
    }
    return out;
  }

  /**
   * Resolve which pod a read targets. Prefer the authenticated agent (the
   * Phase-1 case: a client reading its own feed); fall back to decoding one
   * of our did:web actor params for anonymous public reads.
   */
  async function resolveTarget(request, actorParam) {
    const webid = await api.auth.getAgent(request);
    if (webid) return { webid, ...podFromWebid(webid) };
    const decoded = actorParam && podFromDid(actorParam);
    if (decoded) {
      // Synthesize a WebID for shaping author objects (host + path segment).
      const webidGuess = `${decoded.origin}${decoded.podPath}profile/card#me`;
      return { webid: webidGuess, ...decoded };
    }
    return null;
  }

  // =================================================================== routes

  // Preflight for the whole XRPC surface.
  api.fastify.options('/xrpc/*', (request, reply) => cors(reply).code(204).send());

  // ------------------------------------------- com.atproto.server.describeServer
  api.fastify.get('/xrpc/com.atproto.server.describeServer', (request, reply) => json(reply, 200, {
    did: serviceDid,
    availableUserDomains: [`.${serviceHost}`],
    inviteCodeRequired: false,
    phoneVerificationRequired: false,
    links: {},
    contact: {},
  }));

  // ------------------------------------------- com.atproto.server.createSession
  api.fastify.post('/xrpc/com.atproto.server.createSession', async (request, reply) => {
    const p = readParams(request);
    const identifier = p.identifier || p.username || p.handle;
    const mint = await mintPodToken(identifier, p.password);
    if (!mint) {
      return xrpcErr(reply, 401, 'AuthenticationRequired', 'Invalid identifier or password');
    }
    const { username } = podFromWebid(mint.webid);
    // The pod bearer IS the session token; there is no separate refresh cycle,
    // so refreshJwt re-presents the same bearer (documented in the README).
    return json(reply, 200, {
      accessJwt: mint.access_token,
      refreshJwt: mint.access_token,
      handle: username,
      did: didFromWebid(mint.webid),
      email: undefined,
      emailConfirmed: false,
      active: true,
    });
  });

  // ------------------------------------------- com.atproto.server.getSession
  api.fastify.get('/xrpc/com.atproto.server.getSession', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return xrpcErr(reply, 401, 'AuthenticationRequired', 'The access token is invalid');
    const { username } = podFromWebid(webid);
    return json(reply, 200, {
      did: didFromWebid(webid),
      handle: username,
      email: undefined,
      emailConfirmed: false,
      active: true,
    });
  });

  // ------------------------------------------- com.atproto.repo.createRecord
  api.fastify.post('/xrpc/com.atproto.repo.createRecord', async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return xrpcErr(reply, 401, 'AuthenticationRequired', 'The access token is invalid');
    const p = readParams(request);
    const collection = p.collection || POST_NSID;
    if (collection !== POST_NSID) {
      return xrpcErr(reply, 400, 'InvalidRequest',
        `bluesky shim Phase 1 stores only ${POST_NSID} records (got ${collection})`);
    }
    const rec = p.record || {};
    const text = typeof rec.text === 'string' ? rec.text : '';
    if (!text.trim()) return xrpcErr(reply, 400, 'InvalidRequest', 'Record text is empty');

    const { podPath } = podFromWebid(webid);
    const rkey = (typeof p.rkey === 'string' && /^[A-Za-z0-9._~-]{1,64}$/.test(p.rkey))
      ? p.rkey : mintTid();
    const record = {
      $type: POST_NSID,
      text,
      createdAt: rec.createdAt || new Date().toISOString(),
    };
    const resourcePath = `${podPath}${RECORD_DIR}/${rkey}.json`;

    // Store it in the pod under the caller's OWN credentials — real WAC
    // decides whether this write is allowed.
    const put = await lb(resourcePath, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      auth: request.headers.authorization,
    });
    if (put.status === 401 || put.status === 403) {
      return xrpcErr(reply, 403, 'Forbidden', 'The pod refused this write (WAC)');
    }
    if (!(put.ok || put.status === 204)) {
      return xrpcErr(reply, 502, 'RepoWriteFailed', `Pod storage rejected the record (${put.status})`);
    }
    const did = didFromWebid(webid);
    return json(reply, 200, {
      uri: `at://${did}/${POST_NSID}/${rkey}`,
      cid: cidFor(record),
      commit: { cid: cidFor(record), rev: rkey },
      validationStatus: 'unknown',
    });
  });

  // ------------------------------------------- com.atproto.repo.listRecords
  api.fastify.get('/xrpc/com.atproto.repo.listRecords', async (request, reply) => {
    const p = request.query || {};
    const collection = p.collection || POST_NSID;
    if (collection !== POST_NSID) return json(reply, 200, { records: [] });
    const target = await resolveTarget(request, p.repo);
    if (!target) return xrpcErr(reply, 400, 'InvalidRequest', 'Unknown or unresolvable repo');
    const did = didFromWebid(target.webid);
    const posts = await listPosts(target.podPath, request.headers.authorization);
    const records = posts.map(({ rkey, record }) => ({
      uri: `at://${did}/${POST_NSID}/${rkey}`,
      cid: cidFor(record),
      value: { $type: POST_NSID, text: record.text || '', createdAt: record.createdAt },
    }));
    return json(reply, 200, { records, cursor: undefined });
  });

  // ------------------------------------------- app.bsky.feed.getAuthorFeed
  api.fastify.get('/xrpc/app.bsky.feed.getAuthorFeed', async (request, reply) => {
    const p = request.query || {};
    const target = await resolveTarget(request, p.actor);
    if (!target) return xrpcErr(reply, 400, 'InvalidRequest', 'Unknown or unresolvable actor');
    const posts = await listPosts(target.podPath, request.headers.authorization);
    const limit = Math.min(Number(p.limit) || 50, 100);
    const feed = posts.slice(0, limit).map(({ rkey, record }) => recordToPostView(record, rkey, target.webid));
    return json(reply, 200, { feed, cursor: undefined });
  });

  api.log.info(`bluesky: XRPC shim at /xrpc/* → pods via ${loopback} (issue #211 Phase 1)`);
  // The load-bearing caveat (see README "Findings"): these absolute /xrpc
  // routes register fine, but they are only reachable if the operator has
  // WAC-exempted /xrpc. A plugin gets ONE prefix pushed to appPaths and this
  // fixed protocol root is not it, so the plugin cannot self-exempt — the
  // operator must pass `appPaths: ['/xrpc']` to createServer. This is the
  // SECOND independent confirmation of mastodon's reserved-path seam.
  api.log.warn('bluesky: /xrpc must be in appPaths or WAC will 401 every client '
    + 'request — the one-prefix plugin model cannot self-exempt a fixed protocol root');
}
