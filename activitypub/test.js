// ActivityPub actor plugin over a real JSS from npm. Drives the Phase-1
// vertical slice:
//
//   fetch actor   → GET  /ap/<user>/actor        (Person + real publicKeyPem)
//   post          → POST /ap/<user>/outbox        "hello fediverse" (owner Bearer)
//   read outbox   → GET  /ap/<user>/outbox        OrderedCollection contains it
//   be followed   → POST /ap/<user>/inbox         a Follow activity
//   list followers→ GET  /ap/<user>/followers     contains the follower
//   auth boundary → POST /ap/<user>/outbox        no Bearer → 401
//
// Same probe-port-then-boot dance as mastodon/: the plugin needs its origin
// in config before listen (finding: api.serverInfo), idp:true gives the
// /idp/register + /idp/credentials the owner Bearer rides on, and appPaths
// widens WAC past the plugin's single prefix to the fixed AP root.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const USER = 'fedialice';
const PASS = 'correct horse battery staple';
const REMOTE_FOLLOWER = 'https://remote.example/users/bob';

describe('activitypub plugin', () => {
  let jss;
  let base;
  let token;

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without baseUrl (no api.serverInfo — same finding as mastodon/notifications)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_ }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + the AP plugin, registers a pod owner, mints a Bearer', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      // The finding in action: the fixed AP paths live OUTSIDE the plugin's
      // single prefix, and the loader WAC-exempts only that prefix. Keeping
      // everything under one /ap root means the operator exempts ONE path.
      appPaths: ['/ap'],
      plugins: [{ module: module_, config: { baseUrl: base } }],
    });
    const reg = await fetch(`${base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, confirmPassword: PASS }),
    });
    assert.ok([200, 201, 302].includes(reg.status), `register: ${reg.status}`);

    const cred = await fetch(`${base}/idp/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    assert.strictEqual(cred.status, 200, `credentials: ${cred.status}`);
    token = (await cred.json()).access_token;
    assert.ok(token, 'no access_token from /idp/credentials');
  });

  it('GET /ap/<user>/actor is an AS2 Person with a real public key', async () => {
    const res = await fetch(`${base}/ap/${USER}/actor`, { headers: { accept: 'application/activity+json' } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/activity\+json/);
    const actor = await res.json();
    assert.strictEqual(actor.type, 'Person');
    assert.strictEqual(actor.preferredUsername, USER);
    assert.match(actor.id, new RegExp(`/ap/${USER}/actor$`));
    assert.match(actor.inbox, new RegExp(`/ap/${USER}/inbox$`));
    assert.match(actor.outbox, new RegExp(`/ap/${USER}/outbox$`));
    assert.ok(actor.publicKey, 'no publicKey');
    assert.match(actor.publicKey.publicKeyPem, /-----BEGIN PUBLIC KEY-----/, 'no PEM public key');
    assert.strictEqual(actor.publicKey.owner, actor.id);
  });

  it('the actor keypair is stable across fetches (persisted in pluginDir)', async () => {
    const a = await (await fetch(`${base}/ap/${USER}/actor`)).json();
    const b = await (await fetch(`${base}/ap/${USER}/actor`)).json();
    assert.strictEqual(a.publicKey.publicKeyPem, b.publicKey.publicKeyPem);
  });

  it('POST /ap/<user>/outbox unauthenticated is 401', async () => {
    const res = await fetch(`${base}/ap/${USER}/outbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Note', content: 'anon should fail' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('POST /ap/<user>/outbox (owner Bearer) stores a Note and returns a Create', async () => {
    const res = await fetch(`${base}/ap/${USER}/outbox`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Note', content: 'hello fediverse' }),
    });
    assert.ok([200, 201].includes(res.status), `outbox POST: ${res.status}`);
    const create = await res.json();
    assert.strictEqual(create.type, 'Create');
    assert.strictEqual(create.object.type, 'Note');
    assert.strictEqual(create.object.content, 'hello fediverse');

    // It really landed in the pod as a JSON-LD resource under the owner.
    const noteUrl = create.object.id;
    const raw = await fetch(noteUrl, { headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(raw.status, 200, `pod note fetch: ${raw.status}`);
    const note = await raw.json();
    assert.strictEqual(note.type, 'Note');
    assert.strictEqual(note.content, 'hello fediverse');
  });

  it('a non-owner (unauth) cannot post even with a valid path', async () => {
    const res = await fetch(`${base}/ap/${USER}/outbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Note', content: 'nope' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('GET /ap/<user>/outbox is an OrderedCollection containing the Note', async () => {
    const res = await fetch(`${base}/ap/${USER}/outbox`);
    assert.strictEqual(res.status, 200);
    const coll = await res.json();
    assert.strictEqual(coll.type, 'OrderedCollection');
    assert.ok(coll.totalItems >= 1, `expected >=1, got ${coll.totalItems}`);

    // The page form carries the items inline.
    const page = await (await fetch(`${base}/ap/${USER}/outbox?page=true`)).json();
    assert.strictEqual(page.type, 'OrderedCollectionPage');
    assert.ok(Array.isArray(page.orderedItems), 'no orderedItems');
    assert.ok(
      page.orderedItems.some((it) => it.type === 'Create' && /hello fediverse/.test(it.object?.content || '')),
      'posted Note not in outbox',
    );
  });

  it('POST /ap/<user>/inbox accepts a Follow and records the follower', async () => {
    const res = await fetch(`${base}/ap/${USER}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${REMOTE_FOLLOWER}#follows/1`,
        type: 'Follow',
        actor: REMOTE_FOLLOWER,
        object: `${base}/ap/${USER}/actor`,
      }),
    });
    assert.strictEqual(res.status, 200);
  });

  it('GET /ap/<user>/followers lists the follower actor id', async () => {
    const res = await fetch(`${base}/ap/${USER}/followers`);
    assert.strictEqual(res.status, 200);
    const coll = await res.json();
    assert.strictEqual(coll.type, 'OrderedCollection');
    assert.ok(coll.orderedItems.includes(REMOTE_FOLLOWER), `follower not listed: ${JSON.stringify(coll.orderedItems)}`);
  });

  it('GET /ap/<user>/following is an OrderedCollection (empty in Phase 1)', async () => {
    const coll = await (await fetch(`${base}/ap/${USER}/following`)).json();
    assert.strictEqual(coll.type, 'OrderedCollection');
    assert.ok(Array.isArray(coll.orderedItems));
  });

  it('POST /ap/<user>/inbox stores a Create without requiring signature verification', async () => {
    const res = await fetch(`${base}/ap/${USER}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${REMOTE_FOLLOWER}#create/1`,
        type: 'Create',
        actor: REMOTE_FOLLOWER,
        object: { type: 'Note', content: 'hi from the fediverse' },
      }),
    });
    assert.strictEqual(res.status, 200);
  });
});
