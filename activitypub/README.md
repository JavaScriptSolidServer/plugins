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

The AP paths are fixed and live outside the plugin's mount prefix. Since JSS
0.0.219 the plugin claims + WAC-exempts the `/ap` root itself at activate time
via `api.reservePath('/ap', { methods: [...] })` (#602) — the operator no
longer passes `appPaths`. See **Findings**.

## Endpoints

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/ap/<user>/actor` | ✅ done | AS2 `Person` + `publicKey.publicKeyPem` (RSA, per-actor, persisted) |
| `GET` | `/ap/<user>/outbox` | ✅ done | `OrderedCollection`; `?page=true` → `OrderedCollectionPage` with `Create{Note}` items |
| `POST` | `/ap/<user>/outbox` | ✅ done | owner-only (`api.auth.getAgent`); stores a Note in the pod via loopback PUT; `inReplyTo` passes through onto the stored Note + returned `Create` (threading) |
| `GET` | `/ap/<user>/inbox` | ✅ done | **owner-only** (same `getAgent` check as the outbox POST — the log holds strangers' activity, i.e. the owner's private mail; anonymous → 401). `OrderedCollection` summary; `?page=true` → `OrderedCollectionPage` of the raw stored activities, **newest first**, each carrying a `published` stamp (receipt time stamped at ingest when the sender omits it; backfilled at read for pre-stamping entries). The read surface mastodon/ builds timelines/notifications/threads on. Covered by the existing `/ap` reservation (GET was already in the reserved methods) |
| `POST` | `/ap/<user>/inbox` | ✅ done (store) | persists every activity — `Like`/`Announce`/`Create` retained as-is, `Follow` records the follower (deduped), `Undo{Follow}` removes it — bounded `maxInbox`; **inbound signature verify: Phase 2** — unauthenticated-by-design, so outbound delivery is SSRF-gated |
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
GET  /ap/fedialice/inbox   (owner Bearer)      → OrderedCollection; ?page=true
                                                 pages the log newest-first,
                                                 every item `published`-stamped
GET  /ap/fedialice/inbox   (no Bearer)         → 401 (owner's private mail)
POST /ap/fedialice/outbox  (no Bearer)         → 401
```

**20 tests, all green:**

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
  `pluginDir/state/<user>.json` (`inbox` log, `followers`, `following`). Each
  inbox entry stores the raw activity plus a `receivedAt`; the activity gets a
  `published` stamp at ingest when the sender omitted one (and pre-stamping
  entries are backfilled from `receivedAt` at read time), so the owner-read
  `GET inbox` always serves sortable items. Followers/following stay public
  AP surface; the inbox **log** is owner-only.

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
  a wall. **The inbox therefore remains unauthenticated-by-design in Phase 1.**

### Hardening the unauthenticated inbox (SSRF + DoS gates)

Because inbound signatures aren't verified yet, an anonymous `Follow` supplies
an attacker-controlled `actor` URL that the server would otherwise fetch (to
resolve a delivery inbox) and then POST to — a classic SSRF against cloud
metadata / internal services — and an anonymous flood could grow the persisted
state without bound. Those surfaces are now **gated** (the mitigation that
stands in for signature verification until Phase 2):

- **SSRF gate on all outbound delivery** (`fetchActorInbox` + `signAndDeliver`).
  A port of `corsproxy/`'s guard: the target scheme must be `http`/`https`, the
  hostname is resolved (`node:dns`), and delivery is **refused if any resolved
  address is private/loopback/link-local (incl. `169.254.169.254`)/CGNAT/ULA/
  unspecified**, failing **closed** on a resolution error. Redirects are
  followed **manually** and re-validated per hop (never `redirect:'follow'`).
  Default is **closed**; `config.allowPrivateDelivery: true` is a documented
  escape hatch for local/loopback testing only.
- **Bounded state.** The inbox log is trimmed to the most recent
  `config.maxInbox` (default 500) on every write, and the followers ledger is
  **deduped by actor id** (duplicate `Follow` spam can't grow it).
- **Atomic persistence.** State and keypair writes go to a temp file then
  `fs.renameSync` over the target, so a crash mid-write can't truncate the
  followers ledger / keypair.
- **Capped outbox walk.** `GET outbox` caps its loopback status-container walk
  at `config.maxResources` (default 1000), like `backup/` + `sparql/`.
- **No leaked sockets.** Delivery responses are drained/cancelled on every path.

Config knobs (all default-safe): `allowPrivateDelivery` (default `false`),
`maxInbox` (default `500`), `maxResources` (default `1000`).

## Findings

**Headline: a plugin can stand up a functional ActivityPub actor on the public
api** — RSA keypair in `pluginDir`, objects in the pod via loopback LDP under
real WAC, actor discovery composable with the webfinger/nip05 pattern — with
**no** `src/...` import, standing beside core's own `src/ap/` rather than
replacing it. Two things it hits:

1. **The fixed AP paths re-hit the reserved-path / `appPaths` seam
   (Nth confirmation) — the literal-root half is now CLOSED.** ActivityPub
   endpoints are conventionally actor-rooted absolute paths (`/<user>/inbox`,
   `/<user>/outbox`, …) that *collide with the pod's own LDP namespace*
   (`/<user>/…` **is** the pod). Even mounted under one configurable root
   (`/ap`, chosen precisely to keep it to **one** extra path — the bluesky/
   move), the loader WAC-exempts only the plugin's single `prefix`; the AP
   root is not it, so **every federation request 401'd until the operator
   hand-passed `appPaths: ['/ap']`**. This was the **same seam** mastodon/
   (`/api` + `/oauth`) and bluesky/ (`/xrpc`) hit — a **fourth** independent
   API-shim confirming it. **Consumed as of JSS 0.0.219**: the seam shipped
   as `api.reservePath` (#602) and this plugin now claims + WAC-exempts `/ap`
   itself at activate time (methods widened to exactly the implemented verbs
   — POST for the inbox/outbox, nothing wider, since an exemption on an
   unimplemented write verb would fall through to LDP as an unauthenticated
   write; collisions with another claimant fail the boot loudly). **The
   SHARPER half remains open**: the AP case is why the seam is *reservePath*,
   not *more prefixes* — the natural AP layout wants paths **interleaved
   with** pod paths under the same `/<user>/` root, i.e. the parameterized
   case, which the literal-subtree claim doesn't give a plugin a way to own
   for a *whole namespace* (`/:user/inbox` for every user alongside the pod's
   own `/:user/…` documents). `/ap` is still the workaround root; the
   canonical `/<user>/inbox` layout is still out of reach. Cross-ref NOTES §5
   and `mastodon/` + `bluesky/` "Findings".

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
