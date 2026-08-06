// markets/ui.js — the trading UI, server-rendered as one static HTML
// string (the forge/ pattern: zero deps, zero build, strict CSP).
//
// Two things this file deliberately does NOT do:
//
//   - it never stores a pod bearer. The token is posted ONCE to
//     {prefix}/api/session and exchanged for an HttpOnly, SameSite=Strict
//     cookie scoped to this plugin, so script cannot read it and a stored
//     XSS elsewhere on the pod origin cannot exfiltrate pod-wide access.
//   - it never asks a bettor to think in shares. The ticket is
//     STAKE-FIRST — "risk 10, returns 24.60 at 2.46" — with the share
//     count demoted to a detail line. The server's /quote?spend= does the
//     inversion.
//
// DESIGN SYSTEM. Everything below is driven by tokens declared once in
// :root — a 4px spacing scale, a 6-step type scale, one brand green, an
// outcome palette with no grey in it, and semantic up/down reserved
// exclusively for P&L. Changing the palette is a one-place edit.
// Deliberate consequences of the token rules:
//   - grey is never an outcome colour (grey reads as "disabled", and
//     white-on-grey measured 2.68:1 — below AA);
//   - --up/--down never colour a button, only a number;
//   - one left edge: the gutter lives on `main`, children sit flush.

export function renderUi(prefix, opts = {}) {
  const accounts = !!opts.accounts; // standalone host: register/login form
  const brand = typeof opts.brand === 'string' && opts.brand ? opts.brand : 'Markets';
  const tagline = typeof opts.tagline === 'string' && opts.tagline ? opts.tagline : 'prediction markets on your pod';
  // Social/OG affordances for standalone hosts; harmless defaults for JSS.
  const mk = opts.market && typeof opts.market === 'object' ? opts.market : null;
  const esc0 = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // A shared market should unfurl as the QUESTION and its live odds — that
  // is the whole reason someone sends the link.
  const mkOdds = mk ? mk.outcomes
    .map((o, i) => `${o} ${(mk.prices[i] * 100).toFixed(0)}%`).slice(0, 4).join(' · ') : '';
  const mkWhen = mk ? (() => {
    const d = Math.round((mk.closesAt - Date.now()) / 86400000);
    return mk.status === 'open' && d > 0 ? `closes in ${d}d` : mk.status;
  })() : '';
  const ogTitle = mk ? esc0(mk.title) : `${brand} — ${tagline}`;
  const ogImage = typeof opts.ogImage === 'string' ? opts.ogImage : '';
  const ogUrl = typeof opts.ogUrl === 'string' ? opts.ogUrl : '';
  const favicon = typeof opts.favicon === 'string' && opts.favicon ? opts.favicon
    : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Crect x='1' y='11' width='4.5' height='8' rx='1.5' fill='%23667' opacity='.6'/%3E%3Crect x='7.75' y='6' width='4.5' height='13' rx='1.5' fill='%23667'/%3E%3Crect x='14.5' y='1' width='4.5' height='18' rx='1.5' fill='%2316A34A'/%3E%3C/svg%3E";
  const ogMeta = [
    `<link rel="icon" type="image/svg+xml" href="${favicon}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${brand}">`,
    `<meta property="og:title" content="${ogTitle}">`,
    `<meta property="og:description" content="${mk
      ? esc0(`${mkOdds} — ${mkWhen}${mk.category ? ` · ${mk.category}` : ''} · play money on ${brand}`)
      : 'Play-money prediction markets: bet paper credits, watch the odds move, climb the leaderboard, ask your own questions.'}">`,
    ogUrl ? `<meta property="og:url" content="${ogUrl}${prefix}${mk ? `/m/${esc0(mk.id)}` : '/'}">` : '',
    ogImage ? `<meta property="og:image" content="${ogImage}">` : '',
    ogImage ? `<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">` : '',
    `<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${ogTitle}">`,
    mk ? `<meta name="twitter:description" content="${esc0(`${mkOdds} — ${mkWhen}`)}">` : '',
    ogImage ? `<meta name="twitter:image" content="${ogImage}">` : '',
  ].filter(Boolean).join('\n');
  const P = JSON.stringify(prefix);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brand} — ${tagline}</title>
