// CORS proxy plugin over a real JSS from npm: proxying, CORS headers,
// preflight, and — the point — the SSRF gates. A tiny local upstream plays
// "the internet"; it lives on 127.0.0.1, so the proxying instance must
// allowlist it, which conveniently makes both allowlist directions and the
// bare private-IP guard all testable against real sockets.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

describe('corsproxy plugin', () => {
  let jss;
  let base;
  let upstream;
  let up; // upstream base url, http://127.0.0.1:<port>

  before(async () => {
    // --- the upstream the proxy will fetch from ------------------------
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const [route] = req.url.split('?');
        if (route === '/hello') {
          res.setHeader('content-type', 'text/plain');
          res.setHeader('x-upstream', 'yes');
          res.end('hello through the proxy');
        } else if (route === '/echo') {
          res.setHeader('content-type', req.headers['content-type'] || 'application/octet-stream');
          res.end(body);
        } else if (route === '/headers') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(req.headers));
        } else if (route === '/big') {
          res.setHeader('content-type', 'text/plain');
          res.end('x'.repeat(1000));
        } else if (route === '/redirect-private') {
          // An allowlisted upstream bouncing the proxy at a NON-allowlisted
          // private target — the redirect re-validation must catch it.
          res.statusCode = 302;
          res.setHeader('location', `http://localhost:${upstream.address().port}/hello`);
          res.end();
        } else {
          res.statusCode = 404;
          res.end('no such upstream route');
        }
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    up = `http://127.0.0.1:${upstream.address().port}`;

    // --- one JSS, four proxy configurations ----------------------------
    jss = await startJss({
      plugins: [
        { id: 'corsproxy', module: module_, prefix: '/proxy', config: { allowHosts: ['127.0.0.1'] } },
        { id: 'corsproxy-open', module: module_, prefix: '/open', config: {} },
        { id: 'corsproxy-tiny', module: module_, prefix: '/tiny', config: { allowHosts: ['127.0.0.1'], maxBodyBytes: 10 } },
        { id: 'corsproxy-auth', module: module_, prefix: '/authed', config: { allowHosts: ['127.0.0.1'], requireAuth: true } },
      ],
    });
    base = jss.base;
  });

  after(async () => {
    if (jss) await jss.close();
    if (upstream) await new Promise((resolve) => upstream.close(resolve));
  });

  const viaProxy = (target, init) => fetch(`${base}/proxy?url=${encodeURIComponent(target)}`, init);

  // ------------------------------------------------------------ proxying

  it('proxies a GET: body, status, upstream headers, CORS header', async () => {
    const res = await viaProxy(`${up}/hello`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'hello through the proxy');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(res.headers.get('x-upstream'), 'yes'); // upstream headers forwarded
    assert.strictEqual(res.headers.get('content-type'), 'text/plain');
  });

  it('supports the path form {prefix}/<url>', async () => {
    const res = await fetch(`${base}/proxy/${encodeURIComponent(`${up}/hello`)}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'hello through the proxy');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  });

  it('forwards a POST body byte-exact', async () => {
    const payload = JSON.stringify({ x: 42, y: 'hi' });
    const res = await viaProxy(`${up}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), payload);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  });

  it('forwards upstream error statuses, still with CORS', async () => {
    const res = await viaProxy(`${up}/definitely-missing`);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  });

  it('answers OPTIONS preflight with CORS headers', async () => {
    const res = await fetch(`${base}/proxy?url=${encodeURIComponent(`${up}/hello`)}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-upstream-authorization',
      },
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('access-control-allow-headers'), /x-upstream-authorization/i);
  });

  // ------------------------------------------------------ credential hygiene

  it('never forwards the pod Authorization; X-Upstream-Authorization opts in', async () => {
    const res = await viaProxy(`${up}/headers`, {
      headers: {
        authorization: 'Bearer pod-secret',
        'x-upstream-authorization': 'Bearer upstream-token',
        cookie: 'session=abc',
      },
    });
    assert.strictEqual(res.status, 200);
    const seen = await res.json();
    assert.strictEqual(seen.authorization, 'Bearer upstream-token'); // renamed
    assert.strictEqual(seen.cookie, undefined);
    assert.strictEqual(seen['x-upstream-authorization'], undefined);
  });

  // ------------------------------------------------------------ SSRF gates

  it('REFUSES a private/loopback target when not allowlisted', async () => {
    // /open has no allowHosts — pure blockPrivate. The upstream is really
    // listening; only the gate stands between the proxy and it.
    const literal = await fetch(`${base}/open?url=${encodeURIComponent(`${up}/hello`)}`);
    assert.strictEqual(literal.status, 400);
    assert.strictEqual(literal.headers.get('access-control-allow-origin'), '*');

    const resolved = await fetch(`${base}/open?url=${encodeURIComponent(`http://localhost:${upstream.address().port}/hello`)}`);
    assert.strictEqual(resolved.status, 400); // localhost resolves to loopback

    for (const target of ['http://10.0.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
      const res = await fetch(`${base}/open?url=${encodeURIComponent(target)}`);
      assert.strictEqual(res.status, 400, `${target} must be refused`);
    }
  });

  it('allowHosts admits the listed host and ONLY the listed host', async () => {
    // 127.0.0.1 is allowlisted on /proxy (that is how every green test
    // above got through) — but localhost is not, even though it is the
    // same interface.
    const res = await fetch(`${base}/proxy?url=${encodeURIComponent(`http://localhost:${upstream.address().port}/hello`)}`);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /allowHosts/);
  });

  it('refuses non-http(s) schemes', async () => {
    for (const target of ['file:///etc/passwd', 'ftp://127.0.0.1/x', 'gopher://127.0.0.1/x']) {
      const res = await viaProxy(target);
      assert.strictEqual(res.status, 400, `${target} must be refused`);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    }
  });

  it('re-validates redirect targets (allowlisted host bouncing to a private one)', async () => {
    const res = await viaProxy(`${up}/redirect-private`);
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.message, /allowHosts|private/);
  });

  it('rejects a request with no target URL', async () => {
    const res = await fetch(`${base}/proxy`);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  });

  // ------------------------------------------------------------ resource caps

  it('caps the response body at maxBodyBytes', async () => {
    const res = await fetch(`${base}/tiny?url=${encodeURIComponent(`${up}/big`)}`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.strictEqual(text, 'x'.repeat(10)); // 1000 bytes upstream, 10 through
  });

  // ------------------------------------------------------------------ auth

  it('requireAuth: anonymous requests get 401 (with CORS)', async () => {
    const res = await fetch(`${base}/authed?url=${encodeURIComponent(`${up}/hello`)}`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.match(body.message, /Authentication/);
  });
});
