// Ripple (Ryan Fugger, 2004) — trustlines + payment routing as a #206 loader
// plugin. The ORIGINAL Ripple: a web of bilateral credit between real
// identities, payments routed through chains of trust. No blockchain, no
// token, no consensus — which is exactly why it fits the plugin api.
//
//   plugins: [{ module: 'ripple/plugin.js', prefix: '/ripple' }]
//
// Spec: webcontracts/webcontracts.github.io#4 ("trustline.v1 profile — Ryan
// Fugger's original Ripple as a web contract"). References: classic
// ripplepay.com; Fugger, "Money as IOUs in Social Trust Networks".
//
// ------------------------------------------------------------------ the model
//
//   Trustline  a UNILATERAL grant: creditor extends debtor up to `limit` of
//              `currency`. Only the creditor may create/resize/remove it —
//              it is their risk. (creditor, debtor, currency) is the key.
//   Balance    ONE signed number per unordered pair+currency (stored as
//              "lo owes hi" with [lo,hi] = sorted ids) — never two mirrored
//              entries, so the books cannot desync.
//   Payment    sender → recipient routed by BFS over the trust graph.
//              capacity(x→y) = limit(y extends x) − debt(x→y); every hop on
//              the path must carry the full amount; balances shift atomically
//              along it. The elegance of Fugger's design: intermediaries need
//              NO per-payment consent — each hop only consumes credit its
//              next node ALREADY granted. Signed debt gives clearing for
//              free: if y owes x, x can "pay" y with zero trustline — the
//              payment forgives existing debt first.
//   Settle     the creditor acknowledges out-of-band repayment ("peer paid
//              me"), reducing what the peer owes them. Only the party whose
//              CLAIM shrinks may record it, so nobody can erase another's IOU.
//   Log        every transition is hash-chained (seq, prev → sha256 of the
//              RFC 8785-canonical entry) — trustline.v1's contract-state
//              framing; the tip is the thing a later wave anchors to Bitcoin
//              via the forge/ Blocktrails path.
//
// Amounts cross the API as decimals (≤ 6 dp) but ALL arithmetic is integer
// micro-units — no float drift in anyone's ledger.
//
// State is a single JSON under api.storage.pluginDir() (the relay/capability
// pattern); mutations are synchronous in-process, which makes multi-hop
// payments trivially atomic — the honest single-server MVP. Cross-server
// routing (the hard 2004 problem: atomic commit between hosts) is the
// federation flavour, documented in README, not attempted here.
//
// ----------------------------------------------------------------- the paths
//
//   GET  <prefix>                    UI (trustlines, balances, pay/settle)
//   GET  <prefix>/api/whoami         the caller's agent id (auth check)
//   GET  <prefix>/api/graph          all trustlines + balances (public; see
//                                    README finding on credit-graph privacy)
//   GET  <prefix>/api/balances?agent=X   net + per-peer positions
//   GET  <prefix>/api/path?from&to&currency&amount   dry-run pathfind
//   POST <prefix>/api/trustlines         { peer, currency, limit }   [creditor]
//   POST <prefix>/api/trustlines/remove  { peer, currency }          [creditor]
//   POST <prefix>/api/payments           { to, currency, amount }    [sender]
//   POST <prefix>/api/settle             { peer, currency, amount }  [creditor]
//   GET  <prefix>/api/log?limit=N        the hash-chained transition log
//   GET  <prefix>/api/log/verify         recompute + check the whole chain

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------- pure model
// Exported for unit tests: everything below operates on plain state
// ({ trustlines, balances }) with integer micro-unit amounts.

const MICRO = 1_000_000n;
const MAX_UNITS = 1_000_000_000_000; // 1e12 units ceiling on limits/amounts
const CUR_RE = /^[A-Z0-9]{1,12}$/;
const SEP = '|'; // agent ids are URLs / DIDs — no '|' in either grammar

/** Decimal number → integer micro-units (bigint), or null if invalid. */
export function toMicro(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v <= 0 || v > MAX_UNITS) return null;
  const micro = Math.round(v * 1e6);
  if (Math.abs(v * 1e6 - micro) > 1e-6) return null; // > 6 dp
  return BigInt(micro);
}
/** Integer micro-units (bigint) → decimal number. */
export const fromMicro = (m) => Number(m) / 1e6;