${ogMeta}
<style>
  :root{
    /* surfaces + ink */
    --surface:#eef1ee; --card:#ffffff; --raised:#ffffff;
    --line:#dde4de; --line-strong:#74837b; /* measured 3.98:1 on white, 3.50:1 on surface */
    --ink:#111815; --ink2:#4a564f; --ink3:#5e6b64;
    /* brand + semantics. up/down are P&L ONLY, never a button. */
    --accent:#0b6b4f; --accent-ink:#ffffff; --accent-tint:rgba(11,107,79,.08);
    --up:#0f7d5c; --down:#b3261e; --live:#b3261e;
    /* outcome palette — no grey, no brand green, and every one of these
       carries --on-outcome text at 11px/600 above 4.5:1 */
    --o1:#2563eb; --o2:#b45309; --o3:#7c3aed;
    --o4:#0e7490; --o5:#be123c; --o6:#4d7c0f;
    --on-outcome:#ffffff;
    /* 4px spacing scale */
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s6:24px; --s8:32px; --s12:48px;
    /* type scale */
    --t-micro:11px; --t-meta:13px; --t-body:14px; --t-title:16px;
    --t-page:24px; --t-hero:36px;
    /* radii */
    --r-card:12px; --r-ctl:10px; --r-bar:6px; --r-pill:999px;
    --shadow:0 1px 2px rgba(16,24,20,.06), 0 8px 24px rgba(16,24,20,.04);
    --shadow-lift:0 8px 28px rgba(16,24,20,.10);
  }
  @media (prefers-color-scheme: dark){
    :root{
      --surface:#0e1512; --card:#151d19; --raised:#1b2420;
      --line:#26312c; --line-strong:#6d7d75;
      --ink:#e9efeb; --ink2:#a9b6af; --ink3:#8b9891;
      --accent:#2f9d78; --accent-ink:#06120d; --accent-tint:rgba(47,157,120,.14);
      --up:#3fbf94; --down:#f0685f; --live:#f0685f;
      /* dark fills are LIGHTER, so white-on-fill inverts to dark ink —
         white measured 2.4–3.4:1 on these, worse than the swatch that
         failed round 1. */
      --o1:#6ea8fe; --o2:#e08a3c; --o3:#a98bff;
      --o4:#35b3cc; --o5:#f2708c; --o6:#9bc44e;
      --on-outcome:#08110d;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.28);
      --shadow-lift:0 8px 28px rgba(0,0,0,.45);
    }
  }
  *{box-sizing:border-box}
  html{color-scheme:light dark}
  body{
    margin:0;background:var(--surface);color:var(--ink);
    font:var(--t-body)/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    font-variant-numeric:tabular-nums; /* every number, not four selectors */
    -webkit-font-smoothing:antialiased;
  }
  a{color:var(--accent)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}

  /* ---------- chrome ---------- */
  .topbar{
    height:56px;background:var(--card);border-bottom:1px solid var(--line);
    display:flex;align-items:center;gap:var(--s3);padding:0 var(--s4);
    position:sticky;top:0;z-index:20
  }
  .brand{display:flex;align-items:center;gap:var(--s2);text-decoration:none;color:var(--ink);
    font-size:15px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
  .brand svg{display:block}
  .spacer{flex:1}
  .livechip{display:inline-flex;align-items:center;gap:6px;font-size:var(--t-micro);
    font-weight:600;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em}
  .livedot{width:7px;height:7px;border-radius:50%;background:var(--up)}
  .livechip.off .livedot{background:var(--ink3)}
  @media (prefers-reduced-motion: no-preference){
    .livechip:not(.off) .livedot{animation:pulse 2s ease-in-out infinite}
  }
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .balance{display:inline-flex;align-items:center;gap:6px;font-size:var(--t-meta);color:var(--ink2)}
  .balance b{font-size:var(--t-title);font-weight:700;color:var(--ink)}
  .playpill{font-size:var(--t-micro);font-weight:600;color:var(--ink3);
    border:1px solid var(--line);border-radius:var(--r-pill);padding:3px 8px;white-space:nowrap}

  /* ---------- layout: one gutter, one left edge ---------- */
  main{max-width:1200px;margin:0 auto;padding:var(--s4)}
  .cols{display:block}
  @media (min-width:1000px){
    .cols{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:var(--s6);align-items:start}
    .rail{position:sticky;top:calc(56px + var(--s4))}
    /* The ticket is FIRST in the DOM so that on a phone the primary CTA
       is both on screen and next in tab order. Desktop puts it back in
       column two with grid order — doing it visually only would break
       WCAG 1.3.2 again. */
    #detail-view .cols>div:not(.rail){order:1}
    #detail-view .rail{order:2}
  }
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-card);
    box-shadow:var(--shadow);padding:var(--s4);margin:0 0 var(--s4)}
  .card h2{font-size:var(--t-title);font-weight:600;margin:0 0 var(--s3)}
  h1{font-size:var(--t-page);font-weight:700;margin:0 0 var(--s2);line-height:1.25}
  .hint{color:var(--ink3);font-size:var(--t-meta)}
  .micro{font-size:var(--t-micro);font-weight:600;letter-spacing:.06em;
    text-transform:uppercase;color:var(--ink3)}

  /* ---------- controls ---------- */
  input,select,button,textarea{font:inherit;color:var(--ink);
    background:var(--raised);border:1px solid var(--line-strong);
    border-radius:var(--r-ctl);padding:10px 12px;min-height:44px}
  input::placeholder,textarea::placeholder{color:var(--ink3)}
  button{cursor:pointer;font-weight:600}
  button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  button.primary:hover{filter:brightness(1.06)}
  button.big{min-height:52px;font-size:var(--t-title);font-weight:700;border-radius:var(--r-card);width:100%}
  button.small{min-height:34px;padding:6px 10px;font-size:var(--t-meta)}
  button.ghost{background:transparent}
  button:disabled{background:var(--line);border-color:var(--line);color:var(--ink3);
    cursor:default;filter:none}
  .row{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap;margin:var(--s3) 0}
  .row:first-child{margin-top:0}
  .row:last-child{margin-bottom:0}

  /* tabs */
  .tabs{display:flex;gap:var(--s1);margin:0 0 var(--s3);flex-wrap:wrap}
  .tabs button{min-height:36px;padding:0 14px;border-radius:var(--r-pill);
    background:transparent;border:1px solid var(--line-strong);color:var(--ink2);font-size:var(--t-meta)}
  /* selection is never colour alone — the active filter carries a mark */
  .tabs button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);
    color:var(--accent-ink);font-weight:700}
  .tabs button[aria-pressed="true"]::before{content:"✓ "}
  @media (pointer: coarse){ button.small{min-height:44px;min-width:44px} }
  @media (prefers-reduced-motion: reduce){ *{animation:none !important;scroll-behavior:auto !important} }

  /* ---------- market rows ---------- */
  .mlist{list-style:none;margin:0;padding:0}
  .mrow{display:block;padding:var(--s3) var(--s4);margin:0 calc(-1 * var(--s4));
    border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
  .mlist li:last-child .mrow{border-bottom:0}
  .mrow:hover{background:var(--accent-tint)}
  .mrow .t{font-size:var(--t-title);font-weight:600;line-height:1.35}
  .meta{color:var(--ink3);font-size:var(--t-meta);margin-top:var(--s1);
    display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center}
  .meta .dot{color:var(--line-strong)}

  /* status chips — a live market must not read as inert grey */
  .status{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;
    letter-spacing:.08em;text-transform:uppercase;padding:3px 7px;border-radius:5px;white-space:nowrap}
  .status.open{color:var(--accent);background:color-mix(in srgb, var(--up) 20%, transparent)}
  .status.closed,.status.resolving,.status.voiding{color:var(--on-outcome);background:var(--live)}
  .status.disputed{color:var(--on-outcome);background:var(--o3)}
  .status.resolved,.status.void{color:var(--ink3);background:color-mix(in srgb, var(--ink3) 14%, transparent)}
  .status .sd{width:6px;height:6px;border-radius:50%;background:currentColor}
  @media (prefers-reduced-motion: no-preference){
    .status.closed .sd,.status.resolving .sd,.status.voiding .sd{animation:pulse 1.6s ease-in-out infinite}
  }

  /* legend + ratio strip: names, not just percentages */
  .legend{display:flex;gap:var(--s3);flex-wrap:wrap;margin-top:var(--s2);
    font-size:var(--t-meta);color:var(--ink2)}
  .legend span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
  .legend i{width:9px;height:9px;border-radius:3px;display:inline-block;flex:none}
  .legend b{color:var(--ink);font-weight:700}
  .strip{display:flex;gap:2px;height:10px;border-radius:var(--r-bar);overflow:hidden;margin-top:6px}
  .strip div{min-width:3px}
  .settled .strip div{opacity:.4}
  .settled .strip div.win{opacity:1}
  .settled .mrow .t{color:var(--ink2)}

  /* ---------- market detail ---------- */
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));
    gap:var(--s3);margin:var(--s4) 0;padding:var(--s3) 0;
    border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
  .stats div .micro{display:block;margin-bottom:2px}
  .stats div .v{font-size:15px;font-weight:600}
  .oracle{display:inline-flex;align-items:center;gap:6px;max-width:200px}
  .oracle .mono{width:20px;height:20px;border-radius:50%;flex:none;display:grid;
    place-items:center;background:var(--accent-tint);color:var(--accent);
    font-size:10px;font-weight:700}
  .oracle .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--t-meta)}

  .bar{display:flex;gap:2px;height:28px;border-radius:var(--r-bar);overflow:hidden;margin:var(--s3) 0}
  .bar div{display:flex;align-items:center;padding-left:var(--s2);color:var(--on-outcome);
    font-size:var(--t-micro);font-weight:600;overflow:hidden;white-space:nowrap;min-width:3px}
  .spark{width:100%;height:140px;display:block;margin:var(--s4) 0}

  .out-btn{display:flex;align-items:center;gap:var(--s3);width:100%;text-align:left;
    border:1px solid var(--line);border-radius:var(--r-card);background:var(--raised);
    margin-bottom:var(--s2);padding:var(--s3) var(--s4);min-height:56px;
    box-shadow:inset 3px 0 0 var(--oc,var(--line-strong))}
  .out-btn:hover{border-color:var(--line-strong)}
  .out-btn[aria-pressed="true"]{border:1.5px solid var(--accent);background:var(--accent-tint);
    box-shadow:inset 3px 0 0 var(--oc,var(--accent)), 0 0 0 3px rgba(11,107,79,.24)}
  .out-btn .nm{flex:1;font-size:var(--t-title);font-weight:600;min-width:0;
    overflow:hidden;text-overflow:ellipsis}
  .out-btn .pc{width:72px;text-align:right;font-size:18px;font-weight:700}
  .out-btn .od{width:56px;text-align:right;font-size:var(--t-meta);color:var(--ink3)}

  /* ---------- bet ticket ---------- */
  .ticket{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--accent);
    border-radius:var(--r-card);box-shadow:var(--shadow-lift);padding:var(--s4)}
  .ticket .on{font-size:var(--t-meta);color:var(--ink2)}
  .ticket .on b{color:var(--ink)}
  .stakes{display:flex;gap:var(--s2);flex-wrap:wrap}
  .stakes button{min-height:36px;padding:0 14px;border-radius:var(--r-pill);
    background:var(--surface);border:1px solid var(--line-strong);color:var(--ink2);font-size:var(--t-meta)}
  .stakes button[aria-pressed="true"]{background:var(--accent-tint);border-color:var(--accent);
    color:var(--accent);font-weight:700}
  .payout{display:flex;align-items:center;gap:var(--s6);margin:var(--s4) 0 var(--s2)}
  .payout .sep{width:1px;align-self:stretch;background:var(--line);flex:none}
  .payout .big{font-size:28px;font-weight:700;line-height:1.1}
  .payout .unit{font-size:var(--t-body);font-weight:500;color:var(--ink2);margin-left:6px}
  .payout .odds{font-size:20px;font-weight:600;color:var(--ink2);line-height:1.1}
  .profit{color:var(--up);font-size:var(--t-meta);font-weight:600}
  .breakdown{color:var(--ink3);font-size:var(--t-meta);margin-top:var(--s2)}
  .warn{background:color-mix(in srgb, var(--down) 10%, transparent);color:var(--down);
    border:1px solid color-mix(in srgb, var(--down) 35%, transparent);border-radius:var(--r-ctl);
    padding:var(--s2) var(--s3);font-size:var(--t-meta);font-weight:600;margin-bottom:var(--s3)}
  .slip{border:1px solid var(--accent);background:var(--accent-tint);
    border-radius:var(--r-card);padding:var(--s3);margin-top:var(--s2)}
  .slip .lead{font-size:var(--t-title);font-weight:700;margin-bottom:var(--s1)}
  .winner{display:flex;align-items:center;gap:var(--s2);background:var(--accent-tint);
    border:1px solid var(--accent);border-radius:var(--r-bar);padding:var(--s2) var(--s3);
    margin-top:var(--s2);font-weight:600;font-size:var(--t-meta)}
  .lost{color:var(--ink3);text-decoration:line-through}
  .youre-in{font-size:var(--t-micro);font-weight:700;padding:2px 6px;border-radius:5px}
  .youre-in.up{background:color-mix(in srgb, var(--up) 12%, transparent);color:var(--up)}
  .youre-in.down{background:color-mix(in srgb, var(--down) 12%, transparent);color:var(--down)}

  /* ---------- tables ---------- */
  table{width:100%;border-collapse:collapse;font-size:var(--t-meta)}
  th{color:var(--ink3);font-weight:600;font-size:var(--t-micro);text-transform:uppercase;
    letter-spacing:.06em;text-align:left;padding:0 var(--s2) var(--s2) 0}
  td{padding:var(--s2) var(--s2) var(--s2) 0;border-top:1px solid var(--line);vertical-align:top}
  td.num,th.num{text-align:right;padding-right:0}
  .legs{list-style:none;margin:var(--s1) 0 0;padding:0;color:var(--ink3);font-size:var(--t-meta)}
  .legs li{display:flex;gap:var(--s2);align-items:baseline;padding:2px 0}
  .legs i{width:8px;height:8px;border-radius:2px;flex:none;align-self:center}
  .legs .nm{flex:1;color:var(--ink2);min-width:0;overflow:hidden;text-overflow:ellipsis}
  .pnl.up{color:var(--up);font-weight:700}
  .pnl.down{color:var(--down);font-weight:700}
  .cash{width:104px}

  /* ---------- misc ---------- */
  .msg{font-size:var(--t-meta);margin:var(--s2) 0;color:var(--ink2)}
  .msg.err{color:var(--down)}
  .hidden{display:none !important}
  .empty{color:var(--ink3);font-size:var(--t-meta);padding:var(--s6) 0;text-align:center}
  .toasts{position:fixed;left:50%;transform:translateX(-50%);bottom:var(--s6);z-index:60;
    display:flex;flex-direction:column-reverse;gap:var(--s2);align-items:center}
  .toast{background:var(--ink);color:var(--surface);padding:12px 16px;border-radius:var(--r-card);
    font-size:var(--t-body);box-shadow:var(--shadow-lift);max-width:92vw}
  details>summary{list-style:none}
  details>summary::-webkit-details-marker{display:none}
  details>summary::before{content:"+ ";color:var(--accent);font-weight:700}
  details[open]>summary::before{content:"\\2212 "}
  footer{max-width:1200px;margin:0 auto;padding:var(--s6) var(--s4) var(--s12);
    color:var(--ink3);font-size:var(--t-meta);border-top:1px solid var(--line)}
  .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .skip{position:absolute;left:-9999px}
  .skip:focus{left:var(--s4);top:8px;z-index:50;background:var(--card);padding:8px 12px;
    border-radius:var(--r-ctl);border:1px solid var(--accent)}
  /* Below the two-column breakpoint the ticket must come FIRST on a
     market page — it was rendering after the chart and the position
     table, i.e. two screens below the fold. */
  @media (max-width:999px){ .cols{display:flex;flex-direction:column} }
  @media (max-width:560px){
    main{padding:var(--s3)}
    .mrow{margin:0 calc(-1 * var(--s3));padding:var(--s3)}
    .payout{gap:var(--s4)}
    .cash{width:100%}
    /* the top bar was overflowing the viewport by ~40px */
    .playpill,.livechip{display:none}
    .brand span{display:none}
    .stats{grid-template-columns:repeat(2,1fr)}
  }
