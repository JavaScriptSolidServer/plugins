// otp — one-time-password challenge/verify/session (#505) as a #206 loader plugin.
//
//   plugins: [{ module: 'otp/plugin.js', prefix: '/otp',
//               config: { channel: async (identifier, code, purpose) => {…},
//                         codeLength: 6, ttl: 300, sessionTtl: 900,
//                         maxAttempts: 5, rateLimitPerIdentifier: 5,
//                         rateLimitPerIp: 20, rateWindow: 60,
//                         exposeTestbox: false } }]
//
// A channel-delivered, single-use, short-lived code proves control of an
// out-of-band channel (email / SMS / Nostr DM …). Verifying it mints a
// short-lived, plugin-scoped SESSION token. Three routes:
//
//   POST {prefix}/request  NO auth — { identifier, purpose } → generate a
//                          6–8 digit code, store hash(code)+purpose+expiry+
//                          attempts in pluginDir, dispatch via the channel
//                          adapter. Rate-limited per identifier AND per IP.
//   POST {prefix}/verify   NO auth — { identifier, code, purpose } →
//                          constant-time compare; on success consume the
//                          code (single-use) and mint a session token; on
//                          failure decrement attempts, lock after N.
//   GET  {prefix}/whoami   Authorization: Bearer <otp session token> →
//                          validate and echo { identifier, purpose, exp }.
//
// Session token format (HMAC, like capability/'s macaroon-lite):
//
//   otp1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(secret, "otp1."+payload))>
//   payload = { v:1, sub:identifier, purpose, iat, exp, jti }
//
// purpose ∈ session | claim | recovery:
//   session  — low-friction first-touch auth for someone with no WebID.
//   claim    — one-shot right to drop something (pairs with capability/).
//   recovery — proves CHANNEL control only. Rebinding pod keys / minting a
//              real pod credential is a CORE seam this plugin cannot reach
//              (see README "Findings"; cross-ref capability/'s WAC boundary).
//
// The channel adapter is the integration point: config.channel(identifier,
// code, purpose) => Promise does real delivery (email/SMS/DM). With none
// configured a "console" test channel records the code in an in-memory
// outbox, surfaced at GET {prefix}/_testbox ONLY when config.exposeTestbox
// is true — so a test can read the code. Never enable that in production.
//
// State in api.storage.pluginDir(): `secret` (32 random bytes, the HMAC
// key, mode 0600) and `otp.json` (the OTP table, pruned of expired rows at
// boot). This plugin never imports server internals (repo RULE): the
// session it establishes is PLUGIN-SCOPED, not a pod credential.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PURPOSES = new Set(['session', 'claim', 'recovery']);
const MAX_TOKEN_LENGTH = 4096;
const NUL = '\u0000';

// ---------------------------------------------------------------- crypto
// Exported as pure functions so tests (and operators) can craft/check
// tokens and code hashes against a known secret without booting a server.

/** @returns {string} `otp1.<b64url payload>.<b64url hmac-sha256 sig>` */
export function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`otp1.${body}`).digest('base64url');
  return `otp1.${body}.${sig}`;
}

