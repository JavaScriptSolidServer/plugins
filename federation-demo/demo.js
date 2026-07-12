// federation-demo/demo.js — federation with no cloud, narrated.
//
//   node federation-demo/demo.js
//
// Boots TWO independent JavaScript Solid Server instances on loopback (each
// in its own child process — JSS's data root is process-global, so two live
// servers cannot share one process), registers alice on A and bob on B, and
// walks real ActivityPub federation mechanics between them: webfinger
// discovery, a cross-origin Follow, a signed Accept delivered server-to-
// server, a Note published via the outbox and fanned out to the follower's
// inbox on the other server — then the reverse direction, where server B's
// production-default SSRF gate (correctly) refuses loopback delivery and
// the script couriers the activity by hand, saying so.
//
// Loopback only. No external network. Exit 0 on success.

import {
  AP_CT, getJson, postActivity, registerUser, sleep, spawnInstance, waitFor,
} from './harness.js';

const PASS = 'correct horse battery staple';
const NOTE_A = 'Hello from server A — federation with no cloud!';
const NOTE_B = 'Greetings back from server B, delivered by hand.';

// ------------------------------------------------------------- narration
let stepNo = 0;
const line = (s = '') => console.log(s);
const step = (title) => {
  stepNo += 1;
  line();
  line(`── Step ${stepNo}: ${title}`);
};
const say = (s) => line(`   ${s}`);
const show = (label, obj) => {
  say(`${label}:`);
  for (const l of JSON.stringify(obj, null, 2).split('\n')) line(`     ${l}`);
};
/** Pick a few fields so the JSON snippets stay readable. */
const pick = (obj, keys) => Object.fromEntries(
  keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]),
);

let A = null;
let B = null;

