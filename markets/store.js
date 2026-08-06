// markets/store.js — the durable ledger: an append-only journal, a
// periodic snapshot, and the reducer that turns events into state.
//
// WHY EVENT SOURCING and not the one-JSON-blob pattern the other plugins
// use: balances ARE the product here, so three requirements arrive
// together and a snapshot-only design meets none of them.
//
//   1. AUDIT — every credit movement must be reconstructible after the
//      fact ("I never made that trade"). A mutable snapshot keeps only
//      the end state; the journal keeps the story.
//   2. DURABILITY — a trade must survive a power cut the instant it is
//      acknowledged. The journal is appended and fsync'd BEFORE the
//      client is told "ok"; the snapshot is a lazy optimisation that can
//      lag or be lost entirely without losing a single trade.
//   3. COST — rewriting every market and balance on every trade is
//      O(entire state) per mutation. An append is O(event).
//
// Recovery = load the snapshot, replay journal entries with seq >
// snapshot.seq. Every amount AND every price vector is RECORDED in its
// event, never recomputed at replay, so recovery is deterministic even
// though pricing is float: the reducer does bookkeeping, not arithmetic.
// (Recomputing would be subtly wrong, not merely wasteful — Math.exp is
// implementation-defined precision, and the void TWAP is integrated over
// the recorded price path.)
//
// Corruption is a BOOT FAILURE, never a silent reset (AGENT.md: "fail
// loudly"). A truncated snapshot that reset to {} would erase every
// balance and then overwrite the evidence on the next write; instead we
// throw, keep the file, and let the operator restore from the .bak or
// replay the journal. Only a MISSING file is a legitimate empty start.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A dictionary with no prototype — `__proto__`/`constructor` as a key
 *  are ordinary misses, not surprise objects (security finding). */
export const dict = (from) => Object.assign(Object.create(null), from || {});

// ------------------------------------------------------- durable write
/**
 * Atomic AND durable: write temp, fsync the file, rename over the target,
 * then fsync the DIRECTORY so the rename itself is on disk. Without the
 * two fsyncs the rename can be visible while the bytes are not — which is
 * exactly how a truncated snapshot gets created.
 */
export function durableWriteSync(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    let dir;
    try {
      dir = fs.openSync(path.dirname(file), 'r');
      fs.fsyncSync(dir);
    } catch { /* directory fsync unsupported on some platforms */ } finally {
      if (dir !== undefined) try { fs.closeSync(dir); } catch { /* closed */ }
    }
  } catch (err) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ------------------------------------------------------------ reducer
//
// Every mutation of ledger/markets state happens HERE and nowhere else.
// Handlers validate and emit; the reducer applies. That is what makes a
// trade atomic: append (fsync) → apply (synchronous, no await) → reply.

const ROTATE_BYTES = 32 * 1024 * 1024; // rotate the journal past this size
const MAX_HISTORY = 720;              // price samples kept per market
const MAX_SETTLEMENTS = 200;          // settlement receipts kept per agent
const PROTECT_MS = 4 * 60 * 60 * 1000; // recent window that is never thinned

/**
 * Thin the price history in place. Samples inside PROTECT_MS of `nowT`
 * are NEVER merged: thinning by COUNT alone would let a high-frequency
 * market push real samples out of the void TWAP window, making the
 * redemption price a function of trade timing — i.e. attacker-steerable.
 * Thinning strictly outside the window cannot move the TWAP integral
 * over it.
 */
function compactHistory(h, nowT) {
  if (h.length <= MAX_HISTORY) return h;
  const cutoff = nowT - PROTECT_MS;
  const recent = h.filter((s) => s.t >= cutoff);
  const older = h.filter((s) => s.t < cutoff).filter((_, i) => i % 2 === 0);
  // Keep the last sample before the window so the first in-window segment
  // still has the price that was in force when it began.
  h.length = 0;
  h.push(...older, ...recent);
  return h;
}

export const TWAP_PROTECT_MS = PROTECT_MS;

export function emptyState() {
  return { seq: 0, ledger: dict(), markets: dict(), settlements: dict() };
}

/** Ledger row, created on demand. Agents start at zero; grants are events. */
function row(state, agent) {
  let r = state.ledger[agent];
  if (!r) {
    r = { balanceMicro: 0, created: null, frozen: false, epoch: 0 };
    state.ledger[agent] = r;
  }
  return r;
}

function pushSettlement(state, agent, rec) {
  const list = state.settlements[agent] || (state.settlements[agent] = []);
  list.push(rec);
  if (list.length > MAX_SETTLEMENTS) list.splice(0, list.length - MAX_SETTLEMENTS);
}

