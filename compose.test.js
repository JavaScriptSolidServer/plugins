// The money shot: ONE JavaScript Solid Server from npm, EVERY plugin in
// this repo loaded from pure config, each surface exercised over the wire,
// pods + WAC intact beside them all.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { probePort, startJss } from './helpers.js';
import { finalizeEvent, generateSecretKey } from './relay/nip01.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const at = (p) => path.join(__dirname, p);

function openWs(url, headers) {
  const socket = new WebSocket(url, headers ? { headers } : undefined);
  return new Promise((resolve, reject) => {
    const lines = [];
    socket.on('message', (d) => lines.push(String(d)));
    socket.on('open', () => resolve({ socket, lines }));
    socket.on('error', reject);
  });
}

function waitFor(lines, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = lines.find(predicate);
      if (hit) { clearInterval(timer); resolve(hit); }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout; lines: ${JSON.stringify(lines.slice(0, 10))}`));
      }
    }, 25);
  });
}

describe('composition: every plugin on one server', () => {
  let jss;
  let base;
  let wsBase;

  after(async () => { if (jss) await jss.close(); });

  it('boots pods + idp + twenty plugins from config', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-compose-'));
    jss = await startJss({
      port,
      root,
      idp: true,
      // The protocol shims own fixed roots outside their prefix — mastodon
      // (/api,/oauth), bluesky (/xrpc), activitypub (/ap) — which a plugin
      // can't self-exempt (finding), so the operator widens appPaths.
      appPaths: ['/api', '/oauth', '/xrpc', '/ap'],
      // Explicit ids: the <name>/plugin.js convention makes every basename
      // reduce to 'plugin' — the loader's duplicate-id guard requires ids
      // here (finding: derive from the parent dir for generic basenames).
      plugins: [
        { id: 'relay', module: at('relay/plugin.js'), prefix: '/relay' },
        { id: 'webrtc', module: at('webrtc/plugin.js'), prefix: '/webrtc' },
        { id: 'terminal', module: at('terminal/plugin.js'), prefix: '/terminal', config: { token: 'compose-secret' } },
        { id: 'tunnel', module: at('tunnel/plugin.js'), prefix: '/tunnel' },
        {
          id: 'notifications',
          module: at('notifications/plugin.js'),
          prefix: '/.notifications',
          config: { podsRoot: root, baseUrl: base },
        },
        { id: 'pay', module: at('pay/plugin.js'), prefix: '/paid', config: { cost: 2, address: 'x' } },
        { id: 'nip05', module: at('nip05/plugin.js'), prefix: '/nip05', config: { podsRoot: root } },
        { id: 'corsproxy', module: at('corsproxy/plugin.js'), prefix: '/proxy', config: {} },
        { id: 'capability', module: at('capability/plugin.js'), prefix: '/cap', config: {} },
        { id: 'webdav', module: at('webdav/plugin.js'), prefix: '/webdav', config: { baseUrl: base, loopbackUrl: base } },
        { id: 'gitscratch', module: at('gitscratch/plugin.js'), prefix: '/git', config: {} },
        { id: 'sparql', module: at('sparql/plugin.js'), prefix: '/sparql', config: { baseUrl: base, loopbackUrl: base } },
        { id: 'otp', module: at('otp/plugin.js'), prefix: '/otp', config: {} },
        { id: 'carddav', module: at('carddav/plugin.js'), prefix: '/carddav', config: { baseUrl: base, loopbackUrl: base } },
        { id: 'mastodon', module: at('mastodon/plugin.js'), prefix: '/mastodon', config: { baseUrl: base, loopbackUrl: base } },
        { id: 'bluesky', module: at('bluesky/plugin.js'), prefix: '/bluesky', config: { baseUrl: base, loopbackUrl: base } },
        { id: 'caldav', module: at('caldav/plugin.js'), prefix: '/caldav', config: { baseUrl: base, loopbackUrl: base } },
        { id: 'webfinger', module: at('webfinger/plugin.js'), prefix: '/webfinger', config: { podsRoot: root, baseUrl: base } },
        { id: 'activitypub', module: at('activitypub/plugin.js'), prefix: '/activitypub', config: { baseUrl: base, loopbackUrl: base } },
        { id: 'rss', module: at('rss/plugin.js'), prefix: '/feed', config: { baseUrl: base, loopbackUrl: base } },
      ],
    });
    assert.ok(jss.base);
  });

  it('relay: signed event round-trips', async () => {
    const { socket, lines } = await openWs(`${wsBase}/relay`);
    const event = finalizeEvent({ kind: 1, content: 'compose' }, generateSecretKey());
    socket.send(JSON.stringify(['EVENT', event]));
    await waitFor(lines, (l) => {
      const m = JSON.parse(l);
      return m[0] === 'OK' && m[1] === event.id && m[2] === true;
    });
    socket.close();
  });

  it('webrtc: content-addressed room relays an offer between peers', async () => {
    // Anonymous content-addressed dialect (no credentials needed).
    const room = 'a'.repeat(64); // hex hash "resource"
    const a = await openWs(`${wsBase}/webrtc`);
    const b = await openWs(`${wsBase}/webrtc`);
    a.socket.send(JSON.stringify({ type: 'announce', resource: room, offers: [] }));
    await waitFor(a.lines, (l) => JSON.parse(l).type === 'resource-peers');
    b.socket.send(JSON.stringify({
      type: 'announce', resource: room,
      offers: [{ sdp: 'compose-offer', offer_id: 'o1' }],
    }));
    await waitFor(a.lines, (l) => {
      const m = JSON.parse(l);
      return m.type === 'offer' && m.offer_id === 'o1';
    });
    a.socket.close();
    b.socket.close();
  });

  it('terminal: token-gated shell echoes', async () => {
    const socket = new WebSocket(`${wsBase}/terminal?token=compose-secret`);
    let buf = '';
    socket.on('message', (d) => { buf += String(d); });
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 400)); // let the shell spawn
    socket.send('echo compose-ok\n');
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no echo; got ${JSON.stringify(buf)}`)), 5000);
      const iv = setInterval(() => {
        if (buf.includes('compose-ok')) { clearTimeout(t); clearInterval(iv); resolve(); }
      }, 25);
    });
    socket.close();
  });

  it('notifications: pod write fans out to a subscriber', async () => {
    fs.writeFileSync(
      path.join(jss.root, 'note.txt.acl'),
      `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#public> a acl:Authorization; acl:agentClass foaf:Agent;
  acl:accessTo <./note.txt>; acl:mode acl:Read.
`,
    );
    const { socket, lines } = await openWs(`${wsBase}/.notifications`);
    await waitFor(lines, (l) => l === 'protocol solid-0.1');
    socket.send(`sub ${base}/note.txt`);
    await waitFor(lines, (l) => l === `ack ${base}/note.txt`);
    fs.writeFileSync(path.join(jss.root, 'note.txt'), 'hello');
    await waitFor(lines, (l) => l === `pub ${base}/note.txt`);
    socket.close();
  });

  it('pay: 402 then paid content', async () => {
    let res = await fetch(`${base}/paid/demo`);
    assert.strictEqual(res.status, 402);
    res = await fetch(`${base}/paid/demo`, { headers: { 'x-payment-proof': 'demo-proof-of-payment' } });
    assert.strictEqual(res.status, 200);
  });

  it('nip05: serves the discovery document', async () => {
    const res = await fetch(`${base}/nip05/nostr.json`);
    assert.strictEqual(res.status, 200);
    assert.ok('names' in (await res.json()));
  });

  it('corsproxy: refuses a missing/blocked target but is alive', async () => {
    const res = await fetch(`${base}/proxy`); // no ?url
    assert.strictEqual(res.status, 400);
  });

  it('capability: minting requires identity (401 anon)', async () => {
    const res = await fetch(`${base}/cap/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: '/cap/x', modes: ['read'], ttl: 60 }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('webdav: OPTIONS advertises DAV class 1', async () => {
    const res = await fetch(`${base}/webdav/`, { method: 'OPTIONS' });
    assert.ok(res.status < 500);
    assert.match(res.headers.get('dav') || '', /1/);
  });

  it('gitscratch: an anonymous push is refused', async () => {
    const res = await fetch(`${base}/git/probe.git/info/refs?service=git-receive-pack`);
    assert.strictEqual(res.status, 401);
  });

  it('sparql: rejects a non-sparql content type (415)', async () => {
    const res = await fetch(`${base}/sparql`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'nope',
    });
    assert.ok([400, 415].includes(res.status), `got ${res.status}`);
  });

  it('otp: whoami without a session token is 401', async () => {
    const res = await fetch(`${base}/otp/whoami`);
    assert.strictEqual(res.status, 401);
  });

  it('carddav: OPTIONS advertises the addressbook', async () => {
    const res = await fetch(`${base}/carddav/`, { method: 'OPTIONS' });
    assert.ok(res.status < 500);
    assert.match(res.headers.get('dav') || '', /addressbook/);
  });

  it('mastodon: the instance endpoint answers (fixed /api root, appPaths-widened)', async () => {
    const res = await fetch(`${base}/api/v1/instance`);
    assert.strictEqual(res.status, 200);
    assert.ok('title' in (await res.json()));
  });

  it('bluesky: the XRPC describeServer answers (fixed /xrpc root)', async () => {
    const res = await fetch(`${base}/xrpc/com.atproto.server.describeServer`);
    assert.strictEqual(res.status, 200);
  });

  it('caldav: OPTIONS advertises calendar-access', async () => {
    const res = await fetch(`${base}/caldav/`, { method: 'OPTIONS' });
    assert.ok(res.status < 500);
    assert.match(res.headers.get('dav') || '', /calendar-access/);
  });

  it('webfinger: missing resource is 400 (endpoint alive)', async () => {
    const res = await fetch(`${base}/.well-known/webfinger`);
    assert.strictEqual(res.status, 400);
  });

  it('activitypub: unauthenticated outbox POST is refused', async () => {
    const res = await fetch(`${base}/ap/alice/outbox`, {
      method: 'POST', headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Note', content: 'x' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('rss: missing container is 400 (endpoint alive)', async () => {
    const res = await fetch(`${base}/feed/atom`);
    assert.strictEqual(res.status, 400);
  });

  it('pods still work beside all of it (idp register + WAC)', async () => {
    let res = await fetch(`${base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'composer', password: 'compose-pass', confirmPassword: 'compose-pass' }),
    });
    assert.ok(res.status < 400, `register: ${res.status}`);
    res = await fetch(`${base}/composer/private/x`, { method: 'PUT', body: 'nope' });
    assert.ok([401, 403].includes(res.status), `WAC: ${res.status}`);
  });
});
