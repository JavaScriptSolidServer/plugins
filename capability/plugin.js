// capability — capability URIs (#506) as a #206 loader plugin.
//
//   plugins: [{ module: 'capability/plugin.js', prefix: '/cap',
//               config: { resources: { 'report.pdf': '…seed content…' },
//                         defaultTtl: 3600, maxTtl: 2592000, maxBytes: 1048576 } }]
//
// Scoped, time-bound, SHAREABLE access by URI possession instead of WebID:
//
//   POST {prefix}/issue    authenticated (api.auth.getAgent) — mint a grant
//                          { resource, modes: ['read'|'write'], ttl } →
//                          { url: '{prefix}/r/<token>', token, jti, exp, … }
//   *    {prefix}/r/<tok>  NO auth — the capability IS the auth. Signature,
//                          expiry, revocation and mode are checked; then the
//                          resource is served (read) or written (write).
//   POST {prefix}/revoke   authenticated, issuer-only — { token } or { jti }
//
// Token format (macaroon-lite, self-describing + self-verifying, no DB):
//
//   v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(secret, "v1."+payload))>
//   payload = { v:1, jti, iss, res, modes, iat, exp }
//
// The HMAC key is a server-side secret generated once and persisted in
// api.storage.pluginDir()/secret; the revocation ledger (revoked.json) and
// an issued index (issued.json, so issuers can revoke by jti) live beside
// it. Issue #506 proposes signing with the issuer's Nostr key
// (src/auth/nostr-keys.js) — that's an internal a plugin can't reach, so
// this port signs with a server secret instead: same bearer semantics,
// but only the minting server can verify (see README findings).
//
// Scope boundary (the finding): the resources these capabilities govern
// are the PLUGIN'S OWN — an in-memory map seeded from config.resources
// plus files under pluginDir()/store. Granting capability access to
// arbitrary POD resources would require telling WAC "treat this request
// as authorized" (issue #506's virtual-agent step) — a seam only core can
// provide. See README "Findings".

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MODES = new Set(['read', 'write']);
const MODE_FOR_METHOD = { GET: 'read', HEAD: 'read', PUT: 'write', POST: 'write' };
const MAX_TOKEN_LENGTH = 4096;

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};
const mimeFor = (name) => MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';

// ---------------------------------------------------------------- token
// Exported as pure functions so tests (and operators) can craft and check
// tokens against a known secret without booting a server.

/** @returns {string} `v1.<b64url payload>.<b64url hmac-sha256 sig>` */
export function signCapability(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`v1.${body}`).digest('base64url');
  return `v1.${body}.${sig}`;
}

/** @returns {{ payload?: object, error?: string }} signature + shape only — expiry/revocation/mode are the caller's checks */
export function verifyCapability(token, secret) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return { error: 'malformed token' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { error: 'malformed token' };
  const [, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`v1.${body}`).digest();
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
  if (!payload || payload.v !== 1 || typeof payload.jti !== 'string'
    || typeof payload.res !== 'string' || !Array.isArray(payload.modes)
    || typeof payload.exp !== 'number') {
    return { error: 'malformed token' };
  }
  return { payload };
}

