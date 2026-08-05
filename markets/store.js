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
// snapshot.seq. Because every amount is RECORDED in its event (never
// recomputed at replay), replay is deterministic even though pricing is
// float: the reducer does bookkeeping, not arithmetic decisions.
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

const MAX_HISTORY = 720;      // price samples kept per market
const MAX_SETTLEMENTS = 200;  // settlement receipts kept per agent

/** Thin the price history in place, keeping the newest samples dense. */
function compactHistory(h) {
  if (h.length <= MAX_HISTORY) return h;
  const keep = h.slice(-Math.floor(MAX_HISTORY / 2));            // recent: all
  const old = h.slice(0, h.length - keep.length).filter((_, i) => i % 2 === 0); // older: halved
  h.length = 0;
  h.push(...old, ...keep);
  return h;
}

export function emptyState() {
  return { seq: 0, ledger: dict(), markets: dict(), settlements: dict() };
}

/** Ledger row, created on demand. Agents start at zero; grants are events. */
function row(state, agent) {
  let r = state.ledger[agent];
  if (!r) {
    r = { balanceMicro: 0, created: null, frozen: false };
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
      if (!m.history || !m.history.length) m.history = [{ t: ev.t, p: prices(m.q, m.bMicro) }];
      state.markets[m.id] = m;
      row(state, m.creator).balanceMicro -= m.subsidyMicro;
      break;
    }
    case 'trade': {
      const m = state.markets[ev.marketId];
      const r = row(state, ev.agent);
      const pos = m.positions[ev.agent]
        || (m.positions[ev.agent] = { shares: m.outcomes.map(() => 0), costMicro: m.outcomes.map(() => 0) });
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
      m.history.push({ t: ev.t, p: prices(m.q, m.bMicro) });
      compactHistory(m.history);
      break;
    }
    case 'market.close': {
      const m = state.markets[ev.marketId];
      m.closesAt = Math.min(m.closesAt, ev.t);
      m.closedAt = m.closedAt || ev.t;
      break;
    }
    case 'market.resolve': {
      const m = state.markets[ev.marketId];
      m.status = 'resolving';
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
      (m.disputes || (m.disputes = [])).push({ agent: ev.agent, reason: ev.reason, at: ev.t });
      break;
    }
    case 'market.settle': {
      const m = state.markets[ev.marketId];
      for (const [agent, micro] of Object.entries(ev.payouts)) {
        row(state, agent).balanceMicro += micro;
        pushSettlement(state, agent, {
          market: m.id,
          title: m.title,
          status: ev.status,
          outcome: ev.status === 'resolved' ? m.resolvedOutcome : null,
          payout: micro,
          at: ev.t,
        });
      }
      row(state, m.creator).balanceMicro += ev.creatorMicro;
      if (ev.houseMicro) row(state, ev.house).balanceMicro += ev.houseMicro;
      m.status = ev.status;
      m.resolvedAt = new Date(ev.t).toISOString();
      m.settledPrices = ev.prices || null;
      break;
    }
    case 'admin.adjust': {
      row(state, ev.agent).balanceMicro += ev.deltaMicro;
      break;
    }
    case 'admin.freeze': {
      row(state, ev.agent).frozen = !!ev.frozen;
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
        + `rebuild from ${journalFile}.`,
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
    for (const m of Object.values(state.markets)) m.positions = dict(m.positions);
  }

  // ---- replay the journal tail (everything after the snapshot)
  let replayed = 0;
  if (fs.existsSync(journalFile)) {
    const lines = fs.readFileSync(journalFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (err) {
        // A torn LAST line is the normal crash signature (append
        // interrupted mid-write) and is safe to drop: that event was
        // never acknowledged. A torn line anywhere else is corruption.
        if (line === lines[lines.length - 2] || line === lines[lines.length - 1]) {
          log.warn(`markets: dropping torn final journal line (${err.message})`);
          break;
        }
        throw new Error(`markets: ${journalFile} is corrupt at a non-final line: ${err.message}`);
      }
      if (ev.seq <= state.seq) continue;
      applyEvent(state, ev, prices);
      replayed++;
    }
  }
  if (replayed) log.info(`markets: replayed ${replayed} journal event(s) past snapshot seq ${state.seq - replayed}`);

  // ---- append path: fsync'd before the caller is allowed to reply
  const jfd = fs.openSync(journalFile, 'a');
  let dirty = 0;

  /**
   * Journal an event, then apply it. Throws BEFORE any state change if
   * the write fails, so a failed append can never leave the in-memory
   * ledger ahead of the durable one (the old design mutated first and
   * 500'd after, leaving memory and disk permanently divergent).
   */
  function commit(ev) {
    ev.seq = state.seq + 1;
    ev.t = ev.t || Date.now();
    fs.writeSync(jfd, `${JSON.stringify(ev)}\n`);
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
    } catch (err) {
      // Non-fatal by design: the journal is the durable record, so a
      // failed snapshot costs replay time at boot, not data.
      log.warn(`markets: snapshot failed (journal is still authoritative): ${err.message}`);
    }
  }

  return {
    state,
    commit,
    snapshot,
    stats: () => ({ seq: state.seq, replayed, journalFile, snapFile }),
    close() {
      snapshot();
      try { fs.closeSync(jfd); } catch { /* already closed */ }
    },
  };
}
