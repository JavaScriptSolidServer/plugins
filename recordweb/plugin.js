// RecordWeb (RWP) — the RecordWeb Protocol (https://github.com/recordweb) as a
// #206 loader plugin. Turns a JSS server into an RWP node: institutional
// Records with global DIDs, content-addressed immutable snapshots forming a
// version DAG, cryptographic finalization, and Merkle-rooted Cases.
//
//   plugins: [{ module: 'recordweb/plugin.js', prefix: '/recordweb',
//               config: { namespace: 'bern.ch',      // optional; default = host
//                         baseUrl: 'https://pod.example' } }] // optional override
//
// RWP (recordweb.github.io/rwp) composes three W3C standards — DID Core (a
// `did:rwp:<namespace>:<uuid>` per Record), PROV-O (the version graph as a
// DAG of `parents` edges), and VC/crypto proof (an Ed25519 signature over the
// finalized snapshot hash). The RecordWeb Concept (recordweb.github.io/rwc)
// names two extensions this estate already has parts of: "deliver Records to
// Solid Pods (citizen-controlled copies)" — that's what a JSS node IS — and
// "anchor Merkle roots to an external timestamp proof" — which forge/ already
// does against Bitcoin. This plugin implements the Level-1 core plus Cases
// (RWP conformance Level 1 + Ch. 8) honestly on the public plugin surface.
//
// ----------------------------------------------------------------- the model
//
//   Record   did:rwp:<ns>:<uuid> — identity + a version DAG of snapshots.
//   Snapshot immutable, content-addressed. snapshotHash =
//              SHA-256( JCS(metadata \ {snapshotHash,signature}) || payloadBytes )
//            (RFC 8785 canonical JSON). state draft|finalized; draft is
//            mutable-by-replacement, finalized is signed + frozen + linkable.
//   Case     did:rwp:<ns>:<uuid> whose payload hard-links finalized snapshots
//            (by hash) and soft-links Records (by DID). merkleRoot is the
//            binary Merkle tree over the sorted hard-linked hashes — one
//            provable fingerprint over the whole Case.
//
// -------------------------------------------------------------- storage/auth
//
// State lives under api.storage.pluginDir() (server-private, never served over
// HTTP) — the right footing for immutability: a finalized snapshot's bytes are
// content-addressed by name, so they cannot change without changing their DID
// reference, and this plugin refuses to overwrite one. Writes (create record,
// append draft, finalize, create case) require an authenticated agent via
// api.auth.getAgent — that agent becomes the Record `owner`/controller, and
// only the owner may append/finalize. Resolution and verification are public,
// as a DID resolver must be. Owner signing keys are minted + persisted per
// agent in pluginDir (node:crypto Ed25519), the same mint-and-hold pattern
// didweb/ uses for pods with no provisioned key.
//
// ----------------------------------------------------------------- the paths
//
//   POST   <prefix>/records                      create a Record (root draft)
//   POST   <prefix>/records/:uuid/snapshots      append a draft child snapshot
//   POST   <prefix>/records/:uuid/snapshots/:hash/finalize   sign + freeze
//   GET    <prefix>/records/:uuid                Record metadata + version graph
//   GET    <prefix>/records/:uuid/snapshots/:hash            one snapshot
//   GET    <prefix>/records/:uuid/payload/:hash             raw payload bytes
//   POST   <prefix>/cases                        create a Case (Merkle-rooted)
//   GET    <prefix>/cases/:uuid                  Case doc + merkleRoot
//   GET    <prefix>/resolve/:uuid                the Record's DID document
//   GET    <prefix>/1.0/identifiers/*            DIF-universal-resolver shim
//   GET    <prefix>/verify/records/:uuid/:hash   recompute hash + check sig
//   GET    <prefix>/verify/cases/:uuid           recompute + check Merkle root
//   GET    /.well-known/rwp-resolver.json        HTTP mirror of the DNS-TXT
//                                                resolver-discovery record
//
// Findings (walls hit against the public surface) are in README.md.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// --------------------------------------------------------------- RFC 8785 JCS
//
// Canonical JSON for hashing: keys sorted by UTF-16 code unit, no insignificant
// whitespace, NFC-normalized strings, ECMAScript-shortest numbers. Our metadata
// value space is objects / arrays / strings / integers / booleans / null — no
// non-integer floats — so JSON.stringify's number form is already canonical for
// what we hash. (A payload carrying arbitrary floats is stored as opaque bytes,
// not canonicalized, so the fractional-number edge of full JCS never bites.)

