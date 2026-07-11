// admin — a WordPress-admin-style operator home for a JSS deployment, as a
// #206 loader plugin. The capstone: ONE page (plus a JSON API) that shows
// everything about the server and its installed plugins that the plugin api
// lets an operator SEE — and a "not possible yet" strip naming everything a
// wp-admin/Nextcloud-style admin would also DO, each with the seam that
// blocks it.
//
//   plugins: [{ id: 'admin', module: 'admin/plugin.js', prefix: '/admin',
//               config: {                                    // all optional
//                 podsRoot: '/srv/jss/data/pods',            // enables pod stats
//                 adminAgents: ['https://…/card.jsonld#me'], // gate the surface
//                 probes: { relay: { kind: 'ws' } },         // refine a plugin row
//               } }]
//
// The plugin list is auto-discovered (api.plugins, #610) and the origin comes
// from api.serverInfo (#601) — no hand-copied inventory, no loopbackUrl.
//
//   GET <prefix>/            → self-contained HTML admin page (server-side
//                              rendered from a live snapshot, then polled
//                              client-side every ~10s)
//   GET <prefix>/status.json → the same snapshot as JSON, probed live per
//                              request (concurrent, ~3s timeout each, no
//                              caching)
//
// THE POINT (the README headline): measure how much of wp-admin the plugin
// api can express today. The read side works — liveness, per-plugin probes,
// user/storage stats — and now runs on real seams: the plugin list is
// api.plugins (#610, auto-discovered, no drift), the origin is api.serverInfo
// (#601). What's still re-declared: podsRoot (the api mediates no data-root
// access) and the operator gate (adminAgents — no api.isOperator yet). The
// WRITE side is architecturally absent: no install (#200), no runtime
// enable/disable (boot-time loader; `deactivate()` exists but nothing calls
// it at runtime), no settings panels (no contribute-a-panel affordance — the
// `adminPage` link convention here is the workaround), no log viewer
// (api.log is write-only). Those absences are the finding, not TODOs.
//
// AUTH: if config.adminAgents (array of agent id strings) is present, BOTH
// the page and the JSON require a Bearer token that api.auth.getAgent
// resolves to a listed agent — 401 anonymous, 403 non-admin, JSON errors
// either way. If absent, the surface is served OPEN with a loud warn at
// activate. "Who is an operator?" has no api answer — every plugin invents
// its own (metrics: a shared token; terminal: a token; this one: an agent
// allowlist); see README findings.
//
// PROBES are dashboard/'s machinery verbatim in spirit: anonymous, loopback
// only, local paths validated at activate ('/' prefix, no '://', never under
// this plugin's own prefix — a probe of status.json from status.json would
// recurse). <500 is alive by default; `expect: [..]` narrows; kind: 'ws'
// accepts 400/426 (upgrade refusal IS the healthy answer to a plain GET).
//
// PODS WALK: if config.podsRoot is given (an absolute path), the pod count,
// total disk usage and newest-pod mtime are computed by a recursive stat
// walk. Containment: the root is fs.realpath'd once and symlinks are never
// followed below it, so the walk cannot escape podsRoot; the walk is capped
// (default 50k entries, truncation reported); only counts and sizes are
// read — never file contents, and nothing from the walk is served as data.

