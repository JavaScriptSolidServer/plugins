// Two-server ActivityPub federation over loopback — the "federation with no
// cloud" scenario. NOT a plugin: a demo composition of webfinger/ +
// activitypub/ across TWO independent JSS instances on one machine.
//
//   server A (127.0.0.1:<portA>)  hosts alice   allowPrivateDelivery: true
//   server B (127.0.0.1:<portB>)  hosts bob     DEFAULT config (gate closed)
//
// Both instances run as CHILD PROCESSES (instance.js): JSS's storage root is
// process-global (process.env.DATA_ROOT, re-read per request by the IdP and
// storage layers), so two live createServer instances in one process would
// both serve whichever root booted last. Two servers ⇒ two processes.
//
// The flow: webfinger discovery of alice from B's side → bob follows alice
// (cross-origin actor URLs) → A's plugin delivers a signed Accept OUTBOUND
// to B (works because A opted into allowPrivateDelivery, the documented
// escape hatch for private-network/test deployments — the SSRF gate's
// default stays untouched) → alice posts a Note via her outbox → A fans the
// Create out to bob's inbox on B (plugin-outbound delivery, same opt-in) →
// the REVERSE direction shows the production default: B (gate closed)
// refuses to resolve/deliver to alice's loopback actor, so the test driver
// couriers bob's post A-ward and says so. Nothing in the gate is weakened:
// server B exercises exactly the default the security regression tests in
// activitypub/test.js protect.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  AP_CT, getJson, postActivity, registerUser, sleep, spawnInstance, waitFor,
} from './harness.js';

const PASS = 'correct horse battery staple';
const NOTE_A = 'Hello from server A — federation with no cloud!';
const NOTE_B = 'Greetings back from server B, delivered by hand.';

