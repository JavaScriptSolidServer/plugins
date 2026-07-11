// NIP-05 (https://github.com/nostr-protocol/nips/blob/master/05.md) as a
// #206 loader plugin — out-of-tree take on JSS issue #445.
//
//   plugins: [{ module: 'nip05/plugin.js', prefix: '/nip05',
//               config: { podsRoot: './data',
//                         relayUrl: 'wss://pod.example/relay' } }]
//
// Serves `GET /.well-known/nostr.json?name=<name>` →
//   { "names": { "<pod>": "<pubkey-hex>" }, "relays"?: { "<hex>": [relayUrl] } }
//
// built by scanning each pod's PUBLIC profile (`<pod>/profile/card.jsonld`)
// for the owner-key verificationMethod that `--provision-keys` lands there
// (#437/#443). Reads the public side only — never `private/privkey.jsonld`.
//
// The interesting part is the path. `/.well-known/nostr.json` is a fixed
// absolute path; a plugin is mounted under ONE prefix. It turns out the
// loader does NOT confine routes to the prefix — `api.fastify` is the real
// (scoped) instance, so an exact-path GET registers fine and beats core's
// LDP `GET /*` wildcard on route specificity. And it is served
// unauthenticated — but only because core's auth preHandler happens to
// blanket-exempt `/.well-known/*` as the spec-mandated public namespace,
// NOT because the plugin api granted anything: the loader's WAC exemption
// covers `prefix` alone. Both facts are load-bearing accidents of core's
// current routing (see README "Findings"); the same document is therefore
// also served at `<prefix>/nostr.json`, which rests only on documented
// plugin-api ground, and the absolute registration is a guarded attempt.
//
// Pubkey extraction is vendored (adapted from core's src/auth/nostr-keys.js,
// AGPL-3.0-only) because that module is internal — same wall relay/nip01.js
// documents. Keys are checked on-curve with @noble/curves before being
// advertised, so the endpoint never publishes a pubkey verifiers would
// reject.

import fs from 'node:fs/promises';
import path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';

/** Multicodec varint for secp256k1-pub: 0xe7 0x01 → 'e701' hex. */
const MULTICODEC_SECP256K1_PUB_HEX = 'e701';

/** NIP-05 §"local part" grammar: a-z0-9-_. (case-insensitive). */
const NIP05_NAME = /^[a-z0-9\-_.]+$/i;

