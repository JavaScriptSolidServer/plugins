# matrix — a Matrix Client-Server API shim over your own pod

Point a Matrix client (Element, or any raw Client-Server API caller) at a
JavaScript Solid Server and log in with your pod credentials, create a room,
send a message, and read the timeline back. This is **Phase 1** — "a personal
Matrix client over your own pod." No federation, no other homeservers, no
incremental `/sync`: a **room is a JSON resource in your own pod** and its
timeline is the events you appended to it.

This is the **chat-protocol** entry in the API-shim family — after the two
microblog shims (`mastodon/`, `bluesky/`) it confirms the same two seams a
third time, now against a fixed `/_matrix` root: the reserved-path/`appPaths`
gap (since **closed** by `api.reservePath()`, JSS 0.0.219) and the
`/idp/credentials` token bridge.

```
plugins: [{
  module: 'matrix/plugin.js',
  config: {
    baseUrl: 'http://localhost:3000',      // public origin (server_name + loopback)
    loopbackUrl: 'http://127.0.0.1:3000',  // optional: where the shim reaches the host
  },
}]
```

That's the whole setup. As of JSS 0.0.219 the plugin claims and WAC-exempts
the fixed `/_matrix` root itself via `api.reservePath()` at activate time
(#602) — no `appPaths` widening required. (Before 0.0.219 the operator had to
pass `appPaths: ['/_matrix']` by hand or WAC 401'd every client call — see
[Findings](#findings).)

## Pointing a client at it

A Matrix client asks for a **homeserver base URL** and then logs in. Give it
your JSS origin (`http://localhost:3000`). It will `GET /_matrix/client/versions`,
then `POST /_matrix/client/v3/login` with your username + password; the bearer
it gets back **is** your pod token, resent on every later call.

```bash
# 1. supported versions (public — the client's first probe)
curl -s localhost:3000/_matrix/client/versions

# 2. log in (password → pod bearer)
TOKEN=$(curl -s localhost:3000/_matrix/client/v3/login \
  -H 'content-type: application/json' \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"alice"},"password":"…"}' \
  | jq -r .access_token)

# 3. who am I
curl -s localhost:3000/_matrix/client/v3/account/whoami -H "Authorization: Bearer $TOKEN"

# 4. create a room
ROOM=$(curl -s localhost:3000/_matrix/client/v3/createRoom \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Test Room"}' | jq -r .room_id)

# 5. send a message (txnId is the client's idempotency key)
curl -s -X PUT "localhost:3000/_matrix/client/v3/rooms/$ROOM/send/m.room.message/txn1" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"msgtype":"m.text","body":"hello matrix"}'

# 6. read the timeline back
curl -s "localhost:3000/_matrix/client/v3/rooms/$ROOM/messages" -H "Authorization: Bearer $TOKEN"
```

## Endpoint coverage

| Endpoint | Status | Notes |
|---|---|---|
| `GET /_matrix/client/versions` | ✅ done | public; supported CS-API versions |
| `GET /.well-known/matrix/client` | ✅ done | homeserver autodiscovery (`base_url`) |
| `GET /_matrix/client/v3/login` | ✅ done | advertises the `m.login.password` flow |
| `POST /_matrix/client/v3/login` | ✅ done | `m.login.password` → pod bearer as `access_token` |
| `GET /_matrix/client/v3/account/whoami` | ✅ done | `user_id` from `getAgent()` |
| `POST /_matrix/client/v3/createRoom` | ✅ done | room state → `<pod>/matrix/rooms/<localpart>.json` |
| `PUT /_matrix/client/v3/rooms/{id}/send/{type}/{txn}` | ✅ done | appends a timeline event; `txnId` idempotent |
| `GET /_matrix/client/v3/rooms/{id}/messages` | ✅ done | the stored timeline (`dir=b` default, `dir=f`) |
| `GET /_matrix/client/v3/joined_rooms` | ✅ done | lists the caller's rooms from the container |
| `GET /_matrix/client/v3/sync` | 🟡 stub | full-state only; **no since-token / incremental** — see Findings |
| federation (`/_matrix/federation/*`), join/invite, e2ee, presence, receipts, media | ⛔ not yet | Phase 2+ |

Every response carries wide-open CORS (`access-control-allow-origin: *`) and
`OPTIONS /_matrix/*` is answered locally, so browser clients (Element) can
talk to the shim cross-origin.

## The login → pod-credentials bridge

Matrix's `access_token` is just a bearer the client resends. A Solid pod's
access token is *also* just a bearer. So the bridge is direct — no token of
our own, no session store:

| Matrix step | What the shim does |
|---|---|
| `POST /_matrix/client/v3/login` `m.login.password` | loopback `POST /idp/credentials` with the username+password → return the pod bearer as `access_token` |
| every later `Authorization: Bearer <token>` | forwarded verbatim: `getAgent()` resolves it to the WebID; room/message writes are loopback LDP PUTs under that same bearer, so **real WAC**, not this shim, decides what lands |

There is no `refresh` cycle and no device store: the pod bearer is the whole
identity. `device_id` is synthesized per login and echoed back for clients
that require the field.

## Identity & object derivation

- **`user_id` = `@<pod>:<host>`** — `<pod>` is the first WebID path segment
  (`/alice/…` → `alice`), `<host>` is the homeserver `server_name`
  (`new URL(baseUrl).host`). Single-user WebIDs (`/profile/card…`) fall back
  to the host label.
- **`room_id` = `!<localpart>:<host>`** — `<localpart>` is an opaque
  base64url id minted at creation and also the pod filename. A room maps onto
  one JSON resource `<pod>/matrix/rooms/<localpart>.json` holding
  `{ room_id, creator, name, topic, created, events: [...] }`. The first event
  is a synthetic `m.room.create`, by Matrix convention.
- **`event_id` = `$<opaque>`** — the event-id v3+ grammar (no domain part).
  Every `send` appends `{ event_id, type, sender, content, origin_server_ts,
  txn_id }` to the room's `events` array; the `txn_id` makes a re-sent event
  idempotent (same `event_id`, no duplicate).
- **Write auth is honest.** Room/message writes are loopback LDP `PUT`s
  carrying the caller's own bearer, so real WAC governs them: a client can
  only write to a pod it actually controls, and a 401/403 from WAC surfaces as
  `M_FORBIDDEN`.

## Findings

### 1. Matrix's fixed `/_matrix` root doesn't fit the one-prefix plugin model — the Nth confirmation, now for a chat protocol (CLOSED: `api.reservePath`, JSS 0.0.219)

The same seam `mastodon/` (`/api`+`/oauth`) and `bluesky/` (`/xrpc`) found,
confirmed a **third** time and for a **different protocol family** (real-time
chat, not microblogging). A Matrix client hits **fixed absolute paths** under
`/_matrix/client/...` that no client will let you relocate under a plugin
`prefix`. Two things follow, identically to the microblog shims:

- **Routing works.** The loader does not confine a plugin's routes to its
  prefix (`api.fastify` is the real scoped instance), and these static/param
  routes outrank core's LDP `GET /*` wildcard on Fastify's specificity
  ordering. Registration is fine.
- **Authorization did not (before 0.0.219).** `/_matrix` is an ordinary pod
  path, not `/.well-known/*` (which core blanket-exempts). The WAC hook skips
  only paths in `appPaths`, and the loader pushes a plugin's **single
  `prefix`** there. A plugin had no way to push more roots — there was no
  `api.reservePath()` / `api.appPaths.add()` — so it **could not self-exempt
  its own surface**, and every unexempted client call was 401'd by WAC before
  the handler ran.

The honest consequence, at the time: the shim was only usable if the
**operator** widened `appPaths` by hand (`appPaths: ['/_matrix']`). That the
finding held across **social (`activitypub`) → microblog (`mastodon`,
`bluesky`) → chat (`matrix`)** was the point: the one-prefix model couldn't
express *any* app whose routes are dictated by an external protocol at a
fixed absolute root, regardless of protocol family — an `api.reservePath()`
surface would close it uniformly.

**Closed — JSS 0.0.219 shipped exactly that seam (#602), consumed here.**
`activate()` now calls `api.reservePath('/_matrix', { methods: ['GET',
'HEAD', 'OPTIONS', 'POST', 'PUT'] })`: the literal reservation WAC-exempts
the whole `/_matrix` subtree, widened to exactly the write verbs the routes
implement (POST login/createRoom, PUT send-event) and no further — exempting
a verb no route implements would let it fall through to core's LDP write
wildcards as an unauthenticated storage write. A second plugin reserving the
same root fails the boot loudly (naming both claimants), and route
registration stays the plugin's job. The operator no longer touches
`appPaths`.

### 2. The `/idp/credentials` token bridge generalizes to a 4th protocol

The same loopback bridge established by `notifications/`/`webdav/` and reused
for OAuth (`mastodon`) and XRPC sessions (`bluesky`), now put to Matrix's
`m.login.password` login. The shim has **no user store and mints no token of
its own** — `POST /_matrix/client/v3/login` calls the host's own
`/idp/credentials` over loopback and returns the pod bearer verbatim as the
Matrix `access_token`. Because a Matrix token and a Solid bearer are the same
kind of thing (a value resent in `Authorization`), the two worlds join with
zero impedance, and `getAgent(request)` resolves every later call — so the
shim never decides identity, the server does. **Four protocols
(ActivityStreams login, Mastodon OAuth, AT-Protocol sessions, Matrix login),
one bridge:** authentication translation is a general property of the loopback
+ `getAgent` pair, not a per-protocol trick.

### 3. LDP ↔ Matrix-event mapping: timelines fit, the `/sync` since-token model does not

- **Timelines map cleanly onto an append-only resource.** A Matrix room's
  timeline is an ordered event log; storing it as a growing `events: [...]`
  array in one pod JSON resource, with `event_id`s minted at append time,
  round-trips `/rooms/{id}/messages` and `/joined_rooms` faithfully. Read-time
  work only: `/messages` is one `GET`, `/joined_rooms` and `/sync` walk the
  `matrix/rooms/` container (one `GET` + one per room — the same N+1 /
  `api.events` write-index seam `sparql/` and `mastodon/` note).
- **The `/sync` since-token model is the wall.** Matrix's core client loop is
  a long-poll `GET /sync?since=<token>` that returns *only what changed since
  that token* and blocks until something does. That needs **server-side,
  per-device sync state** (a cursor the homeserver tracks for each client) and
  a **live push channel** to wake the long-poll on a write. This shim is
  stateless (identity is the pod bearer, storage is the pod) and reacts to no
  pod write — so it can only implement a **full-state, non-incremental
  `/sync`**: it ignores `since`, returns every room's whole timeline, and
  hands back a placeholder `next_batch`. That is correct-but-inefficient for a
  first fetch and wrong for a delta. A real `/sync` wants exactly the two
  things the api lacks: **write-time reactivity** (the missing
  `api.events.onResourceChange`, which would also power live push over
  `api.ws.route`) and a place to keep per-device sync cursors (server-side
  plugin state keyed by device — `pluginDir` could hold it, but only
  `api.events` can keep it fresh). This is the sharpest "stateless bridge vs.
  stateful protocol" gap the shim family has hit: the microblog shims'
  timelines are pull-only, so they never needed it; Matrix's push-shaped core
  makes the seam unavoidable.

## Run

```
cd .. && node --test --test-concurrency=1 matrix/test.js
```

12 tests, all green: versions (public) → login (bad password 403) → whoami
(anon 401) → createRoom (unauth 401, resource lands in the pod) → send
(idempotent txnId) → messages (contains the message) → joined_rooms → sync
stub.