/**
 * Apply one event. Pure bookkeeping over recorded amounts — no pricing
 * decisions, so replaying the journal reproduces the state exactly.
 * @param {object} state
 * @param {object} ev  { type, t, ...payload }
 * @param {(q:number[],b:number)=>number[]} prices  price fn (for history)
 */
export function applyEvent(state, ev, prices) {
  switch (ev.type) {
    case 'grant': {
      const r = row(state, ev.agent);
      r.balanceMicro += ev.amountMicro;
      r.created = r.created || new Date(ev.t).toISOString();
      break;
    }
    case 'market.create': {
      const m = ev.market;
      m.positions = dict(m.positions);
      // Seed the price path at creation. `m.history || [...]` would NOT
      // do it — an empty array is truthy, and a market whose history
      // starts at its first trade has a TWAP equal to the post-trade
      // price, which is precisely the void front-run the TWAP exists to
      // stop. (Caught by the pump-and-void regression test.)
      if (!m.history || !m.history.length) {
        m.history = [{ t: ev.t, p: ev.seedPrices || prices(m.q, m.bMicro) }];
      }
      state.markets[m.id] = m;
      row(state, m.creator).balanceMicro -= m.subsidyMicro;
      break;
    }
    case 'trade': {
      const m = state.markets[ev.marketId];
      const r = row(state, ev.agent);
      const pos = m.positions[ev.agent]
        || (m.positions[ev.agent] = {
          shares: m.outcomes.map(() => 0), costMicro: m.outcomes.map(() => 0), netInMicro: 0,
        });
      // Net cash in, EXCLUDING fees: what this agent put into the pool
      // net of what they took back out. It caps a void redemption (see
      // lifecycle.js). Fees are deliberately not refundable — including
      // them made distorting the void price free, and a settlement price
      // any funded account can move for nothing is not a price.
      pos.netInMicro = (pos.netInMicro || 0)
        + (ev.side === 'buy' ? ev.costMicro : -ev.proceedsMicro);
      if (ev.side === 'buy') {
        r.balanceMicro -= ev.totalMicro;
        m.collectedMicro += ev.costMicro;
        m.q[ev.outcome] += ev.sharesMicro;
        pos.shares[ev.outcome] += ev.sharesMicro;
        pos.costMicro[ev.outcome] += ev.totalMicro;
      } else {
        r.balanceMicro += ev.totalMicro;
        m.collectedMicro -= ev.proceedsMicro;
        m.q[ev.outcome] -= ev.sharesMicro;
        // Cost basis is reduced proportionally to the fraction sold, so
        // what remains is the basis of what is still held (and realized
        // P&L is proceeds − basis released).
        const before = pos.shares[ev.outcome];
        const released = before > 0 ? Math.round((pos.costMicro[ev.outcome] * ev.sharesMicro) / before) : 0;
        pos.shares[ev.outcome] -= ev.sharesMicro;
        pos.costMicro[ev.outcome] -= released;
      }
      m.feesMicro += ev.feeMicro;
      m.volumeMicro += ev.sharesMicro;
      m.trades += 1;
      // Use the price vector RECORDED with the event, not a fresh
      // softmax: Math.exp is implementation-defined precision, so
      // recomputing at replay could drift the price path across
      // machines or libm versions — and the void TWAP is computed from
      // that path, so drift would change what a market pays out.
      m.history.push({ t: ev.t, p: ev.pricesAfter || prices(m.q, m.bMicro) });
      compactHistory(m.history, ev.t);
      break;
    }
    case 'market.close': {
      const m = state.markets[ev.marketId];
      m.closesAt = Math.min(m.closesAt, ev.t);
      m.closedAt = m.closedAt || ev.t;
      break;
    }
    case 'market.propose-void': {
      const m = state.markets[ev.marketId];
      m.status = 'voiding';
      m.proposal = 'void';
      m.resolvedOutcome = null; // a void proposal abandons any prior call
      m.settleAt = ev.settleAt;
      m.closesAt = Math.min(m.closesAt, ev.t);
      m.closedAt = m.closedAt || ev.t;
      m.resolvedBy = ev.agent;
      break;
    }
    case 'market.resolve': {
      const m = state.markets[ev.marketId];
      m.status = 'resolving';
      m.proposal = 'resolve';
      m.resolvedOutcome = ev.outcome;
      m.settleAt = ev.settleAt;
      m.closesAt = Math.min(m.closesAt, ev.t);
      m.closedAt = m.closedAt || ev.t;
      m.resolvedBy = ev.agent;
      break;
    }
    case 'market.dispute': {
      const m = state.markets[ev.marketId];
      m.status = 'disputed';
      // The bond is what stops "dispute every loss": it is forfeited to
      // the house if the resolution is upheld, refunded if the dispute
      // was right. Held by the market until settlement, like the pool.
      row(state, ev.agent).balanceMicro -= ev.bondMicro || 0;
      m.disputeBondMicro = (m.disputeBondMicro || 0) + (ev.bondMicro || 0);
      (m.disputes || (m.disputes = [])).push({
        agent: ev.agent, reason: ev.reason, at: ev.t, bondMicro: ev.bondMicro || 0,
      });
      break;
    }
    case 'market.settle': {
      const m = state.markets[ev.marketId];
      // Set BEFORE the receipts are written — they record it.
      if (ev.outcome !== undefined && ev.outcome !== null) m.resolvedOutcome = ev.outcome;
      // Everyone who HELD is given a receipt, not only those who were
      // paid: "you lost 12.40 on this" is the settlement a bettor most
      // needs to see, and a payout-only list silently drops it.
      const holders = new Set([...Object.keys(ev.payouts), ...Object.keys(m.positions)]);
      for (const agent of holders) {
        const micro = ev.payouts[agent] || 0;
        if (micro) row(state, agent).balanceMicro += micro;
        const pos = m.positions[agent];
        if (!micro && !(pos && pos.shares.some((x) => x !== 0))) continue;
        pushSettlement(state, agent, {
          market: m.id,
          title: m.title,
          status: ev.status,
          outcome: ev.status === 'resolved' ? m.resolvedOutcome : null,
          payout: micro,
          // Cost basis of what was held, so the receipt can show net P&L.
          cost: pos ? pos.costMicro.reduce((a, x) => a + x, 0) : 0,
          at: ev.t,
        });
      }
      for (const [agent, micro] of Object.entries(ev.bondRefunds || {})) {
        row(state, agent).balanceMicro += micro;
      }
      row(state, m.creator).balanceMicro += ev.creatorMicro;
      if (ev.houseMicro) row(state, ev.house).balanceMicro += ev.houseMicro;
      m.status = ev.status;
      // A void has no winner; leaving a stale outcome on it showed
      // integrators a winning outcome on a cancelled market.
      if (ev.status === 'void') m.resolvedOutcome = null;
      m.resolvedAt = new Date(ev.t).toISOString();
      m.settledPrices = ev.prices || null;
      break;
    }
    case 'admin.adjust': {
      row(state, ev.agent).balanceMicro += ev.deltaMicro;
      break;
    }
    case 'admin.freeze': {
      const r = row(state, ev.agent);
      r.frozen = !!ev.frozen;
      // Freezing must also kill live sessions, not just future requests.
      if (r.frozen) r.epoch = (r.epoch || 0) + 1;
      break;
    }
    case 'session.revoke': {
      const r = row(state, ev.agent);
      r.epoch = (r.epoch || 0) + 1;
      break;
    }
    case 'admin.hide': {
      state.markets[ev.marketId].hidden = !!ev.hidden;
      break;
    }
    default:
      throw new Error(`markets: unknown journal event type '${ev.type}'`);
  }
  state.seq = ev.seq;
  return state;
}

