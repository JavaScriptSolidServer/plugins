// markets/lifecycle.js — the settlement state machine.
//
// Extracted from the route layer for one structural reason: a market's
// lifecycle fields must only ever change inside store.js's reducer, via a
// journalled event. When this logic lived inline in a handler, an
// adjudication assigned `m.resolvedOutcome` directly — payouts were
// journalled, the OUTCOME was not — so replaying the journal restored the
// oracle's original wrong answer while the credits sat with the corrected
// one. The audit trail contradicted the money.
//
// The rule this module exists to enforce: NOTHING here assigns to a
// market field. Everything goes through `commit()`, and the reducer does
// the mutating. Anything that needs to change state adds an event type.
//
//   open --closesAt--> (closed: no trading)
//     |                      |
//     | oracle resolve       | nobody resolves within settlementWindow
//     | oracle propose-void  v
//     v                    auto-void at TWAP (anyone may trigger)
//   resolving / voiding --window--> settled
//     |
//     | a holder disputes (bonded)
//     v
//   disputed --operator: uphold / re-resolve / void--> settled
//            --grace, unadjudicated--> the resolution STANDS

import { twapPrices } from './lmsr.js';

/**
 * @param {object} deps
 * @param {object} deps.state           the live store state
 * @param {Function} deps.commit        store.commit — the ONLY way to mutate
 * @param {Function} deps.broadcast     (type, market) => void
 * @param {object} deps.log             api.log
 * @param {object} deps.cfg             { twapWindowMs, houseFeeShareBps, settlementWindowMs, disputeGraceMs, house }
 */
