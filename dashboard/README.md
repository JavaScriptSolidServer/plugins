# dashboard — plugin status page with live liveness probes

One HTML page (plus a JSON API) showing every plugin the operator declared,
each probed live over loopback on every request. It is deliberately the
simplest possible ops surface — and deliberately the first live consumer of
the **#463/#464 app-registry seam**: the api gives a plugin no way to see
its co-loaded siblings, so the operator must hand this dashboard a *copy* of
the very plugins list they already passed to `createServer`.

## Usage

```js
import { createServer } from 'javascript-solid-server/src/server.js';

const PORT = 3240;
const fastify = createServer({
  root: './data/pods',
  plugins: [
    { id: 'relay',      module: 'plugins/relay/plugin.js',      prefix: '/relay' },
    { id: 'capability', module: 'plugins/capability/plugin.js', prefix: '/cap', config: {} },
    { id: 'rss',        module: 'plugins/rss/plugin.js',        prefix: '/feed',
      config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'mastodon',   module: 'plugins/mastodon/plugin.js',   prefix: '/mastodon',
      config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },

    { id: 'dashboard', module: 'plugins/dashboard/plugin.js', prefix: '/dashboard',
      config: {
        loopbackUrl: `http://127.0.0.1:${PORT}`,
        // A HAND-COPIED duplicate of the list above — the api has no
        // registry a plugin could read (#463/#464). Keep them in sync
        // yourself; nothing will tell you when they drift.
        plugins: [
          { id: 'relay',      probe: '/relay', kind: 'ws' },
          { id: 'capability', probe: '/cap/issue' },
          { id: 'rss',        probe: '/feed/atom' },
          { id: 'mastodon',   probe: '/api/v1/instance', expect: [200] },
        ],
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

Each `config.plugins` entry is `{ id, probe, expect?, kind? }`:

- `probe` — a **local path** on this server. It must start with `/`, must
  not contain `://`, and must not point back at the dashboard itself
  (recursion); all three are enforced with a throw at `activate`. Probes go
  **only** to `loopbackUrl + probe`, never to external URLs.
- Probes carry **no Authorization** — they are anonymous liveness checks of
  public surfaces. By default any status **< 500 counts as alive**: a
  400/401/404 from a guard is a living plugin answering. `expect: [200]`
  (a status allowlist) narrows that per probe.
- `kind: 'ws'` — see finding 3 below: WebSocket endpoints are probed with a
  plain HTTP GET; upgrade-refusal statuses (400/426) count as *up*.
- States: **up** (2xx/3xx, or a matched `expect`), **degraded** (answered
  4xx — alive, but guarded/not plainly OK), **down** (no answer, timeout,
  5xx, or an `expect` mismatch). `alive` = not down.
- Probes run server-side on **every** `status.json` request, concurrently
  (`Promise.all`), each with a ~3s timeout (`AbortSignal.timeout`,
  `config.timeoutMs`), **never cached** — so each page refresh costs O(N)
  loopback fetches. Fine for a human-refresh dashboard; put a poller with
  its own cadence in front if you want to hammer it.
- The host itself is probed too (`GET /`, any non-5xx counts).
- No `config.plugins` → an empty dashboard that still renders, with a note
  explaining why it can't populate itself.

### The page, in words

A single narrow column, system font, honest table. Header "plugin
dashboard", a muted meta line ("probed 2026-07-11T… — live, uncached,
anonymous loopback probes every 5s"). Then one table: **plugin | probe |
status | http | latency**. First row is the server itself, then one row per
declared plugin: the id, the probe path in `code` (ws probes tagged with a
small `ws` chip), a pill badge — green **up**, amber **degraded**, red
**down** — the HTTP status ("—" when nothing answered), and "3 ms" in
tabular numerals. Everything inline: no external assets, no framework, one
small script that re-fetches `status.json` every `refreshMs` (default 5s)
and rewrites the cells. Dark-mode via `prefers-color-scheme`. Without JS
you still get the declared list (statuses stay "…"), so `curl` shows the
inventory.

## What maps / what doesn't

