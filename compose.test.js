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

  it('boots pods + idp + thirty-three plugins from config', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-compose-'));
    jss = await startJss({
      port,
      root,
      idp: true,
      // The protocol shims own fixed roots outside their prefix — mastodon
      // (/api,/oauth), bluesky (/xrpc), activitypub (/ap), matrix (/_matrix)
      // — which a plugin can't self-exempt (finding), so the operator
      // widens appPaths.
      appPaths: ['/api', '/oauth', '/xrpc', '/ap', '/_matrix'],
      // Explicit ids: the <name>/plugin.js convention makes every basename
      // reduce to 'plugin' — the loader's duplicate-id guard requires ids
      // here (finding: derive from the parent dir for generic basenames).
      plugins: [
        { module: at('relay/plugin.js'), prefix: '/relay' },
        { module: at('webrtc/plugin.js'), prefix: '/webrtc' },
        { module: at('terminal/plugin.js'), prefix: '/terminal', config: { token: 'compose-secret' } },
        { module: at('tunnel/plugin.js'), prefix: '/tunnel' },
        {
          module: at('notifications/plugin.js'),
          prefix: '/.notifications',
          config: { podsRoot: root, baseUrl: base },
        },
        { module: at('pay/plugin.js'), prefix: '/paid', config: { cost: 2, address: 'x' } },
        { module: at('nip05/plugin.js'), prefix: '/nip05', config: { podsRoot: root } },
        { module: at('corsproxy/plugin.js'), prefix: '/proxy', config: {} },
        { module: at('capability/plugin.js'), prefix: '/cap', config: {} },
        { module: at('webdav/plugin.js'), prefix: '/webdav', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('gitscratch/plugin.js'), prefix: '/git', config: {} },
        { module: at('sparql/plugin.js'), prefix: '/sparql', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('otp/plugin.js'), prefix: '/otp', config: {} },
        { module: at('carddav/plugin.js'), prefix: '/carddav', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('mastodon/plugin.js'), prefix: '/mastodon', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('bluesky/plugin.js'), prefix: '/bluesky', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('caldav/plugin.js'), prefix: '/caldav', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('webfinger/plugin.js'), prefix: '/webfinger', config: { podsRoot: root, baseUrl: base } },
        { module: at('activitypub/plugin.js'), prefix: '/activitypub', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('rss/plugin.js'), prefix: '/feed', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('matrix/plugin.js'), prefix: '/matrix', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('search/plugin.js'), prefix: '/search', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('didweb/plugin.js'), prefix: '/didweb', config: { podsRoot: root, baseUrl: base } },
        { module: at('s3/plugin.js'), prefix: '/s3', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('micropub/plugin.js'), prefix: '/micropub', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('backup/plugin.js'), prefix: '/backup', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('shortlink/plugin.js'), prefix: '/short', config: { baseUrl: base } },
        { module: at('oembed/plugin.js'), prefix: '/oembed', config: { baseUrl: base, loopbackUrl: base } },
        { module: at('jmap/plugin.js'), prefix: '/jmap', config: { baseUrl: base, loopbackUrl: base } },
        {
          module: at('remotestorage/plugin.js'),
          prefix: '/remotestorage',
          // webfinger/ already owns /.well-known/webfinger on this server —
          // the witnessed collision (see remotestorage/README.md) — so this
          // instance stands down and serves only its own-prefix JRD.
          config: { baseUrl: base, loopbackUrl: base, claimWellKnown: false },
        },
        { module: at('metrics/plugin.js'), prefix: '/metrics', config: { loopbackUrl: base } },
        {
          module: at('admin/plugin.js'),
          prefix: '/admin',
          // Auto-discovers via api.plugins (#610), origin via api.serverInfo
          // (#601) — no hand-fed list, no loopbackUrl. No adminAgents → open
          // mode (the plugin warns; the finding: no operator concept yet).
          config: {
            podsRoot: root,
            probes: {
              relay: { kind: 'ws' }, webrtc: { kind: 'ws' }, terminal: { kind: 'ws' },
              tunnel: { kind: 'ws' }, notifications: { kind: 'ws' },
            },
          },
        },
        {
          module: at('dashboard/plugin.js'),
          prefix: '/dashboard',
          // No hand-fed list and no loopbackUrl: the dashboard auto-discovers
          // every plugin via api.plugins (#610) and reaches the host via
          // api.serverInfo (#601). Only the WebSocket endpoints need a
          // refinement so a plain-GET upgrade refusal reads as alive.
          config: {
            probes: {
              relay: { kind: 'ws' }, webrtc: { kind: 'ws' }, terminal: { kind: 'ws' },
              tunnel: { kind: 'ws' }, notifications: { kind: 'ws' },
              // admin probes every plugin on page render; hit its cheap
              // healthz so the two ops consoles don't storm each other.
              admin: { probe: '/admin/healthz', expect: [200] },
            },
          },
        },
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

  it('matrix: the versions endpoint answers (fixed /_matrix root)', async () => {
    const res = await fetch(`${base}/_matrix/client/versions`);
    assert.strictEqual(res.status, 200);
  });

  it('search: missing query is 400 (endpoint alive)', async () => {
    const res = await fetch(`${base}/search`);
    assert.strictEqual(res.status, 400);
  });

  it('didweb: unknown pod DID is 404 (resolver alive)', async () => {
    const res = await fetch(`${base}/didweb/nobody/did.json`);
    assert.strictEqual(res.status, 404);
  });

  it('s3: an unauthenticated object GET is denied (gateway alive)', async () => {
    const res = await fetch(`${base}/s3/bucket/key`);
    assert.strictEqual(res.status, 403);
  });

  it('micropub: q=config answers; unauthenticated POST is 401', async () => {
    let res = await fetch(`${base}/micropub?q=config`);
    assert.strictEqual(res.status, 200);
    assert.ok('syndicate-to' in (await res.json()));
    res = await fetch(`${base}/micropub`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'h=entry&content=compose',
    });
    assert.strictEqual(res.status, 401);
  });

  it('backup: bare GET is 400 with usage (no whole-server export)', async () => {
    const res = await fetch(`${base}/backup`);
    assert.strictEqual(res.status, 400);
  });

  it('shortlink: anonymous mint is 401; unknown slug is 404', async () => {
    let res = await fetch(`${base}/short`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/x` }),
    });
    assert.strictEqual(res.status, 401);
    res = await fetch(`${base}/short/nosuchslug`, { redirect: 'manual' });
    assert.strictEqual(res.status, 404);
  });

  it('oembed: missing url is 400 (endpoint alive, never fetches external)', async () => {
    const res = await fetch(`${base}/oembed`);
    assert.strictEqual(res.status, 400);
  });

  it('jmap: anonymous session is 401; /.well-known/jmap redirects to it', async () => {
    let res = await fetch(`${base}/jmap/session`);
    assert.strictEqual(res.status, 401);
    res = await fetch(`${base}/.well-known/jmap`, { redirect: 'manual' });
    assert.strictEqual(res.status, 301);
  });

  it('remotestorage: own-prefix webfinger answers (well-known stood down to webfinger/)', async () => {
    const res = await fetch(`${base}/remotestorage/webfinger`);
    assert.strictEqual(res.status, 400); // missing ?resource — endpoint alive
  });

  it('admin: auto-discovers plugins (api.plugins) and reports pods stats', async () => {
    let res = await fetch(`${base}/admin/`);
    assert.strictEqual(res.status, 200);
    const page = await res.text();
    for (const id of ['nip05', 'metrics', 'rss', 's3']) assert.ok(page.includes(id), id);
    res = await fetch(`${base}/admin/status.json`);
    assert.strictEqual(res.status, 200);
    const status = await res.json();
    assert.strictEqual(status.server.alive, true);
    // Discovered ~every sibling, not a hand-fed few.
    assert.ok(status.plugins.length >= 25, `discovered only ${status.plugins.length}`);
    const byId = Object.fromEntries(status.plugins.map((p) => [p.id, p]));
    for (const id of ['nip05', 'rss', 'mastodon', 's3', 'metrics']) {
      assert.ok(byId[id]?.alive, `${id}: ${JSON.stringify(byId[id])}`);
    }
    // podsRoot configured → pod stats present.
    assert.ok(status.pods && typeof status.pods.count === 'number', JSON.stringify(status.pods));
  });

  it('metrics: healthz is ok and the exposition names the process gauges', async () => {
    let res = await fetch(`${base}/metrics/healthz`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).status, 'ok');
    res = await fetch(`${base}/metrics/metrics`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /process_uptime_seconds/);
  });

  it('dashboard: auto-discovers every plugin via api.plugins; status.json probes live', async () => {
    let res = await fetch(`${base}/dashboard/`);
    assert.strictEqual(res.status, 200);
    const page = await res.text();
    // Auto-discovered, not a hand-fed three — a broad sample must appear.
    for (const id of ['nip05', 'rss', 'relay', 's3', 'micropub', 'metrics']) {
      assert.ok(page.includes(id), id);
    }
    res = await fetch(`${base}/dashboard/status.json`);
    assert.strictEqual(res.status, 200);
    const status = await res.json();
    assert.strictEqual(status.server.alive, true);
    // Discovered ~every sibling (minus itself), far more than a curated list.
    assert.ok(status.plugins.length >= 25, `discovered only ${status.plugins.length}`);
    // The well-understood HTTP plugins answer <500 at their prefix → alive.
    const byId = Object.fromEntries(status.plugins.map((p) => [p.id, p]));
    for (const id of ['nip05', 'rss', 'mastodon', 's3', 'micropub', 'backup', 'metrics']) {
      assert.strictEqual(byId[id]?.alive, true, `${id}: ${JSON.stringify(byId[id])}`);
    }
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