/** Canonical unordered pair: [lo, hi]. */
export const pair = (a, b) => (a < b ? [a, b] : [b, a]);
export const pairKey = (a, b, cur) => pair(a, b).join(SEP) + SEP + cur;
export const lineKey = (creditor, debtor, cur) => creditor + SEP + debtor + SEP + cur;

/** What x currently owes y in `cur` (micro, signed ≥ 0 means x owes y). */
export function debtOf(state, x, y, cur) {
  const bal = BigInt(state.balances[pairKey(x, y, cur)] ?? '0'); // lo owes hi
  const [lo] = pair(x, y);
  return x === lo ? bal : -bal;
}
/** Shift debt(x→y) by deltaMicro (signed). */
export function adjustDebt(state, x, y, cur, deltaMicro) {
  const k = pairKey(x, y, cur);
  const [lo] = pair(x, y);
  const next = BigInt(state.balances[k] ?? '0') + (x === lo ? deltaMicro : -deltaMicro);
  if (next === 0n) delete state.balances[k];
  else state.balances[k] = next.toString();
}
/** Spendable capacity on hop x→y: limit(y→x) − debt(x→y). */
export function capacityOf(state, x, y, cur) {
  const line = state.trustlines[lineKey(y, x, cur)];
  const limit = line ? BigInt(line.limit) : 0n;
  return limit - debtOf(state, x, y, cur);
}

const MAX_HOPS = 8;

/**
 * BFS shortest path from→to where EVERY hop carries amountMicro.
 * Neighbours of x are peers that extended x credit OR share a balance with x
 * (signed debt means owed-to-you credit is spendable with no trustline).
 */
export function findPath(state, from, to, cur, amountMicro) {
  const neighbours = new Map(); // x → Set(y)
  const add = (x, y) => {
    if (!neighbours.has(x)) neighbours.set(x, new Set());
    neighbours.get(x).add(y);
  };
  for (const line of Object.values(state.trustlines)) {
    if (line.currency === cur) add(line.debtor, line.creditor); // debtor may pay creditor
  }
  for (const k of Object.keys(state.balances)) {
    const [lo, hi, c] = k.split(SEP);
    if (c === cur) { add(lo, hi); add(hi, lo); }
  }
  const prev = new Map([[from, null]]);
  let frontier = [from];
  for (let depth = 0; depth < MAX_HOPS && frontier.length; depth += 1) {
    const next = [];
    for (const x of frontier) {
      for (const y of neighbours.get(x) ?? []) {
        if (prev.has(y)) continue;
        if (capacityOf(state, x, y, cur) < amountMicro) continue;
        prev.set(y, x);
        if (y === to) {
          const p = [to];
          for (let n = x; n !== null; n = prev.get(n)) p.unshift(n);
          return p;
        }
        next.push(y);
      }
    }
    frontier = next;
  }
  return null;
}

// ------------------------------------------------- RFC 8785 canonical JSON
// (vendored, same shape recordweb/ uses — plugin dirs stay self-contained)
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
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Hash a log entry (its own `hash` field excluded). */
export function entryHash(entry) {
  const { hash, ...core } = entry;
  return 'sha256:' + sha256(canonicalize(core));
}

// -------------------------------------------------------------------- plugin