// -------------------------------------------------------------- store
/**
 * @param {object} opts
 * @param {string} opts.dir      pluginDir
 * @param {object} opts.log      api.log
 * @param {Function} opts.prices price fn passed through to the reducer
 */
export function createStore({ dir, log, prices }) {
  const snapFile = path.join(dir, 'state.json');
  const bakFile = path.join(dir, 'state.json.bak');
  const journalFile = path.join(dir, 'journal.jsonl');

  // ---- load snapshot (missing = fresh start; corrupt = boot failure)
  let state = emptyState();
  if (fs.existsSync(snapFile)) {
    let raw;
    try {
      raw = fs.readFileSync(snapFile, 'utf8');
    } catch (err) {
      throw new Error(`markets: cannot read ${snapFile}: ${err.message}`);
    }
    let snap;
    try {
      snap = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `markets: ${snapFile} is corrupt (${err.message}). Refusing to boot rather than `
        + `silently resetting every balance — restore ${bakFile}, or delete the snapshot to `
        + `rebuild by replaying every journal segment (journal.jsonl plus any journal.<seq>.jsonl).`,
      );
    }
    if (!snap || typeof snap !== 'object' || !snap.ledger || !snap.markets) {
      throw new Error(`markets: ${snapFile} is not a markets snapshot (missing ledger/markets)`);
    }
    state = {
      seq: snap.seq || 0,
      ledger: dict(snap.ledger),
      markets: dict(snap.markets),
      settlements: dict(snap.settlements),
    };
    for (const m of Object.values(state.markets)) {
      m.positions = dict(m.positions);
      // Backfill fields added after this snapshot was written. Cost
      // basis is present in every old snapshot and is the correct
      // conservative stand-in for net cash in.
      for (const pos of Object.values(m.positions)) {
        if (pos.netInMicro === undefined) {
          pos.netInMicro = pos.costMicro.reduce((a, x) => a + x, 0);
        }
      }
      // …and what the oracle proposed, which older states recorded only
      // in the status. Doing it HERE rather than at read time means
      // every downstream branch sees a well-formed market.
      if (!m.proposal) {
        if (m.status === 'voiding') m.proposal = 'void';
        else if (m.status === 'resolving' || Number.isInteger(m.resolvedOutcome)) m.proposal = 'resolve';
      }
    }
  }

  // ---- replay the journal (every segment, in sequence order)
  //
  // Rotation retires `journal.jsonl` to `journal.<seq>.jsonl`, so the live
  // file alone is NOT the ledger. Replaying only the live file meant that
  // deleting a corrupt snapshot — which is exactly what the boot error
  // used to advise — silently produced a brand-new empty ledger with
  // every balance at zero and no warning at all. Recovery reads every
  // segment.
  //
  // A torn FINAL line in the LIVE segment is the normal crash signature —
  // an append interrupted mid-write — and is safe to drop, because that
  // event was never acknowledged to a client. But it must also be
  // TRUNCATED away before appending again: reopening in 'a' mode over a
  // fragment welds the next (acknowledged, fsync'd) event onto the
  // partial line, so the next boot drops a real event and reuses its seq.
  const segments = fs.existsSync(dir)
    ? fs.readdirSync(dir)
      .map((f) => /^journal\.(\d+)\.jsonl$/.exec(f))
      .filter(Boolean)
      .map((m) => ({ file: path.join(dir, m[0]), seq: Number(m[1]) }))
      .sort((a, b) => a.seq - b.seq)
      .map((x) => x.file)
    : [];
  const files = [...segments, journalFile].filter((f) => fs.existsSync(f));

  let replayed = 0;
  let torn = false;
  let goodBytes = 0;
  for (const file of files) {
    const isLive = file === journalFile;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    // O(1) "is this the final content line?" — the previous O(n) slice
    // per line made boot quadratic (100k events ≈ 5.4s of blocked boot).
    let lastContent = -1;
    for (let i = lines.length - 1; i >= 0; i--) { if (lines[i]) { lastContent = i; break; } }
    if (isLive) goodBytes = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) { if (isLive && i < lines.length - 1) goodBytes += 1; continue; }
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (err) {
        if (isLive && i === lastContent) {
          log.warn(`markets: dropping torn final journal line and truncating to ${goodBytes} bytes (${err.message})`);
          torn = true;
          break;
        }
        throw new Error(`markets: ${file} is corrupt at a non-final line: ${err.message}`);
      }
      if (isLive) goodBytes += Buffer.byteLength(line, 'utf8') + (i < lines.length - 1 ? 1 : 0);
      if (ev.seq <= state.seq) continue;
      // Contiguity: an excised or reordered line means the audit trail has
      // been tampered with or truncated. Replaying past a gap would
      // silently produce a state nobody can account for.
      if (ev.seq !== state.seq + 1) {
        throw new Error(
          `markets: journal gap at seq ${ev.seq} (expected ${state.seq + 1}) in ${file} — the ledger `
          + `cannot be reconstructed from a discontinuous journal; restore from backup`,
        );
      }
      applyEvent(state, ev, prices);
      replayed++;
    }
  }
  if (replayed) log.info(`markets: replayed ${replayed} journal event(s) across ${files.length} segment(s)`);
  // Cut the fragment off BEFORE opening for append (see above).
  if (torn) fs.truncateSync(journalFile, goodBytes);

  // ---- append path: fsync'd before the caller is allowed to reply
  let jfd = fs.openSync(journalFile, 'a');
  let dirty = 0;

  /**
   * Journal an event, then apply it. Throws BEFORE any state change if
   * the write fails, so a failed append can never leave the in-memory
   * ledger ahead of the durable one (the old design mutated first and
   * 500'd after, leaving memory and disk permanently divergent).
   */
  function reopenJournal() {
    jfd = fs.openSync(journalFile, 'a');
  }

  function commit(ev) {
    ev.seq = state.seq + 1;
    ev.t = ev.t || Date.now();
    // A descriptor lost during rotation (or by anything else) must not
    // wedge the ledger forever: recover it here rather than failing
    // every trade and settlement from now on.
    if (jfd === null) reopenJournal();
    const line = Buffer.from(`${JSON.stringify(ev)}\n`, 'utf8');
    let off = 0;
    while (off < line.length) off += fs.writeSync(jfd, line, off, line.length - off);
    fs.fsyncSync(jfd);
    applyEvent(state, ev, prices);
    dirty++;
    return ev;
  }

  function snapshot() {
    if (!dirty) return;
    try {
      if (fs.existsSync(snapFile)) fs.copyFileSync(snapFile, bakFile);
      durableWriteSync(snapFile, JSON.stringify({
        seq: state.seq, ledger: state.ledger, markets: state.markets, settlements: state.settlements,
      }));
      dirty = 0;
      // Rotate only AFTER a durable snapshot that covers every event in
      // the file — then the retired segment is never needed for replay,
      // only for audit. Without this the journal grows forever and boot
      // is O(lifetime).
      if (fs.fstatSync(jfd).size >= ROTATE_BYTES) {
        const retired = path.join(path.dirname(journalFile), `journal.${state.seq}.jsonl`);
        try {
          fs.closeSync(jfd);
          fs.renameSync(journalFile, retired);
          files.push(retired); // keep the audit query able to see it
        } catch (err) {
          // NOT harmless: leaving jfd closed makes every later commit
          // fail with EBADF, i.e. every trade and settlement 500s
          // forever. Always get a working descriptor back.
          log.error(`markets: journal rotation failed: ${err.message}`);
        } finally {
          // If THIS throws, jfd stays null and commit() reopens lazily.
          jfd = null;
          try { reopenJournal(); } catch (err) {
            log.error(`markets: could not reopen the journal after rotation: ${err.message}`);
          }
        }
        log.info(`markets: rotated journal at seq ${state.seq} (prior segment retained for audit)`);
      }
    } catch (err) {
      // Non-fatal by design: the journal is the durable record, so a
      // failed snapshot costs replay time at boot, not data.
      log.warn(`markets: snapshot failed (journal is still authoritative): ${err.message}`);
    }
  }

  /**
   * Every journal event touching one agent — the support/adjudication
   * query. Reads the journal rather than memory, because the point is to
   * answer "what actually happened", not "what does state say now".
   */
  function eventsFor(agent, limit = 500) {
    const out = [];
    // Every segment, oldest first: reading only the live journal returns
    // an EMPTY history after the first rotation, and a confidently empty
    // answer to "what happened to this account" is worse than an error.
    const all = [];
    // Re-scan: a rotation since boot moved the live file's contents into
    // a segment that wasn't in the boot-time list.
    const current = new Set(files);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/^journal\.\d+\.jsonl$/.test(f)) current.add(path.join(dir, f));
      }
    } catch { /* directory vanished */ }
    // Numeric order: lexicographic puts journal.100 before journal.20,
    // so a busy account's "most recent 500 events" were the wrong 500.
    const ordered = [...current].sort((a, b) => {
      const na = /journal\.(\d+)\.jsonl$/.exec(a);
      const nb = /journal\.(\d+)\.jsonl$/.exec(b);
      if (!na) return 1;   // the live journal sorts last
      if (!nb) return -1;
      return Number(na[1]) - Number(nb[1]);
    });
    for (const file of ordered) {
      try { all.push(...fs.readFileSync(file, 'utf8').split('\n')); } catch { /* rotated away */ }
    }
    for (const line of all) {
      if (!line || !line.includes(agent)) continue; // cheap prefilter
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const touches = ev.agent === agent
        || (ev.payouts && ev.payouts[agent] !== undefined)
        || (ev.bondRefunds && ev.bondRefunds[agent] !== undefined)
        || (ev.market && ev.market.creator === agent);
      if (touches) out.push(ev);
    }
    return out.slice(-limit);
  }

  return {
    state,
    commit,
    snapshot,
    eventsFor,
    stats: () => ({ seq: state.seq, replayed, journalFile, snapFile }),
    close() {
      snapshot();
      try { fs.closeSync(jfd); } catch { /* already closed */ }
    },
  };
}