.chips{display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s3) 0 0}
.chips button{border:1px solid var(--line);background:var(--surface);color:var(--ink-2);border-radius:999px;padding:4px 12px;font-size:var(--f-sm);cursor:pointer}
.chips button:hover{border-color:var(--accent);color:var(--ink)}
.chips button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.chips .n{opacity:.65;font-variant-numeric:tabular-nums;margin-left:.35em}
.board{list-style:none;margin:0;padding:0}
.board li{display:flex;align-items:baseline;gap:var(--s3);padding:var(--s2) 0;border-bottom:1px solid var(--line);font-size:var(--f-sm)}
.board li:last-child{border-bottom:0}
.board li.you .board-name{font-weight:700;color:var(--accent,inherit)}
.board-rank{color:var(--ink-3);font-variant-numeric:tabular-nums;min-width:1.4em;text-align:right}
.board-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.board-pl{font-variant-numeric:tabular-nums;font-weight:600}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to markets</a>
<div class="toasts" id="toasts"></div>
<header class="topbar">
  <a class="brand" href="${prefix}">
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1" y="11" width="4.5" height="8" rx="1.5" fill="currentColor" opacity=".45"></rect>
      <rect x="7.75" y="6" width="4.5" height="13" rx="1.5" fill="currentColor" opacity=".7"></rect>
      <rect x="14.5" y="1" width="4.5" height="18" rx="1.5" fill="var(--accent)"></rect>
    </svg>
    ${brand}
  </a>
  <span class="livechip off" id="live"><span class="livedot" aria-hidden="true"></span><span id="live-t">connecting</span></span>
  <span class="spacer"></span>
  <span class="playpill" title="These credits cannot be bought, sold or withdrawn">Play money</span>
  <span class="balance hidden" id="bal-wrap">
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
      <path d="M7 3.6v6.8M5.2 5.2h3.1a1.4 1.4 0 010 2.8H5.2h3.3a1.4 1.4 0 010 2.8" fill="none"
        stroke="currentColor" stroke-width="1.2" stroke-linecap="round"></path>
    </svg>
    <b id="bal">—</b><span class="sr"> credits</span>
  </span>
  <button type="button" class="small" id="signin">Sign in</button>
</header>

<main id="main">
  <div class="card hidden" id="auth-card">
    <h2>Start with 1,000 free paper credits</h2>
    ${accounts ? `
    <p class="hint">Pick a username, get 1,000 paper credits, and start calling the news. Your
       session is an HttpOnly cookie scoped to this app; nothing is stored in the browser.</p>
    <div class="row">
      <label class="sr" for="acct-user">Username</label>
      <input id="acct-user" autocomplete="username" placeholder="Username" style="flex:1;min-width:130px">
      <label class="sr" for="acct-pass">Password</label>
      <input id="acct-pass" type="password" autocomplete="current-password" placeholder="Password" style="flex:1;min-width:130px">
      <button type="button" class="primary" id="do-acct-signin">Sign in</button>
      <button type="button" id="do-acct-register">Create account</button>
    </div>` : `
    <p class="hint">New accounts are granted 1,000 paper credits to bet with. Sign in with a pod
       bearer token (from <code>POST /idp/credentials</code>) — it is exchanged for a session cookie
       scoped to this app and <b>never stored in the browser</b>, so this page cannot leak access to
       the rest of your pod.</p>
    <div class="row">
      <label class="sr" for="token">Pod bearer token</label>
      <input id="token" type="password" placeholder="Pod bearer token" style="flex:1;min-width:200px">
      <button type="button" class="primary" id="do-signin">Start session</button>
    </div>`}
    <div class="msg" id="auth-msg" role="alert"></div>
  </div>

  <!-- ============================ list view ============================ -->
  <div id="list-view">
    <div class="cols">
      <div>
        <h1>Markets</h1>
        <nav class="tabs" aria-label="Market status filter" id="tabs"></nav>
        <nav class="chips" aria-label="Topic" id="cats"></nav>
        <div class="row">
          <label class="sr" for="search">Search markets</label>
          <input id="search" type="search" placeholder="Search markets" style="flex:1;min-width:200px">
        </div>
        <div class="card">
          <div class="sr" role="status" id="list-count"></div>
          <ul class="mlist" id="list" aria-busy="true"><li class="empty">Loading markets…</li></ul>
        </div>
        <div class="row" style="justify-content:center">
          <button type="button" class="hidden" id="more">Show more markets</button>
        </div>
      </div>

      <aside class="rail">
        <div class="card" id="board-card">
          <h2>Top predictors</h2>
          <p class="hint" style="margin:0 0 var(--s2)">Ranked by net worth — cash plus open positions.</p>
          <ol id="board" class="board"><li class="empty">No predictions yet.</li></ol>
        </div>
        <div class="card hidden" id="me-card">
          <h2>My positions</h2>
          <div id="positions"></div>
          <h2 style="margin-top:var(--s6)">Settled</h2>
          <div id="settled"></div>
        </div>

        <div class="card hidden" id="admin-card">
          <h2>Operator</h2>
          <p class="hint">Disputes wait here. If nobody adjudicates before the grace period expires
             the oracle's call stands and the disputer forfeits their bond, so an unworked queue is a
             decision, not a pause.</p>
          <div id="admin-disputes"></div>
          <div class="row">
            <label class="sr" for="ad-agent">Agent WebID</label>
            <input id="ad-agent" placeholder="Agent WebID" style="flex:1;min-width:160px">
          </div>
          <div class="row">
            <button type="button" class="small" id="ad-lookup">History</button>
            <button type="button" class="small" id="ad-freeze">Freeze</button>
            <button type="button" class="small" id="ad-unfreeze">Unfreeze</button>
          </div>
          <div class="row">
            <label class="sr" for="ad-credits">Credit adjustment</label>
            <input id="ad-credits" type="number" placeholder="± credits" style="width:110px">
            <label class="sr" for="ad-reason">Reason</label>
            <input id="ad-reason" placeholder="Reason (journalled)" style="flex:1;min-width:140px">
            <button type="button" class="small" id="ad-adjust">Adjust</button>
          </div>
          <div class="msg" id="admin-msg" role="alert"></div>
          <pre id="admin-out" class="hint" style="overflow:auto;max-height:200px;margin:0"></pre>
        </div>

        <details class="card">
          <summary style="cursor:pointer;font-weight:600">Create a market</summary>
          <p class="hint">You escrow b·ln(n) credits as maker liquidity and may not trade in your own
             market. You get the escrow back (never more) plus a share of trade fees when the market
             settles — but <b>you forfeit it entirely if nobody ever settles the market</b> and it has
             to be rescued automatically, so name an oracle who will act.</p>
          <div class="row"><label class="sr" for="c-title">Question</label>
            <input id="c-title" placeholder="Question — e.g. Arsenal v Spurs: full-time result" style="flex:1;min-width:200px"></div>
          <div class="row"><label class="sr" for="c-outcomes">Outcomes</label>
            <input id="c-outcomes" placeholder="Outcomes, comma-separated — Arsenal, Draw, Spurs" style="flex:1;min-width:200px"></div>
          <div class="row"><label class="sr" for="c-desc">Rules</label>
            <textarea id="c-desc" rows="2" placeholder="Rules — exactly what counts as a win, and from which source" style="flex:1;min-width:200px"></textarea></div>
          <div class="row"><label class="sr" for="c-oracle">Oracle WebID</label>
            <input id="c-oracle" placeholder="Oracle WebID (optional — defaults to you)" style="flex:1;min-width:200px"></div>
          <div class="row">
            <label class="sr" for="c-category">Category</label>
            <input id="c-category" placeholder="Category" style="width:130px">
            <label class="hint" for="c-closes">Closes</label>
            <input id="c-closes" type="datetime-local">
            <label class="hint" for="c-b">Liquidity b</label>
            <input id="c-b" type="number" value="100" min="10" style="width:90px">
          </div>
          <div class="row">
            <span class="hint" id="c-escrow">Escrow: —</span>
            <span class="spacer"></span>
            <button type="button" class="primary" id="c-go">Create market</button>
          </div>
          <div class="msg" id="c-msg" role="alert"></div>
        </details>
      </aside>
    </div>
  </div>

  <!-- ========================== detail view ========================== -->
  <div id="detail-view" class="hidden">
    <p style="display:flex;align-items:center;gap:var(--s3)"><a href="#" id="back">&larr; All markets</a>
      <button type="button" id="share" class="ghost" style="font-size:var(--f-sm)">Copy link</button></p>
    <div class="cols">
      <aside class="rail">
        <div class="ticket" id="ticket">
          <div class="row" style="justify-content:space-between">
            <span class="micro">Your bet</span>
            <span class="on">on <b id="t-pick">—</b></span>
          </div>
          <div class="row">
            <label class="micro" for="t-stake">Risk</label>
            <input id="t-stake" type="number" min="0" step="1" value="10"
              style="flex:1;min-width:90px;font-size:28px;font-weight:700;text-align:right;min-height:56px">
            <span class="hint">credits</span>
          </div>
          <div class="stakes" id="t-chips" role="group" aria-label="Quick stake"></div>
          <div class="payout">
            <div>
              <span class="micro">Returns</span>
              <div><span class="big" id="t-towin">—</span><span class="unit">credits</span></div>
              <div class="profit" id="t-profit"></div>
            </div>
            <div class="sep" aria-hidden="true"></div>
            <div>
              <span class="micro">Your odds</span>
              <div class="odds" id="t-odds">—</div>
              <div class="hint" id="t-oddsnote"></div>
            </div>
          </div>
          <div class="warn hidden" id="t-warn"></div>
          <button type="button" class="primary big" id="t-buy">Place bet</button>
          <div class="slip hidden" id="t-slip">
            <div id="t-slip-copy"></div>
            <div class="hint" id="t-countdown"></div>
            <div class="row">
              <button type="button" class="primary big" id="t-confirm" style="flex:2">Confirm bet</button>
              <button type="button" class="big ghost" id="t-cancel" style="flex:1">Cancel</button>
            </div>
          </div>
          <div class="breakdown" id="t-detail"></div>
          <div class="msg" id="t-fill"></div>
          <div class="msg" id="t-msg" role="alert"></div>
        </div>
      </aside>
      <div>
        <div class="card">
          <div class="row" style="gap:var(--s2)"><span id="d-status"></span></div>
          <h1 id="d-title" tabindex="-1"></h1>
          <p class="hint" id="d-rules"></p>
          <div class="stats" id="d-stats"></div>
          <div class="bar" id="d-bar" role="img" aria-label="Current prices"></div>
          <svg class="spark" id="d-spark" viewBox="0 0 320 140" role="img"
               aria-labelledby="spark-title"><title id="spark-title">Price history</title></svg>
          <div id="d-outcomes" role="group" aria-label="Choose an outcome"></div>
        </div>

        <div class="card hidden" id="d-position"></div>

        <div class="card hidden" id="oracle-card">
          <h2>Oracle controls</h2>
          <div class="row">
            <label class="sr" for="o-outcome">Winning outcome</label>
            <select id="o-outcome" style="flex:1;min-width:140px"></select>
            <button type="button" id="o-resolve">Resolve</button>
          </div>
          <div class="row">
            <button type="button" id="o-close">Close early</button>
            <button type="button" id="o-void">Propose void</button>
          </div>
        </div>

        <div class="card hidden" id="dispute-card">
          <h2>Does this look wrong?</h2>
          <p class="hint" id="dispute-copy"></p>
          <button type="button" id="o-dispute">Dispute this outcome</button>
        </div>
      </div>

    </div>
  </div>
</main>

<footer>
  <b>Paper credits — play money.</b> These credits cannot be bought, sold or withdrawn and have no
  monetary value. Prices are set by an automated market maker; markets are resolved by a named
  oracle and can be disputed.