export async function activate(api) {
  const prefix = api.prefix || '/ripple';
  const stateFile = path.join(api.storage.pluginDir(), 'state.json');

  /** { seq, tip, trustlines: {lineKey: {creditor,debtor,currency,limit}},
   *    balances: {pairKey: microString}, log: [entries] } */
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    state = { seq: 0, tip: null, trustlines: {}, balances: {}, log: [] };
  }

  // Every transition rewrites the whole file (state is small; the O(n) log
  // growth is a documented finding, same class as plugins#6 on relay/).
  function persist() {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  }

  /** Append a hash-chained transition and persist. Mutations that led here
   *  are synchronous, so a multi-hop payment commits atomically with its
   *  log entry — no awaits between the balance shifts and this write. */
  function logTransition(actor, type, params) {
    const entry = {
      seq: state.seq + 1, prev: state.tip, ts: new Date().toISOString(),
      actor, type, params,
    };
    entry.hash = entryHash(entry);
    state.seq = entry.seq;
    state.tip = entry.hash;
    state.log.push(entry);
    persist();
    return entry;
  }

  // ------------------------------------------------------------- http utils
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS')
    .header('access-control-allow-headers', 'authorization, content-type');
  const json = (reply, code, obj) => cors(reply).code(code)
    .header('content-type', 'application/json; charset=utf-8')
    .send(JSON.stringify(obj, null, 2));

  async function requireAgent(request, reply) {
    const agent = await api.auth.getAgent(request);
    if (!agent) { json(reply, 401, { error: 'authentication required' }); return null; }
    return agent;
  }
  const parseCurrency = (v) => {
    const cur = String(v ?? '').toUpperCase();
    return CUR_RE.test(cur) ? cur : null;
  };

  api.fastify.options(`${prefix}/*`, (request, reply) => cors(reply).code(204).send());

  // ------------------------------------------------------------------ whoami
  api.fastify.get(`${prefix}/api/whoami`, async (request, reply) => {
    const agent = await api.auth.getAgent(request);
    return json(reply, 200, { agent });
  });

  // ------------------------------------------------------------------- graph
  api.fastify.get(`${prefix}/api/graph`, (request, reply) => {
    const trustlines = Object.values(state.trustlines).map((l) => ({
      creditor: l.creditor, debtor: l.debtor, currency: l.currency,
      limit: fromMicro(BigInt(l.limit)),
      debt: fromMicro(bigMax(debtOf(state, l.debtor, l.creditor, l.currency), 0n)),
      available: fromMicro(bigMax(capacityOf(state, l.debtor, l.creditor, l.currency), 0n)),
    }));
    const balances = Object.entries(state.balances).map(([k, v]) => {
      const [lo, hi, currency] = k.split(SEP);
      const m = BigInt(v);
      return m >= 0n
        ? { debtor: lo, creditor: hi, currency, amount: fromMicro(m) }
        : { debtor: hi, creditor: lo, currency, amount: fromMicro(-m) };
    });
    return json(reply, 200, { trustlines, balances, seq: state.seq, tip: state.tip });
  });

  // ---------------------------------------------------------------- balances
  api.fastify.get(`${prefix}/api/balances`, (request, reply) => {
    const agent = request.query.agent;
    if (!agent) return json(reply, 400, { error: 'agent query parameter required' });
    const positions = [];
    const net = {}; // currency → micro
    for (const [k, v] of Object.entries(state.balances)) {
      const [lo, hi, currency] = k.split(SEP);
      if (lo !== agent && hi !== agent) continue;
      const peer = lo === agent ? hi : lo;
      const owes = debtOf(state, agent, peer, currency); // + agent owes peer
      positions.push({
        peer,
        currency,
        balance: fromMicro(-owes), // + peer owes the agent (their asset)
      });
      net[currency] = (net[currency] ?? 0n) - owes;
    }
    return json(reply, 200, {
      agent,
      positions,
      net: Object.fromEntries(Object.entries(net).map(([c, m]) => [c, fromMicro(m)])),
    });
  });

  // -------------------------------------------------------------- trustlines
  api.fastify.post(`${prefix}/api/trustlines`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const body = request.body || {};
    const peer = typeof body.peer === 'string' ? body.peer : null;
    const currency = parseCurrency(body.currency);
    const limit = body.limit === 0 ? 0n : toMicro(body.limit);
    if (!peer || peer.includes(SEP)) return json(reply, 400, { error: 'peer (agent id) required' });
    if (peer === agent) return json(reply, 400, { error: 'cannot extend credit to yourself' });
    if (!currency) return json(reply, 400, { error: 'currency must match [A-Z0-9]{1,12}' });
    if (limit === null) return json(reply, 400, { error: 'limit must be a positive number (≤ 6 dp) or 0' });
    const k = lineKey(agent, peer, currency);
    const existed = !!state.trustlines[k];
    state.trustlines[k] = { creditor: agent, debtor: peer, currency, limit: limit.toString() };
    const entry = logTransition(agent, existed ? 'update-trustline' : 'create-trustline',
      { peer, currency, limit: fromMicro(limit) });
    api.log.info(`ripple: ${agent} ${existed ? 'updated' : 'created'} trustline → ${peer} ${fromMicro(limit)} ${currency}`);
    return json(reply, existed ? 200 : 201, {
      trustline: { creditor: agent, debtor: peer, currency, limit: fromMicro(limit) }, entry,
    });
  });

  api.fastify.post(`${prefix}/api/trustlines/remove`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const body = request.body || {};
    const peer = typeof body.peer === 'string' ? body.peer : null;
    const currency = parseCurrency(body.currency);
    if (!peer || !currency) return json(reply, 400, { error: 'peer and currency required' });
    const k = lineKey(agent, peer, currency);
    if (!state.trustlines[k]) return json(reply, 404, { error: 'no such trustline' });
    // The IOU record lives in balances, not the line — but removing the line
    // while the peer still owes you strands your claim's context. Settle first.
    if (debtOf(state, peer, agent, currency) > 0n) {
      return json(reply, 409, { error: 'peer has outstanding debt on this line — settle before removing' });
    }
    delete state.trustlines[k];
    const entry = logTransition(agent, 'remove-trustline', { peer, currency });
    return json(reply, 200, { removed: { creditor: agent, debtor: peer, currency }, entry });
  });

  // -------------------------------------------------------------------- path
  function pathQuery(q) {
    const currency = parseCurrency(q.currency);
    const amount = toMicro(Number(q.amount));
    if (!q.from || !q.to || !currency || amount === null) return null;
    return { from: q.from, to: q.to, currency, amount };
  }
  api.fastify.get(`${prefix}/api/path`, (request, reply) => {
    const q = pathQuery(request.query);
    if (!q) return json(reply, 400, { error: 'from, to, currency, amount (positive, ≤ 6 dp) required' });
    const p = findPath(state, q.from, q.to, q.currency, q.amount);
    if (!p) return json(reply, 404, { error: 'no route with sufficient credit' });
    return json(reply, 200, { path: p, hops: p.length - 1 });
  });

  // ---------------------------------------------------------------- payments
  api.fastify.post(`${prefix}/api/payments`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const body = request.body || {};
    const to = typeof body.to === 'string' ? body.to : null;
    const currency = parseCurrency(body.currency);
    const amount = toMicro(body.amount);
    if (!to || to === agent) return json(reply, 400, { error: 'to (another agent id) required' });
    if (!currency) return json(reply, 400, { error: 'currency must match [A-Z0-9]{1,12}' });
    if (amount === null) return json(reply, 400, { error: 'amount must be a positive number (≤ 6 dp)' });
    const p = findPath(state, agent, to, currency, amount);
    if (!p) return json(reply, 404, { error: 'no route with sufficient credit' });
    // Atomic: synchronous shifts along the path, then one chained log write.
    for (let i = 0; i < p.length - 1; i += 1) adjustDebt(state, p[i], p[i + 1], currency, amount);
    const entry = logTransition(agent, 'send-payment',
      { from: agent, to, currency, amount: fromMicro(amount), path: p });
    api.log.info(`ripple: ${agent} paid ${to} ${fromMicro(amount)} ${currency} via ${p.length - 1} hop(s)`);
    return json(reply, 200, { payment: { from: agent, to, currency, amount: fromMicro(amount), path: p }, entry });
  });

  // ------------------------------------------------------------------ settle
  api.fastify.post(`${prefix}/api/settle`, async (request, reply) => {
    const agent = await requireAgent(request, reply); if (!agent) return reply;
    const body = request.body || {};
    const peer = typeof body.peer === 'string' ? body.peer : null;
    const currency = parseCurrency(body.currency);
    const amount = toMicro(body.amount);
    if (!peer || !currency || amount === null) {
      return json(reply, 400, { error: 'peer, currency and a positive amount (≤ 6 dp) required' });
    }
    // Only the CREDITOR (the one owed) may record repayment — you can only
    // shrink a claim you hold, never a claim held against you.
    const owed = debtOf(state, peer, agent, currency);
    if (owed < amount) {
      return json(reply, 409, { error: `peer owes ${fromMicro(bigMax(owed, 0n))} ${currency} — cannot settle ${fromMicro(amount)}` });
    }
    adjustDebt(state, peer, agent, currency, -amount);
    const entry = logTransition(agent, 'settle', { peer, currency, amount: fromMicro(amount) });
    return json(reply, 200, {
      settled: { peer, currency, amount: fromMicro(amount), remaining: fromMicro(owed - amount) }, entry,
    });
  });

  // --------------------------------------------------------------------- log
  api.fastify.get(`${prefix}/api/log`, (request, reply) => {
    const limit = Math.min(Number(request.query.limit) || 50, 500);
    return json(reply, 200, { seq: state.seq, tip: state.tip, entries: state.log.slice(-limit) });
  });
  api.fastify.get(`${prefix}/api/log/verify`, (request, reply) => {
    let prev = null;
    for (const e of state.log) {
      if (e.prev !== prev || entryHash(e) !== e.hash) {
        return json(reply, 200, { valid: false, brokenAt: e.seq, seq: state.seq });
      }
      prev = e.hash;
    }
    return json(reply, 200, { valid: true, seq: state.seq, tip: state.tip });
  });

  // ---------------------------------------------------------------------- UI
  api.fastify.get(prefix, (request, reply) => cors(reply).code(200)
    .header('content-type', 'text/html; charset=utf-8').send(uiPage(prefix)));

  api.log.info(`ripple: trustline node up at ${prefix} (Fugger-classic; `
    + `${Object.keys(state.trustlines).length} lines, seq ${state.seq})`);

  return { deactivate() { /* no timers/sockets */ } };
}

