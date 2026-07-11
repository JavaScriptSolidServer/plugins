// Backup plugin over a real JSS from npm: seed a pod with nested containers,
// text, JSON-LD and binary resources, download the container as a .tar.gz,
// gunzip it, parse the hand-rolled ustar in-test (checksums verified), and
// assert byte-for-byte content plus the MANIFEST.json bookkeeping. Also the
// WAC property: an anonymous backup of a mixed public/private container
// includes the public resource, skips the private one, and says so.
//
// Same probe-port-then-boot dance as rss/sparql/webdav (the plugin needs the
// host origin in config before listen — api.serverInfo finding), and the
// misconfiguration test runs FIRST because a failed second createServer
// re-points JSS's process-global data root (AGENT.md footgun).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
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

// ------------------------------------------------------- tiny ustar reader

/**
 * Parse a (gunzipped) ustar buffer → Map<name, { type, content }>.
 * Verifies each header checksum; joins the prefix field back onto the name.
 */
function parseTar(buf) {
  const entries = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // terminating zero block
    const field = (start, len) => {
      const raw = block.subarray(start, start + len);
      const nul = raw.indexOf(0);
      return raw.subarray(0, nul === -1 ? len : nul).toString('utf8');
    };
    // Checksum: sum of header bytes with the checksum field read as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : block[i];
    const stored = parseInt(field(148, 8).trim(), 8);
    assert.strictEqual(sum, stored, `tar checksum mismatch at offset ${off}`);
    assert.match(field(257, 6), /^ustar/, 'ustar magic missing');

    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const content = Buffer.from(buf.subarray(off + 512, off + 512 + size));
    entries.set(name, { type, content });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ------------------------------------------------------------------- suite

describe('backup plugin', () => {
  let jss;
  let base;
  let alice; // { access_token, webid }

  // Seeded bodies, asserted byte-for-byte after the round trip.
  const HELLO = 'Hello, backup!\nLine two.\n';
  const DEEP = JSON.stringify({ '@id': '', 'dcterms:title': 'Deep note', body: 'nested' });
  const BINARY = Buffer.from(Array.from({ length: 512 + 7 }, (_, i) => i % 256)); // not 512-aligned
  const LONG_OK = `${'b'.repeat(90)}.bin`; // full entry name >100 bytes → needs the ustar prefix field
  const LONG_BAD = `${'z'.repeat(150)}.bin`; // basename alone >100 bytes → unrepresentable, skipped

  const backup = (container, token) => fetch(`${base}/backup${container}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  const fetchArchive = async (container, token) => {
    const res = await backup(container, token);
    assert.strictEqual(res.status, 200, `backup ${container}: ${res.status}`);
    assert.match(res.headers.get('content-type'), /application\/gzip/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename=".+\.tar\.gz"$/);
    const gz = Buffer.from(await res.arrayBuffer());
    return parseTar(zlib.gunzipSync(gz));
  };

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without config.loopbackUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/backup' }] }),
      /requires config\.loopbackUrl/,
    );
  });

  it('boots with idp + pods and seeds a nested pod tree', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        id: 'backup',
        module: module_,
        prefix: '/backup',
        config: { loopbackUrl: base },
      }],
    });
    alice = await registerAndMint(base, 'alice');

    const put = async (podPath, body, contentType) => {
      const res = await fetch(base + podPath, {
        method: 'PUT',
        headers: { 'content-type': contentType, authorization: `Bearer ${alice.access_token}` },
        body,
      });
      assert.ok(res.status < 400, `seed ${podPath}: ${res.status}`);
    };
    await put('/alice/stuff/hello.txt', HELLO, 'text/plain');
    await put('/alice/stuff/nested/deep.jsonld', DEEP, 'application/ld+json');
    await put(`/alice/stuff/${LONG_OK}`, BINARY, 'application/octet-stream');
    await put(`/alice/stuff/${LONG_BAD}`, 'never fits', 'text/plain');
  });

  it('GET /backup/<container>/ streams a gzipped ustar of the readable tree', async () => {
    const entries = await fetchArchive('/alice/stuff/', alice.access_token);

    // Directory entries for the container and its sub-container.
    assert.strictEqual(entries.get('alice/stuff/')?.type, '5', 'container dir entry');
    assert.strictEqual(entries.get('alice/stuff/nested/')?.type, '5', 'nested dir entry');

    // Files, byte-for-byte.
    assert.strictEqual(entries.get('alice/stuff/hello.txt')?.content.toString(), HELLO);
    assert.strictEqual(entries.get('alice/stuff/nested/deep.jsonld')?.content.toString(), DEEP);

    // The long name (entry name 106 bytes) rides the ustar prefix field and
    // survives the round trip intact — content equal to the binary seed.
    const long = entries.get(`alice/stuff/${LONG_OK}`);
    assert.ok(long, 'prefix-field entry present');
    assert.ok(long.content.equals(BINARY), 'binary body must survive byte-for-byte');

    // The unrepresentable name is absent from the tar…
    assert.ok(!entries.has(`alice/stuff/${LONG_BAD}`), 'overlong basename must be skipped');

    // …and MANIFEST.json (at archive root) accounts for everything.
    const manifest = JSON.parse(entries.get('MANIFEST.json').content.toString());
    assert.strictEqual(manifest.container, '/alice/stuff/');
    const includedPaths = manifest.included.map((e) => e.path);
    for (const p of ['/alice/stuff/', '/alice/stuff/hello.txt',
      '/alice/stuff/nested/', '/alice/stuff/nested/deep.jsonld',
      `/alice/stuff/${LONG_OK}`]) {
      assert.ok(includedPaths.includes(p), `manifest must include ${p}`);
    }
    assert.deepStrictEqual(
      manifest.skipped,
      [{ path: `/alice/stuff/${LONG_BAD}`, reason: 'name-too-long' }],
    );
    assert.strictEqual(manifest.counts.included, 5);
    assert.strictEqual(manifest.counts.skipped, 1);
    assert.strictEqual(manifest.truncated, false);

    // No .acl / .meta companions are exported.
    for (const name of entries.keys()) assert.ok(!/\.(acl|meta)$/.test(name), name);
  });

  it('anonymous backup keeps public resources, skips private ones, counts them', async () => {
    // A mixed container: the container itself and open.txt publicly readable,
    // secret.txt owner-only (inherits the owner-only acl:default).
    const put = async (podPath, body) => {
      const res = await fetch(base + podPath, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain', authorization: `Bearer ${alice.access_token}` },
        body,
      });
      assert.ok(res.status < 400, `seed ${podPath}: ${res.status}`);
    };
    await put('/alice/pub/open.txt', 'anyone may read this');
    await put('/alice/pub/secret.txt', 'owner eyes only');

    const ownerAll = `<#owner> a acl:Authorization;\n`
      + `  acl:agent <${alice.webid}>;\n`
      + '  acl:accessTo <./>;\n  acl:default <./>;\n'
      + '  acl:mode acl:Read, acl:Write, acl:Control.\n';
    fs.writeFileSync(
      path.join(jss.root, 'alice', 'pub', '.acl'),
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n'
      + '@prefix foaf: <http://xmlns.com/foaf/0.1/>.\n'
      + '<#public> a acl:Authorization;\n'
      + '  acl:agentClass foaf:Agent;\n  acl:accessTo <./>;\n  acl:mode acl:Read.\n'
      + ownerAll,
    );
    fs.writeFileSync(
      path.join(jss.root, 'alice', 'pub', 'open.txt.acl'),
      '@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n'
      + '@prefix foaf: <http://xmlns.com/foaf/0.1/>.\n'
      + '<#public> a acl:Authorization;\n'
      + '  acl:agentClass foaf:Agent;\n  acl:accessTo <./open.txt>;\n  acl:mode acl:Read.\n'
      + `<#owner> a acl:Authorization;\n  acl:agent <${alice.webid}>;\n`
      + '  acl:accessTo <./open.txt>;\n  acl:mode acl:Read, acl:Write, acl:Control.\n',
    );

    // Sanity: WAC really does refuse the private file to anonymous.
    const probe = await fetch(`${base}/alice/pub/secret.txt`);
    assert.ok(probe.status === 401 || probe.status === 403, `secret must be private, got ${probe.status}`);

    const entries = await fetchArchive('/alice/pub/', null);
    assert.strictEqual(entries.get('alice/pub/open.txt')?.content.toString(), 'anyone may read this');
    assert.ok(!entries.has('alice/pub/secret.txt'), 'private resource must not leak into an anonymous backup');

    const manifest = JSON.parse(entries.get('MANIFEST.json').content.toString());
    assert.strictEqual(manifest.counts.skipped, 1);
    assert.strictEqual(manifest.skipped[0].path, '/alice/pub/secret.txt');
    assert.strictEqual(manifest.skipped[0].reason, 'unauthorized');
    assert.ok([401, 403].includes(manifest.skipped[0].status));

    // The owner still gets both.
    const owned = await fetchArchive('/alice/pub/', alice.access_token);
    assert.strictEqual(owned.get('alice/pub/secret.txt')?.content.toString(), 'owner eyes only');
    assert.strictEqual(JSON.parse(owned.get('MANIFEST.json').content.toString()).counts.skipped, 0);
  });

  it('an unreadable or missing ROOT container is an error status, not an archive', async () => {
    // /alice/stuff/ is owner-only → anonymous gets the WAC refusal itself.
    const anon = await backup('/alice/stuff/', null);
    assert.ok(anon.status === 401 || anon.status === 403, `expected refusal, got ${anon.status}`);

    const gone = await backup('/alice/no-such-container/', alice.access_token);
    assert.strictEqual(gone.status, 404);
  });

  it('GET /backup and /backup/ are 400 with usage (no whole-server export)', async () => {
    for (const url of ['/backup', '/backup/']) {
      const res = await fetch(base + url, {
        headers: { authorization: `Bearer ${alice.access_token}` },
      });
      assert.strictEqual(res.status, 400, url);
      assert.match((await res.json()).error, /name a container/);
    }
  });

  it('a path without a trailing slash is treated as the container', async () => {
    const entries = await fetchArchive('/alice/pub', alice.access_token);
    assert.ok(entries.has('alice/pub/open.txt'));
  });
});
