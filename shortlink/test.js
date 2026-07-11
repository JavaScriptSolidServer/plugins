// shortlink plugin over a real JSS from npm. Two pods (alice creates, bob
// contests) prove the ownership rules; redirect hygiene (no-store, 302,
// local-only targets) and the hit counter are driven over real HTTP.
//
// Same probe-port-then-boot dance as micropub/: the plugin needs its own
// origin in config before listen (finding: api.serverInfo), and idp:true
// provides /idp/register + /idp/credentials to mint the pod bearers.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

describe('shortlink plugin', () => {
  let jss;
  let base;
  let sl; // the shortlink endpoint
  let alice; // bearer
  let bob; // bearer
  let target; // a long pod URL to shorten
  let mintedSlug; // the auto-minted slug from the create test

  after(async () => { if (jss) await jss.close(); });

  const post = (token, body) => fetch(sl, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const follow = (slug) => fetch(`${sl}/${slug}`, { redirect: 'manual' });
  const preview = (slug) => fetch(`${sl}/${slug}?preview=1`);
  const del = (slug, token) => fetch(`${sl}/${slug}`, {
    method: 'DELETE',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const list = async (token) => {
    const res = await fetch(sl, { headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 200);
    return (await res.json()).links;
  };

  // DATA_ROOT footgun: validation-failure boots MUST run before the
  // long-lived boot (a second createServer repoints the process global).
  it('refuses to boot without baseUrl (no api.serverInfo — same finding as micropub/webdav)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/shortlink' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp and mints two pod bearers', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    sl = `${base}/shortlink`;
    target = `${base}/alice/notes/2026/07/a-very-long-resource-name-nobody-wants-to-dictate.html`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        id: 'shortlink',
        module: module_,
        prefix: '/shortlink',
        config: { baseUrl: base },
      }],
    });
    for (const [user, assign] of [['alice', (t) => { alice = t; }], ['bob', (t) => { bob = t; }]]) {
      const pass = `correct horse ${user} staple`;
      const reg = await fetch(`${base}/idp/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass, confirmPassword: pass }),
      });
      assert.ok([200, 201, 302].includes(reg.status), `register ${user}: ${reg.status}`);
      const cred = await (await fetch(`${base}/idp/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      })).json();
      assert.ok(cred.access_token, `mint ${user} failed: ${JSON.stringify(cred)}`);
      assign(cred.access_token);
    }
  });

  it('anonymous POST is 401', async () => {
    const res = await post(null, { url: target });
    assert.strictEqual(res.status, 401);
  });

  it('create → 201 with a minted base62 slug and an absolute short url', async () => {
    const res = await post(alice, { url: target });
    assert.strictEqual(res.status, 201, `create: ${res.status} ${await res.clone().text()}`);
    const body = await res.json();
    assert.match(body.slug, /^[0-9A-Za-z]{7}$/, 'default slug is 7 chars of base62');
    assert.strictEqual(body.short, `${sl}/${body.slug}`);
    assert.strictEqual(body.url, target);
    assert.ok(body.created, 'created timestamp present');
    assert.strictEqual(res.headers.get('location'), body.short);
    mintedSlug = body.slug;
  });

  it('GET slug → 302 to the target with Cache-Control: no-store', async () => {
    const res = await follow(mintedSlug);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), target);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store', 'a cached 302 would outlive deletion');
  });

  it('?preview=1 returns the record instead of redirecting (and does not count a hit)', async () => {
    const res = await preview(mintedSlug);
    assert.strictEqual(res.status, 200);
    const rec = await res.json();
    assert.strictEqual(rec.slug, mintedSlug);
    assert.strictEqual(rec.url, target);
    assert.strictEqual(rec.hits, 1, 'exactly the one redirect so far — previews do not count');
    assert.ok(rec.agent.includes('alice'), `creator recorded: ${rec.agent}`);
  });

  it('external targets are refused with 400 (no open redirector)', async () => {
    for (const url of [
      'https://evil.example/phish',
      `${base}.evil.example/looks-local`, // the startsWith bypass: parsed-origin check catches it
      'javascript:alert(1)',
      'not a url',
    ]) {
      const res = await post(alice, { url });
      assert.strictEqual(res.status, 400, `expected 400 for ${url}, got ${res.status}`);
    }
  });

  it('custom slug works and is normalized to lowercase', async () => {
    const res = await post(alice, { url: target, slug: 'Weekly-Report' });
    assert.strictEqual(res.status, 201, `custom slug: ${res.status} ${await res.clone().text()}`);
    const body = await res.json();
    assert.strictEqual(body.slug, 'weekly-report');
    assert.strictEqual((await follow('weekly-report')).status, 302);

    const bad = await post(alice, { url: target, slug: 'no spaces!' });
    assert.strictEqual(bad.status, 400, 'invalid slug charset refused');
  });

  it('same agent re-posting the same url+slug is idempotent 200', async () => {
    const res = await post(alice, { url: target, slug: 'weekly-report' });
    assert.strictEqual(res.status, 200, 'idempotent re-post is 200, not 409');
    const body = await res.json();
    assert.strictEqual(body.slug, 'weekly-report');
    assert.strictEqual(body.url, target);
  });

  it('another agent claiming a taken slug → 409', async () => {
    const res = await post(bob, { url: `${base}/bob/stuff.ttl`, slug: 'weekly-report' });
    assert.strictEqual(res.status, 409);
  });

  it('DELETE by a non-creator → 403; anonymous DELETE → 401', async () => {
    assert.strictEqual((await del('weekly-report', bob)).status, 403);
    assert.strictEqual((await del('weekly-report', null)).status, 401);
    assert.strictEqual((await follow('weekly-report')).status, 302, 'link survives refused deletes');
  });

  it('DELETE by the creator → 204, then the slug is 404', async () => {
    assert.strictEqual((await del('weekly-report', alice)).status, 204);
    assert.strictEqual((await follow('weekly-report')).status, 404);
    assert.strictEqual((await preview('weekly-report')).status, 404);
  });

  it('list shows only the caller\'s own links', async () => {
    const bobsLink = await (await post(bob, { url: `${base}/bob/notes/today.md` })).json();

    const aliceLinks = await list(alice);
    assert.deepStrictEqual(aliceLinks.map((l) => l.slug), [mintedSlug], 'alice sees hers only (deleted one gone)');

    const bobLinks = await list(bob);
    assert.deepStrictEqual(bobLinks.map((l) => l.slug), [bobsLink.slug], 'bob sees his only');
  });

  it('hits increment on each redirect and surface in preview and list', async () => {
    const { slug } = await (await post(alice, { url: `${base}/alice/photos/summer.jpg` })).json();
    assert.strictEqual((await follow(slug)).status, 302);
    assert.strictEqual((await follow(slug)).status, 302);

    const rec = await (await preview(slug)).json();
    assert.strictEqual(rec.hits, 2);

    const mine = await list(alice);
    assert.strictEqual(mine.find((l) => l.slug === slug).hits, 2);
  });

  it('persistence is atomic: links.json stays valid JSON with the record, no leftover .tmp', async () => {
    const res = await post(alice, { url: `${base}/alice/durable/thing.ttl`, slug: 'durable-link' });
    assert.strictEqual(res.status, 201);

    const pluginDir = path.join(jss.root, '.plugins', 'shortlink');
    const tableFile = path.join(pluginDir, 'links.json');

    // The table survived the write and parses. A truncated write would leave
    // invalid JSON the boot loader swallows into {} — losing every link.
    const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
    assert.ok(table['durable-link'], 'the just-created link is present on disk');
    assert.strictEqual(table['durable-link'].url, `${base}/alice/durable/thing.ttl`);

    // The atomic write must not leave any temp file behind in the plugin dir.
    const leftovers = fs.readdirSync(pluginDir).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], `no leftover temp files, saw: ${leftovers}`);
  });

  it('unknown slug → 404, even one far past maxParamLength (wildcard route)', async () => {
    assert.strictEqual((await follow('n0such1')).status, 404);
    const long = 'x'.repeat(150); // a named :slug param would 404 at the router with Fastify's default body
    const res = await follow(long);
    assert.strictEqual(res.status, 404);
    assert.strictEqual((await res.json()).error, 'no such short link', 'our handler answered, not the router');
  });
});