const bigMax = (a, b) => (a > b ? a : b);

// --------------------------------------------------------------------- UI page
// Server-rendered shell + fetch against the JSON api. Auth = a pasted pod
// bearer kept in localStorage (the forge-style login widget is a later wave).
function uiPage(prefix) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ripple — trustlines</title>
<style>
:root{--bg:#f6f7f5;--card:#fff;--ink:#1c2422;--soft:#5b6a66;--line:#d8ded9;--acc:#2c6e5a;--warn:#9a6417;--bad:#a6362f;
font-size:15px}
@media (prefers-color-scheme:dark){:root{--bg:#101614;--card:#182019;--ink:#e6ebe7;--soft:#93a29b;--line:#2b3630;--acc:#5bbe9c;--warn:#d69a4a;--bad:#e2776e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:24px 16px 80px}
h1{font-family:ui-monospace,monospace;font-size:1.35rem;margin:.2rem 0 .3rem}
h2{font-size:1rem;margin:0 0 10px}
p.sub{color:var(--soft);margin:0 0 20px;font-size:.92rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}
label{display:block;font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);margin:8px 0 4px}
input,select{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);font:13px ui-monospace,monospace}
button{margin-top:10px;padding:8px 16px;border:1px solid var(--acc);border-radius:7px;background:var(--acc);color:#fff;font:600 13px ui-monospace,monospace;cursor:pointer}
button.ghost{background:transparent;color:var(--acc)}
table{width:100%;border-collapse:collapse;font:12.5px ui-monospace,monospace}
td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line);word-break:break-all}
th{color:var(--soft);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;border-top:0}
.msg{font:12.5px ui-monospace,monospace;margin-top:10px;color:var(--soft);word-break:break-all}
.msg.ok{color:var(--acc)}.msg.bad{color:var(--bad)}
.who{font:12.5px ui-monospace,monospace;color:var(--acc);word-break:break-all}
.grid{display:grid;gap:16px}@media(min-width:720px){.grid{grid-template-columns:1fr 1fr}}
</style>
<div class="wrap">
<h1>Ripple <span style="color:var(--soft);font-weight:400">· trustlines</span></h1>
<p class="sub">Fugger-classic mutual credit: extend trust, pay through chains of it, settle out of band.
Payments route automatically through credit already granted — that's the whole trick.</p>

