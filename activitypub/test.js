// ActivityPub actor plugin over a real JSS from npm. Drives the Phase-1
// vertical slice:
//
//   fetch actor   → GET  /ap/<user>/actor        (Person + real publicKeyPem)
//   post          → POST /ap/<user>/outbox        "hello fediverse" (owner Bearer)
//   read outbox   → GET  /ap/<user>/outbox        OrderedCollection contains it
//   be followed   → POST /ap/<user>/inbox         a Follow activity
//   list followers→ GET  /ap/<user>/followers     contains the follower
//   read inbox    → GET  /ap/<user>/inbox         owner Bearer pages the log
//                                                 (newest first, published
//                                                 stamped); anon → 401
//   auth boundary → POST /ap/<user>/outbox        no Bearer → 401
//
// Same probe-port-then-boot dance as mastodon/: the plugin needs its origin
// in config before listen (finding: api.serverInfo), and idp:true gives the
// /idp/register + /idp/credentials the owner Bearer rides on. No appPaths:
// since JSS 0.0.219 the plugin reserves the fixed /ap root itself
// (api.reservePath, #602).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
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
      // No appPaths: the fixed AP paths live OUTSIDE the plugin's single
      // prefix, and as of JSS 0.0.219 the plugin claims + WAC-exempts the
      // one /ap root itself via api.reservePath (#602) — the literal-root
      // half of the finding, consumed. The SHARPER half stays open: the
      // natural AP layout wants paths interleaved with the pod's /<user>/
      // namespace (the parameterized case), and /ap is still the workaround.
      // NOTE: allowPrivateDelivery is deliberately NOT set — the instance runs
      // the DEFAULT (closed) SSRF policy, so the loopback-actor test below
      // exercises the real production default. maxInbox is lowered only so the
      // flood test can cross the cap without thousands of requests.
      plugins: [{ module: module_, config: { baseUrl: base, maxInbox: 20 } }],
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

  // ---- THE INBOX LOG (owner-read surface for mastodon/ timelines) -----------

  it('GET /ap/<user>/inbox anonymous is 401 (the log is the owner\'s private mail)', async () => {
    const res = await fetch(`${base}/ap/${USER}/inbox`);
    assert.strictEqual(res.status, 401);
    const page = await fetch(`${base}/ap/${USER}/inbox?page=true`);
    assert.strictEqual(page.status, 401);
  });

  it('GET /ap/<user>/inbox (owner Bearer) pages the log newest-first; the Follow carries published', async () => {
    const res = await fetch(`${base}/ap/${USER}/inbox`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/activity+json' },
    });
    assert.strictEqual(res.status, 200);
    const coll = await res.json();
    assert.strictEqual(coll.type, 'OrderedCollection');
    assert.ok(coll.totalItems >= 2, `expected the Follow + Create in the log, got ${coll.totalItems}`);

    const page = await (await fetch(`${base}/ap/${USER}/inbox?page=true`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assert.strictEqual(page.type, 'OrderedCollectionPage');
    assert.ok(Array.isArray(page.orderedItems), 'no orderedItems');
    // The earlier Follow (POSTed with no published) is in the log, stamped at ingest.
    const follow = page.orderedItems.find((a) => a.type === 'Follow' && a.actor === REMOTE_FOLLOWER);
    assert.ok(follow, 'earlier Follow not in the inbox log');
    assert.ok(follow.published, 'stored Follow carries no published stamp');
    // Newest first: the Create was POSTed after the Follow.
    const iCreate = page.orderedItems.findIndex((a) => a.type === 'Create');
    const iFollow = page.orderedItems.findIndex((a) => a.type === 'Follow');
    assert.ok(iCreate < iFollow, `log not newest-first (Create at ${iCreate}, Follow at ${iFollow})`);
  });

  it('a Like and an Announce POSTed to the inbox land in the log with type intact', async () => {
    for (const activity of [
      { type: 'Like', id: `${REMOTE_FOLLOWER}#likes/1`, actor: REMOTE_FOLLOWER, object: `${base}/${USER}/public/statuses/x.jsonld` },
      { type: 'Announce', id: `${REMOTE_FOLLOWER}#boosts/1`, actor: REMOTE_FOLLOWER, object: `${base}/${USER}/public/statuses/x.jsonld` },
    ]) {
      const res = await fetch(`${base}/ap/${USER}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', ...activity }),
      });
      assert.strictEqual(res.status, 200);
    }
    const page = await (await fetch(`${base}/ap/${USER}/inbox?page=true`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const like = page.orderedItems.find((a) => a.id === `${REMOTE_FOLLOWER}#likes/1`);
    const boost = page.orderedItems.find((a) => a.id === `${REMOTE_FOLLOWER}#boosts/1`);
    assert.ok(like, 'Like not retained in the inbox log');
    assert.strictEqual(like.type, 'Like');
    assert.ok(like.published, 'Like carries no published stamp');
    assert.ok(boost, 'Announce not retained in the inbox log');
    assert.strictEqual(boost.type, 'Announce');
    assert.ok(boost.published, 'Announce carries no published stamp');
    // Newest first: the Announce was POSTed last, so it heads the page.
    assert.strictEqual(page.orderedItems[0].id, `${REMOTE_FOLLOWER}#boosts/1`);
  });

  it('read-time backfill: a legacy inbox entry without published is stamped from receivedAt', async () => {
    // Entries stored BEFORE ingest-time stamping existed have no published;
    // inject one straight into the state file (the format the plugin persists)
    // and assert the read path backfills it. statePath/readState are defined
    // with the security regressions below — same describe scope.
    const state = readState();
    state.inbox.push({
      receivedAt: '2020-01-01T00:00:00.000Z',
      activity: { type: 'Like', id: 'urn:legacy:unstamped', actor: REMOTE_FOLLOWER },
    });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    const page = await (await fetch(`${base}/ap/${USER}/inbox?page=true`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const legacy = page.orderedItems.find((a) => a.id === 'urn:legacy:unstamped');
    assert.ok(legacy, 'legacy entry not served');
    assert.strictEqual(legacy.published, '2020-01-01T00:00:00.000Z');
  });

  it('inReplyTo survives outbox POST → pod resource → outbox collection (threading)', async () => {
    const parent = 'https://remote.example/users/bob/statuses/12345';
    const res = await fetch(`${base}/ap/${USER}/outbox`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/activity+json' },
      body: JSON.stringify({ type: 'Note', content: 'a threaded reply', inReplyTo: parent }),
    });
    assert.ok([200, 201].includes(res.status), `outbox POST: ${res.status}`);
    const create = await res.json();
    assert.strictEqual(create.object.inReplyTo, parent, 'returned Create lost inReplyTo');

    // The stored pod resource carries it…
    const raw = await (await fetch(create.object.id, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.strictEqual(raw.inReplyTo, parent, 'pod Note lost inReplyTo');

    // …and so does the outbox collection item.
    const page = await (await fetch(`${base}/ap/${USER}/outbox?page=true`)).json();
    const item = page.orderedItems.find((it) => it.object?.content === 'a threaded reply');
    assert.ok(item, 'reply Note not in outbox');
    assert.strictEqual(item.object.inReplyTo, parent, 'outbox item lost inReplyTo');
  });

  // ---- SECURITY REGRESSIONS -------------------------------------------------

  // Path to the per-actor state file. No explicit `id` is passed for the entry;
  // since JSS 0.0.219 (#596 fix) the loader derives the id from the parent dir
  // of a generic basename → 'activitypub'; pluginDir is <root>/.plugins/<id>/
  // (see plugins.js), state lives under state/<user>.json.
  const statePath = () => path.join(jss.root, '.plugins', 'activitypub', 'state', `${USER}.json`);
  const readState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));

  it('SSRF: a Follow with a private/loopback actor URL is refused delivery (default config)', async () => {
    // Stand up a loopback "internal service" and count every hit. A default
    // instance (allowPrivateDelivery unset) must NEVER fetch it: the actor URL
    // resolves to 127.0.0.1, so fetchActorInbox is gated to null.
    let hits = 0;
    const internal = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/activity+json' });
      res.end(JSON.stringify({ id: 'x', inbox: `http://127.0.0.1/inbox` }));
    });
    const iport = await probePort();
    await new Promise((r) => internal.listen(iport, '127.0.0.1', r));
    try {
      const privateActor = `http://127.0.0.1:${iport}/users/attacker`;
      const res = await fetch(`${base}/ap/${USER}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify({
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${privateActor}#follows/1`,
          type: 'Follow',
          actor: privateActor,
          object: `${base}/ap/${USER}/actor`,
        }),
      });
      // The inbox POST itself still succeeds (unauthenticated-by-design store)…
      assert.strictEqual(res.status, 200);
      // …but the SSRF gate meant the private host was never contacted.
      await new Promise((r) => setTimeout(r, 150)); // let any (buggy) delivery fire
      assert.strictEqual(hits, 0, `SSRF gate leaked: private host got ${hits} request(s)`);
      // The follower is still recorded, but with no resolvable inbox.
      const rec = readState().followers.find((f) => f.actor === privateActor);
      assert.ok(rec, 'follower not recorded');
      assert.ok(!rec.inbox, `expected no delivery inbox, got ${rec.inbox}`);
    } finally {
      await new Promise((r) => internal.close(r));
    }
  });

  it('DoS: the inbox log stays bounded (maxInbox) when flooded past the cap', async () => {
    // maxInbox is 20 for this instance; flood well past it and assert the
    // persisted log is trimmed to the most recent N rather than growing forever.
    for (let i = 0; i < 60; i++) {
      await fetch(`${base}/ap/${USER}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify({ type: 'Like', id: `urn:flood:${i}`, actor: REMOTE_FOLLOWER }),
      });
    }
    const inbox = readState().inbox;
    assert.ok(inbox.length <= 20, `inbox not bounded: ${inbox.length} > 20`);
    // The trim keeps the newest entries (last flood id is present).
    assert.ok(
      inbox.some((e) => e.activity?.id === 'urn:flood:59'),
      'newest flooded activity was trimmed away',
    );
  });

  it('DoS: duplicate Follows do not grow the followers ledger', async () => {
    const dupActor = 'https://remote.example/users/dupfollower';
    const follow = () => fetch(`${base}/ap/${USER}/inbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${dupActor}#follows/dup`,
        type: 'Follow',
        actor: dupActor,
        object: `${base}/ap/${USER}/actor`,
      }),
    });
    for (let i = 0; i < 5; i++) assert.strictEqual((await follow()).status, 200);
    const count = readState().followers.filter((f) => f.actor === dupActor).length;
    assert.strictEqual(count, 1, `duplicate Follows created ${count} ledger entries`);
  });
});
