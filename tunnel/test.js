// Tunnel plugin over a real JSS from npm, end-to-end: a real local HTTP
// target, a tunnel client on the control WebSocket, and public fetches
// through {prefix}/{name}/… — headers, bodies, credential hygiene (#530),
// disconnect and timeout behavior.
//
// Auth: registration is gated on api.auth.getAgent, so the test client
// self-mints NIP-98 credentials (kind-27235 Schnorr event over the control
// URL) — the one scheme a test can create without an IdP round-trip. The
// agent id comes back as did:nostr:<pubkey>.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { schnorr } from '@noble/curves/secp256k1';
import { startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const entry = {
  module: path.join(__dirname, 'plugin.js'),
  prefix: '/tunnel',
  config: { requestTimeout: 2000 }, // short so the 504 test is quick
};

// ---- minimal NIP-98 signer (same schnorr pattern as relay/nip01.js) ----
// One keypair for the whole file: the host's did:nostr resolution result
// is cached per pubkey, so only the first connect pays the resolver.
const SK = schnorr.utils.randomPrivateKey();
const PUBKEY = Buffer.from(schnorr.getPublicKey(SK)).toString('hex');

function nip98Auth(url, method = 'GET') {
  const event = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', url], ['method', method]],
    content: '',
    pubkey: PUBKEY,
  };
  const payload = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  event.id = createHash('sha256').update(payload, 'utf8').digest('hex');
  event.sig = Buffer.from(schnorr.sign(event.id, SK)).toString('hex');
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

// ---- ws helpers --------------------------------------------------------
function waitMsg(ws, types, timeout = 5000) {
  const wanted = Array.isArray(types) ? types : [types];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${wanted.join('|')}`));
    }, timeout);
    function onMessage(data) {
      const msg = JSON.parse(String(data));
      if (wanted.includes(msg.type)) {
        cleanup();
        resolve(msg);
      }
    }
    function onClose() {
      cleanup();
      reject(new Error(`ws closed while waiting for ${wanted.join('|')}`));
    }
    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

/** Forward one proxied request to the local target over real HTTP. */
function forwardRequest(ws, msg, port) {
  const headers = { ...msg.headers };
  delete headers.host;
  const req = http.request({ host: '127.0.0.1', port, path: msg.path, method: msg.method, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const out = { ...res.headers };
      delete out.connection;
      delete out['transfer-encoding'];
      delete out['content-length']; // fastify recomputes for the decoded body
      ws.send(JSON.stringify({
        type: 'response', id: msg.id, status: res.statusCode,
        headers: out, body: Buffer.concat(chunks).toString('base64'), bodyEncoding: 'base64',
      }));
    });
  });
  req.on('error', () => {
    ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 502, headers: {}, body: 'target unreachable' }));
  });
  if (msg.body) req.end(msg.bodyEncoding === 'base64' ? Buffer.from(msg.body, 'base64') : msg.body);
  else req.end();
}

/**
 * Connect an authenticated tunnel client, register `name`, return
 * { ws, ack }. With targetPort set it acts as a real tunnel client,
 * forwarding proxied requests to the local target; with onRequest it
 * hands frames to the test; with neither it ignores them (for the
 * disconnect/timeout tests).
 */
async function openTunnel(jss, name, { passthrough, targetPort, onRequest } = {}) {
  const ws = new WebSocket(`${jss.wsBase}/tunnel/connect`, {
    headers: { authorization: nip98Auth(`${jss.base}/tunnel/connect`) },
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type !== 'request') return;
    if (targetPort) forwardRequest(ws, msg, targetPort);
    else if (onRequest) onRequest(msg);
  });
  // Generous first-connect budget: the host may consult the external
  // did:nostr resolver once (timeout-bounded, then cached per pubkey).
  const ackPromise = waitMsg(ws, ['registered', 'error'], 15_000);
  ws.send(JSON.stringify({ type: 'register', name, ...(passthrough !== undefined && { passthrough }) }));
  return { ws, ack: await ackPromise };
}

describe('tunnel plugin', () => {
  let jss;
  let target;
  let targetPort;
  const seen = []; // every request the local target received

  before(async () => {
    target = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url.startsWith('/api/hello')) {
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-target': 'reached',
            'set-cookie': 'target-cookie=1; Path=/',
          });
          res.end(JSON.stringify({ hello: 'world', path: req.url }));
        } else if (req.method === 'POST') {
          res.writeHead(201, { 'content-type': 'text/plain' });
          res.end(`got:${body}`);
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      });
    });
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetPort = target.address().port;
    jss = await startJss({ plugins: [entry] });
  });

  after(async () => {
    if (jss) await jss.close();
    if (target) await new Promise((resolve) => target.close(resolve));
  });

  it('rejects unauthenticated control connections', async () => {
    const ws = new WebSocket(`${jss.wsBase}/tunnel/connect`);
    const msg = await waitMsg(ws, 'error', 10_000);
    assert.ok(msg.message.includes('Authentication'), msg.message);
    ws.close();
  });

  it('registers a tunnel and proxies GET end-to-end to a real local server', async () => {
    const { ws, ack } = await openTunnel(jss, 'dev', { targetPort });
    assert.strictEqual(ack.type, 'registered');
    assert.strictEqual(ack.name, 'dev');
    assert.strictEqual(ack.url, '/tunnel/dev/');
    assert.strictEqual(ack.passthrough, false);

    const res = await fetch(`${jss.base}/tunnel/dev/api/hello?x=1`, {
      headers: { 'x-custom-request': 'to-tunnel' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-target'), 'reached');
    const body = await res.json();
    assert.strictEqual(body.hello, 'world');
    assert.strictEqual(body.path, '/api/hello?x=1'); // prefix stripped, query kept

    const hit = seen.at(-1);
    assert.strictEqual(hit.method, 'GET');
    assert.strictEqual(hit.url, '/api/hello?x=1');
    assert.strictEqual(hit.headers['x-custom-request'], 'to-tunnel');
    ws.close();
  });

  it('POST bodies round-trip byte-exact (raw pass-through parser)', async () => {
    const { ws } = await openTunnel(jss, 'postapp', { targetPort });
    // Pretty-printed JSON: a parse-and-reserialize proxy would minify it.
    const raw = '{\n  "name": "test",\n  "pretty": true\n}';
    const res = await fetch(`${jss.base}/tunnel/postapp/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(await res.text(), `got:${raw}`);
    assert.strictEqual(seen.at(-1).body, raw, 'target must receive the exact bytes sent');
    ws.close();
  });

  it('strips visitor credentials both ways by default (#530)', async () => {
    const { ws } = await openTunnel(jss, 'noauth', { targetPort });
    const res = await fetch(`${jss.base}/tunnel/noauth/api/hello`, {
      headers: { cookie: 'session=secret', authorization: 'Bearer visitor-token' },
    });
    assert.strictEqual(res.status, 200);
    const hit = seen.at(-1);
    assert.strictEqual(hit.headers.cookie, undefined, 'cookie must not reach the target');
    assert.strictEqual(hit.headers.authorization, undefined, 'authorization must not reach the target');
    if (typeof res.headers.getSetCookie === 'function') {
      assert.deepStrictEqual(res.headers.getSetCookie(), [], 'target set-cookie must not reach the visitor');
    } else {
      assert.strictEqual(res.headers.get('set-cookie'), null);
    }
    ws.close();
  });

  it('passthrough forwards credentials in and Set-Cookie out, minus relay session cookies (#530)', async () => {
    const { ws, ack } = await openTunnel(jss, 'authapp', { targetPort, passthrough: true });
    assert.strictEqual(ack.passthrough, true);
    const res = await fetch(`${jss.base}/tunnel/authapp/api/hello`, {
      headers: {
        cookie: 'appsid=keep; _session=relay-secret; _interaction=flow',
        authorization: 'Bearer visitor-token',
      },
    });
    assert.strictEqual(res.status, 200);
    const hit = seen.at(-1);
    assert.strictEqual(hit.headers.authorization, 'Bearer visitor-token');
    assert.strictEqual(hit.headers.cookie, 'appsid=keep', 'relay IdP cookies must be filtered out');
    const setCookie = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie().join('; ')
      : (res.headers.get('set-cookie') || '');
    assert.ok(setCookie.includes('target-cookie=1'), `set-cookie must survive passthrough; got: ${setCookie}`);
    ws.close();
  });

  it('rejects the reserved name "connect" and invalid names', async () => {
    const { ws, ack } = await openTunnel(jss, 'connect');
    assert.strictEqual(ack.type, 'error');
    assert.ok(ack.message.includes('reserved'), ack.message);

    const errPromise = waitMsg(ws, 'error');
    ws.send(JSON.stringify({ type: 'register', name: '...' }));
    const err = await errPromise;
    assert.ok(err.message.includes('Invalid'), err.message);
    ws.close();
  });

  it('returns 502 for an unregistered tunnel', async () => {
    const res = await fetch(`${jss.base}/tunnel/nonexistent/path`);
    assert.strictEqual(res.status, 502);
  });

  it('redirects {prefix}/{name} to the trailing-slash form (308)', async () => {
    const { ws } = await openTunnel(jss, 'redir', { targetPort });
    const res = await fetch(`${jss.base}/tunnel/redir`, { redirect: 'manual' });
    assert.strictEqual(res.status, 308);
    assert.strictEqual(res.headers.get('location'), '/tunnel/redir/');
    ws.close();
  });

  it('resolves in-flight requests with 502 when the tunnel disconnects', async () => {
    let sawRequest;
    const gotRequest = new Promise((resolve) => { sawRequest = resolve; });
    const { ws } = await openTunnel(jss, 'flaky', { onRequest: sawRequest });

    const resPromise = fetch(`${jss.base}/tunnel/flaky/hang`);
    await gotRequest; // the proxy delivered the frame; now vanish
    ws.close();
    const res = await resPromise;
    assert.strictEqual(res.status, 502);
    assert.strictEqual(await res.text(), 'Tunnel disconnected');

    // ...and the public path stays 502 after the disconnect.
    const later = await fetch(`${jss.base}/tunnel/flaky/hang`);
    assert.strictEqual(later.status, 502);
    const body = await later.json();
    assert.strictEqual(body.message, 'Tunnel not connected');
  });

  it('times out unanswered requests with 504', async () => {
    const { ws } = await openTunnel(jss, 'slow'); // ignores request frames
    const res = await fetch(`${jss.base}/tunnel/slow/never`);
    assert.strictEqual(res.status, 504);
    assert.strictEqual(await res.text(), 'Gateway Timeout');
    ws.close();
  });
});
