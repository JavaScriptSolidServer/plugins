// admin plugin over a real JSS from npm: ONE server carrying the admin page
// plus two real sibling plugins (rss, metrics) as probe targets, podsRoot
// pointed at the server's own data root, and an adminAgents allowlist proven
// with two real pods (alice is the operator, mallory is not).
//
// Ordering follows AGENT.md's DATA_ROOT footgun: every validation-failure
// boot runs FIRST (a second createServer in one process repoints JSS's
// module-global data root, even when the boot fails), and the open-mode
// (no adminAgents) boot runs LAST, after the long-lived server is closed —
// sequential closed boots are fine (metrics/test.js does the same).

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

  it('refuses to boot without config.loopbackUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ id: 'admin', module: module_, prefix: '/admin' }] }),
      /requires config\.loopbackUrl/,
    );
  });

  it('rejects a probe path containing :// (probes never leave loopback)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'admin',
          module: module_,
          prefix: '/admin',
          config: {
            loopbackUrl: 'http://127.0.0.1:9',
            plugins: [{ id: 'evil', probe: 'https://example.com/exfil' }],
          },
        }],
      }),
      /probe must be a local path/,
    );
  });

  it('rejects a probe that targets the admin page itself (would recurse)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'admin',
          module: module_,
          prefix: '/admin',
          config: {
            loopbackUrl: 'http://127.0.0.1:9',
            plugins: [{ id: 'ouroboros', probe: '/admin/status.json' }],
          },
        }],
      }),
      /would recurse/,
    );
  });

  // -------------------------------------------------- the long-lived boot

  it('boots ONE JSS: admin + rss + metrics, podsRoot at the server root, adminAgents set', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    // Our own data root so its absolute path can go into config BEFORE boot
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
          config: {
            loopbackUrl: base,
            baseUrl: base,
            podsRoot: root,
            adminAgents: [adminWebId],
            // Hand-copied inventory — a duplicate of the list above, because
            // the api has no registry a plugin could read (#463/#464).
            plugins: [
              // rss: anonymous GET /feed/atom is a 400 usage/guard answer.
              { id: 'rss', prefix: '/feed', description: 'Atom/RSS feeds over pod containers', probe: '/feed/atom', expect: [400] },
              // metrics healthz is open → 200; its exposition doubles as the
              // adminPage link (the settings-panel workaround convention).
              { id: 'metrics', prefix: '/metrics', description: 'healthz + Prometheus exporter', probe: '/metrics/healthz', expect: [200], adminPage: '/metrics/metrics' },
              // admin itself: declared but NOT probed (a probe under our own
              // prefix throws at activate) → the 'unprobed' state.
              { id: 'admin', prefix: '/admin', description: 'this page' },
            ],
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
    // The page and status.json are gated (above), but healthz must answer
    // anonymously so another prober (dashboard/) can check liveness cheaply
    // without triggering a full snapshot render.
    const res = await get(`${base}/admin/healthz`);
    assert.strictEqual(res.status, 200, `healthz: ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(typeof body.uptime_seconds, 'number');
  });

  // ------------------------------------------------------------- the page

  it('admin GET page → 200 self-contained HTML with plugin ids, pods count, sections', async () => {
    const res = await get(`${base}/admin/`, alice);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();

    // Plugins table: every declared id, prefix links, the adminPage link.
    for (const id of ['rss', 'metrics', 'admin']) {
      assert.ok(html.includes(`<td class="id">${id}</td>`), `page must list ${id}`);
    }
    assert.ok(html.includes('href="/feed"'), 'prefix link to rss');
    assert.ok(html.includes('href="/metrics/metrics"'), 'adminPage link rendered');

    // Server section, server-side rendered (curl shows real content).
    assert.ok(html.includes(process.version), 'node version rendered');
    assert.match(html, /host liveness[\s\S]*?badge up/, 'host probed alive at render time');

    // Pods section: two pods (alice + mallory), rendered server-side.
    assert.ok(html.includes('id="pods-count">2<'), 'pods count rendered server-side');
    assert.match(html, /id="pods-raw">\d+</, 'storage bytes rendered');

    // The not-possible strip, with the seams named.
    assert.ok(html.includes("What wp-admin has that this page can't do"), 'strip present');
    for (const marker of ['#200', '#463', 'deactivate()', 'adminPage', 'write-only']) {
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

  it('status.json: server, plugins[].state, pods stats, meta counts', async () => {
    const res = await get(`${base}/admin/status.json`, alice);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();

    assert.match(body.generated, /^\d{4}-\d\d-\d\dT/, 'generated is an ISO timestamp');

    // Server: liveness over loopback + process facts (same process as the test).
    assert.strictEqual(body.server.alive, true, JSON.stringify(body.server));
    assert.strictEqual(typeof body.server.status, 'number');
    assert.strictEqual(body.server.baseUrl, base);
    assert.strictEqual(body.server.node, process.version);
    assert.strictEqual(body.server.platform, `${process.platform} ${process.arch}`);
    assert.ok(body.server.uptime_seconds >= 0);

    // Plugins: rss up via expect [400], metrics up via expect [200],
    // admin declared-but-unprobed.
    assert.strictEqual(body.plugins.length, 3);
    const byId = Object.fromEntries(body.plugins.map((p) => [p.id, p]));
    assert.strictEqual(byId.rss.state, 'up', JSON.stringify(byId.rss));
    assert.strictEqual(byId.rss.status, 400, 'anonymous /feed/atom is a 400 guard answer');
    assert.strictEqual(byId.metrics.state, 'up', JSON.stringify(byId.metrics));
    assert.strictEqual(byId.metrics.status, 200);
    assert.strictEqual(byId.metrics.adminPage, '/metrics/metrics');
    assert.strictEqual(byId.admin.state, 'unprobed');
    assert.strictEqual(byId.admin.status, null);

    // Pods: two pods, real byte totals from the capped walk.
    assert.ok(body.pods.count >= 1, `pods.count: ${body.pods.count}`);
    assert.strictEqual(body.pods.count, 2, 'alice + mallory');
    assert.strictEqual(typeof body.pods.storageBytes, 'number');
    assert.ok(body.pods.storageBytes > 0, 'pods have profile documents on disk');
    assert.strictEqual(body.pods.truncated, false);
    assert.match(body.pods.newestPodModified, /^\d{4}-/, 'newest pod mtime is a timestamp');

    // Meta.
    assert.deepStrictEqual(
      { declared: body.meta.declared, up: body.meta.up, down: body.meta.down, unprobed: body.meta.unprobed },
      { declared: 3, up: 2, down: 0, unprobed: 1 },
    );
    assert.strictEqual(body.meta.guarded, true);
  });

  it('probes are live each request (no caching): two calls, fresh timestamps', async () => {
    const a = await (await get(`${base}/admin/status.json`, alice)).json();
    const b = await (await get(`${base}/admin/status.json`, alice)).json();
    assert.notStrictEqual(a.generated, b.generated, 'each request re-probes');
  });

  // --------------------------------------- open mode (fresh boot, LAST)

  it('a boot WITHOUT adminAgents serves anonymously, and says so on the page', async () => {
    await jss.close(); // sequential closed boots are safe (DATA_ROOT footgun)
    jss = null;

    const port = await probePort();
    const openBase = `http://127.0.0.1:${port}`;
    jssOpen = await startJss({
      port,
      plugins: [{
        id: 'admin',
        module: module_,
        prefix: '/admin',
        config: { loopbackUrl: openBase }, // no adminAgents → OPEN (warned at activate)
      }],
    });

    const page = await fetch(`${openBase}/admin/`);
    assert.strictEqual(page.status, 200, 'anonymous page in open mode');
    const html = await page.text();
    assert.ok(html.includes('OPEN: no adminAgents configured'),
      'the page itself declares the open-mode hazard');
    assert.ok(html.includes('No plugins declared'), 'empty inventory explains itself');

    const res = await fetch(`${openBase}/admin/status.json`);
    assert.strictEqual(res.status, 200, 'anonymous JSON in open mode');
    const body = await res.json();
    assert.strictEqual(body.server.alive, true);
    assert.strictEqual(body.meta.guarded, false);
    assert.strictEqual(body.pods, null, 'no podsRoot → no pod stats');
  });
});
