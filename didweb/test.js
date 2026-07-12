// did:web resolver plugin over a real JSS from npm.
//
// Two footings are exercised:
//   * The root/server DID at `/.well-known/did.json` — served anonymously
//     because core blanket-exempts /.well-known/* from WAC (the same accident
//     nip05/ and webfinger/ lean on). Default server is NOT public-read, so
//     the anonymous 200 demonstrates the exemption, not a permissive default.
//   * The pathed per-pod DID at `/<user>/did.json` — which lands INSIDE the
//     pod's WAC-governed /<user>/ namespace. Since JSS 0.0.219 the plugin
//     reserves the parameterized shape via api.reservePath('/:user/did.json')
//     (#602), so the anonymous GET answers with NO ACL grant and NO appPaths
//     in the config (this config passes neither). The exact-shape guarantee
//     is asserted from both sides: the DID document resolves anonymously,
//     while a sibling pod resource, a deeper same-basename path, and a write
//     to did.json itself all stay WAC-denied. The contract-safe
//     `<prefix>/<user>/did.json` mount is asserted to be identical.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PLUGIN = path.join(__dirname, 'plugin.js');

/** Write a pod WebID card, optionally carrying a secp256k1 verificationMethod. */
function writeCard(podDir, webId, secpMultibase) {
  fs.mkdirSync(path.join(podDir, 'profile'), { recursive: true });
  const card = { '@id': webId, '@type': ['foaf:Person'], 'foaf:name': 'Test' };
  if (secpMultibase) {
    card.verificationMethod = [{
      id: `${webId}#nostr`,
      type: 'Multikey',
      controller: webId,
      publicKeyMultibase: secpMultibase,
    }];
  }
  fs.writeFileSync(path.join(podDir, 'profile', 'card.jsonld'), JSON.stringify(card, null, 2));
}

/** A fresh, valid, on-curve secp256k1 pubkey as an f-form Multikey. */
function freshSecpFForm() {
  const pub = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true); // compressed
  return 'f' + 'e701' + Buffer.from(pub).toString('hex');
}

