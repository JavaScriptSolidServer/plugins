# webrtc — WebRTC signaling plugin

Out-of-tree port of JSS `src/webrtc/index.js`.

```js
plugins: [{ module: 'webrtc/plugin.js', prefix: '/webrtc',
            config: { maxMessageSize: 65536, maxOffersPerAnnounce: 10,
                      maxResourcesPerPeer: 50 } }]
```

One WebSocket endpoint at the mount prefix, speaking core's exact wire
protocol (core mounts at `/.webrtc`; here the prefix decides). Three
dialects on the same socket:

- **Identity-based** (authenticated): connect with `Authorization: Bearer`
  or `?token=` (browser WebSocket can't set headers), get a
  `{ type: "peers", you, peerId, peers }` welcome, then relay
  `offer` / `answer` / `candidate` / `hangup` to a peer by WebID (or
  did:nostr DID). Presence via `peer-joined` / `peer-left`; reconnects
  replace the old socket.
- **Content-addressed** (anonymous ok): `announce` a hex resource hash —
  the "room" — with SDP offers; the server relays offers to peers already
  in the room, `answer` routes back by peer id, `leave` exits. Rooms are
  isolated; membership is cleaned up on disconnect.
- **WebTorrent tracker dialect**: `{ action: "announce", info_hash,
  peer_id, offers }` with 20-byte binary or hex ids, for stock WebTorrent
  clients.

The server only introduces peers — media and data flow directly between
them. Full parity with core, plus: messages arriving while auth is still
resolving are buffered and replayed in order (core can drop an eager
client's first message), `deactivate()` closes every socket rather than
only identity-registered ones, and the size limits are configurable.

## Findings

- **Zero vendored code — the first wall-free port.** `api.auth.getAgent`
  replaced core's internal `src/auth/token.js` one-for-one, and it
  verified Bearer tokens on a raw WebSocket *upgrade* request unchanged.
  Everything else was `api.ws.route` + `api.prefix` + `api.config`.
- **`api.ws.route` handlers can be async** and the loader catches
  rejections (logs, terminates the one socket) — exactly what an
  auth-then-serve WebSocket needs. The handler also gets the full Fastify
  request: `request.query` for the `?token=` fallback, mutable
  `request.headers` to shim that token in as a Bearer header before
  calling `getAgent`. That shim works but is awkward — candidate seam:
  `getAgent(request, { queryToken: true })` or native `?token=` support,
  so browser WebSocket auth isn't a copy-paste ritual across plugins.
- **Timing trap found by the port: the welcome frame can coalesce with
  the 101 handshake.** `getAgent` on a Bearer token resolves without
  I/O, so the plugin's `peers` welcome can land in the same TCP segment
  as the upgrade response; node's `ws` client then emits `message`
  synchronously right after `open`, and any listener attached after
  `await open` silently misses it. Core never noticed because its auth
  path crosses more event-loop ticks. Not a plugin-api gap — a protocol
  footgun; the test client buffers from socket construction (browsers
  queue events as tasks and are unaffected).
- **The port fixes core's own auth race**: core attaches its message
  handler only after `await`ing auth, so a client that speaks immediately
  after `open` (legal for the anonymous tracker dialect) can lose
  messages. Here a buffering listener goes on first, then handlers swap
  synchronously and the backlog replays in order.
- **Tests authenticate with zero internals**: `POST /.pods` returns
  `{ webId, token }` over plain HTTP, so real Bearer credentials come
  from the public surface — no reaching into the IdP or token modules.
- **Parity gaps: none.** All three dialects, all message types, all error
  paths. Only differences are the mount path (prefix vs hardcoded
  `/.webrtc`) and the deliberate improvements above. `peer-joined` /
  `peer-left` keep core's `webId` field name on the wire even though the
  value may be a did:nostr DID, so existing clients keep working.
