// ActivityPub actor (W3C AP / ActivityStreams 2.0) as a #206 loader plugin —
// out-of-tree take on JSS issues #51 / #164 ("federate a pod as an AP actor").
//
//   plugins: [{ module: 'activitypub/plugin.js',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000',
//                         apRoot: '/ap' } }]
//
// Phase 1 — a single pod stood up as a personal ActivityPub actor. Fetch the
// actor (with a real RSA public key), post a Note to its outbox (stored in
// the pod over loopback LDP, under real WAC), read the outbox back as an
// OrderedCollection of Create{Note}, and receive Follow/Create/Like into the
// inbox (persisted to pluginDir). The OWNER can read that inbox log back as
// an OrderedCollection (newest first, owner-authed — it holds strangers'
// activity, so it is private mail; mastodon/ builds timelines/notifications
// on it). Followers/following are OrderedCollections from that persisted
// state. This is NOT a bundled-feature port: JSS core
// ships an ActivityPub feature under src/ap/ (which leans on the `microfed`
// npm module and shares closures with server.js); this is a parallel
// reimplementation on the PUBLIC plugin api only — src/ap/ was read for the
// AS2 shapes but never imported (the repo rule).
//
// --------------------------------------------------------------- the paths
//
// ActivityPub endpoints are conventionally ABSOLUTE, rooted at the actor:
// `/<user>/inbox`, `/<user>/outbox`, `/<user>/followers`. Those collide with
// the pod's own LDP namespace (`/<user>/...` IS the pod). Like mastodon/
// (fixed `/api` + `/oauth`) and bluesky/ (`/xrpc`), a plugin gets ONE mount
// `prefix` and the loader WAC-exempts only that one prefix. To keep the AP
// surface to a SINGLE extra root, everything here lives under one
// configurable base — `/ap/<user>/actor`, `/ap/<user>/outbox`, … (default
// `apRoot: '/ap'`). Since JSS 0.0.219 the plugin claims + WAC-exempts that
// root ITSELF via `api.reservePath` (#602) — no more hand-passed
// `appPaths: ['/ap']`. The deviation from AP's actor-rooted absolute paths
// remains: the natural layout wants paths interleaved with the pod's
// `/<user>/` namespace, and /ap is still the workaround root — the open
// half of the README "Findings".
//
// -------------------------------------------------------- HTTP Signatures
//
// Real federation authenticates every server-to-server POST with an HTTP
// Signature (draft-cavage). This plugin SIGNS outbound deliveries in-plugin
// with node:crypto (see signAndDeliver) — the actor's persisted RSA private
// key over the standard `(request-target) host date digest` string. It does
// NOT verify inbound signatures: that needs fetching the SENDER's actor
// document to get their public key, then verifying — doable on the public api
// (plain fetch + crypto.verify) but out of Phase-1 scope; inbound activities
// are stored regardless and the boundary is documented. See README.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { lookup } from 'node:dns/promises';

// --------------------------------------------------------------- SSRF gate
//
// The inbox is unauthenticated-by-design in Phase 1 (inbound HTTP-Signature
// verification is the Phase-2 boundary — see README), so a Follow's
// attacker-controlled `actor` URL is fetched (to resolve the delivery inbox)
// and later POSTed to. That is an SSRF surface. The mitigation, until real
// signature verification lands, is this gate — a port of corsproxy/'s
// private-address guard: outbound delivery targets must be http/https AND
// every resolved address must be public (loopback/RFC1918/link-local incl.
// the 169.254.169.254 cloud-metadata endpoint/CGNAT/ULA/unspecified are all
// refused), failing CLOSED on any resolution error. A target that fails the
// gate is skipped silently (delivery returns null) — the inbox POST itself
// still succeeds so normal federation semantics are preserved.
const V4_BLOCKED_CIDRS = [
  '0.0.0.0/8', //        "this network" / unspecified
  '10.0.0.0/8', //       RFC1918
  '100.64.0.0/10', //    CGNAT
  '127.0.0.0/8', //      loopback
  '169.254.0.0/16', //   link-local (incl. 169.254.169.254 cloud metadata)
  '172.16.0.0/12', //    RFC1918
  '192.0.0.0/24', //     IETF protocol assignments
  '192.0.2.0/24', //     TEST-NET-1
  '192.168.0.0/16', //   RFC1918
  '198.18.0.0/15', //    benchmarking
  '198.51.100.0/24', //  TEST-NET-2
  '203.0.113.0/24', //   TEST-NET-3
  '224.0.0.0/4', //      multicast
  '240.0.0.0/4', //      reserved + broadcast
];

