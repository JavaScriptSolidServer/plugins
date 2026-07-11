# metrics — healthz + Prometheus exporter

Ops observability for a JSS deployment, from node builtins only: a
liveness/readiness endpoint (`/healthz`) and a Prometheus text-format
exporter (`/metrics`). No dependencies, no internals — the exposition
format is hand-rolled (`# HELP`/`# TYPE` + `name{labels} value` is all
there is to it).

## Usage

```js
import { createServer } from 'javascript-solid-server/src/server.js';

const fastify = createServer({
  root: './data',
  plugins: [{
    id: 'metrics',
    module: './plugins/metrics/plugin.js',
    prefix: '/metrics',
    config: {
      loopbackUrl: 'http://127.0.0.1:3000', // optional: adds a front-door check to healthz
      token: 'long-random-string',          // optional: Bearer-guards /metrics/metrics
    },
  }],
});
await fastify.listen({ port: 3000 });
```

**Both config keys are optional** — a deliberate contrast with the plugins
that `throw` on missing config. Without `loopbackUrl` the plugin degrades
gracefully: `/healthz` still answers 200 and reports process liveness, it
just can't vouch for the host's HTTP pipeline. (With `api.serverInfo` the
knob would disappear entirely — the plugin would always know where its own
host lives. See Findings.)

```console
$ curl -s http://localhost:3000/metrics/healthz | jq
{
  "status": "ok",
  "uptime_seconds": 42.1,
  "checks": {
    "process": { "ok": true, "pid": 12345 },
    "loopback": { "ok": true, "status": 200 }
  }
}

$ curl -s -H 'Authorization: Bearer long-random-string' http://localhost:3000/metrics/metrics
# HELP process_uptime_seconds Node.js process uptime in seconds.
# TYPE process_uptime_seconds gauge
process_uptime_seconds 42.1
...
jss_plugin_http_requests_total{method="GET",route="/metrics/healthz",status="200"} 3
```

Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: jss
    metrics_path: /metrics/metrics
    authorization:
      type: Bearer
      credentials: long-random-string
    static_configs:
      - targets: ['localhost:3000']
