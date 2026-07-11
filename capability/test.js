// Capability plugin over a real JSS from npm: minting requires a verified
// agent (real IdP Bearer), the minted URL is bearer-auth on its own (no
// credential needed to use it), and every refusal path holds — expiry,
// tampering, mode mismatch, revocation (issuer-only).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startJss } from '../helpers.js';
import { signCapability } from './plugin.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const PASSWORD = 'correct horse battery staple';
const SEEDED = 'quarterly numbers: 42';

describe('capability plugin', () => {
  let jss;
  let alice; // { access_token, webid }
  let mallory;

  const registerAndMint = async (username) => {
    const reg = await fetch(`${jss.base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD, confirmPassword: PASSWORD }),
    });
    assert.ok([200, 201, 302].includes(reg.status) || reg.ok, `register ${username}: ${reg.status}`);
    const cred = await fetch(`${jss.base}/idp/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    const body = await cred.json();
    assert.ok(body.access_token, `mint ${username} failed: ${JSON.stringify(body)}`);
    return body;
  };

  const issue = (grant, bearer) => fetch(`${jss.base}/cap/issue`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(grant),
  });

  before(async () => {
    jss = await startJss({
      idp: true,
      plugins: [{
        module: module_,
        id: 'capability',
        prefix: '/cap',
        config: { resources: { 'report.pdf': SEEDED, 'notes/todo.txt': 'ship it' } },
      }],
    });
    alice = await registerAndMint('alice');
    mallory = await registerAndMint('mallory');
  });
  after(async () => { if (jss) await jss.close(); });

  it('refuses to mint for anonymous or invalidly-credentialed callers', async () => {
    const anon = await issue({ resource: 'report.pdf', modes: ['read'], ttl: 60 });
    assert.strictEqual(anon.status, 401, 'no credential must be refused');
    const forged = await issue({ resource: 'report.pdf' }, 'not-a-real-token');
    assert.strictEqual(forged.status, 401, 'a bogus Bearer must be refused');
  });

  it('rejects malformed grants (missing resource, traversal, unknown mode, bad ttl)', async () => {
    for (const grant of [
      {},
      { resource: '../../etc/passwd' },
      { resource: 'report.pdf', modes: ['admin'] },
      { resource: 'report.pdf', ttl: -5 },
    ]) {
      const res = await issue(grant, alice.access_token);
      assert.strictEqual(res.status, 400, `grant ${JSON.stringify(grant)} must be refused`);
    }
  });

  it('authenticated issue returns a capability URL that serves the resource with NO auth', async () => {
    const res = await issue({ resource: '/cap/files/report.pdf', modes: ['read'], ttl: 3600 }, alice.access_token);
    assert.strictEqual(res.status, 201);
    const cap = await res.json();
    assert.match(cap.url, /^\/cap\/r\/v1\./);
    assert.strictEqual(cap.resource, 'report.pdf', 'resource path is normalized');
    assert.strictEqual(cap.issuer, alice.webid);
    assert.ok(cap.jti && cap.exp > Date.now() / 1000);

    // The URL alone is the credential: plain fetch, zero headers.
    const read = await fetch(`${jss.base}${cap.url}`);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(await read.text(), SEEDED);
    assert.strictEqual(read.headers.get('cache-control'), 'no-store');
    assert.strictEqual(read.headers.get('referrer-policy'), 'no-referrer');

    // HEAD counts as read too.
    const head = await fetch(`${jss.base}${cap.url}`, { method: 'HEAD' });
    assert.strictEqual(head.status, 200);
  });

  it('refuses an expired token', async () => {
    // Craft one against the persisted server secret rather than sleeping.
    const secret = fs.readFileSync(path.join(jss.root, '.plugins', 'capability', 'secret'));
    const now = Math.floor(Date.now() / 1000);
    const token = signCapability(
      { v: 1, jti: 'expired-jti', iss: alice.webid, res: 'report.pdf', modes: ['read'], iat: now - 120, exp: now - 60 },
      secret,
    );
    const res = await fetch(`${jss.base}/cap/r/${token}`);
    assert.strictEqual(res.status, 401);
    assert.match((await res.json()).error, /expired/);
  });

  it('refuses a tampered token', async () => {
    const cap = await (await issue({ resource: 'report.pdf', ttl: 60 }, alice.access_token)).json();
    // Re-target the payload to another resource, keeping the original sig.
    const [v, body, sig] = cap.token.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.res = 'notes/todo.txt';
    const forged = `${v}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    const res = await fetch(`${jss.base}/cap/r/${forged}`);
    assert.strictEqual(res.status, 401);
    assert.match((await res.json()).error, /signature/);

    const garbage = await fetch(`${jss.base}/cap/r/v1.not.real`);
    assert.strictEqual(garbage.status, 401);
  });

  it('enforces modes: write-only refuses GET, read-only refuses PUT, write lands and reads back', async () => {
    const writeCap = await (await issue(
      { resource: 'uploads/drop.txt', modes: ['write'], ttl: 60 }, alice.access_token,
    )).json();

    // write-only must not read…
    const peek = await fetch(`${jss.base}${writeCap.url}`);
    assert.strictEqual(peek.status, 403);

    // …but PUT (no auth — possession suffices) writes the resource.
    const put = await fetch(`${jss.base}${writeCap.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'hello from the drop box',
    });
    assert.ok([201, 204].includes(put.status), `PUT status ${put.status}`);

    // A separate read capability sees what was written.
    const readCap = await (await issue(
      { resource: 'uploads/drop.txt', modes: ['read'], ttl: 60 }, alice.access_token,
    )).json();
    const read = await fetch(`${jss.base}${readCap.url}`);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(await read.text(), 'hello from the drop box');

    // …and that read-only capability refuses a write.
    const push = await fetch(`${jss.base}${readCap.url}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'nope' });
    assert.strictEqual(push.status, 403);
  });

  it('revocation: issuer-only, and a revoked token stops working', async () => {
    const cap = await (await issue({ resource: 'report.pdf', ttl: 3600 }, alice.access_token)).json();
    assert.strictEqual((await fetch(`${jss.base}${cap.url}`)).status, 200, 'works before revocation');

    const revoke = (body, bearer) => fetch(`${jss.base}/cap/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });

    assert.strictEqual((await revoke({ token: cap.token })).status, 401, 'anonymous revoke refused');
    assert.strictEqual((await revoke({ token: cap.token }, mallory.access_token)).status, 403, 'non-issuer revoke refused');

    const ok = await revoke({ token: cap.token }, alice.access_token);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).revoked, cap.jti);

    const after_ = await fetch(`${jss.base}${cap.url}`);
    assert.strictEqual(after_.status, 401);
    assert.match((await after_.json()).error, /revoked/);
  });

  it('revocation by jti (issued index) works without keeping the token', async () => {
    const cap = await (await issue({ resource: 'notes/todo.txt', ttl: 3600 }, alice.access_token)).json();
    const res = await fetch(`${jss.base}/cap/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.access_token}` },
      body: JSON.stringify({ jti: cap.jti }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await fetch(`${jss.base}${cap.url}`)).status, 401);
  });

  it('the revocation ledger persists atomically: valid JSON with the jti, no leftover .tmp', async () => {
    const cap = await (await issue({ resource: 'report.pdf', ttl: 3600 }, alice.access_token)).json();
    const revoke = await fetch(`${jss.base}/cap/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.access_token}` },
      body: JSON.stringify({ token: cap.token }),
    });
    assert.strictEqual(revoke.status, 200);

    const pluginDir = path.join(jss.root, '.plugins', 'capability');

    // The revocation ledger survived the write and parses. A truncated write
    // would leave invalid JSON the boot loader swallows into {} — and a
    // revoked capability would silently come back to life. That's the bug.
    const revoked = JSON.parse(fs.readFileSync(path.join(pluginDir, 'revoked.json'), 'utf8'));
    assert.ok(cap.jti in revoked, 'the revoked jti is on disk in the ledger');

    // Neither ledger write may leave a temp file behind in the plugin dir.
    const leftovers = fs.readdirSync(pluginDir).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], `no leftover temp files, saw: ${leftovers}`);
  });
});