<div class="card"><h2>Identity</h2>
<label for="tok">Pod bearer token (POST /idp/credentials)</label>
<input id="tok" placeholder="paste access_token"><button id="save">Use token</button>
<div class="who" id="who">anonymous</div></div>

<div class="grid">
<div class="card"><h2>Extend trust</h2>
<label for="tpeer">Peer (WebID / did)</label><input id="tpeer">
<label for="tcur">Currency</label><input id="tcur" value="USD">
<label for="tlim">Limit (0 = freeze)</label><input id="tlim" value="100">
<button id="btrust">Set trustline</button><div class="msg" id="mtrust"></div></div>

<div class="card"><h2>Pay</h2>
<label for="pto">To</label><input id="pto">
<label for="pcur">Currency</label><input id="pcur" value="USD">
<label for="pamt">Amount</label><input id="pamt" value="10">
<button class="ghost" id="bpath">Find route</button> <button id="bpay">Send payment</button>
<div class="msg" id="mpay"></div></div>
</div>

<div class="card"><h2>Settle (record repayment received)</h2>
<label for="speer">Peer who paid you back</label><input id="speer">
<label for="scur">Currency</label><input id="scur" value="USD">
<label for="samt">Amount</label><input id="samt" value="10">
<button id="bsettle">Record settlement</button><div class="msg" id="msettle"></div></div>

