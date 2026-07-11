# corsproxy — CORS forward proxy as a plugin

Out-of-tree port of JSS's `--cors-proxy`
([#378](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/378),
shipped in [#379](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/pull/379),
`src/handlers/cors-proxy.js`) onto the #206 plugin loader. Browser apps
fetch cross-origin resources that lack CORS headers through the pod's
origin, and get the upstream response back with permissive CORS headers.

## Usage

```js
plugins: [{
  module: 'corsproxy/plugin.js',
  prefix: '/proxy',
  config: {
    allowHosts: ['api.example.com'],  // optional strict allowlist
    blockPrivate: true,               // default true
    requireAuth: false,               // default false
    maxBodyBytes: 50 * 1024 * 1024,   // default 50 MB
    timeoutMs: 30_000,                // headers-phase, default 30 s
    maxRedirects: 5,                  // default 5
  },
}]
```

Two request forms, any method (`GET`/`HEAD`/`POST`/`PUT`/`PATCH`/`DELETE`),
plus `OPTIONS` preflight:

```
GET  /proxy?url=https%3A%2F%2Fexample.com%2Fdata.json     query form
GET  /proxy/https://example.com/data.json                 path form
POST /proxy?url=…                                         body forwarded byte-exact
```

Responses stream through with the upstream status and headers (minus
hop-by-hop / `content-encoding` / `content-length` / `set-cookie` and the
upstream's own CORS answer), plus:

```
access-control-allow-origin: *
access-control-allow-methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS
access-control-allow-headers: <echoed from preflight, or a sane default>
access-control-expose-headers: *
```

Errors (400/401/502/504) carry the CORS headers too, so a browser app can
read them (relates to JSS #376).

### Config

| key | default | meaning |
|---|---|---|
| `allowHosts` | `[]` | **strict allowlist** when non-empty: only these hostnames (or `host:port`) are reachable, and they bypass the private-address guard — the operator vouched for them |
| `blockPrivate` | `true` | refuse targets that are (or resolve to) private/reserved addresses |
| `requireAuth` | `false` | require `api.auth.getAgent(request)` to return an agent (Bearer, DPoP, NIP-98, …); anonymous → 401 |
| `maxBodyBytes` | 50 MB | upstream response cap — partial slice up to the cap, then the transfer is aborted |
| `timeoutMs` | 30 s | headers-phase timeout → 504 (body-phase deferred, same as core — #380) |
| `maxRedirects` | 5 | manual redirect budget |

## Security model

A forward proxy is an SSRF cannon pointed at whatever network the server
sits on — the gates run **before** any fetch, and again on **every**
redirect hop:

1. **Scheme gate** — `http:`/`https:` only. `file:`, `ftp:`, `gopher:`,
   `data:` etc. are refused.
2. **Allowlist gate** — when `allowHosts` is set, the target hostname (or
   `host:port`) must match an entry; everything else is refused.
3. **Private-address gate** (`blockPrivate`, default on) — the hostname is
   resolved (`dns.lookup`, *all* A + AAAA records) and refused if **any**
   address is loopback (`127/8`, `::1`), RFC1918 (`10/8`, `172.16/12`,
   `192.168/16`), link-local (`169.254/16` — including the
   `169.254.169.254` cloud metadata endpoint — and `fe80::/10`), CGNAT
   (`100.64/10`), ULA (`fc00::/7`), site-local, multicast, reserved
   ranges, `0.0.0.0/8`, `::`, or a v4-mapped/NAT64 form embedding any of
   those. IP-literal targets are checked directly. Unresolvable or
   zero-record hostnames are refused — **fail closed** (core's shared
   guard fails open on empty A+AAAA, JSS #381; this port doesn't).
4. **Redirect re-validation** — `fetch` runs with `redirect: 'manual'`;
   each hop's target goes back through gates 1–3, so an allowlisted or
   public upstream cannot bounce the proxy into `http://10.0.0.1/`.
   Capped at `maxRedirects`.
5. **Credential hygiene** (the #379 header policy) — the caller's
   `Authorization` / `Cookie` / `DPoP` authenticate to *this pod* and are
   never forwarded upstream. Clients opt in to upstream credentials via
   `X-Upstream-Authorization`, which becomes `Authorization` on the way
   out and is dropped on any cross-origin redirect hop. Upstream
   `Set-Cookie` is stripped so a proxied site can't plant cookies on the
   pod's origin. `Host`/`Origin`/`Referer`/`Via`/`X-Forwarded-*` are
   stripped both for privacy and cache-poisoning reasons.
6. **Resource caps** — response bodies stream through a `maxBodyBytes`
   counter (truncate, then abort the upstream transfer); upstream must
   produce headers within `timeoutMs` or the caller gets a 504.

**Residual risk — DNS rebinding.** Gate 3 is resolve-then-fetch, and
global `fetch` resolves again; an attacker-controlled DNS name whose
answer flips between the two lookups can slip past. Closing that needs a
pinned-IP dial (custom undici `Agent`/`connect`), which the repo's
import rule excludes (undici isn't a `node:` builtin and isn't a repo
dep). Core's handler has the same resolve-then-fetch shape. Deployments
where this matters should use `allowHosts`, which doesn't rely on
resolution at all.

## Tests

`node --test corsproxy/test.js` — 13 tests: proxying (GET/POST/path
form/upstream errors), preflight, credential hygiene, and one test per
gate: private-IP refusal (against a *really listening* loopback upstream),
allowlist admits only its entries, scheme refusal, redirect
re-validation, missing-URL, body cap, `requireAuth` 401.

## Findings

### The headline: per-pod ACL gating is impossible out here — exactly what #382 says

Core's cors-proxy is **WAC-gated**: every request runs through
`authorize()` against the pod's `.acl` for `/proxy`, so in single-user and
subdomain modes the *pod owner* governs proxy access by writing an ACL
(READ for GET/HEAD, APPEND/WRITE for POST; payment-gated ACLs return 402).
[#382](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/382)
points out this already breaks down in path-based multi-pod mode, where
`/proxy` sits *outside* every pod and only the operator can gate it.

The plugin port makes that limitation **structural**:

- A plugin owns exactly one prefix, and the loader adds that prefix to
  `appPaths` — i.e. it is *exempted from WAC by design* (#582). There is
  no `api` surface to run `authorize()` against a pod's ACL hierarchy,
  and no pod the prefix belongs to: `/proxy` lives beside `/alice/…`,
  not inside it.
- So a pod owner **cannot** write `.acl` to govern their users' proxy
  access. The only knobs are operator-level config: `requireAuth` (any
  authenticated agent) and `allowHosts`. That is authentication, not
  authorization — there is no per-agent, per-mode, or payment-gated
  policy without reimplementing WAC inside the plugin (which would mean
  importing internals, which the rule forbids).
- A "each pod gets its own gated proxy at `/<pod>/proxy`" deployment —
  #382's option A — is doubly out of reach: the loader mounts one static
  prefix per entry, and anything mounted *inside* a pod's namespace would
  need the core router to carve it out of LDP handling.

Conclusion: #382 is right that per-pod proxy control is inherently a
**core concern**. The proxy mechanics (fetch, CORS, SSRF gates, caps)
port cleanly to a plugin; the *authorization story* does not, because the
plugin seam deliberately trades WAC integration for isolation. If the api
ever grows an `api.authorize(request, path, mode)` seam (the same gap the
notifications port hit via loopback WAC checks), this plugin could adopt
core's ACL gating verbatim.

### Smaller findings

- **#381 confirmed and avoidable**: the shared guard's DNS fail-open
  (empty A+AAAA → valid) is trivially fail-closed out here; nothing
  depended on the open behavior.
- **`.all()` + one prefix is enough** for a whole method surface
  including OPTIONS preflight — no new seam needed for plain HTTP
  plugins, confirming the webrtc port's experience.
- **Raw-body forwarding** again required the scoped
  pass-through content-type parser trick from `tunnel/` (relates to
  #583) — the third port to need it; a `api.rawBody`-style affordance
  keeps suggesting itself.
- **Path form survives routing**: `{prefix}/https://example.com/…`
  reaches the wildcard route intact on the host's Fastify (query string
  included); the plugin re-inflates a scheme separator collapsed by path
  normalization and accepts a percent-encoded form as well.

## License

AGPL-3.0-only, same as JSS — adapts the `src/handlers/cors-proxy.js`
design.