/** RFC 8785 canonical serialization of a JSON value (our value space). */
export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: non-finite number');
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys
      .map((k) => JSON.stringify(k.normalize('NFC')) + ':' + canonicalize(value[k]))
      .join(',') + '}';
  }
  throw new Error(`JCS: unserializable ${t}`);
}

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** snapshotHash = SHA-256( JCS(meta \ {snapshotHash,signature}) || payload ). */
export function computeSnapshotHash(metadata, payloadBytes) {
  const { snapshotHash, signature, ...core } = metadata; // excluded from the hash
  const canon = Buffer.from(canonicalize(core), 'utf8');
  return 'sha256:' + sha256hex(Buffer.concat([canon, payloadBytes]));
}

// ------------------------------------------------------------- Case Merkle root
//
// RWP's algorithm: collect hard-linked snapshot hashes, sort by hex string,
// fold pairwise with SHA-256 over the concatenated hex (odd node promoted).
// We fold over the bare hex (the `sha256:` prefix stripped) so the input is
// exactly the 64-hex-char digests the spec's pseudocode sorts.

/** Merkle root (as `sha256:<hex>`) over a set of `sha256:`-prefixed hashes. */
export function merkleRoot(hashes) {
  const bare = hashes.map((h) => String(h).replace(/^sha256:/, ''));
  if (bare.length === 0) return 'sha256:' + sha256hex(Buffer.alloc(0));
  let level = [...bare].sort();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256hex(Buffer.from(level[i] + level[i + 1], 'utf8')));
      else next.push(level[i]); // promote the odd one
    }
    level = next;
  }
  return 'sha256:' + level[0];
}

// ------------------------------------------------------------- multibase (Ed25519)
// z + base58btc( 0xed01 || 32-byte pubkey ) — the same Multikey encoding didweb/
// emits, vendored minimally here so recordweb/ needs no shared import.
const MULTICODEC_ED25519_PUB = Uint8Array.from([0xed, 0x01]);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(bytes) {
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
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k -= 1) out += B58[digits[k]];
  return out;
}
function ed25519Multikey(rawPub) {
  const framed = new Uint8Array(MULTICODEC_ED25519_PUB.length + rawPub.length);
  framed.set(MULTICODEC_ED25519_PUB, 0);
  framed.set(rawPub, MULTICODEC_ED25519_PUB.length);
  return 'z' + base58btc(framed);
}

// -------------------------------------------------------------------- grammars
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const now = () => new Date().toISOString();

