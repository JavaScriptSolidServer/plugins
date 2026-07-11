# activitypub — a pod as a W3C ActivityPub actor

Out-of-tree take on JSS issues **#51 / #164** ("federate a pod as an AP
actor"), built straight onto the [#206 plugin loader](https://jss.live/docs/features/plugins).
Phase 1: a single pod stood up as a **personal ActivityPub actor** — fetch the
actor (with a real RSA public key), post a Note to its outbox (stored in the
pod over loopback LDP, under real WAC), read the outbox back as an
`OrderedCollection` of `Create{Note}`, and receive `Follow`/`Create`/`Like`
into the inbox.

This is **not a port**. JSS core ships an ActivityPub feature under `src/ap/`,
but it leans on the `microfed` npm module and shares closures with
`server.js`. Per the repo rule this plugin imports **no** `src/...` — `src/ap/`
was read for the AS2 shapes and never imported. Everything (keypair, HTTP
Signature signing, collections) is reimplemented on the public plugin api +
`node:crypto` alone.

```js
plugins: [{
  module: 'activitypub/plugin.js',
  config: {
    baseUrl: 'http://localhost:3000',     // public origin (mint absolute URIs)
    loopbackUrl: 'http://127.0.0.1:3000', // where WE reach the pod (default: baseUrl)
    apRoot: '/ap',                        // single root for all AP paths (default /ap)
  },
}]
```

Because the AP paths are fixed and live outside the plugin's mount prefix, the
operator must widen WAC: `createServer({ appPaths: ['/ap'], … })`. See
**Findings**.