export async function activate(api) {
  const prefix = api.prefix || '/cap';
  const cfg = api.config || {};
  const defaultTtl = cfg.defaultTtl ?? 3600;
  const maxTtl = cfg.maxTtl ?? 30 * 24 * 3600;
  const maxBytes = cfg.maxBytes ?? 1024 * 1024;

  // ------------------------------------------------------- persistence
  const dir = api.storage.pluginDir();
  const secretFile = path.join(dir, 'secret');
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600 });
  }
  const secret = fs.readFileSync(secretFile);

  const storeDir = path.join(dir, 'store');
  fs.mkdirSync(storeDir, { recursive: true });

  const revokedFile = path.join(dir, 'revoked.json');
  const issuedFile = path.join(dir, 'issued.json');
  const loadJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  // revoked: jti -> exp (kept until the token would have expired anyway;
  // null = exp unknown, kept forever). issued: jti -> { iss, exp } so the
  // issuer can revoke by jti without having kept the token itself.
  const now = Math.floor(Date.now() / 1000);
  const revoked = new Map(Object.entries(loadJson(revokedFile)).filter(([, exp]) => exp == null || exp > now));
  const issued = new Map(Object.entries(loadJson(issuedFile)).filter(([, v]) => v?.exp > now));
  const persist = () => {
    fs.writeFileSync(revokedFile, JSON.stringify(Object.fromEntries(revoked)));
    fs.writeFileSync(issuedFile, JSON.stringify(Object.fromEntries(issued)));
  };

  // -------------------------------------------------------- resources
  // The plugin's OWN resource space: config-seeded read-only map, shadowed
  // by files under pluginDir()/store (where write capabilities land).
  const seeded = new Map(Object.entries(cfg.resources ?? {}));

  /**
   * Canonical resource name: '{prefix}/files/report.pdf', '/report.pdf'
   * and 'report.pdf' all mean 'report.pdf'. Rejects traversal.
   * @returns {string|null}
   */
  function normalizeName(resource) {
    if (typeof resource !== 'string' || !resource || resource.length > 512) return null;
    let name = resource;
    if (name.startsWith(`${prefix}/files/`)) name = name.slice(`${prefix}/files/`.length);
    else if (name.startsWith(`${prefix}/`)) name = name.slice(`${prefix}/`.length);
    name = name.replace(/^\/+/, '');
    if (!name || name.includes('\\') || name.includes('\0')) return null;
    const segments = name.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
    return name;
  }

  /** Absolute path under storeDir, or null if it would escape. */
  function storePath(name) {
    const abs = path.resolve(storeDir, name);
    return abs.startsWith(storeDir + path.sep) ? abs : null;
  }

  // -------------------------------------------------------- validation
  /** Full check chain for a presented token. @returns {{ payload?, code?, error? }} */
  function validate(token, method) {
    const { payload, error } = verifyCapability(token, secret);
    if (error) return { code: 401, error };
    if (payload.exp <= Math.floor(Date.now() / 1000)) return { code: 401, error: 'capability expired' };
    if (revoked.has(payload.jti)) return { code: 401, error: 'capability revoked' };
    const needed = MODE_FOR_METHOD[method];
    if (!needed) return { code: 405, error: `method ${method} not supported` };
    if (!payload.modes.includes(needed)) {
      return { code: 403, error: `capability grants [${payload.modes}], not '${needed}' (${method})` };
    }
    return { payload };
  }

  const capHeaders = (reply) => reply
    .header('cache-control', 'no-store')       // bearer URL — never cache
    .header('referrer-policy', 'no-referrer'); // #506: no Referer leakage

  // ------------------------------------------------------------ routes
  // POST {prefix}/issue — only a signed-in agent may mint.
  api.fastify.post(`${prefix}/issue`, async (request, reply) => {
    const agent = await api.auth.getAgent(request);
    if (!agent) return reply.code(401).send({ error: 'authentication required to issue capabilities' });

    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const name = normalizeName(body.resource);
    if (!name) return reply.code(400).send({ error: 'resource must be a plain path (no .. / \\), e.g. "report.pdf"' });

    const modes = Array.isArray(body.modes) && body.modes.length ? [...new Set(body.modes)] : ['read'];
    if (!modes.every((m) => MODES.has(m))) {
      return reply.code(400).send({ error: `modes must be a subset of [${[...MODES]}]` });
    }
    const ttl = body.ttl ?? defaultTtl;
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > maxTtl) {
      return reply.code(400).send({ error: `ttl must be a positive number of seconds <= ${maxTtl}` });
    }

    const iat = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      jti: crypto.randomBytes(16).toString('base64url'),
      iss: agent,
      res: name,
      modes,
      iat,
      exp: iat + Math.floor(ttl),
    };
    const token = signCapability(payload, secret);
    issued.set(payload.jti, { iss: agent, exp: payload.exp });
    persist();
    api.log.info(`capability: ${agent} issued ${modes} on ${name} (jti ${payload.jti}, ttl ${ttl}s)`);
    return reply.code(201).send({
      url: `${prefix}/r/${token}`,
      token,
      jti: payload.jti,
      resource: name,
      modes,
      exp: payload.exp,
      issuer: agent,
    });
  });

  // {prefix}/r/<token> — NO auth: possession of the URL is the credential.
  // (HEAD is served automatically by fastify's exposeHeadRoutes off GET.)
  // Wildcard, not `:token`: fastify's default maxParamLength (100) is
  // shorter than a capability token (~300 chars), and a plugin cannot set
  // server options — a named param would 404 every capability.
  api.fastify.route({
    method: ['GET', 'PUT', 'POST'],
    url: `${prefix}/r/*`,
    handler: async (request, reply) => {
      const { payload, code, error } = validate(request.params['*'], request.method);
      if (error) return capHeaders(reply).code(code).send({ error });
      const name = payload.res;

      if (MODE_FOR_METHOD[request.method] === 'read') {
        const abs = storePath(name);
        if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          return capHeaders(reply).header('content-type', mimeFor(name)).send(fs.readFileSync(abs));
        }
        if (seeded.has(name)) {
          return capHeaders(reply).header('content-type', mimeFor(name)).send(seeded.get(name));
        }
        return capHeaders(reply).code(404).send({ error: 'no such resource' });
      }

      // write
      let buf = request.body;
      if (buf == null) return capHeaders(reply).code(400).send({ error: 'request body required' });
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(typeof buf === 'string' ? buf : JSON.stringify(buf));
      if (buf.length > maxBytes) return capHeaders(reply).code(413).send({ error: `body exceeds ${maxBytes} bytes` });
      const abs = storePath(name);
      if (!abs) return capHeaders(reply).code(400).send({ error: 'bad resource path' });
      const existed = fs.existsSync(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      api.log.info(`capability: write to ${name} via jti ${payload.jti} (${buf.length} bytes)`);
      return capHeaders(reply).code(existed ? 204 : 201).send();
    },
  });

  // POST {prefix}/revoke — issuer-only; body { token } or { jti }.
  api.fastify.post(`${prefix}/revoke`, async (request, reply) => {
    const agent = await api.auth.getAgent(request);
    if (!agent) return reply.code(401).send({ error: 'authentication required to revoke' });

    const body = request.body && typeof request.body === 'object' ? request.body : {};
    let jti;
    let iss;
    let exp = null;
    if (typeof body.token === 'string') {
      const { payload, error } = verifyCapability(body.token, secret);
      if (error) return reply.code(400).send({ error });
      ({ jti, iss, exp } = payload);
    } else if (typeof body.jti === 'string') {
      const record = issued.get(body.jti);
      if (!record) return reply.code(404).send({ error: 'unknown jti (index only keeps unexpired issues; revoke by token instead)' });
      jti = body.jti;
      ({ iss, exp } = record);
    } else {
      return reply.code(400).send({ error: 'body must carry token or jti' });
    }
    if (iss !== agent) return reply.code(403).send({ error: 'only the issuer may revoke a capability' });

    revoked.set(jti, exp);
    persist();
    api.log.info(`capability: ${agent} revoked jti ${jti}`);
    return reply.send({ revoked: jti });
  });

  api.log.info(
    `capability: issue at ${prefix}/issue, capabilities at ${prefix}/r/<token>, ` +
    `revoke at ${prefix}/revoke (${seeded.size} seeded resource(s), store ${storeDir})`,
  );
  return {
    deactivate() {
      persist();
    },
  };
}

export default activate;