describe('didweb plugin', () => {
  let jss;
  let base;
  let encHost;

  after(async () => { if (jss) await jss.close(); });

  before(async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    encHost = new URL(base).host.replace(/:/g, '%3A'); // 127.0.0.1%3A<port>

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-didweb-'));
    // alice: pod with a provisioned secp256k1 key. NO did.json ACL: the
    // ABSOLUTE pathed did:web location must resolve anonymously on the
    // strength of the parameterized reservation alone (#602).
    writeCard(path.join(root, 'alice'), `${base}/alice/profile/card#me`, freshSecpFForm());
    // carol: pod with NO key → the plugin mints + persists an Ed25519 VM.
    writeCard(path.join(root, 'carol'), `${base}/carol/profile/card#me`);
    // a dot-guarded tree that must never be treated as a pod.
    writeCard(path.join(root, '.idp'), `${base}/.idp/profile/card#me`);

    jss = await startJss({
      port,
      root,
      plugins: [{
        module: PLUGIN,
        prefix: '/didweb',
        // No baseUrl: the did:web host + service URLs now come from
        // api.serverInfo() (#601). The encHost assertions below (derived from
        // the real probed origin) must still hold — that's the retrofit proof.
        // No appPaths either (there is nowhere to pass one): the absolute
        // pathed mount is WAC-exempted by api.reservePath alone (#602).
        config: { podsRoot: root, actorPathTemplate: '/ap/<user>/actor' },
      }],
    });
  });

  it('serves the root DID at /.well-known/did.json (anonymous, did+json, open CORS)', async () => {
    const res = await fetch(`${base}/.well-known/did.json`);
    assert.strictEqual(res.status, 200, 'anonymous GET on the well-known DID path');
    assert.match(res.headers.get('content-type') || '', /application\/did\+json/, 'DID media type');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*', 'open CORS for resolvers');

    const doc = await res.json();
    assert.strictEqual(doc.id, `did:web:${encHost}`, 'root id is did:web:<host>');
    assert.ok(Array.isArray(doc.verificationMethod) && doc.verificationMethod.length >= 1,
      'root DID has at least one verificationMethod');
    const vm = doc.verificationMethod[0];
    assert.strictEqual(vm.type, 'Multikey', 'VM is a Multikey');
    assert.strictEqual(vm.controller, doc.id, 'VM controller is the DID');
    assert.ok(vm.publicKeyMultibase.startsWith('z'), 'base58btc multibase key');
    assert.ok(doc.authentication.includes(vm.id), 'authentication references the VM id');
    assert.ok(doc.assertionMethod.includes(vm.id), 'assertionMethod references the VM id');
    const pod = doc.service.find((s) => s.type === 'SolidPod');
    assert.ok(pod, 'a SolidPod service entry is present');
    assert.strictEqual(pod.serviceEndpoint, `${base}/`, 'root SolidPod points at the origin');
  });

  it('serves a pathed pod DID via the prefix mount with a secp256k1 VM from the card', async () => {
    const res = await fetch(`${base}/didweb/alice/did.json`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/did\+json/);
    const doc = await res.json();

    assert.strictEqual(doc.id, `did:web:${encHost}:alice`, 'pathed id is did:web:<host>:<user>');
    assert.ok(doc.alsoKnownAs.includes(`${base}/alice/profile/card#me`), 'alsoKnownAs binds the WebID');

    const vm = doc.verificationMethod.find((v) => v.id === `${doc.id}#owner-key`);
    assert.ok(vm, 'an owner-key VM derived from the card is present');
    assert.strictEqual(vm.type, 'Multikey');
    // secp256k1 Multikeys canonically start with the "zQ3s" base58btc prefix.
    assert.ok(vm.publicKeyMultibase.startsWith('zQ3s'), 'secp256k1 Multikey prefix');
    assert.ok(doc.authentication.includes(vm.id), 'authentication references the owner key');

    const pod = doc.service.find((s) => s.type === 'SolidPod');
    assert.strictEqual(pod.serviceEndpoint, `${base}/alice/`, 'SolidPod points at the pod URL');
    const ap = doc.service.find((s) => s.type === 'ActivityPubActor');
    assert.strictEqual(ap.serviceEndpoint, `${base}/ap/alice/actor`, 'AP actor service from actorPathTemplate');
  });

  it('resolves the ABSOLUTE pathed did:web location anonymously via the parameterized reservation', async () => {
    // No ACL grant, no appPaths: api.reservePath('/:user/did.json') (#602)
    // alone makes the spec-pinned URL answer inside the WAC-governed pod
    // namespace — the wall README finding 2 documented, closed in JSS 0.0.219.
    const res = await fetch(`${base}/alice/did.json`);
    assert.strictEqual(res.status, 200, 'anonymous GET answers with no ACL and no appPaths');
    assert.match(res.headers.get('content-type') || '', /application\/did\+json/);
    const doc = await res.json();
    assert.strictEqual(doc.id, `did:web:${encHost}:alice`);
    // Identical to the contract-safe prefix mount.
    const viaPrefix = await (await fetch(`${base}/didweb/alice/did.json`)).json();
    assert.deepStrictEqual(doc, viaPrefix, 'absolute and prefix mounts serve the identical DID document');
  });

  it('does not leak the exemption beyond the exact /<user>/did.json shape', async () => {
    // Sibling resource in the same pod namespace: still WAC-denied anonymously.
    const sibling = await fetch(`${base}/alice/profile/card.jsonld`);
    assert.ok([401, 403].includes(sibling.status),
      `sibling pod resource stays WAC-governed (got ${sibling.status})`);
    // Deeper path with the same basename: /:user/did.json is an EXACT-shape
    // match (two segments), not a subtree claim.
    const deeper = await fetch(`${base}/alice/sub/did.json`);
    assert.ok([401, 403].includes(deeper.status),
      `deeper did.json path stays WAC-governed (got ${deeper.status})`);
    // Reservations are read-only by default: a write to the reserved shape
    // itself must still hit WAC, not fall through as an anonymous LDP PUT.
    const put = await fetch(`${base}/alice/did.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"id":"spoofed"}',
    });
    assert.ok([401, 403].includes(put.status),
      `anonymous PUT on the reserved path is WAC-denied (got ${put.status})`);
  });

  it('mints + persists an Ed25519 VM for a pod with no key in its card', async () => {
    const res = await fetch(`${base}/didweb/carol/did.json`);
    assert.strictEqual(res.status, 200);
    const doc = await res.json();
    assert.strictEqual(doc.id, `did:web:${encHost}:carol`);
    const vm = doc.verificationMethod.find((v) => v.id === `${doc.id}#server-key`);
    assert.ok(vm, 'a minted server-key VM is present');
    // Ed25519 Multikeys canonically start with the "z6Mk" base58btc prefix.
    assert.ok(vm.publicKeyMultibase.startsWith('z6Mk'), 'Ed25519 Multikey prefix');
    assert.ok(doc.authentication.includes(vm.id), 'authentication references the minted key');

    // Persisted: a second resolution returns the SAME key, not a fresh mint.
    const again = await (await fetch(`${base}/didweb/carol/did.json`)).json();
    assert.strictEqual(again.verificationMethod.find((v) => v.id === `${doc.id}#server-key`).publicKeyMultibase,
      vm.publicKeyMultibase, 'minted key is persisted across requests');
  });

  it('404s for an unknown user (via the WAC-exempt prefix mount)', async () => {
    const res = await fetch(`${base}/didweb/nobody/did.json`);
    assert.strictEqual(res.status, 404, 'no pod → no DID');
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*', 'CORS on the 404 too');
  });

  it('does not serve a DID for a dot-guarded directory', async () => {
    // The plugin's own guard 404s a dotdir; core's dotfile guard 403s the
    // path before the handler even runs. Either way, no DID document — a
    // dotdir (.idp, .well-known, …) is never a resolvable pod.
    const res = await fetch(`${base}/didweb/.idp/did.json`);
    assert.ok([403, 404].includes(res.status), `dotdirs are never pods (got ${res.status})`);
    assert.notStrictEqual(res.status, 200, 'no DID document for a dotdir');
  });
});