async function main() {
  line('╔══════════════════════════════════════════════════════════════╗');
  line('║  Federation with no cloud — two Solid servers, one machine    ║');
  line('║  webfinger discovery + ActivityPub follow/publish/delivery    ║');
  line('╚══════════════════════════════════════════════════════════════╝');

  // ---------------------------------------------------------------------
  step('boot two independent JSS instances (child processes, loopback only)');
  say('JSS keeps its data root in process-global state (process.env.DATA_ROOT,');
  say('re-read per request), so two live servers cannot share one process —');
  say('each instance runs in its own child process. See federation-demo/README.md.');
  A = await spawnInstance({ name: 'a', allowPrivateDelivery: true });
  say(`server A up: ${A.base}   (data root ${A.root})`);
  say('         └── allowPrivateDelivery: true — the activitypub plugin\'s');
  say('             DOCUMENTED opt-in for private-network/test deployments.');
  say('             Its SSRF gate refuses loopback delivery targets by');
  say('             default; on a loopback-only demo, A must opt in or it');
  say('             could never deliver to B at 127.0.0.1.');
  B = await spawnInstance({ name: 'b' });
  say(`server B up: ${B.base}   (data root ${B.root})`);
  say('         └── DEFAULT config — B keeps the production SSRF policy,');
  say('             so the demo also shows what the gate refuses.');

  // ---------------------------------------------------------------------
  step('register alice on A and bob on B (each server\'s own IdP)');
  const tokenA = await registerUser(A.base, 'alice', PASS);
  say(`alice registered on A — pod ${A.base}/alice/ (owner Bearer minted)`);
  const tokenB = await registerUser(B.base, 'bob', PASS);
  say(`bob   registered on B — pod ${B.base}/bob/ (owner Bearer minted)`);
  const aliceActor = `${A.base}/ap/alice/actor`;
  const bobActor = `${B.base}/ap/bob/actor`;

  // ---------------------------------------------------------------------
  step(`DISCOVERY — B\'s side resolves alice via webfinger on A`);
  const acct = `acct:alice@127.0.0.1:${A.port}`;
  const wfUrl = `${A.base}/.well-known/webfinger?resource=${encodeURIComponent(acct)}`;
  say(`GET ${wfUrl}`);
  const jrd = await getJson(wfUrl, 'application/jrd+json');
  show('JRD', {
    subject: jrd.subject,
    links: jrd.links.filter((l) => l.rel === 'self' || l.rel.includes('profile-page')),
  });
  const self = jrd.links.find((l) => l.rel === 'self' && l.type === AP_CT);
  if (self?.href !== aliceActor) throw new Error(`expected actor ${aliceActor}, JRD says ${self?.href}`);
  say('the rel=self link is alice\'s ActivityPub actor URL — minted from A\'s');
  say('live origin via api.serverInfo (webfinger got no baseUrl in config).');
  const actor = await getJson(aliceActor);
  show('actor document (excerpt)', {
    ...pick(actor, ['id', 'type', 'preferredUsername', 'inbox', 'outbox']),
    publicKeyPem: `${actor.publicKey.publicKeyPem.split('\n')[0]}…`,
  });

  // ---------------------------------------------------------------------
  step('FOLLOW — bob (a REAL actor on B) follows alice on A');
  const follow = {
    id: `${bobActor}#follows/alice`,
    type: 'Follow',
    actor: bobActor,
    object: aliceActor,
  };
  show('Follow activity', follow);
  say(`POST ${A.base}/ap/alice/inbox`);
  say('(the driver couriers the Follow itself: the Phase-1 activitypub');
  say(' plugin has no outbound-Follow client — its `following` collection');
  say(' is empty by design, a documented Phase-2 boundary)');
  const fRes = await postActivity(`${A.base}/ap/alice/inbox`, follow);
  if (fRes.status !== 200) throw new Error(`Follow → ${fRes.status}`);
  say(`→ ${fRes.status} accepted`);
  const followers = await getJson(`${A.base}/ap/alice/followers`);
  show('alice\'s followers on A', followers.orderedItems);
  if (!followers.orderedItems.includes(bobActor)) throw new Error('bob not in followers');
  say('note the follower id is CROSS-ORIGIN: an actor URL hosted on B.');

  say('');
  say('now watch A act on its own: it fetched bob\'s actor doc FROM B to');
  say('resolve his inbox, and delivers a SIGNED Accept back to B…');
  const accept = await waitFor(
    () => B.readState('bob').inbox.find(
      (e) => e.activity?.type === 'Accept' && e.activity?.actor === aliceActor,
    ),
    'signed Accept in bob\'s inbox on B',
  );
  show('arrived in bob\'s inbox log on B', {
    receivedAt: accept.receivedAt,
    activity: pick(accept.activity, ['type', 'actor']),
  });
  say('that was genuine server-to-server delivery (A → B), HTTP-signed with');
  say('alice\'s RSA key. It cleared A\'s SSRF gate only via the documented');
  say('allowPrivateDelivery opt-in — the gate itself is untouched.');

  // ---------------------------------------------------------------------
  step('PUBLISH — alice posts a Note via her outbox (owner Bearer)');
  say(`POST ${A.base}/ap/alice/outbox   "${NOTE_A}"`);
  const pRes = await postActivity(
    `${A.base}/ap/alice/outbox`,
    { type: 'Note', content: NOTE_A },
    { token: tokenA },
  );
  if (pRes.status !== 201) throw new Error(`outbox POST → ${pRes.status}`);
  const create = await pRes.json();
  show('201 Create', {
    type: create.type,
    actor: create.actor,
    object: pick(create.object, ['id', 'type', 'content']),
  });
  say('the Note is stored IN ALICE\'S POD over loopback LDP under real WAC —');
  say('the pod is the store, the plugin is just the AP face.');

  // ---------------------------------------------------------------------
  step('DELIVERY — A fans the Create out to bob\'s inbox on B (plugin-initiated)');
  const delivered = await waitFor(
    () => B.readState('bob').inbox.find(
      (e) => e.activity?.type === 'Create' && e.activity?.object?.content === NOTE_A,
    ),
    'alice\'s Create in bob\'s inbox on B',
  );
  show('arrived in bob\'s inbox log on B', {
    receivedAt: delivered.receivedAt,
    activity: {
      ...pick(delivered.activity, ['type', 'actor']),
      object: pick(delivered.activity.object, ['content']),
    },
  });
  say('no driver involved: A\'s activitypub plugin signed and POSTed this to');
  say(`${B.base}/ap/bob/inbox on its own, at publish time.`);
  say('(B stores it without verifying the HTTP signature — inbound');
  say(' verification is the plugin\'s documented Phase-2 boundary.)');

  // ---------------------------------------------------------------------
  step('REVERSE — alice follows bob on B, which runs the PRODUCTION default');
  const followBack = {
    id: `${aliceActor}#follows/bob`,
    type: 'Follow',
    actor: aliceActor,
    object: bobActor,
  };
  say(`POST ${B.base}/ap/bob/inbox   (Follow, actor = alice@A)`);
  const fbRes = await postActivity(`${B.base}/ap/bob/inbox`, followBack);
  if (fbRes.status !== 200) throw new Error(`Follow back → ${fbRes.status}`);
  const bobFollowers = await getJson(`${B.base}/ap/bob/followers`);
  show('bob\'s followers on B', bobFollowers.orderedItems);
  const rec = B.readState('bob').followers.find((f) => f.actor === aliceActor);
  if (rec?.inbox) throw new Error('B resolved a loopback inbox — gate should have refused');
  say('B recorded the follower BUT refused to fetch alice\'s actor URL:');
  say(`   follower record on B: { actor: alice@A, inbox: ${JSON.stringify(rec?.inbox ?? null)} }`);
  say('that is the SSRF gate doing its job — 127.0.0.1 is a private target');
  say('and B never opted into allowPrivateDelivery. No Accept was sent.');

  // ---------------------------------------------------------------------
  step('REVERSE — bob posts; B cannot deliver to loopback, the DRIVER couriers');
  say(`POST ${B.base}/ap/bob/outbox   "${NOTE_B}"`);
  const bRes = await postActivity(
    `${B.base}/ap/bob/outbox`,
    { type: 'Note', content: NOTE_B },
    { token: tokenB },
  );
  if (bRes.status !== 201) throw new Error(`bob outbox POST → ${bRes.status}`);
  await sleep(400);
  if (A.readState('alice').inbox.some((e) => e.activity?.object?.content === NOTE_B)) {
    throw new Error('B delivered outbound despite its default-closed SSRF gate');
  }
  say('→ 201 Create on B; nothing arrived on A by itself (gate held — honest).');
  say('');
  say('HONEST BIT: on a default-config server the plugin refuses loopback/');
  say('private delivery by design, and there is no core seam (api.events,');
  say('#603 / a delivery policy hook) to hand the job to. So this script now');
  say('does what an out-of-network relay would do — read bob\'s outbox and');
  say('POST the Create to alice\'s inbox BY HAND:');
  const page = await getJson(`${B.base}/ap/bob/outbox?page=true`);
  const bobCreate = page.orderedItems.find((it) => it.object?.content === NOTE_B);
  say(`   GET  ${B.base}/ap/bob/outbox?page=true   → found the Create`);
  const courier = await postActivity(`${A.base}/ap/alice/inbox`, bobCreate);
  if (courier.status !== 200) throw new Error(`courier delivery → ${courier.status}`);
  say(`   POST ${A.base}/ap/alice/inbox            → ${courier.status}`);
  const landed = await waitFor(
    () => A.readState('alice').inbox.find(
      (e) => e.activity?.type === 'Create' && e.activity?.object?.content === NOTE_B,
    ),
    'bob\'s Create in alice\'s inbox on A',
  );
  show('arrived in alice\'s inbox log on A', {
    receivedAt: landed.receivedAt,
    activity: {
      ...pick(landed.activity, ['type', 'actor']),
      object: pick(landed.activity.object, ['content']),
    },
  });

  // ---------------------------------------------------------------------
  step('shut down both servers');
  await Promise.all([A.stop(), B.stop()]);
  A = null;
  B = null;
  say('both instances stopped, throwaway data roots removed.');

  line();
  line('══════════════════════════════════════════════════════════════════');
  line('  Federation round trip complete — two Solid servers on one machine,');
  line('  loopback only, no cloud:');
  line('    • discovery   webfinger on A resolved alice for B\'s side');
  line('    • follow      bob@B → alice@A, cross-origin actor URLs');
  line('    • accept      A → B, plugin-signed and plugin-delivered');
  line('    • publish     alice\'s Note stored in her pod under real WAC');
  line('    • delivery    A → B plugin-initiated (allowPrivateDelivery opt-in);');
  line('                  B → A couriered by the driver (default SSRF gate held)');
  line('══════════════════════════════════════════════════════════════════');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`\nDEMO FAILED: ${err.stack || err}`);
  try { await Promise.all([A?.stop(), B?.stop()]); } catch { /* best effort */ }
  process.exit(1);
}
