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
  // Anchor to when TRADING stopped, not to when somebody clicked.
  // Stamping the anchor at propose time let a late oracle void redeem at
  // spot — 40 points from the backstop's price on the same market,
  // chosen simply by waiting.
  const endT = Math.min(m.closesAt, m.closedAt ?? Infinity, Date.now());
  return twapPrices(m.history, endT - twapWindowMs, endT, m.outcomes.length);
}

/**
 * Compute and journal a settlement. Payouts are derived here, RECORDED
 * in the event, and applied by the reducer — so replay never recomputes
 * float arithmetic.
 */
function settle(m, status, payoutMicroOf, prices, {
  adjudicatedBy = null, sustained = false, outcome = null, abandoned = false,
} = {}) {
  // The escrow is slashed for ABANDONMENT, not for an outcome. Gating it
  // on `status === 'resolved'` instead made a FALSE resolution strictly
  // dominate an honest void by the whole escrow — the exact mirror of
  // the bug that gating was added to fix — and made creating any
  // low-volume market negative-EV, since a creator cannot force the
  // oracle they named to act.
  const creatorMayRecover = !abandoned;
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

  // The creator may recover AT MOST what they escrowed. That cap is what
  // makes "resolve to an outcome nobody holds" pointless. The escrow is
  // forfeited entirely only when the market had to be rescued by the
  // abandoned-market backstop — i.e. nobody ever settled it — which is
  // the one case where the maker bond should actually be at risk.
  const residual = pool - paid;
  const creatorFromPool = creatorMayRecover ? Math.max(0, Math.min(residual, m.subsidyMicro)) : 0;
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
/**
 * A VOID REFUNDS WHAT YOU PUT IN. Nothing about the market price enters
 * the payout at all.
 *
 * The journey here is worth recording. Refunding stakes looked impossible
 * under an AMM (early sellers already left with pool money), so voids
 * redeemed at the market price — first spot, which was a guaranteed
 * arbitrage; then a TWAP, which a sustained pump defeated; then
 * min(TWAP, cost basis), which a partial sell defeated and which taxed a
 * hedged position 12%. Each fix left the payout a function of a price
 * somebody could move.
 *
 * The premise was wrong. Track NET cash in — Σ paid − Σ taken out — and
 * the sum over all holders is exactly `collectedMicro` by construction,
 * so refunding `max(0, netIn)` is funded by what the pool actually
 * holds. Traders who cashed out at a profit make Σ max(0, netIn) exceed
 * collected, and that excess is precisely the maker loss the creator's
 * b·ln n escrow exists to cover, with the pro-rata clamp as the backstop.
 *
 * So it is manipulation-proof: there is no price to distort. A pump
 * before a void used to hand the pumper a full refund while collapsing
 * an innocent holder's redemption to 5.6% of what they paid, with the
 * difference falling to the house. Now everybody gets their money back
 * and the griefer's only achievement is paying the fees.
 */
const settleVoid = (m, opts = {}) => settle(
  m,
  'void',
  (pos) => Math.max(0, pos.netInMicro || 0),
  // Recorded for the audit trail only — the price at close is worth
  // knowing, and is no longer worth anything to an attacker.
  voidPrices(m),
  opts,
);

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

/**
 * When an unadjudicated dispute stops holding up settlement.
 *
 * Anchored to the LATEST dispute so a late disputer gets a real window
 * rather than a truncated one — but HARD-CAPPED from the first, because
 * each new disputer otherwise pushes the deadline out again: ten dust
 * accounts posting the 25-credit floor out of their own free signup
 * grants could freeze a settlement for seventy days at no real cost.
 */
// `proposal` is backfilled at load (store.js), so by here it is always
// set for any market that reached a proposal state.
const isVoidProposal = (m) => m.proposal === 'void';

/** When an unadjudicated dispute stops holding up settlement. Exported
 *  so the operator queue advertises the deadline the machine uses — the
 *  two drifting apart made the queue wrong exactly when it mattered. */
function disputeDeadline(m) {
  const ds = m.disputes || [];
  if (!ds.length) return m.settleAt ?? Infinity;
  const first = ds[0].at;
  const last = ds[ds.length - 1].at;
  return Math.min(last + disputeGraceMs, first + disputeGraceMs * 3);
}

function tickOne(m, now = Date.now()) {
  if (m.status === 'resolving' && now >= m.settleAt) settleResolved(m);
  else if (m.status === 'voiding' && now >= m.settleAt) settleVoid(m);
  else if (m.status === 'open' && now >= m.closesAt + settlementWindowMs) {
    log.warn(`markets: ${m.id} auto-voiding — no resolution within the settlement window`);
    settleVoid(m, { abandoned: true });
  } else if (m.status === 'disputed' && now >= disputeDeadline(m)) {
    // Fall through to WHAT THE ORACLE PROPOSED — a resolution if
    // there was one, otherwise the void it proposed. An unadjudicated
    // dispute must not cancel a bet you lost, and must not invent a
    // resolution that never existed.
    log.warn(`markets: ${m.id} dispute expired unadjudicated — the oracle's call stands`);
    if (isVoidProposal(m)) settleVoid(m);
    else settleResolved(m);
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

  return { voidPrices, settle, settleResolved, settleVoid, tick, tickOne, maybeTick, disputeDeadline };
}