describe('federation-demo: two JSS instances federate over loopback', () => {
  let A; let B; //           the two servers (child processes)
  let tokenA; let tokenB; // owner Bearers: alice@A, bob@B
  let aliceActor; let bobActor; // canonical cross-origin actor URLs

  before(async () => {
    // Sequential spawn: each child probes its own port; spawning serially
    // avoids any probe race between the two processes.
    A = await spawnInstance({ name: 'a', allowPrivateDelivery: true });
    B = await spawnInstance({ name: 'b' }); // production-default SSRF policy
    tokenA = await registerUser(A.base, 'alice', PASS);
    tokenB = await registerUser(B.base, 'bob', PASS);
    aliceActor = `${A.base}/ap/alice/actor`;
    bobActor = `${B.base}/ap/bob/actor`;
  });

  after(async () => {
    await Promise.all([A?.stop(), B?.stop()]);
  });

  it('the two instances are genuinely distinct origins', () => {
    assert.notStrictEqual(A.port, B.port);
    assert.notStrictEqual(A.root, B.root);
  });

  it('DISCOVERY: B-side resolves acct:alice@A via A\'s /.well-known/webfinger', async () => {
    const acct = `acct:alice@127.0.0.1:${A.port}`;
    const res = await fetch(
      `${A.base}/.well-known/webfinger?resource=${encodeURIComponent(acct)}`,
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/jrd\+json/);
    const jrd = await res.json();
    assert.strictEqual(jrd.subject, acct);
    const self = jrd.links.find((l) => l.rel === 'self' && l.type === AP_CT);
    assert.ok(self, `no rel=self AP link in JRD: ${JSON.stringify(jrd.links)}`);
    // Host binding via api.serverInfo: the JRD mints hrefs on A's live
    // origin without webfinger being handed a baseUrl.
    assert.strictEqual(self.href, aliceActor);
  });

  it('DISCOVERY: the discovered actor document is a Person with a real key', async () => {
    const actor = await getJson(aliceActor);
    assert.strictEqual(actor.type, 'Person');
    assert.strictEqual(actor.id, aliceActor);
    assert.strictEqual(actor.inbox, `${A.base}/ap/alice/inbox`);
    assert.match(actor.publicKey?.publicKeyPem || '', /-----BEGIN PUBLIC KEY-----/);
  });

  it('FOLLOW: bob\'s B-hosted Follow lands in alice\'s inbox on A; followers is cross-origin', async () => {
    // bob's actor id is his REAL actor URL on server B — a different origin
    // than anything server A hosts. This is what single-instance tests
    // can't exercise: A must fetch B to resolve the follower's inbox.
    const res = await postActivity(`${A.base}/ap/alice/inbox`, {
      id: `${bobActor}#follows/alice`,
      type: 'Follow',
      actor: bobActor,
      object: aliceActor,
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.accepted, bobActor);

    const followers = await getJson(`${A.base}/ap/alice/followers`);
    assert.ok(
      followers.orderedItems.includes(bobActor),
      `bob's B-hosted actor URL not in alice's followers: ${JSON.stringify(followers.orderedItems)}`,
    );

    // A resolved bob's delivery inbox by fetching his actor doc FROM B —
    // possible only because A runs allowPrivateDelivery: true (the
    // documented opt-in; both servers here are loopback).
    const rec = A.readState('alice').followers.find((f) => f.actor === bobActor);
    assert.ok(rec, 'follower not persisted on A');
    assert.strictEqual(rec.inbox, `${B.base}/ap/bob/inbox`);
  });

  it('FOLLOW: A delivers a signed Accept outbound to bob\'s inbox on B (plugin-initiated)', async () => {
    // This is real server-to-server delivery: A's plugin signed and POSTed
    // the Accept to B without the driver touching it. (B stores it without
    // verifying the signature — the plugin's documented Phase-2 boundary.)
    const entry = await waitFor(
      () => B.readState('bob').inbox.find(
        (e) => e.activity?.type === 'Accept' && e.activity?.actor === aliceActor,
      ),
      'signed Accept from alice in bob\'s inbox log on B',
    );
    assert.strictEqual(entry.activity.object?.type, 'Follow');
    assert.strictEqual(entry.activity.object?.actor, bobActor);
  });

  it('PUBLISH: alice posts a Note via her outbox (owner Bearer)', async () => {
    const res = await postActivity(
      `${A.base}/ap/alice/outbox`,
      { type: 'Note', content: NOTE_A },
      { token: tokenA },
    );
    assert.strictEqual(res.status, 201);
    const create = await res.json();
    assert.strictEqual(create.type, 'Create');
    assert.strictEqual(create.object.content, NOTE_A);
    assert.ok(create.object.id.startsWith(A.base), 'Note id not minted on A');

    const page = await getJson(`${A.base}/ap/alice/outbox?page=true`);
    assert.ok(
      page.orderedItems.some((it) => it.object?.content === NOTE_A),
      'posted Note missing from alice\'s outbox',
    );
  });

  it('DELIVERY: A\'s plugin delivers the Create to bob\'s inbox on B (via allowPrivateDelivery)', async () => {
    // Plugin-outbound delivery WORKS on this repo's activitypub plugin: the
    // outbox POST fans the Create out to followers itself, and the SSRF
    // gate lets the loopback target through only because server A opted
    // into allowPrivateDelivery (documented, test/private-network use).
    // No driver courier needed in this direction.
    const entry = await waitFor(
      () => B.readState('bob').inbox.find(
        (e) => e.activity?.type === 'Create' && e.activity?.object?.content === NOTE_A,
      ),
      'alice\'s Create in bob\'s inbox log on B',
    );
    assert.strictEqual(entry.activity.actor, aliceActor);
  });

  it('REVERSE: alice follows bob on default-config B — the SSRF gate refuses loopback resolution', async () => {
    const res = await postActivity(`${B.base}/ap/bob/inbox`, {
      id: `${aliceActor}#follows/bob`,
      type: 'Follow',
      actor: aliceActor,
      object: bobActor,
    });
    assert.strictEqual(res.status, 200); // the Follow is still recorded…

    const followers = await getJson(`${B.base}/ap/bob/followers`);
    assert.ok(followers.orderedItems.includes(aliceActor));

    // …but B (allowPrivateDelivery unset — the production default the
    // security regression tests protect) refused to fetch alice's loopback
    // actor URL, so no delivery inbox was resolved and no Accept went out.
    const rec = B.readState('bob').followers.find((f) => f.actor === aliceActor);
    assert.ok(rec, 'follower not persisted on B');
    assert.ok(!rec.inbox, `default SSRF gate should refuse loopback, got inbox ${rec.inbox}`);

    await sleep(300); // let any (buggy) Accept delivery fire
    assert.ok(
      !A.readState('alice').inbox.some(
        (e) => e.activity?.type === 'Accept' && e.activity?.actor === bobActor,
      ),
      'B delivered an Accept despite its default-closed SSRF gate',
    );
  });

  it('REVERSE: bob posts; B cannot deliver (default gate), so the DRIVER couriers it — honestly', async () => {
    const res = await postActivity(
      `${B.base}/ap/bob/outbox`,
      { type: 'Note', content: NOTE_B },
      { token: tokenB },
    );
    assert.strictEqual(res.status, 201);

    // B's fan-out skips alice (no resolved inbox — gate held), so nothing
    // arrives on A by itself.
    await sleep(400);
    assert.ok(
      !A.readState('alice').inbox.some((e) => e.activity?.object?.content === NOTE_B),
      'B delivered outbound despite its default-closed SSRF gate',
    );

    // The open wall, worked around in the open: on a default-config server
    // the plugin cannot deliver to private/loopback peers (by design), and
    // there is no core delivery/event seam (api.events, #603) a plugin
    // could hand the job to. So the driver plays courier: read bob's
    // outbox, POST the Create to alice's inbox — exactly what a relay
    // outside the private network would do.
    const page = await getJson(`${B.base}/ap/bob/outbox?page=true`);
    const create = page.orderedItems.find((it) => it.object?.content === NOTE_B);
    assert.ok(create, 'bob\'s Note missing from his outbox on B');
    const deliver = await postActivity(`${A.base}/ap/alice/inbox`, create);
    assert.strictEqual(deliver.status, 200);

    const entry = await waitFor(
      () => A.readState('alice').inbox.find(
        (e) => e.activity?.type === 'Create' && e.activity?.object?.content === NOTE_B,
      ),
      'bob\'s Create in alice\'s inbox log on A',
    );
    assert.strictEqual(entry.activity.actor, bobActor);
  });
});
