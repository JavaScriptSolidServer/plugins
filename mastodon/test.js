// Mastodon-API shim over a real JSS from npm. Drives the whole "Phanpy day"
// a client actually performs:
//
//   register app  → POST /api/v1/apps
//   get a token   → POST /oauth/token (password AND auth-code + PKCE)
//   who am I      → GET  /api/v1/accounts/verify_credentials
//   post          → POST /api/v1/statuses "hello fediverse"
//   post a photo  → POST /api/v2/media (multipart) → statuses with media_ids
//   reply         → in_reply_to_id → GET /statuses/:id/context
//   fav / boost   → POST /statuses/:id/{favourite,reblog}
//   timelines     → home + public (podsRoot discovery), Link-header paging
//   notifications → seeded via the activitypub/ plugin's AP inbox
//   delete        → DELETE /api/v1/statuses/:id (owner only)
//
// Same probe-port-then-boot dance as notifications/ and webdav/: the shim
// needs its server origin in config before listen (finding: api.serverInfo),
// and idp:true gives us the /idp/register + /idp/credentials the token
// bridge rides on. The activitypub/ plugin is loaded ALONGSIDE (a second
// plugin in this suite's own config — its files are untouched) because the
// notifications tab reads the AP inbox over loopback; if the AP plugin
// doesn't yet expose `GET /ap/<user>/inbox?page=true`, the notifications
// test soft-skips loudly instead of failing.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');
const apModule = path.join(__dirname, '..', 'activitypub', 'plugin.js');

const USER = 'fedialice';
const PASS = 'correct horse battery staple';
const USER2 = 'fedibob';
const PASS2 = 'bob has a horse too';

// A tiny (not-necessarily-decodable) PNG-shaped byte blob — the round-trip
// assertion is byte equality, nothing renders it.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d49444154789c626000010000050001a5f645400000000049454e44ae426082',
  'hex',
);

const authed = (token, extra = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });
const authedJson = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

