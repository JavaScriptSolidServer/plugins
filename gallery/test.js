// Pod gallery over a real JSS from npm — the first api.mountApp (#583)
// consumer, so the tests are really probing the seam:
//
//   stream a multi-MB body through the raw handler into the pod (the
//   un-drained request stream the seam exists to provide), byte-identical;
//   WAC — not the plugin — refusing an anonymous write; the gallery page
//   walking the container; and core's LDP answering Range with a 206 slice
//   NATIVELY (so playback needs no plugin lane at all — a Finding).
//
// Zero-config boot: no baseUrl/loopbackUrl in the entry — api.serverInfo
// (#601) supplies the origin. The two validation-failure boots run FIRST
// (module-global DATA_ROOT footgun — see AGENT.md).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const USER = 'galleryalice';
const PASS = 'correct horse battery staple';

describe('gallery plugin', () => {
  let jss;
  let base;
  let token;
  const big = crypto.randomBytes(6 * 1024 * 1024); // 6 MB — big enough to matter
  let bigUrl;

  after(async () => { if (jss) await jss.close(); });

  // DATA_ROOT footgun: validation-failure boots MUST precede the long boot.
  it('refuses to boot with a malformed config.container', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'gallery', module: module_, prefix: '/gallery',
          config: { container: 'not-an-absolute-container' },
        }],
      }),
      /config\.container/,
    );
  });

  it('refuses to boot without a prefix — mountApp needs a mount', async () => {
    await assert.rejects(
      startJss({ plugins: [{ id: 'gallery', module: module_ }] }),
      /mountApp needs a prefix/,
    );
  });

  it('boots with NO plugin config at all (api.serverInfo supplies the origin), mints a bearer', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{ id: 'gallery', module: module_, prefix: '/gallery' }],
    });
    const reg = await fetch(`${base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, confirmPassword: PASS }),
    });
    assert.ok([200, 201, 302].includes(reg.status), `register: ${reg.status}`);
    const cred = await fetch(`${base}/idp/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    const body = await cred.json();
    assert.ok(body.access_token, `mint failed: ${JSON.stringify(body)}`);
    token = body.access_token;
  });

  it('streams a 6 MB upload into the pod byte-identically (the #583 lane)', async () => {
    const res = await fetch(`${base}/gallery/upload/big.bin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: big,
    });
    assert.strictEqual(res.status, 201, `upload: ${res.status} ${await res.clone().text()}`);
    const out = await res.json();
    bigUrl = res.headers.get('location');
    assert.strictEqual(bigUrl, `${base}/${USER}/public/gallery/big.bin`,
      'default container derives from the caller\'s own pod');
    assert.strictEqual(out.url, bigUrl);

    // Round-trip: the pod resource is byte-identical to what was sent.
    // /public/ is public-read under the seeded ACLs — no auth needed.
    const back = await fetch(bigUrl);
    assert.strictEqual(back.status, 200);
    assert.strictEqual(back.headers.get('accept-ranges'), 'bytes', 'core advertises byte ranges');
    const body = Buffer.from(await back.arrayBuffer());
    assert.strictEqual(body.length, big.length);
    assert.strictEqual(
      crypto.createHash('sha256').update(body).digest('hex'),
      crypto.createHash('sha256').update(big).digest('hex'),
      'downloaded bytes differ from uploaded bytes',
    );
  });

  it('anonymous upload to a pod container is refused by WAC (401/403), not by the plugin', async () => {
    const res = await fetch(`${base}/gallery/upload/nope.jpg?container=/${USER}/public/gallery/`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.from('not really a jpeg'),
    });
    assert.ok([401, 403].includes(res.status), `expected WAC refusal, got ${res.status}`);
    // Nothing landed.
    const gone = await fetch(`${base}/${USER}/public/gallery/nope.jpg`);
    assert.strictEqual(gone.status, 404);
  });

  it('traversal / dotted filenames are rejected before any pod call', async () => {
    // Names the plugin's own guard refuses (400): characters outside the
    // one-plain-segment allowlist. These sail past the host untouched.
    for (const name of ['bad%7Cname.png', 'sneaky%0a.png']) {
      const res = await fetch(`${base}/gallery/upload/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
        body: Buffer.from('x'),
      });
      assert.strictEqual(res.status, 400, `${name}: expected 400, got ${res.status}`);
    }
    // Dotted / traversal shapes never reach the pod: core 403s any dotted
    // path segment BEFORE the plugin runs, even under a WAC-exempt plugin
    // prefix (a Finding: the dot-guard outranks appPaths), and '%2e%2e'
    // is collapsed to '/gallery/' by WHATWG URL normalization on the
    // client itself, landing on the page route as a 405. Any refusing
    // layer is correct; nothing may land.
    for (const name of ['..%2Fescape.png', '.htaccess', '%2e%2e']) {
      const res = await fetch(`${base}/gallery/upload/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
        body: Buffer.from('x'),
      });
      assert.ok([400, 403, 405].includes(res.status), `${name}: expected refusal, got ${res.status}`);
    }
  });

  it('past bodyLimit, core LDP — not the mounted lane — refuses: 413 passthrough (a Finding)', async () => {
    // 21 MiB > the host's default 20 MiB bodyLimit. The mounted lane
    // streams it through UNCAPPED (the pass-through parser sidesteps the
    // host's buffering and its limit — the plugin must impose its own cap
    // if it ever stops forwarding to core); the refusal comes from core's
    // LDP buffering the loopback PUT, surfaced verbatim. The proof of the
    // layering is the body: it is the PLUGIN's passthrough JSON, so the
    // 21 MiB demonstrably crossed the mounted lane first.
    const res = await fetch(`${base}/gallery/upload/huge.bin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: crypto.randomBytes(21 * 1024 * 1024),
    });
    assert.strictEqual(res.status, 413, `expected 413, got ${res.status}`);
    const body = await res.json();
    assert.match(body.error, /pod storage rejected the upload \(413\)/,
      'the 413 should be core\'s, passed through the plugin lane');
  });

  it('the gallery page lists uploads with inline media tags (anonymous, public container)', async () => {
    // A couple of visual items alongside big.bin.
    for (const [name, type] of [['photo.png', 'image/png'], ['clip.mp4', 'video/mp4']]) {
      const up = await fetch(`${base}/gallery/upload/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': type },
        body: crypto.randomBytes(2048),
      });
      assert.strictEqual(up.status, 201, `${name}: ${up.status}`);
    }
    const res = await fetch(`${base}/gallery/?container=/${USER}/public/gallery/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    for (const needle of ['big.bin', 'photo.png', 'clip.mp4', '<img', '<video', '6.0 MB']) {
      assert.ok(html.includes(needle), `page is missing ${JSON.stringify(needle)}`);
    }
    // Media links point STRAIGHT at the pod resources (core serves Range).
    assert.ok(html.includes(`/${USER}/public/gallery/clip.mp4`), 'no direct pod link');
  });

  it('an authenticated page with no ?container derives the caller\'s own gallery', async () => {
    const res = await fetch(`${base}/gallery`, { headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes(`/${USER}/public/gallery/`), 'derived container not shown');
    assert.ok(html.includes('photo.png'), 'derived gallery not walked');
  });

  it('core LDP GET honors Range natively: 206 + Content-Range with the exact slice (Finding)', async () => {
    const start = 1024 * 1024;
    const end = start + 1023;
    const res = await fetch(bigUrl, { headers: { range: `bytes=${start}-${end}` } });
    assert.strictEqual(res.status, 206, 'core did not answer 206 — the gallery would need its own Range lane');
    assert.strictEqual(res.headers.get('content-range'), `bytes ${start}-${end}/${big.length}`);
    const slice = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(slice.length, 1024);
    assert.ok(slice.equals(big.subarray(start, end + 1)), 'the 206 body is not the requested slice');
  });

  it('a private container stays private: owner uploads land, strangers get WAC\'s 401', async () => {
    const priv = `/${USER}/private/gallery/`;
    const up = await fetch(`${base}/gallery/upload/secret.png?container=${encodeURIComponent(priv)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      body: crypto.randomBytes(512),
    });
    assert.strictEqual(up.status, 201, `owner upload: ${up.status} ${await up.clone().text()}`);

    // Anonymous: both the resource and the gallery page reflect WAC's verdict.
    const raw = await fetch(`${base}${priv}secret.png`);
    assert.ok([401, 403].includes(raw.status), `resource: expected 401/403, got ${raw.status}`);
    const anonPage = await fetch(`${base}/gallery/?container=${encodeURIComponent(priv)}`);
    assert.ok([401, 403].includes(anonPage.status), `page: expected 401/403, got ${anonPage.status}`);

    // The owner sees it — the page walks the container AS the caller.
    const ownerPage = await fetch(`${base}/gallery/?container=${encodeURIComponent(priv)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(ownerPage.status, 200);
    assert.ok((await ownerPage.text()).includes('secret.png'));
  });
});
