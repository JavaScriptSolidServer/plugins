// Dashboard plugin over a real JSS from npm (>= 0.0.218): boot ONE server
// carrying the dashboard plus three real sibling plugins (rss, capability,
// relay) and probe them through /dashboard/status.json. The dashboard
// AUTO-DISCOVERS its siblings from api.plugins (#610) — no hand-copied list —
// and reaches the host over loopback via api.serverInfo (#601) — no
// loopbackUrl in config. config.probes only refines individual probes.
//
// Misconfiguration tests (which fail a createServer) run FIRST: a failed
// second createServer re-points JSS's process-global data root (AGENT.md
// footgun), so the empty-server case runs LAST and closes itself.

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
  //
  // config.probes refinements are validated at activate; a bad one fails the
  // boot. (There is no loopbackUrl to validate anymore — serverInfo supplies
  // the origin.)

  it('rejects a probe refinement containing :// (probes never leave loopback)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'dashboard',
          module: module_,
          prefix: '/dashboard',
          config: { probes: { evil: { probe: 'https://example.com/exfil' } } },
        }],
      }),
      /probe must be a local path/,
    );
  });

  it('rejects a probe refinement not starting with /', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'dashboard',
          module: module_,
          prefix: '/dashboard',
          config: { probes: { relative: { probe: 'api/v1/instance' } } },
        }],
      }),
      /probe must be a local path/,
    );
  });

  it('rejects a probe refinement that targets the dashboard itself (would recurse)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'dashboard',
          module: module_,
          prefix: '/dashboard',
          config: { probes: { ouroboros: { probe: '/dashboard/status.json' } } },
        }],
      }),
      /would recurse/,
    );
  });

  // -------------------------------------------------- the long-lived boot

  it('boots ONE JSS and auto-discovers its siblings (no hand-fed list, no loopbackUrl)', async () => {
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
          // NO config.plugins (auto-discovered) and NO loopbackUrl
          // (serverInfo). Only per-plugin probe refinements:
          config: {
            probes: {
              // rss: bare /feed isn't a clean liveness signal; /feed/atom
              // gives a 400 usage/guard answer — a 4xx from a living plugin.
              rss: { probe: '/feed/atom' },
              // relay is a WebSocket endpoint (probe defaults to its /relay
              // prefix); an upgrade-refusal to a plain GET counts as alive.
              relay: { kind: 'ws' },
              // capability: probe the POST-only /cap/issue and DECLARE
              // expect [200]; its anonymous 4xx fails that → demonstrates
              // 'down' with a real, loaded plugin.
              capability: { probe: '/cap/issue', expect: [200] },
            },
          },
        },
      ],
    });
    assert.ok(jss.base);
  });

  it('GET /dashboard/ is a self-contained HTML page naming every discovered plugin', async () => {
    const res = await fetch(`${base}/dashboard/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    for (const id of ['rss', 'capability', 'relay', 'server']) {
      assert.ok(html.includes(`<td class="id">${id}</td>`), `page must list ${id}`);
    }
    for (const probe of ['/feed/atom', '/relay', '/cap/issue']) {
      assert.ok(html.includes(`<code>${probe}</code>`), `page must show probe ${probe}`);
    }
    assert.ok(html.includes('status.json'), 'page script polls status.json');
    assert.ok(!/src\s*=\s*"http/.test(html) && !/href\s*=\s*"http/.test(html),
      'page must be self-contained (no external assets)');
    const bare = await fetch(`${base}/dashboard`);
    assert.strictEqual(bare.status, 200);
    assert.match(bare.headers.get('content-type'), /text\/html/);
  });

  it('GET /dashboard/status.json probes live: shape, alive flags, latency', async () => {
    const res = await fetch(`${base}/dashboard/status.json`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();

    assert.match(body.generated, /^\d{4}-\d\d-\d\dT/, 'generated is an ISO timestamp');
    assert.strictEqual(body.server.alive, true, `host probe: ${JSON.stringify(body.server)}`);
    assert.strictEqual(typeof body.server.status, 'number');

    // Three discovered siblings — the dashboard filtered itself out.
    assert.strictEqual(body.plugins.length, 3);
    const byId = Object.fromEntries(body.plugins.map((p) => [p.id, p]));
    for (const p of body.plugins) {
      assert.strictEqual(typeof p.latency_ms, 'number', `${p.id} latency_ms`);
      assert.strictEqual(typeof p.probe, 'string');
    }

    // relay (ws) and rss answered <500 anonymously → alive.
    assert.strictEqual(byId.relay.alive, true, `relay: ${JSON.stringify(byId.relay)}`);
    assert.strictEqual(byId.rss.alive, true, `rss: ${JSON.stringify(byId.rss)}`);
    assert.strictEqual(byId.rss.status, 400, 'rss /feed/atom anon is a 400 guard answer');

    // capability answered a non-200 <500, which the DEFAULT rule would call
    // alive — but its expect:[200] refinement declares that down.
    assert.strictEqual(typeof byId.capability.status, 'number');
    assert.ok(byId.capability.status < 500 && byId.capability.status !== 200,
      `capability draws a non-200 <500, got ${byId.capability.status}`);
    assert.strictEqual(byId.capability.alive, false, `capability: ${JSON.stringify(byId.capability)}`);
    assert.strictEqual(byId.capability.state, 'down');
  });

  it('probes are live each request (no caching): two calls, fresh timestamps', async () => {
    const a = await (await fetch(`${base}/dashboard/status.json`)).json();
    const b = await (await fetch(`${base}/dashboard/status.json`)).json();
    assert.notStrictEqual(a.generated, b.generated, 'each request re-probes');
  });

  // ---------------------------------------------- empty case (own server, last)

  it('with no other plugins loaded, renders an empty dashboard that explains itself', async () => {
    const solo = await startJss({
      plugins: [{ id: 'dashboard', module: module_, prefix: '/dashboard' }],
    });
    try {
      const page = await fetch(`${solo.base}/dashboard/`);
      assert.strictEqual(page.status, 200);
      assert.ok((await page.text()).includes('No other plugins are loaded'),
        'empty dashboard explains itself');

      const res = await fetch(`${solo.base}/dashboard/status.json`);
      assert.strictEqual(res.status, 200);
      const bodyJson = await res.json();
      assert.deepStrictEqual(bodyJson.plugins, []);
      assert.strictEqual(bodyJson.server.alive, true);
    } finally {
      await solo.close();
    }
  });
});
