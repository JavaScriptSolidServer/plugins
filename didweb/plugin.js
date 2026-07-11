// did:web (W3C DID method, https://w3c-ccg.github.io/did-method-web/) as a
// #206 loader plugin — a DID document resolver for pods.
//
//   plugins: [{ module: 'didweb/plugin.js', prefix: '/didweb',
//               config: { podsRoot: './data',
//                         baseUrl: 'https://pod.example',
//                         actorPathTemplate: '/ap/<user>/actor', // optional AP service
//                         serviceEndpoints: [ /* extra service entries */ ] } }]
//
// did:web resolves a DID to an HTTPS-fetched DID document:
//   did:web:<host>          → GET https://<host>/.well-known/did.json
//   did:web:<host>:<user>   → GET https://<host>/<user>/did.json
// (the port, if any, is percent-encoded into the host: `localhost:3000` →
// `did:web:localhost%3A3000`). Any DID resolver — the DIF universal-resolver,
// did-resolver's web-did-resolver, veramo, etc. — turns the DID back into
// these URLs, so serving the two documents IS implementing the method.
//
// The DID document we serve, per scope (root/server vs per-pod):
//   { "@context": [...], "id": "did:web:<host>[:<user>]",
//     "alsoKnownAs": [ "<webid>" ],
//     "verificationMethod": [ Multikey … ],
//     "authentication": [ "#…" ], "assertionMethod": [ "#…" ],
//     "service": [ { type: "SolidPod", serviceEndpoint: "<pod-url>" }, … ] }
//
// verificationMethod is derived from the pod's PUBLIC profile card the same
// way nip05/ and webfinger/ read it: the provisioned Nostr owner key
// (#437/#443) in `<pod>/profile/card.jsonld`'s verificationMethod, re-encoded
// as a base58btc secp256k1 Multikey. If a pod carries no such key we MINT and
// persist an Ed25519 keypair in pluginDir (node:crypto) so every resolvable
// DID always has at least one key + an authentication reference. `alsoKnownAs`
// binds the DID to the pod's WebID (the two identities are the same subject),
// and a SolidPod service entry links to the pod URL; an optional AP-actor
// service is added when `config.actorPathTemplate` is set.
//
// --------------------------------------------------------------- the paths
//
// Two locations, two very different footings (see README "Findings"):
//   * `/.well-known/did.json` — the root/server DID. Works by the SAME chain
//     of luck nip05/ and webfinger/ document: the loader doesn't confine
//     routes to the prefix, an exact path outranks core's LDP `GET /*`
//     wildcard, and core's auth preHandler blanket-exempts `/.well-known/*`.
//     Guarded (try/catch) and mirrored at the contract-safe `<prefix>/did.json`.
//   * `/<user>/did.json` — the pathed per-pod DID. This is NOT a well-known
//     path: it lands INSIDE the pod's own `/<user>/` LDP namespace and is
//     therefore WAC-governed (server.js only skips auth for `/.well-known/*`,
//     `appPaths`, and the plugin's own prefix). did:web pathed resolution thus
//     works ONLY if the pod owner grants public Read at that path — the exact
//     namespace-interleaving wall activitypub/ hit with `/<user>/inbox`. Also
//     mirrored at the always-safe `<prefix>/<user>/did.json`.
//
// Nostr pubkey extraction is vendored (adapted from core's internal
// src/auth/nostr-keys.js, AGPL-3.0-only) — the same wall nip05/ and
// relay/nip01 document — and every key is checked on-curve with @noble/curves
// before it is published.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

// ---- multicodec varint prefixes (multibase/Multikey) ---------------------
const MULTICODEC_SECP256K1_PUB = Uint8Array.from([0xe7, 0x01]);
const MULTICODEC_ED25519_PUB = Uint8Array.from([0xed, 0x01]);
const MULTICODEC_SECP256K1_PUB_HEX = 'e701';

// ---- DID / crypto JSON-LD contexts ---------------------------------------
const DID_CONTEXT = 'https://www.w3.org/ns/did/v1';
const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1';

/** pod-dir / did:web path-segment grammar (also blocks path traversal). */
const LOCAL_PART = /^[a-zA-Z0-9._-]+$/;

