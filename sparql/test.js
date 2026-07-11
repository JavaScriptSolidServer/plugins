// SPARQL plugin over a real JSS from npm: seed a pod with JSON-LD photos,
// then query them through POST /sparql — BGP joins, FILTER, LIMIT,
// projection, and the loopback-WAC property (a caller only sees data they
// could GET themselves).
//
// Same port-probe-then-boot dance as notifications/: the plugin needs the
// server's own origin in config (api.serverInfo finding).
//
// Ordering matters: the misconfiguration test boots (and fails) a second
// createServer, and JSS resolves its IdP keys through the process-global
// DATA_ROOT env var that every createServer call repoints — so the failed
// boot MUST come before the long-lived server, or the main server's token
// verification silently reads the wrong keys directory. (notifications/
// orders its tests the same way; worth a NOTES entry someday.)

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
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

describe('sparql plugin', () => {
  let jss;
  let base;
  let alice; // { access_token, webid }
  let mallory;

  const sparql = (query, { token, container } = {}) =>
    fetch(`${base}/sparql${container ? `?container=${encodeURIComponent(container)}` : ''}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-query',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: query,
    });

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without config.baseUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/sparql' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + pods, registers agents, seeds JSON-LD photos', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        module: module_,
        prefix: '/sparql',
        config: { baseUrl: base },
      }],
    });
    alice = await registerAndMint(base, 'alice');
    mallory = await registerAndMint(base, 'mallory');

    // Seed alice's pod (owner-only by default WAC) with JSON-LD photos.
    const photos = {
      'photo-sunrise.jsonld': {
        '@context': { schema: 'https://schema.org/' },
        '@id': '',
        '@type': 'schema:Photo',
        'schema:name': 'sunrise over the pier',
        'schema:dateCreated': '2026-01-15',
      },
      'photo-boat.jsonld': {
        '@context': { schema: 'https://schema.org/' },
        '@id': '',
        '@type': 'schema:Photo',
        'schema:name': 'old fishing boat',
        'schema:dateCreated': '2024-06-01',
      },
      'photo-harbor.jsonld': {
        '@context': { schema: 'https://schema.org/' },
        '@id': '',
        '@type': 'schema:Photo',
        'schema:name': 'harbor at sunset',
        'schema:dateCreated': '2026-03-02',
        'schema:creator': { '@id': alice.webid },
      },
    };
    for (const [name, doc] of Object.entries(photos)) {
      const res = await fetch(`${base}/alice/photos/${name}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/ld+json',
          authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify(doc),
      });
      assert.ok(res.status < 400, `seed ${name}: ${res.status}`);
    }
  });

  it('BGP join + FILTER(>) + LIMIT over FROM, as the pod owner', async () => {
    const res = await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?s ?d
      FROM <${base}/alice/photos/>
      WHERE {
        ?s a schema:Photo .
        ?s schema:dateCreated ?d .
        FILTER(?d > "2025-01-01")
      }
      LIMIT 10
    `, { token: alice.access_token });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/sparql-results\+json/);
    const body = await res.json();
    assert.deepStrictEqual(body.head.vars, ['s', 'd']);
    assert.strictEqual(body.results.bindings.length, 2);
    const subjects = body.results.bindings.map((b) => b.s.value).sort();
    assert.deepStrictEqual(subjects, [
      `${base}/alice/photos/photo-harbor.jsonld`,
      `${base}/alice/photos/photo-sunrise.jsonld`,
    ]);
    for (const b of body.results.bindings) {
      assert.strictEqual(b.s.type, 'uri');
      assert.strictEqual(b.d.type, 'literal');
      assert.ok(b.d.value > '2025-01-01', `filter leaked ${b.d.value}`);
    }
  });

  it('projection + CONTAINS: only the projected variable comes back', async () => {
    const res = await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?name
      WHERE {
        ?s schema:name ?name .
        FILTER(CONTAINS(?name, "sun"))
      }
    `, { token: alice.access_token, container: '/alice/photos/' });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.head.vars, ['name']);
    const names = body.results.bindings.map((b) => b.name.value).sort();
    assert.deepStrictEqual(names, ['harbor at sunset', 'sunrise over the pier']);
    for (const b of body.results.bindings) {
      assert.deepStrictEqual(Object.keys(b), ['name'], 'projection must drop unprojected vars');
    }

    // REGEX with flags matches too.
    const rx = await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?name
      WHERE { ?s schema:name ?name . FILTER(REGEX(?name, "^HARBOR", "i")) }
    `, { token: alice.access_token, container: '/alice/photos/' });
    const rxBody = await rx.json();
    assert.deepStrictEqual(rxBody.results.bindings.map((b) => b.name.value), ['harbor at sunset']);
  });

  it('predicate lists (;) and FILTER(=) find exactly one photo', async () => {
    const res = await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?s
      FROM <${base}/alice/photos/>
      WHERE {
        ?s a schema:Photo ;
           schema:dateCreated ?d .
        FILTER(?d = "2024-06-01")
      }
    `, { token: alice.access_token });
    const body = await res.json();
    assert.strictEqual(body.results.bindings.length, 1);
    assert.strictEqual(body.results.bindings[0].s.value, `${base}/alice/photos/photo-boat.jsonld`);
  });

  it('nested @id objects become IRI triples (creator)', async () => {
    const res = await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?s
      FROM <${base}/alice/photos/>
      WHERE { ?s schema:creator <${alice.webid}> }
    `, { token: alice.access_token });
    const body = await res.json();
    assert.strictEqual(body.results.bindings.length, 1);
    assert.strictEqual(body.results.bindings[0].s.value, `${base}/alice/photos/photo-harbor.jsonld`);
  });

  it('LIMIT caps the bindings', async () => {
    const res = await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?s FROM <${base}/alice/photos/>
      WHERE { ?s a schema:Photo } LIMIT 1
    `, { token: alice.access_token });
    const body = await res.json();
    assert.strictEqual(body.results.bindings.length, 1);
  });

  it('WAC via loopback: anonymous and strangers see nothing', async () => {
    const query = `
      PREFIX schema: <https://schema.org/>
      SELECT ?s ?d
      FROM <${base}/alice/photos/>
      WHERE { ?s a schema:Photo . ?s schema:dateCreated ?d }
    `;
    // Owner sees all three…
    const owner = await (await sparql(query, { token: alice.access_token })).json();
    assert.strictEqual(owner.results.bindings.length, 3);
    // …anonymous sees none (the pod is owner-only by default)…
    const anonRes = await sparql(query);
    assert.strictEqual(anonRes.status, 200);
    const anon = await anonRes.json();
    assert.strictEqual(anon.results.bindings.length, 0, 'anonymous must not see private data');
    // …and a different authenticated agent sees none either.
    const stranger = await (await sparql(query, { token: mallory.access_token })).json();
    assert.strictEqual(stranger.results.bindings.length, 0, 'mallory must not see alice\'s data');
  });

  it('DISTINCT dedupes projected rows', async () => {
    const res = await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT DISTINCT ?t
      FROM <${base}/alice/photos/>
      WHERE { ?s a ?t }
    `, { token: alice.access_token });
    const body = await res.json();
    const photoRows = body.results.bindings.filter((b) => b.t.value === 'https://schema.org/Photo');
    assert.strictEqual(photoRows.length, 1, 'three Photos must collapse to one distinct type row');
  });

  it('400 on malformed queries and missing scope; 415 on wrong content-type', async () => {
    const bad = await sparql('SELECT WHERE garbage {', { token: alice.access_token });
    assert.strictEqual(bad.status, 400);

    const noScope = await sparql('SELECT ?s WHERE { ?s ?p ?o }', { token: alice.access_token });
    assert.strictEqual(noScope.status, 400);
    assert.match((await noScope.json()).error, /name a scope/);

    const offOrigin = await sparql(
      'SELECT ?s FROM <https://elsewhere.example/pod/> WHERE { ?s ?p ?o }',
      { token: alice.access_token },
    );
    assert.strictEqual(offOrigin.status, 400);

    const wrongType = await fetch(`${base}/sparql`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'SELECT ?s WHERE { ?s ?p ?o }',
    });
    assert.strictEqual(wrongType.status, 415);
  });
});
