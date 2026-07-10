# relay — NIP-01 nostr relay plugin

Out-of-tree port of JSS `src/nostr/relay.js`.

```js
plugins: [{ module: 'relay/plugin.js', prefix: '/relay',
            config: { maxEvents: 1000, rateLimit: 60, persist: true } }]
```

WebSocket relay at the mount prefix. EVENT/REQ/CLOSE per NIP-01,
replaceable + parameterized-replaceable + ephemeral kinds, per-socket rate
limiting — feature parity with core, plus one improvement core doesn't
have: events persist to `api.storage.pluginDir()` (JSONL), so the relay
survives restarts.

## Findings

- **`api.ws.route` was sufficient** for the whole realtime surface — no
  `@fastify/websocket` dependency, no upgrade handling, ~10 lines less
  glue than core's registration.
- **Wall: event verification is internal.** Core's `src/nostr/event.js`
  (validate/verify/sign, the #135 nostr-tools replacement) is not a
  documented import, so this port vendors a trimmed copy
  ([nip01.js](./nip01.js)). Fine for a relay (crypto is a legitimate own
  dependency via `@noble/curves`), but any plugin wanting to *verify nostr
  events the way the host does* re-implements today. Candidate seam:
  export it like auth.js, e.g. `javascript-solid-server/nostr.js`.
- **`api.storage.pluginDir()` immediately earned its keep** — persistence
  was a 15-line add that core never grew.