export function createLifecycle({ state, commit, broadcast, log, cfg }) {
  const { twapWindowMs, houseFeeShareBps, settlementWindowMs, disputeGraceMs, HOUSE } = cfg;

/** Prices to redeem a voided market at: the TWAP over the window ending
 *  at close (see the header — this is what kills the void front-run). */
function voidPrices(m) {
  const endT = m.closedAt || Math.min(m.closesAt, Date.now());
  return twapPrices(m.history, endT - twapWindowMs, endT, m.outcomes.length);
}

/**
 * Compute and journal a settlement. Payouts are derived here, RECORDED
 * in the event, and applied by the reducer — so replay never recomputes
 * float arithmetic.
 */
function settle(m, status, payoutMicroOf, prices, { adjudicatedBy = null, sustained = false, outcome = null } = {}) {
  const pool = m.subsidyMicro + m.collectedMicro;
  const raw = [];
  let sum = 0;
  for (const [agent, pos] of Object.entries(m.positions)) {
    const computed = payoutMicroOf(pos);
    // A non-finite payout must be LOUD. Math.max(0, Math.floor(NaN)) is
    // NaN and `if (v > 0)` is false, so a broken payout function paid
    // every holder zero and burned the pool to the house in silence.
    if (!Number.isFinite(computed)) {
      throw new Error(`markets: ${m.id} computed a non-finite payout for ${agent} — refusing to settle`);
    }
    const v = Math.max(0, Math.floor(computed));
    if (v > 0) { raw.push([agent, v]); sum += v; }
  }
  // Belt and braces: solvency is proved (lmsr.js), but if float drift
  // ever put us over the pool, everyone takes the same haircut rather
  // than the last claimant absorbing all of it.
  let scale = 1;
  if (sum > pool) {
    scale = pool / sum;
    log.error(`markets: ${m.id} conservation clamp — payouts ${sum} > pool ${pool}; pro-rata ${scale}`);
  }
  const payouts = {};
  let paid = 0;
  for (const [agent, v] of raw) {
    const p = Math.floor(v * scale);
    if (p > 0) { payouts[agent] = p; paid += p; }
  }

  // The creator may recover AT MOST what they escrowed. Anything left
  // beyond that is other people's money and goes to the house — which
  // is what makes "resolve to an outcome nobody holds" unprofitable.
  const residual = pool - paid;
  const creatorFromPool = Math.max(0, Math.min(residual, m.subsidyMicro));
  const houseFromPool = residual - creatorFromPool;
  const houseFee = Math.floor((m.feesMicro * houseFeeShareBps) / 10_000);
  const creatorFee = m.feesMicro - houseFee;

  // Dispute bonds return ONLY when an operator SUSTAINED the dispute —
  // whether that meant voiding or re-resolving. Inferring it from a
  // void status was wrong twice over: a re-resolution vindicates the
  // disputer but isn't a void, and an unadjudicated grace-expiry void
  // would hand the bond back for free.
  const bondRefunds = {};
  let bondToHouse = 0;
  for (const d of m.disputes || []) {
    if (!d.bondMicro) continue;
    if (sustained) bondRefunds[d.agent] = (bondRefunds[d.agent] || 0) + d.bondMicro;
    else bondToHouse += d.bondMicro;
  }

  commit({
    type: 'market.settle',
    marketId: m.id,
    status,
    // Journalled so replay reproduces the settled outcome. Assigning
    // m.resolvedOutcome outside the reducer made the audit trail
    // contradict the money after a restore.
    outcome,
    payouts,
    bondRefunds,
    creatorMicro: creatorFromPool + creatorFee,
    houseMicro: houseFromPool + houseFee + bondToHouse,
    house: HOUSE,
    adjudicatedBy,
    prices: prices ? prices.map((p) => Number(p.toFixed(6))) : null,
  });
  broadcast('settle', m);
}

const settleResolved = (m, opts = {}) => {
  // An adjudicator may settle at a DIFFERENT outcome than the oracle
  // declared; that corrected outcome rides in the event.
  const outcome = opts.outcome ?? m.resolvedOutcome;
  // A disputed VOID PROPOSAL has no resolvedOutcome; resolving it would
  // index shares[undefined] and pay every holder nothing.
  if (!Number.isInteger(outcome)) {
    throw new Error(`markets: ${m.id} has no resolved outcome to settle at`);
  }
  settle(m, 'resolved', (pos) => pos.shares[outcome], null, { ...opts, outcome });
};
// On a void you receive the LESSER of market value (at the TWAP) and
// what you actually paid. The cap is what finally kills the void
// arbitrage: the TWAP already defeats a last-second pump, but a
// *sustained* pump held across the whole window makes the TWAP equal
// the pumped price, and against a dead oracle that is a profitable
// grief funded by the creator's escrow. Capping at cost basis means no
// holder can ever exit a void for more than they put in, so pumping to
// be voided is never profitable at any hold duration. It only ever
// pays LESS than the TWAP, so conservation is strictly preserved.
const settleVoid = (m, opts) => {
  const p = voidPrices(m);
  settle(m, 'void',
    (pos) => pos.shares.reduce((a, s, i) => a + Math.min(s * p[i], pos.costMicro[i]), 0),
    p, opts);
};

/**
 * Advance every market whose deadline has passed. Runs on a timer AND
 * lazily before reads, so a settlement is never waiting on a tick.
 *
 * The auto-void arm is the DEAD-ORACLE BACKSTOP: a market whose oracle
 * never acts (typo, abandoned, malicious) would otherwise lock every
 * trader's credits forever, since trading also stops at close. After
 * settlementWindow anyone's request advances it to a TWAP void.
 */
// Settlement on the request path is bounded to once a second: a mass
// expiry otherwise turns an anonymous GET into a multi-second stall
// (one fsync per newly-due market).
let lastTick = 0;
function maybeTick() {
  if (Date.now() - lastTick < 1000) return;
  lastTick = Date.now();
  tick();
}

function tickOne(m, now = Date.now()) {
  if (m.status === 'resolving' && now >= m.settleAt) settleResolved(m);
  else if (m.status === 'voiding' && now >= m.settleAt) settleVoid(m);
  else if (m.status === 'open' && now >= m.closesAt + settlementWindowMs) {
    log.warn(`markets: ${m.id} auto-voiding — no resolution within the settlement window`);
    settleVoid(m);
  } else if (m.status === 'disputed'
    // Anchor to the LATEST dispute: anchoring to the first gave a
    // late disputer a truncated window and took a bond that could
    // never be heard.
    && now >= (m.disputes[m.disputes.length - 1].at + disputeGraceMs)) {
    // Fall through to WHAT THE ORACLE PROPOSED — a resolution if
    // there was one, otherwise the void it proposed. An unadjudicated
    // dispute must not cancel a bet you lost, and must not invent a
    // resolution that never existed.
    log.warn(`markets: ${m.id} dispute expired unadjudicated — the oracle's call stands`);
    if (Number.isInteger(m.resolvedOutcome)) settleResolved(m);
    else settleVoid(m);
  }
}

function tick() {
  const now = Date.now();
  for (const m of Object.values(state.markets)) {
    try {
      tickOne(m, now);
    } catch (e) {
      // Isolate one bad market — but a systematic failure (a broken
      // dependency, say) silently stalls EVERY settlement, so this is
      // logged at error level and never swallowed quietly.
      log.error(`markets: tick failed for ${m.id}: ${e.message}`);
    }
  }
}

  return { voidPrices, settle, settleResolved, settleVoid, tick, tickOne, maybeTick };
}
