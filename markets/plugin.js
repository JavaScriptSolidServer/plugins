// markets — prediction markets with an LMSR automated market maker, as a
// #206 loader plugin. Paper credits: the FanDuel *shape* (markets, live
// prices, positions, cash-out, settlement) with play money.
//
//   plugins: [{ module: 'markets/plugin.js', prefix: '/predict',
//               config: { grantCredits: 1000, feeBps: 100,
//                         admins: ['https://alice.example/profile/card#me'] } }]
//
// Layout: lmsr.js (the AMM math + TWAP), store.js (journal + snapshot +
// reducer), lifecycle.js (the settlement state machine), guard.js
// (sessions, CSRF, rate limiting, headers), ui.js (the trading UI), this
// file (policy + routes).
//
// MONEY. Integer micro-credits (1 credit = 1e6 micro). Costs round up,
// proceeds and payouts round down, fees round up — every rounding
// direction favours the pool, so float drift can never over-draw it.
// Shares are integer micro-shares; one share of the winning outcome
// redeems for exactly one credit.
//
// SOLVENCY. The creator escrows LMSR's worst-case maker loss b·ln n at
// creation, so payouts provably fit inside subsidy + collected (see
// lmsr.js for the two Gibbs-inequality bounds this rests on). A pro-rata
// clamp at settlement is the belt-and-braces backstop; it logs loudly and
// has never fired.
//
// SETTLEMENT is a state machine, not a single privileged call, because a
// unilateral instant oracle is a credit-theft primitive:
//
//   open --closesAt--> (closed: no trading)
//     |                      |
//     | oracle resolve       | nobody resolves within settlementWindow
//     v                      v
//   resolving --disputeWindow--> resolved      auto-void at TWAP
//     |                                        (funds are NEVER stuck:
//     | any holder disputes                     anyone may trigger this)
//     v
//   disputed --admin: uphold / re-resolve / void--> settled
//            --disputeGrace with no admin--> the resolution STANDS
//              (bonds forfeited: silence must not be a free refund)
//
// Three separate defences against the oracle stealing the pool:
//   1. the oracle and creator MAY NOT TRADE in their own market;
//   2. the creator's settlement claim is CAPPED AT THEIR OWN ESCROW —
//      residual beyond it goes to the house, so resolving to an outcome
//      nobody holds wins the attacker nothing;
//   3. holders can dispute inside the window, which parks the market for
//      an admin instead of paying out.
//
// VOID REDEEMS AT A TWAP over the window ending at close, never at spot.
// Redeeming at spot is a guaranteed arbitrage — by strict convexity,
// buying x shares costs less than x·p_final, so buy-then-void extracts
// b·ln n risk-free, partly out of other holders' redemptions. A TWAP is
// still conserving (the bound holds for ANY probability vector) but a
// last-second pump barely moves it, so the pump is a pure loss.
//
// ATOMICITY. Every mutating handler awaits auth FIRST, then validates and
// calls store.commit() with no await in between — Node's single thread
// makes the journal-append-then-apply a transaction. commit() journals
// (fsync) BEFORE mutating memory, so a failed write cannot leave the
// in-memory ledger ahead of the durable one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lmsrPrices, tradeCostRaw, sharesForBudget, twapPrices, uniformPrices } from './lmsr.js';
import { createStore, dict, TWAP_PROTECT_MS } from './store.js';
import { createLifecycle } from './lifecycle.js';
import {
  createSessions, createRateLimiter, isSameOrigin, isAmbientCredential, UI_HEADERS, API_HEADERS,
} from './guard.js';
import { renderUi } from './ui.js';

export { lmsrCost, lmsrPrices, twapPrices } from './lmsr.js';

const MICRO = 1_000_000;
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const HOUSE = '(house)'; // reserved ledger key — not a valid agent id, so unclaimable

const LIMITS = {
  titleLen: 200,
  descriptionLen: 2000,
  categoryLen: 40,
  outcomeLabelLen: 80,
  outcomesMin: 2,
  outcomesMax: 12,
  bMinCredits: 10,
  bMaxCredits: 100_000,
  maxMarkets: 10_000,
  maxMarketsPerAgent: 50,
  maxTradeShares: 1_000_000,
  maxHorizonMs: 5 * 365 * 24 * 3600 * 1000,
  listLimit: 50,
  listLimitMax: 200,
  leaderboard: 20,
  tradeFeedLimit: 100,
  idempotencyTtlMs: 10 * 60 * 1000,
  maxIdempotencyKeys: 10_000,
  maxAdjustCredits: 1_000_000,
  maxSockets: 500,
  maxSocketsPerIp: 10,
  wsBufferBytes: 1 << 20,
};

export function randomId(len = 8) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += B62[b % 62];
  return s;
}

/** A persistent per-deployment secret, created 0600 on first boot. */
function readOrCreateSecret(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    const s = crypto.randomBytes(32);
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}

/** An agent id is a WebID (http/https URL) or a DID — the two shapes
 *  getAgent can ever return. Rejecting anything else at creation stops a
 *  typo'd oracle from being an unsatisfiable settlement condition. */
