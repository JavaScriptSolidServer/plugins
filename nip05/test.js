// NIP-05 plugin over a real JSS from npm.
//
// The headline assertion is the well-known one: the plugin registers
// `GET /.well-known/nostr.json` — an absolute path OUTSIDE its mount
// prefix — and an unauthenticated fetch gets the document. That works
// (see README findings) because the loader doesn't confine routes to the
// prefix and core blanket-exempts /.well-known/* from auth; the same
// document is also asserted at the contract-safe `<prefix>/nostr.json`.
// Note the default server is NOT public-read (notifications' tests need
// explicit .acl files for anonymous reads), so the anonymous 200 here is
// a real demonstration of the exemption, not of a permissive default.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PLUGIN = path.join(__dirname, 'plugin.js');

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const xonly = (fillByte) => hex(schnorr.getPublicKey(new Uint8Array(32).fill(fillByte)));

/** f-form Multikey as core's provisioner emits: f + e701 + parity + x-only. */
const fForm = (pubHex) => `f` + 'e701' + '02' + pubHex;

/** secp256k1 JWK (x + matching even-parity y) for an x-only pubkey. */
function jwkFor(pubHex) {
  const { y } = secp256k1.ProjectivePoint.fromHex('02' + pubHex).toAffine();
  return {
    kty: 'EC',
    crv: 'secp256k1',
    x: Buffer.from(pubHex, 'hex').toString('base64url'),
    y: Buffer.from(y.toString(16).padStart(64, '0'), 'hex').toString('base64url'),
  };
}

/** Minimal profile card shaped like src/webid/profile.js output. */
function writeCard(podDir, webId, vmProps) {
  fs.mkdirSync(path.join(podDir, 'profile'), { recursive: true });
  const card = {
    '@id': webId,
    '@type': ['foaf:Person'],
    'foaf:name': 'Test',
    ...(vmProps && {
      verificationMethod: [{
        '@id': `${webId.split('#')[0]}#owner-key`,
        '@type': 'Multikey',
        controller: webId,
        ...vmProps,
      }],
    }),
  };
  fs.writeFileSync(path.join(podDir, 'profile', 'card.jsonld'), JSON.stringify(card, null, 2));
}

describe('nip05 plugin', () => {
  const alice = xonly(1); // advertised via publicKeyMultibase (f-form)
  const bob = xonly(2); // advertised via publicKeyJwk
  const rootKey = xonly(3); // single-user layout: card at the root itself
  const dave = xonly(4); // pod created after boot

  let jss;
  let relayUrl;
  after(async () => { if (jss) await jss.close(); });

  before(async () => {
    const port = await probePort();
    relayUrl = `ws://127.0.0.1:${port}/relay`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-nip05-'));

    writeCard(path.join(root, 'alice'), 'https://x/alice/profile/card#me',
      { publicKeyMultibase: fForm(alice) });
    writeCard(path.join(root, 'bob'), 'https://x/bob/profile/card#me',
      { publicKeyJwk: jwkFor(bob) });
    // carol has a card but no key — must be absent from the mapping.
    writeCard(path.join(root, 'carol'), 'https://x/carol/profile/card#me', null);
    // mallory declares a key in an encoding the provisioner never emits
    // (z-base58 multibase) — must be skipped, not mis-served.
    writeCard(path.join(root, 'mallory'), 'https://x/mallory/profile/card#me',
      { publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' });
    // dot-guarded trees are never pods.
    writeCard(path.join(root, '.idp'), 'https://x/.idp/profile/card#me',
      { publicKeyMultibase: fForm(xonly(9)) });
    // single-user layout: the pod IS the root → reserved `_` name.
    writeCard(root, 'https://x/profile/card#me', { publicKeyMultibase: fForm(rootKey) });

    jss = await startJss({
      port,
      root,
      plugins: [{
        module: PLUGIN,
        prefix: '/nip05',
        config: { podsRoot: root, relayUrl },
      }],
    });
  });

  it('serves the aggregated mapping at /.well-known/nostr.json, unauthenticated', async () => {
    const res = await fetch(`${jss.base}/.well-known/nostr.json`);
    assert.strictEqual(res.status, 200, 'anonymous GET on the absolute well-known path');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*',
      'NIP-05 requires open CORS for browser verifiers');
    const body = await res.json();
    assert.strictEqual(body.names.alice, alice, 'publicKeyMultibase (f-form) pod');
    assert.strictEqual(body.names.bob, bob, 'publicKeyJwk pod');
    assert.strictEqual(body.names._, rootKey, 'root card maps to the reserved `_` name');
    assert.ok(!('carol' in body.names), 'pod without a key is absent');
    assert.ok(!('mallory' in body.names), 'undecodable key encoding is absent');
    assert.ok(!Object.keys(body.names).some((n) => n.startsWith('.')), 'no dot-dirs');
  });

  it('auto-includes relays for every listed pubkey when relayUrl is set', async () => {
    const body = await (await fetch(`${jss.base}/.well-known/nostr.json`)).json();
    assert.deepStrictEqual(body.relays[alice], [relayUrl]);
    assert.deepStrictEqual(body.relays[bob], [relayUrl]);
    assert.deepStrictEqual(
      Object.keys(body.relays).sort(),
      Object.values(body.names).sort(),
      'relays keys are exactly the advertised pubkeys',
    );
  });

  it('serves the identical document under its own prefix (the contract-safe mount)', async () => {
    const viaPrefix = await fetch(`${jss.base}/nip05/nostr.json`);
    assert.strictEqual(viaPrefix.status, 200);
    assert.deepStrictEqual(
      await viaPrefix.json(),
      await (await fetch(`${jss.base}/.well-known/nostr.json`)).json(),
    );
  });

  it('?name= returns only the requested mapping (NIP-05 query form)', async () => {
    const body = await (await fetch(`${jss.base}/.well-known/nostr.json?name=alice`)).json();
    assert.deepStrictEqual(body.names, { alice });
    assert.deepStrictEqual(Object.keys(body.relays), [alice], 'relays filtered too');
  });

  it('?name= for an unknown name yields a well-formed empty mapping', async () => {
    const res = await fetch(`${jss.base}/.well-known/nostr.json?name=nobody`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.names, {});
    assert.ok(!('relays' in body), 'no relays block when nothing is listed');
  });

  it('picks up pods provisioned after boot (scan per request, no cache)', async () => {
    writeCard(path.join(jss.root, 'dave'), 'https://x/dave/profile/card#me',
      { publicKeyMultibase: fForm(dave) });
    const body = await (await fetch(`${jss.base}/.well-known/nostr.json`)).json();
    assert.strictEqual(body.names.dave, dave);
  });

  it('activates without podsRoot and serves an empty names map', async () => {
    const bare = await startJss({
      plugins: [{ module: PLUGIN, prefix: '/nip05' }],
    });
    try {
      for (const url of [`${bare.base}/.well-known/nostr.json`, `${bare.base}/nip05/nostr.json`]) {
        const res = await fetch(url);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { names: {} });
      }
    } finally {
      await bare.close();
    }
  });
});