function v4ToInt(ip) {
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

const V4_BLOCKED = V4_BLOCKED_CIDRS.map((cidr) => {
  const [base, bits] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  return { base: (v4ToInt(base) & mask) >>> 0, mask };
});

function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  if (!Number.isFinite(n)) return true; // malformed — fail closed
  return V4_BLOCKED.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

/** Expand an IPv6 literal to its 8 16-bit groups (null when malformed). */
function expandV6(ip) {
  let addr = ip.split('%')[0].toLowerCase();
  const dotted = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    addr = addr.slice(0, -dotted[1].length)
      + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [headStr, tailStr = ''] = addr.split('::');
  const head = headStr ? headStr.split(':') : [];
  const tail = tailStr ? tailStr.split(':') : [];
  const groups = addr.includes('::')
    ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    : head;
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || '0', 16));
  return nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : nums;
}

function isPrivateV6(ip) {
  const g = expandV6(ip);
  if (!g) return true; // malformed — fail closed
  const zeroThrough = (i) => g.slice(0, i).every((n) => n === 0);
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (zeroThrough(5) && g[5] === 0xffff) return isPrivateV4(embeddedV4()); // ::ffff:v4
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) {
    return isPrivateV4(embeddedV4()); // 64:ff9b::/96 NAT64
  }
  if (g.every((n) => n === 0)) return true; //                :: unspecified
  if (zeroThrough(7) && g[7] === 1) return true; //           ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; //             fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; //             fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; //             fec0::/10 site-local
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; //     2001:db8::/32 documentation
  return false;
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not an IP literal — fail closed
}

/** True only if hostname resolves and EVERY address is public. Fail closed. */
async function resolvesToPublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return !isPrivateIp(host);
  let records;
  try { records = await lookup(host, { all: true, verbatim: true }); }
  catch { return false; } // unresolvable — fail closed
  if (!records?.length) return false; // zero addresses — fail closed
  return records.every(({ address }) => !isPrivateIp(address));
}

/**
 * Fetch a delivery target behind the SSRF gate. Scheme must be http/https and
 * (unless cfg.allowPrivateDelivery) every resolved hop must be public.
 * Redirects are followed MANUALLY and each hop is re-validated (redirect:
 * 'follow' would let a public URL 302 to 169.254.169.254). Returns the
 * Response, or null if the target is refused / unreachable — callers treat
 * null as "skip delivery". The caller owns consuming res.body.
 */
