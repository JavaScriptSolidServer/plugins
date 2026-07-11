// oEmbed provider plugin over a real JSS from npm: seed a pod with a
// hand-crafted (fully valid) PNG, a GIF, a JPEG, an HTML page, a Micropub
// h-entry JSON post and a plain text note, then unfurl each through
// GET /oembed?url=… — photo dimension extraction, the link-not-rich HTML
// safety choice, the local-URL-only guard, the private→404 collapse, both
// output formats, and the /discover helper.
//
// Same probe-port-then-boot dance as rss/sparql/webdav (api.serverInfo
// finding), and the misconfiguration tests run FIRST because a failed second
// createServer re-points JSS's process-global data root and would poison the
// live server (the DATA_ROOT footgun).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const PASSWORD = 'correct-horse-battery';

async function registerAndMint(base, username) {
  const reg = await fetch(`${base}/idp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, confirmPassword: PASSWORD }),
  });
  assert.ok(reg.status < 400, `register ${username}: ${reg.status}`);
  const cred = await fetch(`${base}/idp/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const body = await cred.json();
  assert.ok(body.access_token, `mint ${username} failed: ${JSON.stringify(body)}`);
  return body; // { access_token, webid }
}

// ------------------------------------------------- hand-crafted test images

/** CRC-32 (the PNG polynomial), table-less. */
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** One PNG chunk: length + type + data + CRC(type+data). */
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** A complete, valid black RGB PNG of the given size (real IHDR/IDAT/IEND). */
function makePng(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // raw scanlines: filter byte 0 + width*3 zero bytes per row, deflated.
  const raw = Buffer.alloc(height * (1 + width * 3));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A minimal GIF89a: header + logical screen descriptor + trailer. */
function makeGif(width, height) {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return Buffer.concat([head, Buffer.from([0x3b])]); // trailer
}

/** A minimal JPEG: SOI + one SOF0 frame header + EOI. */
function makeJpeg(width, height) {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // 3 components
  sof.set([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 10);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

// ------------------------------------------------------------------- suite

describe('oembed provider plugin', () => {
  let jss;
  let base;
  let alice; // { access_token, webid }

  const oembed = (params, { token } = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`${base}/oembed?${qs}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  };

  after(async () => { if (jss) await jss.close(); });

  // Misconfiguration FIRST — a second createServer, even a failing one,
  // re-points the process-global data root (DATA_ROOT footgun).
  it('refuses to boot without config.baseUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ id: 'oembed', module: module_, prefix: '/oembed' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('refuses to boot without config.loopbackUrl', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'oembed', module: module_, prefix: '/oembed',
          config: { baseUrl: 'http://127.0.0.1:1' },
        }],
      }),
      /requires config\.loopbackUrl/,
    );
  });

  it('boots with idp, registers alice, seeds pod resources', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        id: 'oembed',
        module: module_,
        prefix: '/oembed',
        config: { baseUrl: base, loopbackUrl: base },
      }],
    });
    alice = await registerAndMint(base, 'alice');

    const put = async (p, body, contentType) => {
      const res = await fetch(base + p, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          authorization: `Bearer ${alice.access_token}`,
        },
        body,
      });
      assert.ok(res.status < 400, `seed ${p}: ${res.status}`);
    };

    await put('/alice/pics/photo.png', makePng(40, 30), 'image/png');
    await put('/alice/pics/anim.gif', makeGif(12, 7), 'image/gif');
    await put('/alice/pics/shot.jpg', makeJpeg(7, 5), 'image/jpeg');
    await put('/alice/pics/broken.png', Buffer.from('not actually a png'), 'image/png');
    await put('/alice/page.html', '<h1>My page</h1><script>alert(1)</script>', 'text/html');
    await put('/alice/posts/note.json', JSON.stringify({
      type: ['h-entry'],
      properties: { name: ['Hello oEmbed'], content: ['a note body'] },
    }), 'application/json');
    await put('/alice/posts/data.json', JSON.stringify({ plain: 'not micropub' }), 'application/json');
    await put('/alice/notes/plain.txt', 'just some text', 'text/plain');
  });

  it('image → photo with width/height parsed from the PNG bytes', async () => {
    const res = await oembed({ url: `${base}/alice/pics/photo.png` }, { token: alice.access_token });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const doc = await res.json();
    assert.strictEqual(doc.type, 'photo');
    assert.strictEqual(doc.url, `${base}/alice/pics/photo.png`);
    assert.strictEqual(doc.width, 40, 'width must come from the PNG IHDR');
    assert.strictEqual(doc.height, 30, 'height must come from the PNG IHDR');
    assert.strictEqual(doc.version, '1.0');
    assert.strictEqual(doc.title, 'photo');
  });

  it('GIF and JPEG dimensions parse too', async () => {
    const gif = await (await oembed({ url: `${base}/alice/pics/anim.gif` }, { token: alice.access_token })).json();
    assert.strictEqual(gif.type, 'photo');
    assert.strictEqual(gif.width, 12);
    assert.strictEqual(gif.height, 7);

    const jpg = await (await oembed({ url: `${base}/alice/pics/shot.jpg` }, { token: alice.access_token })).json();
    assert.strictEqual(jpg.type, 'photo');
    assert.strictEqual(jpg.width, 7);
    assert.strictEqual(jpg.height, 5);
  });

  it('maxwidth/maxheight scale the declared dimensions proportionally', async () => {
    const halved = await (await oembed({
      url: `${base}/alice/pics/photo.png`, maxwidth: '20',
    }, { token: alice.access_token })).json();
    assert.strictEqual(halved.width, 20);
    assert.strictEqual(halved.height, 15);

    const capped = await (await oembed({
      url: `${base}/alice/pics/photo.png`, maxheight: '10',
    }, { token: alice.access_token })).json();
    assert.strictEqual(capped.height, 10);
    assert.strictEqual(capped.width, 13); // floor(40 * 10/30)

    // Constraints larger than the image change nothing.
    const untouched = await (await oembed({
      url: `${base}/alice/pics/photo.png`, maxwidth: '1000', maxheight: '1000',
    }, { token: alice.access_token })).json();
    assert.strictEqual(untouched.width, 40);
    assert.strictEqual(untouched.height, 30);
  });

  it('an unparseable image falls through to link (never a photo without dimensions)', async () => {
    const doc = await (await oembed({ url: `${base}/alice/pics/broken.png` }, { token: alice.access_token })).json();
    assert.strictEqual(doc.type, 'link');
    assert.strictEqual(doc.width, undefined);
    assert.strictEqual(doc.height, undefined);
  });

  it('text/html → link, never rich, and no pod HTML in the response', async () => {
    const res = await oembed({ url: `${base}/alice/page.html` }, { token: alice.access_token });
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    const doc = JSON.parse(body);
    assert.strictEqual(doc.type, 'link', 'HTML must map to link, not rich (XSS)');
    assert.strictEqual(doc.html, undefined, 'no html field may be emitted');
    assert.ok(!body.includes('alert(1)'), 'pod-authored markup must not leak into the oEmbed doc');
    assert.strictEqual(doc.title, 'page');
  });

  it('a Micropub h-entry JSON post → link with the h-entry name as title', async () => {
    const doc = await (await oembed({ url: `${base}/alice/posts/note.json` }, { token: alice.access_token })).json();
    assert.strictEqual(doc.type, 'link');
    assert.strictEqual(doc.title, 'Hello oEmbed');
  });

  it('non-micropub JSON and plain text → link with the filename as title', async () => {
    const data = await (await oembed({ url: `${base}/alice/posts/data.json` }, { token: alice.access_token })).json();
    assert.strictEqual(data.type, 'link');
    assert.strictEqual(data.title, 'data');

    const txt = await (await oembed({ url: `${base}/alice/notes/plain.txt` }, { token: alice.access_token })).json();
    assert.strictEqual(txt.type, 'link');
    assert.strictEqual(txt.title, 'plain');
  });

  it('provider fields are present on every response', async () => {
    const doc = await (await oembed({ url: `${base}/alice/notes/plain.txt` }, { token: alice.access_token })).json();
    assert.strictEqual(doc.version, '1.0');
    assert.strictEqual(doc.provider_name, 'Solid Pod');
    assert.strictEqual(doc.provider_url, base);
  });

  it('external or malformed urls are 400 — never fetched', async () => {
    for (const url of ['https://example.com/photo.png', 'http://127.0.0.1:1/x', 'not-a-url', '']) {
      const res = await oembed(url === '' ? {} : { url });
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(url)}`);
      const doc = await res.json();
      assert.ok(doc.error, 'error body must carry an error field');
    }
  });

  it('a private resource is oEmbed 404 for anonymous callers (WAC via loopback)', async () => {
    // Everything under /alice/ is owner-only by default — the consumer view.
    const res = await oembed({ url: `${base}/alice/pics/photo.png` });
    assert.strictEqual(res.status, 404);
    assert.match((await res.json()).error, /not found/);

    // A resource that does not exist at all looks exactly the same.
    const gone = await oembed({ url: `${base}/alice/pics/nope.png` }, { token: alice.access_token });
    assert.strictEqual(gone.status, 404);
  });

  it('format=xml renders an <oembed> document; unknown formats are 501', async () => {
    const res = await oembed({
      url: `${base}/alice/pics/photo.png`, format: 'xml',
    }, { token: alice.access_token });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/xml/);
    const xml = await res.text();
    assert.ok(xml.includes('<oembed>'), xml);
    assert.ok(xml.includes('<type>photo</type>'), xml);
    assert.ok(xml.includes('<width>40</width>'), xml);
    assert.ok(xml.includes('<height>30</height>'), xml);
    assert.ok(xml.includes('<version>1.0</version>'), xml);

    const bad = await oembed({ url: `${base}/alice/pics/photo.png`, format: 'yaml' });
    assert.strictEqual(bad.status, 501);
    assert.match((await bad.json()).error, /not implemented/);
  });

  it('GET /oembed/discover returns the <link> tags to paste into HTML', async () => {
    const target = `${base}/alice/page.html`;
    const res = await fetch(`${base}/oembed/discover?url=${encodeURIComponent(target)}`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.ok(text.includes('rel="alternate"'), text);
    assert.ok(text.includes('type="application/json+oembed"'), text);
    assert.ok(text.includes('type="text/xml+oembed"'), text);
    // The href points back at this endpoint with the target url encoded,
    // and is attribute-escaped (& → &amp;).
    assert.ok(text.includes(`${base}/oembed?url=${encodeURIComponent(target)}&amp;format=json`), text);

    // The guard applies here too.
    const bad = await fetch(`${base}/oembed/discover?url=${encodeURIComponent('https://example.com/x')}`);
    assert.strictEqual(bad.status, 400);
  });
});
