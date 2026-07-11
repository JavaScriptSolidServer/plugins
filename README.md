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

## Building more

**[AGENT.md](./AGENT.md)** is the comprehensive guide for adding plugins —
the api, the five reusable patterns, the gaps and their workarounds, a
copy-this-plugin map, and the footguns. Read it, then `NOTES.md` (findings)
and `ISSUES.md` (backlog).

## The rule

A plugin directory may import:

1. `javascript-solid-server/auth.js` (`getAgent`) — the documented contract,
2. whatever the `activate(api)` surface provides,
3. its own npm dependencies.

**Never `javascript-solid-server/src/...`.** If a port can't be written
without internals, that gap is the finding — document it in the port's
README and NOTES.md, ship the closest honest approximation.

## What's here

**Ports of bundled features** (does the public api reproduce core?):

| Plugin | Ports | Status | Notable |
|---|---|---|---|
| `relay/` | `src/nostr/relay.js` | ✅ parity + | pluginDir persistence core lacks; vendored NIP-01 verify |
| `webrtc/` | `src/webrtc/index.js` | ✅ full parity | **zero imports** — `activate(api)` alone sufficed; fixes an auth race core has |
| `terminal/` | `src/terminal/index.js` | ✅ parity + hardened | mandatory access control, minimal child env, confined cwd |
| `tunnel/` | `src/tunnel/` | ✅ parity | one deviation: single-prefix forces `{prefix}/connect` control path |
| `notifications/` | `src/notifications/` | ✅ parity | **the seam-forcer** — WAC via loopback; forces `api.events`, `api.serverInfo` |
| `pay/` | pay mode | 📋 wall-report | pipeline-modifying → **stays core**; draws the #564 line |

**New features built straight onto the api** (from the `plugin`-tagged issue backlog):

| Plugin | Issue | Notable |
|---|---|---|
| `nip05/` | #445 | `/.well-known/nostr.json` from pods' public keys; well-known-path ownership is *accidental* today |
| `corsproxy/` | #382/#379 | forward proxy with fail-closed SSRF defense; per-pod ACL needs `api.authorize` |
| `capability/` | #506 | macaroon-lite scoped/time-bound/revocable capability URLs |
| `webdav/` | #507 | mount a pod in Finder/Nautilus/Windows; WebDAV↔LDP over loopback, Basic→Bearer |
| `sparql/` | #509 | read-time SPARQL SELECT over pod JSON-LD; write-index needs `api.events` |
| `gitscratch/` | #322 | ephemeral Solid-authed git remotes via the `git-http-backend` CGI |
| `otp/` | #505 | one-time-password session flow; account recovery needs core auth |
| `carddav/` | #157 | contact sync (iOS/macOS/Thunderbird/DAVx5); the DAV bridge, generalized |
| `mastodon/` | #515/#516 | Mastodon-API shim — a client logs into its own pod; needs `appPaths` widened |
| `bluesky/` | #211 | AT-Protocol XRPC shim — same shape, `/xrpc` root; token bridge generalizes |
| `caldav/` | #157-sib | calendar sync — completes the DAV family (webdav+carddav+caldav) |
| `webfinger/` | #164 | `/.well-known/webfinger` — fediverse `acct:` resolution for the shims |
| `activitypub/` | #51/#164 | federate a pod as an AS2 actor; outbound HTTP Signatures |
| `rss/` | — | any pod container as an Atom/RSS feed |

**~200 tests, all green** (`npm test`), including `compose.test.js` — all
twenty plugins on one server from pure config, pods + WAC intact beside
them. Findings consolidated in [NOTES.md](./NOTES.md); the full
plugin-tagged backlog triaged in [ISSUES.md](./ISSUES.md).

```
<name>/plugin.js   the port          <name>/test.js   real-JSS tests   <name>/README.md   findings
compose.test.js    ONE server, every plugin           serve.js         demo composition
helpers.js         test harness (boot JSS from npm)    NOTES.md         consolidated findings
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
