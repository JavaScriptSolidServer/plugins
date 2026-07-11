// Plugin status dashboard, as a #206 loader plugin.
//
//   plugins: [{ module: 'dashboard/plugin.js', prefix: '/dashboard',
//               config: { probes: { relay: { kind: 'ws' } } } }]   // all optional
//
//   GET /dashboard/            → self-contained HTML status page
//   GET /dashboard/status.json → live probe results as JSON
//
// The dashboard AUTO-DISCOVERS every co-loaded plugin from `api.plugins`
// (#610) — a read-only, frozen roster of { id, prefix, module } the loader
// exposes — so there is no hand-maintained list to drift when a plugin is
// added or removed. It reaches the host over loopback via `api.serverInfo()`
// (#601), resolved per request, so no `loopbackUrl` need be configured
// either. (Earlier this plugin required both a hand-copied `config.plugins`
// array and `config.loopbackUrl`; both were the workarounds those two seams
// removed — see README "Findings".)
//
// Probes are anonymous liveness checks of public surfaces: they carry NO
// Authorization and go ONLY to the host's own loopback origin. By default
// each plugin is probed at its OWN prefix and any status < 500 counts as
// alive — a 400/401/404 from a guard is a living plugin answering. The
// roster carries no health hints, so `config.probes` optionally refines a
// per-plugin probe: `{ <id>: { probe?, expect?, kind? } }` — a different
// path, an `expect: [200,…]` allowlist, or `kind: 'ws'` (a WebSocket
// endpoint, where a 400/426 upgrade-refusal to a plain GET counts as up).
// Probes run server-side, concurrently, with a per-probe timeout, and are
// NEVER cached: every request re-probes (O(N) loopback fetches).

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_REFRESH_MS = 5000;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export async function activate(api) {
  const prefix = api.prefix || '/dashboard';
  const timeoutMs = api.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMs = api.config.refreshMs ?? DEFAULT_REFRESH_MS;

  // The callable loopback origin. Prefer an explicit override; otherwise ask
  // the host (api.serverInfo, #601) at REQUEST time — before listen the port
  // may be 0, and probes only ever run per request. Build host:port (the
  // live bind), not baseUrl, since baseUrl may be a public idpIssuer URL the
  // server can't call itself.
  function loopbackOrigin() {
    if (api.config.loopbackUrl) return String(api.config.loopbackUrl).replace(/\/$/, '');
    const { protocol, host, port } = api.serverInfo();
    const h = host.includes(':') ? `[${host}]` : host;
    return `${protocol}://${h}:${port}`;
  }

  // Optional per-plugin probe refinements: { <id>: { probe?, expect?, kind? } }.
  // Validated here so a refinement can never leave loopback or recurse into
  // the dashboard's own routes.
  const overrides = api.config.probes ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('dashboard: config.probes must be an object keyed by plugin id');
  }
  for (const [id, ov] of Object.entries(overrides)) {
    const where = `dashboard: probes[${JSON.stringify(id)}]`;
    if (!ov || typeof ov !== 'object') throw new Error(`${where} must be an object`);
    if (ov.probe !== undefined) {
      if (typeof ov.probe !== 'string' || !ov.probe.startsWith('/') || ov.probe.includes('://')) {
        throw new Error(`${where}.probe must be a local path starting with '/' and containing no '://' — got ${JSON.stringify(ov.probe)}`);
      }
      if (ov.probe === prefix || ov.probe.startsWith(`${prefix}/`)) {
        throw new Error(`${where}.probe ${JSON.stringify(ov.probe)} targets the dashboard itself — would recurse`);
      }
    }
    if (ov.expect !== undefined
        && (!Array.isArray(ov.expect) || ov.expect.length === 0 || !ov.expect.every(Number.isInteger))) {
      throw new Error(`${where}.expect must be a non-empty array of integer HTTP statuses`);
    }
    if (ov.kind !== undefined && ov.kind !== 'http' && ov.kind !== 'ws') {
      throw new Error(`${where}.kind must be 'http' or 'ws'`);
    }
  }

  // The targets: every loaded plugin EXCEPT this dashboard (identified by its
  // own prefix), auto-discovered from api.plugins. Default probe = the
  // plugin's own prefix; an override wins. A plugin with neither a prefix nor
  // an override probe can't be health-checked, so it's skipped.
  const targets = api.plugins
    .filter((p) => p.id && p.prefix !== prefix)
    .map((p) => {
      const ov = overrides[p.id] ?? {};
      return {
        id: p.id,
        probe: ov.probe ?? (p.prefix || null),
        expect: ov.expect ?? null,
        kind: ov.kind ?? 'http',
      };
    })
    .filter((t) => t.probe);

  // ------------------------------------------------------------- the probes

  /** One anonymous loopback GET → { status: number|null, latency_ms }. */
  async function hit(path) {
    const started = performance.now();
    let status = null;
    try {
      const res = await fetch(loopbackOrigin() + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: '*/*' }, // deliberately NO authorization
      });
      status = res.status;
      try { await res.body?.cancel(); } catch { /* drained */ }
    } catch { /* timeout / refused / DNS → status stays null */ }
    return { status, latency_ms: Math.round(performance.now() - started) };
  }

  /** up | degraded | down for one target's probe result. */
  function classify(target, status) {
    if (status === null || status >= 500) return 'down'; // no answer, or the server erred
    if (target.expect) return target.expect.includes(status) ? 'up' : 'down';
    if (status < 400) return 'up';
    // ws refinement: 400/426 are exactly what an upgrade-requiring endpoint
    // says to a plain GET — that IS the healthy answer.
    if (target.kind === 'ws' && (status === 400 || status === 426)) return 'up';
    return 'degraded'; // alive — a guard answered 4xx — but not plainly 2xx/3xx
  }

  /** Probe the host and every discovered plugin, concurrently, uncached. */
  async function snapshot() {
    const [host, ...results] = await Promise.all([
      hit('/'), // the host itself: any non-5xx answer is a living server
      ...targets.map((t) => hit(t.probe)),
    ]);
    return {
      generated: new Date().toISOString(),
      server: {
        alive: host.status !== null && host.status < 500,
        status: host.status,
        latency_ms: host.latency_ms,
      },
      plugins: targets.map((t, i) => {
        const { status, latency_ms } = results[i];
        const state = classify(t, status);
        return {
          id: t.id,
          probe: t.probe,
          kind: t.kind,
          ...(t.expect ? { expect: t.expect } : {}),
          alive: state !== 'down',
          state,
          status,
          latency_ms,
        };
      }),
    };
  }

  // --------------------------------------------------------------- the page
  //
  // Self-contained: inline CSS, no external assets, no frameworks; one small
  // inline script polls status.json and rewrites the table cells. Rows are
  // rendered server-side from the discovered list so the page is readable
  // without JS (and testable with curl). Dark-mode via prefers-color-scheme.

  const row = (rid, id, probe, kind) => `
      <tr id="${rid}">
        <td class="id">${esc(id)}</td>
        <td class="probe"><code>${esc(probe)}</code>${kind === 'ws' ? ' <span class="kind">ws</span>' : ''}</td>
        <td><span class="state badge">…</span></td>
        <td class="code">…</td>
        <td class="latency">…</td>
      </tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>plugin dashboard</title>
<style>
  :root { color-scheme: light dark;
    --fg: #1a1a1a; --bg: #ffffff; --muted: #666; --line: #ddd;
    --up: #1a7f37; --up-bg: #e6f4ea; --deg: #7a5d00; --deg-bg: #fdf3d0;
    --down: #b3261e; --down-bg: #fbe9e7; }
  @media (prefers-color-scheme: dark) { :root {
    --fg: #e6e6e6; --bg: #121212; --muted: #999; --line: #333;
    --up: #6fdb8b; --up-bg: #10331a; --deg: #e8c96a; --deg-bg: #33290d;
    --down: #ff8a80; --down-bg: #38120f; } }
  body { margin: 2rem auto; max-width: 46rem; padding: 0 1rem;
    font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  #meta { color: var(--muted); font-size: .85rem; margin: 0 0 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line); }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  code { font-size: .9em; }
  .kind { font-size: .7rem; color: var(--muted); border: 1px solid var(--line);
    border-radius: 3px; padding: 0 .3em; vertical-align: middle; }
  .badge { display: inline-block; min-width: 4.5em; text-align: center;
    border-radius: 999px; padding: .05em .6em; font-size: .85em; }
  .badge.up { color: var(--up); background: var(--up-bg); }
  .badge.degraded { color: var(--deg); background: var(--deg-bg); }
  .badge.down { color: var(--down); background: var(--down-bg); }
  .latency, .code { font-variant-numeric: tabular-nums; }
  .note { color: var(--muted); font-size: .9rem; }
</style>
</head>
<body>
  <h1>plugin dashboard</h1>
  <p id="meta">probing ${targets.length} plugin${targets.length === 1 ? '' : 's'} over loopback…</p>
  <table>
    <thead><tr><th>plugin</th><th>probe</th><th>status</th><th>http</th><th>latency</th></tr></thead>
    <tbody>
${row('row-server', 'server', '/', 'http')}${targets.map((t, i) => row(`row-${i}`, t.id, t.probe, t.kind)).join('')}
    </tbody>
  </table>
${targets.length === 0 ? `  <p class="note">No other plugins are loaded. This dashboard
  auto-discovers its co-loaded siblings via <code>api.plugins</code> (#610); load
  another plugin and it appears here — no hand-maintained list to drift.</p>
` : ''}  <script>
    (function () {
      var url = ${JSON.stringify(`${prefix}/status.json`)};
      function set(rowEl, state, status, latency) {
        var b = rowEl.querySelector('.state');
        b.textContent = state;
        b.className = 'state badge ' + state;
        rowEl.querySelector('.code').textContent = (status === null || status === undefined) ? '—' : status;
        rowEl.querySelector('.latency').textContent = latency + ' ms';
      }
      async function tick() {
        var meta = document.getElementById('meta');
        try {
          var res = await fetch(url, { cache: 'no-store' });
          var data = await res.json();
          set(document.getElementById('row-server'),
              data.server.alive ? 'up' : 'down', data.server.status, data.server.latency_ms);
          data.plugins.forEach(function (p, i) {
            var rowEl = document.getElementById('row-' + i);
            if (rowEl) set(rowEl, p.state, p.status, p.latency_ms);
          });
          meta.textContent = 'probed ' + data.generated
            + ' — live, uncached, anonymous loopback probes every ' + ${JSON.stringify(refreshMs)} / 1000 + 's';
        } catch (err) {
          meta.textContent = 'status fetch failed: ' + err;
        }
      }
      tick();
      setInterval(tick, ${JSON.stringify(refreshMs)});
    })();
  </script>
</body>
</html>
`;

  // ----------------------------------------------------------------- routes

  const servePage = (request, reply) => reply
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(html);

  api.fastify.get(`${prefix}/`, servePage);
  api.fastify.get(prefix, servePage);
  api.fastify.get(`${prefix}/status.json`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return snapshot();
  });

  api.log.info(
    `dashboard: ${targets.length} plugin(s) at ${prefix}/ `
    + `(auto-discovered via api.plugins; loopback via api.serverInfo)`,
  );
  // Stateless — nothing to tear down (probes are per-request, the refresh
  // timer lives in the client page).
}
