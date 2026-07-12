# AGENT.md — building JSS plugins

Orientation for an LLM (or human) adding to this repo. Read this, then
`NOTES.md` (findings/seams) and `ISSUES.md` (backlog disposition). The
existing plugins are your reference implementations — this file tells you
which one to copy for what.

## What this repo is

Out-of-tree plugins for [JavaScript Solid
Server](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer),
built on its **#206 loader** (`createServer({ plugins })`, JSS ≥ 0.0.215).
It is an *experiment*: prove the plugin api by using it, and treat every
wall you hit as a finding, not a blocker. **35 plugins, 471 tests today.**

### The one rule that makes the experiment valid

A plugin's `plugin.js` may import **only**:
1. Node builtins (`node:crypto`, `node:fs`, …),
2. this repo's deps (`@noble/curves`, `ws`) — add none without cause,
3. `javascript-solid-server/auth.js` (the one blessed import, for `getAgent`).

**Never `javascript-solid-server/src/...`.** If you can't build it without an
internal, that gap *is the result* — document it in your README `## Findings`
and in `NOTES.md`, implement the closest honest approximation (vendor a
trimmed pure module with attribution, or reach the host over loopback), and
move on. Copying an internal defeats the point.

## The plugin api

Your module exports `async function activate(api)`. What `api` gives you:

| member | what |
|---|---|
| `api.fastify` | the scoped Fastify instance — register routes/hooks here |
| `api.prefix` | your mount prefix (WAC-exempt automatically); `''` if none |
| `api.config` | the entry's `config` object, verbatim |
| `api.log` | logger; speaks both `.info/.warn/.error` and `.log` |
| `api.auth.getAgent(request)` | `async → agentId string | null` (WebID or did:nostr), verified across every credential scheme |
| `api.storage.pluginDir()` | a private server-side dir under the data root's dot-guard — never served over HTTP; your persistence lives here |
| `api.ws.route(path, (socket, request) => {})` | a WebSocket endpoint via the host's upgrade stack — no `@fastify/websocket`, no `'upgrade'` listener |

Return `{ deactivate() }` for teardown (close sockets, clear timers) on
server close. **Fail loudly**: if required config is missing, `throw` in
`activate` — the loader turns it into a boot failure, which is what you want.

## The five patterns (copy these)

1. **Loopback to the host** — the workhorse. To touch pod data or reach
   another host endpoint, make an HTTP call to the server itself
   (`config.loopbackUrl`/`baseUrl`) **forwarding the client's
   `Authorization`**, so the host's real WAC decides. You get correctness
   for free and need no internal access. See `notifications/` (a single HEAD
   authorization check), `webdav/` `carddav/` `caldav/` `rss/` `sparql/` (a
   whole data plane), `mastodon/` `bluesky/` `activitypub/` (token bridge to
   `/idp/credentials`). This is how a plugin does anything WAC-governed.
2. **Token bridge** — for API shims: `POST /oauth/token` (or equivalent)
   calls the host's `POST /idp/credentials` over loopback and returns the
   pod bearer verbatim as the client's token; later calls resolve via
   `getAgent`. A Mastodon/Bluesky/OAuth token and a Solid bearer are the
   same kind of thing. See `mastodon/`, `bluesky/`.
3. **`pluginDir` persistence** — anything stateful (relay events, capability
   secrets+revocations, OTP table, AP keypairs/followers, git repos) is JSON
   or files under `api.storage.pluginDir()`. See `relay/`, `capability/`,
   `otp/`, `activitypub/`, `gitscratch/`.
4. **HMAC macaroon-lite tokens** — for self-verifying scoped tokens with no
   DB: `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, ...))>`,
   secret in `pluginDir`. See `capability/` (canonical), `otp/` (session).
5. **`ws.route` for realtime** — bring your own `WebSocketServer({ noServer:
   true })` if you like and feed it, or just use the handler. See `relay/`,
   `webrtc/`, `terminal/`, `tunnel/`, `notifications/`.

## The gaps (what you can't do, and the workaround)

Full ranking in `NOTES.md`. The ones you'll hit:

- **No `api.authorize(request, path, mode)`** — you can't ask "would WAC
  allow this?" for authority the *requester* doesn't drive (a proxy governed
  by a pod owner's `.acl`, a capability exercising the *issuer's* right).
  Workaround: loopback with the requester's own creds covers the common
  case; the issuer-authority case has no workaround — document it. (4
  consumers; the top blocking seam.)
