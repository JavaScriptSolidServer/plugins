// RecordWeb (RWP) node plugin over a real JSS from npm.
//
// Exercises the full Record lifecycle on the public plugin surface:
//   * create → append draft → finalize (sign), owner-gated via getAgent;
//   * content-addressing: the snapshotHash recomputes from stored bytes, and
//     an anonymous / non-owner write is refused (401 / 403);
//   * finalize is one-way: a second finalize is 409, the draft stays in history;
//   * did:rwp resolution (native + DIF-universal shim) returns a DID document
//     whose currentVersion points at the finalized snapshot; a foreign
//     namespace and an unknown uuid resolve to 404;
//   * verify recomputes the snapshotHash AND checks the Ed25519 signature
//     against the owner's minted key;
//   * a Case Merkle-roots its hard-linked snapshots, and verify recomputes the
//     same root — tamper the input and the recompute diverges.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';
import { canonicalize, computeSnapshotHash, merkleRoot } from './plugin.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PLUGIN = path.join(__dirname, 'plugin.js');

async function mintToken(base, username) {
  const pass = 'record-pass';
  const reg = await fetch(`${base}/idp/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: pass, confirmPassword: pass }),
  });
  assert.ok([200, 201, 302].includes(reg.status), `register ${username}: ${reg.status}`);
  const cred = await fetch(`${base}/idp/credentials`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: pass }),
  });
  const body = await cred.json();
  assert.ok(body.access_token, `mint ${username}: ${JSON.stringify(body)}`);
  return body.access_token;
}

const postJson = (url, token, obj) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(obj),
});

describe('recordweb (RWP) plugin', () => {
  let jss; let base; let ns; let alice; let bob;

  after(async () => { if (jss) await jss.close(); });

  before(async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    ns = new URL(base).host;
    jss = await startJss({
      port, idp: true,
      plugins: [{ module: PLUGIN, prefix: '/recordweb' }],
    });
    alice = await mintToken(base, 'alice');
    bob = await mintToken(base, 'bob');
  });

  // ---- pure crypto units (no server) --------------------------------------
  it('JCS canonicalization sorts keys and drops whitespace (RFC 8785)', () => {
    assert.strictEqual(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.strictEqual(canonicalize({ z: [3, 2], a: 'x' }), '{"a":"x","z":[3,2]}');
  });

  it('the Merkle root is order-independent and one-in-one-out', () => {
    const a = 'sha256:' + '11'.repeat(32);
    const b = 'sha256:' + '22'.repeat(32);
    assert.strictEqual(merkleRoot([a, b]), merkleRoot([b, a]), 'sorted before folding');
    assert.strictEqual(merkleRoot([a]), a, 'a single hash is its own root');
    assert.notStrictEqual(merkleRoot([a, b]), merkleRoot([a]), 'adding a link changes the root');
  });

  // ---- lifecycle -----------------------------------------------------------
  let did; let uuid; let rootHash; let draftHash; let finalHash; let podCopy;

  it('refuses an anonymous create (writes need a pod agent)', async () => {
    const res = await postJson(`${base}/recordweb/records`, null, { payload: { hello: 'world' } });
    assert.strictEqual(res.status, 401);
  });

  it('creates a Record: mints a did:rwp, roots a draft snapshot', async () => {
    const res = await postJson(`${base}/recordweb/records`, alice, {
      recordType: 'did:rwp:example/note',
      payload: { title: 'Building permit', parcel: '451' },
    });
    assert.strictEqual(res.status, 201, await res.clone().text());
    const body = await res.json();
    did = body.did; uuid = did.split(':').pop();
    rootHash = body.snapshot.snapshotHash; draftHash = rootHash;
    assert.strictEqual(body.did, `did:rwp:${ns}:${uuid}`, 'DID is did:rwp:<host>:<uuid>');
    assert.strictEqual(body.snapshot.state, 'draft');
    assert.deepStrictEqual(body.snapshot.parents, [], 'root snapshot has no parents');
    assert.match(body.snapshot.snapshotHash, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(body.didDocument.controller, body.snapshot.owner, 'owner controls the DID');
  });

  it('appends a draft child snapshot (parent = head)', async () => {
    const res = await postJson(`${base}/recordweb/records/${uuid}/snapshots`, alice, {
      payload: { title: 'Building permit', parcel: '451', note: 'revised' },
    });
    assert.strictEqual(res.status, 201, await res.clone().text());
    const body = await res.json();
    assert.deepStrictEqual(body.snapshot.parents, [draftHash], 'child links to the previous head');
    draftHash = body.snapshot.snapshotHash;
  });

  it('refuses a non-owner append (403)', async () => {
    const res = await postJson(`${base}/recordweb/records/${uuid}/snapshots`, bob, { payload: { x: 1 } });
    assert.strictEqual(res.status, 403);
  });

  it('finalizes the draft: signs it, freezes it, advances currentVersion', async () => {
    const res = await postJson(`${base}/recordweb/records/${uuid}/snapshots/${draftHash.replace(':', '_')}/finalize`, alice, {});
    assert.strictEqual(res.status, 200, await res.clone().text());
    const body = await res.json();
    finalHash = body.snapshot.snapshotHash;
    assert.strictEqual(body.snapshot.state, 'finalized');
    assert.ok(body.snapshot.finalized, 'carries a finalized timestamp');
    assert.ok(body.snapshot.signature?.startsWith('z'), 'multibase signature present');
    assert.notStrictEqual(finalHash, draftHash, 'the state change gives a new content hash');
    assert.strictEqual(body.didDocument.currentVersion, finalHash, 'DID doc points at the finalized snapshot');
    podCopy = body.podCopy;
    assert.strictEqual(podCopy.delivered, true, `pod delivery: ${JSON.stringify(podCopy)}`);
    assert.ok(podCopy.snapshot.includes(`/alice/records/${uuid}/`), 'copy lands in the owner\'s pod');
  });

  it('the pod copy is content-honest — it re-hashes to the same snapshotHash', async () => {
    // The owner fetches their citizen-controlled copy from their own pod and
    // recomputes the hash; it must equal the sealed snapshotHash. WAC governs
    // the read (alice's bearer), proving the write went through the host, not
    // a plugin backdoor.
    const metaRes = await fetch(podCopy.snapshot, { headers: { authorization: `Bearer ${alice}` } });
    assert.strictEqual(metaRes.status, 200, 'owner reads the pod copy');
    const meta = await metaRes.json();
    const payload = Buffer.from(await (await fetch(podCopy.payload, { headers: { authorization: `Bearer ${alice}` } })).arrayBuffer());
    assert.strictEqual(computeSnapshotHash(meta, payload), finalHash, 'pod copy re-hashes to the sealed hash');
    assert.strictEqual(meta.state, 'finalized');
  });

  it('a non-owner cannot read another agent\'s pod copy (WAC still governs)', async () => {
    const res = await fetch(podCopy.snapshot, { headers: { authorization: `Bearer ${bob}` } });
    assert.ok([401, 403].includes(res.status), `bob is denied alice's pod copy (got ${res.status})`);
  });

  it('refuses a second finalize — finalization is one-way (409)', async () => {
    const res = await postJson(`${base}/recordweb/records/${uuid}/snapshots/${finalHash.replace(':', '_')}/finalize`, alice, {});
    assert.strictEqual(res.status, 409);
  });

  it('reads the Record with its version graph (draft nodes retained)', async () => {
    const body = await (await fetch(`${base}/recordweb/records/${uuid}`)).json();
    assert.strictEqual(body.state, 'finalized');
    assert.strictEqual(body.currentVersion, finalHash);
    assert.ok(body.versionGraph.nodes.length >= 3, 'root + revised draft + finalized all present');
    // Finalization is a state transition of the same logical snapshot — the
    // finalized node keeps the draft's parents (the root), it is not a child of
    // the draft. Both the revised draft and the finalized node descend from root.
    assert.ok(body.versionGraph.edges.some((e) => e.from === finalHash && e.to === rootHash),
      'the finalized snapshot descends from the root');
  });

  // ---- resolution ----------------------------------------------------------
  it('resolves the DID document (native + DIF-universal shim, identical)', async () => {
    const native = await (await fetch(`${base}/recordweb/resolve/${uuid}`)).json();
    assert.strictEqual(native.id, did);
    assert.strictEqual(native.currentVersion, finalHash);
    assert.ok(native.verificationMethod[0].publicKeyMultibase.startsWith('z6Mk'), 'Ed25519 Multikey');
    const universal = await (await fetch(`${base}/recordweb/1.0/identifiers/${encodeURIComponent(did)}`)).json();
    assert.deepStrictEqual(universal, native, 'both resolver shapes agree');
  });

  it('404s an unknown uuid and rejects a foreign namespace', async () => {
    const unknown = await fetch(`${base}/recordweb/resolve/00000000-0000-4000-8000-000000000000`);
    assert.strictEqual(unknown.status, 404);
    const foreign = await fetch(`${base}/recordweb/1.0/identifiers/${encodeURIComponent('did:rwp:elsewhere.example:' + uuid)}`);
    assert.strictEqual(foreign.status, 404, 'a DID from another namespace does not resolve here');
  });

  // ---- verification --------------------------------------------------------
  it('verifies the finalized snapshot: hash recomputes AND signature checks out', async () => {
    const v = await (await fetch(`${base}/recordweb/verify/records/${uuid}/${finalHash.replace(':', '_')}`)).json();
    assert.strictEqual(v.payloadValid, true);
    assert.strictEqual(v.hashValid, true, 'stored snapshotHash equals the recompute');
    assert.strictEqual(v.signatureValid, true, 'Ed25519 signature verifies against the owner key');
    assert.strictEqual(v.recomputed, finalHash);
  });

  it('the finalized snapshot hash matches an independent local recompute', async () => {
    const snap = await (await fetch(`${base}/recordweb/records/${uuid}/snapshots/${finalHash.replace(':', '_')}`)).json();
    const payloadUrl = `${base}/recordweb/records/${uuid}/payload/${finalHash.replace(':', '_')}`;
    const payload = Buffer.from(await (await fetch(payloadUrl)).arrayBuffer());
    assert.strictEqual(computeSnapshotHash(snap, payload), finalHash, 'client-side JCS agrees with the server');
  });

  // ---- cases ---------------------------------------------------------------
  let caseUuid; let caseRoot;
  it('creates a Case that Merkle-roots its hard-linked snapshots', async () => {
    const res = await postJson(`${base}/recordweb/cases`, alice, {
      title: 'Building Permit Musterstrasse 12',
      trigger: { type: 'hard', recordDid: did, snapshotHash: finalHash },
      context: [{ type: 'hard', recordDid: did, snapshotHash: finalHash, role: 'application' }],
    });
    assert.strictEqual(res.status, 201, await res.clone().text());
    const body = await res.json();
    caseUuid = body.caseId.split(':').pop(); caseRoot = body.merkleRoot;
    assert.match(caseRoot, /^sha256:[0-9a-f]{64}$/);
    assert.strictEqual(body.finalizable, true, 'no soft links → finalizable');
    assert.strictEqual(caseRoot, merkleRoot([finalHash, finalHash]), 'root matches an independent recompute');
  });

  it('a soft link blocks Case finalization', async () => {
    const res = await postJson(`${base}/recordweb/cases`, alice, {
      title: 'Open case', context: [{ recordDid: did }], // no snapshotHash = soft link
    });
    const body = await res.json();
    assert.strictEqual(body.finalizable, false);
  });

  it('verifies the Case Merkle root by recomputation', async () => {
    const v = await (await fetch(`${base}/recordweb/verify/cases/${caseUuid}`)).json();
    assert.strictEqual(v.merkleRootValid, true);
    assert.strictEqual(v.recomputed, caseRoot);
    assert.strictEqual(v.hardLinkCount, 2);
  });

  // ---- discovery -----------------------------------------------------------
  it('publishes the resolver-discovery doc (HTTP mirror of the DNS-TXT record)', async () => {
    const res = await fetch(`${base}/.well-known/rwp-resolver.json`);
    assert.strictEqual(res.status, 200, 'well-known resolver doc resolves anonymously');
    const doc = await res.json();
    assert.strictEqual(doc.v, 'rwp1');
    assert.strictEqual(doc.namespace, ns);
    assert.ok(doc.resolve.includes('/1.0/identifiers/'), 'advertises the universal-resolver path');
  });
});
