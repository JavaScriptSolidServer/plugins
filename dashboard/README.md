# dashboard — plugin status page with live liveness probes

One HTML page (plus a JSON API) showing every plugin loaded on the server,
each probed live over loopback on every request. It is deliberately the
simplest possible ops surface — and it is the **first live consumer of two
shipped plugin-API seams**: it auto-discovers its co-loaded siblings from
`api.plugins` (#610) and reaches the host over loopback via `api.serverInfo`
(#601), both landed in JSS **0.0.218**. This plugin drove the need for both
seams and now runs on them — no hand-maintained list, no origin in config.

## Usage

```js
import { createServer } from 'javascript-solid-server/src/server.js';

const fastify = createServer({
  root: './data/pods',
  plugins: [
    { id: 'relay',      module: 'plugins/relay/plugin.js',      prefix: '/relay' },
    { id: 'capability', module: 'plugins/capability/plugin.js', prefix: '/cap' },
    { id: 'rss',        module: 'plugins/rss/plugin.js',        prefix: '/feed',
      config: { baseUrl: PUBLIC_URL } },

    // No plugins list, no loopbackUrl — the dashboard discovers everything
    // above via api.plugins and finds the host via api.serverInfo. The only
    // config is optional per-plugin probe *refinement*:
    { id: 'dashboard', module: 'plugins/dashboard/plugin.js', prefix: '/dashboard',
      config: {
        probes: {
          relay: { kind: 'ws' },                   // a WebSocket endpoint
          rss:   { probe: '/feed/atom' },          // a better liveness path than bare /feed
          // capability: { expect: [200] },        // declare a stricter "up"
        },
      } },
  ],
});
```

- `GET /dashboard/` — the page.
- `GET /dashboard/status.json` — the same data as JSON:

```json
{
  "generated": "2026-07-11T12:00:00.000Z",
  "server":  { "alive": true, "status": 200, "latency_ms": 2 },
  "plugins": [
    { "id": "rss", "probe": "/feed/atom", "kind": "http",
      "alive": true, "state": "degraded", "status": 400, "latency_ms": 3 }
  ]
}
```

### Probe semantics

The plugin **list** comes from `api.plugins` — you don't supply it. Each
discovered plugin is probed at its own `prefix` by default; `config.probes`
optionally refines a single plugin's probe as `{ probe?, expect?, kind? }`:

- `probe` — a **local path** on this server, overriding the default (the
  plugin's prefix). It must start with `/`, must not contain `://`, and must
  not point back at the dashboard itself (recursion); all three are enforced
  with a throw at `activate`. Probes go **only** to the host's own loopback
  origin, never to external URLs.
- Probes carry **no Authorization** — anonymous liveness checks of public
  surfaces. By default any status **< 500 counts as alive**: a 400/401/404
  from a guard is a living plugin answering. `expect: [200]` narrows that.
- `kind: 'ws'` — a WebSocket endpoint; an upgrade-refusal (400/426) to the
  plain-HTTP probe counts as *up* (see finding 3).
- States: **up** (2xx/3xx or a matched `expect`), **degraded** (a 4xx —
  alive but guarded), **down** (no answer, timeout, 5xx, or `expect`
  mismatch). `alive` = not down.
- Probes run server-side on **every** `status.json` request, concurrently,
  each with a ~3s timeout (`config.timeoutMs`), **never cached** — O(N)
  loopback fetches per refresh. The host itself is probed too (`GET /`).
- If the dashboard is the only plugin loaded, the page renders with a note
  explaining there are no siblings to show.

### The page, in words

A single narrow column, system font, honest table: **plugin | probe |
status | http | latency**. First row is the server itself, then one row per
discovered plugin — id, probe path in `code` (ws probes tagged with a small
`ws` chip), a pill badge (green **up**, amber **degraded**, red **down**),
the HTTP status ("—" when nothing answered), latency in tabular numerals.
Everything inline: no external assets, one small script that re-fetches
`status.json` every `refreshMs` (default 5s). Dark-mode via
`prefers-color-scheme`. Without JS you still get the discovered list, so
`curl` shows the inventory.

## What maps / what doesn't

| capability | status |
|---|---|
| list every loaded plugin | ✅ auto-discovered from `api.plugins` (#610) — no hand-copied list |
| find the host to probe it | ✅ `api.serverInfo` (#601) — no `loopbackUrl` in config |
| live liveness per plugin | ✅ anonymous loopback GET, <500 = alive, `expect` to sharpen |
| host self-check | ✅ `GET /` non-5xx |
| meaningful per-plugin probe | ⚠️ default = the plugin's prefix; refine via `config.probes` (finding 1) |
| ws endpoint health | ⚠️ plain-HTTP approximation only (finding 3) |
| deep health (deps, storage, queue lag) | ❌ out of scope; surface liveness only |

## Findings

1. **`api.plugins` shipped — and this is what it unlocked (with a residual).**
   This plugin was the proof-of-need for the app-registry seam (#463/#464 →
   filed #610 → merged #612, JSS 0.0.218), and it now consumes it: the
   hand-copied `config.plugins` array is **gone**, and drift is impossible —
   add or remove a plugin and the dashboard reflects it with zero config
   change. The residual, now sharpened: the roster is `{ id, prefix, module }`
   with **no health hints**, so the dashboard defaults to probing each
   plugin's prefix and still needs `config.probes` to characterise the ones a
   bare-prefix hit doesn't (ws endpoints; a plugin whose prefix 404s but a
   sub-path answers). That is exactly the *optional per-entry `probe`/`health`
   hint* anticipated in the #610 sketch — the remaining, smaller ask.
2. **`api.serverInfo` shipped — origin repetition gone.** The dashboard used
   to require `loopbackUrl` and throw without it; now it calls
   `api.serverInfo()` (#601, 0.0.218) per request and builds the callable
   `host:port` itself. One timing note that makes serverInfo's function
   shape (not a snapshot) matter: the origin is resolved **at request time**,
   not cached at `activate` — a probe-time port-0 boot only knows its real
   port once listening, which is precisely the case serverInfo() handles.
3. **WebSocket endpoints still can't be truthfully probed over plain HTTP —
   the `kind: 'ws'` refinement.** A ws endpoint's healthy answer to a plain
   GET is *refusal*; we accept 400/426 as *up*. But this host's upgrade stack
   registers no plain-GET route for `ws.route` paths, so `GET /relay` draws a
   **404**, indistinguishable from "no such plugin" (lands as *degraded*).
   An honest ws probe needs a real handshake. This is now a corollary of
   finding 1's residual: if the roster carried a `kind`/health hint, the
   plugin itself (relay *knows* it's a socket) could supply it instead of the
   operator typing `{ kind: 'ws' }` — or `api.ws.route` could register a
   conventional `GET → 426` on the same path.
4. **Anonymous probes can't tell "guarded" from "missing".** On this host an
   unknown path draws **401** (WAC answers before routing), and a POST-only
   route answers GET with 404. So every anonymous 4xx means only "the server
   routed and answered", and the default <500-is-alive rule is exactly that
   strong. `expect: [200]` is the operator's tool for surfaces that should
   answer anonymously. A per-probe `Authorization` was deliberately not
   added: a dashboard config holding live bearer tokens is a worse failure
   mode than a mushy probe.
5. **Self-probe recursion.** The dashboard filters *itself* out of the
   roster (by matching its own prefix) so it never probes `status.json` —
   which would fan out N more probes until timeouts cascade. A `config.probes`
   refinement pointing under the dashboard's own prefix is also rejected at
   `activate`. Exactly the footgun the #610 sketch flags for any
   registry-driven consumer: it finds itself in the list.

## Test

```
node --test --test-concurrency=1 dashboard/test.js
```

Boots one JSS (≥ 0.0.218) carrying the dashboard plus three real siblings
(rss, capability, relay), with **no** hand-fed list and **no** loopbackUrl,
and asserts: auto-discovery names every sibling, the JSON shape, the
alive/expect/down semantics, the no-cache property, an empty-server render,
and the `config.probes` validation throws (ordered before the long-lived
boot — the `DATA_ROOT` footgun).
