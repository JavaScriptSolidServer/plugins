// markets/ui.js — the trading UI, server-rendered as one static HTML
// string (the forge/ pattern: zero deps, zero build).
//
// Two things this file deliberately does NOT do any more:
//
//   - it never stores a pod bearer. The token is posted ONCE to
//     {prefix}/api/session and exchanged for an HttpOnly, SameSite=Strict
//     cookie scoped to this plugin, so script cannot read it and a stored
//     XSS elsewhere on the pod origin cannot exfiltrate pod-wide access.
//     Every fetch is same-origin with credentials: 'same-origin'.
//   - it never asks a bettor to think in shares. The ticket is
//     STAKE-FIRST — "risk 10, to win 24.60 (2.46)" — with the share count
//     as a detail line. The server's /quote?spend= does the inversion.
//
// The page speaks the same visual language as the rest of these plugins:
// dense rows, light chrome, one accent per outcome, tabular numerals.

export function renderUi(prefix) {
  const P = JSON.stringify(prefix);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Markets — prediction markets on your pod</title>
<style>
  :root{--surface:#f2f4f1;--card:#fff;--line:#dfe5df;--ink:#1b231e;--ink2:#4d5a52;
    --ink3:#7f8b83;--accent:#0f6a4e;--up:#0f7d5c;--mid:#97a09c;--down:#b45309;--bad:#b3261e}
  *{box-sizing:border-box}
  body{margin:0;background:var(--surface);color:var(--ink);
    font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--accent)}
  .topbar{background:var(--card);border-bottom:1px solid var(--line);padding:.55rem 1rem;
    display:flex;align-items:center;gap:.8rem;position:sticky;top:0;z-index:10}
  .brand{font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:1.02rem;
    text-decoration:none;color:inherit}
  .brand span{color:var(--up)}
  .spacer{flex:1}
  .chip{color:var(--ink2);font-size:.85rem;font-variant-numeric:tabular-nums}
  .chip b{color:var(--ink)}
  main{max-width:46rem;margin:0 auto;padding:.6rem .6rem 5rem}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.85rem;margin:.6rem 0}
  h1{font-size:1.05rem;margin:.4rem .2rem}
  h2{font-size:.95rem;margin:0 0 .5rem}
  .hint{color:var(--ink3);font-size:.8rem}
  .tabs{display:flex;gap:.3rem;margin:.5rem .2rem}
  .tabs a{padding:.45rem .8rem;border-radius:99px;text-decoration:none;color:var(--ink2);
    font-size:.85rem;font-weight:600;min-height:36px;display:flex;align-items:center}
  .tabs a.on{background:var(--accent);color:#fff}
  .mrow{display:block;padding:.7rem .4rem;border-bottom:1px solid var(--line);
    text-decoration:none;color:inherit}
  .mrow:last-child{border-bottom:0}
  .mrow:hover{background:#eaf0ea}
  .mrow .t{font-weight:600}
  .meta{color:var(--ink3);font-size:.78rem;margin-top:.15rem}
  .bar{display:flex;gap:2px;height:20px;border-radius:5px;overflow:hidden;margin-top:.4rem}
  .bar div{display:flex;align-items:center;justify-content:center;color:#fff;
    font-size:.68rem;font-weight:700;min-width:1.6rem;overflow:hidden;white-space:nowrap}
  .status{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .status.open{color:var(--up)} .status.closed{color:var(--ink3)}
  .status.resolving{color:var(--down)} .status.disputed{color:var(--bad)}
  .status.resolved{color:var(--accent)} .status.void{color:var(--bad)}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  td,th{padding:.45rem .4rem;border-bottom:1px solid var(--line);text-align:left}
  th{color:var(--ink3);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  input,select,button,textarea{font:inherit;padding:.55rem .6rem;border:1px solid var(--line);
    border-radius:8px;background:#fff;color:var(--ink);min-height:44px}
  button{cursor:pointer;font-weight:600}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.buy{background:var(--up);border-color:var(--up);color:#fff;flex:1}
  button.sell{background:#fff;border-color:var(--down);color:var(--down)}
  button.small{min-height:34px;padding:.3rem .6rem;font-size:.8rem}
  button:disabled{opacity:.45;cursor:default}
  .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.5rem 0}
  .msg{font-size:.82rem;margin:.4rem 0;color:var(--ink2)} .msg.err{color:var(--bad)}
  .hidden{display:none}
  .pill{font-size:.72rem;border:1px solid var(--line);border-radius:99px;padding:.15rem .55rem;color:var(--ink2)}
  .pnl.up{color:var(--up);font-weight:600} .pnl.down{color:var(--bad);font-weight:600}
  .ticket{background:#f7faf7;border:1px solid var(--line);border-radius:10px;padding:.7rem;margin-top:.6rem}
  .ticket .big{font-size:1.35rem;font-weight:700;font-variant-numeric:tabular-nums}
  .stakes{display:flex;gap:.4rem;flex-wrap:wrap}
  .stakes button{min-height:38px}
  .out-btn{display:flex;justify-content:space-between;align-items:center;width:100%;
    border:1px solid var(--line);border-radius:8px;background:#fff;margin-bottom:.35rem;
    padding:.6rem .7rem;cursor:pointer;min-height:48px}
  .out-btn.on{border-color:var(--accent);box-shadow:0 0 0 2px rgba(15,106,78,.15)}
  .out-btn .px{font-weight:700;font-variant-numeric:tabular-nums}
  .toast{position:fixed;left:50%;transform:translateX(-50%);bottom:1.2rem;z-index:50;
    background:var(--ink);color:#fff;padding:.7rem 1rem;border-radius:10px;font-size:.9rem;
    box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:90vw}
  .spark{width:100%;height:52px;display:block}
  @media(max-width:520px){ .row{gap:.4rem} main{padding:.4rem .4rem 5rem} }
</style>
</head>
<body>
<div class="topbar">
  <a class="brand" href="${prefix}">Mar<span>kets</span></a>
  <span class="chip hidden" id="live">● live</span>
  <span class="spacer"></span>
  <span class="chip">⛁ <b id="bal">—</b> credits</span>
  <button class="small" id="signin">Sign in</button>
</div>
<main>
  <div class="card hidden" id="auth-card">
    <h2>Start a session</h2>
    <p class="hint">Paste a pod bearer token (from <code>POST /idp/credentials</code>). It is exchanged
       for a session cookie scoped to this app and <b>never stored in the browser</b> —
       so this page can't leak access to the rest of your pod.</p>
    <div class="row">
      <input id="token" type="password" placeholder="pod bearer token" style="flex:1;min-width:12rem">
      <button class="primary" id="do-signin">Start session</button>
    </div>
    <div class="msg" id="auth-msg"></div>
  </div>

  <div id="list-view">
    <nav class="tabs" id="tabs"></nav>
    <div class="row" style="margin:.2rem">
      <input id="search" placeholder="Search markets" style="flex:1">
    </div>
    <div class="card" id="list">loading…</div>
    <div class="row" style="justify-content:center">
      <button class="small hidden" id="more">Load more</button>
    </div>

    <div class="card hidden" id="me-card">
      <h2>My positions</h2>
      <div id="positions" class="hint">no positions yet</div>
      <h2 style="margin-top:.9rem">Settled</h2>
      <div id="settled" class="hint">nothing settled yet</div>
    </div>

    <details class="card">
      <summary style="cursor:pointer;font-weight:600">Create a market</summary>
      <p class="hint">You escrow b·ln(n) credits as maker liquidity. You get your escrow back
         (never more) plus a share of trade fees at settlement — and you may not trade in
         your own market.</p>
      <div class="row"><input id="c-title" placeholder="Question — e.g. Arsenal v Spurs: full-time result" style="flex:1;min-width:14rem"></div>
      <div class="row"><input id="c-outcomes" placeholder="Outcomes, comma-separated — Arsenal, Draw, Spurs" style="flex:1;min-width:14rem"></div>
      <div class="row">
        <input id="c-category" placeholder="Category (e.g. football)" style="width:11rem">
        <label class="hint">closes <input id="c-closes" type="datetime-local"></label>
        <label class="hint">liquidity b <input id="c-b" type="number" value="100" min="10" style="width:6.5rem"></label>
      </div>
      <div class="row">
        <span class="hint" id="c-escrow">escrow: —</span>
        <span class="spacer"></span>
        <button class="primary" id="c-go">Create market</button>
      </div>
      <div class="msg" id="c-msg"></div>
    </details>
  </div>

  <div id="detail-view" class="hidden">
    <p style="margin:.5rem .2rem"><a href="#" id="back">&larr; all markets</a></p>
    <div class="card">
      <h2 id="d-title"></h2>
      <div class="hint" id="d-meta"></div>
      <div class="bar" id="d-bar"></div>
      <svg class="spark" id="d-spark" viewBox="0 0 300 52" preserveAspectRatio="none"></svg>
      <div id="d-outcomes" style="margin-top:.6rem"></div>

      <div class="ticket" id="ticket">
        <div class="row" style="margin:0 0 .4rem">
          <span class="hint">Risk</span>
          <input id="t-stake" type="number" min="0" step="1" value="10" style="width:6.5rem">
          <span class="hint">credits on <b id="t-pick">—</b></span>
        </div>
        <div class="stakes">
          <button class="small" data-stake="5">5</button>
          <button class="small" data-stake="10">10</button>
          <button class="small" data-stake="25">25</button>
          <button class="small" data-stake="100">100</button>
          <button class="small" data-stake="max">Max</button>
        </div>
        <div class="row" style="margin:.6rem 0 .2rem">
          <div>
            <div class="hint">To win</div>
            <div class="big" id="t-towin">—</div>
          </div>
          <div>
            <div class="hint">Odds</div>
            <div class="big" id="t-odds">—</div>
          </div>
          <span class="spacer"></span>
          <button class="buy" id="t-buy">Place bet</button>
        </div>
        <div class="hint" id="t-detail"></div>
        <div class="msg" id="t-msg"></div>
      </div>

      <div id="d-position" class="hidden" style="margin-top:.7rem"></div>

      <div class="row hidden" id="oracle-row">
        <span class="pill">oracle</span>
        <select id="o-outcome" style="flex:1;min-width:8rem"></select>
        <button id="o-resolve">Resolve</button>
        <button id="o-void">Void</button>
        <button id="o-close">Close early</button>
      </div>
      <div class="row hidden" id="dispute-row">
        <span class="hint">Resolution looks wrong?</span>
        <button id="o-dispute" class="small">Dispute</button>
      </div>
    </div>
  </div>
</main>
<script>
(() => {
  const PREFIX = ${P};
  const API = PREFIX + '/api';
  const $ = (id) => document.getElementById(id);
  const COLORS = ['#0f7d5c','#97a09c','#b45309','#1d4ed8','#7c3aed','#0e7490',
                  '#a21caf','#4d7c0f','#b91c1c','#334155','#9a3412','#115e59'];
  let me = null, current = null, pick = 0, tab = 'open', cursor = null, quoteSeq = 0, lastQuote = null;

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      credentials: 'same-origin',
      ...opts,
      headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || ('error ' + res.status)); e.status = res.status; e.body = body; throw e; }
    return body;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (p) => (p * 100).toFixed(1) + '%';
  const cr = (n) => Number(n).toFixed(2);
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  function toast(text, ms = 4200) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function countdown(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'closed';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
          m = Math.floor((s % 3600) / 60);
    if (d > 0) return 'closes in ' + d + 'd ' + h + 'h';
    if (h > 0) return 'closes in ' + h + 'h ' + m + 'm';
    return 'closes in ' + m + 'm ' + (s % 60) + 's';
  }

  function priceBar(el, outcomes, prices) {
    el.innerHTML = '';
    prices.forEach((p, i) => {
      const d = document.createElement('div');
      d.style.flex = String(Math.max(p, 0.02) * 1000);
      d.style.background = COLORS[i % COLORS.length];
      d.textContent = p >= 0.08 ? pct(p) : '';
      d.title = outcomes[i] + ' ' + pct(p);
      el.appendChild(d);
    });
  }

  // price history → one polyline per outcome, time on x, probability on y
  function sparkline(el, history, n) {
    el.innerHTML = '';
    if (!history || history.length < 2) return;
    const t0 = history[0].t, t1 = history[history.length - 1].t || (t0 + 1);
    const span = Math.max(1, t1 - t0);
    for (let k = 0; k < n; k++) {
      const pts = history.map((h) => {
        const x = ((h.t - t0) / span) * 300;
        const y = 50 - h.p[k] * 48;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', pts);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', COLORS[k % COLORS.length]);
      line.setAttribute('stroke-width', '1.6');
      el.appendChild(line);
    }
  }

  // ------------------------------------------------------------- session
  async function refreshMe(quiet) {
    try {
      const prev = me;
      me = await api('/me');
      $('bal').textContent = cr(me.balance);
      $('signin').textContent = 'Sign out';
      $('auth-card').classList.add('hidden');
      $('me-card').classList.remove('hidden');
      renderMe();
      // A settlement that landed since the last poll is the moment that
      // matters most in a betting product — announce it.
      if (prev && me.settlements.length && (!prev.settlements.length
          || prev.settlements[0].at !== me.settlements[0].at)) {
        const s = me.settlements[0];
        toast(s.payout > 0
          ? 'Settled: ' + s.title + ' — you won ' + cr(s.payout) + ' credits'
          : 'Settled: ' + s.title + ' — no return this time');
      }
    } catch (e) {
      me = null;
      $('bal').textContent = '—';
      $('signin').textContent = 'Sign in';
      $('me-card').classList.add('hidden');
      if (!quiet && e.status !== 401) $('auth-msg').textContent = e.message;
    }
  }

  function renderMe() {
    const el = $('positions');
    if (!me.positions.length) el.innerHTML = '<span class="hint">no positions yet</span>';
    else {
      el.innerHTML = '<table><thead><tr><th>Market</th><th class="num">Value</th><th class="num">P&amp;L</th><th></th></tr></thead><tbody>'
        + me.positions.map((p) => {
          const cls = p.unrealizedPnl >= 0 ? 'up' : 'down';
          const sign = p.unrealizedPnl >= 0 ? '+' : '';
          return '<tr><td><a href="#m/' + esc(p.market) + '">' + esc(p.title) + '</a>'
            + '<div class="meta">' + p.shares.map((s, i) => s > 0
                ? cr(s) + ' × ' + esc(p.outcomes[i]) + ' @ ' + pct(p.prices[i]) : '').filter(Boolean).join(' · ')
            + '</div></td>'
            + '<td class="num">' + cr(p.totalValue) + '</td>'
            + '<td class="num"><span class="pnl ' + cls + '">' + sign + cr(p.unrealizedPnl) + '</span></td>'
            + '<td class="num">' + (p.tradable
                ? '<button class="small cashout" data-m="' + esc(p.market) + '">Cash out</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>';
      el.querySelectorAll('.cashout').forEach((b) => { b.onclick = () => cashOut(b.dataset.m); });
    }
    const s = $('settled');
    s.innerHTML = me.settlements.length
      ? '<table><tbody>' + me.settlements.slice(0, 10).map((x) =>
          '<tr><td>' + esc(x.title) + '<div class="meta">' + esc(x.status)
          + (x.outcome != null ? '' : ' (voided)') + ' · ' + new Date(x.at).toLocaleString() + '</div></td>'
          + '<td class="num"><span class="pnl ' + (x.payout > 0 ? 'up' : 'down') + '">+'
          + cr(x.payout) + '</span></td></tr>').join('') + '</tbody></table>'
      : '<span class="hint">nothing settled yet</span>';
  }

  async function cashOut(marketId) {
    const m = await api('/markets/' + encodeURIComponent(marketId));
    if (!m.position) return;
    const i = m.position.shares.findIndex((s) => s > 0);
    if (i < 0) return;
    const shares = m.position.shares[i];
    const q = await api('/markets/' + m.id + '/quote?side=sell&outcome=' + i + '&shares=' + shares);
    if (!confirm('Cash out ' + cr(shares) + ' × ' + m.outcomes[i] + ' for about ' + cr(q.total) + ' credits?')) return;
    try {
      await api('/markets/' + m.id + '/trade', {
        method: 'POST',
        headers: { 'idempotency-key': uid() },
        body: JSON.stringify({ side: 'sell', outcome: i, shares, minProceeds: q.total * 0.98 }),
      });
      toast('Cashed out for ' + cr(q.total) + ' credits');
      await refreshMe(); await route();
    } catch (e) { toast(e.message); }
  }

  // --------------------------------------------------------------- list
  const TABS = [['open', 'Open'], ['closed', 'In play'], ['settled', 'Settled'], ['mine', 'Mine']];
  function renderTabs() {
    $('tabs').innerHTML = TABS.map(([k, label]) =>
      '<a href="#" data-tab="' + k + '" class="' + (tab === k ? 'on' : '') + '">' + label + '</a>').join('');
    $('tabs').querySelectorAll('a').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); tab = a.dataset.tab; cursor = null; renderTabs(); renderList(); };
    });
  }

  async function renderList(append) {
    const params = new URLSearchParams();
    if (tab === 'mine') { if (!me) { $('list').innerHTML = '<span class="hint">sign in to see your markets</span>'; return; } params.set('creator', me.agent); }
    else params.set('status', tab);
    const search = $('search').value.trim();
    if (search) params.set('q', search);
    if (append && cursor) params.set('cursor', cursor);
    let data;
    try { data = await api('/markets?' + params.toString()); }
    catch (e) { $('list').innerHTML = '<span class="hint">' + esc(e.message) + '</span>'; return; }
    cursor = data.nextCursor;
    $('more').classList.toggle('hidden', !cursor);
    const el = $('list');
    if (!append) el.innerHTML = '';
    if (!data.markets.length && !append) {
      el.innerHTML = '<span class="hint">'
        + (search ? 'No markets match “' + esc(search) + '”.' : 'No markets here yet — create one below.')
        + '</span>';
      return;
    }
    for (const m of data.markets) {
      const a = document.createElement('a');
      a.className = 'mrow'; a.href = '#m/' + m.id;
      a.innerHTML = '<span class="t">' + esc(m.title) + '</span> '
        + '<span class="status ' + esc(m.status) + '">' + esc(m.status)
        + (m.status === 'resolved' && m.resolvedOutcome != null ? ' · ' + esc(m.outcomes[m.resolvedOutcome]) : '') + '</span>'
        + '<div class="meta">' + (m.category ? esc(m.category) + ' · ' : '')
        + (m.tradable ? countdown(m.closesAt) : new Date(m.closesAt).toLocaleString())
        + ' · ' + m.trades + ' trades · pool ' + cr(m.liquidity) + '</div>';
      const bar = document.createElement('div'); bar.className = 'bar';
      priceBar(bar, m.outcomes, m.prices);
      a.appendChild(bar);
      el.appendChild(a);
    }
  }

  // ------------------------------------------------------------- detail
  async function renderDetail(id, keepTicket) {
    let m;
    try { m = await api('/markets/' + encodeURIComponent(id)); }
    catch (e) { toast(e.message); location.hash = ''; return; }
    current = m;
    $('list-view').classList.add('hidden');
    $('detail-view').classList.remove('hidden');
    $('d-title').textContent = m.title;
    $('d-meta').innerHTML = '<span class="status ' + esc(m.status) + '">' + esc(m.status) + '</span>'
      + (m.status === 'resolved' && m.resolvedOutcome != null ? ' → <b>' + esc(m.outcomes[m.resolvedOutcome]) + '</b>' : '')
      + (m.status === 'resolving' ? ' → <b>' + esc(m.outcomes[m.resolvedOutcome]) + '</b> · settles ' + new Date(m.settleAt).toLocaleTimeString() + ' (disputable)' : '')
      + ' · ' + (m.tradable ? countdown(m.closesAt) : 'closed ' + new Date(m.closesAt).toLocaleString())
      + ' · pool ' + cr(m.liquidity) + ' · ' + m.trades + ' trades'
      + (m.description ? '<br>' + esc(m.description) : '');
    priceBar($('d-bar'), m.outcomes, m.prices);
    sparkline($('d-spark'), m.history, m.outcomes.length);

    if (!keepTicket && pick >= m.outcomes.length) pick = 0;
    $('d-outcomes').innerHTML = m.outcomes.map((o, i) =>
      '<button class="out-btn ' + (i === pick ? 'on' : '') + '" data-i="' + i + '">'
      + '<span><span style="color:' + COLORS[i % COLORS.length] + '">●</span> ' + esc(o) + '</span>'
      + '<span class="px">' + pct(m.prices[i]) + ' · ' + (1 / Math.max(m.prices[i], 1e-6)).toFixed(2) + '</span>'
      + '</button>').join('');
    $('d-outcomes').querySelectorAll('.out-btn').forEach((b) => {
      b.onclick = () => { pick = Number(b.dataset.i); renderDetail(m.id, true); };
    });
    $('t-pick').textContent = m.outcomes[pick];

    const canTrade = m.tradable && me && me.agent !== m.oracle && me.agent !== m.creator;
    $('ticket').classList.toggle('hidden', !m.tradable);
    $('t-buy').disabled = !canTrade;
    $('t-buy').textContent = !me ? 'Sign in to bet'
      : (me.agent === m.oracle || me.agent === m.creator) ? 'You run this market' : 'Place bet';

    const pos = m.position;
    const pd = $('d-position');
    if (pos && pos.shares.some((s) => s > 0)) {
      pd.classList.remove('hidden');
      const cls = pos.unrealizedPnl >= 0 ? 'up' : 'down';
      pd.innerHTML = '<div class="card" style="margin:0"><h2>Your position</h2>'
        + '<table><tbody>' + pos.shares.map((s, i) => s > 0
          ? '<tr><td>' + cr(s) + ' × ' + esc(m.outcomes[i]) + '</td>'
            + '<td class="num">worth ' + cr(pos.value[i]) + '</td>'
            + '<td class="num">' + (m.tradable ? '<button class="small sell-one" data-i="' + i + '">Cash out</button>' : '') + '</td></tr>'
          : '').join('')
        + '</tbody></table>'
        + '<div class="row"><span class="hint">cost ' + cr(pos.totalCost) + ' · value ' + cr(pos.totalValue)
        + '</span><span class="spacer"></span><span class="pnl ' + cls + '">'
        + (pos.unrealizedPnl >= 0 ? '+' : '') + cr(pos.unrealizedPnl) + '</span></div></div>';
      pd.querySelectorAll('.sell-one').forEach((b) => { b.onclick = () => cashOut(m.id); });
    } else pd.classList.add('hidden');

    const isOracle = me && (me.agent === m.oracle);
    $('oracle-row').classList.toggle('hidden', !(isOracle && (m.status === 'open')));
    $('o-outcome').innerHTML = m.outcomes.map((o, i) => '<option value="' + i + '">' + esc(o) + '</option>').join('');
    $('dispute-row').classList.toggle('hidden', !(m.status === 'resolving' && pos));
    quote();
  }

  // Stake-first quote: ask the server how many shares this stake buys and
  // what it returns, so the bettor sees "risk / to win / odds".
  async function quote() {
    if (!current || !current.tradable) { $('t-towin').textContent = '—'; $('t-odds').textContent = '—'; return; }
    const stake = Number($('t-stake').value);
    if (!(stake > 0)) { $('t-towin').textContent = '—'; $('t-odds').textContent = '—'; $('t-detail').textContent = ''; return; }
    const seq = ++quoteSeq;
    try {
      const q = await api('/markets/' + current.id + '/quote?side=buy&outcome=' + pick + '&spend=' + stake);
      if (seq !== quoteSeq) return; // a newer quote already landed
      lastQuote = q;
      $('t-towin').textContent = cr(q.toWin);
      $('t-odds').textContent = q.odds ? q.odds.toFixed(2) : '—';
      $('t-detail').textContent = cr(q.shares) + ' shares at avg ' + pct(q.avgPrice)
        + ' · stake ' + cr(q.total) + ' (fee ' + cr(q.fee) + ') · profit if right ' + cr(q.profit)
        + ' · worst case you pay ≤ ' + cr(q.total * 1.02);
    } catch (e) {
      if (seq !== quoteSeq) return;
      lastQuote = null;
      $('t-towin').textContent = '—'; $('t-odds').textContent = '—';
      $('t-detail').textContent = e.message;
    }
  }

  async function placeBet() {
    if (!lastQuote) return;
    $('t-msg').textContent = ''; $('t-msg').className = 'msg';
    $('t-buy').disabled = true;
    try {
      const r = await api('/markets/' + current.id + '/trade', {
        method: 'POST',
        headers: { 'idempotency-key': uid() },
        body: JSON.stringify({ side: 'buy', outcome: pick, spend: Number($('t-stake').value), maxCost: lastQuote.total * 1.02 }),
      });
      toast('Bet placed — ' + cr(r.shares) + ' × ' + r.outcomeLabel + ' to win ' + cr(r.toWin));
      await refreshMe(); await renderDetail(current.id, true);
    } catch (e) {
      $('t-msg').textContent = e.message + (e.status === 409 ? ' — refresh the quote and try again' : '');
      $('t-msg').className = 'msg err';
    } finally { $('t-buy').disabled = false; }
  }

  async function act(action, body, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await api('/markets/' + current.id + '/' + action, { method: 'POST', body: JSON.stringify(body || {}) });
      await refreshMe(); await renderDetail(current.id, true);
      toast(action + ' ok');
    } catch (e) { $('t-msg').textContent = e.message; $('t-msg').className = 'msg err'; }
  }

  async function route() {
    const h = location.hash;
    if (h.startsWith('#m/')) return renderDetail(h.slice(3), true);
    $('detail-view').classList.add('hidden');
    $('list-view').classList.remove('hidden');
    current = null; cursor = null;
    renderTabs();
    return renderList();
  }

  // ------------------------------------------------------------- events
  $('signin').onclick = async () => {
    if (me) { await api('/session', { method: 'DELETE' }); me = null; await refreshMe(true); await route(); return; }
    $('auth-card').classList.toggle('hidden');
    $('token').focus();
  };
  $('do-signin').onclick = async () => {
    $('auth-msg').textContent = 'starting session…'; $('auth-msg').className = 'msg';
    try {
      await api('/session', { method: 'POST', headers: { authorization: 'Bearer ' + $('token').value.trim() } });
      $('token').value = '';
      await refreshMe(); await route();
      toast('Signed in');
    } catch (e) { $('auth-msg').textContent = e.message; $('auth-msg').className = 'msg err'; }
  };
  $('back').onclick = (e) => { e.preventDefault(); location.hash = ''; };
  $('t-buy').onclick = placeBet;
  $('more').onclick = () => renderList(true);
  let searchTimer;
  $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { cursor = null; renderList(); }, 250); };
  let quoteTimer;
  $('t-stake').oninput = () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(quote, 220); };
  document.querySelectorAll('[data-stake]').forEach((b) => {
    b.onclick = () => {
      $('t-stake').value = b.dataset.stake === 'max' ? Math.floor((me ? me.balance : 0) * 100) / 100 : b.dataset.stake;
      quote();
    };
  });
  $('o-resolve').onclick = () => {
    const i = Number($('o-outcome').value);
    act('resolve', { outcome: i },
      'Resolve "' + current.title + '" as "' + current.outcomes[i] + '"?\\n\\n'
      + 'This pays out the whole pool after the dispute window. It cannot be undone.');
  };
  $('o-void').onclick = () => act('void', {}, 'Void this market? Every share is redeemed at the average price over the window before close.');
  $('o-close').onclick = () => act('close', {});
  $('o-dispute').onclick = () => {
    const reason = prompt('Why is this resolution wrong?');
    if (reason) act('dispute', { reason });
  };
  $('c-go').onclick = async () => {
    $('c-msg').textContent = ''; $('c-msg').className = 'msg';
    try {
      const outcomes = $('c-outcomes').value.split(',').map((s) => s.trim()).filter(Boolean);
      const m = await api('/markets', {
        method: 'POST',
        headers: { 'idempotency-key': uid() },
        body: JSON.stringify({
          title: $('c-title').value,
          outcomes,
          category: $('c-category').value,
          closesAt: $('c-closes').value ? new Date($('c-closes').value).toISOString() : '',
          b: Number($('c-b').value),
        }),
      });
      location.hash = '#m/' + m.id;
      await refreshMe();
      toast('Market created');
    } catch (e) { $('c-msg').textContent = e.message; $('c-msg').className = 'msg err'; }
  };
  const escrowPreview = () => {
    const n = $('c-outcomes').value.split(',').map((s) => s.trim()).filter(Boolean).length;
    const b = Number($('c-b').value);
    $('c-escrow').textContent = (n >= 2 && b > 0)
      ? 'escrow: ' + cr(b * Math.log(n)) + ' credits (b·ln ' + n + ')'
      : 'escrow: —';
  };
  $('c-outcomes').oninput = $('c-b').oninput = escrowPreview;
  window.addEventListener('hashchange', () => route());

  // Live feed, with reconnect. Only re-render when the event concerns
  // what is on screen, so someone else's trade can't reset your ticket.
  let ws, backoff = 1000;
  function connect() {
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + PREFIX + '/ws');
    } catch { return; }
    ws.onopen = () => { backoff = 1000; $('live').classList.remove('hidden'); };
    ws.onclose = () => {
      $('live').classList.add('hidden');
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (current) { if (msg.market && msg.market.id === current.id) renderDetail(current.id, true); }
      else renderList();
      if (msg.type === 'settle' && me) refreshMe();
    };
  }
  connect();
  setInterval(() => { if (current) { const el = $('d-meta'); if (el && current.tradable) renderDetail(current.id, true); } }, 30000);
  escrowPreview();
  refreshMe(true).then(route);
})();
</script>
</body>
</html>`;
}
