// Plugin status dashboard, as a #206 loader plugin.
//
//   plugins: [{ module: 'dashboard/plugin.js', prefix: '/dashboard',
//               config: { loopbackUrl: 'http://127.0.0.1:3000',
//                         plugins: [{ id: 'rss', probe: '/feed/atom' }, …] } }]
//
//   GET /dashboard/            → self-contained HTML status page
//   GET /dashboard/status.json → live probe results as JSON
//
// THE POINT: a plugin cannot enumerate its co-loaded siblings — the api has
// no registry (no api.plugins, no api.serverInfo, nothing). So the operator
// must hand this dashboard a DUPLICATE of the very plugins list they already
// passed to createServer, and the two lists can silently drift. This plugin
// is the first live consumer of the #463/#464 app-registry seam — see
// README `## Findings`.
//
// Probes are anonymous liveness checks of public surfaces: they carry NO
// Authorization and go ONLY to loopbackUrl + a declared local path (never an
// external URL — enforced at activate). By default any status < 500 counts
// as alive: a 400/401/404 from a guard or a usage hint IS a living plugin
// answering. An `expect: [200, …]` list narrows that per probe. Probes run
// server-side, concurrently, with a per-probe timeout, and are NEVER cached:
// every request to /status.json probes live (O(N) loopback fetches — see
// README).
//
// kind: 'ws' is a documented simplification: a WebSocket endpoint is probed
// with a plain HTTP GET, and the upgrade-refusal statuses (400/426) count as
// "up". This proves the path is routed and answering, not that the socket
// handshake works — an honest ws probe would need a real upgrade (the 'ws'
// package is an allowed dep, but the HTTP probe keeps the plugin dep-free
// and the caveat is documented in the README findings).

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_REFRESH_MS = 5000;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export async function activate(api) {
  const prefix = api.prefix || '/dashboard';
  const loopback = (api.config.loopbackUrl || '').replace(/\/$/, '');
  if (!loopback) {
    throw new Error(
      'dashboard plugin requires config.loopbackUrl — the plugin api exposes '
      + 'no server origin (the api.serverInfo finding, again); point it at the '
      + 'host itself, e.g. http://127.0.0.1:3000',
    );
  }
  const timeoutMs = api.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMs = api.config.refreshMs ?? DEFAULT_REFRESH_MS;

  // ------------------------------------------------- validate declared list
  //
  // config.plugins is the operator's hand-copied registry (the finding).
  // Missing → [] and the dashboard still renders, with a note.

  const declared = api.config.plugins ?? [];
  if (!Array.isArray(declared)) {
    throw new Error('dashboard: config.plugins must be an array of { id, probe, expect?, kind? }');
  }
  const targets = declared.map((entry, i) => {
    const where = `dashboard: config.plugins[${i}]`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const { id, probe, expect, kind } = entry;
    if (typeof id !== 'string' || !id) throw new Error(`${where} needs a non-empty string id`);
    if (typeof probe !== 'string' || !probe.startsWith('/') || probe.includes('://')) {
      throw new Error(
        `${where}: probe must be a local path starting with '/' and containing no '://' `
        + `(probes only ever go to loopbackUrl) — got ${JSON.stringify(probe)}`,
      );
    }
    if (probe === prefix || probe.startsWith(`${prefix}/`)) {
      throw new Error(
        `${where}: probe ${JSON.stringify(probe)} targets the dashboard itself — `
        + 'probing /status.json from /status.json would recurse; point probes at other plugins',
      );
    }
    if (expect !== undefined
        && (!Array.isArray(expect) || expect.length === 0 || !expect.every(Number.isInteger))) {
      throw new Error(`${where}: expect must be a non-empty array of integer HTTP statuses`);
    }
    if (kind !== undefined && kind !== 'http' && kind !== 'ws') {
      throw new Error(`${where}: kind must be 'http' or 'ws'`);
    }
    return { id, probe, expect: expect ?? null, kind: kind ?? 'http' };
  });

  // ------------------------------------------------------------- the probes

  /** One anonymous loopback GET → { status: number|null, latency_ms }. */
  async function hit(path) {
    const started = performance.now();
    let status = null;
    try {
      const res = await fetch(loopback + path, {
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
    // ws simplification: 400/426 are exactly what an upgrade-requiring
    // endpoint says to a plain GET — that IS the healthy answer.
    if (target.kind === 'ws' && (status === 400 || status === 426)) return 'up';
    return 'degraded'; // alive — a guard answered 4xx — but not plainly 2xx/3xx
  }

  /** Probe the host and every declared plugin, concurrently, uncached. */
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
  // rendered server-side from the declared list so the page is readable
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
${targets.length === 0 ? `  <p class="note">No plugins declared. Pass <code>config.plugins</code>
  (an array of <code>{ id, probe, expect?, kind? }</code>) to this dashboard's
  entry — the plugin api has no registry, so the dashboard cannot discover its
  co-loaded siblings on its own (see the README findings, issues #463/#464).</p>
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
    `dashboard: ${targets.length} declared plugin(s) at ${prefix}/ `
    + `(hand-copied list — no api.plugins registry to read; #463/#464)`,
  );
  // Stateless — nothing to tear down (probes are per-request, the refresh
  // timer lives in the client page).
}
