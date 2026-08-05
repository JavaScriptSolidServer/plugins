// markets/lmsr.js — the automated market maker, as pure functions.
//
// Hanson's Logarithmic Market Scoring Rule:
//   cost   C(q) = b·ln Σᵢ exp(qᵢ/b)
//   price  pᵢ   = softmax(q/b)ᵢ
//
// Units: q and b are integer MICRO (1e-6) units throughout; the ratio q/b
// is unitless so the formulas are unchanged. Only cost DELTAS are float,
// and callers round them in the pool's favour.
//
// Two solvency facts this module's callers depend on, both consequences of
// the Gibbs variational principle
//   C(q) = maxᵣ [ Σ rᵢqᵢ + b·H(r) ]  over probability vectors r:
//
//   1. RESOLVE:  q_win ≤ C(q) = collected + C(0) = collected + b·ln n
//   2. VOID:     Σᵢ qᵢrᵢ ≤ C(q) for ANY probability vector r
//
// (2) is why voiding at a TIME-WEIGHTED AVERAGE price vector is safe, not
// just at the final one — the bound holds for every r, so a TWAP redeems
// within the pool exactly like the spot vector does. That freedom is what
// closes the void front-run: redeeming at spot lets a trader buy into an
// outcome (cost < shares × p_final, by strict convexity) and immediately
// void for a risk-free b·ln n; redeeming at a TWAP over the pre-close
// window means a late pump barely moves the redemption price, so the pump
// is a pure loss. See plugin.js's void handler.

/** C(q) = b·ln Σ exp(qᵢ/b), shift-stable (logsumexp). */
export function lmsrCost(q, b) {
  const m = Math.max(...q);
  let s = 0;
  for (const qi of q) s += Math.exp((qi - m) / b);
  return m + b * Math.log(s);
}

/** pᵢ = softmax(q/b)ᵢ — sums to 1 up to float eps. */
export function lmsrPrices(q, b) {
  const m = Math.max(...q);
  const e = q.map((qi) => Math.exp((qi - m) / b));
  const s = e.reduce((a, x) => a + x, 0);
  return e.map((x) => x / s);
}

/** Raw float cost (micro; negative for a sell) of moving outcome i by delta. */
export function tradeCostRaw(q, b, i, delta) {
  const q2 = q.slice();
  q2[i] += delta;
  return lmsrCost(q2, b) - lmsrCost(q, b);
}

/** Uniform price vector over n outcomes. */
export function uniformPrices(n) {
  return new Array(n).fill(1 / n);
}

/**
 * Largest whole number of micro-shares of outcome `i` buyable for
 * `budgetMicro`, inclusive of fee. Monotone in shares, so a binary search
 * is exact; `costOf(shares) → totalMicro` is supplied by the caller so
 * this stays agnostic about fee/rounding policy.
 * @returns {number} micro-shares (0 if the budget buys nothing)
 */
export function sharesForBudget(q, b, i, budgetMicro, costOf, capMicro) {
  if (budgetMicro <= 0) return 0;
  // Price only rises as you buy, so shares ≤ budget / p_i(now) bounds the
  // search; cap it so a near-zero price can't produce an absurd hi.
  const p = lmsrPrices(q, b)[i];
  let hi = Math.min(capMicro, Math.ceil(budgetMicro / Math.max(p, 1e-9)) + 1);
  if (costOf(hi) <= budgetMicro) return hi; // budget buys the cap outright
  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (costOf(mid) <= budgetMicro) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Time-weighted average price vector over [fromT, toT].
 *
 * `history` is [{ t, p }] where p is the price vector IN FORCE from t
 * until the next entry (seeded at market creation with the uniform
 * vector), so the price path is a step function and the TWAP is an exact
 * piecewise-constant integral — no interpolation, no sampling bias.
 * Renormalized on the way out so the result is a probability vector even
 * after float accumulation.
 */
export function twapPrices(history, fromT, toT, n) {
  const lastAtOrBefore = () => {
    let p = history.length ? history[0].p : null;
    for (const h of history) if (h.t <= toT) p = h.p;
    return p ? p.slice() : uniformPrices(n);
  };
  if (!history.length || toT <= fromT) return lastAtOrBefore();

  const acc = new Array(n).fill(0);
  let total = 0;
  for (let i = 0; i < history.length; i++) {
    const segStart = history[i].t;
    const segEnd = i + 1 < history.length ? history[i + 1].t : toT;
    const a = Math.max(segStart, fromT);
    const z = Math.min(segEnd, toT);
    if (z <= a) continue;
    const w = z - a;
    total += w;
    for (let k = 0; k < n; k++) acc[k] += history[i].p[k] * w;
  }
  // A window that closes before the first sample (or a zero-length one)
  // has no mass: fall back to the price actually in force at toT.
  if (total <= 0) return lastAtOrBefore();
  const s = acc.reduce((x, y) => x + y, 0) || 1;
  return acc.map((x) => x / s);
}
