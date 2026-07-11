# admin — a wp-admin-style operator home, and the measure of how far the api gets

One self-contained HTML page (plus `status.json`) that shows *everything about
a JSS deployment the plugin api lets an operator see*: the server (origin,
liveness, uptime, node, platform), every installed plugin (live loopback
probes, prefix links, per-plugin admin pages), the pods (count, disk usage,
newest activity) — composed on top of `dashboard/`'s probe machinery,
`metrics/`'s healthz idea, `nip05/`'s podsRoot scan, and `shortlink/`'s
`getAgent` auth.

**The point is the gap analysis.** The read side of wp-admin is mostly
expressible today — but every pillar of it rests on config that *repeats
something the host already knows*, and the entire write side (install,
enable/disable, settings, log viewing) is architecturally absent. The page
carries a "Not possible yet" strip naming each missing pillar and the seam
behind it; the table below is the same analysis in full.

## Usage

```js
import { createServer } from 'javascript-solid-server/src/server.js';

const PORT = 3240;
const PUBLIC_URL = 'https://pod.example';
const PODS = '/srv/jss/data/pods';

const fastify = createServer({
  root: PODS,
  idp: true,
  plugins: [
    { id: 'rss',     module: 'plugins/rss/plugin.js',     prefix: '/feed',
      config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'metrics', module: 'plugins/metrics/plugin.js', prefix: '/metrics',
      config: { loopbackUrl: `http://127.0.0.1:${PORT}` } },

    { id: 'admin', module: 'plugins/admin/plugin.js', prefix: '/admin',
      config: {                                     // all optional
        podsRoot: PODS,                             // → pod/storage stats
        // Who is an operator? The api has no answer, so this plugin invents
        // one: an agent-id allowlist. Omit it and the page serves OPEN
        // (loud warn at activate).
        adminAgents: ['https://pod.example/alice/profile/card.jsonld#me'],
        // The plugin list is auto-discovered via api.plugins (#610) — no
        // hand-copied inventory. `probes` only *refines* individual rows
        // (the roster carries no health hints):
        probes: {
          rss:     { probe: '/feed/atom', expect: [400], description: 'Atom/RSS feeds' },
          metrics: { probe: '/metrics/healthz', expect: [200], description: 'healthz + Prometheus', adminPage: '/metrics/metrics' },
        },
      } },
  ],
});
```

Or from the CLI — since admin needs no required config, it loads via
`--plugin` (open, no pod stats): `jss start --plugin ./admin/plugin.js@/admin`
alongside other plugins. Add `podsRoot`/`adminAgents` via a config file to
enable stats and gate it.

- `GET /admin/` — the page (server-side rendered from a live snapshot, so
  `curl` shows real content; an inline script re-polls every ~10s — when
  guarded, append `#token=<bearer>` to the URL so the poller can authenticate).
- `GET /admin/status.json` — the same snapshot as JSON. Probed live per
  request: anonymous loopback GETs, concurrent, ~3s timeout each, never
  cached. Probe semantics are `dashboard/`'s: `<500` = alive, `expect: [...]`
  narrows, `kind: 'ws'` accepts 400/404/426-style upgrade refusals as routed.
- Both surfaces are guarded by `adminAgents` when present: 401 anonymous,
  403 authenticated-but-not-listed, JSON errors either way.

### The page, in words

A single column, system font, four labeled sections plus a warning strip.
Header "server admin" with the origin and either "guarded: 1 admin agent" or
"OPEN: no adminAgents configured — anyone can read this page". **Server**: a
key/value table — base URL, host liveness as a green/red pill with the HTTP
status and loopback latency, process uptime ("3h 12m"), node version,
platform. **Plugins**: a table of *plugin | description | prefix | status |
http | latency | admin* — each prefix a link, each status a pill (green up /
amber degraded / red down / grey unprobed), and a "settings" link where the
entry declared an `adminPage`. **Pods / Users**: pod count, disk usage
("1.2 GB (1288490188 bytes, 4302 entries walked)", with a TRUNCATED note if
the 50k-entry walk cap hit), newest pod mtime. **Not possible yet**: an
amber strip listing the five wp-admin pillars this page can't have, each
with its seam. **Meta**: "3 declared — 2 up, 0 degraded, 0 down, 1 unprobed
· generated 2026-07-11T… · polls status.json every 10s". Dark-mode via
`prefers-color-scheme`; no external assets anywhere.

## Findings

