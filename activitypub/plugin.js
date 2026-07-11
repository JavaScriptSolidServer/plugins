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
// inbox (persisted to pluginDir). Followers/following are OrderedCollections
// from that persisted state. This is NOT a bundled-feature port: JSS core
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
// surface to a SINGLE extra root the operator must exempt, everything here
// lives under one configurable base — `/ap/<user>/actor`, `/ap/<user>/outbox`,
// … (default `apRoot: '/ap'`). This deviates from the AP convention of
// actor-rooted absolute paths; the deviation, and the reserved-path/appPaths
// seam it re-hits, are the README "Findings" (Nth confirmation of #582's
// `api.reservePath`).
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
  // operator exempts a single path via appPaths (see README findings).
  const apRoot = (api.config.apRoot || '/ap').replace(/\/$/, '');

  const dir = api.storage.pluginDir();
  const keysDir = path.join(dir, 'keys');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(keysDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

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
    fs.writeFileSync(file, JSON.stringify(kp, null, 2));
    return kp;
  }

  // ---- per-actor state: inbox log, followers, following, note index ------
  const emptyState = () => ({ inbox: [], followers: [], following: [], notes: [] });
  function loadState(user) {
    try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(path.join(stateDir, `${user}.json`), 'utf8')) }; }
    catch { return emptyState(); }
  }
  function saveState(user, state) {
    fs.writeFileSync(path.join(stateDir, `${user}.json`), JSON.stringify(state, null, 2));
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
        for (const child of contains) {
          const cid = typeof child === 'string' ? child : child['@id'];
          const m = cid && /\/([0-9]+)\.jsonld$/.exec(cid);
          if (!m) continue;
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
    return fetch(inboxUrl, {
      method: 'POST',
      headers: {
        host: u.host, date, digest, 'content-type': AP_CT,
        accept: AP_CT, signature: sig,
      },
      body,
    });
  }

  /** Fetch a remote actor's inbox URL (for delivery). null on any failure. */
  async function fetchActorInbox(actorUrl) {
    try {
      const res = await fetch(String(actorUrl).replace(/#.*$/, ''), {
        headers: { accept: AP_CT }, redirect: 'follow',
      });
      if (!res.ok) return null;
      const doc = await res.json();
      return doc.inbox || doc.endpoints?.sharedInbox || null;
    } catch { return null; }
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
    const state = loadState(user);
    state.notes.push({ id: noteUri, url: noteUri, content, published, attributedTo: actorId(user) });
    saveState(user, state);

    // Deliver the Create to followers (signed, best-effort, non-blocking).
    const create = noteToCreate(user, note);
    for (const f of state.followers) {
      if (f.inbox) signAndDeliver(f.inbox, { '@context': AS_CONTEXT, ...create }, user).catch(() => {});
    }

    return ap(reply, 201, { '@context': AS_CONTEXT, ...create });
  });

  // ---- POST inbox: accept incoming activities ----------------------------
  api.fastify.post(`${apRoot}/:user/inbox`, async (request, reply) => {
    const user = request.params.user;
    const activity = readJson(request);
    if (!activity.type) return err(reply, 400, 'Missing activity type');

    // Phase 1: storing needs no crypto. Inbound HTTP Signature VERIFICATION
    // (fetch the sender's actor key, verify the signature) is the Phase-2
    // boundary — see README. We persist every activity to the inbox log.
    const state = loadState(user);
    state.inbox.push({ receivedAt: new Date().toISOString(), activity });

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

  api.log.info(`activitypub: AP actor surface at ${apRoot}/<user>/{actor,outbox,inbox,followers,following} → pods via ${loopback} (issues #51/#164 Phase 1)`);
  api.log.warn(`activitypub: ${apRoot} must be in appPaths or WAC will 401 every `
    + 'federation request — the one-prefix plugin model cannot self-exempt fixed AP paths (see README findings)');
}
