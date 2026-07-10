# terminal — WebSocket shell plugin (GATED)

Out-of-tree port of JSS `src/terminal/index.js`. A remote shell over a
WebSocket — the most dangerous of the ports, so the gate is deliberately
**stricter** than core.

```js
plugins: [{
  module: 'terminal/plugin.js',
  prefix: '/terminal',
  config: {
    // At least one of these is REQUIRED — activate() throws otherwise.
    allowAgents: ['https://alice.example/profile/card#me'], // verified-agent allowlist
    token: 'shared-secret',                                 // browser query-param fallback
    // Optional:
    shell: '/bin/sh',        // default /bin/sh
    args: [],                // default none (reads commands from stdin)
    cwd: '/srv/work',        // default api.storage.pluginDir()
    env: { FOO: 'bar' },     // merged into the curated env (never process.env)
    PATH: '/usr/bin:/bin',   // override the child's PATH
  },
}]
```

A client sends stdin as text/binary frames and receives stdout+stderr the
same way; lifecycle signals arrive as JSON envelopes
(`{type:"exit",code}` / `{type:"error",message}`), matching core's wire
protocol.

## Security model

This endpoint hands a network client a shell. Every layer assumes that.

1. **No open shell, ever.** `activate()` **throws** unless `config`
   provides access control — a non-empty `allowAgents` array and/or a
   `token`. There is no `public` escape hatch (core has one; this port
   drops it on purpose). A misconfigured operator gets a failed boot, not
   an anonymous root shell.

2. **Connection auth, two mechanisms:**
   - **`allowAgents` (primary).** At connect time the plugin calls
     `api.auth.getAgent(request)` — the same `#584` contract the host uses,
     covering IdP Bearer/DPoP, NIP-98, LWS-CID and WebID-TLS — and admits
     the connection only if the verified agent id is in the allowlist. The
     `ws` npm client *can* send an `Authorization` header, so programmatic
     clients use this path.
   - **`token` (browser fallback).** Browsers cannot set headers on a
     WebSocket handshake, so a shared secret may be passed as `?token=…`
     and is compared (length-checked, constant-time-ish) to `config.token`.
     This is a bearer secret in a URL — weaker than a verified credential
     (it can land in logs/history), so treat it as a convenience for
     trusted/dev use and prefer `allowAgents` in production.

   Unauthorized handshakes get an `{type:"error"}` frame and a close with
   code `1008` before any process is spawned.

3. **Minimal env.** Core spawns with `{ ...process.env }`, leaking every
   server secret (token secrets, API keys, JWKS paths) into a
   client-driven shell. This port spawns with a curated env only —
   `PATH`, `HOME` (= cwd), `TERM`, `LANG`, plus any explicit `config.env`.
   `process.env` is never passed through.

4. **Confined working dir.** Defaults to `api.storage.pluginDir()` (a
   private, never-served data dir), overridable via `config.cwd`. Never the
   server's cwd.

5. **No orphans.** Each shell is tracked; the socket's `close`/`error`
   `SIGKILL`s its child, and `deactivate()` kills every remaining shell on
   server shutdown.

## Findings

- **`api.ws.route` + `api.auth.getAgent` cover the whole gate.** The
  request handed to the ws handler is the real Fastify request, so
  `getAgent(request)` verifies Bearer/DPoP/NIP-98 credentials exactly as an
  HTTP route would — no internal imports, no `@fastify/websocket`
  dependency. The authenticated-shell pattern ports cleanly.

- **Wall: the handshake cannot be rejected before it completes.**
  `api.ws.route` only exposes the *post-upgrade* socket, so an
  unauthorized client always sees the TCP/WS handshake succeed and is then
  closed with `1008`. Core has the same shape. It is fine for
  confidentiality (nothing is spawned or sent), but a plugin cannot answer
  the upgrade with a `401`, and clients must treat an immediate `1008`
  close as "refused" (the test's `open()` helper does). Candidate seam: let
  `ws.route` accept a pre-upgrade guard, e.g.
  `api.ws.route(path, handler, { authorize(request) })`.

- **No one-use ticket flow in core.** Grepping `src/` turns up only the
  IdP's OAuth one-time-use token bookkeeping — nothing a browser can trade
  for a short-lived ws ticket. So the browser fallback here is a static
  `?token=` shared secret, with the tradeoff documented above. A proper
  `POST /…/ticket` → single-use nonce → `?ticket=` exchange would be the
  right upstream fix; it needs a route the plugin owns plus short-TTL
  storage (`pluginDir` suffices), but is out of scope for a faithful port.

- **No PTY.** Core uses `child_process` with `sh -i` (no `node-pty`), and
  so does this port — we honor the "no native deps" rule for free. The
  consequence is the same as core's: no real TTY, so job control, terminal
  sizing (`SIGWINCH`), and programs that demand a tty (`vi`, `top`,
  password prompts) degrade or misbehave. This port drops the interactive
  `-i` flag by default and reads commands from stdin, which avoids prompt
  noise; set `config.args` to `['-i']` to match core. A real PTY would
  require a native dependency and is deliberately not added.

- **`api.auth.getAgent` needs no URL/host for Bearer.** IdP-issued Bearer
  JWTs verify against the local JWKS by signature alone, so the credential
  works over a ws handshake unchanged. DPoP/NIP-98 (which sign over
  method+url) would need the ws upgrade's method/url to line up with what
  the client signed — untested here, a note for anyone using those schemes
  over websockets.

## Tests

`node --test --test-concurrency=1 terminal/test.js` — 5 tests:
boot refusal without access control; unauthorized handshake closed
(missing/wrong token); authorized token session runs `echo` and sees
output; shell `SIGKILL`ed on disconnect (pid reaped, no orphan);
allowlisted agent connects with a Bearer header while an anonymous client
and a validly-signed-but-not-allowlisted agent are both refused.
