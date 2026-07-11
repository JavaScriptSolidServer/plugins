// admin plugin over a real JSS from npm (>= 0.0.218): ONE server carrying the
// admin page plus two real siblings (rss, metrics), auto-discovered via
// api.plugins (#610) with NO hand-fed list and NO loopbackUrl (api.serverInfo,
// #601). podsRoot points at the server's own data root; an adminAgents
// allowlist is proven with two real pods (alice is the operator, mallory not).
//
// Ordering follows AGENT.md's DATA_ROOT footgun: validation-failure boots run
// FIRST, and the open-mode (no adminAgents) boot runs LAST after the
// long-lived server is closed (sequential closed boots are fine).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');
const sibling = (p) => path.join(__dirname, '..', p);

describe('admin plugin', () => {
  let jss;
  let jssOpen; // the open-mode boot, LAST
  let base;
  let alice; // admin bearer
  let mallory; // non-admin bearer

  after(async () => {
    if (jss) await jss.close();
    if (jssOpen) await jssOpen.close();
  });

  const get = (url, token) => fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  // ------------------------------------------------ validation (pre-boot)
  // config.probes refinements are validated at activate. (There is no
  // loopbackUrl to validate — api.serverInfo supplies the origin.)

  it('rejects a probe refinement containing :// (probes never leave loopback)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'admin', module: module_, prefix: '/admin',
          config: { probes: { evil: { probe: 'https://example.com/exfil' } } },
        }],
      }),
      /probe must be a local path/,
    );
  });

  it('rejects a probe refinement that targets the admin page itself (would recurse)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'admin', module: module_, prefix: '/admin',
          config: { probes: { ouroboros: { probe: '/admin/status.json' } } },
        }],
      }),
      /would recurse/,
    );
  });

  // -------------------------------------------------- the long-lived boot

  it('boots ONE JSS and auto-discovers siblings (no hand-fed list, no loopbackUrl)', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    // Our own data root so its absolute path can go into config before boot
    // (podsRoot is operator-repeated state — the api doesn't mediate it).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-admin-test-'));
    // The admin agent must be known at boot, before the pod exists — the
    // WebID is deterministic (path mode): <base>/<name>/profile/card.jsonld#me.
    const adminWebId = `${base}/alice/profile/card.jsonld#me`;

    jss = await startJss({
      port,
      root,
      idp: true,
      plugins: [
        {
          id: 'rss',
          module: sibling('rss/plugin.js'),
          prefix: '/feed',
          config: { baseUrl: base, loopbackUrl: base },
        },
        {
          id: 'metrics',
          module: sibling('metrics/plugin.js'),
          prefix: '/metrics',
          config: { loopbackUrl: base },
        },
        {
          id: 'admin',
          module: module_,
          prefix: '/admin',
          // No loopbackUrl, no baseUrl, no hand-fed plugins list. Only
          // podsRoot (pod stats), adminAgents (the gate), and per-plugin
          // probe refinements (the roster carries no health hints).
          config: {
            podsRoot: root,
            adminAgents: [adminWebId],
            probes: {
              rss: { probe: '/feed/atom', expect: [400], description: 'Atom/RSS feeds over pod containers' },
              metrics: { probe: '/metrics/healthz', expect: [200], description: 'healthz + Prometheus exporter', adminPage: '/metrics/metrics' },
            },
          },
        },
      ],
    });

    // Mint the two pods + bearers: POST /.pods creates pod + IdP account,
    // POST /idp/credentials returns { access_token, webid }.
    const mint = async (name) => {
      const password = `correct horse ${name} staple`;
      const res = await fetch(`${base}/.pods`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, email: `${name}@example.com`, password }),
      });
      assert.strictEqual(res.status, 201, `pod ${name}: ${res.status} ${await res.clone().text()}`);
      const cred = await (await fetch(`${base}/idp/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password }),
      })).json();
      assert.ok(cred.access_token, `mint ${name} failed: ${JSON.stringify(cred)}`);
      return cred;
    };
    const aliceCred = await mint('alice');
    assert.strictEqual(aliceCred.webid, adminWebId,
      'predicted admin WebID matches what the IdP minted (adminAgents must be known at boot)');
    alice = aliceCred.access_token;
    mallory = (await mint('mallory')).access_token;
  });

  // ------------------------------------------------------------ the guard

  it('anonymous GET page and status.json → 401 JSON', async () => {
    for (const p of ['/admin/', '/admin/status.json']) {
      const res = await get(base + p);
      assert.strictEqual(res.status, 401, `${p}: ${res.status}`);
      assert.match(res.headers.get('www-authenticate'), /^Bearer/);
      const body = await res.json();
      assert.match(body.error, /authentication required/);
    }
  });

  it('a non-admin agent (real pod bearer, not in adminAgents) → 403 JSON', async () => {
    for (const p of ['/admin/', '/admin/status.json']) {
      const res = await get(base + p, mallory);
      assert.strictEqual(res.status, 403, `${p}: ${res.status}`);
      const body = await res.json();
      assert.match(body.error, /not an admin/);
    }
  });

  it('healthz is 200 and ungated — liveness needs no auth, even when the page is gated', async () => {
    const res = await get(`${base}/admin/healthz`);
    assert.strictEqual(res.status, 200, `healthz: ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(typeof body.uptime_seconds, 'number');
  });

  // ------------------------------------------------------------- the page

  it('admin GET page → 200 self-contained HTML with discovered plugins, pods, sections', async () => {
    const res = await get(`${base}/admin/`, alice);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();

    // Plugins table: the discovered siblings (admin filters ITSELF out).
    for (const id of ['rss', 'metrics']) {
      assert.ok(html.includes(`<td class="id">${id}</td>`), `page must list ${id}`);
    }
    assert.ok(!html.includes('<td class="id">admin</td>'), 'admin does not list itself');
    assert.ok(html.includes('href="/feed"'), 'prefix link to rss');
    assert.ok(html.includes('href="/metrics/metrics"'), 'adminPage link rendered');

    // Server section, server-side rendered (curl shows real content).
    assert.ok(html.includes(process.version), 'node version rendered');
    assert.match(html, /host liveness[\s\S]*?badge up/, 'host probed alive at render time');

    // Pods section: two pods (alice + mallory), rendered server-side.
    assert.ok(html.includes('id="pods-count">2<'), 'pods count rendered server-side');
    assert.match(html, /id="pods-raw">\d+</, 'storage bytes rendered');

    // The not-possible strip, with the seams named (api.plugins no longer
    // among them — it shipped).
    assert.ok(html.includes("What wp-admin has that this page can't do"), 'strip present');
    for (const marker of ['#200', 'deactivate()', 'adminPage', 'write-only', 'api.isOperator']) {
      assert.ok(html.includes(marker), `strip names the seam: ${marker}`);
    }

    // Self-contained + polling.
    assert.ok(html.includes('status.json'), 'page script polls status.json');
    assert.ok(!/src\s*=\s*"http/.test(html), 'no external scripts');

    // Bare prefix serves the same page (still guarded).
    const bare = await get(`${base}/admin`, alice);
    assert.strictEqual(bare.status, 200);
    assert.strictEqual((await get(`${base}/admin`)).status, 401, 'bare prefix guarded too');
  });

  // ------------------------------------------------------------- the JSON

  it('status.json: server (origin from serverInfo), plugins[].state, pods, meta', async () => {
    const res = await get(`${base}/admin/status.json`, alice);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();

    assert.match(body.generated, /^\d{4}-\d\d-\d\dT/, 'generated is an ISO timestamp');

    // Server: liveness over loopback + process facts. baseUrl now comes from
    // api.serverInfo (no config.baseUrl) — assert it's a real origin.
    assert.strictEqual(body.server.alive, true, JSON.stringify(body.server));
    assert.strictEqual(typeof body.server.status, 'number');
    assert.ok(/^https?:\/\/.+:\d+$/.test(body.server.baseUrl) || body.server.baseUrl.startsWith('http'),
      `server.baseUrl is an origin: ${body.server.baseUrl}`);
    assert.strictEqual(body.server.node, process.version);
    assert.strictEqual(body.server.platform, `${process.platform} ${process.arch}`);
    assert.ok(body.server.uptime_seconds >= 0);

    // Plugins: the two discovered siblings, refined via config.probes; admin
    // filtered itself out.
    assert.strictEqual(body.plugins.length, 2);
    const byId = Object.fromEntries(body.plugins.map((p) => [p.id, p]));
    assert.ok(!byId.admin, 'admin is not in its own list');
    assert.strictEqual(byId.rss.state, 'up', JSON.stringify(byId.rss));
    assert.strictEqual(byId.rss.status, 400, 'anonymous /feed/atom is a 400 guard answer');
    assert.strictEqual(byId.metrics.state, 'up', JSON.stringify(byId.metrics));
    assert.strictEqual(byId.metrics.status, 200);
    assert.strictEqual(byId.metrics.adminPage, '/metrics/metrics');

    // Pods: two pods, real byte totals from the capped walk.
    assert.strictEqual(body.pods.count, 2, 'alice + mallory');
    assert.strictEqual(typeof body.pods.storageBytes, 'number');
    assert.ok(body.pods.storageBytes > 0, 'pods have profile documents on disk');
    assert.strictEqual(body.pods.truncated, false);
    assert.match(body.pods.newestPodModified, /^\d{4}-/, 'newest pod mtime is a timestamp');

    // Meta.
    assert.deepStrictEqual(
      { declared: body.meta.declared, up: body.meta.up, down: body.meta.down, unprobed: body.meta.unprobed },
      { declared: 2, up: 2, down: 0, unprobed: 0 },
    );
    assert.strictEqual(body.meta.guarded, true);
  });

  it('probes are live each request (no caching): two calls, fresh timestamps', async () => {
    const a = await (await get(`${base}/admin/status.json`, alice)).json();
    const b = await (await get(`${base}/admin/status.json`, alice)).json();
    assert.notStrictEqual(a.generated, b.generated, 'each request re-probes');
  });

  // --------------------------------------- open mode (fresh boot, LAST)

  it('a boot WITHOUT adminAgents serves anonymously; admin alone renders empty', async () => {
    await jss.close(); // sequential closed boots are safe (DATA_ROOT footgun)
    jss = null;

    const port = await probePort();
    const openBase = `http://127.0.0.1:${port}`;
    jssOpen = await startJss({
      port,
      plugins: [{
        id: 'admin', module: module_, prefix: '/admin',
        config: {}, // no adminAgents → OPEN (warned at activate); no loopbackUrl
      }],
    });

    const page = await fetch(`${openBase}/admin/`);
    assert.strictEqual(page.status, 200, 'anonymous page in open mode');
    const html = await page.text();
    assert.ok(html.includes('OPEN: no adminAgents configured'),
      'the page itself declares the open-mode hazard');
    assert.ok(html.includes('No other plugins are loaded'), 'empty inventory explains itself');

    const res = await fetch(`${openBase}/admin/status.json`);
    assert.strictEqual(res.status, 200, 'anonymous JSON in open mode');
    const body = await res.json();
    assert.strictEqual(body.server.alive, true);
    assert.strictEqual(body.meta.guarded, false);
    assert.deepStrictEqual(body.plugins, [], 'admin alone discovers no siblings');
    assert.strictEqual(body.pods, null, 'no podsRoot → no pod stats');
  });
});
