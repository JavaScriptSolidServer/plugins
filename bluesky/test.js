// Bluesky / AT-Protocol XRPC shim over a real JSS from npm. Drives the whole
// Phase-1 vertical slice a client actually performs:
//
//   server meta   → GET  /xrpc/com.atproto.server.describeServer   (public)
//   log in        → POST /xrpc/com.atproto.server.createSession    (pod creds)
//   who am I      → GET  /xrpc/com.atproto.server.getSession
//   post          → POST /xrpc/com.atproto.repo.createRecord "hello bluesky"
//   list records  → GET  /xrpc/com.atproto.repo.listRecords
//   author feed   → GET  /xrpc/app.bsky.feed.getAuthorFeed
//
// Same probe-port-then-boot dance as mastodon/, notifications/ and webdav/:
// the shim needs its server origin in config before listen (finding:
// api.serverInfo), and idp:true gives us the /idp/register + /idp/credentials
// the token bridge rides on.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const USER = 'skyalice';
const PASS = 'correct horse battery staple';

const XRPC = (base, nsid) => `${base}/xrpc/${nsid}`;

describe('bluesky plugin', () => {
  let jss;
  let base;
  let session; // { accessJwt, did, handle }
  let postUri;

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without baseUrl (no api.serverInfo — same finding as mastodon/notifications)', async () => {
    // Order this failure BEFORE the long-lived boot: JSS keeps its data root in
    // a process-global that even a failing boot repoints (NOTES.md footgun).
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
      // The finding, closed: AT-Protocol's fixed `/xrpc/*` root — one root,
      // once unreachable without the operator widening appPaths by hand —
      // is self-reserved via api.reservePath (#602), consumed as of JSS
      // 0.0.219. No appPaths here, and the suite passing without them is
      // the proof. See README "Findings".
      plugins: [{ module: module_, config: { baseUrl: base } }],
    });
    const reg = await fetch(`${base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, confirmPassword: PASS }),
    });
    assert.ok([200, 201, 302].includes(reg.status), `register: ${reg.status}`);
  });

  it('describeServer is public JSON metadata with a service DID', async () => {
    const res = await fetch(XRPC(base, 'com.atproto.server.describeServer'));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.did, /^did:web:/, `no service did: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.availableUserDomains), 'availableUserDomains not an array');
  });

  it('createSession bridges pod creds to an accessJwt + did/handle', async () => {
    const res = await fetch(XRPC(base, 'com.atproto.server.createSession'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: USER, password: PASS }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.accessJwt, `no accessJwt: ${JSON.stringify(body)}`);
    assert.ok(body.refreshJwt, 'no refreshJwt');
    assert.strictEqual(body.handle, USER);
    assert.match(body.did, /^did:web:/);
    session = body;
  });

  it('bad password is rejected at createSession', async () => {
    const res = await fetch(XRPC(base, 'com.atproto.server.createSession'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: USER, password: 'wrong-password' }),
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.ok(body.error, 'no XRPC error field');
  });

  it('getSession returns the logged-in did/handle; anonymous is 401', async () => {
    const res = await fetch(XRPC(base, 'com.atproto.server.getSession'), {
      headers: { authorization: `Bearer ${session.accessJwt}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.handle, USER);
    assert.strictEqual(body.did, session.did);

    const anon = await fetch(XRPC(base, 'com.atproto.server.getSession'));
    assert.strictEqual(anon.status, 401);
  });

  it('createRecord stores an app.bsky.feed.post in the pod and returns an at:// uri', async () => {
    const res = await fetch(XRPC(base, 'com.atproto.repo.createRecord'), {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        repo: session.did,
        collection: 'app.bsky.feed.post',
        record: { text: 'hello bluesky', createdAt: new Date().toISOString() },
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.uri, /^at:\/\/did:web:.+\/app\.bsky\.feed\.post\/.+/, `bad uri: ${body.uri}`);
    assert.ok(body.cid, 'no cid');
    postUri = body.uri;

    // It really landed in the pod as a JSON resource under the owner's control.
    const rkey = postUri.split('/').pop();
    const raw = await fetch(`${base}/${USER}/public/bsky/${rkey}.json`, {
      headers: { authorization: `Bearer ${session.accessJwt}` },
    });
    assert.strictEqual(raw.status, 200);
    const record = await raw.json();
    assert.strictEqual(record.$type, 'app.bsky.feed.post');
    assert.strictEqual(record.text, 'hello bluesky');
  });

  it('anonymous createRecord is refused', async () => {
    const res = await fetch(XRPC(base, 'com.atproto.repo.createRecord'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection: 'app.bsky.feed.post', record: { text: 'nope' } }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('listRecords returns the just-posted record', async () => {
    const res = await fetch(
      `${XRPC(base, 'com.atproto.repo.listRecords')}?repo=${encodeURIComponent(session.did)}`
      + '&collection=app.bsky.feed.post',
      { headers: { authorization: `Bearer ${session.accessJwt}` } },
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.records), 'records not an array');
    assert.ok(body.records.length >= 1, `expected >=1 record, got ${body.records.length}`);
    assert.ok(body.records.some((r) => r.value.text === 'hello bluesky'), 'posted record missing');
    assert.ok(body.records.some((r) => r.uri === postUri), 'posted uri missing');
  });

  it('getAuthorFeed contains the post as a feed view', async () => {
    const res = await fetch(
      `${XRPC(base, 'app.bsky.feed.getAuthorFeed')}?actor=${encodeURIComponent(session.did)}`,
      { headers: { authorization: `Bearer ${session.accessJwt}` } },
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.feed), 'feed not an array');
    assert.ok(body.feed.length >= 1, `expected >=1 feed item, got ${body.feed.length}`);
    const item = body.feed[0];
    assert.ok(item.post, 'feed item has no post');
    assert.match(item.post.record.text, /hello bluesky/);
    assert.strictEqual(item.post.author.handle, USER);
    assert.match(item.post.uri, /^at:\/\//);
  });

  it('a second post appears first (newest-first ordering)', async () => {
    await fetch(XRPC(base, 'com.atproto.repo.createRecord'), {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: 'app.bsky.feed.post',
        record: { text: 'second skeet', createdAt: new Date().toISOString() },
      }),
    });
    const body = await (await fetch(
      `${XRPC(base, 'app.bsky.feed.getAuthorFeed')}?actor=${encodeURIComponent(session.did)}`,
      { headers: { authorization: `Bearer ${session.accessJwt}` } },
    )).json();
    assert.ok(body.feed.length >= 2, `expected >=2, got ${body.feed.length}`);
    assert.match(body.feed[0].post.record.text, /second skeet/);
  });
});
