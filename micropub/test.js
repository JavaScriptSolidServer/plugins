// Micropub server over a real JSS from npm. Drives the vertical slice an
// IndieWeb client actually performs:
//
//   discover config  → GET  /micropub?q=config
//   post a note      → POST /micropub (form-encoded, then JSON)
//   read it back     → GET  the Location permalink / ?q=source
//   edit it          → POST action=update {replace}
//   delete it        → POST action=delete
//
// Same probe-port-then-boot dance as mastodon/: the plugin needs its server
// origin in config before listen (finding: api.serverInfo), and idp:true
// gives the /idp/register + /idp/credentials the token bridge rides on —
// the pod bearer IS the Micropub token, no token endpoint of our own.
// No appPaths needed: everything lives under the one plugin prefix.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const USER = 'indiealice';
const PASS = 'correct horse battery staple';

describe('micropub plugin', () => {
  let jss;
  let base;
  let mp; // the micropub endpoint
  let token;
  let noteUrl; // permalink of the form-encoded note
  let articleUrl; // permalink of the JSON article

  after(async () => { if (jss) await jss.close(); });

  // DATA_ROOT footgun: validation-failure boots MUST run before the
  // long-lived boot (a second createServer repoints the process global).
  it('refuses to boot without baseUrl (no api.serverInfo — same finding as mastodon/webdav)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/micropub' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('refuses to boot without loopbackUrl', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          module: module_, prefix: '/micropub', config: { baseUrl: 'http://example.test' },
        }],
      }),
      /requires config\.loopbackUrl/,
    );
  });

  it('boots with idp, registers a pod owner, and mints a bearer (the Micropub token)', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    mp = `${base}/micropub`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        id: 'micropub',
        module: module_,
        prefix: '/micropub',
        config: { baseUrl: base, loopbackUrl: base },
      }],
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

  it('GET ?q=config returns the config document (no media-endpoint, empty syndicate-to)', async () => {
    const res = await fetch(`${mp}?q=config`);
    assert.strictEqual(res.status, 200);
    const config = await res.json();
    assert.deepStrictEqual(config['syndicate-to'], []);
    assert.strictEqual(config['media-endpoint'], undefined, 'no media endpoint (finding: streaming body seam)');
  });

  it('unauthenticated POST is 401 {"error":"unauthorized"}', async () => {
    const res = await fetch(mp, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'h=entry&content=should+not+land',
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error, 'unauthorized');
  });

  it('form-encoded create → 201 + Location; the post is real pod JSON', async () => {
    const res = await fetch(mp, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'h=entry&content=hello+indieweb&category[]=indieweb&category[]=solid',
    });
    assert.strictEqual(res.status, 201, `create: ${res.status} ${await res.clone().text()}`);
    noteUrl = res.headers.get('location');
    assert.ok(noteUrl, 'no Location header');
    assert.match(noteUrl, new RegExp(`^${base}/${USER}/public/posts/\\d{4}/\\d{2}/.+\\.json$`));

    // The permalink IS a pod resource, readable with the same bearer.
    const raw = await fetch(noteUrl, { headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(raw.status, 200);
    const post = await raw.json();
    assert.deepStrictEqual(post.type, ['h-entry']);
    assert.deepStrictEqual(post.properties.content, ['hello indieweb']);
    assert.deepStrictEqual(post.properties.category, ['indieweb', 'solid']);
    assert.ok(post.properties.published?.[0], 'no published timestamp');
  });

  it('JSON create with multiple properties → 201; name yields the slug', async () => {
    const res = await fetch(mp, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: ['h-entry'],
        properties: {
          name: ['My First Article'],
          content: ['Longer thoughts, stored in my own pod.'],
          category: ['essays'],
          photo: ['https://example.org/shed.jpg'], // URL value only — no upload
        },
      }),
    });
    assert.strictEqual(res.status, 201, `create: ${res.status} ${await res.clone().text()}`);
    articleUrl = res.headers.get('location');
    assert.match(articleUrl, /\/my-first-article\.json$/);

    const post = await (await fetch(articleUrl, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepStrictEqual(post.properties.name, ['My First Article']);
    assert.deepStrictEqual(post.properties.photo, ['https://example.org/shed.jpg']);
  });

  it('GET ?q=source&url=… returns the stored properties as Micropub JSON', async () => {
    const res = await fetch(`${mp}?q=source&url=${encodeURIComponent(noteUrl)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const source = await res.json();
    assert.deepStrictEqual(source.type, ['h-entry']);
    assert.deepStrictEqual(source.properties.content, ['hello indieweb']);
    assert.deepStrictEqual(source.properties.category, ['indieweb', 'solid']);
  });

  it('GET ?q=source with an external url is 400 (no external fetching)', async () => {
    const res = await fetch(`${mp}?q=source&url=${encodeURIComponent('https://aaronparecki.com/post/1')}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, 'invalid_request');
  });

  it('action=update with replace changes the content (GET-merge-PUT)', async () => {
    const res = await fetch(mp, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'update',
        url: noteUrl,
        replace: { content: ['hello indieweb, edited'] },
      }),
    });
    assert.strictEqual(res.status, 204, `update: ${res.status} ${await res.clone().text()}`);
    const post = await (await fetch(noteUrl, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.deepStrictEqual(post.properties.content, ['hello indieweb, edited']);
    // untouched properties survive the merge
    assert.deepStrictEqual(post.properties.category, ['indieweb', 'solid']);
  });

  it('action=delete removes the post; the permalink is gone', async () => {
    const res = await fetch(mp, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `action=delete&url=${encodeURIComponent(articleUrl)}`,
    });
    assert.strictEqual(res.status, 204, `delete: ${res.status}`);
    const gone = await fetch(articleUrl, { headers: { authorization: `Bearer ${token}` } });
    assert.ok([404, 410].includes(gone.status), `expected 404/410, got ${gone.status}`);
  });
});