The headline: **how much of a wp-admin/Nextcloud-style admin can the plugin
api express today?** Answer: most of the *read* side, none of the *write*
side. Two read pillars that used to lean on operator-repeated config now run
on **shipped seams** — the inventory on `api.plugins` (#610) and the origin on
`api.serverInfo` (#601) — so what's still re-declared is `podsRoot` and the
operator gate. Pillar by pillar:

| wp-admin pillar | what this plugin does today | the seam that would close the gap |
|---|---|---|
| **Plugin inventory** | ✅ auto-discovered via `api.plugins` (#610) — no hand-copied list, no drift | closed. The roster is `{ id, prefix, module }` with no health hints, so ws endpoints / odd prefixes still want a `config.probes` refinement; an optional per-entry `health`/`probe` hint would close that residual too |
| **Install / marketplace** | nothing — architecturally impossible; shown in the "not possible yet" strip | a package source + runtime install (#200 marketplace); would also need the loader to activate entries after boot |
| **Enable / disable** | nothing — the loader activates at boot only; `deactivate()` exists in the plugin contract but nothing calls it at runtime | runtime `activate()`/`deactivate()` on the loader, driven by an authorized surface |
| **Settings panels** | links to a per-plugin `adminPage` path the operator declares — each plugin hand-rolls its own page and this one merely points at it | a contribute-a-panel affordance (a plugin registers a settings fragment/route with the admin surface); today there is no gated hook or registration point for it |
| **Health / status** | ✅ the strongest pillar: host liveness + per-plugin anonymous loopback probes, live per request, `expect`/`ws` semantics from `dashboard/` | mostly closed already; per-plugin *self-reported* health (`health: () => …` on a registry entry) would beat anonymous probing |
| **Users / storage** | ✅ if the operator repeats `podsRoot`: pod count, du-style recursive size (capped at 50k entries, truncation reported, realpath'd root, symlinks never followed, contents never read), newest pod mtime | the api doesn't mediate any filesystem access — `podsRoot` re-declares what the host already knows; an `api.storage.stats()` / data-root accessor would do this honestly. (The origin repetition this used to share is gone — `api.serverInfo` shipped.) |
| **Log viewer** | nothing — `api.log` is write-only | an `api.log` tailing/reading seam (ring buffer or stream); until then "recent logs" can't exist on any plugin page |
| **Auth / roles** | invents an operator concept from scratch: `config.adminAgents`, an agent-id allowlist checked via `api.auth.getAgent`; without it the surface is OPEN behind a warn | an operator/role concept in the api. Today every ops plugin invents its own admin auth — `metrics/` a shared token, `terminal/` a token, this one an agent allowlist — three plugins, three incompatible answers to "who is an operator?" |

Beyond the table:

1. **"Who is an operator?" has no api answer** (the auth/roles row, sharpened).
   `getAgent` verifies *identity* perfectly across every credential scheme,
   but authorization is entirely the plugin's problem, and there is no
   host-level notion of "the server operator" to defer to — even though the
   host clearly has one (whoever writes `createServer`'s config). An
   `api.isOperator(agent)` (or an `operators: [...]` server option plugins
   can read) would let every ops surface in this repo share one answer.
2. **Pod stats are the last config-repetition standing.** The plugin can
   count users and measure storage *only because* the operator passed the same
   `root` path to both `createServer` and this plugin's config — the api
   mediates no storage introspection. This used to be one of *three* things
   the operator re-declared (origin, plugin list, data root); the first two
   shipped (`api.serverInfo`, `api.plugins`) and admin now consumes them, so
   the read side is down to this one. An `api.storage.stats()` / data-root
   accessor would close it.
3. **A guarded plugin page has no session story.** Core's UI has its own
   login; a plugin page can't ride it — the only credential a plugin can
   check is what arrives on the request, so the browser poller has to shuttle
   a bearer by hand (`#token=` in the URL fragment here; the fragment never
   leaves the browser, but it is still a token pasted into a URL bar). A
   contribute-a-panel seam would solve this for free, since panels would be
   served *inside* an already-authenticated core surface.
4. **The write side is absent by architecture, not by effort** — and that is
   the finding, not a TODO list. Install, enable/disable, and config editing
   all require the loader to act *after* boot; today the plugins array is
   consumed once by `createServer` and the only lifecycle event a plugin ever
   sees is its own `activate()`. Nothing on this page pretends otherwise: it
   has zero write operations, and the "not possible yet" strip names each
   absence with its seam (also exported as `NOT_POSSIBLE` from `plugin.js`
   so the list can't drift from the docs).
5. **Composition worked.** This plugin is `dashboard/`'s probes +
   `metrics/`'s healthz idea + `nip05/`'s podsRoot scan + `shortlink/`'s
   `getAgent` guard in one page, with no new primitive needed — evidence
   that the api's *read-side* vocabulary is genuinely composable. Two of the
   repeated-config findings it once carried are now closed (it consumes
   `api.plugins` and `api.serverInfo`); `podsRoot` and the operator gate
   remain.

## Test

```
node --test --test-concurrency=1 admin/test.js
```

Validation throws first (external probe URL, self-probe recursion — before
the long-lived boot; the `DATA_ROOT` footgun), then one JSS with admin + rss
+ metrics auto-discovered (no hand-fed list, no `loopbackUrl`), `podsRoot` at
the server root and
`adminAgents` set to a pod minted via `/.pods` + `/idp/credentials`:
anonymous → 401, second pod's bearer → 403, admin bearer → the full page
(plugin ids, server-side-rendered pods count, the not-possible strip) and
the `status.json` shape (rss up via `expect: [400]`, metrics up via
`[200]`, an unprobed self-entry, pod count 2, real byte totals, meta
counts), plus the no-caching property. The open-mode boot (no
`adminAgents`) runs LAST against a fresh server after the first is closed,
and asserts the page itself declares it is OPEN.