describe('mastodon plugin', () => {
  let jss;
  let base;
  let root;
  let clientId;
  let clientSecret;
  let token;
  let token2;
  let firstStatus; // the 'hello fediverse' status entity

  after(async () => { if (jss) await jss.close(); });

  const post = (tok, body) => fetch(`${base}/api/v1/statuses`, {
    method: 'POST', headers: authedJson(tok), body: JSON.stringify(body),
  });

  it('refuses to boot without baseUrl (no api.serverInfo — same finding as notifications/webdav)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_ }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + the shim (+ activitypub for the inbox seam), and registers a pod owner', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-mastodon-test-'));
    jss = await startJss({
      port,
      root,
      idp: true,
      plugins: [
        // podsRoot is the OPTIONAL local-user discovery knob (public
        // timeline / context descendants) — the LDP root serves an HTML
        // landing page, not a container listing, so fs is the only lane.
        { module: module_, config: { baseUrl: base, title: 'Test JSS', podsRoot: root } },
        // The integration contract: notifications read the AP inbox that
        // activitypub/ persists (loading a second plugin here touches none
        // of that plugin's files).
        { module: apModule, config: { baseUrl: base, loopbackUrl: base } },
      ],
    });
    for (const [u, p] of [[USER, PASS], [USER2, PASS2]]) {
      const reg = await fetch(`${base}/idp/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: u, password: p, confirmPassword: p }),
      });
      assert.ok([200, 201, 302].includes(reg.status), `register ${u}: ${reg.status}`);
    }
  });

  it('GET /api/v1/instance is public JSON metadata that notes it is JSS-backed', async () => {
    const res = await fetch(`${base}/api/v1/instance`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.title, 'Test JSS');
    assert.ok(body.version, 'no version');
    assert.match(body.description, /JSS/);
    // Media is enabled now (Phanpy gates the photo button on this).
    assert.ok(body.configuration.statuses.max_media_attachments >= 1, 'media disabled');
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
    assert.ok('vapid_key' in app, 'no vapid_key stub');
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

    // bob too (used for the multi-user cases below)
    const res2 = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', username: USER2, password: PASS2 }),
    });
    assert.strictEqual(res2.status, 200);
    token2 = (await res2.json()).access_token;
  });

  it('bad password is rejected at the token endpoint', async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', username: USER, password: 'wrong-password' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('GET /api/v1/accounts/verify_credentials returns the logged-in account (CredentialAccount shape)', async () => {
    const res = await fetch(`${base}/api/v1/accounts/verify_credentials`, authed(token));
    assert.strictEqual(res.status, 200);
    const account = await res.json();
    assert.strictEqual(account.username, USER);
    assert.strictEqual(account.acct, USER);
    assert.strictEqual(account.id, USER, 'Account.id is the username now');
    assert.match(account.url, new RegExp(`/${USER}/`));
    assert.strictEqual(account.source.privacy, 'public');
    assert.deepStrictEqual(account.source.fields, []);

    // anonymous is 401 — AND carries CORS, or Phanpy shows a network error
    const anon = await fetch(`${base}/api/v1/accounts/verify_credentials`);
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.headers.get('access-control-allow-origin'), '*');
  });

  it('POST /api/v1/statuses stores a Note in the pod and returns a Status', async () => {
    const res = await post(token, { status: 'hello fediverse' });
    assert.strictEqual(res.status, 200);
    const status = await res.json();
    assert.ok(status.id, 'no status id');
    assert.match(status.content, /hello fediverse/);
    assert.strictEqual(status.account.username, USER);
    assert.ok(status.created_at, 'no created_at');
    firstStatus = status;

    // The id is base64url of the Note's AS2 id URL — decode and check.
    assert.strictEqual(Buffer.from(status.id, 'base64url').toString('utf8'), status.uri);

    // It really landed in the pod as a JSON-LD resource under the owner's control.
    const raw = await fetch(status.uri, authed(token));
    assert.strictEqual(raw.status, 200);
    const note = await raw.json();
    assert.strictEqual(note.type, 'Note');
    assert.strictEqual(note.content, 'hello fediverse');

    // Round-trip: GET /api/v1/statuses/:id with the new opaque id.
    const back = await fetch(`${base}/api/v1/statuses/${status.id}`, authed(token));
    assert.strictEqual(back.status, 200);
    assert.strictEqual((await back.json()).uri, status.uri);

    // Malformed ids are 404, never 500.
    for (const bad of ['%21%21%21', 'AAAA', 'Nzg5', encodeURIComponent(Buffer.from('https://evil.example/x/public/statuses/1.jsonld').toString('base64url'))]) {
      const r = await fetch(`${base}/api/v1/statuses/${bad}`, authed(token));
      assert.strictEqual(r.status, 404, `expected 404 for ${bad}, got ${r.status}`);
    }
  });

  it('GET /api/v1/timelines/home returns the just-posted status', async () => {
    const res = await fetch(`${base}/api/v1/timelines/home`, authed(token));
    assert.strictEqual(res.status, 200);
    const timeline = await res.json();
    assert.ok(Array.isArray(timeline), 'timeline is not an array');
    assert.ok(timeline.length >= 1, `expected >=1 status, got ${timeline.length}`);
    assert.ok(timeline.some((s) => /hello fediverse/.test(s.content)), 'posted status not in timeline');
    assert.strictEqual(timeline[0].account.username, USER);
  });

  it('a second post appears first (newest-first ordering)', async () => {
    await post(token, { status: 'second toot' });
    const timeline = await (await fetch(`${base}/api/v1/timelines/home`, authed(token))).json();
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
    const who = await fetch(`${base}/api/v1/accounts/verify_credentials`, authed(tok.access_token));
    assert.strictEqual(who.status, 200);
    assert.strictEqual((await who.json()).username, USER);
  });

  it('PKCE (S256) is verified when the client sends it — the Phanpy flow', async () => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const issue = async () => {
      const res = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${clientId}`
        + `&redirect_uri=${encodeURIComponent('https://app.example/cb')}`
        + `&code_challenge=${challenge}&code_challenge_method=S256`
        + `&username=${USER}&password=${encodeURIComponent(PASS)}`, { redirect: 'manual' });
      assert.strictEqual(res.status, 302);
      return new URL(res.headers.get('location')).searchParams.get('code');
    };

    // Wrong verifier → invalid_grant.
    const bad = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: await issue(), code_verifier: 'not-the-verifier' }),
    });
    assert.strictEqual(bad.status, 400);

    // Right verifier → token; and the response carries a refresh_token
    // that the refresh grant accepts.
    const good = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: await issue(), code_verifier: verifier }),
    });
    assert.strictEqual(good.status, 200);
    const tok = await good.json();
    assert.ok(tok.access_token && tok.refresh_token);
    const refreshed = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }),
    });
    assert.strictEqual(refreshed.status, 200);
    assert.strictEqual((await refreshed.json()).access_token, tok.access_token);
  });

  it('POST /oauth/revoke and GET /api/v1/apps/verify_credentials answer', async () => {
    const rev = await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(rev.status, 200);
    const ver = await fetch(`${base}/api/v1/apps/verify_credentials`, authed(token));
    assert.strictEqual(ver.status, 200);
    assert.ok('name' in (await ver.json()));
  });

  // ------------------------------------------------------------------ media

  let attachment;

  it('POST /api/v2/media uploads a photo (multipart) and the bytes round-trip from the pod', async () => {
    const boundary = `----phanpy${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="description"\r\n\r\nA tiny dot\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="dot.png"\r\ncontent-type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${base}/api/v2/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const uploadBody = await res.text();
    assert.strictEqual(res.status, 200, uploadBody);
    attachment = JSON.parse(uploadBody);
    assert.ok(attachment.id, 'no attachment id');
    assert.strictEqual(attachment.type, 'image');
    assert.strictEqual(attachment.description, 'A tiny dot');
    assert.ok(attachment.url && attachment.preview_url, 'no urls');

    // The exact bytes are in the pod, world-readable.
    const raw = await fetch(attachment.url);
    assert.strictEqual(raw.status, 200);
    assert.deepStrictEqual(Buffer.from(await raw.arrayBuffer()), PNG, 'bytes did not round-trip');

    // GET /api/v1/media/:id resolves it; PUT updates the description.
    const got = await fetch(`${base}/api/v1/media/${attachment.id}`, authed(token));
    assert.strictEqual(got.status, 200);
    const put = await fetch(`${base}/api/v1/media/${attachment.id}`, {
      method: 'PUT', headers: authedJson(token), body: JSON.stringify({ description: 'Updated alt text' }),
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual((await put.json()).description, 'Updated alt text');
  });

  it('multipart abuse is a 422, not a 500 (missing boundary, no file, nested multipart)', async () => {
    const cases = [
      { ct: 'multipart/form-data', body: Buffer.from('junk') }, //         no boundary
      { ct: 'multipart/form-data; boundary=b', body: Buffer.from('--b\r\ncontent-disposition: form-data; name="x"\r\n\r\nv\r\n--b--\r\n') }, // no file part
      { ct: 'multipart/form-data; boundary=b', body: Buffer.from('--b\r\ncontent-disposition: form-data; name="file"; filename="f"\r\ncontent-type: multipart/mixed; boundary=c\r\n\r\nzz\r\n--b--\r\n') }, // nested
    ];
    for (const c of cases) {
      const res = await fetch(`${base}/api/v2/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': c.ct },
        body: c.body,
      });
      assert.strictEqual(res.status, 422, `expected 422, got ${res.status}`);
    }
    // Anonymous upload is 401 (with CORS).
    const anon = await fetch(`${base}/api/v2/media`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b' }, body: '--b--' });
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.headers.get('access-control-allow-origin'), '*');
  });

  it('a status can carry the uploaded photo (media_ids → media_attachments + AS2 attachment)', async () => {
    const res = await post(token, { status: 'look at this dot', media_ids: [attachment.id] });
    assert.strictEqual(res.status, 200);
    const status = await res.json();
    assert.strictEqual(status.media_attachments.length, 1);
    assert.strictEqual(status.media_attachments[0].url, attachment.url);
    assert.strictEqual(status.media_attachments[0].type, 'image');

    // The AS2 Note carries the attachment array (so it federates later).
    const note = await (await fetch(status.uri, authed(token))).json();
    assert.ok(Array.isArray(note.attachment) && note.attachment.length === 1, 'Note.attachment missing');
    assert.strictEqual(note.attachment[0].url, attachment.url);
    assert.strictEqual(note.attachment[0].mediaType, 'image/png');

    // Unknown media id → 422.
    const bad = await post(token, { status: 'x', media_ids: ['AAAA'] });
    assert.strictEqual(bad.status, 422);
  });

  // ---------------------------------------------------------------- threads

  let threadRoot;
  let threadReply;

  it('replies thread: in_reply_to_id lands on the Note, and /context walks the chain', async () => {
    threadRoot = await (await post(token, { status: 'thread root' })).json();
    threadReply = await (await post(token, { status: 'thread reply', in_reply_to_id: threadRoot.id })).json();
    assert.strictEqual(threadReply.in_reply_to_id, threadRoot.id);
    assert.strictEqual(threadReply.in_reply_to_account_id, USER);

    const ctxReply = await (await fetch(`${base}/api/v1/statuses/${threadReply.id}/context`, authed(token))).json();
    assert.ok(ctxReply.ancestors.some((s) => s.id === threadRoot.id), 'root not in ancestors');
    assert.deepStrictEqual(ctxReply.descendants, []);

    const ctxRoot = await (await fetch(`${base}/api/v1/statuses/${threadRoot.id}/context`, authed(token))).json();
    assert.deepStrictEqual(ctxRoot.ancestors, []);
    assert.ok(ctxRoot.descendants.some((s) => s.id === threadReply.id), 'reply not in descendants');
  });

  // ------------------------------------------------------- favourite / boost

  it('favourite → favourited:true + count, appears in /favourites and /favourited_by; unfavourite undoes', async () => {
    const fav = await fetch(`${base}/api/v1/statuses/${firstStatus.id}/favourite`, { method: 'POST', ...authed(token) });
    assert.strictEqual(fav.status, 200);
    const favd = await fav.json();
    assert.strictEqual(favd.favourited, true);
    assert.strictEqual(favd.favourites_count, 1);

    const list = await (await fetch(`${base}/api/v1/favourites`, authed(token))).json();
    assert.ok(list.some((s) => s.id === firstStatus.id), 'not in favourites list');

    const by = await (await fetch(`${base}/api/v1/statuses/${firstStatus.id}/favourited_by`, authed(token))).json();
    assert.ok(by.some((a) => a.username === USER), 'not in favourited_by');

    const un = await (await fetch(`${base}/api/v1/statuses/${firstStatus.id}/unfavourite`, { method: 'POST', ...authed(token) })).json();
    assert.strictEqual(un.favourited, false);
    assert.strictEqual(un.favourites_count, 0);
  });

  it('reblog → reblogged:true + count; unreblog undoes; anonymous action is 401', async () => {
    const rb = await (await fetch(`${base}/api/v1/statuses/${firstStatus.id}/reblog`, { method: 'POST', ...authed(token) })).json();
    assert.strictEqual(rb.reblogged, true);
    assert.strictEqual(rb.reblogs_count, 1);
    const un = await (await fetch(`${base}/api/v1/statuses/${firstStatus.id}/unreblog`, { method: 'POST', ...authed(token) })).json();
    assert.strictEqual(un.reblogged, false);

    const anon = await fetch(`${base}/api/v1/statuses/${firstStatus.id}/favourite`, { method: 'POST' });
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.headers.get('access-control-allow-origin'), '*');
  });

  // ------------------------------------------------------------- pagination

  it('timelines paginate: ?limit + Link rel=next/prev, no overlap between pages', async () => {
    for (let i = 1; i <= 6; i++) {
      const r = await post(token, { status: `page filler ${i}` });
      assert.strictEqual(r.status, 200);
    }
    const p1 = await fetch(`${base}/api/v1/timelines/home?limit=5`, authed(token));
    assert.strictEqual(p1.status, 200);
    const page1 = await p1.json();
    assert.strictEqual(page1.length, 5, `limit=5 gave ${page1.length}`);
    const link = p1.headers.get('link');
    assert.ok(link, 'no Link header');
    assert.strictEqual(p1.headers.get('access-control-expose-headers'), 'link', 'Link not CORS-exposed');
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    const prev = /<([^>]+)>;\s*rel="prev"/.exec(link);
    assert.ok(next, `no rel=next in ${link}`);
    assert.ok(prev, `no rel=prev in ${link}`);

    const p2 = await fetch(next[1], authed(token));
    assert.strictEqual(p2.status, 200);
    const page2 = await p2.json();
    assert.ok(page2.length >= 1, 'second page empty');
    const ids1 = new Set(page1.map((s) => s.id));
    assert.ok(page2.every((s) => !ids1.has(s.id)), 'pages overlap');
    // Strictly older content on page 2.
    assert.ok(page2.every((s) => s.created_at <= page1.at(-1).created_at), 'page 2 not older');

    // since_id gives only the newer side.
    const sinceRes = await fetch(`${base}/api/v1/timelines/home?since_id=${page1.at(-1).id}&limit=40`, authed(token));
    const since = await sinceRes.json();
    assert.ok(since.every((s) => !page2.some((o) => o.id === s.id)), 'since_id leaked older statuses');
  });

  // ------------------------------------------------ multi-user: public + follow

  it('public?local=true shows ALL local users (podsRoot discovery)', async () => {
    const r = await post(token2, { status: 'bob speaks' });
    assert.strictEqual(r.status, 200);
    const pub = await fetch(`${base}/api/v1/timelines/public?local=true`, authed(token));
    assert.strictEqual(pub.status, 200);
    const timeline = await pub.json();
    const users = new Set(timeline.map((s) => s.account.username));
    assert.ok(users.has(USER2), `bob missing from public timeline (${[...users]})`);
    assert.ok(users.has(USER), `alice missing from public timeline (${[...users]})`);
    // Anonymous public timeline also works (public-read pods).
    const anon = await fetch(`${base}/api/v1/timelines/public?local=true`);
    assert.strictEqual(anon.status, 200);
    assert.ok((await anon.json()).some((s) => s.account.username === USER2));
  });

  it('follow a local user → relationships true → their posts join home; unfollow undoes', async () => {
    const fo = await fetch(`${base}/api/v1/accounts/${USER2}/follow`, { method: 'POST', ...authed(token) });
    assert.strictEqual(fo.status, 200);
    assert.strictEqual((await fo.json()).following, true);

    const rel = await (await fetch(`${base}/api/v1/accounts/relationships?id[]=${USER2}`, authed(token))).json();
    assert.strictEqual(rel[0].id, USER2);
    assert.strictEqual(rel[0].following, true);

    const home = await (await fetch(`${base}/api/v1/timelines/home?limit=40`, authed(token))).json();
    assert.ok(home.some((s) => s.account.username === USER2), 'followed user missing from home');

    const un = await fetch(`${base}/api/v1/accounts/${USER2}/unfollow`, { method: 'POST', ...authed(token) });
    assert.strictEqual((await un.json()).following, false);
    const home2 = await (await fetch(`${base}/api/v1/timelines/home?limit=40`, authed(token))).json();
    assert.ok(!home2.some((s) => s.account.username === USER2), 'unfollowed user still in home');
  });

  it('account endpoints: GET :id, lookup, :id/statuses (paginated), 404 for unknowns', async () => {
    const acc = await fetch(`${base}/api/v1/accounts/${USER2}`);
    assert.strictEqual(acc.status, 200);
    assert.strictEqual((await acc.json()).id, USER2);

    const lu = await fetch(`${base}/api/v1/accounts/lookup?acct=@${USER2}`);
    assert.strictEqual(lu.status, 200);
    assert.strictEqual((await lu.json()).username, USER2);

    const sts = await fetch(`${base}/api/v1/accounts/${USER}/statuses?limit=3`, authed(token));
    assert.strictEqual(sts.status, 200);
    const list = await sts.json();
    assert.strictEqual(list.length, 3);
    assert.ok(list.every((s) => s.account.username === USER));
    assert.match(sts.headers.get('link') || '', /rel="next"/);

    for (const bad of [`${base}/api/v1/accounts/nobody-here`, `${base}/api/v1/accounts/lookup?acct=nobody-here`,
      `${base}/api/v1/accounts/${USER2}@elsewhere.example`]) {
      const r = await fetch(bad);
      assert.strictEqual(r.status, 404, `expected 404 for ${bad}`);
    }
  });

  // ------------------------------------------------------------------ delete

  it('DELETE /api/v1/statuses/:id: owner deletes, non-owner 403, anonymous 401', async () => {
    const victim = await (await post(token, { status: 'delete me' })).json();

    const anon = await fetch(`${base}/api/v1/statuses/${victim.id}`, { method: 'DELETE' });
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.headers.get('access-control-allow-origin'), '*');

    const asBob = await fetch(`${base}/api/v1/statuses/${victim.id}`, { method: 'DELETE', ...authed(token2) });
    assert.strictEqual(asBob.status, 403);

    const asOwner = await fetch(`${base}/api/v1/statuses/${victim.id}`, { method: 'DELETE', ...authed(token) });
    assert.strictEqual(asOwner.status, 200);
    assert.strictEqual((await asOwner.json()).text, 'delete me');

    const gone = await fetch(`${base}/api/v1/statuses/${victim.id}`, authed(token));
    assert.strictEqual(gone.status, 404);
  });

  it('the widened PUT/DELETE verbs cannot fall through to LDP (catch-all 404s, with CORS)', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const res = await fetch(`${base}/api/v1/no-such-surface/xyz`, { method, body: method === 'PUT' ? 'data' : undefined });
      assert.strictEqual(res.status, 404, `${method}: expected the shim's 404, got ${res.status}`);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
      assert.match(res.headers.get('content-type') || '', /json/, `${method} fell through to something un-json`);
    }
    // And nothing got written to storage at that path.
    const check = await fetch(`${base}/api/v1/no-such-surface/xyz`);
    assert.notStrictEqual(check.status, 200);
  });

  // ------------------------------------------------------------ notifications

  it('notifications: AP inbox activities map to follow/favourite/mention entities', async (t) => {
    // The integration contract with the parallel activitypub/ work:
    // GET {apRoot}/<user>/inbox?page=true (owner Bearer) → OrderedCollectionPage.
    const probe = await fetch(`${base}/ap/${USER}/inbox?page=true`, authed(token));
    if (probe.status === 404) {
      t.skip('SKIPPED LOUDLY: activitypub/ does not expose GET /ap/<user>/inbox?page=true yet '
        + '(parallel Wave A work) — the mastodon side degrades to an empty notifications tab.');
      return;
    }

    // Seed the inbox directly (the AP plugin accepts anonymous inbox POSTs
    // by design; the actor URL is TEST-NET so its SSRF gate skips delivery).
    const inbox = `${base}/ap/${USER}/inbox`;
    const remoteActor = 'http://203.0.113.9/users/carol';
    const seed = (activity) => fetch(inbox, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', ...activity }),
    });
    const follow = await seed({
      id: `${remoteActor}#follow-1`, type: 'Follow', actor: remoteActor,
      object: `${base}/ap/${USER}/actor`, published: new Date().toISOString(),
    });
    assert.ok(follow.ok, `Follow seed: ${follow.status}`);
    const like = await seed({
      id: `${remoteActor}#like-1`, type: 'Like', actor: remoteActor,
      object: firstStatus.uri, published: new Date().toISOString(),
    });
    assert.ok(like.ok, `Like seed: ${like.status}`);
    const mention = await seed({
      id: `${remoteActor}#create-1`, type: 'Create', actor: remoteActor,
      published: new Date().toISOString(),
      object: {
        id: `http://203.0.113.9/notes/1`, type: 'Note',
        attributedTo: remoteActor, content: `hi @${USER}`,
        inReplyTo: firstStatus.uri, published: new Date().toISOString(),
      },
    });
    assert.ok(mention.ok, `Create seed: ${mention.status}`);

    const res = await fetch(`${base}/api/v1/notifications`, authed(token));
    assert.strictEqual(res.status, 200);
    const notifs = await res.json();
    const types = notifs.map((n) => n.type);
    assert.ok(types.includes('follow'), `no follow in ${JSON.stringify(types)}`);
    assert.ok(types.includes('favourite'), `no favourite in ${JSON.stringify(types)}`);
    assert.ok(types.includes('mention'), `no mention in ${JSON.stringify(types)}`);

    const fav = notifs.find((n) => n.type === 'favourite');
    assert.strictEqual(fav.status.id, firstStatus.id, 'favourite did not resolve the liked status');
    assert.strictEqual(fav.account.acct, 'carol@203.0.113.9', 'remote account not parsed from actor URL');
    assert.ok(fav.created_at, 'no created_at');

    const men = notifs.find((n) => n.type === 'mention');
    assert.match(men.status.content, /hi @/);

    // Anonymous notifications are 401 (with CORS).
    const anon = await fetch(`${base}/api/v1/notifications`);
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(anon.headers.get('access-control-allow-origin'), '*');
  });

  // ------------------------------------------------------------------ stubs

  it('every stub Phanpy touches answers its empty shape, with CORS', async () => {
    const emptyArrays = [
      '/api/v1/custom_emojis', '/api/v1/filters', '/api/v2/filters', '/api/v1/lists',
      '/api/v1/bookmarks', '/api/v1/follow_requests', '/api/v1/conversations',
      '/api/v1/scheduled_statuses', '/api/v1/announcements', '/api/v1/mutes',
      '/api/v1/blocks', '/api/v1/domain_blocks', '/api/v1/instance/peers',
      '/api/v1/trends', '/api/v1/trends/tags', '/api/v1/trends/statuses',
      '/api/v1/trends/links', '/api/v2/trends/statuses', '/api/v1/directory',
      '/api/v1/timelines/tag/solid',
    ];
    for (const p of emptyArrays) {
      const res = await fetch(`${base}${p}`, authed(token));
      assert.strictEqual(res.status, 200, `${p}: ${res.status}`);
      assert.deepStrictEqual(await res.json(), [], `${p} not []`);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*', `${p}: no CORS`);
    }
    const markers = await fetch(`${base}/api/v1/markers?timeline[]=home`, authed(token));
    assert.deepStrictEqual(await markers.json(), {});
    const markersPost = await fetch(`${base}/api/v1/markers`, { method: 'POST', headers: authedJson(token), body: '{}' });
    assert.strictEqual(markersPost.status, 200);
    const prefs = await (await fetch(`${base}/api/v1/preferences`, authed(token))).json();
    assert.strictEqual(prefs['posting:default:visibility'], 'public');
    const search = await (await fetch(`${base}/api/v2/search?q=x`, authed(token))).json();
    assert.deepStrictEqual(search, { accounts: [], statuses: [], hashtags: [] });
    const health = await fetch(`${base}/api/v1/streaming/health`);
    assert.strictEqual(health.status, 200);
    assert.strictEqual(await health.text(), 'OK');
    // Preflights carry the full header set Phanpy sends.
    const pre = await fetch(`${base}/api/v1/statuses`, { method: 'OPTIONS' });
    assert.strictEqual(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') || '', /idempotency-key/i);
    assert.match(pre.headers.get('access-control-allow-methods') || '', /DELETE/);
  });
});
