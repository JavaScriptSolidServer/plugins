// Mastodon-API shim over a real JSS from npm. Drives the whole Phase-1
// vertical slice a client actually performs:
//
//   register app  → POST /api/v1/apps
//   get a token   → POST /oauth/token grant_type=password (pod creds)
//   who am I      → GET  /api/v1/accounts/verify_credentials
//   post          → POST /api/v1/statuses "hello fediverse"
//   read it back  → GET  /api/v1/timelines/home
//
// Same probe-port-then-boot dance as notifications/ and webdav/: the shim
// needs its server origin in config before listen (finding: api.serverInfo),
// and idp:true gives us the /idp/register + /idp/credentials the token
// bridge rides on.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const USER = 'fedialice';
const PASS = 'correct horse battery staple';

describe('mastodon plugin', () => {
  let jss;
  let base;
  let clientId;
  let clientSecret;
  let token;

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without baseUrl (no api.serverInfo — same finding as notifications/webdav)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_ }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + the shim, and registers a pod owner', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      // The finding, closed: Mastodon's fixed API roots (/api, /oauth) are
      // self-reserved via api.reservePath (#602), consumed as of JSS
      // 0.0.219 — no appPaths here, and the suite passing without them is
      // the proof. See README "Findings".
      plugins: [{ module: module_, config: { baseUrl: base, title: 'Test JSS' } }],
    });
    const reg = await fetch(`${base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, confirmPassword: PASS }),
    });
    assert.ok([200, 201, 302].includes(reg.status), `register: ${reg.status}`);
  });

  it('GET /api/v1/instance is public JSON metadata that notes it is JSS-backed', async () => {
    const res = await fetch(`${base}/api/v1/instance`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.title, 'Test JSS');
    assert.ok(body.version, 'no version');
    assert.match(body.description, /JSS/);
    // v2 shape too
    const v2 = await (await fetch(`${base}/api/v2/instance`)).json();
    assert.strictEqual(v2.domain, new URL(base).host);
  });

  it('POST /api/v1/apps registers a client and returns client_id/secret', async () => {
    const res = await fetch(`${base}/api/v1/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Phanpy-ish', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read write',
      }),
    });
    assert.strictEqual(res.status, 200);
    const app = await res.json();
    assert.ok(app.client_id && app.client_secret, `missing creds: ${JSON.stringify(app)}`);
    assert.strictEqual(app.name, 'Phanpy-ish');
    ({ client_id: clientId, client_secret: clientSecret } = app);
  });

  it('POST /oauth/token grant_type=password bridges pod creds to a Bearer', async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password', client_id: clientId, client_secret: clientSecret,
        username: USER, password: PASS, scope: 'read write',
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.token_type, 'Bearer');
    assert.ok(body.access_token, `no access_token: ${JSON.stringify(body)}`);
    token = body.access_token;
  });

  it('bad password is rejected at the token endpoint', async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', username: USER, password: 'wrong-password' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('GET /api/v1/accounts/verify_credentials returns the logged-in account', async () => {
    const res = await fetch(`${base}/api/v1/accounts/verify_credentials`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const account = await res.json();
    assert.strictEqual(account.username, USER);
    assert.strictEqual(account.acct, USER);
    assert.ok(account.id, 'no account id');
    assert.match(account.url, new RegExp(`/${USER}/`));

    // anonymous is 401
    const anon = await fetch(`${base}/api/v1/accounts/verify_credentials`);
    assert.strictEqual(anon.status, 401);
  });

  it('POST /api/v1/statuses stores a Note in the pod and returns a Status', async () => {
    const res = await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'hello fediverse' }),
    });
    assert.strictEqual(res.status, 200);
    const status = await res.json();
    assert.ok(status.id, 'no status id');
    assert.match(status.content, /hello fediverse/);
    assert.strictEqual(status.account.username, USER);
    assert.ok(status.created_at, 'no created_at');

    // It really landed in the pod as a JSON-LD resource under the owner's control.
    const raw = await fetch(`${base}/${USER}/${'public/statuses'}/${status.id}.jsonld`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(raw.status, 200);
    const note = await raw.json();
    assert.strictEqual(note.type, 'Note');
    assert.strictEqual(note.content, 'hello fediverse');
  });

  it('GET /api/v1/timelines/home returns the just-posted status', async () => {
    const res = await fetch(`${base}/api/v1/timelines/home`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const timeline = await res.json();
    assert.ok(Array.isArray(timeline), 'timeline is not an array');
    assert.ok(timeline.length >= 1, `expected >=1 status, got ${timeline.length}`);
    assert.ok(timeline.some((s) => /hello fediverse/.test(s.content)), 'posted status not in timeline');
    assert.strictEqual(timeline[0].account.username, USER);
  });

  it('a second post appears first (newest-first ordering)', async () => {
    await fetch(`${base}/api/v1/statuses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'second toot' }),
    });
    const timeline = await (await fetch(`${base}/api/v1/timelines/home`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assert.ok(timeline.length >= 2, `expected >=2, got ${timeline.length}`);
    assert.match(timeline[0].content, /second toot/);
  });

  it('the authorization_code flow: /oauth/authorize issues a code, /oauth/token redeems it', async () => {
    // Headless shortcut: pass creds to authorize, capture the redirect code.
    const authRes = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${clientId}`
      + `&redirect_uri=${encodeURIComponent('https://app.example/cb')}`
      + `&username=${USER}&password=${encodeURIComponent(PASS)}`, { redirect: 'manual' });
    assert.strictEqual(authRes.status, 302);
    const location = authRes.headers.get('location');
    const code = new URL(location).searchParams.get('code');
    assert.ok(code, `no code in redirect: ${location}`);

    const tokRes = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret }),
    });
    assert.strictEqual(tokRes.status, 200);
    const tok = await tokRes.json();
    assert.ok(tok.access_token, 'code exchange returned no token');

    // The exchanged token works as a real pod Bearer.
    const who = await fetch(`${base}/api/v1/accounts/verify_credentials`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    assert.strictEqual(who.status, 200);
    assert.strictEqual((await who.json()).username, USER);
  });
});