/** @returns {{ payload?: object, error?: string }} signature + shape only — expiry is the caller's check */
export function verifySession(token, secret) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return { error: 'malformed token' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'otp1') return { error: 'malformed token' };
  const [, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`otp1.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { error: 'bad signature' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { error: 'malformed token' };
  }
  if (!payload || payload.v !== 1 || typeof payload.sub !== 'string'
    || typeof payload.purpose !== 'string' || typeof payload.exp !== 'number') {
    return { error: 'malformed token' };
  }
  return { payload };
}

/**
 * Code hash: HMAC-SHA256(secret, identifier \n purpose \n code) as base64url.
 * Bound to identifier+purpose so a code is only valid for the row it was
 * issued for, and keyed by the server secret so the table never holds a
 * plaintext or a plainly-hashed code. Constant width (43 chars) → the
 * verify-time timingSafeEqual always compares equal-length buffers.
 */
export function hashCode(code, identifier, purpose, secret) {
  return crypto.createHmac('sha256', secret)
    .update(`${identifier}\n${purpose}\n${code}`).digest('base64url');
}

// ------------------------------------------------------------ rate limit
// In-memory token bucket: `capacity` tokens, refilled at capacity/windowSec
// per second. One request costs one token; empty bucket → refused. State is
// process-local (resets on restart), which is the right scope for a
// throttle — no persistence, no cross-node coordination promised.
function takeToken(map, key, capacity, refillPerSec) {
  const now = Date.now();
  let b = map.get(key);
  if (!b) { b = { tokens: capacity, last: now }; map.set(key, b); }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function generateCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += crypto.randomInt(0, 10);
  return s;
}

// ------------------------------------------------------- durable write
// Atomic persist: write to a uniquely-named temp file in the SAME directory
// (rename is only atomic within one filesystem), then rename it over the
// target. A crash mid-write truncates the throwaway temp, never the live
// table — so a truncated table can no longer silently reset to {} at boot
// and re-open a consumed OTP row. The random suffix avoids concurrent-writer
// temp collisions; a failed rename unlinks the temp so no partial file and
// no stale `.tmp` are left behind. (This does NOT address the read-modify-
// write TOCTOU between concurrent persisters — a separate, larger concern.)
function atomicWrite(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export async function activate(api) {
  const prefix = api.prefix || '/otp';
  const cfg = api.config || {};
  const codeLength = Math.min(8, Math.max(6, cfg.codeLength ?? 6));
  const defaultTtl = cfg.ttl ?? 300;              // code lifetime, seconds
  const maxTtl = cfg.maxTtl ?? 3600;              // ceiling for a per-request ttl
  const sessionTtl = cfg.sessionTtl ?? 900;       // session token lifetime, seconds
  const maxAttempts = cfg.maxAttempts ?? 5;       // wrong tries before lockout
  const idCapacity = cfg.rateLimitPerIdentifier ?? 5;
  const ipCapacity = cfg.rateLimitPerIp ?? 20;
  const windowSec = cfg.rateWindow ?? 60;
  const exposeTestbox = cfg.exposeTestbox === true;
  const channel = typeof cfg.channel === 'function' ? cfg.channel : null;

  // ------------------------------------------------------- persistence
  const dir = api.storage.pluginDir();
  const secretFile = path.join(dir, 'secret');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600 });
  }
  const secret = fs.readFileSync(secretFile);

  const tableFile = path.join(dir, 'otp.json');
  const loadJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  // OTP table: key = `${identifier}\0${purpose}` -> { identifier, purpose,
  // hash, iat, exp, attempts_remaining, locked }. Only one live code per
  // (identifier, purpose): a new request supersedes the old. Expired rows
  // pruned at boot.
  const now0 = Math.floor(Date.now() / 1000);
  const table = new Map(Object.entries(loadJson(tableFile)).filter(([, e]) => e && e.exp > now0));
  const persist = () => atomicWrite(tableFile, JSON.stringify(Object.fromEntries(table)));
  const keyFor = (identifier, purpose) => `${identifier}${NUL}${purpose}`;

  // ---------------------------------------------------- channel adapter
  // The integration point. A real deployment sets config.channel to deliver
  // over email / SMS / Nostr DM. With none set, the console/test channel
  // records the code in an in-memory outbox (the ONLY place a code is ever
  // legible after generation) for the testbox route to read.
  const outbox = [];
  async function dispatch(identifier, code, purpose) {
    if (channel) { await channel(identifier, code, purpose); return; }
    api.log.info(
      `otp: [console channel] ${purpose} code generated for ${identifier} — `
      + 'set config.channel for real delivery (email/SMS/DM)',
    );
    outbox.push({ identifier, purpose, code, at: Date.now() });
  }

  const idBuckets = new Map();
  const ipBuckets = new Map();

  const parseBody = (request) => (request.body && typeof request.body === 'object' ? request.body : {});

  // ------------------------------------------------------------ routes
  // POST {prefix}/request — challenge. No auth: requesting a code proves
  // nothing; only verifying it does.
  api.fastify.post(`${prefix}/request`, async (request, reply) => {
    const body = parseBody(request);
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    const purpose = typeof body.purpose === 'string' ? body.purpose : 'session';
    if (!identifier || identifier.length > 256) {
      return reply.code(400).send({ error: 'identifier required (<= 256 chars)' });
    }
    if (!PURPOSES.has(purpose)) {
      return reply.code(400).send({ error: `purpose must be one of [${[...PURPOSES]}]` });
    }
    const ttl = body.ttl ?? defaultTtl;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > maxTtl) {
      return reply.code(400).send({ error: `ttl must be a positive number of seconds <= ${maxTtl}` });
    }

    // Rate-limit per source IP AND per identifier (the #505 brief).
    const ip = request.ip || 'unknown';
    if (!takeToken(ipBuckets, ip, ipCapacity, ipCapacity / windowSec)) {
      return reply.code(429).send({ error: 'rate limit exceeded (source ip)' });
    }
    if (!takeToken(idBuckets, identifier, idCapacity, idCapacity / windowSec)) {
      return reply.code(429).send({ error: 'rate limit exceeded (identifier)' });
    }

    const code = generateCode(codeLength);
    const iat = Math.floor(Date.now() / 1000);
    table.set(keyFor(identifier, purpose), {
      identifier,
      purpose,
      hash: hashCode(code, identifier, purpose, secret),
      iat,
      exp: iat + Math.floor(ttl),
      attempts_remaining: maxAttempts,
      locked: false,
    });
    persist();
    await dispatch(identifier, code, purpose);
    api.log.info(`otp: issued ${purpose} challenge for ${identifier} (ttl ${Math.floor(ttl)}s)`);
    // The plaintext code goes ONLY to the channel, never in the response.
    return reply.code(201).send({ ok: true, identifier, purpose, expiresIn: Math.floor(ttl) });
  });

  // POST {prefix}/verify — challenge answer. On success, single-use consume
  // + mint a plugin-scoped session token.
  api.fastify.post(`${prefix}/verify`, async (request, reply) => {
    const body = parseBody(request);
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    const purpose = typeof body.purpose === 'string' ? body.purpose : 'session';
    const code = typeof body.code === 'string' ? body.code : '';
    if (!identifier || !code) {
      return reply.code(400).send({ error: 'identifier and code required' });
    }
    if (!PURPOSES.has(purpose)) {
      return reply.code(400).send({ error: `purpose must be one of [${[...PURPOSES]}]` });
    }

    const key = keyFor(identifier, purpose);
    const entry = table.get(key);
    const nowS = Math.floor(Date.now() / 1000);
    if (!entry) {
      return reply.code(401).send({ error: 'no active code for this identifier/purpose' });
    }
    if (entry.exp <= nowS) {
      table.delete(key);
      persist();
      return reply.code(401).send({ error: 'code expired' });
    }
    if (entry.locked || entry.attempts_remaining <= 0) {
      entry.locked = true;
      persist();
      return reply.code(423).send({ error: 'too many attempts — locked; request a new code' });
    }

    // Constant-time compare against the stored hash.
    const presented = Buffer.from(hashCode(code, identifier, purpose, secret));
    const stored = Buffer.from(entry.hash);
    const ok = presented.length === stored.length && crypto.timingSafeEqual(presented, stored);
    if (!ok) {
      entry.attempts_remaining -= 1;
      if (entry.attempts_remaining <= 0) entry.locked = true;
      persist();
      return reply.code(401).send({
        error: 'invalid code',
        attempts_remaining: Math.max(0, entry.attempts_remaining),
        locked: entry.locked,
      });
    }

    // Success: consume the code atomically (single-use), then mint session.
    table.delete(key);
    persist();
    const exp = nowS + sessionTtl;
    const token = signSession(
      { v: 1, sub: identifier, purpose, iat: nowS, exp, jti: crypto.randomBytes(12).toString('base64url') },
      secret,
    );
    api.log.info(`otp: verified ${purpose} for ${identifier} — session minted (exp ${exp})`);
    return reply.send({ token, identifier, purpose, exp });
  });

  // GET {prefix}/whoami — demonstrate the session. Bearer here is the OTP
  // session token, NOT a pod credential and NOT checked by api.auth.
  api.fastify.get(`${prefix}/whoami`, async (request, reply) => {
    const auth = request.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return reply.code(401).send({ error: 'Bearer OTP session token required' });
    const { payload, error } = verifySession(m[1].trim(), secret);
    if (error) return reply.code(401).send({ error });
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return reply.code(401).send({ error: 'session expired' });
    }
    return reply.send({ identifier: payload.sub, purpose: payload.purpose, exp: payload.exp });
  });

  // GET {prefix}/_testbox — reads the console channel's outbox. Guarded:
  // only mounted when config.exposeTestbox is true. Leaks live codes; a
  // production config must never set it.
  if (exposeTestbox) {
    api.fastify.get(`${prefix}/_testbox`, async (request, reply) => reply.send({ outbox }));
    api.log.warn(`otp: TESTBOX EXPOSED at ${prefix}/_testbox — for tests only, never enable in production`);
  }

  api.log.info(
    `otp: request at ${prefix}/request, verify at ${prefix}/verify, whoami at ${prefix}/whoami `
    + `(codeLength ${codeLength}, ttl ${defaultTtl}s, sessionTtl ${sessionTtl}s, `
    + `${channel ? 'custom channel' : 'console channel'})`,
  );
  return {
    deactivate() {
      persist();
    },
  };
}

export default activate;