export function isAgentId(s) {
  if (typeof s !== 'string' || !s || s.length > 512) return false;
  if (s.startsWith('did:')) return /^did:[a-z0-9]+:[\w.:%-]+$/i.test(s);
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

export async function activate(api) {
  const prefix = api.prefix ?? '/markets'; // '' = site root (standalone host)
  const cfg = api.config || {};

  // ------------------------------------------------------------ config
  const num = (v, d) => (v === undefined ? d : v);
  const grantMicro = Math.round(num(cfg.grantCredits, 1000) * MICRO);
  const accountsUi = !!cfg.accountsUi; // standalone hosts: register/login form instead of pod-bearer paste
  const feeBps = num(cfg.feeBps, 100);
  const houseFeeShareBps = num(cfg.houseFeeShareBps, 5000);
  const disputeWindowMs = num(cfg.disputeWindowMs, 60 * 60 * 1000);
  const disputeBondMicro = Math.round(num(cfg.disputeBondCredits, 25) * MICRO);
  const disputeBondBps = num(cfg.disputeBondBps, 2000); // 20% of the disputed position
  const disputeGraceMs = num(cfg.disputeGraceMs, 7 * 24 * 3600 * 1000);
  const settlementWindowMs = num(cfg.settlementWindowMs, 7 * 24 * 3600 * 1000);
  const twapWindowMs = num(cfg.twapWindowMs, 30 * 60 * 1000);
  const sessionTtlMs = num(cfg.sessionTtlMs, 12 * 3600 * 1000);
  const rateCapacity = num(cfg.rateCapacity, 120);
  const rateRefillPerSec = num(cfg.rateRefillPerSec, 2);
  const allowInsiderTrading = cfg.allowInsiderTrading === true;
  const admins = new Set(Array.isArray(cfg.admins) ? cfg.admins : []);

  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
    throw new Error('markets: config.feeBps must be an integer 0..1000 (basis points)');
  }
  if (!Number.isInteger(houseFeeShareBps) || houseFeeShareBps < 0 || houseFeeShareBps > 10_000) {
    throw new Error('markets: config.houseFeeShareBps must be an integer 0..10000');
  }
  if (!Number.isFinite(grantMicro) || grantMicro < 0) {
    throw new Error('markets: config.grantCredits must be a non-negative number');
  }
  for (const a of admins) {
    if (!isAgentId(a)) throw new Error(`markets: config.admins contains a non-agent id: ${a}`);
  }
  // These windows are load-bearing, not cosmetic: twapWindowMs = 0 makes
  // voidPrices() degenerate to the SPOT price, which resurrects the
  // buy-then-void arbitrage the TWAP exists to prevent. Refuse to boot on
  // a value that would silently disable a defence.
  for (const [name, v] of Object.entries({
    disputeWindowMs, disputeGraceMs, settlementWindowMs, twapWindowMs, sessionTtlMs,
    snapshotIntervalMs: num(cfg.snapshotIntervalMs, 30_000),
  })) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`markets: config.${name} must be a positive number of milliseconds (got ${v})`);
    }
  }
  // "> 0" is not the property that matters: a 1ms window gives the last
  // price full weight, i.e. the TWAP IS spot — the very arbitrage the
  // window exists to prevent.
  if (twapWindowMs < 60_000) {
    throw new Error('markets: config.twapWindowMs must be at least 60000ms — a shorter window is spot pricing in disguise');
  }
  // Get these two the wrong way round and a resolution is still inside
  // its dispute window when the abandoned-market backstop opens — which
  // made every resolution voidable by every loser.
  if (disputeWindowMs >= settlementWindowMs) {
    throw new Error(
      `markets: config.disputeWindowMs (${disputeWindowMs}) must be shorter than `
      + `settlementWindowMs (${settlementWindowMs})`,
    );
  }
  if (!Number.isFinite(disputeBondBps) || disputeBondBps < 0 || disputeBondBps > 10_000) {
    throw new Error('markets: config.disputeBondBps must be 0..10000');
  }
  if (!Number.isFinite(rateCapacity) || rateCapacity <= 0
      || !Number.isFinite(rateRefillPerSec) || rateRefillPerSec <= 0) {
    throw new Error('markets: config.rateCapacity and config.rateRefillPerSec must be positive');
  }
  if (twapWindowMs > TWAP_PROTECT_MS) {
    throw new Error(
      `markets: config.twapWindowMs (${twapWindowMs}) must not exceed ${TWAP_PROTECT_MS}ms — beyond that, `
      + 'price-history thinning reaches inside the redemption window and makes the void price steerable by trade timing',
    );
  }
  if (!Number.isFinite(disputeBondMicro) || disputeBondMicro < 0) {
    throw new Error('markets: config.disputeBondCredits must be a non-negative number');
  }
  if (/["'<>]/.test(prefix)) throw new Error(`markets: refusing an unsafe prefix: ${prefix}`);

  // -------------------------------------------------- store & security
  const dir = api.storage.pluginDir();
  const store = createStore({ dir, log: api.log, prices: lmsrPrices });
  const { state } = store;
  const sessions = createSessions({ dir, ttlMs: sessionTtlMs });
  const pseudonymSalt = readOrCreateSecret(path.join(dir, 'pseudonym.salt'));
  const limiter = createRateLimiter({ capacity: rateCapacity, refillPerSec: rateRefillPerSec });

  /** agent → Set(marketId) — so /api/me is O(your markets), not O(all). */
  const byAgent = new Map();
  const indexPosition = (agent, id) => {
    let s = byAgent.get(agent);
    if (!s) byAgent.set(agent, (s = new Set()));
    s.add(id);
  };
  for (const m of Object.values(state.markets)) {
    for (const agent of Object.keys(m.positions)) indexPosition(agent, m.id);
  }

  const ownOrigin = () => {
    try {
      if (typeof api.serverInfo === 'function') {
        const info = api.serverInfo();
        if (info && info.baseUrl) return info.baseUrl;
      }
    } catch { /* not listening yet */ }
    return cfg.baseUrl || null;
  };

  // ------------------------------------------------------------- auth
  const cookieName = 'markets_session';
  function cookieToken(request) {
    const raw = request.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName) return decodeURIComponent(v.join('='));
    }
    return null;
  }

  /**
   * Resolve the caller. Order matters: our own scoped session token (the
   * only credential a browser is ever asked to hold) is checked first, so
   * the pod bearer path is reserved for API clients that send it
   * explicitly.
   */
  /** Resolve a session token to an agent id. A session is live only
   *  while its epoch matches the agent's current epoch — that comparison
   *  is what makes sign-out, freeze and revoke actually end a session,
   *  since a self-verifying token is otherwise valid for its whole TTL. */
  function liveSession(token) {
    const claims = sessions.verify(token);
    if (!claims) return null;
    const row = state.ledger[claims.agent];
    if ((row ? row.epoch || 0 : 0) !== claims.epoch) return null;
    return claims.agent;
  }

  /**
   * @returns {Promise<{agent:string|null, ambient:boolean}>} `ambient` is
   * true when the credential is one a browser attaches by itself — a
   * cookie, or a WebID-TLS client certificate — i.e. one a cross-origin
   * page could borrow without knowing it.
   */
  async function resolveAgentFull(request) {
    const cookie = cookieToken(request);
    if (cookie) {
      const agent = liveSession(cookie);
      if (agent) return { agent, ambient: true };
    }
    const auth = request.headers.authorization;
    if (auth && auth.startsWith('Bearer v1.')) {
      const agent = liveSession(auth.slice(7));
      if (agent) return { agent, ambient: false };
    }
    const agent = await api.auth.getAgent(request);
    // getAgent may have authenticated from an ambient TLS client
    // certificate; only an explicit Authorization header proves the
    // caller actually held a secret.
    return { agent, ambient: agent ? !auth : false };
  }

  async function resolveAgent(request) {
    return (await resolveAgentFull(request)).agent;
  }

  // ------------------------------------------------------------ replies
  const err = (reply, code, error, extra) => reply.code(code).send({ error, ...extra });

  /** Guard for every mutating route: same-origin required whenever the
   *  credential is ambient (cookie/TLS cert), because those are exactly
   *  the credentials a cross-origin page can borrow. */
  /** The origin to compare against, preferring configured/serverInfo and
   *  falling back to the request's own Host so a deployment without
   *  baseUrl doesn't silently refuse every browser mutation. */
  function originFor(request) {
    const known = ownOrigin();
    if (known) return known;
    const host = request.headers.host;
    if (!host) return null;
    // Fastify reports the SOCKET's protocol unless trustProxy is on,
    // which a plugin cannot set; behind nginx/Caddy that is 'http' while
    // the browser's Origin says https, and every mutation would 403.
    const proto = request.headers['x-forwarded-proto'] || request.protocol || 'https';
    return `${String(proto).split(',')[0].trim()}://${host}`;
  }

  function csrfOk(request) {
    // A session cookie makes the request ambient REGARDLESS of any
    // Authorization header: resolveAgent checks the cookie first, so an
    // attacker could otherwise bolt on a junk bearer to look
    // "explicitly credentialed", skip this check, and still be
    // authenticated by the victim's cookie.
    if (!cookieToken(request) && !isAmbientCredential(request)) return true;
    return isSameOrigin(request, originFor(request));
  }

  async function authed(request, reply, { mutating = true } = {}) {
    // Resolve first so an anonymous caller gets a 401 rather than a
    // confusing 403; nothing is acted on before the CSRF check below.
    const { agent, ambient } = await resolveAgentFull(request);
    if (!agent) { err(reply, 401, 'authentication required'); return null; }
    if (mutating && ambient && !isSameOrigin(request, originFor(request))) {
      err(reply, 403, 'cross-origin request refused — this endpoint is same-origin only');
      return null;
    }
    if (state.ledger[agent] && state.ledger[agent].frozen) {
      err(reply, 403, 'this account is frozen; contact the operator');
      return null;
    }
    return agent;
  }

  /** Grant the signup credits the first time we ever see an agent. */
  function ensureAccount(agent) {
    const row = state.ledger[agent];
    if (row && row.created) return row;
    store.commit({ type: 'grant', agent, amountMicro: grantMicro });
    api.log.info(`markets: granted ${grantMicro / MICRO} credits to ${agent}`);
    return state.ledger[agent];
  }

  const balanceOf = (agent) => (state.ledger[agent] ? state.ledger[agent].balanceMicro : 0);

  // ------------------------------------------------- rate limit + CORS
  //
  // FINDING: hooks added via api.fastify are NOT scoped to the plugin's
  // own routes — they run for EVERY request the server handles, including
  // other plugins' and core's. An unguarded rate-limit hook here 429'd
  // the metrics and dashboard plugins in the compose suite. Every hook
  // below therefore gates on `mine(request)` first. (metrics/ hit the
  // same edge from the other side and documented it as "scope: all
  // plugins, never core".)
  const mine = (request) => {
    const u = request.url;
    return u === prefix || u.startsWith(`${prefix}/`) || u.startsWith(`${prefix}?`);
  };

  api.fastify.addHook('onRequest', async (request, reply) => {
    if (!mine(request)) return undefined;
    const key = liveSession(cookieToken(request) || '') || request.ip;
    const cost = request.method === 'GET' || request.method === 'HEAD' ? 1 : 4;
    const waitMs = limiter.take(key, cost);
    if (waitMs) {
      return reply.code(429)
        .header('retry-after', Math.ceil(waitMs / 1000))
        .send({ error: 'rate limit exceeded — slow down' });
    }
    return undefined;
  });

  // The host reflects arbitrary Origins with Allow-Credentials on its LDP
  // routes; those defaults must not apply to money endpoints. Pin ACAO to
  // our own origin and drop credential sharing entirely.
  api.fastify.addHook('onSend', async (request, reply, payload) => {
    if (!mine(request)) return payload;
    const origin = ownOrigin();
    reply.header('access-control-allow-origin', origin || 'null');
    reply.removeHeader('access-control-allow-credentials');
    if (request.url.startsWith(`${prefix}/api`)) {
      for (const [k, v] of Object.entries(API_HEADERS)) reply.header(k, v);
    }
    return payload;
  });

  // ------------------------------------------------------- projections
  const tradable = (m) => m.status === 'open' && Date.now() < m.closesAt;
  const displayStatus = (m) => (m.status === 'open' && !tradable(m) ? 'closed' : m.status);

  function positionOut(m, pos) {
    const prices = lmsrPrices(m.q, m.bMicro);
    const shares = pos.shares.map((s) => s / MICRO);
    const cost = pos.costMicro.map((c) => c / MICRO);
    // Value a live position at what the AMM would actually pay to close
    // it (proceeds net of fee), not at mark — "cash out" must not quote a
    // number the sell path won't honour.
    const value = pos.shares.map((s, i) => (s > 0 ? sellQuote(m, i, s).totalMicro / MICRO : 0));
    const totalValue = value.reduce((a, x) => a + x, 0);
    const totalCost = cost.reduce((a, x) => a + x, 0);
    return {
      shares,
      cost,
      prices: prices.map((p) => Number(p.toFixed(6))),
      value,
      totalCost: Number(totalCost.toFixed(6)),
      totalValue: Number(totalValue.toFixed(6)),
      unrealizedPnl: Number((totalValue - totalCost).toFixed(6)),
    };
  }

  function marketOut(m, { agent = null, history = false } = {}) {
    const prices = lmsrPrices(m.q, m.bMicro);
    const out = {
      id: m.id,
      title: m.title,
      description: m.description,
      category: m.category || null,
      outcomes: m.outcomes,
      prices: prices.map((p) => Number(p.toFixed(6))),
      status: displayStatus(m),
      // The RAW lifecycle state, distinct from the display status: a
      // market past closesAt displays as 'closed' while its raw status is
      // still 'open', and that is exactly when the oracle must resolve.
      // Without this a client can't tell "closed, awaiting resolution"
      // from "settled", and hides the resolve controls at the only moment
      // they matter.
      rawStatus: m.status,
      tradable: tradable(m),
      canResolve: m.status === 'open',
      canVoid: m.status === 'open' && !tradable(m),
      closesAt: new Date(m.closesAt).toISOString(),
      createdAt: m.createdAt,
      creator: m.creator,
      oracle: m.oracle,
      b: m.bMicro / MICRO,
      volume: m.volumeMicro / MICRO,
      fees: m.feesMicro / MICRO,
      trades: m.trades,
      liquidity: (m.subsidyMicro + m.collectedMicro) / MICRO,
      resolvedOutcome: m.resolvedOutcome ?? null,
      settleAt: m.settleAt ? new Date(m.settleAt).toISOString() : null,
      resolvedAt: m.resolvedAt ?? null,
      settledPrices: m.settledPrices ?? null,
      disputes: (m.disputes || []).length,
      hidden: !!m.hidden,
    };
    if (agent && m.positions[agent]) out.position = positionOut(m, m.positions[agent]);
    if (history) out.history = m.history.map((h) => ({ t: h.t, p: h.p.map((x) => Number(x.toFixed(6))) }));
    return out;
  }

  // ------------------------------------------------------------ pricing
  function buyQuote(m, i, sharesMicro) {
    const costMicro = Math.ceil(tradeCostRaw(m.q, m.bMicro, i, sharesMicro));
    const feeMicro = Math.ceil((costMicro * feeBps) / 10_000);
    return { sharesMicro, costMicro, feeMicro, totalMicro: costMicro + feeMicro };
  }

  function sellQuote(m, i, sharesMicro) {
    const proceedsMicro = Math.floor(-tradeCostRaw(m.q, m.bMicro, i, -sharesMicro));
    const feeMicro = Math.ceil((proceedsMicro * feeBps) / 10_000);
    return { sharesMicro, proceedsMicro, feeMicro, totalMicro: proceedsMicro - feeMicro };
  }

  /** Validate a trade request into micro units. Returns { error } or the
   *  priced trade. `spend` is the stake-first path: how many shares does
   *  this many credits buy? (Consumers think in stakes, not shares.) */
  function priceTrade(m, side, outcomeRaw, sharesRaw, spendRaw) {
    const outcome = Number(outcomeRaw);
    if (!Number.isInteger(outcome) || outcome < 0 || outcome >= m.outcomes.length) {
      return { error: 'outcome must be a valid outcome index' };
    }
    if (side !== 'buy' && side !== 'sell') return { error: "side must be 'buy' or 'sell'" };

    let sharesMicro;
    if (spendRaw !== undefined && spendRaw !== null && spendRaw !== '') {
      if (side !== 'buy') return { error: 'spend is only meaningful for a buy' };
      const spend = Number(spendRaw);
      if (!Number.isFinite(spend) || spend <= 0) return { error: 'spend must be a positive number of credits' };
      const budget = Math.floor(spend * MICRO);
      sharesMicro = sharesForBudget(m.q, m.bMicro, outcome, budget,
        (x) => buyQuote(m, outcome, x).totalMicro, LIMITS.maxTradeShares * MICRO);
      if (sharesMicro <= 0) return { error: 'that stake is too small to buy any shares' };
    } else {
      const shares = Number(sharesRaw);
      if (!Number.isFinite(shares) || shares <= 0 || shares > LIMITS.maxTradeShares) {
        return { error: `shares must be > 0 and ≤ ${LIMITS.maxTradeShares}` };
      }
      sharesMicro = Math.round(shares * MICRO);
      if (sharesMicro <= 0) return { error: 'shares too small (min 0.000001)' };
    }

    const t = side === 'buy' ? buyQuote(m, outcome, sharesMicro) : sellQuote(m, outcome, sharesMicro);
    return { ...t, outcome, side };
  }

  /** The consumer-facing framing: stake in, payout out, decimal odds. */
  function quoteOut(m, t) {
    const shares = t.sharesMicro / MICRO;
    const stake = t.totalMicro / MICRO;
    const base = {
      side: t.side,
      outcome: t.outcome,
      outcomeLabel: m.outcomes[t.outcome],
      shares: Number(shares.toFixed(6)),
      fee: Number((t.feeMicro / MICRO).toFixed(6)),
      total: Number(stake.toFixed(6)),
    };
    if (t.side === 'buy') {
      base.cost = Number((t.costMicro / MICRO).toFixed(6));
      base.toWin = Number(shares.toFixed(6));            // a winning share pays 1 credit
      base.profit = Number((shares - stake).toFixed(6));
      base.avgPrice = shares > 0 ? Number((stake / shares).toFixed(6)) : null;
      base.odds = stake > 0 ? Number((shares / stake).toFixed(3)) : null; // decimal odds
    } else {
      base.proceeds = Number((t.proceedsMicro / MICRO).toFixed(6));
      base.avgPrice = shares > 0 ? Number((stake / shares).toFixed(6)) : null;
    }
    return base;
  }

  // ----------------------------------------------------------- lifecycle
  // The settlement state machine lives in lifecycle.js — see that file
  // for why it is not inline here (a state change that skipped the
  // reducer made the audit trail contradict the money).
  const {
    voidPrices, settleResolved, settleVoid, tick, tickOne, maybeTick, disputeDeadline,
  } = createLifecycle({
    state,
    commit: store.commit,
    broadcast: (type, m) => broadcast(type, m),
    log: api.log,
    cfg: { twapWindowMs, houseFeeShareBps, settlementWindowMs, disputeGraceMs, HOUSE },
  });

  // --------------------------------------------------------- websocket
  const sockets = new Set();
  const perIp = new Map();
  await api.ws.route(`${prefix}/ws`, (socket, request) => {
    // Reject cross-origin upgrades: public data today, but an unchecked
    // origin makes any future per-agent field on the wire a leak.
    const wsOrigin = request.headers && request.headers.origin;
    if (wsOrigin && !isSameOrigin({ headers: { origin: wsOrigin } }, originFor(request))) {
      try { socket.close(1008, 'cross-origin'); } catch { /* gone */ }
      return;
    }
    const ip = request.socket ? request.socket.remoteAddress : 'unknown';
    const n = perIp.get(ip) || 0;
    if (sockets.size >= LIMITS.maxSockets || n >= LIMITS.maxSocketsPerIp) {
      try { socket.close(1013, 'too many connections'); } catch { /* gone */ }
      return;
    }
    // A live price feed is public (prices are public), but an unbounded,
    // never-reaped socket set is a memory DoS — hence the caps, the idle
    // reaper below, and the backpressure check in broadcast().
    perIp.set(ip, n + 1);
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    const drop = () => {
      sockets.delete(socket);
      const c = (perIp.get(ip) || 1) - 1;
      if (c <= 0) perIp.delete(ip); else perIp.set(ip, c);
    };
    socket.on('close', drop);
    socket.on('error', drop);
    sockets.add(socket);
  });

  const reaper = setInterval(() => {
    for (const s of sockets) {
      if (!s.isAlive) { try { s.terminate ? s.terminate() : s.close(); } catch { /* gone */ } continue; }
      s.isAlive = false;
      try { s.ping ? s.ping() : null; } catch { /* gone */ }
    }
  }, 30_000);
  reaper.unref?.();

  const ticker = setInterval(tick, 15_000);
  ticker.unref?.();

  function broadcast(type, m) {
    // A withdrawn market must not push its title and description to
    // every connected client when it settles.
    if (m.hidden) return;
    const msg = JSON.stringify({ type, market: marketOut(m) });
    for (const s of sockets) {
      // Drop a client that isn't draining rather than buffering without
      // bound on its behalf.
      if (s.bufferedAmount > LIMITS.wsBufferBytes) { try { s.close(1013, 'too slow'); } catch { /* gone */ } continue; }
      try { s.send(msg); } catch { /* dead socket; close event reaps it */ }
    }
  }

  // ------------------------------------------------------- idempotency
  // A retried trade (double-click, network timeout) must not execute
  // twice. Keyed by agent + Idempotency-Key; the original response is
  // replayed verbatim.
  const idem = new Map();
  const fingerprint = (request) => crypto.createHash('sha256')
    .update(`${request.method} ${request.url} ${JSON.stringify(request.body || {})}`)
    .digest('hex');

  /** @returns {{code,body}|'conflict'|null} */
  function idemGet(agent, key, fp) {
    if (!key) return null;
    const hit = idem.get(`${agent} ${key}`);
    if (!hit) return null;
    if (Date.now() - hit.at > LIMITS.idempotencyTtlMs) { idem.delete(`${agent} ${key}`); return null; }
    // A key reused for a DIFFERENT request is an error, never a replay:
    // otherwise a client deriving keys per session or per market silently
    // loses trades and is told they succeeded.
    if (hit.fp !== fp) return 'conflict';
    return hit;
  }
  function idemPut(agent, key, code, body, fp) {
    if (!key) return;
    if (idem.size >= LIMITS.maxIdempotencyKeys) {
      for (const k of idem.keys()) { idem.delete(k); if (idem.size < LIMITS.maxIdempotencyKeys * 0.9) break; }
    }
    idem.set(`${agent} ${key}`, { at: Date.now(), code, body, fp });
  }
  const idemKey = (request) => {
    const k = request.headers['idempotency-key'];
    return typeof k === 'string' && k.length <= 128 ? k : null;
  };

  // ============================================================ routes
  const jsonOpts = (bodyLimit) => ({ bodyLimit });

  // ---- session: exchange a pod bearer for a scoped, expiring token ----
  // The browser never stores the pod bearer (see guard.js): it posts it
  // once and gets an HttpOnly cookie scoped to this plugin.
  api.fastify.post(`${prefix}/api/session`, jsonOpts(2048), async (request, reply) => {
    if (!csrfOk(request)) return err(reply, 403, 'cross-origin request refused');
    const agent = await api.auth.getAgent(request);
    if (!agent) return err(reply, 401, 'a pod bearer token is required to start a session');
    ensureAccount(agent);
    const token = sessions.mint(agent, state.ledger[agent].epoch || 0);
    const secure = (ownOrigin() || '').startsWith('https:') ? ' Secure;' : '';
    reply.header('set-cookie',
      `${cookieName}=${encodeURIComponent(token)}; Path=${prefix}; HttpOnly; SameSite=Strict;${secure} Max-Age=${Math.floor(sessionTtlMs / 1000)}`);
    return reply.send({ agent, expiresIn: Math.floor(sessionTtlMs / 1000), balance: balanceOf(agent) / MICRO });
  });

  api.fastify.delete(`${prefix}/api/session`, async (request, reply) => {
    if (!csrfOk(request)) return err(reply, 403, 'cross-origin request refused');
    // Clearing the cookie is cosmetic on its own — the token is
    // self-verifying, so a captured copy still worked for the full TTL.
    // Bump the epoch so every token minted before now stops verifying.
    const who = await resolveAgent(request);
    if (who && state.ledger[who]) store.commit({ type: 'session.revoke', agent: who });
    reply.header('set-cookie', `${cookieName}=; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=0`);
    return reply.send({ ok: true });
  });

  // ---- me: balance, positions (O(your markets)), settlement receipts ---
  api.fastify.get(`${prefix}/api/me`, async (request, reply) => {
    const agent = await authed(request, reply, { mutating: false });
    if (!agent) return reply;
    ensureAccount(agent);
    maybeTick();
    const positions = [];
    for (const id of byAgent.get(agent) || []) {
      const m = state.markets[id];
      if (!m) continue;
      if (m.status === 'resolved' || m.status === 'void') continue; // paid out; the receipt is the record
      const pos = m.positions[agent];
      if (!pos || pos.shares.every((s) => s === 0)) continue;
      positions.push({
        market: m.id,
        title: m.title,
        status: displayStatus(m),
        tradable: tradable(m),
        outcomes: m.outcomes,
        closesAt: new Date(m.closesAt).toISOString(),
        ...positionOut(m, pos),
      });
    }
    const settlements = (state.settlements[agent] || []).slice(-25).reverse()
      .map((s) => {
        // The receipt records an outcome INDEX; a bettor needs the name.
        const mk = state.markets[s.market];
        return {
          ...s,
          outcomeLabel: mk && s.outcome != null ? mk.outcomes[s.outcome] : null,
          payout: s.payout / MICRO,
          cost: (s.cost || 0) / MICRO,
          net: (s.payout - (s.cost || 0)) / MICRO,
          at: new Date(s.at).toISOString(),
        };
      });
    return reply.send({
      agent,
      balance: balanceOf(agent) / MICRO,
      isAdmin: admins.has(agent),
      positions,
      settlements,
    });
  });

  // ---- create ---------------------------------------------------------
  api.fastify.post(`${prefix}/api/markets`, jsonOpts(8192), async (request, reply) => {
    const agent = await authed(request, reply);
    if (!agent) return reply;
    const key = idemKey(request);
    const fp = key ? fingerprint(request) : null;
    const prior = idemGet(agent, key, fp);
    if (prior === 'conflict') return err(reply, 409, 'this Idempotency-Key was already used for a different request');
    if (prior) return reply.code(prior.code).send(prior.body);

    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > LIMITS.titleLen) {
      return err(reply, 400, `title required, ≤ ${LIMITS.titleLen} chars`);
    }
    const description = typeof body.description === 'string' ? body.description.slice(0, LIMITS.descriptionLen) : '';
    const category = typeof body.category === 'string' ? body.category.trim().slice(0, LIMITS.categoryLen) : '';

    // Length is checked BEFORE mapping: a 600k-element array must not be
    // materialised just to be rejected.
    if (!Array.isArray(body.outcomes)
        || body.outcomes.length < LIMITS.outcomesMin || body.outcomes.length > LIMITS.outcomesMax) {
      return err(reply, 400, `outcomes must be ${LIMITS.outcomesMin}..${LIMITS.outcomesMax} labels`);
    }
    const outcomes = body.outcomes.map((o) => (typeof o === 'string' ? o.trim() : ''));
    if (outcomes.some((o) => !o || o.length > LIMITS.outcomeLabelLen) || new Set(outcomes).size !== outcomes.length) {
      return err(reply, 400, `outcomes must be distinct non-empty labels ≤ ${LIMITS.outcomeLabelLen} chars`);
    }

    const closesAt = Date.parse(body.closesAt || '');
    const now = Date.now();
    if (!Number.isFinite(closesAt) || closesAt <= now || closesAt > now + LIMITS.maxHorizonMs) {
      return err(reply, 400, 'closesAt must be a future ISO timestamp within 5 years');
    }
    const b = num(body.b, 100);
    if (!Number.isFinite(b) || b < LIMITS.bMinCredits || b > LIMITS.bMaxCredits) {
      return err(reply, 400, `b (liquidity, credits) must be ${LIMITS.bMinCredits}..${LIMITS.bMaxCredits}`);
    }
    // An oracle that isn't a resolvable agent id is an unsatisfiable
    // settlement condition — the funds would only ever exit via the
    // auto-void backstop. Refuse the typo instead.
    const oracle = body.oracle === undefined || body.oracle === '' ? agent : body.oracle;
    if (!isAgentId(oracle)) return err(reply, 400, 'oracle must be a WebID (http/https) or a did: identifier');

    // Count only LIVE markets: counting settled ones would make the cap
    // a permanent ceiling on markets ever created, not on markets open.
    const live = Object.values(state.markets).filter((x) => x.status !== 'resolved' && x.status !== 'void');
    if (live.length >= LIMITS.maxMarkets) return err(reply, 503, 'too many open markets; try again later');
    const ownLive = live.filter((x) => x.creator === agent).length;
    if (ownLive >= LIMITS.maxMarketsPerAgent) {
      return err(reply, 429, `you already have ${ownLive} unsettled markets (max ${LIMITS.maxMarketsPerAgent})`);
    }

    const bMicro = Math.round(b * MICRO);
    const subsidyMicro = Math.ceil(bMicro * Math.log(outcomes.length));
    ensureAccount(agent);
    if (balanceOf(agent) < subsidyMicro) {
      return err(reply, 402, `creating this market escrows b·ln(n) = ${(subsidyMicro / MICRO).toFixed(2)} credits; you have ${(balanceOf(agent) / MICRO).toFixed(2)}`);
    }

    let id = randomId();
    while (state.markets[id]) id = randomId();
    store.commit({
      type: 'market.create',
      seedPrices: uniformPrices(outcomes.length),
      market: {
        id,
        title,
        description,
        category,
        outcomes,
        creator: agent,
        oracle,
        createdAt: new Date(now).toISOString(),
        closesAt,
        closedAt: null,
        status: 'open',
        bMicro,
        q: outcomes.map(() => 0),
        subsidyMicro,
        collectedMicro: 0,
        feesMicro: 0,
        volumeMicro: 0,
        trades: 0,
        positions: {},
        history: [],
        disputes: [],
        hidden: false,
      },
    });
    const m = state.markets[id];
    api.log.info(`markets: ${agent} created ${id} "${title}" (${outcomes.length} outcomes, b=${b})`);
    broadcast('market', m);
    const out = marketOut(m, { agent });
    idemPut(agent, key, 201, out, fp);
    return reply.code(201).send(out);
  });

  // ---- list: cursor pagination + filters ------------------------------
  api.fastify.get(`${prefix}/api/markets`, async (request, reply) => {
    maybeTick();
    const q = request.query || {};
    const limit = Math.min(LIMITS.listLimitMax, Math.max(1, Number(q.limit) || LIMITS.listLimit));
    const wanted = typeof q.status === 'string' ? q.status : '';
    const category = typeof q.category === 'string' ? q.category.toLowerCase() : '';
    const search = typeof q.q === 'string' ? q.q.toLowerCase().slice(0, 100) : '';
    const creator = typeof q.creator === 'string' ? q.creator : '';

    let all = Object.values(state.markets).filter((m) => !m.hidden);
    if (creator) all = all.filter((m) => m.creator === creator);
    if (category) all = all.filter((m) => (m.category || '').toLowerCase() === category);
    if (search) all = all.filter((m) => m.title.toLowerCase().includes(search)
      || (m.description || '').toLowerCase().includes(search));
    if (wanted === 'open') all = all.filter((m) => tradable(m));
    else if (wanted === 'closed') {
      all = all.filter((m) => !tradable(m)
        && ['open', 'resolving', 'voiding', 'disputed'].includes(m.status));
    }
    else if (wanted === 'settled') all = all.filter((m) => m.status === 'resolved' || m.status === 'void');

    // Deterministic total order (createdAt desc, id desc) so the cursor
    // is stable across pages even as markets are created.
    all.sort((a, x) => x.createdAt.localeCompare(a.createdAt) || x.id.localeCompare(a.id));
    const cursor = typeof q.cursor === 'string' ? q.cursor : '';
    let start = 0;
    if (cursor) {
      const idx = all.findIndex((m) => `${m.createdAt}|${m.id}` === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = all.slice(start, start + limit);
    const last = page[page.length - 1];
    return reply.send({
      markets: page.map((m) => marketOut(m)),
      total: all.length,
      nextCursor: start + limit < all.length && last ? `${last.createdAt}|${last.id}` : null,
    });
  });

  api.fastify.get(`${prefix}/api/markets/:id`, async (request, reply) => {
    maybeTick();
    const m = state.markets[request.params.id];
    if (!m) return err(reply, 404, 'no such market');
    const agent = await resolveAgent(request);
    // Withdrawn means withdrawn: leaving the title and description served
    // at a stable URL is not takedown. Holders and operators can still
    // see it, so positions remain settleable.
    if (m.hidden && !admins.has(agent) && !m.positions[agent]) {
      return err(reply, 451, 'this market has been withdrawn by the operator');
    }
    return reply.send(marketOut(m, { agent, history: true }));
  });

  // ---- quote: stake-first (spend) or share-first ----------------------
  api.fastify.get(`${prefix}/api/markets/:id/quote`, async (request, reply) => {
    const m = state.markets[request.params.id];
    if (!m) return err(reply, 404, 'no such market');
    if (m.hidden) return err(reply, 451, 'this market has been withdrawn by the operator');
    const q = request.query || {};
    const t = priceTrade(m, q.side, q.outcome, q.shares, q.spend);
    if (t.error) return err(reply, 400, t.error);
    return reply.send({ ...quoteOut(m, t), tradable: tradable(m) });
  });

  // ---- trade ----------------------------------------------------------
  api.fastify.post(`${prefix}/api/markets/:id/trade`, jsonOpts(2048), async (request, reply) => {
    const agent = await authed(request, reply);
    if (!agent) return reply;
    const key = idemKey(request);
    const fp = key ? fingerprint(request) : null;
    const prior = idemGet(agent, key, fp);
    if (prior === 'conflict') return err(reply, 409, 'this Idempotency-Key was already used for a different request');
    if (prior) return reply.code(prior.code).send(prior.body);

    // From here to store.commit() there is NO await — the atomicity
    // contract (see header). Do not introduce one.
    const m = state.markets[request.params.id];
    if (!m) return err(reply, 404, 'no such market');
    // A hidden market must be UNTRADABLE, not merely unlisted: takedown
    // that leaves the URL working is not takedown.
    if (m.hidden) return err(reply, 403, 'this market has been withdrawn by the operator');
    if (!tradable(m)) return err(reply, 409, `market is ${displayStatus(m)} — trading has stopped`);
    if (!allowInsiderTrading && (agent === m.oracle || agent === m.creator)) {
      return err(reply, 403, 'the creator and oracle of a market may not trade in it');
    }

    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const t = priceTrade(m, body.side, body.outcome, body.shares, body.spend);
    if (t.error) return err(reply, 400, t.error);

    // A guard that is present but unparseable must FAIL the request, not
    // be silently skipped: NaN comparisons are always false, so the old
    // code executed unguarded while the client believed it was protected.
    for (const g of ['maxCost', 'minProceeds']) {
      if (body[g] !== undefined && !Number.isFinite(Number(body[g]))) {
        return err(reply, 400, `${g} must be a finite number of credits when supplied`);
      }
    }

    ensureAccount(agent);
    const pos = m.positions[agent];
    if (t.side === 'buy') {
      if (body.maxCost !== undefined && t.totalMicro > Math.round(Number(body.maxCost) * MICRO)) {
        return err(reply, 409, `cost ${(t.totalMicro / MICRO).toFixed(6)} exceeds maxCost — price moved`,
          { quote: quoteOut(m, t) });
      }
      if (balanceOf(agent) < t.totalMicro) {
        return err(reply, 402, `insufficient balance: need ${(t.totalMicro / MICRO).toFixed(6)}, have ${(balanceOf(agent) / MICRO).toFixed(6)}`);
      }
    } else {
      const held = pos ? pos.shares[t.outcome] : 0;
      if (held < t.sharesMicro) {
        return err(reply, 409, `you hold ${(held / MICRO).toFixed(6)} shares of that outcome — no short selling`);
      }
      if (body.minProceeds !== undefined && t.totalMicro < Math.round(Number(body.minProceeds) * MICRO)) {
        return err(reply, 409, `proceeds ${(t.totalMicro / MICRO).toFixed(6)} below minProceeds — price moved`,
          { quote: quoteOut(m, t) });
      }
    }

    // The post-trade price vector, computed here and journalled, so
    // replay never has to recompute a float (see store.js).
    const qAfter = m.q.slice();
    qAfter[t.outcome] += t.side === 'buy' ? t.sharesMicro : -t.sharesMicro;
    store.commit({
      type: 'trade',
      marketId: m.id,
      agent,
      pricesAfter: lmsrPrices(qAfter, m.bMicro),
      side: t.side,
      outcome: t.outcome,
      sharesMicro: t.sharesMicro,
      costMicro: t.costMicro ?? 0,
      proceedsMicro: t.proceedsMicro ?? 0,
      feeMicro: t.feeMicro,
      totalMicro: t.totalMicro,
    });
    indexPosition(agent, m.id);
    broadcast('trade', m);
    const out = {
      ok: true,
      ...quoteOut(m, t),
      balance: balanceOf(agent) / MICRO,
      market: marketOut(m, { agent }),
    };
    idemPut(agent, key, 200, out, fp);
    return reply.send(out);
  });

  // ---- trade feed & price history -------------------------------------
  api.fastify.get(`${prefix}/api/markets/:id/history`, async (request, reply) => {
    const m = state.markets[request.params.id];
    if (!m) return err(reply, 404, 'no such market');
    if (m.hidden) return err(reply, 451, 'this market has been withdrawn by the operator');
    return reply.send({
      id: m.id,
      outcomes: m.outcomes,
      history: m.history.map((h) => ({ t: h.t, p: h.p.map((x) => Number(x.toFixed(6))) })),
    });
  });

  // ---- oracle & lifecycle ---------------------------------------------
  async function oracleMarket(request, reply) {
    const agent = await authed(request, reply);
    if (!agent) return null;
    const m = state.markets[request.params.id];
    if (!m) { err(reply, 404, 'no such market'); return null; }
    if (agent !== m.oracle && !admins.has(agent)) { err(reply, 403, 'only the market oracle may do this'); return null; }
    return { m, agent };
  }

  api.fastify.post(`${prefix}/api/markets/:id/close`, jsonOpts(512), async (request, reply) => {
    const ctx = await oracleMarket(request, reply);
    if (!ctx) return reply;
    const { m } = ctx;
    if (m.status !== 'open') return err(reply, 409, `market is ${m.status}`);
    store.commit({ type: 'market.close', marketId: m.id });
    broadcast('market', m);
    return reply.send(marketOut(m));
  });

  // resolve declares the outcome and opens the DISPUTE WINDOW; payout
  // happens at settleAt (or via /settle once it passes).
  api.fastify.post(`${prefix}/api/markets/:id/resolve`, jsonOpts(512), async (request, reply) => {
    const ctx = await oracleMarket(request, reply);
    if (!ctx) return reply;
    const { m, agent } = ctx;
    if (m.status !== 'open') return err(reply, 409, `market is ${m.status}`);
    const outcome = (request.body || {}).outcome;
    if (!Number.isInteger(outcome) || outcome < 0 || outcome >= m.outcomes.length) {
      return err(reply, 400, 'outcome must be a valid outcome index');
    }
    store.commit({
      type: 'market.resolve', marketId: m.id, agent, outcome, settleAt: Date.now() + disputeWindowMs,
    });
    api.log.info(`markets: ${m.id} resolving → ${m.outcomes[outcome]} (settles in ${disputeWindowMs}ms)`);
    broadcast('market', m);
    return reply.send(marketOut(m));
  });

  // Anyone may push a due settlement through — settlement must not depend
  // on the oracle staying online.
  api.fastify.post(`${prefix}/api/markets/:id/settle`, jsonOpts(512), async (request, reply) => {
    const m = state.markets[request.params.id];
    if (!m) return err(reply, 404, 'no such market');
    // Advance THIS market only: a full scan here was a free O(all
    // markets) job for any anonymous caller, and throttling it instead
    // turned an explicit "settle now" into a silent no-op.
    try {
      tickOne(m);
    } catch (e) {
      api.log.error(`markets: ${m.id} cannot settle: ${e.message}`);
      return err(reply, 503, `this market cannot be settled automatically and needs an operator: ${e.message}`);
    }
    if (m.status === 'resolved' || m.status === 'void') return reply.send(marketOut(m));
    if (m.status === 'resolving' || m.status === 'voiding') {
      return err(reply, 409, `settles at ${new Date(m.settleAt).toISOString()} (dispute window open)`);
    }
    return err(reply, 409, `market is ${displayStatus(m)} — nothing to settle`);
  });

  // A holder can park a resolution they believe is wrong, at the cost of
  // a bond. An operator adjudicates; if none does before the grace
  // expires the resolution stands and the bond is forfeited, because a
  // dispute that cancels the market for free is just a refund button.
  api.fastify.post(`${prefix}/api/markets/:id/dispute`, jsonOpts(1024), async (request, reply) => {
    const agent = await authed(request, reply);
    if (!agent) return reply;
    const m = state.markets[request.params.id];
    if (!m) return err(reply, 404, 'no such market');
    // 'disputed' is disputable too: latching on the FIRST disputer meant
    // one person paid the bond and every other loser free-rode on the
    // resulting void. Each disputer posts their own.
    try {
      tickOne(m); // otherwise a market past settleAt is still 'resolving' here
    } catch (e) {
      api.log.error(`markets: ${m.id} cannot settle: ${e.message}`);
    }
    if (m.status !== 'resolving' && m.status !== 'disputed' && m.status !== 'voiding') {
      return err(reply, 409, 'only a resolving market can be disputed');
    }
    const pos = m.positions[agent];
    if (!pos || pos.shares.every((s) => s === 0)) return err(reply, 403, 'only a holder may dispute');
    if ((m.disputes || []).some((d) => d.agent === agent)) {
      return err(reply, 409, 'you have already disputed this market');
    }
    const reason = typeof (request.body || {}).reason === 'string'
      ? request.body.reason.slice(0, 500) : '';
    if (!reason.trim()) return err(reply, 400, 'a reason is required to dispute');
    // With no operator configured, `sustained` can never become true, so
    // the bond is mathematically unrecoverable. Don't take it.
    if (!admins.size) {
      return err(reply, 409, 'this deployment has no operator to adjudicate disputes, so a dispute bond could never be returned');
    }
    ensureAccount(agent);
    // Scale with what the dispute puts at risk. A flat bond against a
    // large position is trivially +EV to post: the disputer risks 25 to
    // reclaim hundreds.
    const atRisk = pos.costMicro.reduce((a, x) => a + x, 0);
    const bondMicro = Math.max(disputeBondMicro, Math.ceil(atRisk * disputeBondBps / 10_000));
    if (balanceOf(agent) < bondMicro) {
      return err(reply, 402, `disputing this market stakes a bond of ${(bondMicro / MICRO).toFixed(2)} credits, forfeited unless the operator sustains your dispute`);
    }
    store.commit({ type: 'market.dispute', marketId: m.id, agent, reason, bondMicro });
    api.log.warn(`markets: ${m.id} disputed by ${agent}: ${reason}`);
    broadcast('market', m);
    return reply.send(marketOut(m));
  });

  api.fastify.post(`${prefix}/api/markets/:id/void`, jsonOpts(512), async (request, reply) => {
    const agent = await authed(request, reply);
    if (!agent) return reply;
    const m = state.markets[request.params.id];
    if (!m) return err(reply, 404, 'no such market');
    // Only an ABANDONED market qualifies for the anyone-can-rescue
    // backstop: resolving/voiding/disputed all mean the oracle acted and
    // a settlement is already pending.
    const stale = m.status === 'open' && Date.now() >= m.closesAt + settlementWindowMs;
    if (m.status === 'resolved' || m.status === 'void') return err(reply, 409, `market is ${m.status}`);
    if (m.status === 'resolving' && !admins.has(agent)) {
      return err(reply, 409, 'this market has a resolution pending — only the operator can turn that into a void');
    }
    if (m.status === 'voiding' && !admins.has(agent) && !stale) {
      return err(reply, 409, `a void is already proposed; it settles at ${new Date(m.settleAt).toISOString()}`);
    }
    // Once disputed, ONLY an admin may settle. Otherwise the oracle
    // answers a dispute against itself by voiding the market, and the
    // dispute is no check on the oracle at all.
    if (m.status === 'disputed' && !admins.has(agent)) {
      return err(reply, 403, 'this market is under dispute; only the operator may settle it');
    }
    // The oracle/admin may void a market that has stopped trading; ANYONE
    // may void one whose oracle went missing past the settlement window.
    if (!(admins.has(agent) || stale || (agent === m.oracle && !tradable(m)))) {
      return err(reply, 403, tradable(m)
        ? 'close the market before voiding it — voiding live trading cancels everyone’s open bets'
        : 'only the oracle may void before the settlement window expires');
    }
    if (!m.closedAt) store.commit({ type: 'market.close', marketId: m.id });

    // An operator, or the anyone-can-rescue backstop, settles now.
    if (admins.has(agent) || stale) {
      settleVoid(m, admins.has(agent)
        ? { adjudicatedBy: agent, sustained: m.status === 'disputed' }
        : { abandoned: stale });
      api.log.info(`markets: ${m.id} voided (redeemed at TWAP)`);
      return reply.send(marketOut(m));
    }

    // An ORACLE void is only a proposal: it goes through the same
    // dispute window as a resolution, so holders can object before a
    // cancellation they can only lose on becomes final.
    store.commit({ type: 'market.propose-void', marketId: m.id, agent, settleAt: Date.now() + disputeWindowMs });
    api.log.info(`markets: ${m.id} void proposed by the oracle — settles after the dispute window`);
    broadcast('market', m);
    return reply.send(marketOut(m));
  });

  // ---- public stats & leaderboard -------------------------------------
  // Facet list for topic browsing — a news front page is organised by
  // subject, and the category field was display-only until now.
  api.fastify.get(`${prefix}/api/categories`, (request, reply) => {
    const counts = new Map();
    for (const m of Object.values(state.markets)) {
      const c = (m.category || '').trim();
      if (!c) continue;
      if (m.status === 'settled' || m.status === 'void') continue;
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    const categories = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, open]) => ({ name, open }));
    return reply.headers(API_HEADERS).send({ categories });
  });

  api.fastify.get(`${prefix}/api/stats`, async (request, reply) => {
    let totalMicro = 0;
    let accounts = 0;
    for (const r of Object.values(state.ledger)) { totalMicro += r.balanceMicro; accounts++; }
    let openPoolMicro = 0;
    let open = 0;
    for (const m of Object.values(state.markets)) {
      if (m.status === 'resolved' || m.status === 'void') continue;
      // Fees are held by the market until settlement too — an unsettled
      // market escrows subsidy + collected + fees, and all three are paid
      // out at settlement. Omitting fees here would make the conservation
      // figure drift by exactly the fee take.
      openPoolMicro += m.subsidyMicro + m.collectedMicro + m.feesMicro + (m.disputeBondMicro || 0);
      open++;
    }
    return reply.send({
      accounts,
      markets: Object.keys(state.markets).length,
      openMarkets: open,
      totalBalance: totalMicro / MICRO,
      escrowedInOpenMarkets: openPoolMicro / MICRO,
      // The conservation invariant, computable by anyone at any time.
      creditsInSystem: (totalMicro + openPoolMicro) / MICRO,
      journalSeq: state.seq,
      sockets: sockets.size,
    });
  });

  api.fastify.get(`${prefix}/api/leaderboard`, async (request, reply) => {
    // Balances are only exposed to signed-in participants: an anonymous
    // wealth ranking of WebIDs is both a privacy leak and the
    // reconnaissance step for targeting rich accounts.
    const agent = await resolveAgent(request);
    if (!agent) return err(reply, 401, 'sign in to see the leaderboard');
    // Rank by NET WORTH, not idle cash. Ranking on balance alone is
    // actively perverse on a prediction market: the sharpest forecaster,
    // with every credit deployed into positions, sorts to the bottom while
    // someone who never bets sits on top. Net worth = cash + mark-to-market
    // of open positions (a winning share redeems for exactly 1 credit, so
    // the LMSR price IS the market's value estimate) + subsidy still locked
    // in your unsettled creations (returned, capped, at settlement).
    const worth = new Map();
    const add = (a, m) => { if (a !== HOUSE) worth.set(a, (worth.get(a) || 0) + m); };
    for (const [a, row] of Object.entries(state.ledger)) add(a, row.balanceMicro);
    for (const m of Object.values(state.markets)) {
      if (m.status === 'settled' || m.status === 'void') continue;
      const px = lmsrPrices(m.q, m.b);
      for (const [holder, pos] of Object.entries(m.positions || {})) {
        for (let i = 0; i < pos.shares.length; i += 1) {
          if (pos.shares[i] > 0) add(holder, Math.floor(pos.shares[i] * px[i]));
        }
      }
      if (m.subsidyMicro) add(m.creator, m.subsidyMicro);
    }
    const top = [...worth.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMITS.leaderboard)
      .map(([a, netMicro], i) => ({
        rank: i + 1,
        agent: a === agent ? a : anonymize(a),
        you: a === agent,
        balance: (state.ledger[a]?.balanceMicro || 0) / MICRO, // cash, for continuity
        netWorth: netMicro / MICRO,
        profit: (netMicro - grantMicro) / MICRO, // vs the standard grant
      }));
    return reply.send({ leaderboard: top, grant: grantMicro / MICRO });
  });

  /** Stable pseudonym: a leaderboard should show a rival, not a dossier.
   *  SALTED with a per-deployment secret — an unsalted hash of a WebID is
   *  not a pseudonym at all, since anyone can hash a known WebID and
   *  unmask the row. */
  function anonymize(agentId) {
    return `anon-${crypto.createHmac('sha256', pseudonymSalt).update(agentId).digest('hex').slice(0, 8)}`;
  }

  // ---- admin ----------------------------------------------------------
  async function adminOnly(request, reply) {
    const agent = await authed(request, reply);
    if (!agent) return null;
    if (!admins.has(agent)) { err(reply, 403, 'operator only'); return null; }
    return agent;
  }

  api.fastify.post(`${prefix}/api/admin/freeze`, jsonOpts(1024), async (request, reply) => {
    const by = await adminOnly(request, reply);
    if (!by) return reply;
    const { agent, frozen } = request.body || {};
    if (!isAgentId(agent)) return err(reply, 400, 'agent must be an agent id');
    store.commit({ type: 'admin.freeze', agent, frozen: frozen !== false, by });
    api.log.warn(`markets: admin ${by} ${frozen !== false ? 'froze' : 'unfroze'} ${agent}`);
    return reply.send({ ok: true, agent, frozen: frozen !== false });
  });

  api.fastify.post(`${prefix}/api/admin/adjust`, jsonOpts(1024), async (request, reply) => {
    const by = await adminOnly(request, reply);
    if (!by) return reply;
    const { agent, credits, reason } = request.body || {};
    if (!isAgentId(agent)) return err(reply, 400, 'agent must be an agent id');
    const deltaMicro = Math.round(Number(credits) * MICRO);
    // 1e303 is "finite": rounding it into micros yields Infinity, which
    // journals as null and makes every later sum on that row NaN — and
    // the journal replays the corruption on every future boot.
    if (!Number.isFinite(Number(credits)) || !Number.isSafeInteger(deltaMicro)
        || Math.abs(Number(credits)) > LIMITS.maxAdjustCredits) {
      return err(reply, 400, `credits must be a number within ±${LIMITS.maxAdjustCredits}`);
    }
    if (typeof reason !== 'string' || !reason.trim()) return err(reply, 400, 'a reason is required (it is journalled)');
    store.commit({
      type: 'admin.adjust', agent, deltaMicro, reason: reason.slice(0, 200), by,
    });
    api.log.warn(`markets: admin ${by} adjusted ${agent} by ${credits}: ${reason}`);
    return reply.send({ ok: true, agent, balance: balanceOf(agent) / MICRO });
  });

  // The adjudication verb. Without it a dispute could only ever end in a
  // void, which makes disputing a free refund option on any lost bet:
  // every rational loser disputes, and correct resolutions never stand.
  api.fastify.post(`${prefix}/api/admin/adjudicate`, jsonOpts(1024), async (request, reply) => {
    const by = await adminOnly(request, reply);
    if (!by) return reply;
    const { market, uphold, outcome } = request.body || {};
    const m = state.markets[market];
    if (!m) return err(reply, 404, 'no such market');
    if (m.status !== 'disputed') return err(reply, 409, `market is ${displayStatus(m)}, not disputed`);
    const proposedVoid = m.proposal === 'void';
    try {
    if (uphold === true) {
      // Uphold whatever the oracle actually proposed — a void proposal
      // has no resolution to uphold.
      if (proposedVoid) settleVoid(m, { adjudicatedBy: by });
      else settleResolved(m, { adjudicatedBy: by });
    } else if (uphold === false && Number.isInteger(outcome)) {
      // RE-RESOLVE: the oracle got it wrong and we know the right answer.
      // Voiding would refund the loser and wipe out whoever was RIGHT, so
      // a correctable error needs its own verb.
      if (outcome < 0 || outcome >= m.outcomes.length) return err(reply, 400, 'outcome must be a valid outcome index');
      settleResolved(m, { adjudicatedBy: by, sustained: true, outcome });
    } else if (uphold === false) {
      if (proposedVoid) {
        return err(reply, 400, 'this market has a void proposed, not a resolution — supply an outcome to resolve it instead');
      }
      settleVoid(m, { adjudicatedBy: by, sustained: true });
    } else {
      return err(reply, 400, "uphold must be true (the oracle's call stands), or false with an outcome to re-resolve");
    }
    } catch (e) {
      // A settlement that cannot be computed must be a diagnosable 503,
      // not an unhandled 500 out of the operator's only remedy.
      api.log.error(`markets: ${m.id} adjudication failed: ${e.message}`);
      return err(reply, 503, `this market cannot be settled: ${e.message}`);
    }
    api.log.warn(`markets: admin ${by} adjudicated ${m.id}: ${uphold ? 'upheld' : (Number.isInteger(outcome) ? `re-resolved to ${outcome}` : 'voided')}`);
    return reply.send(marketOut(m));
  });

  // Disputes awaiting adjudication — the operator's work queue.
  api.fastify.get(`${prefix}/api/admin/disputes`, async (request, reply) => {
    const by = await adminOnly(request, reply);
    if (!by) return reply;
    const queue = Object.values(state.markets)
      .filter((m) => m.status === 'disputed')
      .sort((a, b) => (a.disputes[0]?.at || 0) - (b.disputes[0]?.at || 0))
      .slice(0, 200)
      .map((m) => ({
        ...marketOut(m),
        disputeDetail: (m.disputes || []).map((d) => ({
          agent: d.agent, reason: d.reason, at: new Date(d.at).toISOString(), bond: (d.bondMicro || 0) / MICRO,
        })),
        autoSettlesAt: new Date(disputeDeadline(m)).toISOString(),
      }));
    return reply.send({ disputes: queue });
  });

  // Everything an operator needs to answer "what happened to this
  // account?" — the journal, filtered, instead of grep on a server.
  api.fastify.get(`${prefix}/api/admin/agent`, async (request, reply) => {
    const by = await adminOnly(request, reply);
    if (!by) return reply;
    const who = (request.query || {}).agent;
    if (!isAgentId(who)) return err(reply, 400, 'agent must be an agent id');
    const row = state.ledger[who];
    return reply.send({
      agent: who,
      balance: row ? row.balanceMicro / MICRO : 0,
      frozen: !!(row && row.frozen),
      created: row ? row.created : null,
      history: store.eventsFor(who).map((e) => ({ ...e, t: new Date(e.t).toISOString() })),
    });
  });

  api.fastify.post(`${prefix}/api/admin/hide`, jsonOpts(1024), async (request, reply) => {
    const by = await adminOnly(request, reply);
    if (!by) return reply;
    const { market, hidden } = request.body || {};
    const m = state.markets[market];
    if (!m) return err(reply, 404, 'no such market');
    store.commit({ type: 'admin.hide', marketId: m.id, hidden: hidden !== false, by });
    api.log.warn(`markets: admin ${by} ${hidden !== false ? 'hid' : 'unhid'} market ${m.id}`);
    return reply.send({ ok: true, market: m.id, hidden: hidden !== false });
  });

  // ---------------------------------------------------------------- UI
  /** Public share view of a market, or null. */
  function shareOf(id) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(state.markets, id)) return null;
    const m = state.markets[id];
    return {
      id: m.id,
      title: m.title,
      category: m.category || '',
      status: displayStatus(m),
      closesAt: m.closesAt,
      outcomes: m.outcomes,
      prices: lmsrPrices(m.q, m.bMicro),
    };
  }
  const uiOpts = (market) => ({
    accounts: accountsUi, brand: cfg.brand, tagline: cfg.tagline,
    ogImage: cfg.ogImage, ogUrl: cfg.ogUrl, favicon: cfg.favicon, market,
  });

  const uiHandler = async (request, reply) => {
    for (const [k, v] of Object.entries(UI_HEADERS)) reply.header(k, v);
    return reply.header('content-type', 'text/html; charset=utf-8')
      .send(renderUi(prefix, uiOpts(shareOf(request.query && request.query.m))));
  };
  if (prefix) api.fastify.get(prefix, uiHandler); // '' would be an empty route path
  api.fastify.get(`${prefix}/`, uiHandler);

  // Share links: a market is the unit people actually send each other, but
  // the in-app router is hash-based and a fragment never reaches a server —
  // so every shared market unfurled as the generic site card. This path
  // route renders the same app with meta describing THAT market (question,
  // live odds, close time), and the client hands over to the hash router.
  api.fastify.get(`${prefix}/m/:id`, async (request, reply) => {
    for (const [k, v] of Object.entries(UI_HEADERS)) reply.header(k, v);
    return reply.header('content-type', 'text/html; charset=utf-8')
      .send(renderUi(prefix, uiOpts(shareOf(request.params.id))));
  });

  tick();
  const snap = setInterval(() => store.snapshot(), num(cfg.snapshotIntervalMs, 30_000));
  snap.unref?.();

  // A deployment with no admins can never adjudicate: every dispute
  // rides the grace timer and the oracle's resolution stands unchallenged.
  // That may be a deliberate choice for a demo, but it must not be a
  // silent one — the trust model advertises operator adjudication.
  if (!admins.size) {
    api.log.warn(
      'markets: no config.admins — nobody can adjudicate a dispute, so every dispute will expire '
      + 'into the oracle\'s resolution and forfeit the disputer\'s bond. Set config.admins for a '
      + 'deployment where disputes are meant to be a real check on the oracle.',
    );
  }

  api.log.info(
    `markets: LMSR prediction markets at ${prefix} — ${Object.keys(state.markets).length} market(s), `
    + `${Object.keys(state.ledger).length} account(s), grant ${grantMicro / MICRO}, fee ${feeBps}bps, `
    + `journal seq ${state.seq}${admins.size ? `, ${admins.size} admin(s)` : ', no admins configured'}`,
  );

  return {
    deactivate() {
      clearInterval(reaper);
      clearInterval(ticker);
      clearInterval(snap);
      for (const s of sockets) { try { s.close(); } catch { /* already gone */ } }
      sockets.clear();
      limiter.clear();
      store.close();
    },
  };
}

export default activate;