/** Bitcoin base58 alphabet (base58btc, multibase prefix 'z'). */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode bytes as base58btc (no multibase prefix). */
export function base58btcEncode(bytes) {
  const input = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < input.length; i += 1) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k -= 1) out += B58_ALPHABET[digits[k]];
  return out;
}

/** `z` + base58btc(multicodec-prefix || key) — a Multikey publicKeyMultibase. */
export function toMultikey(prefix, keyBytes) {
  const framed = new Uint8Array(prefix.length + keyBytes.length);
  framed.set(prefix, 0);
  framed.set(keyBytes, prefix.length);
  return 'z' + base58btcEncode(framed);
}

/** Is `hex` (33-byte compressed point) a real secp256k1 point? */
function isOnCurve(hex) {
  try {
    secp256k1.ProjectivePoint.fromHex(hex);
    return true;
  } catch {
    return false;
  }
}

/** base64url → lowercase hex, or null. */
function b64urlToHex(s) {
  if (typeof s !== 'string' || !s) return null;
  try {
    return Buffer.from(s, 'base64url').toString('hex').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Decode an f-form Multikey (`f` base16 + multicodec `e701` + parity + x-only,
 * as core's provisioner emits) into the 33-byte COMPRESSED point hex, or null.
 * Unlike nip05 (which keeps x-only for NIP-05) we retain the parity byte so
 * the key round-trips into a base58btc secp256k1 Multikey losslessly.
 */
export function compressedFromFForm(mb) {
  if (typeof mb !== 'string' || !mb.startsWith('f')) return null;
  const hex = mb.slice(1).toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || !hex.startsWith(MULTICODEC_SECP256K1_PUB_HEX)) return null;
  const rest = hex.slice(MULTICODEC_SECP256K1_PUB_HEX.length);
  if (rest.length !== 66) return null; // parity byte + 32-byte x-only
  const parity = rest.slice(0, 2);
  if (parity !== '02' && parity !== '03') return null;
  return isOnCurve(rest) ? rest : null;
}

/**
 * secp256k1 JWK → 33-byte COMPRESSED point hex, or null. Uses y's parity when
 * present; falls back to even parity (02) from x alone (a valid curve x always
 * has an even-parity point), mirroring nip05's probe.
 */
export function compressedFromJwk(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1') return null;
  const x = b64urlToHex(jwk.x);
  if (!x || x.length !== 64) return null;
  const y = b64urlToHex(jwk.y);
  let parity = '02';
  if (y && y.length === 64) parity = (parseInt(y.slice(-1), 16) & 1) ? '03' : '02';
  const compressed = parity + x;
  return isOnCurve(compressed) ? compressed : null;
}

/**
 * First secp256k1 pubkey (compressed hex) declared by a profile document's
 * verificationMethod entries (top-level or inside @graph nodes), preferring
 * publicKeyMultibase and falling back to publicKeyJwk — the shape nip05/ reads.
 */
export function extractSecp256k1(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const nodes = [doc, ...(Array.isArray(doc['@graph']) ? doc['@graph'] : [])];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const raw = node.verificationMethod;
    const vms = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const vm of vms) {
      if (!vm || typeof vm !== 'object') continue;
      const fromMb = compressedFromFForm(vm.publicKeyMultibase);
      if (fromMb) return fromMb;
      const fromJwk = compressedFromJwk(vm.publicKeyJwk);
      if (fromJwk) return fromJwk;
    }
  }
  return null;
}

/** Read + parse `<dir>/profile/card.jsonld`, null on any failure. */
async function readCard(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'profile', 'card.jsonld'), 'utf8'));
  } catch {
    return null;
  }
}

/** Does `<dir>/profile/card.jsonld` exist? (a pod always has its WebID card) */
async function hasCard(dir) {
  try {
    await fs.access(path.join(dir, 'profile', 'card.jsonld'));
    return true;
  } catch {
    return false;
  }
}

