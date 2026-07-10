# notifications — solid-0.1 change notifications plugin

Out-of-tree port of JSS `src/notifications/` (the legacy SolidOS
`solid-0.1` WebSocket protocol). **The deliberate seam-forcer of this
repo** — chosen because core's version leans hardest on internals.

```js
plugins: [{ module: 'notifications/plugin.js', prefix: '/.notifications',
            config: {
              podsRoot: './data',                    // REQUIRED (finding 1)
              baseUrl: 'https://pod.example',        // REQUIRED (finding 2)
              loopbackUrl: 'http://127.0.0.1:3000',  // optional (defaults to baseUrl)
            } }]
```

Protocol parity: `protocol solid-0.1` greeting, `sub`/`ack`/`err … forbidden`,
`pub` with ancestor-container fan-out, `unsub`, subscription limits. Status
endpoint at `<prefix>/status`.

## Findings

1. **No way to learn the data root** — core watches `rootDir` handed to it
   by server.js; a plugin must have the operator repeat the path in config
   (drift risk: point it at the wrong dir and notifications silently cover
   nothing). Candidate seam: `api.events.onResourceChange(cb)` (best — no
   filesystem coupling at all, and core already has the
   `resourceEvents` emitter internally) or, weaker, `api.storage.serverRoot`
   read-only.
2. **No way to learn the server's public origin** — needed for constructing
   `pub` URLs, refusing cross-origin subscriptions, and the loopback check.
   The operator repeats it in config; a plugin cannot even discover it at
   `activate()` time (listen hasn't happened). Candidate seam:
   `api.serverInfo = { baseUrl, port }` resolved at listen.
3. **No response-header injection on core routes** — core advertises the
   websocket via an `Updates-Via` header on every LDP response. A plugin
   cannot add headers to routes it doesn't own; SolidOS clients relying on
   discovery won't find a plugin-hosted endpoint. Candidate seam: a scoped
   `api.hooks.onSend((request, reply) => …)`, policy question included
   (letting plugins touch every response is a bigger grant than the rest of
   the api).
4. **WAC checking from outside — solved, pleasantly.** Core calls internal
   `checkAccess()`. The port authorizes a subscription by **asking the
   server itself**: a loopback `HEAD` to the resource carrying the
   subscriber's own `Authorization` header. Slower (one HTTP round-trip per
   `sub`, cached nothing), but it *cannot disagree* with the server's real
   policy — the test suite proves it against a real WAC `.acl`. This
   pattern generalizes: any plugin needing "would the server allow X?" can
   ask over loopback rather than needing a `api.wac.check()` seam. A seam
   would still be nicer (no TCP round-trip, no loopbackUrl config), but
   it's a *convenience* seam, not a *possibility* seam.
5. **`fs.watch` parity note** — core's watcher and this one share the same
   blind spot (writes that bypass the filesystem, e.g. future non-fs
   storage backends) and the same strength (catches out-of-band edits).
   Only `api.events` fixes the blind spot for both.