- **`api.reservePath()` — LANDED (JSS 0.0.219, #602) and consumed.** A
  plugin now claims + WAC-exempts its protocol-pinned paths itself:
  literal roots (`api.reservePath('/xrpc', { methods: [...] })` — see
  mastodon/bluesky/activitypub/matrix) and parameterized shapes
  (`api.reservePath('/:user/did.json')` — see didweb/). Reservations are
  READ-ONLY by default; widen `methods` to exactly the verbs your routes
  implement, never wider (an exempted verb with no route falls through to
  LDP's write wildcards unauthenticated). No more operator `appPaths`.
  `/.well-known/*` still also rides core's blanket exemption; reserving a
  well-known doc makes the claim deliberate and collision-guarded.
- **No `api.events.onResourceChange`** — you can't react to pod writes, so a
  write-time index / cached feed is impossible; do read-time work (walk the
  container per request) and note the O(N) cost. See `sparql/`, `rss/`.
- **`api.serverInfo` — LANDED (JSS 0.0.218, #601), retrofit in progress.**
  Resolve the origin at REQUEST time (`api.serverInfo().baseUrl`; with an
  ephemeral port it only exists once listening), keep `config.baseUrl` as
  an optional reverse-proxy override. Consumed by webfinger/, didweb/,
  dashboard/, admin/, gallery/; ~18 plugins still carry the old
  config-pair pattern and retrofit the same way.
- **`api.mountApp` — LANDED (JSS 0.0.219, #583).** A raw `(req,res)`
  handler with the UN-drained request stream — the streaming-upload lane
  Fastify's parsers can't give you. See gallery/ (the first consumer) for
  the contract's edges: the mounted lane sidesteps the host `bodyLimit`
  (cap your own if you don't forward to core), the two lanes can't share
  a prefix, and `getAgent` needs a shim for raw reqs.
- **No `api.mcp.registerTool`** — MCP tools can't be added by a plugin
  (that's why #495/#496/#500/#501 aren't here).
- **Can't set Fastify server options** — e.g. `maxParamLength` (100) 404s
  long tokens in named params; use a wildcard route (`/x/*`). See
  `capability/`.

## How to build a new plugin

1. `mkdir <name>/` — the directory name is the plugin id by convention.
2. `<name>/plugin.js` exporting `activate(api)`. Obey the import rule. Pick
   the nearest existing plugin and copy its shape (see the map below).
3. `<name>/test.js` — `node:test` using `../helpers.js`:
   ```js
   import path from 'path';
   import { fileURLToPath } from 'url';
   import { startJss, probePort } from '../helpers.js';
   const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
   const entry = { id: '<name>', module: path.join(__dirname, 'plugin.js'),
                   prefix: '/<name>' };

   // Simple case — no own origin needed:
   const jss = await startJss({ plugins: [entry] });          // jss.base, jss.wsBase, jss.root, jss.close()

   // Needs its own origin (baseUrl/loopback) or fixed roots? Probe first:
   const port = await probePort();
   const base = `http://127.0.0.1:${port}`;
   const jss2 = await startJss({ port, idp: true,
     // fixed roots outside your prefix: api.reservePath in activate (#602),
     // NOT appPaths — see the mastodon/bluesky/activitypub/matrix retrofits
     plugins: [{ ...entry, config: { baseUrl: base, loopbackUrl: base } }] });
   // ... drive real HTTP/WS against jss.base / jss.wsBase ...  then: await jss.close();
   ```
   Mint a pod bearer when you need auth: `POST /.pods` (or `/idp/register`)
   then `POST /idp/credentials` → `access_token`; send `Authorization:
   Bearer`. Run: `node --test --test-concurrency=1 <name>/test.js`.
4. `<name>/README.md` — usage snippet, what maps / what doesn't, and a
   `## Findings` section. **The findings are the deliverable** — what the api
   gave you, what it didn't, which seam a wall points to.
5. Wire it into `compose.test.js` and `serve.js` (both list every plugin;
   add fixed roots to their `appPaths` if you have any). Add its findings to
   `NOTES.md` and its row to `README.md` / `ISSUES.md`. Run `npm test`.

### "I want to build X → copy Y"

| If X is… | copy | because |
|---|---|---|
| a realtime/WebSocket service | `relay/` or `webrtc/` | `ws.route` + `pluginDir` |
| a DAV-family protocol (CalDAV done, e.g. a filesystem/WebDAV variant) | `webdav/`→`carddav/`→`caldav/` | loopback + multistatus XML + ETag + Basic→Bearer, proven 3× |
| an API shim (a new social/chat/proto) | `mastodon/` or `bluesky/` | token bridge + self-reserved fixed roots (#602) |
| a `.well-known` discovery doc | `nip05/` or `webfinger/` | podsRoot scan + guarded absolute route |
| a scoped-token / auth service | `capability/` or `otp/` | HMAC macaroon-lite + `pluginDir` |
| a query/read/search over pod data | `sparql/`, `rss/`, `search/` | loopback container walk + forwarded auth |
| a federation actor | `activitypub/` | keypair in `pluginDir` + loopback objects |
| a proxy/gateway | `corsproxy/` | fetch upstream, SSRF gates, CORS |
| an object-storage / S3-style gateway | `s3/` | loopback LDP + hand-rolled XML + SigV4 |
| a DID / identity document | `didweb/` | podsRoot scan + key derivation |
| a dev/tooling subsystem | `gitscratch/` | shell a system binary via CGI |
| a hosted-content web app (forge, wiki, …) | `forge/` | CGI plumbing + server-rendered GitHub-light UI + JSON API, zero deps/build |
| a posting protocol (IndieWeb-style, client-discovered endpoint) | `micropub/` | pod bearer as the protocol token + loopback writes |
| a data-export / archive download | `backup/` | loopback container walk streamed into a hand-rolled format |
| an ops/observability endpoint | `metrics/` | node builtins + an `api.fastify` hook (scope: all plugins, never core) |
| a meta/status page over siblings | `dashboard/` | anonymous loopback probes + an operator-declared list (no registry) |
| a per-resource metadata/unfurl endpoint | `oembed/` | loopback resolve + local-URL-only guard |
| a stateless request/response protocol (mail, sync, …) | `jmap/` | loopback CRUD + in-protocol refusal of push/delta |
| a storage protocol with conditional writes | `remotestorage/` | If-Match/If-None-Match pass through loopback intact |
| a redirect / metadata micro-service | `shortlink/` | pluginDir JSON table + wildcard slug routes |
| an operator/admin surface | `admin/` | compose probes + podsRoot scan behind an agent allowlist |
| a streaming-body app (upload, media) | `gallery/` | `api.mountApp` raw handler → loopback PUT, auth forwarded |
| a multi-server scenario (not a plugin) | `federation-demo/` | child-process instances (DATA_ROOT is process-global) |

## Footguns (every multi-boot suite rediscovered these)

- **Module-global `DATA_ROOT`**: each `createServer` repoints a process
  global — a second boot in one process, *even a failing one*, poisons the
  first. Order any validation-failure test **before** the long-lived boot.
- **Ambient `~/.gitconfig`** (git-shelling plugins): spawn git with
  `GIT_CONFIG_NOSYSTEM=1` and no `HOME`, or the operator's `init.defaultBranch`
  leaks into created repos.
- **Generic basename id — FIXED in JSS 0.0.219 (#596)**: the loader now
  derives `<name>/plugin.js` → id `<name>` from the parent dir; explicit
  `id` fields are gone from `compose.test.js`/`serve.js`. Don't reintroduce
  them — but if a test hardcodes a pluginDir path, it's `.plugins/<name>/`
  now, not `.plugins/plugin/`.
- **Dotted prefixes** (`/.foo`) fail the WS upgrade — core reserves dotted
  paths. Use a plain prefix for anything with a socket.
- **`logger: false` kills plugin `onResponse` hooks**: core's access-log
  hook throws on the null logger and aborts the downstream chain. If your
  plugin uses `onResponse`, boot tests with `logger: true, logLevel:
  'silent'` (helpers.js defaults to `logger: false`).

## Current state

35 plugins (7 ports + 28 features) + the two-server `federation-demo/`,
471 tests, all green (`npm test`).
A four-axis security review ([SECURITY.md](./SECURITY.md)) hardened the
inbound-federation and query surfaces; the WAC-deferral pattern held.
`compose.test.js` runs every plugin on a single server from pure config.
Four seams have now LANDED upstream and are consumed here: `api.serverInfo`
(#601), `api.reservePath` (#602), `api.mountApp` (#583), `api.plugins`
(#610) — all in JSS 0.0.218/0.0.219, which this repo pins. Still open:
`api.events` (#603) and `api.authorize` (#604). Everything else lives
here, by design. [REPORT.md](./REPORT.md) is the maintainer-facing
summary of it all.