async function gatedFetch(startUrl, init, cfg, { follow = true, maxHops = 5 } = {}) {
  let current;
  try { current = new URL(String(startUrl).replace(/#.*$/, '')); }
  catch { return null; }
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') return null;
    if (!cfg.allowPrivateDelivery && !(await resolvesToPublic(current.hostname))) return null;
    let res;
    try { res = await fetch(current, { ...init, redirect: 'manual' }); }
    catch { return null; }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location || !follow || hop >= maxHops) return res;
    await res.body?.cancel().catch(() => {}); // drop the redirect body before the next hop
    try { current = new URL(location, current); }
    catch { return null; }
  }
}

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const SEC_CONTEXT = 'https://w3id.org/security/v1';
const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AP_CT = 'application/activity+json';
const STATUS_DIR = 'public/statuses'; // where Notes live inside a pod (shared with mastodon/)

// A sortable, numeric-string id (collections are newest-first by id).
let lastMs = 0;
let seq = 0;
function mintId() {
  const ms = Date.now();
  if (ms === lastMs) seq += 1;
  else { lastMs = ms; seq = 0; }
  return (BigInt(ms) * 1000n + BigInt(seq)).toString();
}

/**
 * Derive pod root path + display username from a WebID.
 * Path-mode:   http://host/alice/profile/card.jsonld#me → { alice, /alice/ }
 * Single-user: http://host/profile/card.jsonld#me       → { host label, / }
 */
function podFromWebid(webid) {
  const u = new URL(webid);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length >= 2 && segs[0] !== 'profile') {
    return { username: segs[0], podPath: `/${segs[0]}/`, origin: u.origin };
  }
  return { username: u.hostname.split('.')[0] || 'user', podPath: '/', origin: u.origin };
}

/** Parse a JSON (or activity+json / ld+json) request body into an object. */
function readJson(request) {
  let body = request.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (!body.length) return {};
    try { return JSON.parse(body); } catch { return {}; }
  }
  return (body && typeof body === 'object') ? body : {};
}

