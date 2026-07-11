// Dashboard plugin over a real JSS from npm: boot ONE server carrying the
// dashboard plus three real sibling plugins from this repo (rss, capability,
// relay) and probe them through /dashboard/status.json — the operator's
// hand-copied plugins list (there is no api.plugins registry to read;
// #463/#464), anonymous <500-is-alive semantics, an expect-mismatch 'down'
// row, and the ws-over-plain-HTTP simplification.
//
// Same probe-port-then-boot dance as rss/backup (the plugin needs the host
// origin in config before listen — api.serverInfo finding), and ALL the
// misconfiguration tests run FIRST because a failed second createServer
// re-points JSS's process-global data root (AGENT.md footgun).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');
const sibling = (p) => path.join(__dirname, '..', p);

describe('dashboard plugin', () => {
  let jss;
  let base;

  after(async () => { if (jss) await jss.close(); });

  // ------------------------------------------------ validation (pre-boot)

  it('refuses to boot without config.loopbackUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ id: 'dashboard', module: module_, prefix: '/dashboard' }] }),
      /requires config\.loopbackUrl/,
    );
  });

  it('rejects a probe path containing :// (probes never leave loopback)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'dashboard',
          module: module_,
          prefix: '/dashboard',
          config: {
            loopbackUrl: 'http://127.0.0.1:9',
            plugins: [{ id: 'evil', probe: 'https://example.com/exfil' }],
          },
        }],
      }),
      /probe must be a local path/,
    );
  });

  it('rejects a probe path not starting with /', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'dashboard',
          module: module_,
          prefix: '/dashboard',
          config: {
            loopbackUrl: 'http://127.0.0.1:9',
            plugins: [{ id: 'relative', probe: 'api/v1/instance' }],
          },
        }],
      }),
      /probe must be a local path/,
    );
  });

  it('rejects a probe that targets the dashboard itself (would recurse)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'dashboard',
          module: module_,
          prefix: '/dashboard',
          config: {
            loopbackUrl: 'http://127.0.0.1:9',
            plugins: [{ id: 'ouroboros', probe: '/dashboard/status.json' }],
          },
        }],
      }),
      /would recurse/,
    );
  });

  // -------------------------------------------------- the long-lived boot

  it('boots ONE JSS: dashboard + rss + capability + relay as probe targets', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      plugins: [
        { id: 'relay', module: sibling('relay/plugin.js'), prefix: '/relay' },
        { id: 'capability', module: sibling('capability/plugin.js'), prefix: '/cap', config: {} },
        {
          id: 'rss',
          module: sibling('rss/plugin.js'),
          prefix: '/feed',
          config: { baseUrl: base, loopbackUrl: base },
        },
        {
          id: 'dashboard',
          module: module_,
          prefix: '/dashboard',
          config: {
            loopbackUrl: base,
            // The operator's hand-copied registry — a duplicate of the very
            // list above, because a plugin can't see its siblings (#463/#464).
            plugins: [
              // rss: anonymous GET /feed/atom is a 400 usage/guard answer —
              // a 4xx from a living plugin counts as alive by default.
              { id: 'rss', probe: '/feed/atom' },
              // capability: /cap/issue only answers POST; anonymous GET is a
              // 4xx — alive.
              { id: 'capability', probe: '/cap/issue' },
              // relay is a WebSocket endpoint: plain-HTTP GET, upgrade-refusal
              // (or 4xx) counts as alive — the documented ws simplification.
              { id: 'relay', probe: '/relay', kind: 'ws' },
              // Nothing serves /ghost/health; the 4xx it draws is <500 (so
              // "alive" by default), but expect: [200] declares that
              // insufficient → demonstrates 'down'.
              { id: 'ghost', probe: '/ghost/health', expect: [200] },
            ],
          },
        },
        // A second mount with NO plugins list: must still boot and render.
        { id: 'dashboard-empty', module: module_, prefix: '/emptyboard', config: { loopbackUrl: base } },
      ],
    });
  });

  it('GET /dashboard/ is a self-contained HTML page naming every plugin', async () => {
    const res = await fetch(`${base}/dashboard/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    for (const id of ['rss', 'capability', 'relay', 'ghost', 'server']) {
      assert.ok(html.includes(`<td class="id">${id}</td>`), `page must list ${id}`);
    }
    for (const probe of ['/feed/atom', '/cap/issue', '/relay', '/ghost/health']) {
      assert.ok(html.includes(`<code>${probe}</code>`), `page must show probe ${probe}`);
    }
    assert.ok(html.includes('status.json'), 'page script polls status.json');
    assert.ok(!/src\s*=\s*"http/.test(html) && !/href\s*=\s*"http/.test(html),
      'page must be self-contained (no external assets)');
    // The bare prefix serves the same page.
    const bare = await fetch(`${base}/dashboard`);
    assert.strictEqual(bare.status, 200);
    assert.match(bare.headers.get('content-type'), /text\/html/);
  });

  it('GET /dashboard/status.json probes live: shape, alive flags, latency', async () => {
    const res = await fetch(`${base}/dashboard/status.json`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();

    // Envelope.
    assert.match(body.generated, /^\d{4}-\d\d-\d\dT/, 'generated is an ISO timestamp');
    assert.strictEqual(body.server.alive, true, `host probe: ${JSON.stringify(body.server)}`);
    assert.strictEqual(typeof body.server.status, 'number');

    // One entry per declared plugin, in order.
    assert.strictEqual(body.plugins.length, 4);
    const byId = Object.fromEntries(body.plugins.map((p) => [p.id, p]));

    for (const p of body.plugins) {
      assert.strictEqual(typeof p.latency_ms, 'number', `${p.id} latency_ms`);
      assert.strictEqual(typeof p.probe, 'string');
    }

    // The three live siblings answered <500 anonymously → alive.
    for (const id of ['rss', 'capability', 'relay']) {
      assert.strictEqual(byId[id].alive, true, `${id} should be alive: ${JSON.stringify(byId[id])}`);
      assert.ok(byId[id].status < 500, `${id} status <500, got ${byId[id].status}`);
    }
    // rss's anonymous /feed/atom is a 400 guard answer — alive, not 'down'.
    assert.strictEqual(byId.rss.status, 400);
    assert.notStrictEqual(byId.rss.state, 'down');

    // The expect-mismatch probe: something answered (a 4xx, <500 — which the
    // DEFAULT rule would call alive) but expect [200] declares it down.
    assert.strictEqual(typeof byId.ghost.status, 'number');
    assert.ok(byId.ghost.status < 500 && byId.ghost.status !== 200,
      `ghost draws a non-200 <500, got ${byId.ghost.status}`);
    assert.strictEqual(byId.ghost.alive, false, `ghost: ${JSON.stringify(byId.ghost)}`);
    assert.strictEqual(byId.ghost.state, 'down');
  });

  it('probes are live each request (no caching): two calls, fresh timestamps', async () => {
    const a = await (await fetch(`${base}/dashboard/status.json`)).json();
    const b = await (await fetch(`${base}/dashboard/status.json`)).json();
    assert.notStrictEqual(a.generated, b.generated, 'each request re-probes');
  });

  it('missing config.plugins → empty dashboard that still renders, with a note', async () => {
    const page = await fetch(`${base}/emptyboard/`);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('No plugins declared'), 'empty dashboard explains itself');

    const res = await fetch(`${base}/emptyboard/status.json`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.plugins, []);
    assert.strictEqual(body.server.alive, true);
  });
});