export async function activate(api) {
  const prefix = api.prefix || '/recordweb';
  const store = api.storage.pluginDir();
  const recordsDir = path.join(store, 'records');
  const casesDir = path.join(store, 'cases');
  const keysDir = path.join(store, 'keys');
  for (const d of [recordsDir, casesDir, keysDir]) fs.mkdirSync(d, { recursive: true });

  // Origin resolved at REQUEST time (api.serverInfo, #601); config.baseUrl is an
  // optional reverse-proxy override. The namespace defaults to the host, but RWP
  // namespaces are DNS-domain-based, so config.namespace lets an operator pin the
  // real one (`bern.ch`) independent of the bind address.
  const resolveBaseUrl = () => (api.config.baseUrl
    ? String(api.config.baseUrl).replace(/\/$/, '')
    : api.serverInfo().baseUrl.replace(/\/$/, ''));
  const resolveNamespace = () => (api.config.namespace
    ? String(api.config.namespace)
    : new URL(resolveBaseUrl()).host);
  const didFor = (uuid) => `did:rwp:${resolveNamespace()}:${uuid}`;

  // ---- owner signing keys (mint + persist per agent) -----------------------
  const keyFile = (agent) => path.join(keysDir, sha256hex(Buffer.from(agent, 'utf8')) + '.json');
  function ownerKey(agent) {
    const file = keyFile(agent);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* mint */ }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const rec = {
      agent,
      publicKeyMultibase: ed25519Multikey(rawPub),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    return rec;
  }

  // ---- record store (one directory per Record) -----------------------------
  const recDir = (uuid) => path.join(recordsDir, uuid);
  const metaPath = (uuid, hash) => path.join(recDir(uuid), 'snapshots', hash.replace(':', '_') + '.json');
  const payPath = (uuid, hash) => path.join(recDir(uuid), 'payloads', hash.replace(':', '_') + '.bin');
  const indexPath = (uuid) => path.join(recDir(uuid), 'record.json');

  async function readIndex(uuid) {
    try { return JSON.parse(await fsp.readFile(indexPath(uuid), 'utf8')); } catch { return null; }
  }
  async function readSnapshot(uuid, hash) {
    try { return JSON.parse(await fsp.readFile(metaPath(uuid, hash), 'utf8')); } catch { return null; }
  }
  async function readPayload(uuid, hash) {
    try { return await fsp.readFile(payPath(uuid, hash)); } catch { return null; }
  }

  /** Normalize a request payload into {bytes, format}. */
  function normalizePayload(body) {
    if (typeof body.payloadBase64 === 'string') {
      return { bytes: Buffer.from(body.payloadBase64, 'base64'),
        format: body.payloadFormat || 'application/octet-stream' };
    }
    const p = body.payload;
    if (typeof p === 'string') return { bytes: Buffer.from(p, 'utf8'), format: body.payloadFormat || 'text/plain' };
    if (p && typeof p === 'object') {
      return { bytes: Buffer.from(canonicalize(p), 'utf8'), format: body.payloadFormat || 'application/json' };
    }
    return null;
  }

  /** Walk ancestors of a snapshot hash within a Record (for the cycle guard). */
  async function ancestors(uuid, hash, seen = new Set()) {
    if (seen.has(hash)) return seen;
    seen.add(hash);
    const snap = await readSnapshot(uuid, hash);
    for (const p of snap?.parents || []) await ancestors(uuid, p, seen);
    return seen;
  }

  /** Persist a snapshot (metadata + payload bytes); returns the stored meta. */
  async function writeSnapshot(uuid, metaCore, payloadBytes) {
    const snapshotHash = computeSnapshotHash(metaCore, payloadBytes);
    const meta = { ...metaCore, snapshotHash };
    await fsp.mkdir(path.dirname(metaPath(uuid, snapshotHash)), { recursive: true });
    await fsp.mkdir(path.dirname(payPath(uuid, snapshotHash)), { recursive: true });
    // Content-addressed: an existing file already holds identical bytes.
    await fsp.writeFile(payPath(uuid, snapshotHash), payloadBytes);
    await fsp.writeFile(metaPath(uuid, snapshotHash), JSON.stringify(meta, null, 2));
    return meta;
  }

  // ---- helpers -------------------------------------------------------------
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('access-control-allow-headers', 'authorization, content-type, accept');
  const json = (reply, code, obj) => cors(reply).code(code)
    .header('content-type', 'application/json; charset=utf-8').send(JSON.stringify(obj, null, 2));
  const didDocOf = (reply, doc) => cors(reply).code(200)
    .header('content-type', 'application/did+json; charset=utf-8').send(JSON.stringify(doc, null, 2));

  async function requireAgent(request, reply) {
    const agent = await api.auth.getAgent(request);
    if (!agent) { json(reply, 401, { error: 'authentication required' }); return null; }
    return agent;
  }

  /** The Record's DID document (currentVersion pointer + owner key). */
  function buildDidDoc(index) {
    const did = didFor(index.uuid);
    const base = resolveBaseUrl();
    const key = ownerKey(index.owner); // stable per owner
    const vmId = `${did}#owner-key`;
    return {
      '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
      id: did,
      controller: index.owner,
      recordEndpoint: `${base}${prefix}/records/${index.uuid}`,
      currentVersion: index.currentVersion,
      state: index.state,
      created: index.created,
      updated: index.updated,
      verificationMethod: [{
        id: vmId, type: 'Multikey', controller: did, publicKeyMultibase: key.publicKeyMultibase,
      }],
      authentication: [vmId],
      assertionMethod: [vmId],
    };
  }

  // ===================================================================== routes

  api.fastify.options(`${prefix}/*`, (request, reply) => cors(reply).code(204).send());

  // ---- create a Record (root draft snapshot) -------------------------------
  api.fastify.post(`${prefix}/records`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const body = request.body || {};
    const pay = normalizePayload(body);
    if (!pay) return json(reply, 400, { error: 'payload or payloadBase64 required' });
    const uuid = crypto.randomUUID();
    const did = didFor(uuid);
    const created = now();
    const metaCore = {
      did,
      recordType: body.recordType || null,
      state: 'draft',
      created,
      owner: agent,
      parents: [],
      payloadHash: 'sha256:' + sha256hex(pay.bytes),
      payloadFormat: pay.format,
    };
    const meta = await writeSnapshot(uuid, metaCore, pay.bytes);
    const index = {
      uuid, did, owner: agent, state: 'draft',
      currentVersion: meta.snapshotHash, head: meta.snapshotHash,
      snapshots: [meta.snapshotHash], created, updated: created,
    };
    await fsp.writeFile(indexPath(uuid), JSON.stringify(index, null, 2));
    api.log.info(`recordweb: created ${did} (root ${meta.snapshotHash})`);
    return json(reply, 201, { did, snapshot: meta, didDocument: buildDidDoc(index) });
  });

  // ---- append a draft child snapshot ---------------------------------------
  api.fastify.post(`${prefix}/records/:uuid/snapshots`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const { uuid } = request.params;
    if (!UUID_RE.test(uuid)) return json(reply, 400, { error: 'bad uuid' });
    const index = await readIndex(uuid);
    if (!index) return json(reply, 404, { error: 'no such record' });
    if (index.owner !== agent) return json(reply, 403, { error: 'not the record owner' });
    const body = request.body || {};
    const pay = normalizePayload(body);
    if (!pay) return json(reply, 400, { error: 'payload or payloadBase64 required' });
    // Parents default to the current head; explicit parents enable merges.
    const parents = Array.isArray(body.parents) && body.parents.length ? body.parents : [index.head];
    for (const p of parents) {
      if (!HASH_RE.test(p)) return json(reply, 400, { error: `bad parent hash ${p}` });
      if (!(await readSnapshot(uuid, p))) return json(reply, 400, { error: `unknown parent ${p}` });
    }
    const metaCore = {
      did: index.did,
      recordType: body.recordType ?? null,
      state: 'draft',
      created: now(),
      owner: agent,
      parents,
      payloadHash: 'sha256:' + sha256hex(pay.bytes),
      payloadFormat: pay.format,
    };
    const candidate = computeSnapshotHash(metaCore, pay.bytes);
    // Cycle guard (RWP MUST): reject if the new hash is already an ancestor of
    // any parent — i.e. adding these edges would close a loop in the DAG.
    for (const p of parents) {
      const anc = await ancestors(uuid, p);
      if (anc.has(candidate)) return json(reply, 409, { error: 'snapshot would create a cycle' });
    }
    const meta = await writeSnapshot(uuid, metaCore, pay.bytes);
    if (!index.snapshots.includes(meta.snapshotHash)) index.snapshots.push(meta.snapshotHash);
    index.head = meta.snapshotHash;      // newest draft head for the default lineage
    index.updated = meta.created;
    await fsp.writeFile(indexPath(uuid), JSON.stringify(index, null, 2));
    return json(reply, 201, { snapshot: meta });
  });

  // ---- finalize a draft snapshot (sign + freeze) ---------------------------
  api.fastify.post(`${prefix}/records/:uuid/snapshots/:hash/finalize`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const { uuid } = request.params;
    const hash = request.params.hash.replace('_', ':');
    if (!UUID_RE.test(uuid) || !HASH_RE.test(hash)) return json(reply, 400, { error: 'bad uuid or hash' });
    const index = await readIndex(uuid);
    if (!index) return json(reply, 404, { error: 'no such record' });
    if (index.owner !== agent) return json(reply, 403, { error: 'not the record owner' });
    const snap = await readSnapshot(uuid, hash);
    if (!snap) return json(reply, 404, { error: 'no such snapshot' });
    if (snap.state === 'finalized') return json(reply, 409, { error: 'already finalized (immutable)' });
    // Finalization checks: every parent must resolve (spec check 5).
    for (const p of snap.parents || []) {
      if (!(await readSnapshot(uuid, p))) return json(reply, 422, { error: `parent unresolvable: ${p}` });
    }
    const payloadBytes = await readPayload(uuid, hash);
    if (!payloadBytes) return json(reply, 500, { error: 'payload missing' });
    // Re-derive the frozen metadata, sign the resulting snapshotHash.
    const { snapshotHash: _old, signature: _sig, ...core } = snap;
    const frozenCore = { ...core, state: 'finalized', finalized: now() };
    const frozenHash = computeSnapshotHash(frozenCore, payloadBytes);
    const key = ownerKey(agent);
    const signature = 'z' + base58btc(
      crypto.sign(null, Buffer.from(frozenHash, 'utf8'), crypto.createPrivateKey(key.privateKeyPem)));
    const meta = { ...frozenCore, snapshotHash: frozenHash, signature };
    // The finalized snapshot is a NEW content-addressed node (state changed the
    // hash); write it and repoint the record. The draft node stays in history.
    await fsp.writeFile(metaPath(uuid, frozenHash), JSON.stringify(meta, null, 2));
    await fsp.writeFile(payPath(uuid, frozenHash), payloadBytes);
    if (!index.snapshots.includes(frozenHash)) index.snapshots.push(frozenHash);
    index.currentVersion = frozenHash;
    index.head = frozenHash;
    index.state = 'finalized';
    index.updated = frozenCore.finalized;
    await fsp.writeFile(indexPath(uuid), JSON.stringify(index, null, 2));
    api.log.info(`recordweb: finalized ${index.did} → ${frozenHash}`);
    return json(reply, 200, { snapshot: meta, didDocument: buildDidDoc(index) });
  });

  // ---- read a Record (metadata + version graph) ----------------------------
  api.fastify.get(`${prefix}/records/:uuid`, async (request, reply) => {
    const { uuid } = request.params;
    if (!UUID_RE.test(uuid)) return json(reply, 400, { error: 'bad uuid' });
    const index = await readIndex(uuid);
    if (!index) return json(reply, 404, { error: 'no such record' });
    const nodes = [];
    const edges = [];
    for (const h of index.snapshots) {
      const s = await readSnapshot(uuid, h);
      if (!s) continue;
      nodes.push({ snapshotHash: s.snapshotHash, state: s.state, created: s.created,
        finalized: s.finalized || null, payloadFormat: s.payloadFormat });
      for (const p of s.parents || []) edges.push({ from: s.snapshotHash, to: p });
    }
    return json(reply, 200, {
      did: index.did, owner: index.owner, state: index.state,
      currentVersion: index.currentVersion, created: index.created, updated: index.updated,
      versionGraph: { nodes, edges }, didDocument: buildDidDoc(index),
    });
  });

  // ---- read one snapshot ---------------------------------------------------
  api.fastify.get(`${prefix}/records/:uuid/snapshots/:hash`, async (request, reply) => {
    const { uuid } = request.params;
    const hash = request.params.hash.replace('_', ':');
    if (!UUID_RE.test(uuid) || !HASH_RE.test(hash)) return json(reply, 400, { error: 'bad uuid or hash' });
    const snap = await readSnapshot(uuid, hash);
    if (!snap) return json(reply, 404, { error: 'no such snapshot' });
    // The body is the stored metadata VERBATIM so a client re-hashes it exactly
    // (JCS(meta \ {snapshotHash,signature}) || payload); the payload location
    // rides a Link header rather than a body field that would perturb the hash.
    const base = resolveBaseUrl();
    return cors(reply).code(200)
      .header('content-type', 'application/json; charset=utf-8')
      .header('link', `<${base}${prefix}/records/${uuid}/payload/${hash.replace(':', '_')}>; rel="payload"`)
      .send(JSON.stringify(snap, null, 2));
  });

  // ---- raw payload bytes ---------------------------------------------------
  api.fastify.get(`${prefix}/records/:uuid/payload/:hash`, async (request, reply) => {
    const { uuid } = request.params;
    const hash = request.params.hash.replace('_', ':');
    if (!UUID_RE.test(uuid) || !HASH_RE.test(hash)) return json(reply, 400, { error: 'bad uuid or hash' });
    const snap = await readSnapshot(uuid, hash);
    const bytes = await readPayload(uuid, hash);
    if (!snap || !bytes) return json(reply, 404, { error: 'no such payload' });
    return cors(reply).code(200).header('content-type', snap.payloadFormat || 'application/octet-stream').send(bytes);
  });

  // ---- create a Case (Merkle root over hard links) -------------------------
  api.fastify.post(`${prefix}/cases`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const body = request.body || {};
    if (!body.title) return json(reply, 400, { error: 'title required' });
    // Hard links carry {recordDid, snapshotHash}; soft links carry {recordDid}.
    // Collect every hard-linked snapshotHash across trigger/context/process/
    // decision/result for the Merkle root; a soft link blocks finalization.
    const sections = ['trigger', 'context', 'process', 'decision', 'result'];
    const hardHashes = [];
    let hasSoft = false;
    for (const sec of sections) {
      const raw = body[sec];
      const links = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      for (const l of links) {
        if (!l || typeof l !== 'object') continue;
        if (typeof l.snapshotHash === 'string' && HASH_RE.test(l.snapshotHash)) hardHashes.push(l.snapshotHash);
        else hasSoft = true;
      }
    }
    const uuid = crypto.randomUUID();
    const did = didFor(uuid);
    const created = now();
    const root = merkleRoot(hardHashes);
    const caseDoc = {
      caseId: did, caseType: body.caseType || null, title: body.title, owner: agent,
      trigger: body.trigger ?? null, context: body.context ?? [], process: body.process ?? [],
      decision: body.decision ?? null, result: body.result ?? [],
      hardLinkCount: hardHashes.length, finalizable: !hasSoft,
      merkleRoot: root, created,
    };
    await fsp.mkdir(path.join(casesDir, uuid), { recursive: true });
    await fsp.writeFile(path.join(casesDir, uuid, 'case.json'), JSON.stringify(caseDoc, null, 2));
    api.log.info(`recordweb: created case ${did} (merkleRoot ${root}, ${hardHashes.length} hard links)`);
    return json(reply, 201, caseDoc);
  });

  // ---- read a Case ---------------------------------------------------------
  api.fastify.get(`${prefix}/cases/:uuid`, async (request, reply) => {
    const { uuid } = request.params;
    if (!UUID_RE.test(uuid)) return json(reply, 400, { error: 'bad uuid' });
    try {
      const doc = JSON.parse(await fsp.readFile(path.join(casesDir, uuid, 'case.json'), 'utf8'));
      return json(reply, 200, doc);
    } catch { return json(reply, 404, { error: 'no such case' }); }
  });

  // ---- resolve a Record DID (native + DIF-universal shim) ------------------
  async function resolveUuid(reply, uuid) {
    if (!UUID_RE.test(uuid)) return json(reply, 400, { error: 'bad uuid' });
    const index = await readIndex(uuid);
    // 410 if a tombstone marks the Record deleted; 404 if never known.
    if (!index) {
      try {
        await fsp.access(path.join(recDir(uuid), 'deleted'));
        return json(reply, 410, { error: 'record deleted' });
      } catch { return json(reply, 404, { error: 'no such DID' }); }
    }
    return didDocOf(reply, buildDidDoc(index));
  }
  api.fastify.get(`${prefix}/resolve/:uuid`, (request, reply) => resolveUuid(reply, request.params.uuid));
  // DIF universal-resolver shape: GET /1.0/identifiers/did:rwp:<ns>:<uuid>.
  // Wildcard (not :did) to dodge fastify's 100-char maxParamLength on the DID.
  api.fastify.get(`${prefix}/1.0/identifiers/*`, (request, reply) => {
    const did = decodeURIComponent(request.params['*'] || '');
    const ns = resolveNamespace();
    const want = `did:rwp:${ns}:`;
    if (!did.startsWith('did:rwp:')) return json(reply, 400, { error: 'not a did:rwp DID' });
    if (!did.startsWith(want)) return json(reply, 404, { error: `foreign namespace (this node is ${ns})` });
    return resolveUuid(reply, did.slice(want.length));
  });

  // ---- verify a snapshot (recompute hash + check signature) ----------------
  api.fastify.get(`${prefix}/verify/records/:uuid/:hash`, async (request, reply) => {
    const { uuid } = request.params;
    const hash = request.params.hash.replace('_', ':');
    if (!UUID_RE.test(uuid) || !HASH_RE.test(hash)) return json(reply, 400, { error: 'bad uuid or hash' });
    const snap = await readSnapshot(uuid, hash);
    const bytes = await readPayload(uuid, hash);
    if (!snap || !bytes) return json(reply, 404, { error: 'no such snapshot' });
    const payloadValid = ('sha256:' + sha256hex(bytes)) === snap.payloadHash;
    const recomputed = computeSnapshotHash(snap, bytes);
    const hashValid = recomputed === snap.snapshotHash;
    let signatureValid = null; // null → not applicable (draft, unsigned)
    if (snap.state === 'finalized' && snap.signature) {
      try {
        const key = ownerKey(snap.owner);
        const sig = Buffer.from(base58Decode(snap.signature.replace(/^z/, '')));
        signatureValid = crypto.verify(null, Buffer.from(snap.snapshotHash, 'utf8'),
          crypto.createPublicKey(key.publicKeyPem), sig);
      } catch { signatureValid = false; }
    }
    return json(reply, 200, {
      snapshotHash: snap.snapshotHash, state: snap.state,
      payloadValid, hashValid, signatureValid, recomputed,
    });
  });

  // ---- verify a Case (recompute the Merkle root + resolve hard links) ------
  api.fastify.get(`${prefix}/verify/cases/:uuid`, async (request, reply) => {
    const { uuid } = request.params;
    if (!UUID_RE.test(uuid)) return json(reply, 400, { error: 'bad uuid' });
    let doc;
    try { doc = JSON.parse(await fsp.readFile(path.join(casesDir, uuid, 'case.json'), 'utf8')); }
    catch { return json(reply, 404, { error: 'no such case' }); }
    const sections = ['trigger', 'context', 'process', 'decision', 'result'];
    const hardHashes = [];
    for (const sec of sections) {
      const raw = doc[sec];
      const links = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
      for (const l of links) if (l && typeof l === 'object' && HASH_RE.test(l.snapshotHash || '')) hardHashes.push(l.snapshotHash);
    }
    const recomputed = merkleRoot(hardHashes);
    return json(reply, 200, {
      caseId: doc.caseId, merkleRoot: doc.merkleRoot, recomputed,
      merkleRootValid: recomputed === doc.merkleRoot, hardLinkCount: hardHashes.length,
    });
  });

  // ---- /.well-known/rwp-resolver.json — HTTP mirror of the DNS-TXT record --
  // RWP federation discovers a namespace's resolver via a DNS TXT record
  // (_rwp-resolver.<ns> → "v=rwp1;endpoint=..."). We also publish it over HTTP
  // so a client that has the origin but not DNS control can still discover the
  // endpoint. Reserved (read-only) via api.reservePath — the same deliberate,
  // collision-guarded claim didweb/ makes on /.well-known/did.json.
  const resolverDoc = (reply) => cors(reply).code(200)
    .header('content-type', 'application/json; charset=utf-8')
    .send(JSON.stringify({
      v: 'rwp1', namespace: resolveNamespace(),
      endpoint: `${resolveBaseUrl()}${prefix}`,
      resolve: `${resolveBaseUrl()}${prefix}/1.0/identifiers/{did}`,
    }, null, 2));
  api.fastify.get(`${prefix}/.well-known/rwp-resolver.json`, (request, reply) => resolverDoc(reply));
  api.reservePath('/.well-known/rwp-resolver.json');
  let wellKnown = false;
  try {
    api.fastify.get('/.well-known/rwp-resolver.json', (request, reply) => resolverDoc(reply));
    wellKnown = true;
  } catch (err) {
    api.log.warn(`recordweb: could not claim /.well-known/rwp-resolver.json (${err.message})`);
  }

  // ---- landing page --------------------------------------------------------
  api.fastify.get(prefix, (request, reply) => cors(reply).code(200)
    .header('content-type', 'text/html; charset=utf-8')
    .send(landingPage(prefix)));

  api.log.info(`recordweb: RWP node up at ${prefix} `
    + `(records/snapshots/cases + resolver${wellKnown ? ' + /.well-known/rwp-resolver.json' : ''})`);

  return { deactivate() { /* no timers/sockets to close */ } };
}