| capability | status |
|---|---|
| list every installed plugin | ✅ but only from a hand-copied `config.plugins` (the finding) |
| live liveness per plugin | ✅ anonymous loopback GET, <500 = alive, `expect` to sharpen |
| host self-check | ✅ `GET /` non-5xx |
| ws endpoint health | ⚠️ plain-HTTP approximation only (finding 3) |
| auto-discovery of siblings | ❌ no `api.plugins` — impossible today (#463/#464) |
| deep health (deps, storage, queue lag) | ❌ out of scope; probes are surface liveness only |

## Findings

1. **A plugin cannot enumerate its co-loaded plugins — the #463/#464
   app-registry seam, first live consumer.** The `api` object carries no
   registry: no `api.plugins`, no `api.serverInfo`, nothing that says "these
   entries were passed to `createServer` alongside you". So the one plugin
   whose entire job is *describing the deployment* must be handed a
   **duplicate** of the operator's own plugins list in `config.plugins` —
   and the two lists drift silently: add a plugin to `createServer` and
   forget the dashboard, and the dashboard simply doesn't show it; remove
   one and the dashboard cheerfully probes a path that now 401s/404s, which
   the default rule calls *alive* (see finding 4 — on this host a missing
   route and a guarded one are anonymously indistinguishable). Nothing can
   detect the drift from inside. The seam this proves the need for:
   `api.plugins` → `[{ id, prefix, module }]` (read-only, the loader already
   holds exactly this), ideally with an optional operator/plugin-supplied
   hint like `probe: '/feed/atom'` or `health: () => …` per entry — which is
   also precisely the "surface installed plugins as Solid resources" ask of
   #463/#464: this dashboard is what the consumer of that resource looks
   like, built today at the cost of a hand-maintained shadow copy.
2. **`api.serverInfo` again.** The dashboard needs the host's own origin to
   probe it (`loopbackUrl`), and throws at `activate` when it's missing —
   the same origin the operator has already told `createServer` (port) and
   a dozen sibling plugins (`baseUrl`/`loopbackUrl` in nearly every entry in
   `serve.js`). This is the ~13th consumer of the `api.serverInfo` finding;
   the repetition is now itself dashboard-visible, since the operator types
   the same `http://127.0.0.1:PORT` string into yet another config block.
3. **WebSocket endpoints can't be truthfully probed over plain HTTP — the
   `kind: 'ws'` simplification.** A ws endpoint's healthy answer to a plain
   GET is *refusal*. We accept 400/426 (upgrade-required) as *up* — but this
   host's upgrade stack registers no plain-GET route at all for `ws.route`
   paths, so `GET /relay` actually draws a **404**, indistinguishable from
   "no such plugin" (it lands as *degraded*, honest but mushy). An honest ws
   probe needs a real upgrade handshake — buildable here since `ws` is an
   allowed repo dep, but it drags in a dep and connection lifecycle for a
   liveness ping, so we documented the approximation instead. Which seam?
   None cleanly: it's a corollary of the registry gap — if `api.plugins`
   existed, entries could carry `kind`/liveness hints from the plugins
   themselves (relay *knows* it's a socket; `api.ws.route` could register a
   conventional HTTP `GET → 426` on the same path for free, which would
   also make this dashboard's 400/426 rule land as designed).
4. **Anonymous probes can't tell "guarded" from "missing".** On this host,
   an unknown path (`/ghost/health`) draws **401**, not 404 — WAC answers
   before routing — and a POST-only route answers GET with 404. So every
   anonymous 4xx means only "the server routed and answered", and the
   default <500-is-alive rule is exactly as strong as that statement, no
   stronger. `expect: [200]` is the operator's tool for surfaces that should
   answer anonymously (that's how the test demonstrates *down*). A
   per-probe `Authorization` was deliberately not added: a dashboard config
   holding live bearer tokens is a worse failure mode than a mushy probe.
5. **Self-probe recursion.** `status.json` runs probes; a probe pointed at
   `status.json` would recurse — each probe fans out N more probes until
   the timeouts cascade. Declaring a probe under the dashboard's own prefix
   is therefore rejected at `activate`. Trivial, but it's the kind of
   footgun a real `api.plugins` registry would have to consider too (a
   registry-driven dashboard would find *itself* in the list).

## Test

```
node --test --test-concurrency=1 dashboard/test.js
```

Boots one JSS carrying the dashboard plus three real siblings from this
repo (rss, capability, relay) and asserts the page, the JSON shape, the
alive/expect/down semantics, the no-cache property, the empty-list
fallback, and the pre-boot validation throws (ordered before the long-lived
boot — the `DATA_ROOT` footgun).
