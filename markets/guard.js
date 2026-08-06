// markets/guard.js — the browser-facing security layer: scoped session
// tokens, CSRF/origin enforcement, rate limiting, security headers.
//
// Three attacks this module exists to stop, all confirmed against a live
// server during review:
//
//   1. POD TAKEOVER VIA localStorage. The UI used to ask the user to
//      paste a POD bearer — a credential for their entire pod — and kept
//      it in localStorage on an origin that also serves attacker-uploaded
//      HTML (a pod is a file host: PUT evil.html, it is served as
//      text/html, same origin). One stored XSS anywhere on the host and
//      the attacker owns the victim's whole pod. Fix: the pod bearer is
//      exchanged ONCE for a markets-scoped, expiring session token
//      (capability/'s HMAC macaroon-lite shape) delivered as an HttpOnly
//      cookie — unreadable from script, and useless outside this plugin.
//
//   2. CSRF. The host reflects the request Origin with
//      Access-Control-Allow-Credentials: true, and getAgent also honours
//      ambient WebID-TLS client certificates — so evil.example could POST
//      a trade as the victim and read the reply. Fix: any request
//      carrying AMBIENT credentials (cookie or TLS cert — anything not an
//      explicit Authorization header) must be same-origin to mutate, and
//      the plugin overrides the inherited CORS headers on its own routes.
//
//   3. UNAUTHENTICATED RESOURCE EXHAUSTION. The host's rate limiter is
//      global:false, so plugin routes get none; 20 MiB anonymous bodies
//      were parsed before the 401. Fix: a token bucket here, plus
//      per-route bodyLimit at registration.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ------------------------------------------------- scoped session token
/**
 * v1.<b64url(payload)>.<b64url(HMAC-SHA256)> — self-verifying, no table.
 * Scope is implicit: this secret only ever signs markets sessions, and
 * only this plugin verifies them, so a stolen session token buys markets
 * access and nothing else on the pod.
 */
// A session-signing key that was committed to this repo's history by a
// test writing into the source tree. Removing the file from the working
// tree is NOT remediation: the blob is still `git show`-able, so anyone
// with the repo could forge a session token for any agent on any
// deployment whose pluginDir was seeded from those commits. Refusing to
// boot on it is the only mitigation a plugin can enforce by itself.
const BURNED_SECRETS = new Set([
  'c59b6df7144548b73d07746635c6774828bf8cc74af8febb8d2ce5db2699d277',
]);

export function createSessions({ dir, ttlMs }) {
  const secretFile = path.join(dir, 'session.secret');
  let secret;
  try {
    secret = fs.readFileSync(secretFile);
  } catch {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  if (BURNED_SECRETS.has(crypto.createHash('sha256').update(secret).digest('hex'))) {
    throw new Error(
      `markets: ${secretFile} is a key that leaked into git history — anyone with the repository `
      + 'can forge session tokens for any agent. Delete the file (a fresh key is generated on the '
      + 'next boot; every existing session is invalidated, which is the point).',
    );
  }

  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest();

  function mint(agent, epoch = 0) {
    const exp = Date.now() + ttlMs;
    const payload = b64url(JSON.stringify({ agent, exp, epoch }));
    return `v1.${payload}.${b64url(sign(payload))}`;
  }

  /**
   * @returns {{agent:string, exp:number, epoch:number}|null} the claims,
   * or null if absent/forged/expired. The caller must still compare
   * `epoch` against the agent's current epoch — that comparison is what
   * makes sign-out, freeze and revoke actually terminate a session,
   * since a self-verifying token is otherwise valid for its whole TTL.
   */
  function verify(token) {
    if (typeof token !== 'string' || !token.startsWith('v1.')) return null;
    const [, payload, mac] = token.split('.');
    if (!payload || !mac) return null;
    const expected = b64url(sign(payload));
    // timingSafeEqual throws on length mismatch — compare lengths first.
    if (mac.length !== expected.length
        || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch { return null; }
    if (!claims.agent || typeof claims.exp !== 'number' || Date.now() > claims.exp) return null;
    return { agent: claims.agent, exp: claims.exp, epoch: claims.epoch || 0 };
  }

  return { mint, verify, ttlMs };
}

// ------------------------------------------------------- origin / CSRF
/**
 * Is this request same-origin (or a non-browser client)?
 *
 * Sec-Fetch-Site is the reliable signal in modern browsers and cannot be
 * set by script. Origin is the fallback. A request with NEITHER is not a
 * browser request — curl, a server, a native client — and those cannot be
 * CSRF'd, because CSRF requires a browser to attach credentials the
 * attacker doesn't hold. Such requests are still required to present an
 * explicit Authorization header (see requireSameOriginForAmbient).
 */
export function isSameOrigin(request, ownOrigin) {
  const site = request.headers['sec-fetch-site'];
  const origin = request.headers.origin;
  // When both are present they must AGREE. Letting Sec-Fetch-Site alone
  // decide makes the Origin check dead code and trusts any intermediary
  // that rewrites headers.
  if (site && !(site === 'same-origin' || site === 'none')) return false;
  if (origin) {
    if (!ownOrigin) return false; // an origin is claimed and we can't verify it
    try {
      if (new URL(origin).origin !== new URL(ownOrigin).origin) return false;
    } catch { return false; }
    return true;
  }
  // No Origin header: trust only an explicit same-origin/none fetch
  // signal. A request with neither header is not a browser request, and
  // the caller only reaches here when the credential is ambient — so
  // refusing costs nothing and closes the header-stripping case.
  return site === 'same-origin' || site === 'none';
}

/** True when the credential is ambient (cookie / TLS cert), i.e. a browser
 *  would attach it cross-origin without the attacker knowing it. */
export function isAmbientCredential(request) {
  return !request.headers.authorization;
}

// -------------------------------------------------------- rate limiter
/**
 * Token bucket keyed by agent-or-IP. Costs are per route class, so an
 * expensive settle can charge more than a quote. Memory is bounded by
 * eviction of idle buckets.
 */
export function createRateLimiter({ capacity = 60, refillPerSec = 1, maxKeys = 50_000 } = {}) {
  const buckets = new Map();

  function take(key, cost = 1) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) {
        // Evict the least recently seen decile rather than growing without
        // bound under a spray of one-shot keys.
        const victims = [...buckets.entries()].sort((x, y) => x[1].seen - y[1].seen)
          .slice(0, Math.ceil(maxKeys / 10));
        for (const [k] of victims) buckets.delete(k);
      }
      b = { tokens: capacity, seen: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.seen) / 1000) * refillPerSec);
    b.seen = now;
    if (b.tokens < cost) return Math.ceil(((cost - b.tokens) / refillPerSec) * 1000);
    b.tokens -= cost;
    return 0; // allowed
  }

  return { take, size: () => buckets.size, clear: () => buckets.clear() };
}

// ----------------------------------------------------- header hardening
/** Headers for the HTML UI: no framing (clickjacking a one-click Buy),
 *  no sniffing, and a CSP that keeps script to this origin. */
export const UI_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; "
    + "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** Headers for JSON API replies: never shared-cacheable, and varying on
 *  Authorization so no proxy can serve one agent's positions to another. */
export const API_HEADERS = {
  'cache-control': 'private, no-store',
  vary: 'Authorization, Cookie',
  'x-content-type-options': 'nosniff',
};