export async function activate(api) {
  const prefix = api.prefix || '/didweb';
  const podsRoot = api.config.podsRoot ?? null;
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  // Optional: an AP-actor path template (as webfinger/ uses) → a service entry.
  const actorPathTemplate = api.config.actorPathTemplate || null;
  // Optional: arbitrary extra service entries appended verbatim.
  const extraServices = Array.isArray(api.config.serviceEndpoints)
    ? api.config.serviceEndpoints : [];

  if (!baseUrl) {
    // A DID document is nothing but absolute URLs and a did:web id derived
    // from this server's own host, and the plugin api exposes no server
    // origin (same finding as webfinger/, activitypub/, mastodon/). Without
    // it there is no truthful `id` to mint — hard boot failure.
    throw new Error(
      'didweb plugin requires config.baseUrl — the plugin api exposes no server '
      + 'origin, and the did:web id (did:web:<host>) plus every service URL is '
      + 'derived from it (same finding as webfinger/activitypub/mastodon).',
    );
  }
  if (!podsRoot) {
    // Still activate: the root/server DID (`did:web:<host>`) is servable from
    // a minted key alone, and a purely additive resolver shouldn't fail the
    // whole boot — but say so loudly (see README finding on podsRoot repetition).
    api.log.warn('didweb: no config.podsRoot — only the root DID (did:web:<host>) '
      + 'resolves; every pathed did:web:<host>:<user> will 404 '
      + '(the plugin api cannot learn the data root itself)');
  }

  // did:web host = the baseUrl authority with the port colon percent-encoded.
  const host = new URL(baseUrl).host;           // e.g. "pod.example" or "127.0.0.1:3000"
  const encHost = host.replace(/:/g, '%3A');    // did:web percent-encodes the port colon
  const didFor = (user) => (user ? `did:web:${encHost}:${user}` : `did:web:${encHost}`);

  // Minted Ed25519 keys persist here, one JSON per scope (root → `_root`).
  const keysDir = path.join(api.storage.pluginDir(), 'keys');
  fsSync.mkdirSync(keysDir, { recursive: true });

  /**
   * Load (or mint + persist) an Ed25519 keypair for a scope, returning the
   * base58btc Multikey publicKeyMultibase. The private key never leaves
   * pluginDir (which the host never serves over HTTP).
   */
  function ed25519Multibase(scopeKey) {
    const file = path.join(keysDir, `${scopeKey}.json`);
    try {
      return JSON.parse(fsSync.readFileSync(file, 'utf8')).publicKeyMultibase;
    } catch { /* mint below */ }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    // JWK `x` is the raw 32-byte public key (base64url) for OKP/Ed25519.
    const rawPub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const publicKeyMultibase = toMultikey(MULTICODEC_ED25519_PUB, rawPub);
    fsSync.writeFileSync(file, JSON.stringify({
      publicKeyMultibase,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }, null, 2));
    return publicKeyMultibase;
  }

  /** Confirm the pod named by `user` exists (null → single-user root pod). */
  async function podExists(user) {
    if (!podsRoot) return false;
    if (user === null) return hasCard(podsRoot);
    if (!LOCAL_PART.test(user) || user.startsWith('.')) return false; // traversal / dotdir
    return hasCard(path.join(podsRoot, user));
  }

  /**
   * Build the DID document for a scope. `user === null` → root/server DID
   * (served from the single-user pod card at podsRoot if present, else a
   * minted server key). Returns null when a pathed user has no pod.
   */
  async function buildDidDoc(user) {
    if (user !== null && !(await podExists(user))) return null;
    const did = didFor(user);
    const podPath = user ? `/${user}/` : '/';
    const webid = `${baseUrl}${podPath}profile/card#me`;
    const scopeKey = user ?? '_root';
    const podDir = podsRoot ? (user ? path.join(podsRoot, user) : podsRoot) : null;

    const vms = [];
    // 1) A provisioned Nostr/secp256k1 key from the pod's public card.
    const compressed = podDir ? extractSecp256k1(await readCard(podDir)) : null;
    if (compressed) {
      vms.push({
        id: `${did}#owner-key`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: toMultikey(MULTICODEC_SECP256K1_PUB, Buffer.from(compressed, 'hex')),
      });
    }
    // 2) No card key → mint + persist an Ed25519 key so the DID is usable.
    if (vms.length === 0) {
      vms.push({
        id: `${did}#server-key`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: ed25519Multibase(scopeKey),
      });
    }
    const vmIds = vms.map((vm) => vm.id);

    const service = [
      { id: `${did}#pod`, type: 'SolidPod', serviceEndpoint: `${baseUrl}${podPath}` },
      { id: `${did}#linked-domain`, type: 'LinkedDomains', serviceEndpoint: baseUrl },
    ];
    if (actorPathTemplate) {
      const actorPath = actorPathTemplate.replaceAll('<user>', user ?? '').replace(/\/{2,}/g, '/');
      service.push({ id: `${did}#activitypub`, type: 'ActivityPubActor', serviceEndpoint: `${baseUrl}${actorPath}` });
    }
    for (const extra of extraServices) {
      if (extra && typeof extra === 'object') service.push(extra);
    }

    return {
      '@context': [DID_CONTEXT, MULTIKEY_CONTEXT],
      id: did,
      alsoKnownAs: [webid], // binds the DID to the pod's WebID (same subject)
      verificationMethod: vms,
      authentication: vmIds,
      assertionMethod: vmIds,
      service,
    };
  }

  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, OPTIONS')
    .header('access-control-allow-headers', 'accept');

  const sendDoc = (reply, doc) => cors(reply)
    .header('content-type', 'application/did+json; charset=utf-8')
    .send(JSON.stringify(doc));

  const notFound = (reply, msg) => cors(reply)
    .code(404).header('content-type', 'application/json; charset=utf-8')
    .send({ error: msg });

  // Root/server DID: did:web:<host>.
  async function rootHandler(request, reply) {
    return sendDoc(reply, await buildDidDoc(null));
  }
  // Pathed per-pod DID: did:web:<host>:<user>.
  async function userHandler(request, reply) {
    const user = request.params.user;
    if (!LOCAL_PART.test(user) || user.startsWith('.')) return notFound(reply, 'no such DID');
    const doc = await buildDidDoc(user);
    if (!doc) return notFound(reply, `no such DID: did:web:${encHost}:${user}`);
    return sendDoc(reply, doc);
  }

  // Contract-safe mounts under the plugin prefix (WAC-exempt via appPaths push).
  api.fastify.options(`${prefix}/*`, (request, reply) => cors(reply).code(204).send());
  api.fastify.get(`${prefix}/did.json`, rootHandler);
  api.fastify.get(`${prefix}/:user/did.json`, userHandler);

  // Real did:web root location. Works today for the reasons nip05/webfinger
  // document (loader doesn't confine routes to the prefix; an exact path
  // outranks core's LDP wildcard; core blanket-exempts /.well-known/* from
  // auth) — nothing in the plugin CONTRACT promises it, so a conflict (core
  // someday claiming this GET) degrades to prefix-only, not a boot failure.
  let wellKnown = false;
  try {
    api.fastify.get('/.well-known/did.json', rootHandler);
    wellKnown = true;
  } catch (err) {
    api.log.warn(`didweb: could not claim /.well-known/did.json (${err.message}); `
      + `serving the root DID under ${prefix}/did.json only`);
  }

  // Real did:web PATHED location. Unlike the well-known root this lands inside
  // the pod's own /<user>/ LDP namespace and is WAC-governed (NOT exempt), so
  // it resolves anonymously only where the pod grants public Read — the
  // namespace-interleaving wall activitypub hit. Register it anyway (guarded);
  // the prefix mount is the always-safe fallback.
  let pathed = false;
  try {
    api.fastify.get('/:user/did.json', userHandler);
    pathed = true;
  } catch (err) {
    api.log.warn(`didweb: could not claim /:user/did.json (${err.message}); `
      + `serving pathed DIDs under ${prefix}/<user>/did.json only`);
  }

  api.log.info(`didweb: root DID did:web:${encHost} at `
    + `${wellKnown ? '/.well-known/did.json and ' : ''}${prefix}/did.json; `
    + `pathed DIDs at ${pathed ? '/<user>/did.json and ' : ''}${prefix}/<user>/did.json`
    + (podsRoot ? ` from ${podsRoot}` : ' (no podsRoot: pathed DIDs 404)'));
  if (pathed) {
    api.log.warn('didweb: /<user>/did.json is WAC-governed (inside the pod LDP '
      + 'namespace), so did:web pathed resolution needs the pod to grant public '
      + 'Read there — same reserved-path/namespace seam as activitypub (see README).');
  }
}