## Endpoints

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/ap/<user>/actor` | ✅ done | AS2 `Person` + `publicKey.publicKeyPem` (RSA, per-actor, persisted) |
| `GET` | `/ap/<user>/outbox` | ✅ done | `OrderedCollection`; `?page=true` → `OrderedCollectionPage` with `Create{Note}` items |
| `POST` | `/ap/<user>/outbox` | ✅ done | owner-only (`api.auth.getAgent`); stores a Note in the pod via loopback PUT |
| `POST` | `/ap/<user>/inbox` | ✅ done (store) | persists every activity; `Follow` records the follower; **inbound signature verify: Phase 2** |
| `GET` | `/ap/<user>/followers` | ✅ done | `OrderedCollection` from persisted state |
| `GET` | `/ap/<user>/following` | ✅ done | `OrderedCollection` (empty in Phase 1 — no outbound Follow yet) |
| — | outbound delivery signing | ✅ done (stretch) | `signAndDeliver` signs POSTs with the actor RSA key (draft-cavage); `Accept` to a follower, `Create` to followers on post — best-effort, non-blocking |
| — | inbound HTTP Signature **verify** | 📋 Phase 2 | needs fetching the sender's actor key then verifying |
| — | multi-actor / real cross-server timelines | 📋 Phase 2 | Phase 1 is single/personal actor |

### The vertical slice

```
GET  /ap/fedialice/actor                       → Person, publicKeyPem present
POST /ap/fedialice/outbox  (owner Bearer)  Note "hello fediverse" → 201 Create{Note}
GET  /ap/fedialice/outbox                      → OrderedCollection contains it
POST /ap/fedialice/inbox   Follow(bob)         → 200, follower recorded
GET  /ap/fedialice/followers                   → contains bob
POST /ap/fedialice/outbox  (no Bearer)         → 401
```

**12 tests, all green:**

```bash
cd .../plugins && node --test --test-concurrency=1 activitypub/test.js
```

## The actor / keypair model

- **One RSA-2048 keypair per actor**, generated with
  `crypto.generateKeyPairSync` on first `GET .../actor` and persisted to
  `pluginDir/keys/<user>.json` (SPKI public PEM + PKCS8 private PEM). The
  public half is published in the actor doc's `publicKey.publicKeyPem` (the
  key remote servers use to verify our HTTP Signatures); the private half
  never leaves the plugin dir and signs outbound deliveries.
- **Objects live in the pod, not the plugin.** A posted Note is written by
  loopback LDP `PUT /<user>/public/statuses/<id>.jsonld` carrying the owner's
  own Bearer — so **real WAC**, not this shim, decides the write. (Same
  container mastodon/ uses, so the two plugins see each other's posts.) The
  plugin keeps a small index in `pluginDir/state/<user>.json` so an
  unauthenticated federation `GET outbox` can list Notes even when the pod
  container isn't world-readable; the container read is still attempted first
  and merges in anything written out-of-band.
- **Inbox / followers / following** are persisted per-actor in
  `pluginDir/state/<user>.json` (`inbox` log, `followers`, `following`).

## The HTTP-Signatures boundary

Real federation authenticates every server-to-server POST with an HTTP
Signature.

- **Outbound signing — done, in-plugin.** `signAndDeliver` builds the
  standard draft-cavage signing string
  (`(request-target) host date digest content-type`), signs it with
  `crypto.createSign('RSA-SHA256')` using the actor's private key, and sends
  the `Signature` + `Digest` headers. Used to deliver a signed `Accept` to a
  new follower and to fan a `Create` out to followers on post. Best-effort and
  non-blocking (a delivery to an unreachable inbox never stalls the request),
  so it needs no live remote in the tests.
- **Inbound verification — Phase-2 boundary.** Verifying an incoming signature
  means: parse the `Signature` header, extract `keyId`, **fetch the sender's
  actor document** for its `publicKeyPem`, reconstruct the signing string, and
  `crypto.verify`. Every piece is doable on the public api (plain `fetch` +
  `node:crypto`) — core's own inbox even logs-but-doesn't-reject today — but
  it's deferred here: Phase 1 **stores** inbound activities unconditionally
  and documents the gap. No core seam is required to close it; it's scope, not
  a wall.

## Findings

**Headline: a plugin can stand up a functional ActivityPub actor on the public
api** — RSA keypair in `pluginDir`, objects in the pod via loopback LDP under
real WAC, actor discovery composable with the webfinger/nip05 pattern — with
**no** `src/...` import, standing beside core's own `src/ap/` rather than
replacing it. Two things it hits:

1. **The fixed AP paths re-hit the reserved-path / `appPaths` seam
   (Nth confirmation).** ActivityPub endpoints are conventionally
   actor-rooted absolute paths (`/<user>/inbox`, `/<user>/outbox`, …) that
   *collide with the pod's own LDP namespace* (`/<user>/…` **is** the pod).
   Even mounted under one configurable root (`/ap`, chosen precisely to keep
   it to **one** extra path — the bluesky/ move), the loader still WAC-exempts
   only the plugin's single `prefix`; the AP root is not it, so **every
   federation request 401s until the operator hand-passes
   `appPaths: ['/ap']`**. This is the **same seam** mastodon/ (`/api` +
   `/oauth`) and bluesky/ (`/xrpc`) hit — now a **fourth** independent
   API-shim confirming it. The AP case sharpens the reason the seam is
   *reservePath*, not *more prefixes*: the natural AP layout wants paths
   **interleaved with** pod paths under the same `/<user>/` root, which no
   single mount prefix can carve out. The seam NOTES.md already names —
   `api.reservePath('/ap')` (or `paths: […]` in the plugin entry): the loader
   exempts *and* claims each declared path and reports collisions — would let
   this plugin own its surface and choose the canonical `/<user>/inbox` layout
   without the operator editing `createServer`. Cross-ref NOTES §5 and
   `mastodon/` + `bluesky/` "Findings".

2. **Real federation needs HTTP Signature sign/verify — signing is in-plugin,
   verify needs a remote key fetch (both doable, no core seam).** Outbound
   signing is implemented here with `node:crypto` (above). Inbound
   verification needs fetching the remote actor's public key — a plain
   `fetch` — then `crypto.verify`; nothing in it requires reaching into core.
   So unlike the reserved-path seam, the signature story is **not** a
   plugin-api gap: it's Phase-2 scope. (The one adjacent convenience a core
   seam *would* help with is `api.serverInfo` — this plugin, like mastodon/,
   notifications/, webdav/, must be handed its own `baseUrl` in config to mint
   absolute actor URIs and reach the pod over loopback; NOTES §3.)

Cross-refs: NOTES.md §3 (`api.serverInfo`) and §5 (reserved-path /
`api.reservePath`); sibling shims `mastodon/` and `bluesky/`.
