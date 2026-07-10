# jss-plugins — the out-of-tree experiment

**Status: experimental.** Ports of [JavaScript Solid
Server](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer)'s
bundled features onto the [#206 plugin
loader](https://jss.live/docs/features/plugins) (`createServer({ plugins })`,
JSS ≥ 0.0.215) — each living **outside** the JSS tree, using only what a real
third-party plugin gets.

## Why

Inside `src/`, the bundled features cheat: they import internals, share
closures with server.js, and reach around WAC. Out here a port can only use
the public surface — `activate(api)` plus the documented imports — so:

- every port is an **honest test** of the plugin api,
- every wall a port hits is a **seam discovery**, written up in
  [NOTES.md](./NOTES.md) before it becomes an upstream issue,
- and core stays untouched: these are parallel implementations, not
  migrations. Nothing here removes or changes anything in JSS.

This is the plugin-zero method
([#582](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/582) →
[#584](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/584) →
[#588](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/588) →
[#589](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/pull/589))
applied to JSS's own feature set.

## The rule

A plugin directory may import:

1. `javascript-solid-server/auth.js` (`getAgent`) — the documented contract,
2. whatever the `activate(api)` surface provides,
3. its own npm dependencies.

**Never `javascript-solid-server/src/...`.** If a port can't be written
without internals, that gap is the finding — document it in the port's
README and NOTES.md, ship the closest honest approximation.

## Layout

```
relay/           NIP-01 nostr relay              (port of src/nostr/relay.js)
webrtc/          WebRTC signaling rooms          (port of src/webrtc/index.js)
terminal/        WebSocket shell — GATED         (port of src/terminal/index.js)
tunnel/          reverse tunnel over WebSocket   (port of src/tunnel/)
notifications/   pod change notifications        (port of src/notifications/ — the seam-forcer)
pay/             HTTP 402 paid routes            (port of src/mrc20.js pay mode — wall-report)
compose.test.js  ONE server, every plugin, from pure config
serve.js         demo composition
NOTES.md         findings log: what the api gave us, what it didn't
```

Each directory: `plugin.js` (exports `activate(api)`), `test.js` (boots a
real JSS from npm), `README.md` (usage + findings for that port).

## Run

```bash
npm install
npm test          # every port's tests + the all-plugins composition
npm run serve     # one server: pods + every plugin
```

## License

AGPL-3.0-only, same as JSS — several ports adapt JSS source.