// base58btc decode (for verifying a `z`-multibase signature).
function base58Decode(str) {
  const map = {};
  for (let i = 0; i < B58.length; i += 1) map[B58[i]] = i;
  const bytes = [0];
  for (const ch of str) {
    const val = map[ch];
    if (val === undefined) throw new Error('bad base58');
    let carry = val;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros += 1;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

function landingPage(prefix) {
  return `<!doctype html><meta charset="utf-8"><title>RecordWeb node</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
code{background:#f2f2f2;padding:.1em .35em;border-radius:3px}h1{font-size:1.4rem}
table{border-collapse:collapse;width:100%;margin:1rem 0}td{border-top:1px solid #eee;padding:.4rem .3rem;vertical-align:top}
td:first-child{white-space:nowrap;color:#555;font-family:ui-monospace,monospace;font-size:.85em}</style>
<h1>RecordWeb node <small style="color:#888">(RWP)</small></h1>
<p>Institutional <b>Records</b> with <code>did:rwp</code> identity, content-addressed
immutable snapshots in a version DAG, cryptographic finalization, and Merkle-rooted <b>Cases</b>.
An <a href="https://github.com/recordweb">RWP</a> node served from a Solid pod.</p>
<table>
<tr><td>POST</td><td><code>${prefix}/records</code> — create a Record (root draft)</td></tr>
<tr><td>POST</td><td><code>${prefix}/records/:uuid/snapshots</code> — append a draft</td></tr>
<tr><td>POST</td><td><code>${prefix}/records/:uuid/snapshots/:hash/finalize</code> — sign + freeze</td></tr>
<tr><td>GET</td><td><code>${prefix}/records/:uuid</code> — metadata + version graph</td></tr>
<tr><td>POST</td><td><code>${prefix}/cases</code> — create a Merkle-rooted Case</td></tr>
<tr><td>GET</td><td><code>${prefix}/resolve/:uuid</code> — the Record's DID document</td></tr>
<tr><td>GET</td><td><code>${prefix}/verify/records/:uuid/:hash</code> — recompute hash + check signature</td></tr>
<tr><td>GET</td><td><code>${prefix}/verify/cases/:uuid</code> — recompute the Merkle root</td></tr>
</table>
<p style="color:#888;font-size:.9em">Writes require an authenticated pod agent; resolution and verification are public.</p>`;
}