export async function activate(api) {
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'activitypub plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin (same finding as mastodon/, notifications/, webdav/). It is '
      + 'needed to mint absolute actor/object URIs and to reach the pod over loopback.',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  // ONE extra root (default /ap): every AP path lives under it, so the
  // plugin claims a single path (see README findings).
  const apRoot = (api.config.apRoot || '/ap').replace(/\/$/, '');

  // Claim + WAC-exempt the AP root (api.reservePath, #602, JSS 0.0.219):
  // a literal path exempts the whole subtree, and a second plugin claiming
  // it fails the boot loudly. Reservations are READ-ONLY by default
  // (GET/HEAD/OPTIONS); POST is widened because the routes below implement
  // it (inbox, and the owner-authed outbox). Nothing wider — exempting a
  // write verb with no route would fall through to LDP's wildcards as an
  // unauthenticated storage write.
  api.reservePath(apRoot, { methods: ['GET', 'HEAD', 'OPTIONS', 'POST'] });

  const dir = api.storage.pluginDir();
  const keysDir = path.join(dir, 'keys');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(keysDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Hardening knobs (all default-safe; see README "Findings"):
  //  - allowPrivateDelivery: default FALSE — outbound delivery to
  //    private/loopback/link-local targets is refused (SSRF gate). Set true
  //    ONLY for local testing against a loopback inbox.
  //  - maxInbox:    cap the persisted inbox log (unauthenticated writers can
  //    otherwise grow it without bound → disk/CPU DoS).
  //  - maxResources: cap the loopback status walk in GET outbox (matches
  //    backup/ + sparql/).
  const cfg = {
    allowPrivateDelivery: api.config.allowPrivateDelivery === true, // default closed
    maxInbox: Number.isFinite(api.config.maxInbox) && api.config.maxInbox > 0
      ? api.config.maxInbox : 500,
    maxResources: Number.isFinite(api.config.maxResources) && api.config.maxResources > 0
      ? api.config.maxResources : 1000,
  };

  // Crash-safe write: land the bytes in a temp file, then atomically rename
  // over the target (atomic on the same fs). A crash mid-write can no longer
  // truncate the followers ledger / keypair — the old file survives intact.
  function writeFileAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }

  // --------------------------------------------------------------- helpers
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type, accept, signature, digest')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('vary', 'accept');
  const ap = (reply, code, obj) => cors(reply)
    .code(code).header('content-type', `${AP_CT}; charset=utf-8`).send(JSON.stringify(obj));
  const err = (reply, code, msg) => cors(reply)
    .code(code).header('content-type', 'application/json; charset=utf-8').send({ error: msg });

  /** Reach the pod over loopback, forwarding a caller Authorization if given. */
  const lb = (p, { method = 'GET', headers = {}, body, auth } = {}) => fetch(loopback + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
  });

  // ---- actor URIs (all under the single apRoot) --------------------------
  const actorBase = (user) => `${baseUrl}${apRoot}/${user}`;
  const actorId = (user) => `${actorBase(user)}/actor`;
  const keyId = (user) => `${actorId(user)}#main-key`;

  // ---- per-actor RSA keypair (persisted in pluginDir) --------------------
  function loadOrCreateKeypair(user) {
    const file = path.join(keysDir, `${user}.json`);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* generate below */ }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const kp = { publicKey, privateKey };
    writeFileAtomic(file, JSON.stringify(kp, null, 2));
    return kp;
  }

  // ---- per-actor state: inbox log, followers, following, note index ------
  const emptyState = () => ({ inbox: [], followers: [], following: [], notes: [] });
  function loadState(user) {
    try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(path.join(stateDir, `${user}.json`), 'utf8')) }; }
    catch { return emptyState(); }
  }
  function saveState(user, state) {
    writeFileAtomic(path.join(stateDir, `${user}.json`), JSON.stringify(state, null, 2));
  }

  // ---- the actor document (AS2 Person + security context) ----------------
  function buildActor(user) {
    const kp = loadOrCreateKeypair(user);
    const id = actorId(user);
    return {
      '@context': [AS_CONTEXT, SEC_CONTEXT],
      id,
      type: 'Person',
      preferredUsername: user,
      name: user,
      url: `${baseUrl}/${user}/profile/card.jsonld`,
      inbox: `${actorBase(user)}/inbox`,
      outbox: `${actorBase(user)}/outbox`,
      followers: `${actorBase(user)}/followers`,
      following: `${actorBase(user)}/following`,
      endpoints: { sharedInbox: `${actorBase(user)}/inbox` },
      publicKey: {
        id: keyId(user),
        owner: id,
        publicKeyPem: kp.publicKey,
      },
    };
  }

  /** Wrap a stored Note into a Create activity (outbox item form). */
  function noteToCreate(user, note) {
    return {
      type: 'Create',
      id: `${note.id}#create`,
      actor: actorId(user),
      published: note.published,
      to: [AS_PUBLIC],
      cc: [`${actorBase(user)}/followers`],
      object: note,
    };
  }

  /**
   * List the actor's Notes. The pod is the store: read the statuses
   * container over loopback (picks up Notes written out-of-band, e.g. via
   * mastodon/), and merge the plugin's own index (authoritative for Notes
   * this plugin posted, and the fallback when a federation GET carries no
   * credentials and the container isn't world-readable). Newest first.
   */
  async function listNotes(user, auth) {
    const byId = new Map();
    for (const n of loadState(user).notes) byId.set(n.id, n);
    try {
      const res = await lb(`/${user}/${STATUS_DIR}/`, { headers: { accept: 'application/ld+json' }, auth });
      if (res.ok) {
        const container = await res.json();
        const contains = [].concat(container.contains ?? []);
        let fetched = 0;
        for (const child of contains) {
          // Cap the loopback walk so a huge status container can't turn one
          // GET outbox into an unbounded fan-out (matches backup/ + sparql/).
          if (fetched >= cfg.maxResources) break;
          const cid = typeof child === 'string' ? child : child['@id'];
          const m = cid && /\/([0-9]+)\.jsonld$/.exec(cid);
          if (!m) continue;
          fetched += 1;
          const noteRes = await lb(`/${user}/${STATUS_DIR}/${m[1]}.jsonld`, {
            headers: { accept: 'application/ld+json' }, auth,
          });
          if (!noteRes.ok) continue;
          try {
            const note = await noteRes.json();
            if (note && note.id) byId.set(note.id, note);
          } catch { /* skip */ }
        }
      }
    } catch { /* pod unreachable / unreadable — index still serves */ }
    return [...byId.values()].sort((a, b) => (
      String(a.published) < String(b.published) ? 1 : -1
    ));
  }

  // ---- outbound HTTP Signature signing (node:crypto, draft-cavage) -------
  // The stretch goal, implemented: sign a delivery POST with the actor's RSA
  // private key. Best-effort and non-blocking — a Follow's Accept is fired
  // at the follower's inbox but never awaited on the request path.
  async function signAndDeliver(inboxUrl, activity, user) {
    const kp = loadOrCreateKeypair(user);
    const body = JSON.stringify(activity);
    const u = new URL(inboxUrl);
    const date = new Date().toUTCString();
    const digest = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
    const signingString = [
      `(request-target): post ${u.pathname}`,
      `host: ${u.host}`,
      `date: ${date}`,
      `digest: ${digest}`,
      `content-type: ${AP_CT}`,
    ].join('\n');
    const signature = crypto.createSign('RSA-SHA256').update(signingString).end()
      .sign(kp.privateKey, 'base64');
    const sig = `keyId="${keyId(user)}",algorithm="rsa-sha256",`
      + `headers="(request-target) host date digest content-type",signature="${signature}"`;
    // SSRF gate: the inbox URL came from an attacker-controlled actor doc, so
    // it is validated (public target only, unless allowPrivateDelivery) before
    // the POST. Redirects are NOT followed for delivery — a signed POST cannot
    // be replayed to a re-signed target — a 3xx just fails the delivery. The
    // response body is consumed on every path so no undici socket leaks.
    const res = await gatedFetch(inboxUrl, {
      method: 'POST',
      headers: {
        host: u.host, date, digest, 'content-type': AP_CT,
        accept: AP_CT, signature: sig,
      },
      body,
    }, cfg, { follow: false });
    if (res) await res.body?.cancel().catch(() => {});
    return res;
  }

  /**
   * Fetch a remote actor's inbox URL (for delivery). null on any failure OR
   * when the actor URL fails the SSRF gate (private/loopback/link-local),
   * which is how a Follow with `actor: http://169.254.169.254/…` is refused.
   * The response body is consumed on every path (no socket leak).
   */
  async function fetchActorInbox(actorUrl) {
    const res = await gatedFetch(actorUrl, { headers: { accept: AP_CT } }, cfg, { follow: true });
    if (!res) return null;
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    try {
      const doc = await res.json(); // consumes the body
      return doc.inbox || doc.endpoints?.sharedInbox || null;
    } catch {
      await res.body?.cancel().catch(() => {});
      return null;
    }
  }

  // ================================================================= routes

  // Preflight for the whole AP surface.
  api.fastify.options(`${apRoot}/*`, (request, reply) => cors(reply).code(204).send());

  // ---- GET actor ---------------------------------------------------------
  api.fastify.get(`${apRoot}/:user/actor`, (request, reply) => ap(reply, 200, buildActor(request.params.user)));

  // ---- GET outbox (OrderedCollection of Create{Note}) --------------------
  api.fastify.get(`${apRoot}/:user/outbox`, async (request, reply) => {
    const user = request.params.user;
    const notes = await listNotes(user, request.headers.authorization);
    const items = notes.map((n) => noteToCreate(user, n));
    const outboxUrl = `${actorBase(user)}/outbox`;
    // ?page=true → the collection PAGE form (orderedItems inline).
    if (String(request.query?.page) === 'true') {
      return ap(reply, 200, {
        '@context': AS_CONTEXT,
        id: `${outboxUrl}?page=true`,
        type: 'OrderedCollectionPage',
        partOf: outboxUrl,
        totalItems: items.length,
        orderedItems: items,
      });
    }
    return ap(reply, 200, {
      '@context': AS_CONTEXT,
      id: outboxUrl,
      type: 'OrderedCollection',
      totalItems: items.length,
      first: `${outboxUrl}?page=true`,
      last: `${outboxUrl}?page=true`,
    });
  });

  // ---- POST outbox (owner only): accept a Note / Create{Note}, store it --
  api.fastify.post(`${apRoot}/:user/outbox`, async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'Authentication required to post to the outbox');
    const { username } = podFromWebid(webid);
    const user = request.params.user;
    if (username !== user) return err(reply, 403, 'Only the actor owner may post to this outbox');

    const input = readJson(request);
    // Accept a bare Note, or a Create wrapping a Note.
    const inNote = input.type === 'Create' ? input.object : input;
    const content = typeof inNote?.content === 'string' ? inNote.content : '';
    if (!content.trim()) return err(reply, 422, 'Note content is required');

    const id = mintId();
    const resourcePath = `/${user}/${STATUS_DIR}/${id}.jsonld`;
    const noteUri = `${baseUrl}${resourcePath}`;
    const published = new Date().toISOString();
    const note = {
      '@context': AS_CONTEXT,
      id: noteUri,
      url: noteUri,
      type: 'Note',
      attributedTo: actorId(user),
      content,
      published,
      to: [AS_PUBLIC],
      cc: [`${actorBase(user)}/followers`],
      ...(inNote.inReplyTo ? { inReplyTo: inNote.inReplyTo } : {}),
    };

    // Store in the pod under the caller's OWN credentials — real WAC decides.
    const put = await lb(resourcePath, {
      method: 'PUT',
      headers: { 'content-type': 'application/ld+json' },
      body: JSON.stringify(note),
      auth: request.headers.authorization,
    });
    if (put.status === 401 || put.status === 403) return err(reply, 403, 'Pod storage refused the write');
    if (!(put.ok || put.status === 204)) return err(reply, 500, `Pod storage rejected the Note (${put.status})`);

    // Index it (authoritative for federation GETs that carry no creds).
    // inReplyTo rides along so threading survives even when the outbox is
    // listed from the index alone (pod container unreadable to the caller).
    const state = loadState(user);
    state.notes.push({
      id: noteUri, url: noteUri, content, published, attributedTo: actorId(user),
      ...(note.inReplyTo ? { inReplyTo: note.inReplyTo } : {}),
    });
    saveState(user, state);

    // Deliver the Create to followers (signed, best-effort, non-blocking).
    const create = noteToCreate(user, note);
    for (const f of state.followers) {
      if (f.inbox) signAndDeliver(f.inbox, { '@context': AS_CONTEXT, ...create }, user).catch(() => {});
    }

    return ap(reply, 201, { '@context': AS_CONTEXT, ...create });
  });

  // ---- GET inbox (owner only): the persisted inbox log --------------------
  // Unlike the other collections this one is NOT public AP surface: the log
  // holds activity from strangers, i.e. the owner's private mail, so reading
  // it is gated on the SAME owner check as the outbox POST. Items are the raw
  // stored activities, newest first — mastodon/ builds home timeline,
  // notifications and threads from this. No new reservation needed: the /ap
  // subtree claim above already covers GET here.
  api.fastify.get(`${apRoot}/:user/inbox`, async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) return err(reply, 401, 'Authentication required to read the inbox');
    const { username } = podFromWebid(webid);
    const user = request.params.user;
    if (username !== user) return err(reply, 403, 'Only the actor owner may read this inbox');

    // Newest first (the log is append-ordered). Entries persisted before
    // ingest-time `published` stamping are backfilled from receivedAt here.
    const items = [...loadState(user).inbox].reverse().map(({ receivedAt, activity }) => (
      activity.published ? activity : { ...activity, published: receivedAt }
    ));
    const inboxUrl = `${actorBase(user)}/inbox`;
    // ?page=true → the collection PAGE form (orderedItems inline).
    if (String(request.query?.page) === 'true') {
      return ap(reply, 200, {
        '@context': AS_CONTEXT,
        id: `${inboxUrl}?page=true`,
        type: 'OrderedCollectionPage',
        partOf: inboxUrl,
        totalItems: items.length,
        orderedItems: items,
      });
    }
    return ap(reply, 200, {
      '@context': AS_CONTEXT,
      id: inboxUrl,
      type: 'OrderedCollection',
      totalItems: items.length,
      first: `${inboxUrl}?page=true`,
      last: `${inboxUrl}?page=true`,
    });
  });

  // ---- POST inbox: accept incoming activities ----------------------------
  api.fastify.post(`${apRoot}/:user/inbox`, async (request, reply) => {
    const user = request.params.user;
    const activity = readJson(request);
    if (!activity.type) return err(reply, 400, 'Missing activity type');

    // Phase 1: storing needs no crypto. Inbound HTTP Signature VERIFICATION
    // (fetch the sender's actor key, verify the signature) is the Phase-2
    // boundary — see README. The inbox therefore remains UNAUTHENTICATED BY
    // DESIGN in Phase 1; the SSRF gate on outbound delivery (fetchActorInbox /
    // signAndDeliver) plus the caps below (maxInbox trim, follower dedupe) are
    // the mitigation for the abuse surface that opens. We persist every
    // activity to the inbox log, bounded to the most recent cfg.maxInbox.
    const state = loadState(user);
    // Stamp receipt time as `published` when the sender omitted it — done at
    // INGEST so the timestamp persists with the stored activity (GET inbox
    // additionally backfills at read time for entries stored before this
    // stamping existed). Timeline consumers (mastodon/) sort on it.
    const receivedAt = new Date().toISOString();
    if (!activity.published) activity.published = receivedAt;
    state.inbox.push({ receivedAt, activity });
    if (state.inbox.length > cfg.maxInbox) state.inbox = state.inbox.slice(-cfg.maxInbox);

    if (activity.type === 'Follow') {
      const follower = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
      if (follower && !state.followers.some((f) => f.actor === follower)) {
        // Resolve the follower's inbox for the Accept + future deliveries.
        const inbox = await fetchActorInbox(follower);
        state.followers.push({ actor: follower, inbox, since: new Date().toISOString() });
        saveState(user, state);
        // Stretch: send a signed Accept (best-effort, non-blocking).
        if (inbox) {
          const accept = {
            '@context': AS_CONTEXT,
            id: `${actorId(user)}#accept/${mintId()}`,
            type: 'Accept',
            actor: actorId(user),
            object: activity,
          };
          signAndDeliver(inbox, accept, user).catch(() => {});
        }
        return cors(reply).code(200).send(JSON.stringify({ ok: true, accepted: follower }));
      }
    } else if (activity.type === 'Undo' && activity.object?.type === 'Follow') {
      const follower = typeof activity.object.actor === 'string' ? activity.object.actor : activity.actor;
      state.followers = state.followers.filter((f) => f.actor !== follower);
    }

    saveState(user, state);
    return cors(reply).code(200).send(JSON.stringify({ ok: true, type: activity.type }));
  });

  // ---- GET followers / following (OrderedCollections) --------------------
  const collection = (user, kind, items) => ({
    '@context': AS_CONTEXT,
    id: `${actorBase(user)}/${kind}`,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  });
  api.fastify.get(`${apRoot}/:user/followers`, (request, reply) => {
    const user = request.params.user;
    return ap(reply, 200, collection(user, 'followers', loadState(user).followers.map((f) => f.actor)));
  });
  api.fastify.get(`${apRoot}/:user/following`, (request, reply) => {
    const user = request.params.user;
    return ap(reply, 200, collection(user, 'following', loadState(user).following.map((f) => (typeof f === 'string' ? f : f.actor))));
  });

  api.log.info(`activitypub: AP actor surface at ${apRoot}/<user>/{actor,outbox,inbox,followers,following} → pods via ${loopback} (issues #51/#164 Phase 1; root reserved via api.reservePath)`);
}
