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

  const sparqlUpdate = (update, { token, resource } = {}) =>
    fetch(`${base}/sparql${resource ? `?resource=${encodeURIComponent(resource)}` : ''}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/sparql-update',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: update,
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

  // ------------------------------------------------------- SPARQL UPDATE

  it('INSERT DATA (GRAPH form) adds a triple; SELECT sees it; old triples survive the rewrite', async () => {
    const target = `${base}/alice/photos/photo-boat.jsonld`;
    const update = `
      PREFIX schema: <https://schema.org/>
      INSERT DATA { GRAPH <${target}> {
        <${target}> schema:keywords "vintage" .
      } }
    `;
    const res = await sparqlUpdate(update, { token: alice.access_token });
    assert.strictEqual(res.status, 200);
    const summary = await res.json();
    assert.strictEqual(summary.ok, true);
    assert.strictEqual(summary.op, 'INSERT DATA');
    assert.strictEqual(summary.inserted, 1);
    assert.strictEqual(summary.removed, 0);

    // SELECT sees the new triple…
    const sel = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?k FROM <${base}/alice/photos/>
      WHERE { <${target}> schema:keywords ?k }
    `, { token: alice.access_token })).json();
    assert.deepStrictEqual(sel.results.bindings.map((b) => b.k.value), ['vintage']);

    // …the pre-existing triples survived the GET-merge-PUT rewrite…
    const old = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?d FROM <${target}>
      WHERE { <${target}> a schema:Photo ; schema:dateCreated ?d }
    `, { token: alice.access_token })).json();
    assert.deepStrictEqual(old.results.bindings.map((b) => b.d.value), ['2024-06-01']);

    // …and re-inserting the same triple is a no-op (no write issued).
    const again = await sparqlUpdate(update, { token: alice.access_token });
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await again.json()).inserted, 0);
  });

  it('INSERT DATA via ?resource= creates a missing resource (PUT If-None-Match: *)', async () => {
    const path_ = '/alice/photos/tags.jsonld';
    const iri = `${base}${path_}`;
    const res = await sparqlUpdate(`
      PREFIX schema: <https://schema.org/>
      INSERT DATA {
        <${iri}> a schema:DefinedTerm ; schema:name "boats" .
      }
    `, { token: alice.access_token, resource: path_ });
    assert.strictEqual(res.status, 200);
    const summary = await res.json();
    assert.strictEqual(summary.inserted, 2);

    // The resource now exists as an ordinary LDP JSON-LD resource…
    const got = await fetch(iri, { headers: { authorization: `Bearer ${alice.access_token}` } });
    assert.strictEqual(got.status, 200);
    assert.match((got.headers.get('content-type') || ''), /json/);

    // …and SELECT sees it through the container walk.
    const sel = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?n FROM <${base}/alice/photos/>
      WHERE { ?s a schema:DefinedTerm ; schema:name ?n }
    `, { token: alice.access_token })).json();
    assert.deepStrictEqual(sel.results.bindings.map((b) => b.n.value), ['boats']);
  });

  it('DELETE DATA removes the triple; SELECT no longer sees it; siblings intact', async () => {
    const target = `${base}/alice/photos/photo-boat.jsonld`;
    const res = await sparqlUpdate(`
      PREFIX schema: <https://schema.org/>
      DELETE DATA { GRAPH <${target}> { <${target}> schema:keywords "vintage" } }
    `, { token: alice.access_token });
    assert.strictEqual(res.status, 200);
    const summary = await res.json();
    assert.strictEqual(summary.op, 'DELETE DATA');
    assert.strictEqual(summary.removed, 1);

    const gone = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?k FROM <${base}/alice/photos/> WHERE { ?s schema:keywords ?k }
    `, { token: alice.access_token })).json();
    assert.strictEqual(gone.results.bindings.length, 0, 'deleted triple still visible');

    const still = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?d FROM <${target}> WHERE { <${target}> schema:dateCreated ?d }
    `, { token: alice.access_token })).json();
    assert.deepStrictEqual(still.results.bindings.map((b) => b.d.value), ['2024-06-01']);
  });

  it('DELETE DATA removing every triple leaves an EMPTY resource, not a 404', async () => {
    const path_ = '/alice/photos/tags.jsonld';
    const iri = `${base}${path_}`;
    const res = await sparqlUpdate(`
      PREFIX schema: <https://schema.org/>
      DELETE DATA { <${iri}> a schema:DefinedTerm ; schema:name "boats" . }
    `, { token: alice.access_token, resource: path_ });
    assert.strictEqual(res.status, 200);
    const summary = await res.json();
    assert.strictEqual(summary.removed, 2);
    assert.strictEqual(summary.triples, 0);

    const got = await fetch(iri, { headers: { authorization: `Bearer ${alice.access_token}` } });
    assert.strictEqual(got.status, 200, 'the emptied resource still exists');
    const empty = await (await sparql(
      `SELECT ?s FROM <${iri}> WHERE { ?s ?p ?o }`,
      { token: alice.access_token },
    )).json();
    assert.strictEqual(empty.results.bindings.length, 0);

    // DELETE DATA against a resource that does not exist at all → 404.
    const missing = await sparqlUpdate(`
      PREFIX schema: <https://schema.org/>
      DELETE DATA { <${base}/alice/photos/nope.jsonld> schema:name "x" }
    `, { token: alice.access_token, resource: '/alice/photos/nope.jsonld' });
    assert.strictEqual(missing.status, 404);
  });

  it('WAC passthrough: anonymous and strangers cannot update, and nothing lands', async () => {
    const target = `${base}/alice/photos/photo-sunrise.jsonld`;
    const update = `
      PREFIX schema: <https://schema.org/>
      INSERT DATA { GRAPH <${target}> { <${target}> schema:keywords "defaced" } }
    `;
    const asMallory = await sparqlUpdate(update, { token: mallory.access_token });
    assert.ok([401, 403].includes(asMallory.status), `mallory expected 401/403, got ${asMallory.status}`);
    const anon = await sparqlUpdate(update);
    assert.ok([401, 403].includes(anon.status), `anonymous expected 401/403, got ${anon.status}`);

    const sel = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?k FROM <${target}> WHERE { ?s schema:keywords ?k }
    `, { token: alice.access_token })).json();
    assert.strictEqual(sel.results.bindings.length, 0, 'a refused update must not land');
  });

  it('400 on malformed/unscoped/variable/container updates; 501 on unsupported forms', async () => {
    const t = { token: alice.access_token };

    const malformed = await sparqlUpdate('INSERT DATA { <x> garbage', t);
    assert.strictEqual(malformed.status, 400);

    const noTarget = await sparqlUpdate(
      `INSERT DATA { <${base}/alice/photos/a.jsonld> <${base}/p> "v" }`, t);
    assert.strictEqual(noTarget.status, 400);
    assert.match((await noTarget.json()).error, /name the target/);

    const withVar = await sparqlUpdate(
      `INSERT DATA { GRAPH <${base}/alice/photos/a.jsonld> { ?s <${base}/p> "v" } }`, t);
    assert.strictEqual(withVar.status, 400);
    assert.match((await withVar.json()).error, /ground triples/);

    const container = await sparqlUpdate(
      `INSERT DATA { GRAPH <${base}/alice/photos/> { <${base}/alice/photos/> <${base}/p> "v" } }`, t);
    assert.strictEqual(container.status, 400);

    const offOrigin = await sparqlUpdate(
      'INSERT DATA { GRAPH <https://elsewhere.example/g> { <https://elsewhere.example/s> <https://elsewhere.example/p> "v" } }', t);
    assert.strictEqual(offOrigin.status, 400);

    // Pattern/template forms and graph management: honest 501s.
    const deleteWhere = await sparqlUpdate('DELETE WHERE { ?s ?p ?o }',
      { ...t, resource: '/alice/photos/photo-boat.jsonld' });
    assert.strictEqual(deleteWhere.status, 501);
    assert.match((await deleteWhere.json()).error, /only INSERT DATA and DELETE DATA/);

    const insertWhere = await sparqlUpdate(
      `INSERT { ?s <${base}/p> "v" } WHERE { ?s ?p ?o }`,
      { ...t, resource: '/alice/photos/photo-boat.jsonld' });
    assert.strictEqual(insertWhere.status, 501);

    const withForm = await sparqlUpdate(
      `WITH <${base}/alice/photos/photo-boat.jsonld> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }`, t);
    assert.strictEqual(withForm.status, 501);

    const clear = await sparqlUpdate(`CLEAR GRAPH <${base}/alice/photos/photo-boat.jsonld>`, t);
    assert.strictEqual(clear.status, 501);
  });

  it('the 412 retry path: an interfering write between GET and PUT is re-read, not clobbered', async () => {
    // The plugin runs in-process and reaches the host through global fetch,
    // so the test can deterministically slip an external write into the
    // window between the plugin's GET (which captured the ETag) and its
    // If-Match PUT. The host must answer that PUT with 412 (stale ETag),
    // and the plugin must re-read and merge against the NEW state.
    const path_ = '/alice/photos/photo-sunrise.jsonld';
    const target = `${base}${path_}`;
    const externalDoc = {
      '@context': { schema: 'https://schema.org/' },
      '@id': '',
      '@type': 'schema:Photo',
      'schema:name': 'sunrise over the pier',
      'schema:dateCreated': '2026-01-15',
      'schema:caption': 'written between GET and PUT',
    };
    const realFetch = globalThis.fetch;
    let interfered = false;
    globalThis.fetch = async (input, init) => {
      if (!interfered && init?.method === 'PUT' && String(input).endsWith(path_)) {
        interfered = true; // the interfering PUT below must not recurse
        const ext = await realFetch(target, {
          method: 'PUT',
          headers: {
            'content-type': 'application/ld+json',
            authorization: `Bearer ${alice.access_token}`,
          },
          body: JSON.stringify(externalDoc),
        });
        assert.ok(ext.status < 400, `interfering write: ${ext.status}`);
      }
      return realFetch(input, init);
    };
    try {
      const res = await sparqlUpdate(`
        PREFIX schema: <https://schema.org/>
        INSERT DATA { GRAPH <${target}> { <${target}> schema:keywords "morning" } }
      `, { token: alice.access_token });
      assert.strictEqual(res.status, 200);
      const summary = await res.json();
      assert.strictEqual(summary.retried, true, 'the stale If-Match PUT must have 412ed and retried');
      assert.strictEqual(summary.inserted, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(interfered, 'the interfering write never fired');

    // Both the external write's triple and the update's triple survive.
    const sel = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?c ?k FROM <${target}>
      WHERE { <${target}> schema:caption ?c ; schema:keywords ?k }
    `, { token: alice.access_token })).json();
    assert.strictEqual(sel.results.bindings.length, 1);
    assert.strictEqual(sel.results.bindings[0].c.value, 'written between GET and PUT');
    assert.strictEqual(sel.results.bindings[0].k.value, 'morning');
  });

  it('concurrent INSERT DATA: no torn state, but the host may lose one (measured TOCTOU — see README)', async () => {
    // What IS guaranteed: both callers get 200 (each PUT either passes
    // If-Match or 412s and the retry lands), the resource stays valid
    // JSON-LD, and the seeded triples survive (every PUT snapshot includes
    // them). What is NOT guaranteed: both keywords landing — the host's
    // If-Match check is check-then-write, and two overlapping PUTs can
    // both pass the same ETag (measured; README finding), so the loser's
    // keyword may be silently overwritten. The assertions state exactly
    // the invariants that hold.
    const target = `${base}/alice/photos/photo-harbor.jsonld`;
    const insert = (word) => sparqlUpdate(`
      PREFIX schema: <https://schema.org/>
      INSERT DATA { GRAPH <${target}> { <${target}> schema:keywords "${word}" } }
    `, { token: alice.access_token });
    const [a, b] = await Promise.all([insert('sunset'), insert('harbor')]);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);

    const sel = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?k FROM <${target}> WHERE { <${target}> schema:keywords ?k }
    `, { token: alice.access_token })).json();
    const kws = sel.results.bindings.map((x) => x.k.value).sort();
    assert.ok(kws.length >= 1, 'at least the last write must be visible');
    assert.ok(kws.every((k) => ['harbor', 'sunset'].includes(k)), `unexpected keywords ${kws}`);

    // No torn state: the photo's seeded triples survived both rewrites.
    const still = await (await sparql(`
      PREFIX schema: <https://schema.org/>
      SELECT ?n ?d FROM <${target}>
      WHERE { <${target}> a schema:Photo ; schema:name ?n ; schema:dateCreated ?d }
    `, { token: alice.access_token })).json();
    assert.strictEqual(still.results.bindings.length, 1);
    assert.strictEqual(still.results.bindings[0].n.value, 'harbor at sunset');
    assert.strictEqual(still.results.bindings[0].d.value, '2026-03-02');
  });
});
