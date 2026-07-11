// remoteStorage plugin over a real JSS from npm.
//
// The headline test is the COLLISION BOOT: webfinger/ and remotestorage/
// both claim GET /.well-known/webfinger, and booting both on one server is
// asserted to FAIL — the duplicate-route collision NOTES.md predicted but
// never witnessed. It runs FIRST among boots (after the pure validation
// tests) because of the DATA_ROOT footgun: a failing createServer re-points
// JSS's process-global data root and would poison an earlier long-lived
// boot. The reverse order (remotestorage first) is also measured: webfinger/
// guards its claim with try/catch, so that boot SUCCEEDS and webfinger
// silently loses the route — the other face of the same missing seam.
//
// Then the long-lived boot (remotestorage alone, idp: true) drives the
// protocol surface: PUT/GET/DELETE with ETags, conditional writes measured
// through loopback (If-Match / If-None-Match:* → the HOST's 412), the rS
// folder-description listing with per-item ETags, anonymous public reads
// via a real .acl, the token bridge, and the JRD under the own prefix.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PLUGIN = path.join(__dirname, 'plugin.js');
const WEBFINGER_PLUGIN = path.join(__dirname, '..', 'webfinger', 'plugin.js');

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

describe('remotestorage plugin', () => {
  let jss;
  let base;
  let alice; // { access_token, webid }

  const rs = (p, opts = {}, token) => fetch(`${base}/remotestorage${p}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  after(async () => { if (jss) await jss.close(); });

  // ------------------------------------------------------- (1) validation

  it('refuses to boot without config.baseUrl + config.loopbackUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ id: 'remotestorage', module: PLUGIN, prefix: '/remotestorage' }] }),
      /requires config\.baseUrl and config\.loopbackUrl/,
    );
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'remotestorage', module: PLUGIN, prefix: '/remotestorage',
          config: { baseUrl: 'http://127.0.0.1:9' }, // loopbackUrl missing
        }],
      }),
      /requires config\.baseUrl and config\.loopbackUrl/,
    );
  });

  // -------------------------------------------- (2) THE COLLISION BOOT

  it('COLLISION: webfinger/ + remotestorage/ both claiming /.well-known/webfinger fails the boot', async () => {
    const port = await probePort();
    const b = `http://127.0.0.1:${port}`;
    let witnessed;
    await assert.rejects(
      startJss({
        port,
        plugins: [
          // webfinger/ loads FIRST and claims the route; remotestorage/'s
          // unguarded claim then throws FST_ERR_DUPLICATED_ROUTE.
          { id: 'webfinger', module: WEBFINGER_PLUGIN, prefix: '/webfinger', config: { baseUrl: b } },
          { id: 'remotestorage', module: PLUGIN, prefix: '/remotestorage', config: { baseUrl: b, loopbackUrl: b } },
        ],
      }),
      (err) => {
        witnessed = err;
        // Fastify's duplicate-route error, wrapped by the loader as
        // "plugin remotestorage: activate() failed: …" (the wrap drops
        // err.code, so the message is what identifies it).
        assert.match(err.message, /plugin remotestorage: activate\(\) failed/,
          `expected the loader's activation wrap, got: ${err.message}`);
        assert.match(err.message, /already declared/i,
          `expected fastify's duplicate-route message, got: ${err.message}`);
        assert.match(err.message, /\/\.well-known\/webfinger/,
          `expected the colliding route in the message, got: ${err.message}`);
        return true;
      },
    );
    // Keep the measured error visible in the test log for the README.
    console.log(`    witnessed collision error: ${witnessed.message}`);
  });

  it('COLLISION reverse order: remotestorage first boots fine — webfinger/ guards and silently loses the route', async () => {
    const port = await probePort();
    const b = `http://127.0.0.1:${port}`;
    const both = await startJss({
      port,
      plugins: [
        { id: 'remotestorage', module: PLUGIN, prefix: '/remotestorage', config: { baseUrl: b, loopbackUrl: b } },
        { id: 'webfinger', module: WEBFINGER_PLUGIN, prefix: '/webfinger', config: { baseUrl: b } },
      ],
    });
    try {
      // /.well-known/webfinger answers — but with the remoteStorage JRD:
      // webfinger/'s try/catch degraded it to prefix-only, and every link
      // it would have contributed (profile-page, AP actor, OIDC issuer) is
      // silently gone from the well-known document. The predicted silent
      // link collision, witnessed.
      const res = await fetch(`${b}/.well-known/webfinger?resource=${encodeURIComponent('acct:alice@pod.example')}`);
      assert.strictEqual(res.status, 200);
      const jrd = await res.json();
      assert.ok(jrd.links.some((l) => l.rel === 'remotestorage'),
        'the winner (remotestorage) serves its JRD at the well-known path');
      assert.ok(!jrd.links.some((l) => l.rel === 'http://webfinger.net/rel/profile-page'),
        "the loser's (webfinger/) links are silently absent — no registry to merge them");
    } finally {
      await both.close();
    }
  });

  // --------------------------------------------- (3) the long-lived boot

  it('boots remotestorage alone with idp and mints a pod owner', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        id: 'remotestorage',
        module: PLUGIN,
        prefix: '/remotestorage',
        config: { baseUrl: base, loopbackUrl: base },
      }],
    });
    alice = await registerAndMint(base, 'alice');
  });

  // ------------------------------------------------ storage round trip

  let firstEtag;

  it('PUT → GET → DELETE round-trips a document with ETags end to end', async () => {
    const put = await rs('/alice/documents/notes/todo.txt', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'buy oat milk\n',
    }, alice.access_token);
    assert.strictEqual(put.status, 201, 'first PUT creates');
    firstEtag = put.headers.get('etag');
    assert.match(firstEtag, /^".+"$/, 'PUT returns a quoted ETag (fetched via follow-up HEAD)');

    const get = await rs('/alice/documents/notes/todo.txt', {}, alice.access_token);
    assert.strictEqual(get.status, 200);
    assert.strictEqual(await get.text(), 'buy oat milk\n');
    assert.strictEqual(get.headers.get('etag'), firstEtag,
      'GET ETag equals the ETag PUT reported (host ETag passed through both ways)');
    assert.match(get.headers.get('content-type') || '', /text\/plain/);
    // The streamed GET body is fetch-decoded, so the plugin must NOT forward a
    // host content-length that could be wrong under content-encoding — it lets
    // fastify frame the stream (matches the webdav/ sibling).
    assert.strictEqual(get.headers.get('content-length'), null,
      'GET must not forward a host content-length over the fetch-decoded stream');

    // The resource is created in the pod's own namespace — visible over LDP.
    const ldp = await fetch(`${base}/alice/remotestorage/documents/notes/todo.txt`, {
      headers: { authorization: `Bearer ${alice.access_token}` },
    });
    assert.strictEqual(ldp.status, 200, 'the rS document is a plain pod resource');
    assert.strictEqual(ldp.headers.get('etag'), firstEtag,
      'the ETag rS serves IS the host LDP ETag — pass-through, not hand-rolled');
  });

  it('conditional GET: If-None-Match with the current ETag → 304 (host answers it)', async () => {
    const res = await rs('/alice/documents/notes/todo.txt', {
      headers: { 'if-none-match': firstEtag },
    }, alice.access_token);
    assert.strictEqual(res.status, 304);
  });

  it('conditional writes pass through: host answers 412 for stale If-Match and If-None-Match:* on existing', async () => {
    // Stale If-Match → the HOST's LDP PUT refuses with 412.
    const stale = await rs('/alice/documents/notes/todo.txt', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': '"0000deadbeef0000"' },
      body: 'must not land',
    }, alice.access_token);
    assert.strictEqual(stale.status, 412, 'stale If-Match refused by the host through loopback');

    // If-None-Match: * on an existing document → 412 (create-only guard).
    const create = await rs('/alice/documents/notes/todo.txt', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-none-match': '*' },
      body: 'must not land either',
    }, alice.access_token);
    assert.strictEqual(create.status, 412, 'If-None-Match:* prevents overwrite');

    // Neither refused write landed.
    const get = await rs('/alice/documents/notes/todo.txt', {}, alice.access_token);
    assert.strictEqual(await get.text(), 'buy oat milk\n', 'refused writes must not change the document');

    // Matching If-Match → the update lands and the ETag changes.
    const ok = await rs('/alice/documents/notes/todo.txt', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-match': firstEtag },
      body: 'buy oat milk and bread\n', // different size → different ETag even within one mtime ms
    }, alice.access_token);
    assert.strictEqual(ok.status, 200, 'matching If-Match update succeeds (200 on overwrite)');
    const newEtag = ok.headers.get('etag');
    assert.match(newEtag, /^".+"$/);
    assert.notStrictEqual(newEtag, firstEtag, 'the ETag changed with the content');
    firstEtag = newEtag;

    // If-None-Match: * on a NEW document → 201.
    const fresh = await rs('/alice/documents/notes/fresh.txt', {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'if-none-match': '*' },
      body: 'brand new',
    }, alice.access_token);
    assert.strictEqual(fresh.status, 201, 'If-None-Match:* creates when nothing exists');
  });

  it('folder listings are the rS folder-description format with per-item host ETags', async () => {
    const res = await rs('/alice/documents/notes/', {}, alice.access_token);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/ld\+json/);
    const folderEtag = res.headers.get('etag');
    assert.match(folderEtag, /^"rs-[0-9a-f]+"$/, 'folder ETag is the plugin-derived items hash');
    const body = await res.json();
    assert.strictEqual(body['@context'], 'http://remotestorage.io/spec/folder-description');
    assert.ok(body.items['todo.txt'], 'document item present');
    assert.ok(body.items['fresh.txt'], 'second document item present');
    assert.strictEqual(body.items['todo.txt'].ETag, firstEtag.replace(/"/g, ''),
      'item ETag (unquoted) equals the document\'s own ETag — the property rS sync depends on');
    assert.match(body.items['todo.txt']['Content-Type'], /text\/plain/);
    assert.strictEqual(body.items['todo.txt']['Content-Length'], 'buy oat milk and bread\n'.length);
    assert.ok(!Object.keys(body.items).some((k) => k.startsWith('.')), 'no dotfiles leak into items');

    // Parent folder lists the subfolder with an ETag.
    const parent = await rs('/alice/documents/', {}, alice.access_token);
    const parentBody = await parent.json();
    assert.ok(parentBody.items['notes/'], 'subfolder item present with trailing slash');
    assert.ok(parentBody.items['notes/'].ETag.length > 0, 'subfolder item carries an ETag');

    // Folder conditional GET: If-None-Match with the folder ETag → 304.
    const cond = await rs('/alice/documents/notes/', {
      headers: { 'if-none-match': folderEtag },
    }, alice.access_token);
    assert.strictEqual(cond.status, 304, 'folder 304 answered plugin-side');

    // The folder ETag changes when a child is overwritten (the host's own
    // directory ETag would NOT — measured reason for hand-rolling it).
    const bump = await rs('/alice/documents/notes/todo.txt', {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'rewritten body, new size\n',
    }, alice.access_token);
    assert.strictEqual(bump.status, 200);
    firstEtag = bump.headers.get('etag');
    const relist = await rs('/alice/documents/notes/', {}, alice.access_token);
    assert.notStrictEqual(relist.headers.get('etag'), folderEtag,
      'overwriting a child changes the folder ETag');
  });

  it('a folder that does not exist yet lists as empty items (200, no ETag)', async () => {
    const res = await rs('/alice/documents/nothere/', {}, alice.access_token);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.items, {});
    assert.strictEqual(res.headers.get('etag'), null, 'no ETag so clients re-process each cycle');
  });

  it('DELETE honors If-Match through the host and returns the deleted revision ETag', async () => {
    const wrong = await rs('/alice/documents/notes/todo.txt', {
      method: 'DELETE',
      headers: { 'if-match': '"0000deadbeef0000"' },
    }, alice.access_token);
    assert.strictEqual(wrong.status, 412, 'stale If-Match DELETE refused by the host');

    const del = await rs('/alice/documents/notes/todo.txt', {
      method: 'DELETE',
      headers: { 'if-match': firstEtag },
    }, alice.access_token);
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.headers.get('etag'), firstEtag, 'deleted revision ETag echoed');

    const gone = await rs('/alice/documents/notes/todo.txt', {}, alice.access_token);
    assert.strictEqual(gone.status, 404);

    const again = await rs('/alice/documents/notes/todo.txt', { method: 'DELETE' }, alice.access_token);
    assert.strictEqual(again.status, 404, 'deleting a missing document is 404');
  });

  // ------------------------------------------------------- public reads

  it('anonymous GET works on a public path iff the pod grants public read; private stays 401', async () => {
    const put = await rs('/alice/public/shared/hello.txt', {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'anyone may read this',
    }, alice.access_token);
    assert.ok(put.status < 400, `seed public doc: ${put.status}`);

    // Grant public read on the public/ category container (inherited via
    // acl:default) — same fs-level .acl setup as backup/test.js.
    const publicDir = path.join(jss.root, 'alice', 'remotestorage', 'public');
    fs.writeFileSync(
      path.join(publicDir, '.acl'),
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n'
      + '@prefix foaf: <http://xmlns.com/foaf/0.1/>.\n'
      + '<#public> a acl:Authorization;\n'
      + '  acl:agentClass foaf:Agent;\n  acl:accessTo <./>;\n  acl:default <./>;\n  acl:mode acl:Read.\n'
      + `<#owner> a acl:Authorization;\n  acl:agent <${alice.webid}>;\n`
      + '  acl:accessTo <./>;\n  acl:default <./>;\n'
      + '  acl:mode acl:Read, acl:Write, acl:Control.\n',
    );

    const anon = await rs('/alice/public/shared/hello.txt');
    assert.strictEqual(anon.status, 200, 'anonymous read of a public document');
    assert.strictEqual(await anon.text(), 'anyone may read this');
    assert.match(anon.headers.get('etag') || '', /^".+"$/, 'public GET still carries the ETag');

    // Anonymous folder listing of the public folder works too (the per-item
    // loopback HEADs are anonymous and the .acl grants them).
    const anonList = await rs('/alice/public/shared/');
    assert.strictEqual(anonList.status, 200);
    const listing = await anonList.json();
    assert.ok(listing.items['hello.txt'].ETag.length > 0);

    // Private categories stay refused for anonymous callers — the loopback
    // anonymous GET is refused by real WAC, and the refusal is relayed.
    const priv = await rs('/alice/documents/notes/fresh.txt');
    assert.strictEqual(priv.status, 401, 'private document is refused');
    assert.match(priv.headers.get('www-authenticate') || '', /Bearer/);
    const privList = await rs('/alice/documents/');
    assert.strictEqual(privList.status, 401, 'private folder listing is refused');
  });

  // -------------------------------------------------------- token bridge

  it('POST <prefix>/token bridges username+password to a pod bearer that the storage accepts', async () => {
    const res = await rs('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.access_token, 'a token is minted');
    assert.strictEqual(body.token_type, 'bearer');
    assert.strictEqual(body.webid, alice.webid);

    const put = await rs('/alice/documents/via-bridge.txt', {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'written with the bridged token',
    }, body.access_token);
    assert.strictEqual(put.status, 201, 'the bridged token drives real WAC-governed writes');

    const bad = await rs('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong' }),
    });
    assert.strictEqual(bad.status, 401);
  });

  // ----------------------------------------------------------- webfinger

  it('serves the rS JRD under its own prefix (and, alone, at /.well-known/webfinger)', async () => {
    const resource = 'acct:alice@pod.example';
    const res = await rs(`/webfinger?resource=${encodeURIComponent(resource)}`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/jrd\+json/);
    const jrd = await res.json();
    assert.strictEqual(jrd.subject, resource);

    const draft = jrd.links.find((l) => l.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage');
    assert.ok(draft, 'the draft-dejong-remotestorage link is present');
    assert.strictEqual(draft.href, `${base}/remotestorage/alice`, 'storage href points at the prefix data plane');
    assert.strictEqual(draft.properties['http://remotestorage.io/spec/version'], 'draft-dejong-remotestorage-22');
    assert.strictEqual(draft.properties['http://tools.ietf.org/html/rfc6749#section-4.2'],
      `${base}/remotestorage/token`, 'the auth property points at the token bridge (documented deviation)');

    const legacy = jrd.links.find((l) => l.rel === 'remotestorage');
    assert.ok(legacy, 'the legacy remotestorage rel is present');
    assert.strictEqual(legacy.href, `${base}/remotestorage/alice`);

    // Booted alone, the plugin also owns the real well-known location.
    const wk = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
    assert.strictEqual(wk.status, 200);
    assert.deepStrictEqual(await wk.json(), jrd, 'same JRD at the well-known path when unopposed');

    const missing = await rs('/webfinger');
    assert.strictEqual(missing.status, 400, 'resource parameter is required');
  });

  // ------------------------------------------- content-type provenance

  it('MEASURED: the pod derives Content-Type from the extension, not the PUT header', async () => {
    // rS requires the stored content type to round-trip exactly; JSS's LDP
    // derives it from the file extension on every GET, so an extension-less
    // document PUT as text/csv comes back as application/octet-stream.
    // Documented in README findings — asserted here so a host change shows.
    const put = await rs('/alice/documents/tabular', {
      method: 'PUT', headers: { 'content-type': 'text/csv' }, body: 'a,b\n1,2\n',
    }, alice.access_token);
    assert.strictEqual(put.status, 201);
    const get = await rs('/alice/documents/tabular', {}, alice.access_token);
    assert.strictEqual(await get.text(), 'a,b\n1,2\n', 'bytes round-trip exactly');
    assert.match(get.headers.get('content-type') || '', /application\/octet-stream/,
      'the PUT content-type (text/csv) is NOT stored — extension-derived on GET');
  });

  // ------------------------------------------------------------ hygiene

  it('refuses traversal and dotfile paths', async () => {
    const traverse = await fetch(`${base}/remotestorage/alice/../bob/x.txt`, {
      headers: { authorization: `Bearer ${alice.access_token}` },
    });
    assert.ok([400, 403, 404].includes(traverse.status), `traversal refused (${traverse.status})`);

    const acl = await rs('/alice/public/.acl', {}, alice.access_token);
    assert.strictEqual(acl.status, 404, 'dotfile read is 404');

    const aclWrite = await rs('/alice/public/.acl', {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'nope',
    }, alice.access_token);
    assert.strictEqual(aclWrite.status, 403, 'dotfile write is 403');
  });
});