/** Is `candidateHex` (33-byte compressed point hex) a real secp256k1 point? */
function isOnCurve(candidateHex) {
  try {
    secp256k1.ProjectivePoint.fromHex(candidateHex);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode an f-form Multikey for secp256k1-pub into 32-byte x-only pubkey
 * hex, or null. Recipe (CCG community#254 / did:nostr, as emitted by
 * core's provisioner): multibase `f` (base16-lower) + multicodec `e701`
 * + parity byte (`02`/`03`) + 32-byte x-only pubkey.
 */
export function decodeFFormSecp256k1(mb) {
  if (typeof mb !== 'string' || !mb.startsWith('f')) return null;
  const hex = mb.slice(1).toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || !hex.startsWith(MULTICODEC_SECP256K1_PUB_HEX)) return null;
  const rest = hex.slice(MULTICODEC_SECP256K1_PUB_HEX.length);
  if (rest.length !== 66) return null; // parity byte + 32-byte x-only
  const parity = rest.slice(0, 2);
  if (parity !== '02' && parity !== '03') return null;
  return isOnCurve(rest) ? rest.slice(2) : null;
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

/** secp256k1 JWK → 32-byte x-only pubkey hex (x must be a curve x), or null. */
export function pubkeyFromJwk(jwk) {
  if (!jwk || typeof jwk !== 'object') return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1') return null;
  const x = b64urlToHex(jwk.x);
  if (!x || x.length !== 64) return null;
  // Any valid curve x has points of both parities; probing one suffices.
  return isOnCurve('02' + x) ? x : null;
}

/**
 * First Nostr pubkey declared by a profile document's verificationMethod
 * entries (top-level or inside @graph nodes), preferring publicKeyMultibase
 * and falling back to publicKeyJwk — mirroring what core's verifier accepts.
 */
export function extractNostrPubkey(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const nodes = [doc, ...(Array.isArray(doc['@graph']) ? doc['@graph'] : [])];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    const raw = node.verificationMethod;
    const vms = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const vm of vms) {
      if (!vm || typeof vm !== 'object') continue;
      const fromMb = decodeFFormSecp256k1(vm.publicKeyMultibase);
      if (fromMb) return fromMb;
      const fromJwk = pubkeyFromJwk(vm.publicKeyJwk);
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

export async function activate(api) {
  const prefix = api.prefix || '/nip05';
  const podsRoot = api.config.podsRoot ?? null;
  const relayUrl = api.config.relayUrl ?? null;
  const rootName = api.config.rootName ?? '_'; // NIP-05 reserved "domain itself" name

  if (!podsRoot) {
    // Deliberate: still activate. `{ names: {} }` is a valid NIP-05
    // document, and an operator composing plugins from one config
    // shouldn't have a hard boot failure for a purely additive discovery
    // feature — but say so loudly, since it usually means the config
    // forgot to repeat the data root (see README finding 3).
    api.log.warn('nip05: no config.podsRoot — serving an empty names map '
      + '(the plugin api cannot learn the data root itself)');
  }

  /**
   * Scan pods fresh per request (pods can be created at runtime; the doc
   * is small). `<podsRoot>/<pod>/profile/card.jsonld` → names[<pod>];
   * `<podsRoot>/profile/card.jsonld` (single-user layout) → names[rootName].
   */
  async function buildNames() {
    const names = {};
    if (!podsRoot) return names;
    let entries = [];
    try {
      entries = await fs.readdir(podsRoot, { withFileTypes: true });
    } catch (err) {
      api.log.warn(`nip05: cannot read podsRoot ${podsRoot}: ${err.message}`);
      return names;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue; // .idp, .plugins, .well-known…
      if (!NIP05_NAME.test(entry.name)) continue; // not a legal NIP-05 local part
      const pubkey = extractNostrPubkey(await readCard(path.join(podsRoot, entry.name)));
      if (pubkey) names[entry.name] = pubkey;
    }
    // Single-user: the pod IS the root; map it to the reserved `_` name
    // (NIP-05: `_@domain` displays as bare `domain`), matching core's MVP.
    if (!(rootName in names)) {
      const rootKey = extractNostrPubkey(await readCard(podsRoot));
      if (rootKey) names[rootName] = rootKey;
    }
    return names;
  }

  async function handler(request, reply) {
    let names = await buildNames();
    const q = request.query?.name;
    if (typeof q === 'string' && q !== '') {
      // Per NIP-05 §querying: return just the requested name. An unknown
      // name yields an empty map — still a well-formed document that
      // verifiers correctly treat as "not found".
      names = q in names ? { [q]: names[q] } : {};
    }
    const doc = { names };
    if (relayUrl) {
      const relays = {};
      for (const hex of Object.values(names)) relays[hex] = [relayUrl];
      if (Object.keys(relays).length) doc.relays = relays;
    }
    // NIP-05 verifiers are browsers and bots with no credentials: CORS
    // must be wide open (the spec calls this out explicitly).
    return reply
      .header('access-control-allow-origin', '*')
      .header('content-type', 'application/json; charset=utf-8')
      .send(doc);
  }

  // Always-safe mount: under the plugin's own prefix (WAC-exempt via the
  // loader's appPaths push — the only exemption the plugin api grants).
  api.fastify.get(`${prefix}/nostr.json`, handler);

  // Attempt the real NIP-05 location. Works today (loader doesn't confine
  // routes to the prefix; core's GET there is only the LDP wildcard, which
  // an exact path outranks; core's auth preHandler blanket-exempts
  // /.well-known/*) — but nothing in the plugin CONTRACT promises any of
  // that, so treat failure (e.g. core someday claiming the GET route
  // itself) as degraded, not fatal: the prefix mount still serves.
  let wellKnown = false;
  try {
    api.fastify.get('/.well-known/nostr.json', handler);
    wellKnown = true;
  } catch (err) {
    api.log.warn(`nip05: could not claim /.well-known/nostr.json (${err.message}); `
      + `serving under ${prefix}/nostr.json only`);
  }

  api.log.info(`nip05: serving ${prefix}/nostr.json`
    + (wellKnown ? ' and /.well-known/nostr.json' : '')
    + (podsRoot ? ` from ${podsRoot}` : ' (empty: no podsRoot)'));
}