</footer>

<script>
(() => {
  const PREFIX = ${P};
  const API = PREFIX + '/api';
  const $ = (id) => document.getElementById(id);
  const OC = ['var(--o1)','var(--o2)','var(--o3)','var(--o4)','var(--o5)','var(--o6)'];
  const col = (i) => OC[i % OC.length];

  let me = null, current = null, pick = 0, tab = 'open', cursor = null, paged = false;
  let quoteSeq = 0, lastQuote = null, betKey = null;
  const newIntent = () => { betKey = null; };

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

  function toast(text, ms = 4500) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = text;
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    $('toasts').appendChild(el);   // stack, don't pile in one pixel
    setTimeout(() => el.remove(), ms);
  }

  // A WebID is not a name. Show a monogram + the readable segment, keep
  // the full id in the title.
  function agentName(id) {
    if (!id) return 'unknown';
    try {
      const u = new URL(id);
      const seg = u.pathname.split('/').filter(Boolean);
      return (seg[0] || u.hostname).replace(/\\.(jsonld|ttl)$/, '');
    } catch { return String(id).slice(0, 24); }
  }
  const oracleChip = (id, isYou) => '<span class="oracle" title="' + esc(id) + '">'
    + '<span class="mono" aria-hidden="true">' + esc(agentName(id).slice(0, 1).toUpperCase()) + '</span>'
    + '<span class="nm">' + esc(isYou ? 'You' : agentName(id)) + '</span></span>';

  function countdown(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'closed';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
          m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm ' + (s % 60) + 's';
  }
  const statusLabel = (m) => (m.status === 'closed' ? 'In play'
    : m.status === 'resolving' ? 'Settling'
    : m.status === 'voiding' ? 'Void proposed'
    : m.status.charAt(0).toUpperCase() + m.status.slice(1));
  const statusChip = (m) => '<span class="status ' + esc(m.status) + '">'
    + (['closed', 'resolving', 'voiding'].includes(m.status) ? '<span class="sd"></span>' : '')
    + esc(statusLabel(m)) + '</span>';

  // Named legend + ratio strip. A bar of coloured percentages with no
  // names is unreadable the moment there are more than two outcomes.
  function legendHtml(m, limit = 3) {
    // Outcome order, NOT price order — the strip below is in outcome
    // order, and two different orderings of the same colours read as a
    // contradiction.
    const idx = m.prices.map((p, i) => [p, i]);
    const show = idx.slice(0, limit);
    const rest = idx.length - show.length;
    return '<div class="legend">' + show.map(([p, i]) =>
      '<span><i style="background:' + col(i) + '"></i>' + esc(m.outcomes[i]) + ' <b>' + pct(p) + '</b></span>').join('')
      + (rest > 0 ? '<span class="hint">+' + rest + ' more</span>' : '') + '</div>';
  }
  function stripHtml(m) {
    return '<div class="strip">' + m.prices.map((p, i) =>
      '<div style="flex:' + Math.max(p, 0.01) + ';background:' + col(i) + '"'
      + (m.resolvedOutcome === i ? ' class="win"' : '') + '></div>').join('') + '</div>';
  }

  // ------------------------------------------------------------- session
  async function refreshMe(quiet) {
    try {
      const prev = me;
      me = await api('/me');
      $('bal').textContent = cr(me.balance);
      $('bal-wrap').classList.remove('hidden');
      $('signin').textContent = 'Sign out';
      $('auth-card').classList.add('hidden');
      $('me-card').classList.remove('hidden');
      $('admin-card').classList.toggle('hidden', !me.isAdmin);
      if (me.isAdmin) renderDisputes();
      renderMe();
      if (prev && me.settlements.length && (!prev.settlements.length
          || prev.settlements[0].at !== me.settlements[0].at)) {
        const s = me.settlements[0];
        const net = s.net === undefined ? s.payout : s.net;
        toast(net >= 0
          ? 'Settled: ' + s.title + ' — you won ' + cr(net) + ' credits'
          : 'Settled: ' + s.title + ' — down ' + cr(-net) + ' credits');
      }
    } catch (e) {
      // Only an auth failure means signed out; a 429 or 500 must not
      // blank the balance and flip the CTA while the user is signed in.
      if (e.status === 401 || e.status === 403) {
        me = null;
        $('bal-wrap').classList.add('hidden');
        $('signin').textContent = 'Sign in';
        $('me-card').classList.add('hidden');
        $('admin-card').classList.add('hidden');
      } else if (!quiet) toast('Connection trouble — showing the last known state');
    }
  }

  function renderMe() {
    const el = $('positions');
    if (!me.positions.length) {
      el.innerHTML = '<div class="empty">No open bets yet. Pick a market to place your first.</div>';
    } else {
      const totalVal = me.positions.reduce((a, p) => a + p.totalValue, 0);
      const totalPnl = me.positions.reduce((a, p) => a + p.unrealizedPnl, 0);
      el.innerHTML = '<div class="row" style="justify-content:space-between;align-items:baseline">'
        + '<span><span class="micro">Sell all now for</span> <b style="font-size:var(--t-title)">' + cr(totalVal) + '</b></span>'
        + '<span class="pnl ' + (totalPnl >= 0 ? 'up' : 'down') + '">'
        + (totalPnl >= 0 ? '+' : '') + cr(totalPnl) + '</span></div>'
        + '<ul class="mlist">' + me.positions.map((p) => {
          const cls = p.unrealizedPnl >= 0 ? 'up' : 'down';
          const sign = p.unrealizedPnl >= 0 ? '+' : '';
          const on = p.shares.map((s, i) => (s > 0 ? p.outcomes[i] : null)).filter(Boolean);
          return '<li><a class="mrow" href="#m/' + esc(p.market) + '" style="padding-left:0;padding-right:0;margin:0">'
            + '<div class="row" style="margin:0;gap:var(--s2);justify-content:space-between;flex-wrap:nowrap">'
            + '<span style="min-width:0"><span class="t" style="font-size:var(--t-meta);font-weight:600">'
            + esc(p.title) + '</span>'
            + '<div class="meta" style="margin-top:2px">' + esc(on.join(', '))
            + '<span class="dot">·</span>sell now for ' + cr(p.totalValue) + '</div></span>'
            + '<span class="pnl ' + cls + '" style="white-space:nowrap">' + sign + cr(p.unrealizedPnl)
            + (p.totalCost > 0 ? '<div class="hint" style="text-align:right">' + sign
                + (p.unrealizedPnl / p.totalCost * 100).toFixed(0) + '%</div>' : '')
            + '</span></div></a></li>';
        }).join('') + '</ul>';
    }
    const s = $('settled');
    s.innerHTML = me.settlements.length
      ? '<table><tbody>' + me.settlements.slice(0, 8).map((x) => {
          const net = x.net === undefined ? x.payout : x.net;
          return '<tr><td>' + esc(x.title)
            + '<div class="meta">' + (x.outcome == null ? 'voided — refunded'
                : 'settled ' + esc(x.outcomeLabel || ('outcome ' + x.outcome)))
            + '<span class="dot">·</span>staked ' + cr(x.cost || 0)
            + '<span class="dot">·</span>returned ' + cr(x.payout) + '</div></td>'
            + '<td class="num"><span class="pnl ' + (net >= 0 ? 'up' : 'down') + '">'
            + (net >= 0 ? '+' : '') + cr(net) + '</span></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">Nothing settled yet.</div>';
  }

  async function cashOut(marketId, outcome) {
    if (!Number.isInteger(outcome)) return; // never guess which leg to sell
    const m = await api('/markets/' + encodeURIComponent(marketId));
    if (!m.position || !(m.position.shares[outcome] > 0)) return;
    const shares = m.position.shares[outcome];
    const q = await api('/markets/' + m.id + '/quote?side=sell&outcome=' + outcome + '&shares=' + shares);
    const floor = q.total * 0.98;
    // Never state a realised loss only as the positive number you receive.
    const paid = m.position.cost[outcome];
    const delta = q.total - paid;
    if (!confirm('Cash out your ' + m.outcomes[outcome] + ' bet?\\n\\n'
      + 'You risked ' + cr(paid) + ' and would get about ' + cr(q.total) + ' back — '
      + (delta >= 0 ? 'a profit of ' + cr(delta) : 'a loss of ' + cr(-delta)) + '.\\n'
      + 'You will receive at least ' + cr(floor) + ' if the price moves.')) return;
    const key = uid();
    try {
      await api('/markets/' + m.id + '/trade', {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: JSON.stringify({ side: 'sell', outcome, shares, minProceeds: floor }),
      });
      toast('Cashed out for about ' + cr(q.total) + ' credits');
      await refreshMe(); await route();
    } catch (e) { toast(e.message); }
  }

  // --------------------------------------------------------------- admin
  async function renderDisputes() {
    const el = $('admin-disputes');
    try {
      const { disputes } = await api('/admin/disputes');
      if (!disputes.length) { el.innerHTML = '<div class="empty">No open disputes.</div>'; return; }
      el.innerHTML = disputes.map((d) => '<div class="card" style="box-shadow:none;margin-bottom:var(--s3)">'
        + '<b>' + esc(d.title) + '</b>'
        + '<div class="meta">' + (d.resolvedOutcome != null
            ? 'resolved as <b>' + esc(d.outcomes[d.resolvedOutcome]) + '</b>' : 'void proposed')
        + '<span class="dot">·</span>' + d.disputeDetail.length + ' dispute(s)'
        + '<span class="dot">·</span>settles ' + new Date(d.autoSettlesAt).toLocaleString() + '</div>'
        + d.disputeDetail.map((x) => '<div class="hint">· ' + esc(agentName(x.agent))
            + ' (bond ' + cr(x.bond) + '): ' + esc(x.reason) + '</div>').join('')
        + '<div class="row">'
        + '<button type="button" class="small adj-up" data-m="' + esc(d.id) + '">Uphold</button>'
        + '<label class="sr" for="ao-' + esc(d.id) + '">Re-resolve to</label>'
        + '<select class="adj-out" id="ao-' + esc(d.id) + '" data-m="' + esc(d.id) + '">'
        + d.outcomes.map((o, i) => '<option value="' + i + '">' + esc(o) + '</option>').join('')
        + '</select>'
        + '<button type="button" class="small adj-re" data-m="' + esc(d.id) + '">Re-resolve</button>'
        + '<button type="button" class="small adj-void" data-m="' + esc(d.id) + '">Void</button>'
        + '<button type="button" class="small adj-hide" data-m="' + esc(d.id) + '">Hide</button>'
        + '</div></div>').join('');
      const act = async (path, body) => {
        try { await api(path, { method: 'POST', body: JSON.stringify(body) }); toast('Done'); await renderDisputes(); await refreshMe(); }
        catch (e) { $('admin-msg').textContent = e.message; $('admin-msg').className = 'msg err'; }
      };
      el.querySelectorAll('.adj-up').forEach((b) => { b.onclick = () => act('/admin/adjudicate', { market: b.dataset.m, uphold: true }); });
      el.querySelectorAll('.adj-re').forEach((b) => {
        const sel = el.querySelector('.adj-out[data-m="' + b.dataset.m + '"]');
        b.onclick = () => act('/admin/adjudicate', { market: b.dataset.m, uphold: false, outcome: Number(sel.value) });
      });
      el.querySelectorAll('.adj-void').forEach((b) => {
        b.onclick = () => confirm('Void this market? Everyone is refunded what they put in and nobody wins.')
          && act('/admin/adjudicate', { market: b.dataset.m, uphold: false });
      });
      el.querySelectorAll('.adj-hide').forEach((b) => { b.onclick = () => act('/admin/hide', { market: b.dataset.m, hidden: true }); });
    } catch (e) { el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
  }

  // ---------------------------------------------------------------- list
  const TABS = [['open', 'Open'], ['closed', 'In play'], ['settled', 'Settled'], ['mine', 'Mine']];
  let cat = '';           // active topic facet ('' = all)
  let cats = [];          // [{name, open}]
  async function loadCats() {
    try { cats = (await api('/categories')).categories || []; } catch { cats = []; }
    renderCats();
  }
  function renderCats() {
    const el = $('cats');
    if (!el) return;
    if (!cats.length) { el.innerHTML = ''; return; }
    el.innerHTML = ['<button type="button" data-cat="" aria-pressed="' + (cat === '') + '">All</button>']
      .concat(cats.map((c) =>
        '<button type="button" data-cat="' + esc(c.name) + '" aria-pressed="' + (cat === c.name) + '">'
        + esc(c.name) + '<span class="n">' + c.open + '</span></button>')).join('');
    el.querySelectorAll('button').forEach((b) => {
      b.onclick = () => { cat = b.dataset.cat; cursor = null; paged = false; renderCats(); renderList(); };
    });
  }

  function renderTabs() {
    $('tabs').innerHTML = TABS.map(([k, label]) =>
      '<button type="button" data-tab="' + k + '" aria-pressed="' + (tab === k) + '">' + label + '</button>').join('');
    $('tabs').querySelectorAll('button').forEach((b) => {
      b.onclick = () => { tab = b.dataset.tab; cursor = null; paged = false; renderTabs(); renderList(); };
    });
  }

  let listSeq = 0;
  const EMPTY = {
    open: 'No markets are open for betting right now.',
    closed: 'Nothing in play — these are markets that have closed and are awaiting a result.',
    settled: 'No markets have settled yet.',
    mine: 'You have not created a market yet.',
  };
  async function renderList(append) {
    const mySeq = ++listSeq;
    const params = new URLSearchParams();
    if (tab === 'mine') {
      if (!me) { $('list').innerHTML = '<li class="empty">Sign in to see the markets you created.</li>'; return; }
      params.set('creator', me.agent);
    } else params.set('status', tab);
    const search = $('search').value.trim();
    if (search) params.set('q', search);
    if (cat) params.set('category', cat);
    if (append && cursor) params.set('cursor', cursor);
    const el = $('list');
    el.setAttribute('aria-busy', 'true');
    let data;
    try { data = await api('/markets?' + params.toString()); }
    catch (e) { el.innerHTML = '<li class="empty">' + esc(e.message) + '</li>'; el.setAttribute('aria-busy', 'false'); return; }
    if (mySeq !== listSeq) return; // a newer list already landed
    cursor = data.nextCursor;
    $('more').classList.toggle('hidden', !cursor);
    if (!append) el.innerHTML = '';
    if (!data.markets.length && !append) {
      el.innerHTML = '<li class="empty">'
        + (search ? 'No markets match “' + esc(search) + '”.' : esc(EMPTY[tab] || 'Nothing here yet.'))
        + '</li>';
      el.setAttribute('aria-busy', 'false');
      $('list-count').textContent = 'No markets';
      return;
    }
    for (const m of data.markets) {
      const li = document.createElement('li');
      if (m.status === 'resolved' || m.status === 'void') li.className = 'settled';
      const mine = me && (me.positions || []).find((p) => p.market === m.id);
      const won = m.resolvedOutcome;
      li.innerHTML = '<a class="mrow" href="#m/' + esc(m.id) + '">'
        + '<span class="t">' + esc(m.title) + '</span>'
        + '<div class="meta">' + statusChip(m)
        + (m.category ? '<span class="dot">·</span>' + esc(m.category) : '')
        + '<span class="dot">·</span>' + (m.tradable
            ? 'closes in <span class="cd" data-c="' + esc(m.closesAt) + '">' + countdown(m.closesAt) + '</span>'
            : new Date(m.closesAt).toLocaleDateString())
        + '<span class="dot">·</span>' + m.trades + ' bets'
        // Traded volume, not LMSR maker depth — "pool" read as a prize pot.
        + '<span class="dot">·</span>' + cr(m.volume) + ' traded'
        + (mine ? '<span class="youre-in ' + (mine.unrealizedPnl >= 0 ? 'up' : 'down') + '">You\u2019re in '
            + (mine.unrealizedPnl >= 0 ? '+' : '') + cr(mine.unrealizedPnl) + '</span>' : '')
        + '</div>'
        // A decided question has an answer, not three live probabilities.
        + (won != null && m.status === 'resolved'
            ? '<div class="winner">\u2713 ' + esc(m.outcomes[won]) + ' won</div>'
            : m.status === 'void' ? '<div class="winner">Voided \u2014 everyone refunded</div>'
            : legendHtml(m) + stripHtml(m))
        + '</a>';
      el.appendChild(li);
    }
    el.setAttribute('aria-busy', 'false');
    $('list-count').textContent = data.total + ' market' + (data.total === 1 ? '' : 's');
  }

  // -------------------------------------------------------------- detail
  function sparkline(el, history, n, outcomes) {
    // A FIXED viewBox letterboxes: the default xMidYMid meet drew 294px
    // of content inside a 730px box with the axis labels marooned in the
    // middle. Size the coordinate system to the element instead.
    const W = Math.max(280, Math.round(el.clientWidth || 320));
    const H = 140, PAD = 8, GUT = 30;
    el.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    el.innerHTML = '<title id="spark-title">Price history</title>';
    const ns = 'http://www.w3.org/2000/svg';
    const add = (tag, attrs) => {
      const e = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      el.appendChild(e); return e;
    };
    // Zero is pinned (a probability chart that doesn't start at 0 lies),
    // but the TOP tracks the data — a fixed 0–100% ceiling squeezed three
    // lines into 26% of the canvas on a market where nothing exceeds 45%.
    const peak = history && history.length
      ? Math.max(...history.map((h) => Math.max(...h.p))) : 1;
    const top = Math.min(1, Math.max(0.4, Math.ceil((peak * 1.15) / 0.1) * 0.1));
    const y = (p) => PAD + (1 - p / top) * (H - 2 * PAD - 14);
    const ticks = [0, top / 2, top];
    for (const frac of ticks) {
      const yy = y(frac);
      add('line', {
        x1: GUT, y1: yy, x2: W, y2: yy,
        stroke: 'var(--line)', 'stroke-width': 1,
        'stroke-dasharray': frac === 0 ? '' : '2 4',
      });
      const t = add('text', { x: 0, y: yy + 4, fill: 'var(--ink3)', 'font-size': 10 });
      t.textContent = Math.round(frac * 100) + '%';
    }
    if (!history || history.length < 2) return;
    const t0 = history[0].t, t1 = history[history.length - 1].t || (t0 + 1);
    const span = Math.max(1, t1 - t0);
    const x = (t) => GUT + ((t - t0) / span) * (W - GUT - 4);
    // An x axis: three dates, so "when" is answerable.
    // Pick a resolution the span can actually distinguish, or all three
    // ticks print the same clock time and the axis looks broken.
    const fmt = (ms) => {
      const d = new Date(ms);
      const two = (x) => String(x).padStart(2, '0');
      if (span > 36e5 * 36) return (d.getMonth() + 1) + '/' + d.getDate();
      if (span > 6e4 * 10) return d.getHours() + ':' + two(d.getMinutes());
      return d.getHours() + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
    };
    for (const f of [0, 0.5, 1]) {
      const t = add('text', {
        x: x(t0 + span * f), y: H - 2, fill: 'var(--ink3)', 'font-size': 10,
        'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle',
      });
      t.textContent = fmt(t0 + span * f);
    }
    for (let k = 0; k < n; k++) {
      const pts = history.map((h) => x(h.t).toFixed(1) + ',' + y(h.p[k]).toFixed(1)).join(' ');
      add('polyline', {
        points: pts, fill: 'none', stroke: col(k), 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke', // else the stroke scales unevenly
      });
      const last = history[history.length - 1];
      add('circle', { cx: x(last.t).toFixed(1), cy: y(last.p[k]).toFixed(1), r: 3.5, fill: col(k) });
    }
  }

  const settledView = (m) => m.status === 'resolved' || m.status === 'void';
  let detailSeq = 0;
  async function renderDetail(id, keepTicket) {
    const seq = ++detailSeq;
    let m;
    try { m = await api('/markets/' + encodeURIComponent(id)); }
    catch (e) {
      // Never leave ANOTHER market's page — and its live Place bet
      // button — rendered under this URL.
      if (e.status === 404 || e.status === 451 || !current || current.id !== id) {
        current = null;
        toast(e.status === 451 ? 'That market was withdrawn by the operator' : 'That market no longer exists');
        location.hash = '';
        await route();
        return;
      }
      $('t-buy').disabled = true;
      toast('Connection trouble — prices may be stale');
      return;
    }
    if (seq !== detailSeq) return; // a newer render already landed
    if (!current || current.id !== m.id) {
      // A confirmation opened for one market must not follow the user to
      // another still armed.
      pick = 0; newIntent(); cancelSlip(); $('t-fill').textContent = '';
    }
    current = m;
    $('list-view').classList.add('hidden');
    $('detail-view').classList.remove('hidden');
    document.title = m.title + ' — Markets';
    $('d-status').innerHTML = statusChip(m)
      + (m.status === 'resolved' && m.resolvedOutcome != null
        ? ' <span class="hint">settled as <b>' + esc(m.outcomes[m.resolvedOutcome]) + '</b></span>' : '')
      + (m.status === 'voiding'
        ? ' <span class="hint">everyone is refunded what they paid — nobody wins</span>' : '');
    $('d-title').textContent = m.title;
    $('d-rules').innerHTML = m.description
      ? '<b>Rules:</b> ' + esc(m.description)
      : '<i>The creator stated no rules for this market.</i>';

    const isYou = me && me.agent === m.oracle;
    $('d-stats').innerHTML = [
      [m.tradable ? 'Closes' : 'Closed', m.tradable ? countdown(m.closesAt)
        : new Date(m.closesAt).toLocaleString()],
      ['Traded', cr(m.volume)],
      ['Bets', String(m.trades)],
      ['Oracle', oracleChip(m.oracle, isYou)],
    ].map(([k, v]) => '<div><span class="micro">' + k + '</span><span class="v">' + v + '</span></div>').join('');

    $('d-bar').innerHTML = m.prices.map((p, i) =>
      '<div style="flex:' + Math.max(p, 0.01) + ';background:' + col(i) + '" title="'
      + esc(m.outcomes[i]) + ' ' + pct(p) + '">' + (p >= 0.12 ? esc(m.outcomes[i]) + ' ' + pct(p) : '') + '</div>').join('');
    $('d-bar').setAttribute('aria-label',
      m.outcomes.map((o, i) => o + ' ' + pct(m.prices[i])).join(', '));
    sparkline($('d-spark'), m.history, m.outcomes.length, m.outcomes);
    $('d-spark').setAttribute('aria-label', 'Price history: '
      + m.outcomes.map((o, i) => o + ' now ' + pct(m.prices[i])).join(', '));

    if (pick >= m.outcomes.length) pick = 0;
    const held = m.position ? m.position.shares : m.outcomes.map(() => 0);
    // Update prices IN PLACE when the market's shape hasn't changed.
    // Rebuilding this container on every price tick threw keyboard focus
    // to BODY every few seconds on a live market.
    const existing = $('d-outcomes').querySelectorAll('.out-btn');
    const reuse = !settledView(m) && existing.length === m.outcomes.length
      && m.outcomes.every((o, i) => existing[i].dataset.o === o)
      // …and your holdings are unchanged, or "you hold N to win" goes stale.
      && held.every((h, i) => existing[i].dataset.h === String(h));
    if (reuse) {
      existing.forEach((b, i) => {
        b.querySelector('.pc').textContent = pct(m.prices[i]);
        b.querySelector('.od').firstChild.nodeValue = (1 / Math.max(m.prices[i], 1e-6)).toFixed(2);
        b.setAttribute('aria-pressed', String(i === pick));
      });
    } else $('d-outcomes').innerHTML = m.outcomes.map((o, i) =>
      '<button type="button" class="out-btn" data-i="' + i + '" data-o="' + esc(o) + '"'
      + ' data-h="' + held[i] + '" aria-pressed="' + (i === pick) + '" style="--oc:' + col(i) + '">'
      + '<span class="nm">' + esc(o)
      + (held[i] > 0 ? '<div class="meta" style="margin:0">you hold ' + cr(held[i]) + ' to win</div>' : '')
      + '</span>'
      + '<span class="pc">' + pct(m.prices[i]) + '</span>'
      + '<span class="od">' + (1 / Math.max(m.prices[i], 1e-6)).toFixed(2)
      + '<span class="sr"> decimal odds</span></span>'
      + '</button>').join('');
    if (!reuse) $('d-outcomes').querySelectorAll('.out-btn').forEach((b) => {
      b.onclick = () => {
        // Toggle in place. Rebuilding the container threw keyboard focus
        // to the top of the document and re-fetched the whole market
        // just to move one highlight.
        pick = Number(b.dataset.i);
        newIntent();
        $('d-outcomes').querySelectorAll('.out-btn').forEach((o, j) => {
          o.setAttribute('aria-pressed', String(j === pick));
        });
        $('t-pick').textContent = m.outcomes[pick];
        cancelSlip();
        quote();
      };
    });
    $('t-pick').textContent = m.outcomes[pick];

    if (settledView(m)) {
      // Render the result as text, not as disabled controls: a decided
      // market's outcomes ARE the substance, and disabled ink measured
      // 4.31:1. Odds and the live bar are suppressed too — you could
      // read odds on a team that had already lost.
      $('d-outcomes').innerHTML = m.outcomes.map((o, i) =>
        '<div class="out-btn'
        + (m.status === 'resolved' && i !== m.resolvedOutcome ? ' lost' : '')
        + '" style="--oc:' + col(i) + ';cursor:default;min-height:44px">'
        + '<span class="nm"' + (m.status === 'resolved' && i !== m.resolvedOutcome
            ? ' style="text-decoration:line-through;color:var(--ink3)"' : '') + '>' + esc(o) + '</span>'
        + '<span class="pc">' + (m.status === 'void' ? 'refunded'
            : i === m.resolvedOutcome ? '<b>✓ won</b>' : 'lost') + '</span></div>').join('');
      $('d-bar').innerHTML = '';
      $('d-bar').style.display = 'none';
      $('d-spark').style.display = 'none';
    } else {
      $('d-bar').style.display = '';
      $('d-spark').style.display = '';
    }
    const canTrade = m.tradable && me && me.agent !== m.oracle && me.agent !== m.creator;
    $('ticket').classList.toggle('hidden', !m.tradable);
    $('t-buy').disabled = m.tradable && me && !canTrade;
    $('t-buy').textContent = !me ? 'Sign in to bet'
      : (me.agent === m.oracle || me.agent === m.creator) ? 'You run this market' : 'Place bet';

    const pos = m.position;
    const pd = $('d-position');
    const settled = m.status === 'resolved' || m.status === 'void';
    if (pos && pos.shares.some((s) => s > 0) && settled) {
      // A decided market has no "current price". Show what happened, not
      // a mark-to-market on prices that no longer mean anything.
      pd.classList.remove('hidden');
      pd.dataset.shape = '';   // settled card is a different shape entirely
      const won = m.resolvedOutcome;
      const receipt = (me && (me.settlements || []).find((x) => x.market === m.id)) || null;
      const returned = receipt ? receipt.payout : null;
      const net = receipt ? (receipt.net === undefined ? receipt.payout : receipt.net) : null;
      pd.innerHTML = '<h2>Your bet</h2>'
        + '<table><thead><tr><th>Bet</th><th class="num">Result</th></tr></thead>'
        + '<tbody>' + pos.shares.map((s, i) => (s > 0
          ? '<tr><td class="' + (m.status === 'resolved' && i !== won ? 'lost' : '') + '">'
            + '<i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'
            + col(i) + '"></i> ' + esc(m.outcomes[i]) + ' — risked ' + cr(pos.cost[i]) + '</td>'
            + '<td class="num">' + (m.status === 'void' ? 'refunded'
              : i === won ? '<b>won ' + cr(s) + '</b>' : 'lost') + '</td></tr>'
          : '')).join('') + '</tbody></table>'
        + (m.status === 'resolved' && won != null
          ? '<div class="winner">✓ Settled as ' + esc(m.outcomes[won]) + '</div>' : '')
        + (m.status === 'void' ? '<div class="winner">Market voided — everyone refunded what they paid</div>' : '')
        + (receipt ? '<div class="row"><span class="hint">staked ' + cr(receipt.cost || 0)
            + ' → returned ' + cr(returned) + '</span><span class="spacer"></span>'
            + '<span class="pnl ' + (net >= 0 ? 'up' : 'down') + '">'
            + (net >= 0 ? '+' : '') + cr(net) + '</span></div>' : '');
    } else if (pos && pos.shares.some((s) => s > 0)) {
      pd.classList.remove('hidden');
      const cls = pos.unrealizedPnl >= 0 ? 'up' : 'down';
      // Update the numbers in place when the position's shape is
      // unchanged; rebuilding threw focus off the Cash out buttons every
      // time anyone else traded.
      const legs = pos.shares.map((s, i) => (s > 0 ? i : -1)).filter((i) => i >= 0);
      // Include YOUR OWN holdings: the stake and payout text is only
      // stale when you trade, and a third party's tick leaves shares
      // untouched, so this keeps the focus-preserving path for ticks and
      // forces a rebuild for your own bets.
      const shape = m.id + ':' + legs.join(',') + ':' + pos.shares.join(',');
      // Toggle the up/down class, never ASSIGN className — assigning it
      // dropped the v-pnl/v-total hooks this very function needs, so the
      // next tick threw, froze every P&L figure, and (via an early
      // return) skipped quote(), letting an armed slip advertise a
      // payout 3.4x what it filled at.
      const mark = (el, val) => {
        el.classList.toggle('up', val >= 0);
        el.classList.toggle('down', val < 0);
      };
      let inPlace = false;
      if (pd.dataset.shape === shape) {
        try {
          legs.forEach((i) => {
            const row = pd.querySelector('tr[data-i="' + i + '"]');
            const now = row && row.querySelector('.v-now');
            const d = row && row.querySelector('.v-pnl');
            if (!now || !d) throw new Error('position hooks missing');
            now.textContent = cr(pos.value[i]);
            d.textContent = (pos.value[i] >= pos.cost[i] ? '+' : '') + cr(pos.value[i] - pos.cost[i]);
            mark(d, pos.value[i] - pos.cost[i]);
          });
          const tot = pd.querySelector('.v-total');
          if (!tot) throw new Error('position total missing');
          tot.textContent = (pos.unrealizedPnl >= 0 ? '+' : '') + cr(pos.unrealizedPnl);
          mark(tot, pos.unrealizedPnl);
          const cost = pd.querySelector('.v-cost');
          if (cost) cost.textContent = 'cost ' + cr(pos.totalCost) + ' · value ' + cr(pos.totalValue);
          inPlace = true;
        } catch {
          inPlace = false; // fall through to a full rebuild rather than throw
        }
      }
      if (!inPlace) {
      pd.dataset.shape = shape;
      pd.innerHTML = '<h2>Your position</h2>'
        + '<table><thead><tr><th>Bet</th><th class="num">Sell now for</th>'
        + '<th class="num"><span class="sr">Actions</span></th></tr></thead>'
        + '<tbody>' + pos.shares.map((s, i) => (s > 0
          ? '<tr data-i="' + i + '"><td><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:'
            + col(i) + '"></i> <b>' + esc(m.outcomes[i]) + '</b>'
            + '<div class="meta">risked ' + cr(pos.cost[i]) + '<span class="dot">→</span>returns '
            + cr(s) + ' if right</div></td>'
            + '<td class="num"><span class="v-now">' + cr(pos.value[i]) + '</span>'
            + '<div class="v-pnl pnl ' + (pos.value[i] >= pos.cost[i] ? 'up' : 'down') + '">'
            + (pos.value[i] >= pos.cost[i] ? '+' : '') + cr(pos.value[i] - pos.cost[i]) + '</div></td>'
            + '<td class="num">' + (m.tradable
              ? '<button type="button" class="small cash sell-one" data-i="' + i + '">Cash out</button>' : '') + '</td></tr>'
          : '')).join('') + '</tbody></table>'
        + '<div class="row"><span class="hint v-cost">cost ' + cr(pos.totalCost) + ' · value '
        + cr(pos.totalValue) + '</span><span class="spacer"></span><span class="v-total pnl ' + cls + '">'
        + (pos.unrealizedPnl >= 0 ? '+' : '') + cr(pos.unrealizedPnl) + '</span></div>';
      pd.querySelectorAll('.sell-one').forEach((b) => {
        b.onclick = () => cashOut(m.id, Number(b.dataset.i));
      });
      }
    } else { pd.classList.add('hidden'); pd.dataset.shape = ''; }

    $('oracle-card').classList.toggle('hidden', !(isYou && m.canResolve));
    $('o-outcome').innerHTML = m.outcomes.map((o, i) => '<option value="' + i + '">' + esc(o) + '</option>').join('');
    $('o-void').disabled = !m.canVoid;

    const canDispute = (m.status === 'resolving' || m.status === 'voiding') && pos;
    $('dispute-card').classList.toggle('hidden', !canDispute);
    if (canDispute) {
      const bond = Math.max(25, pos.totalCost * 0.2);
      $('dispute-copy').innerHTML = (m.status === 'voiding'
        ? 'The oracle has proposed to <b>void</b> this market — everyone is refunded what they paid and nobody wins. '
        : 'This market settled as <b>' + esc(m.outcomes[m.resolvedOutcome]) + '</b>. ')
        + 'Disputing stakes a bond of about <b>' + cr(bond) + ' credits</b>, which you <b>lose</b> '
        + 'unless an operator agrees with you. '
        + (m.disputes ? m.disputes + ' dispute(s) already filed. ' : '')
        + 'If nobody adjudicates in time, the oracle&rsquo;s call stands.';
    }
    quote();
  }

  // Stake-first quote: ask the server what this stake returns.
  const warn = (html) => {
    $('t-warn').innerHTML = html || '';
    $('t-warn').classList.toggle('hidden', !html);
  };

  async function quote() {
    const stake = Number($('t-stake').value);
    $('t-chips').querySelectorAll('button').forEach((c) =>
      c.setAttribute('aria-pressed', String(Number(c.dataset.stake) === stake)));
    $('t-msg').textContent = '';      // stale errors outlived the quote
    $('t-msg').className = 'msg';
    const slipWasOpen = !$('t-slip').classList.contains('hidden');
    const blank = () => {
      $('t-towin').textContent = '—'; $('t-odds').textContent = '—';
      $('t-profit').textContent = ''; $('t-oddsnote').textContent = '';
    };
    if (!current || !current.tradable || !(stake > 0)) {
      blank();
      $('t-detail').textContent = '';
      warn('');
      lastQuote = null;               // nothing to review
      $('t-buy').disabled = true;
      $('t-buy').textContent = 'Enter a stake';
      return;
    }

    // Check the balance HERE, not after the user commits and the server
    // answers with "need 600.000000, have 503.945114".
    if (me && stake > me.balance) {
      blank();
      warn('Not enough credits — you are ' + cr(stake - me.balance) + ' short.');
      $('t-buy').disabled = true;
      $('t-buy').textContent = 'Not enough credits';
      $('t-detail').textContent = '';
      lastQuote = null;
      return;
    }

    const seq = ++quoteSeq;
    try {
      const q = await api('/markets/' + current.id + '/quote?side=buy&outcome=' + pick + '&spend=' + stake);
      if (seq !== quoteSeq) return; // a newer quote already landed
      q.spend = stake;               // what the user actually typed
      lastQuote = q;
      $('t-towin').textContent = cr(q.toWin);
      $('t-odds').textContent = q.odds ? q.odds.toFixed(2) : '—';
      $('t-profit').textContent = (q.profit >= 0 ? '+' : '') + cr(q.profit) + ' profit if right';
      $('t-detail').textContent = cr(q.shares) + ' shares · fee ' + cr(q.fee)
        + ' · you pay at most ' + cr(q.total * 1.02);

      // The price you get is not the price on the button: an AMM moves
      // as you buy. Say so, rather than showing two different "odds".
      const spot = current.prices[pick];
      const impact = q.avgPrice - spot; // percentage POINTS, not relative
      $('t-oddsnote').textContent = 'after slippage · market ' + (1 / Math.max(spot, 1e-6)).toFixed(2);
      // If a slip is open, RE-PRICE it rather than deleting it — someone
      // else's trade silently destroying your confirmation is unusable
      // on exactly the busy markets this product is for.
      if (slipWasOpen) reviewBet(true);

      const ok = me && me.agent !== current.oracle && me.agent !== current.creator;
      if (q.profit <= 0) {
        // Odds below 1.00 means you lose even when you win.
        warn('At this stake you lose even if ' + esc(current.outcomes[pick])
          + ' wins — your own bet moves the price past the payout. Reduce your stake.');
        $('t-buy').disabled = true;
        $('t-buy').textContent = 'Stake too large';
      } else {
        warn(impact > 0.05
          ? 'Big stake: this bet itself moves the price from ' + pct(spot) + ' to ' + pct(q.avgPrice) + '.'
          : '');
        $('t-buy').disabled = !(current.tradable && ok);
        $('t-buy').textContent = !me ? 'Sign in to bet'
          : !ok ? 'You run this market' : 'Review bet';
      }
    } catch (e) {
      if (seq !== quoteSeq) return;
      lastQuote = null;
      blank();
      warn('');
      $('t-detail').textContent = e.message;
    }
  }

  function cancelSlip() {
    const hadFocus = $('t-slip').contains(document.activeElement);
    $('t-slip').classList.add('hidden');
    $('t-detail').classList.remove('hidden');
    $('t-buy').classList.remove('hidden');
    if (slipTimer) { clearInterval(slipTimer); slipTimer = null; }
    $('t-countdown').innerHTML = '';   // so the next slip rebuilds it
    $('t-slip-copy').innerHTML = '';   // don't keep the last market's wording
    // Never strand focus on a hidden control — Tab from there restarts
    // at the top of the document, mid-purchase.
    if (hadFocus) {
      // .focus() on a disabled control is a no-op, which left focus on
      // the hidden Confirm button.
      const target = $('t-buy').disabled ? $('t-stake') : $('t-buy');
      target.focus();
    }
  }
  let slipTimer = null;
  let slipLeft = 0;

  // Review before commit. The bet was the one irreversible action in the
  // product and the only one with no confirmation.
  function reviewBet(reprice) {
    if (!lastQuote || !current) return;
    // Re-assert the typed stake: the slip must never state a wager the
    // ticket did not quote.
    if (!reprice && Number($('t-stake').value) !== lastQuote.spend) { quote(); return; }
    $('t-slip-copy').innerHTML = '<div class="lead">Risk ' + cr(lastQuote.total) + ' on '
      + esc(current.outcomes[pick]) + '</div>'
      + '<div class="lead" style="font-size:var(--t-title);color:var(--up)">Returns '
      + cr(lastQuote.toWin) + ' (+' + cr(lastQuote.profit) + ') at '
      + (lastQuote.odds || 0).toFixed(2) + '</div>'
      + '<div class="hint">You pay at most ' + cr(lastQuote.total * 1.02) + ' if the price moves.</div>';
    $('t-detail').classList.add('hidden');
    $('t-slip').classList.remove('hidden');
    $('t-buy').classList.add('hidden');
    if (!reprice) $('t-confirm').focus();
    // ONE timer per slip. Re-pricing must not start a second one.
    if (slipTimer) { clearInterval(slipTimer); slipTimer = null; }
    // A quote goes stale, but a silent 15s cut is a WCAG 2.2.1 failure
    // and too short to read. Count down visibly, offer an extension, and
    // never expire while the user is still inside the slip.
    // A re-price keeps the user's remaining time rather than silently
    // granting a fresh 60s on someone else's trade.
    if (!reprice || !(slipLeft > 0)) slipLeft = 60;
    // Build the countdown ONCE: rewriting this container's innerHTML on
    // every tick destroyed and recreated the button, so focus landed on
    // BODY a second after you reached it.
    // Build it ONCE per slip. Re-pricing must not destroy a control the
    // user may be focused on.
    if (!$('t-extend')) {
      $('t-countdown').innerHTML = 'This price holds for <b><span id="t-left"></span>s</b>. '
        + '<button type="button" class="small" id="t-extend">Keep this price</button>';
      $('t-extend').onclick = () => { slipLeft = 60; $('t-left').textContent = slipLeft; };
    }
    const paint = () => { const el = $('t-left'); if (el) el.textContent = slipLeft; };
    paint();
    slipTimer = setInterval(() => {
      slipLeft -= 1;
      if (slipLeft <= 0) {
        cancelSlip();
        quote();
        $('t-msg').textContent = 'That price expired — check the new price and review again.';
        return;
      }
      paint();
    }, 1000);
  }

  async function placeBet() {
    if (!lastQuote) return;
    // Disable BEFORE restoring focus: doing it after blew focus off the
    // element cancelSlip() had just focused, landing on BODY.
    $('t-msg').textContent = ''; $('t-msg').className = 'msg';
    $('t-buy').disabled = true;
    cancelSlip();
    try {
      if (!betKey) betKey = uid(); // one key per INTENT, so a retry replays
      const r = await api('/markets/' + current.id + '/trade', {
        method: 'POST',
        headers: { 'idempotency-key': betKey },
        body: JSON.stringify({ side: 'buy', outcome: pick, spend: Number($('t-stake').value), maxCost: lastQuote.total * 1.02 }),
      });
      betKey = null;
      toast('Bet placed — ' + cr(r.total) + ' on ' + r.outcomeLabel + ', returns ' + cr(r.toWin));
      // A persistent record on the page: a 4.5s toast that a settlement
      // toast can paint over is not a receipt.
      $('t-fill').innerHTML = '<b>Bet placed.</b> ' + cr(r.total) + ' on ' + esc(r.outcomeLabel)
        + ' → returns ' + cr(r.toWin) + '. Balance ' + cr(r.balance) + '.';
      await refreshMe(); await renderDetail(current.id, true);
    } catch (e) {
      $('t-msg').textContent = e.message + (e.status === 409 ? ' — refresh the quote and try again' : '');
      $('t-msg').className = 'msg err';
    } finally {
      // Recompute rather than force-enable: the market may have closed,
      // or this agent may run it.
      const ok = current && current.tradable && me
        && me.agent !== current.oracle && me.agent !== current.creator;
      $('t-buy').disabled = !ok;
      if (ok && document.activeElement === document.body) $('t-buy').focus();
    }
  }

  async function act(action, body, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await api('/markets/' + current.id + '/' + action, { method: 'POST', body: JSON.stringify(body || {}) });
      await refreshMe(); await renderDetail(current.id, true);
      toast('Done');
    } catch (e) { $('t-msg').textContent = e.message; $('t-msg').className = 'msg err'; }
  }

  async function renderBoard() {
    // The endpoint is signed-in-only and pseudonymized by design (a public
    // wealth ranking of identities is recon); signed out, the card is the
    // invitation instead.
    const el = $('board');
    try {
      const { leaderboard } = await api('/leaderboard');
      if (!leaderboard.length) { el.innerHTML = '<li class="empty">No predictions yet.</li>'; return; }
      el.innerHTML = leaderboard.slice(0, 10).map((r) =>
        '<li' + (r.you ? ' class="you"' : '') + '><span class="board-rank">' + r.rank + '</span>'
        + '<span class="board-name">' + (r.you ? 'you' : esc(agentName(r.agent))) + '</span>'
        + '<span class="board-pl" title="net worth: cash + open positions">'
        + (r.netWorth != null ? r.netWorth : r.balance).toFixed(2) + '</span></li>').join('');
    } catch {
      el.innerHTML = '<li class="empty">Sign in to see the top predictors.</li>';
    }
  }
  setInterval(renderBoard, 30000);

  async function route() {
    renderBoard();
    const h = location.hash;
    if (h.startsWith('#m/')) {
      const id = h.slice(3);
      // Make the ADDRESS BAR shareable: most people copy the URL rather
      // than press a button, and the path form is the one that unfurls
      // with this market's question and odds.
      try { history.replaceState(null, '', PREFIX + '/m/' + id); } catch { /* file:// etc */ }
      return renderDetail(id, true);
    }
    $('detail-view').classList.add('hidden');
    $('list-view').classList.remove('hidden');
    try { if (location.pathname !== (PREFIX || '/')) history.replaceState(null, '', (PREFIX || '/')); } catch { /* ignore */ }
    document.title = ${JSON.stringify(brand + ' — ' + tagline)};
    current = null; cursor = null; paged = false;
    $('d-position').dataset.shape = '';
    cancelSlip();
    $('t-msg').textContent = ''; $('t-msg').className = 'msg';
    $('t-fill').textContent = '';
    renderTabs();
    loadCats();
    return renderList();
  }

  // -------------------------------------------------------------- events
  $('t-chips').innerHTML = [5, 10, 25, 100].map((v) =>
    '<button type="button" data-stake="' + v + '" aria-pressed="false">' + v + '</button>').join('')
    + '<button type="button" data-stake="max" aria-pressed="false">Max stake</button>';
  $('t-chips').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      // "Max" is a whole balance on an AMM — capped so one tap can't
      // buy a 46-point self-inflicted price move.
      $('t-stake').value = b.dataset.stake === 'max'
        ? Math.max(1, Math.floor(Math.min((me ? me.balance : 0), (current ? current.liquidity * 0.1 : 0)) * 100) / 100)
        : b.dataset.stake;
      newIntent(); // a different stake is a different bet
      quote();
    };
  });

  $('signin').onclick = async () => {
    if (me) { await api('/session', { method: 'DELETE' }); me = null; await refreshMe(true); await route(); return; }
    $('auth-card').classList.remove('hidden');
    $('auth-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    ($('token') || $('acct-user')).focus();
  };
  async function startSession(bearer) {
    await api('/session', { method: 'POST', headers: { authorization: 'Bearer ' + bearer } });
    await refreshMe(); await route();
    toast('Signed in');
  }
  if ($('do-signin')) {
    $('do-signin').onclick = async () => {
      $('auth-msg').textContent = 'Starting session…'; $('auth-msg').className = 'msg';
      try {
        await startSession($('token').value.trim());
        $('token').value = '';
      } catch (e) { $('auth-msg').textContent = e.message; $('auth-msg').className = 'msg err'; }
    };
  }
  // Account mode (standalone host): register/login mint a bearer at
  // {prefix}/api/{register,login}, then the normal session exchange runs.
  async function acctAuth(pathName) {
    const username = $('acct-user').value.trim();
    const password = $('acct-pass').value;
    $('auth-msg').textContent = pathName === '/register' ? 'Creating account…' : 'Signing in…';
    $('auth-msg').className = 'msg';
    try {
      const r = await api(pathName, { method: 'POST', body: JSON.stringify({ username, password }) });
      await startSession(r.token);
      $('acct-pass').value = '';
    } catch (e) { $('auth-msg').textContent = e.message; $('auth-msg').className = 'msg err'; }
  }
  if ($('do-acct-signin')) {
    $('do-acct-signin').onclick = () => acctAuth('/login');
    $('do-acct-register').onclick = () => acctAuth('/register');
    $('acct-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') acctAuth('/login'); });
  }
  $('back').onclick = (e) => { e.preventDefault(); location.hash = ''; };
  // The share URL is the PATH form (/m/<id>), which the server renders with
  // this market's question and odds in its meta — a hash link would unfurl
  // as the generic site card.
  $('share').onclick = async () => {
    if (!current) return;
    const url = location.origin + PREFIX + '/m/' + current.id;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch { window.prompt('Copy this link', url); }
  };
  $('t-buy').onclick = () => {
    if (!me) {
      $('auth-card').classList.remove('hidden');
      $('auth-card').scrollIntoView();
      $('token').focus();
      return;
    }
    reviewBet();
  };
  $('t-confirm').onclick = placeBet;
  $('t-cancel').onclick = () => { cancelSlip(); $('t-buy').focus(); };
  $('more').onclick = () => { paged = true; renderList(true); };
  let searchTimer;
  $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { cursor = null; paged = false; renderList(); }, 250); };
  let quoteTimer;
  $('t-stake').oninput = () => { newIntent(); clearTimeout(quoteTimer); quoteTimer = setTimeout(quote, 220); };

  $('o-resolve').onclick = () => {
    const i = Number($('o-outcome').value);
    const label = current.outcomes[i];
    const typed = prompt('Resolve "' + current.title + '" as "' + label + '".\\n\\n'
      + 'This pays out the whole pool after the dispute window and cannot be undone.\\n'
      + 'Type the winning outcome to confirm:');
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== label.toLowerCase()) { toast('Not resolved — that did not match "' + label + '"'); return; }
    act('resolve', { outcome: i });
  };
  $('o-void').onclick = () => {
    const typed = prompt('Propose voiding "' + current.title + '".\\n\\n'
      + 'Everyone is refunded what they paid in and nobody wins. Holders can dispute it\\n'
      + 'during the window before it settles.\\n\\nType VOID to confirm:');
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== 'VOID') { toast('Not voided'); return; }
    act('void', {});
  };
  $('o-close').onclick = () => act('close', {}, 'Close this market to trading now?');
  $('o-dispute').onclick = () => {
    const reason = prompt('Why is this wrong? (Your bond is forfeited unless an operator agrees.)');
    if (reason && reason.trim()) act('dispute', { reason });
  };

  const adminAct = async (fn) => {
    $('admin-msg').textContent = ''; $('admin-msg').className = 'msg';
    try { await fn(); await refreshMe(); }
    catch (e) { $('admin-msg').textContent = e.message; $('admin-msg').className = 'msg err'; }
  };
  $('ad-lookup').onclick = () => adminAct(async () => {
    const h = await api('/admin/agent?agent=' + encodeURIComponent($('ad-agent').value.trim()));
    $('admin-out').textContent = JSON.stringify(h, null, 1);
  });
  $('ad-freeze').onclick = () => adminAct(() => api('/admin/freeze', {
    method: 'POST', body: JSON.stringify({ agent: $('ad-agent').value.trim(), frozen: true }),
  }).then(() => toast('Frozen')));
  $('ad-unfreeze').onclick = () => adminAct(() => api('/admin/freeze', {
    method: 'POST', body: JSON.stringify({ agent: $('ad-agent').value.trim(), frozen: false }),
  }).then(() => toast('Unfrozen')));
  $('ad-adjust').onclick = () => adminAct(() => api('/admin/adjust', {
    method: 'POST',
    body: JSON.stringify({
      agent: $('ad-agent').value.trim(),
      credits: Number($('ad-credits').value),
      reason: $('ad-reason').value,
    }),
  }).then(() => toast('Adjusted — journalled')));

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
          description: $('c-desc').value,
          ...($('c-oracle').value.trim() ? { oracle: $('c-oracle').value.trim() } : {}),
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
      ? 'Escrow: ' + cr(b * Math.log(n)) + ' credits (b·ln ' + n + ')'
      : 'Escrow: —';
  };
  $('c-outcomes').oninput = $('c-b').oninput = escrowPreview;
  // Arrived via a share link? Hand off to the hash router.
  (function shareEntry() {
    // Both server-visible forms are honoured: the path (/m/<id>) and the
    // query (?m=<id>). A fragment never reaches the server, which is why
    // shared #m/ links unfurled as the generic card.
    // NO REGEX HERE: this file is one big server-side template literal, so
    // a backslash escape is consumed before the browser ever sees it and
    // /\/m\// arrives as //m// — which is a syntax error that takes the
    // whole app down. Plain string work is immune.
    const seg = location.pathname.split('/').filter(Boolean);
    const byPath = seg.length >= 2 && seg[seg.length - 2] === 'm' ? seg[seg.length - 1] : null;
    const byQuery = new URLSearchParams(location.search).get('m');
    const id = byPath || byQuery;
    if (!id || location.hash) return;
    history.replaceState(null, '', (PREFIX || '/') + '#m/' + id);
  })();
  window.addEventListener('hashchange', () => route());

  // Live feed, with reconnect. Only re-render what is on screen.
  let ws, backoff = 1000;
  function setLive(on) {
    $('live').classList.toggle('off', !on);
    $('live-t').textContent = on ? 'Live' : 'Reconnecting';
  }
  function connect() {
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + PREFIX + '/ws');
    } catch { setLive(false); setTimeout(connect, backoff); return; }
    ws.onopen = () => { backoff = 1000; setLive(true); };
    ws.onclose = () => {
      setLive(false);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    let pending = null;
    const schedule = (fn) => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; fn(); }, 300);
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (current) {
        if (msg.market && msg.market.id === current.id) {
          schedule(() => renderDetail(current.id, true).catch((e) => console.error('render', e)));
        }
      } else if (!paged) schedule(() => renderList());
      if (msg.type === 'settle' && me) refreshMe();
    };
  }
  connect();

  // The countdown ticks locally; only re-fetch when it crosses close.
  setInterval(() => {
    if (current && current.tradable) {
      const left = new Date(current.closesAt).getTime() - Date.now();
      if (left <= 0) { renderDetail(current.id, true); return; }
      const el = $('d-stats').querySelector('.v');
      if (el) el.textContent = countdown(current.closesAt);
    } else if (!current) {
      document.querySelectorAll('#list .cd').forEach((el) => {
        el.textContent = countdown(el.dataset.c);
      });
    }
  }, 1000);

  escrowPreview();
  refreshMe(true).then(route);
})();
</script>
</body>
</html>`;
}