<div class="card"><h2>Trust graph</h2><div id="graph">loading…</div></div>
<div class="card"><h2>Transition log <span id="chain" style="color:var(--soft);font-weight:400"></span></h2><div id="log"></div></div>
</div>
<script>
"use strict";
const P=${JSON.stringify(prefix)};
const $=id=>document.getElementById(id);
const tok=()=>localStorage.getItem('rippleToken')||'';
const hdrs=()=>tok()?{authorization:'Bearer '+tok(),'content-type':'application/json'}:{'content-type':'application/json'};
const api=(p,opt)=>fetch(P+'/api'+p,opt).then(async r=>({ok:r.ok,status:r.status,body:await r.json().catch(()=>({}))}));
const msg=(id,r,okText)=>{const e=$(id);e.className='msg '+(r.ok?'ok':'bad');e.textContent=r.ok?okText:(r.body.error||('error '+r.status))};
async function who(){const r=await api('/whoami',{headers:hdrs()});$('who').textContent=r.body.agent||'anonymous';}
async function graph(){const r=await api('/graph');const g=r.body;
 const tl=g.trustlines.map(l=>'<tr><td>'+esc(l.creditor)+'</td><td>'+esc(l.debtor)+'</td><td>'+l.currency+'</td><td>'+l.limit+'</td><td>'+l.debt+'</td><td>'+l.available+'</td></tr>').join('');
 const bl=g.balances.map(b=>'<tr><td>'+esc(b.debtor)+'</td><td>owes</td><td>'+esc(b.creditor)+'</td><td>'+b.amount+' '+b.currency+'</td></tr>').join('');
 $('graph').innerHTML='<table><tr><th>Creditor</th><th>Debtor</th><th>Cur</th><th>Limit</th><th>Debt</th><th>Avail</th></tr>'+(tl||'<tr><td colspan=6 style="color:var(--soft)">no trustlines yet</td></tr>')+'</table>'
  +(bl?'<h2 style="margin-top:14px">IOUs</h2><table>'+bl+'</table>':'');}
async function log(){const r=await api('/log?limit=15');const v=await api('/log/verify');
 $('chain').textContent='· seq '+r.body.seq+' · chain '+(v.body.valid?'✓ valid':'✗ BROKEN');
 $('log').innerHTML='<table><tr><th>#</th><th>Actor</th><th>Type</th><th>Params</th></tr>'+r.body.entries.slice().reverse().map(e=>'<tr><td>'+e.seq+'</td><td>'+esc(short(e.actor))+'</td><td>'+e.type+'</td><td>'+esc(JSON.stringify(e.params))+'</td></tr>').join('')+'</table>';}
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const short=s=>s&&s.length>42?s.slice(0,20)+'…'+s.slice(-16):s;
const refresh=()=>{who();graph();log();};
$('save').onclick=()=>{localStorage.setItem('rippleToken',$('tok').value.trim());refresh();};
$('btrust').onclick=async()=>{const r=await api('/trustlines',{method:'POST',headers:hdrs(),body:JSON.stringify({peer:$('tpeer').value.trim(),currency:$('tcur').value.trim(),limit:Number($('tlim').value)})});msg('mtrust',r,'trustline set (seq '+(r.body.entry||{}).seq+')');refresh();};
$('bpath').onclick=async()=>{const meR=await api('/whoami',{headers:hdrs()});const from=meR.body.agent;if(!from){msg('mpay',{ok:false,body:{error:'set a token first'}});return}
 const r=await api('/path?from='+encodeURIComponent(from)+'&to='+encodeURIComponent($('pto').value.trim())+'&currency='+encodeURIComponent($('pcur').value.trim())+'&amount='+encodeURIComponent($('pamt').value));
 msg('mpay',r,r.ok?('route: '+r.body.path.map(short).join(' → ')):'');};
$('bpay').onclick=async()=>{const r=await api('/payments',{method:'POST',headers:hdrs(),body:JSON.stringify({to:$('pto').value.trim(),currency:$('pcur').value.trim(),amount:Number($('pamt').value)})});msg('mpay',r,r.ok?('paid via '+r.body.payment.path.length+' node path'):'');refresh();};
$('bsettle').onclick=async()=>{const r=await api('/settle',{method:'POST',headers:hdrs(),body:JSON.stringify({peer:$('speer').value.trim(),currency:$('scur').value.trim(),amount:Number($('samt').value)})});msg('msettle',r,r.ok?('settled — remaining '+r.body.settled.remaining):'');refresh();};
$('tok').value=tok();refresh();setInterval(()=>{graph();log();},5000);
</script>`;
}