```

### Endpoints

| route | auth | behavior |
|---|---|---|
| `GET <prefix>/healthz` | always open | `{ status, uptime_seconds, checks }`. With `loopbackUrl`: HEAD-probes the host's `/` over loopback (any non-5xx counts as alive — 401/403/404 are policy, not sickness; no credentials forwarded). Probe failure → `status: "degraded"` + HTTP 503, so it works directly as a k8s readinessProbe / LB health check. |
| `GET <prefix>/metrics` | Bearer iff `config.token` | `text/plain; version=0.0.4` exposition. Token compared constant-time (`timingSafeEqual` over sha256 digests). healthz stays open even with a token set — orchestrators can't send headers easily; scrapers can. |

### Metrics exposed

- `process_uptime_seconds`, `process_resident_memory_bytes`,
  `process_heap_used_bytes`, `process_heap_total_bytes` (gauges,
  `process.memoryUsage()`)
- `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total`
  (counters, `process.cpuUsage()`)
- `nodejs_eventloop_lag_seconds` (gauge — `perf_hooks.monitorEventLoopDelay`
  mean since the previous scrape, reset per scrape; the sampler is disabled
  in `deactivate` so the process exits cleanly)
- `jss_plugin_http_requests_total{method,route,status}` and
  `jss_plugin_http_request_duration_seconds` (summary: `_sum`/`_count`) —
  counted via an `onResponse` hook on `api.fastify`. **Scope: every route
  registered by any plugin in the loader — not core's routes.** The metric
  names say `jss_plugin_`, not `jss_http_`, because that is what they
  honestly are (the headline finding below). The `route` label is the
  registered route pattern, not the raw URL, and a `MAX_SERIES` cap lumps
  overflow into `route="_other"`, so cardinality stays bounded.

## What maps / what doesn't

| aspect | status |
|---|---|
| liveness/readiness JSON | ✅ trivially, plugin-owned route |
| host front-door check | ✅ loopback HEAD (the notifications/ pattern, minus auth forwarding) |
| process/runtime metrics | ✅ all from node builtins |
| per-request metrics for **plugin** routes (all plugins) | ✅ `onResponse` hook on `api.fastify` — measured, see Findings |
| per-request metrics for **core** routes (LDP, idp, `.well-known`) | ❌ invisible to plugin hooks — a whole-server exporter is not buildable out-of-tree today |
| LDP-level metrics (pod count, storage bytes, quota) | ❌ no api surface at all (no data-root access, no storage events) — not attempted |

## Findings

1. **Hook scope on `api.fastify` — measured, and it's "all plugins, no
   core".** The experiment this plugin exists for: an
   `addHook('onResponse')` on the loader's scoped Fastify instance fires
   for **(a) this plugin's routes — yes; (b) every OTHER plugin's routes —
   yes, regardless of entry order; (c) core routes — never** (the UI root
   `/`, LDP pod paths, `/.well-known/*` produce no counter series;
   `test.js` asserts all three). Cause, from reading the loader:
   `loadPlugins(instance, entries, …)` activates **all** entries against
   **one shared `fastify.register` scope**, while core's routes live on the
   parent instance, which Fastify encapsulation shields from child-scope
   hooks. Two consequences for the NOTES.md #8 / #564 discussion:
   - The core/plugin line **holds against core**: a plugin cannot observe
     (or modify — `onRequest`/`preHandler`/`onSend` have the same scope)
     the request pipeline of routes core owns. Pipeline-touching features
     stay core, as #564 concluded.
   - But plugins are **not isolated from each other**: `api.fastify`
     already grants every plugin observation *and interception* of every
     other plugin's routes, with no capability gate. Today that's how this
     exporter sees its neighbors' traffic (useful!); it also means a
     hypothetical `capabilities: ['hooks']` design shouldn't imagine the
     status quo is per-plugin isolation — the existing grant is per-loader.
     If per-plugin encapsulation is ever wanted, the loader would need to
     `register` each entry in its own child scope (which would *break*
     this plugin's cross-plugin counters — the two goals pull opposite
     ways, worth deciding deliberately).
2. **Core bug: `logger: false` silently kills every plugin `onResponse`
   hook.** Core's access-log hook (`src/server.js`, the "Unified access
   log" `onResponse`) calls `request.log.isLevelEnabled('info')`. Booted
   with `logger: false`, Fastify's null logger has no `isLevelEnabled`, so
   the hook throws `TypeError` on every request — and a throwing
   `onResponse` hook aborts the rest of the chain, so plugin `onResponse`
   hooks downstream **never run** (earlier stages — `onRequest`,
   `preHandler`, `onSend` — are unaffected; measured). Symptom here: the
   request counters stay at zero on a logger-less boot; the fix in this
   repo's tests is `logger: true, logLevel: 'silent'` (JSS treats
   `options.logger` as a boolean and takes the level from
   `options.logLevel`). Filed-worthy one-line core fix: guard the call
   (`typeof request.log.isLevelEnabled === 'function'`). Note
   `helpers.js` boots `logger: false` by default, so any *other* plugin
   relying on `onResponse` would hit this in its tests too.
3. **No way to observe core's own request pipeline** (unless finding 1's
   scope surprises you the other way — it doesn't). Request/latency/error
   metrics for the pod itself — the numbers an operator most wants — are
   exactly the routes a plugin hook cannot see. This is the observability
   face of the gated-hooks seam (NOTES.md #8): a read-only
   `capabilities: ['observe']` (onResponse-only, no payload mutation) would
   be a much smaller grant than full pipeline hooks and would make this
   exporter a real whole-server exporter.
4. **`loopbackUrl` optional = graceful degradation** — the deliberate
   contrast with the ~10 plugins that `throw` for it. An ops plugin should
   never take the server down over a missing nicety, so absence just
   removes the check from `/healthz`. Same `api.serverInfo` seam as
   everywhere else (NOTES.md #3), but this plugin demonstrates the soft
   failure mode instead of the loud one.
5. **404s under a plugin's own prefix are invisible too**: an unmatched
   path like `<prefix>/typo` falls through to core's catch-all, which the
   hook can't see — so `jss_plugin_http_requests_total` has no 404 series
   for routes nobody registered. Scrape-side absence, not an error.
6. **Self-observation is included**: the exporter counts its own scrapes
   (and their 401s), which is normal Prometheus practice and turned out to
   be a free test fixture — the auth-refusal series proves refused requests
   still traverse `onResponse`.
