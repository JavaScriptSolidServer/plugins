// Metrics plugin over a real JSS from npm: healthz (with a loopback check),
// Prometheus exposition, Bearer-token guard, and — the experiment this
// plugin exists for — the empirical scope of an onResponse hook added on
// api.fastify. A second "neighbor" plugin (test-fixture.js) is booted
// alongside so the test can prove the hook sees OTHER plugins' routes
// (all entries share one loader register scope) while core routes (/,
// LDP paths, /.well-known) never appear in the counters.
//
// Two host quirks this suite encodes:
//  - The main boot passes `logger: true, logLevel: 'silent'` — under
//    `logger: false` core's access-log onResponse hook throws
//    (request.log.isLevelEnabled is missing on Fastify's null logger) and
//    silently kills every downstream onResponse hook, so the request
//    counters would stay at zero. See README Findings.
//  - The extra boots (no-loopback, dead-loopback) run LAST: a second
//    createServer in one process repoints JSS's module-global DATA_ROOT
//    (AGENT.md footgun). Harmless here — this plugin never touches
//    storage — but the safe ordering is kept anyway.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');
const fixture_ = path.join(__dirname, 'test-fixture.js');

const TOKEN = 'metrics-scrape-token-1234567890';

describe('metrics plugin', () => {
  let jss;
  let base;
  const extra = []; // later boots, closed in after()

  after(async () => {
    for (const s of extra.reverse()) await s.close();
    if (jss) await jss.close();
  });

  const scrape = async (auth = TOKEN) => {
    const res = await fetch(`${base}/metrics/metrics`, {
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    });
    return res;
  };

  it('boots alongside a neighbor plugin (token + loopbackUrl configured)', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      logger: true,
      logLevel: 'silent', // real logger (so onResponse hooks run), no noise
      plugins: [
        {
          id: 'metrics',
          module: module_,
          prefix: '/metrics',
          config: { loopbackUrl: base, token: TOKEN },
        },
        { id: 'neighbor', module: fixture_, prefix: '/neighbor' },
      ],
    });
  });

  it('GET /metrics/healthz is 200 ok, open (no token), with the loopback check', async () => {
    const res = await fetch(`${base}/metrics/healthz`); // no Authorization
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.ok(typeof body.uptime_seconds === 'number' && body.uptime_seconds > 0);
    assert.strictEqual(body.checks.process.ok, true);
    assert.strictEqual(body.checks.loopback.ok, true, 'loopback check present and passing');
    assert.ok(typeof body.checks.loopback.status === 'number');
  });

  it('GET /metrics/metrics requires the Bearer token when config.token is set', async () => {
    const anon = await scrape(null);
    assert.strictEqual(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /^Bearer/);

    const wrong = await scrape('not-the-token');
    assert.strictEqual(wrong.status, 401);

    // Same-length wrong token (the compare hashes first, so length is moot).
    const sameLen = await scrape('x'.repeat(TOKEN.length));
    assert.strictEqual(sameLen.status, 401);

    const right = await scrape();
    assert.strictEqual(right.status, 200);
  });

  it('exposition is well-formed Prometheus text with the process gauges', async () => {
    const res = await scrape();
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    const text = await res.text();

    assert.match(text, /^# TYPE process_uptime_seconds gauge$/m);
    assert.match(text, /^process_uptime_seconds \d+(\.\d+)?$/m, 'well-formed sample value');
    for (const name of [
      'process_resident_memory_bytes',
      'process_heap_used_bytes',
      'process_heap_total_bytes',
      'process_cpu_user_seconds_total',
      'process_cpu_system_seconds_total',
      'nodejs_eventloop_lag_seconds',
    ]) {
      assert.match(text, new RegExp(`^${name} \\d+(\\.\\d+)?(e[-+]?\\d+)?$`, 'mi'), name);
    }
    // Counters really count upward: rss/heap are positive.
    const rss = Number(/^process_resident_memory_bytes (\S+)$/m.exec(text)[1]);
    assert.ok(rss > 1e6, `plausible RSS, got ${rss}`);
  });

  it('request counters observe THIS plugin and the NEIGHBOR plugin, never core (the discovered hook scope)', async () => {
    // Traffic: 3x own healthz, 2x the neighbor's route, and two core
    // routes (the UI root and an LDP pod path).
    for (let i = 0; i < 3; i++) assert.strictEqual((await fetch(`${base}/metrics/healthz`)).status, 200);
    for (let i = 0; i < 2; i++) assert.strictEqual((await fetch(`${base}/neighbor/ping`)).status, 200);
    await fetch(`${base}/`);
    await fetch(`${base}/nobody/nothing.txt`);

    const text = await (await scrape()).text();
    const count = (method, route, status) => {
      const m = new RegExp(
        `^jss_plugin_http_requests_total\\{method="${method}",route="${route.replace(/[/*]/g, '\\$&')}",status="${status}"\\} (\\d+)$`, 'm',
      ).exec(text);
      return m ? Number(m[1]) : 0;
    };

    // (a) Own routes: counted (>= because earlier tests hit healthz too).
    assert.ok(count('GET', '/metrics/healthz', 200) >= 3, 'own route counted');
    // Self-scrapes count as well — /metrics/metrics saw the 401s and 200s above.
    assert.ok(count('GET', '/metrics/metrics', 200) >= 1, 'self-scrape counted');
    assert.ok(count('GET', '/metrics/metrics', 401) >= 2, 'auth refusals counted');

    // (b) ANOTHER plugin's route: counted. All plugin entries activate in
    // ONE shared Fastify register scope, so an api.fastify hook observes
    // every plugin's routes — a wider grant than "your own prefix".
    assert.strictEqual(count('GET', '/neighbor/ping', 200), 2, "neighbor plugin's route counted");

    // (c) Core routes: NEVER counted. Fastify encapsulation shields the
    // parent instance — core's UI root, LDP catch-all and /.well-known
    // don't run plugin hooks, so no core series can appear.
    assert.ok(!text.includes('route="/"'), 'core UI root not counted');
    assert.ok(!text.includes('route="/*"'), 'core catch-all not counted');
    assert.ok(!text.includes('nobody'), 'core LDP path not counted');

    // Duration summary covers the counted requests.
    const sum = Number(/^jss_plugin_http_request_duration_seconds_sum (\S+)$/m.exec(text)[1]);
    const n = Number(/^jss_plugin_http_request_duration_seconds_count (\d+)$/m.exec(text)[1]);
    assert.ok(n >= 8, `duration count covers plugin traffic, got ${n}`);
    assert.ok(sum > 0, 'duration sum accumulates');
  });

  it('without loopbackUrl, healthz degrades gracefully to plain process liveness (and /metrics is open without token)', async () => {
    const s = await startJss({
      logger: true,
      logLevel: 'silent',
      plugins: [{ id: 'metrics', module: module_, prefix: '/metrics' }], // no config at all
    });
    extra.push(s);
    const res = await fetch(`${s.base}/metrics/healthz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.checks.loopback, undefined, 'no loopback check without loopbackUrl');

    const metrics = await fetch(`${s.base}/metrics/metrics`); // no token configured -> open
    assert.strictEqual(metrics.status, 200);
    assert.match(await metrics.text(), /^process_uptime_seconds /m);
  });

  it('a failing loopback probe turns healthz into 503 degraded', async () => {
    const deadPort = await probePort(); // probed then released: nothing listens
    const s = await startJss({
      logger: true,
      logLevel: 'silent',
      plugins: [{
        id: 'metrics',
        module: module_,
        prefix: '/metrics',
        config: { loopbackUrl: `http://127.0.0.1:${deadPort}` },
      }],
    });
    extra.push(s);
    const res = await fetch(`${s.base}/metrics/healthz`);
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.strictEqual(body.status, 'degraded');
    assert.strictEqual(body.checks.loopback.ok, false);
    assert.ok(body.checks.loopback.error, 'failure reason reported');
  });
});