import fsp from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_REFRESH_MS = 10000;
const DEFAULT_MAX_WALK = 50000;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** 1234567 → "1.2 MB" (client script carries its own copy). */
function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i ? v.toFixed(1) : v} ${units[i]}`;
}

/** 93784.2 → "1d 2h 3m" (client script carries its own copy). */
function fmtDur(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '—';
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60); const sec = Math.floor(s % 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// What wp-admin has that this page architecturally can't do, each with the
// seam behind it. Rendered as the "not possible yet" strip and exported so
// the README/tests stay honest about the list.
export const NOT_POSSIBLE = [
  ['Install / marketplace', 'plugins arrive by editing the createServer config and rebooting; there is no runtime install, no package source, no marketplace (#200).'],
  ['Enable / disable', 'the loader activates plugins at boot only; deactivate() exists in the contract but nothing calls it at runtime — no toggle without a restart.'],
  ['Plugin settings panels', 'no contribute-a-panel affordance in the api; the adminPage link convention used on this page is the workaround (each plugin hand-rolls its own page and this one merely links to it).'],
  ['Log viewer', 'api.log is write-only — there is no tailing/reading seam, so "recent server logs" cannot be shown here at all.'],
  ['Gated by default', 'without config.adminAgents this page serves OPEN — the api has no operator concept, so an on-by-default admin can\'t be safely gated without one (the api.isOperator seam).'],
];

export async function activate(api) {
  const prefix = api.prefix || '/admin';
  const cfg = api.config || {};

  // The origin the admin page reaches the host on (loopback) and displays
  // (public) both come from api.serverInfo (#601) unless overridden — no more
  // loopbackUrl/baseUrl required in config. Resolved per request: with port 0
  // the real port exists only once the server is listening.
  function loopbackOrigin() {
    if (cfg.loopbackUrl) return String(cfg.loopbackUrl).replace(/\/$/, '');
    const { protocol, host, port } = api.serverInfo();
    const h = host.includes(':') ? `[${host}]` : host;
    return `${protocol}://${h}:${port}`;
  }
  function publicOrigin() {
    if (cfg.baseUrl) return String(cfg.baseUrl).replace(/\/$/, '');
    return api.serverInfo().baseUrl;
  }

  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMs = cfg.refreshMs ?? DEFAULT_REFRESH_MS;
  const maxWalk = cfg.maxWalkEntries ?? DEFAULT_MAX_WALK;

  // ----------------------------------------------------------- podsRoot
  const podsRoot = cfg.podsRoot ?? null;
  if (podsRoot !== null && (typeof podsRoot !== 'string' || !path.isAbsolute(podsRoot))) {
    throw new Error('admin: config.podsRoot must be an absolute path to the pods data root');
  }

  // -------------------------------------------------------- adminAgents
  const adminAgents = cfg.adminAgents ?? null;
  if (adminAgents !== null) {
    if (!Array.isArray(adminAgents) || adminAgents.length === 0
        || !adminAgents.every((a) => typeof a === 'string' && a)) {
      throw new Error(
        'admin: config.adminAgents must be a non-empty array of agent id '
        + 'strings (WebIDs / did:nostr) — an empty list would lock everyone '
        + 'out; omit the key entirely to serve the admin surface open',
      );
    }
  }

  // ------------------------------------------ discovered plugins + probes
  // The plugin list is api.plugins (#610) — auto-discovered, not hand-copied,
  // so it can't drift from the real createServer list. config.probes
  // optionally refines a single plugin's row by id:
  //   { <id>: { probe?, expect?, kind?, description?, adminPage? } }
  // Paths are validated so a refinement can't leave loopback or recurse into
  // this page. (The roster carries no health hints, so ws endpoints and odd
  // prefixes still want a refinement — same residual as dashboard/.)
  const overrides = cfg.probes ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('admin: config.probes must be an object keyed by plugin id');
  }
  const localPath = (where, key, value) => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('://')) {
      throw new Error(
        `${where}: ${key} must be a local path starting with '/' and containing no '://' `
        + `— got ${JSON.stringify(value)}`,
      );
    }
    return value;
  };
  for (const [id, ov] of Object.entries(overrides)) {
    const where = `admin: config.probes[${JSON.stringify(id)}]`;
    if (!ov || typeof ov !== 'object') throw new Error(`${where} must be an object`);
    if (ov.probe !== undefined) {
      localPath(where, 'probe', ov.probe);
      if (ov.probe === prefix || ov.probe.startsWith(`${prefix}/`)) {
        throw new Error(
          `${where}: probe ${JSON.stringify(ov.probe)} targets the admin page itself — `
          + 'probing status.json from status.json would recurse; point probes at other plugins',
        );
      }
    }
    if (ov.adminPage !== undefined) localPath(where, 'adminPage', ov.adminPage);
    if (ov.description !== undefined && typeof ov.description !== 'string') {
      throw new Error(`${where}: description must be a string`);
    }
    if (ov.expect !== undefined
        && (!Array.isArray(ov.expect) || ov.expect.length === 0 || !ov.expect.every(Number.isInteger))) {
      throw new Error(`${where}: expect must be a non-empty array of integer HTTP statuses`);
    }
    if (ov.kind !== undefined && ov.kind !== 'http' && ov.kind !== 'ws') {
      throw new Error(`${where}: kind must be 'http' or 'ws'`);
    }
  }
  // Every co-loaded plugin except this admin (identified by its own prefix);
  // default probe is the plugin's own prefix.
  const targets = api.plugins
    .filter((p) => p.id && p.prefix !== prefix)
    .map((p) => {
      const ov = overrides[p.id] ?? {};
      return {
        id: p.id,
        prefix: p.prefix || null,
        description: ov.description ?? '',
        probe: ov.probe ?? (p.prefix || null),
        expect: ov.expect ?? null,
        kind: ov.kind ?? 'http',
        adminPage: ov.adminPage ?? null,
      };
    });

  // ---------------------------------------------------------------- auth
  // Agent-allowlist guard (after shortlink/'s getAgent pattern). Applied to
  // BOTH the HTML page and the JSON API. There is no operator/role concept
  // in the api — this allowlist is one more plugin-invented answer to "who
  // is an operator?" (metrics invented a shared token, terminal a token,
  // this one an agent list). See README findings.
  async function requireAdmin(request, reply) {
    if (!adminAgents) return true;
    const agent = await api.auth.getAgent(request);
    if (!agent) {
      reply.code(401)
        .header('www-authenticate', 'Bearer realm="admin"')
        .send({ error: 'authentication required — this admin surface is restricted to config.adminAgents' });
      return false;
    }
    if (!adminAgents.includes(agent)) {
      reply.code(403).send({ error: `agent ${agent} is not an admin (not listed in config.adminAgents)` });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------- probes
  // dashboard/'s machinery: anonymous loopback GET, per-probe timeout.
  async function hit(p) {
    const started = performance.now();
    let status = null;
    try {
      const res = await fetch(loopbackOrigin() + p, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: '*/*' }, // deliberately NO authorization
      });
      status = res.status;
      try { await res.body?.cancel(); } catch { /* drained */ }
    } catch { /* timeout / refused → status stays null */ }
    return { status, latency_ms: Math.round(performance.now() - started) };
  }

  function classify(target, status) {
    if (status === null || status >= 500) return 'down';
    if (target.expect) return target.expect.includes(status) ? 'up' : 'down';
    if (status < 400) return 'up';
    if (target.kind === 'ws' && (status === 400 || status === 426)) return 'up';
    return 'degraded';
  }

  // ------------------------------------------------------------ pods walk
  /** Recursive stat walk under podsRoot — counts and sizes only, capped. */
  async function podStats() {
    if (!podsRoot) return null;
    let rootReal;
    try {
      rootReal = await fsp.realpath(podsRoot);
    } catch (err) {
      return { error: `cannot resolve podsRoot: ${err.message}` };
    }
    // Top level: pod directories are the non-dot dirs (dot dirs are the
    // host's own — .idp, the pluginDir guard, .well-known …).
    let count = 0;
    let newestMs = 0;
    try {
      for (const d of await fsp.readdir(rootReal, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        count += 1;
        try {
          const st = await fsp.stat(path.join(rootReal, d.name));
          if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
        } catch { /* raced away */ }
      }
    } catch (err) {
      return { error: `cannot read podsRoot: ${err.message}` };
    }
    // Full walk for disk usage. Symlinks are skipped entirely (never
    // followed — the containment guard), so the walk stays under rootReal.
    let entries = 0;
    let bytes = 0;
    let truncated = false;
    const stack = [rootReal];
    while (stack.length && !truncated) {
      const dir = stack.pop();
      let dirents;
      try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of dirents) {
        if (entries >= maxWalk) { truncated = true; break; }
        entries += 1;
        if (d.isSymbolicLink()) continue;
        const p = path.join(dir, d.name);
        if (d.isDirectory()) stack.push(p);
        else if (d.isFile()) {
          try { bytes += (await fsp.lstat(p)).size; } catch { /* raced away */ }
        }
      }
    }
    return {
      count,
      storageBytes: bytes,
      entriesWalked: entries,
      truncated,
      newestPodModified: newestMs ? new Date(newestMs).toISOString() : null,
    };
  }

  // ------------------------------------------------------------ snapshot
  const probed = targets.filter((t) => t.probe);
  async function snapshot() {
    const [host, pods, ...results] = await Promise.all([
      hit('/'), // host front door: any non-5xx answer is a living server
      podStats(),
      ...probed.map((t) => hit(t.probe)),
    ]);
    const byId = new Map(probed.map((t, i) => [t, results[i]]));
    const plugins = targets.map((t) => {
      const r = byId.get(t);
      const state = r ? classify(t, r.status) : 'unprobed';
      return {
        id: t.id,
        ...(t.prefix ? { prefix: t.prefix } : {}),
        ...(t.description ? { description: t.description } : {}),
        ...(t.probe ? { probe: t.probe } : {}),
        ...(t.expect ? { expect: t.expect } : {}),
        kind: t.kind,
        ...(t.adminPage ? { adminPage: t.adminPage } : {}),
        state,
        alive: state === 'up' || state === 'degraded',
        status: r ? r.status : null,
        latency_ms: r ? r.latency_ms : null,
      };
    });
    const tally = (s) => plugins.filter((p) => p.state === s).length;
    return {
      generated: new Date().toISOString(),
      server: {
        baseUrl: publicOrigin(),
        alive: host.status !== null && host.status < 500,
        status: host.status,
        latency_ms: host.latency_ms,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        uptime_seconds: Math.round(process.uptime()),
      },
      plugins,
      pods, // null when no podsRoot configured
      meta: {
        declared: plugins.length,
        up: tally('up'),
        degraded: tally('degraded'),
        down: tally('down'),
        unprobed: tally('unprobed'),
        guarded: !!adminAgents,
      },
    };
  }

  // ------------------------------------------------------------ the page
  // Self-contained (inline CSS, no external assets), dark-mode via
  // prefers-color-scheme, server-side rendered from a live snapshot so curl
  // shows real content; a small inline script re-polls status.json every
  // ~10s. When adminAgents guards the surface, the script needs the bearer
  // too — append `#token=<bearer>` to the URL (the api has no session
  // concept a plugin page could ride; see README findings).
  function renderPage(snap) {
    const badge = (state) => `<span class="state badge ${esc(state)}">${esc(state)}</span>`;
    const srvState = snap.server.alive ? 'up' : 'down';
    const rows = snap.plugins.map((p, i) => `
      <tr id="p-${i}">
        <td class="id">${esc(p.id)}</td>
        <td class="desc">${esc(p.description || '')}</td>
        <td>${p.prefix ? `<a href="${esc(p.prefix)}"><code>${esc(p.prefix)}</code></a>` : '—'}</td>
        <td>${badge(p.state)}</td>
        <td class="code">${p.status ?? '—'}</td>
        <td class="latency">${p.latency_ms === null ? '—' : `${p.latency_ms} ms`}</td>
        <td>${p.adminPage ? `<a href="${esc(p.adminPage)}">settings</a>` : '—'}</td>
      </tr>`).join('');

    const podsSection = !podsRoot ? `
    <p class="note">No <code>podsRoot</code> configured — user/storage stats need
    filesystem access the api doesn't mediate (the plugin can only see what the
    operator re-declares; cousin of the <code>api.serverInfo</code> finding).</p>`
      : snap.pods && snap.pods.error ? `
    <p class="note">podsRoot error: ${esc(snap.pods.error)}</p>`
        : `
    <table>
      <tbody>
        <tr><th>pods</th><td id="pods-count">${snap.pods.count}</td></tr>
        <tr><th>disk usage</th><td><span id="pods-bytes">${esc(fmtBytes(snap.pods.storageBytes))}</span>
          <span class="muted">(<span id="pods-raw">${snap.pods.storageBytes}</span> bytes,
          <span id="pods-entries">${snap.pods.entriesWalked}</span> entries walked${snap.pods.truncated ? ', TRUNCATED at the walk cap' : ''})</span></td></tr>
        <tr><th>newest pod modified</th><td id="pods-newest">${esc(snap.pods.newestPodModified ?? '—')}</td></tr>
      </tbody>
    </table>
    ${snap.pods.truncated ? '<p class="note">Walk capped — disk usage is a lower bound.</p>' : ''}`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>server admin</title>
<style>
  :root { color-scheme: light dark;
    --fg: #1a1a1a; --bg: #ffffff; --muted: #666; --line: #ddd; --card: #f7f7f7;
    --up: #1a7f37; --up-bg: #e6f4ea; --deg: #7a5d00; --deg-bg: #fdf3d0;
    --down: #b3261e; --down-bg: #fbe9e7; --unk: #555; --unk-bg: #ececec;
    --warn-bg: #fff3e0; --warn-line: #e0a960; }
  @media (prefers-color-scheme: dark) { :root {
    --fg: #e6e6e6; --bg: #121212; --muted: #999; --line: #333; --card: #1c1c1c;
    --up: #6fdb8b; --up-bg: #10331a; --deg: #e8c96a; --deg-bg: #33290d;
    --down: #ff8a80; --down-bg: #38120f; --unk: #aaa; --unk-bg: #262626;
    --warn-bg: #2b1f10; --warn-line: #7a5d2a; } }
  body { margin: 2rem auto; max-width: 56rem; padding: 0 1rem;
    font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 1.6rem 0 .5rem; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted); }
  a { color: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line);
    vertical-align: top; }
  thead th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  tbody th { font-weight: 600; white-space: nowrap; width: 12rem; }
  code { font-size: .9em; }
  .badge { display: inline-block; min-width: 4.5em; text-align: center;
    border-radius: 999px; padding: .05em .6em; font-size: .85em; }
  .badge.up { color: var(--up); background: var(--up-bg); }
  .badge.degraded { color: var(--deg); background: var(--deg-bg); }
  .badge.down { color: var(--down); background: var(--down-bg); }
  .badge.unprobed { color: var(--unk); background: var(--unk-bg); }
  .latency, .code { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .note, .muted { color: var(--muted); font-size: .9rem; }
  #meta { color: var(--muted); font-size: .85rem; margin: 1.2rem 0 0; }
  .strip { background: var(--warn-bg); border: 1px solid var(--warn-line);
    border-radius: 6px; padding: .8rem 1rem; margin-top: .5rem; }
  .strip ul { margin: .4rem 0 0; padding-left: 1.2rem; }
  .strip li { margin: .3rem 0; }
</style>
</head>
<body>
  <h1>server admin</h1>
  <p class="note">${esc(snap.server.baseUrl)} — ${adminAgents
    ? `guarded: ${adminAgents.length} admin agent${adminAgents.length === 1 ? '' : 's'}`
    : 'OPEN: no adminAgents configured — anyone can read this page'}</p>

  <h2>Server</h2>
  <table>
    <tbody>
      <tr><th>base URL</th><td><a href="${esc(snap.server.baseUrl)}/">${esc(snap.server.baseUrl)}</a></td></tr>
      <tr><th>host liveness</th><td><span id="srv-state">${badge(srvState)}</span>
        <span class="muted">http <span id="srv-status" class="code">${snap.server.status ?? '—'}</span>,
        <span id="srv-latency" class="latency">${snap.server.latency_ms} ms</span> over loopback</span></td></tr>
      <tr><th>process uptime</th><td id="srv-uptime">${esc(fmtDur(snap.server.uptime_seconds))}</td></tr>
      <tr><th>node</th><td>${esc(snap.server.node)}</td></tr>
      <tr><th>platform</th><td>${esc(snap.server.platform)}</td></tr>
    </tbody>
  </table>

  <h2>Plugins</h2>
${targets.length === 0 ? `  <p class="note">No other plugins are loaded. This page
  auto-discovers its co-loaded siblings via <code>api.plugins</code> (#610);
  load another plugin and it appears here — no hand-maintained list.</p>` : `  <table>
    <thead><tr><th>plugin</th><th>description</th><th>prefix</th><th>status</th><th>http</th><th>latency</th><th>admin</th></tr></thead>
    <tbody>${rows}
    </tbody>
  </table>
  <p class="note">Auto-discovered via <code>api.plugins</code> (#610) — no
  hand-copied list to drift. Probes are anonymous loopback GETs at each
  plugin's prefix; <code>config.probes</code> refines individual rows.</p>`}

  <h2>Pods / Users</h2>${podsSection}

  <h2>Not possible yet</h2>
  <div class="strip">
    <strong>What wp-admin has that this page can't do</strong> — each absence is a
    measured api gap, not a TODO:
    <ul>
${NOT_POSSIBLE.map(([what, why]) => `      <li><strong>${esc(what)}</strong> — ${esc(why)}</li>`).join('\n')}
    </ul>
  </div>

  <h2>Meta</h2>
  <p id="meta"><span id="meta-counts">${snap.meta.declared} declared —
    ${snap.meta.up} up, ${snap.meta.degraded} degraded, ${snap.meta.down} down, ${snap.meta.unprobed} unprobed</span>
    · generated <span id="meta-generated">${esc(snap.generated)}</span>
    · polls <code>status.json</code> every ${Math.round(refreshMs / 1000)}s</p>

  <script>
    (function () {
      var url = ${JSON.stringify(`${prefix}/status.json`)};
      var guarded = ${JSON.stringify(!!adminAgents)};
      var token = null;
      try { token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token'); } catch (e) {}
      function fmtBytes(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        var u = ['B', 'KB', 'MB', 'GB', 'TB']; var i = 0; var v = n;
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
        return (i ? v.toFixed(1) : v) + ' ' + u[i];
      }
      function fmtDur(s) {
        var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
            m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
        if (d) return d + 'd ' + h + 'h ' + m + 'm';
        if (h) return h + 'h ' + m + 'm';
        if (m) return m + 'm ' + sec + 's';
        return sec + 's';
      }
      function setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
      }
      function setBadge(container, state) {
        var el = document.querySelector(container + ' .state') || document.querySelector(container);
        if (!el) return;
        el.textContent = state;
        el.className = 'state badge ' + state;
      }
      async function tick() {
        try {
          var res = await fetch(url, {
            cache: 'no-store',
            headers: token ? { authorization: 'Bearer ' + token } : {},
          });
          if (res.status === 401 || res.status === 403) {
            setText('meta-generated', 'poll ' + res.status + (guarded
              ? ' — append #token=<your bearer> to the URL to poll live'
              : ''));
            return;
          }
          var data = await res.json();
          setBadge('#srv-state', data.server.alive ? 'up' : 'down');
          setText('srv-status', data.server.status === null ? '—' : data.server.status);
          setText('srv-latency', data.server.latency_ms + ' ms');
          setText('srv-uptime', fmtDur(data.server.uptime_seconds));
          data.plugins.forEach(function (p, i) {
            var row = document.getElementById('p-' + i);
            if (!row) return;
            setBadge('#p-' + i, p.state);
            row.querySelector('.code').textContent = (p.status === null || p.status === undefined) ? '—' : p.status;
            row.querySelector('.latency').textContent = p.latency_ms === null ? '—' : p.latency_ms + ' ms';
          });
          if (data.pods && !data.pods.error) {
            setText('pods-count', data.pods.count);
            setText('pods-bytes', fmtBytes(data.pods.storageBytes));
            setText('pods-raw', data.pods.storageBytes);
            setText('pods-entries', data.pods.entriesWalked);
            if (data.pods.newestPodModified) setText('pods-newest', data.pods.newestPodModified);
          }
          setText('meta-counts', data.meta.declared + ' declared — ' + data.meta.up + ' up, '
            + data.meta.degraded + ' degraded, ' + data.meta.down + ' down, '
            + data.meta.unprobed + ' unprobed');
          setText('meta-generated', data.generated);
        } catch (err) {
          setText('meta-generated', 'poll failed: ' + err);
        }
      }
      setInterval(tick, ${JSON.stringify(refreshMs)});
      tick();
    })();
  </script>
</body>
</html>
`;
  }

  // -------------------------------------------------------------- routes
  const servePage = async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const snap = await snapshot();
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(renderPage(snap));
  };
  api.fastify.get(`${prefix}/`, servePage);
  api.fastify.get(prefix, servePage);

  api.fastify.get(`${prefix}/status.json`, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    reply.header('cache-control', 'no-store');
    return snapshot();
  });

  // Cheap, ungated liveness — no snapshot, no auth (conventional for a
  // healthz, like metrics/). It lets another prober (e.g. dashboard/) confirm
  // the admin plugin is alive WITHOUT triggering a full page-snapshot render,
  // which probes every sibling and would otherwise blow the prober's timeout
  // and read as 'down' — and, when two ops consoles probe each other, storm.
  api.fastify.get(`${prefix}/healthz`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok', uptime_seconds: Math.round(process.uptime()) };
  });

  if (!adminAgents) {
    api.log.warn(
      `admin: the admin surface at ${prefix}/ is OPEN — no config.adminAgents set, `
      + 'so ANYONE can read the server/plugin/pod overview. The plugin api has no '
      + 'operator concept; pass adminAgents (agent id allowlist) to guard it.',
    );
  }
  api.log.info(
    `admin: operator home at ${prefix}/ — ${targets.length} plugin(s) auto-discovered `
    + `(api.plugins), ${podsRoot ? `pods stats from ${podsRoot}` : 'no podsRoot (no pod stats)'}, `
    + `${adminAgents ? `${adminAgents.length} admin agent(s)` : 'OPEN'}`,
  );

  // Stateless: probes and the pods walk run per request; the refresh timer
  // lives in the client page. Nothing to tear down.
}

export default activate;
