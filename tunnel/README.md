# tunnel — reverse HTTP tunnel over WebSocket

Out-of-tree port of JSS `src/tunnel/index.js` ("decentralized ngrok",
AGPL-3.0-only): a tunnel client connects over WebSocket, registers a name,
and the pod proxies public HTTP traffic to it.

```js
plugins: [{ module: 'tunnel/plugin.js', prefix: '/tunnel',
            config: { requestTimeout: 30000, maxMessageSize: 10485760 } }]
```

- Control socket: `ws://host/tunnel/connect` — authenticated
  (`api.auth.getAgent`: Bearer, DPoP, NIP-98, …; `?token=` fallback for
  browser clients, #528).
- Public URL: `http://host/tunnel/{name}/path`.

## Protocol (unchanged from core)

```
→ { type: "register", name: "myapp", passthrough?: true }
← { type: "registered", name: "myapp", url: "/tunnel/myapp/", passthrough: bool }
← { type: "request", id, method, path, headers, body?, bodyEncoding? }
→ { type: "response", id, status, headers, body, bodyEncoding? }
← { type: "error", message }
```

Full #530 credential model ported: by default `Cookie`/`Authorization`
are stripped inbound and `Set-Cookie` outbound; a registration may opt in
with `passthrough: true` (strict boolean), which forwards them — except
the relay's own IdP `_session`/`_interaction` cookies and
`Proxy-Authorization`, which never cross. 10MB message cap (#567), 30s
response timeout, name takeover only by the same agent, 308 redirect for
`/tunnel/{name}` → `/tunnel/{name}/`.

## Deviations from core

- **Single mount prefix.** Core owns two path roots: the control socket
  at `/.tunnel` and traffic at `/tunnel/{name}/…`. The loader WAC-exempts
  exactly ONE prefix per plugin, so both live under the mount: control at
  `{prefix}/connect`, traffic at `{prefix}/{name}/…` — which makes
  `connect` a **reserved tunnel name** (registration rejects it).
- **Raw bodies, always base64.** The proxy routes sit in a scoped
  pass-through content-type parser (see Findings / JSS #583), so
  `request.body` is the untouched Buffer and every forwarded body is
  `bodyEncoding: "base64"`. Core re-serializes parsed JSON bodies
  (minifying/reordering them); this port is byte-exact — within protocol,
  since clients must already handle both encodings.
- **`requestTimeout` / `maxMessageSize` are config knobs** (core
  hardcodes 30s / 10MB).
- **Auth frames are queued, not dropped.** Core `await`s verification
  before wiring the message handler, so a `register` sent during a slow
  credential check (e.g. first did:nostr resolution) is lost. Here every
  message awaits the shared auth promise — ordering preserved, nothing
  dropped.
- Agents are keyed on `api.auth.getAgent`'s id string (WebID **or**
  `did:nostr:` DID) rather than core's `webId` — same semantics, wider
  domain.

## Findings

- **The one-prefix rule forced the only real protocol change.** A plugin
  cannot own both `/.tunnel` and `/tunnel/`; folding the control socket
  into the mount (`{prefix}/connect`) cost a reserved name. Fine here,
  but any port whose core feature spans multiple path roots will hit
  this seam — plugins may want `prefix: [a, b]` or an
  `api.appPaths.add(path)` escape hatch.
- **Fastify body parsing vs. raw proxying (#583) — the known pattern
  works.** `api.fastify` is a real scope: `register(async (scope) => {
  scope.removeAllContentTypeParsers(); scope.addContentTypeParser('*',
  { parseAs: 'buffer' }, …) })` confines raw-body handling to the proxy
  routes without touching the host's parsers. Ergonomic enough, but every
  proxying plugin will re-discover it; an `api`-level "give me raw
  bodies under this route" helper would close the gap.
- **`api.ws.route` needed no wildcard.** Core's tunnel already
  multiplexes all traffic over one control socket, so a single exact ws
  path sufficed; wildcard ws routes were never needed. (They'd be needed
  by a port whose *clients* connect to per-resource ws paths — the
  notifications port is the one that will test that.)
- **No way to pass ws server options.** The loader registers
  `@fastify/websocket` itself with defaults, so a plugin can't set
  `maxPayload`; like core, the 10MB cap (#567) is enforced app-level
  after the frame is already in memory. A `ws.route(path, handler,
  { maxPayload })` passthrough would let the transport reject oversized
  frames early.
- **`api.auth.getAgent` covered the gate 1:1** — including the `?token=`
  browser fallback (the plugin just copies the query param into the
  Authorization header before calling it). No internal imports needed
  anywhere in this port; the only import in plugin.js is `node:crypto`.
- **Testing an auth-gated plugin without an IdP:** NIP-98 is the one
  credential a test can self-mint (schnorr event over the control URL,
  ~20 lines with `@noble/curves`); the agent falls back to
  `did:nostr:<pubkey>`. First verification may consult the external
  did:nostr resolver (timeout-bounded, then cached per pubkey) — the
  test budgets 15s for the first ack. A documented "test credential"
  seam in the host would make plugin test suites hermetic.

## Test

```bash
node --test --test-concurrency=1 tunnel/test.js
```

10 tests: auth rejection, end-to-end GET through a real local target
(headers both ways, query string), byte-exact POST round-trip, #530
default-strip + passthrough (incl. relay-cookie filtering), reserved and
invalid names, 502 unknown tunnel, 308 trailing-slash redirect, in-flight
disconnect → 502 (and 502 after), unanswered request → 504.
