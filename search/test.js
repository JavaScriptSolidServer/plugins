// Full-text search over a real JSS from npm: seed a pod container with a
// few text resources (JSON-LD notes, a plaintext file, an HTML page), then
// GET /search?q=... and assert the right resource ranks first, the snippet
// carries the term, a non-matching term returns nothing, phrase and
// multi-term (AND) queries narrow correctly, and WAC holds (a stranger /
// anonymous sees only what they can read).
//
// Same port-probe-then-boot dance as sparql/notifications: the plugin needs
// the server's own origin in config (api.serverInfo finding). The
// misconfiguration test (a second, deliberately-failing createServer) is
// ordered FIRST, before the long-lived boot — JSS resolves IdP keys through
// the process-global DATA_ROOT that every createServer repoints, so a failed
// boot after the main one would silently corrupt its token verification.
//
// Both index modes run on ONE server: a second plugin entry mounts the same
// module at /isearch with config.index:true, so cached-index mode is proven
// without a second boot (which would hit the DATA_ROOT footgun above).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('search plugin', () => {
  let jss;
  let base;
  let alice; // { access_token, webid }
  let mallory;

  const search = (q, { token, container, prefix = '/search' } = {}) => {
    const qs = new URLSearchParams({ q });
    if (container) qs.set('container', container);
    return fetch(`${base}${prefix}?${qs.toString()}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  };

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without config.baseUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/search' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + pods, registers agents, seeds text resources', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    // Explicit data root so the cached-index instance can fs.watch it (the
    // optional refresh source); passed to both startJss and podsRoot.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-search-test-'));
    jss = await startJss({
      port,
      root,
      idp: true,
      plugins: [
        { id: 'search', module: module_, prefix: '/search', config: { baseUrl: base } },
        // Same module, cached-index mode, one server (avoids the DATA_ROOT footgun).
        { id: 'search-indexed', module: module_, prefix: '/isearch',
          config: { baseUrl: base, index: true, podsRoot: root, reindexMs: 60000 } },
      ],
    });
    alice = await registerAndMint(base, 'alice');
    mallory = await registerAndMint(base, 'mallory');

    // alice's notes container (owner-only by default WAC).
    const notes = {
      'boats.jsonld': {
        '@context': { schema: 'https://schema.org/' },
        '@id': '',
        '@type': 'schema:Article',
        'schema:name': 'The old fishing boat',
        'schema:articleBody':
          'An old fishing boat rests in the harbor. The fishing crew mends their nets at dawn while gulls wheel overhead.',
      },
      'sunrise.jsonld': {
        '@context': { schema: 'https://schema.org/' },
        '@id': '',
        '@type': 'schema:Article',
        'schema:name': 'Sunrise over the pier',
        'schema:description': 'A single mention of a boat, but mostly about the colours of the morning sky over the pier.',
      },
      'recipe.txt': 'PLAINTEXT:Grandmother\'s bread recipe. Flour, water, salt and yeast. No boats here at all.',
      'page.html': 'HTML:<html><head><title>Harbor Gazette</title></head><body><h1>Fishing report</h1>' +
        '<p>The <b>fishing</b> was excellent this week. Every boat came back full.</p><script>ignore()</script></body></html>',
    };
    for (const [name, doc] of Object.entries(notes)) {
      let contentType = 'application/ld+json';
      let payload = JSON.stringify(doc);
      if (typeof doc === 'string' && doc.startsWith('PLAINTEXT:')) { contentType = 'text/plain'; payload = doc.slice('PLAINTEXT:'.length); }
      if (typeof doc === 'string' && doc.startsWith('HTML:')) { contentType = 'text/html'; payload = doc.slice('HTML:'.length); }
      const res = await fetch(`${base}/alice/notes/${name}`, {
        method: 'PUT',
        headers: { 'content-type': contentType, authorization: `Bearer ${alice.access_token}` },
        body: payload,
      });
      assert.ok(res.status < 400, `seed ${name}: ${res.status}`);
    }
  });

  it('ranks the most relevant resource first; snippet carries the term', async () => {
    const res = await search('fishing boat', { token: alice.access_token, container: '/alice/notes/' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.strictEqual(body.query, 'fishing boat');
    assert.ok(body.hits.length >= 1, 'expected at least one hit');
    // boats.jsonld mentions both "fishing" (x2) and "boat" most densely.
    assert.match(body.hits[0].url, /boats\.jsonld$/, `top hit was ${body.hits[0].url}`);
    assert.ok(body.hits[0].score > 0, 'top score should be positive');
    // Every hit must contain BOTH terms (AND).
    for (const hit of body.hits) {
      assert.match(hit.snippet.toLowerCase(), /fish|boat/, 'snippet should surround a matched term');
    }
    // recipe.txt has neither "fishing" nor "boat" → excluded.
    assert.ok(!body.hits.some((h) => /recipe\.txt$/.test(h.url)), 'non-matching resource must not appear');
    // Scores are sorted descending.
    for (let i = 1; i < body.hits.length; i++) {
      assert.ok(body.hits[i - 1].score >= body.hits[i].score, 'hits must be sorted by score desc');
    }
  });

  it('a single term matches every document that contains it', async () => {
    const res = await search('boat', { token: alice.access_token, container: '/alice/notes/' });
    const body = await res.json();
    const urls = body.hits.map((h) => h.url).sort();
    // boats, sunrise (single mention), page.html ("every boat came back") — not recipe.
    assert.deepStrictEqual(urls, [
      `${base}/alice/notes/boats.jsonld`,
      `${base}/alice/notes/page.html`,
      `${base}/alice/notes/sunrise.jsonld`,
    ]);
  });

  it('a non-matching term returns no hits', async () => {
    const res = await search('platypus', { token: alice.access_token, container: '/alice/notes/' });
    const body = await res.json();
    assert.deepStrictEqual(body.hits, [], 'unknown term must return nothing');
  });

  it('multi-term AND: both terms must be present', async () => {
    // "recipe" only appears in recipe.txt; "boat" never does → no doc has both.
    const res = await search('recipe boat', { token: alice.access_token, container: '/alice/notes/' });
    const body = await res.json();
    assert.deepStrictEqual(body.hits, [], 'AND across disjoint terms yields nothing');

    // "bread recipe" both live in recipe.txt.
    const res2 = await search('bread recipe', { token: alice.access_token, container: '/alice/notes/' });
    const body2 = await res2.json();
    assert.strictEqual(body2.hits.length, 1);
    assert.match(body2.hits[0].url, /recipe\.txt$/);
  });

  it('quoted phrase matches only adjacent words', async () => {
    // The phrase "fishing boat" is adjacent ONLY in boats.jsonld ("old fishing
    // boat"). sunrise/page mention the words apart or singly.
    const res = await search('"fishing boat"', { token: alice.access_token, container: '/alice/notes/' });
    const body = await res.json();
    assert.strictEqual(body.hits.length, 1, `phrase should hit one doc, got ${JSON.stringify(body.hits.map((h) => h.url))}`);
    assert.match(body.hits[0].url, /boats\.jsonld$/);
    assert.match(body.hits[0].snippet.toLowerCase(), /fishing boat/);

    // A phrase that never occurs adjacently returns nothing even though both
    // words exist in the corpus.
    const none = await search('"boat recipe"', { token: alice.access_token, container: '/alice/notes/' });
    assert.deepStrictEqual((await none.json()).hits, []);
  });

  it('HTML title + tag stripping: script content is not searchable', async () => {
    const res = await search('fishing', { token: alice.access_token, container: '/alice/notes/' });
    const body = await res.json();
    const page = body.hits.find((h) => /page\.html$/.test(h.url));
    assert.ok(page, 'html page should be a hit for "fishing"');
    assert.strictEqual(page.title, 'Harbor Gazette', 'title should come from <title>');
    // The <script> body ("ignore") must not be indexed.
    const scr = await search('ignore', { token: alice.access_token, container: '/alice/notes/' });
    assert.ok(!(await scr.json()).hits.some((h) => /page\.html$/.test(h.url)), 'script text must be stripped');
  });

  it('WAC via loopback: anonymous and strangers see nothing private', async () => {
    // Owner finds boats.
    const owner = await (await search('boat', { token: alice.access_token, container: '/alice/notes/' })).json();
    assert.ok(owner.hits.length > 0, 'owner should see her own notes');
    // Anonymous sees none (owner-only pod).
    const anonRes = await search('boat', { container: '/alice/notes/' });
    assert.strictEqual(anonRes.status, 200);
    assert.deepStrictEqual((await anonRes.json()).hits, [], 'anonymous must not see private data');
    // A different authenticated agent sees none either.
    const stranger = await (await search('boat', { token: mallory.access_token, container: '/alice/notes/' })).json();
    assert.deepStrictEqual(stranger.hits, [], 'a stranger must not see alice\'s data');
  });

  it('400s: missing q, missing scope; CORS preflight', async () => {
    const noq = await fetch(`${base}/search?container=/alice/notes/`, { headers: { authorization: `Bearer ${alice.access_token}` } });
    assert.strictEqual(noq.status, 400);
    assert.match((await noq.json()).error, /"q"/);

    const noScope = await fetch(`${base}/search?q=boat`, { headers: { authorization: `Bearer ${alice.access_token}` } });
    assert.strictEqual(noScope.status, 400);
    assert.match((await noScope.json()).error, /name a container/);

    // CORS: GET carries the wildcard origin; OPTIONS preflight is 204 + headers.
    const got = await search('boat', { token: alice.access_token, container: '/alice/notes/' });
    assert.strictEqual(got.headers.get('access-control-allow-origin'), '*');
    const pre = await fetch(`${base}/search?q=boat&container=/alice/notes/`, { method: 'OPTIONS' });
    assert.strictEqual(pre.status, 204);
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods') || '', /GET/);
  });

  it('cached-index mode returns the same ranking and still respects WAC', async () => {
    // Read-time and cached-index must agree on ranking for the owner…
    const rt = await (await search('fishing boat', { token: alice.access_token, container: '/alice/notes/', prefix: '/search' })).json();
    const ix = await (await search('fishing boat', { token: alice.access_token, container: '/alice/notes/', prefix: '/isearch' })).json();
    assert.deepStrictEqual(ix.hits.map((h) => h.url), rt.hits.map((h) => h.url), 'cached ranking must match read-time');
    assert.match(ix.hits[0].url, /boats\.jsonld$/);

    // …and the cache must NOT leak alice's docs to a stranger, even though the
    // index was populated under alice's authority (per-hit HEAD recheck).
    const stranger = await (await search('boat', { token: mallory.access_token, container: '/alice/notes/', prefix: '/isearch' })).json();
    assert.deepStrictEqual(stranger.hits, [], 'cached index must not leak private docs across agents');

    // The response advertises its mode.
    const modeRes = await search('boat', { token: alice.access_token, container: '/alice/notes/', prefix: '/isearch' });
    assert.strictEqual(modeRes.headers.get('x-search-mode'), 'cached-index');
  });
});
