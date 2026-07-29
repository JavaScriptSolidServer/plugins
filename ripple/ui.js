// ripple/ui.js — the server-rendered product UI for the ripple plugin.
//
// One self-contained HTML document (zero deps, zero build, forge-style):
// an app shell over the plugin's JSON api. Sign-in mints a pod bearer from
// the host IdP (/idp/credentials — with account creation via /idp/register),
// so the UI needs no pasted tokens; the bearer lives in localStorage.
//
// Client code deliberately avoids template literals — the whole document is
// one server-side template string, so client JS sticks to quotes + concat.

export function uiPage(prefix) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ripple — trust money</title>
<style>
:root{
  --bg:#EFF3F2; --surface:#FFFFFF; --surface2:#F7FAF9; --ink:#16211F;
  --soft:#5A6B67; --faint:#8CA09B; --line:#D6DEDB; --line-soft:#E4EAE8;
  --acc:#0E7D6C; --acc-ink:#0A5F52; --acc-soft:#DDEEEA;
  --neg:#B3402F; --neg-soft:#F4E0DC; --warn:#9A6417;
  --shadow:0 1px 2px rgba(22,33,31,.05),0 8px 24px rgba(22,33,31,.06);
  --r:12px;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0D1413; --surface:#131B1A; --surface2:#182221; --ink:#E5ECEA;
  --soft:#8FA19C; --faint:#5F726D; --line:#263230; --line-soft:#1E2A28;
  --acc:#3FB59F; --acc-ink:#7BD2C1; --acc-soft:#12302A;
  --neg:#E07A67; --neg-soft:#33201C; --warn:#D69A4A;
  --shadow:0 1px 2px rgba(0,0,0,.35),0 10px 28px rgba(0,0,0,.35);
}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;cursor:pointer}
input,select{font:inherit}
a{color:var(--acc)}

/* ---------- app bar ---------- */
.bar{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar-in{max-width:1080px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:18px}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:-.01em;font-size:16.5px;color:var(--ink);text-decoration:none}
.brand svg{display:block}
nav.tabs{display:flex;gap:2px;margin-left:6px;overflow-x:auto}
nav.tabs a{padding:7px 13px;border-radius:8px;color:var(--soft);text-decoration:none;font-size:14px;font-weight:550;white-space:nowrap}
nav.tabs a:hover{color:var(--ink);background:var(--surface2)}
nav.tabs a.on{color:var(--acc-ink);background:var(--acc-soft)}
.account{margin-left:auto;display:flex;align-items:center;gap:10px;min-width:0}
.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700;font-size:13px;flex:0 0 auto}
.acct-name{font-family:var(--mono);font-size:12.5px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:9px;padding:7px 14px;font-size:13.5px;font-weight:550}
.btn:hover{border-color:var(--acc)}
.btn.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.btn.primary:hover{filter:brightness(1.07)}
.btn.quiet{border-color:transparent;background:transparent;color:var(--soft)}
.btn.quiet:hover{color:var(--ink);background:var(--surface2)}
.btn.danger{color:var(--neg);border-color:color-mix(in srgb,var(--neg) 35%,var(--line))}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.sm{padding:4px 10px;font-size:12.5px;border-radius:7px}

/* ---------- layout ---------- */
main{max-width:1080px;margin:0 auto;padding:26px 20px 90px}
.view{display:none}
.view.on{display:block}
h1{font-size:22px;letter-spacing:-.015em;margin:4px 0 4px}
p.lead{color:var(--soft);margin:0 0 22px;max-width:62ch}
h2{font-size:15px;margin:0;letter-spacing:-.01em}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow)}
.card-h{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line-soft)}
.card-h .spacer{margin-left:auto}
.card-b{padding:18px}
.grid{display:grid;gap:16px}
@media(min-width:840px){.grid.cols2{grid-template-columns:1fr 1fr}.grid.cols3{grid-template-columns:repeat(3,1fr)}}

/* ---------- stat tiles ---------- */
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:16px 18px}
.tile .t-label{font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--faint)}
.tile .t-value{font-size:26px;font-weight:650;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
.tile .t-value small{font-size:14px;color:var(--soft);font-weight:550;margin-left:5px}
.tile .t-sub{font-size:12.5px;color:var(--soft);margin-top:3px}
.pos{color:var(--acc-ink)} .negv{color:var(--neg)}

/* ---------- forms ---------- */
label{display:block;font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin:0 0 6px}
.field{margin-bottom:14px}
input[type=text],input[type=password],input[type=number],select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface2);color:var(--ink);font-size:14px}
input:focus,select:focus{outline:2px solid var(--acc);outline-offset:1px;border-color:var(--acc)}
input.mono{font-family:var(--mono);font-size:13px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.help{font-size:12.5px;color:var(--faint);margin-top:5px}
.formmsg{font-size:13px;margin-top:10px;min-height:18px}
.formmsg.ok{color:var(--acc-ink)} .formmsg.bad{color:var(--neg)}

/* ---------- tables ---------- */
.tbl{width:100%;border-collapse:collapse;font-size:13.5px}
.tbl th{text-align:left;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);padding:8px 10px;border-bottom:1px solid var(--line-soft)}
.tbl td{padding:10px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
.tbl tr:last-child td{border-bottom:0}
.tbl .num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px}
.tblwrap{overflow-x:auto}
.who{display:inline-flex;align-items:center;gap:8px;min-width:0}
.who .avatar{width:24px;height:24px;font-size:11px}
.who .nm{font-weight:550}
.usage{height:5px;border-radius:99px;background:var(--line-soft);overflow:hidden;min-width:90px}
.usage>i{display:block;height:100%;background:var(--acc);border-radius:99px}
.usage>i.hot{background:var(--warn)}
.cur{display:inline-block;font-family:var(--mono);font-size:11px;font-weight:600;color:var(--soft);background:var(--surface2);border:1px solid var(--line);border-radius:6px;padding:1px 7px}
.empty{padding:34px 18px;text-align:center;color:var(--faint);font-size:13.5px}

/* ---------- route preview ---------- */
.route{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:16px;border:1px dashed var(--line);border-radius:10px;background:var(--surface2);min-height:64px}
.route .hopnode{display:inline-flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--line);border-radius:99px;padding:5px 13px 5px 6px;font-weight:550;font-size:13.5px;box-shadow:var(--shadow)}
.route .arrow{color:var(--acc);font-weight:700;padding:0 3px;animation:flow 1.6s ease infinite}
@keyframes flow{0%,100%{opacity:.35}50%{opacity:1}}
.route .r-empty{color:var(--faint);font-size:13px}
.route.err{border-color:color-mix(in srgb,var(--neg) 45%,var(--line))}
.route.err .r-empty{color:var(--neg)}

/* ---------- activity ---------- */
.feed{list-style:none;margin:0;padding:0}
.feed li{display:flex;gap:12px;padding:13px 18px;border-bottom:1px solid var(--line-soft);align-items:flex-start}
.feed li:last-child{border-bottom:0}
.feed .ico{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;flex:0 0 auto;font-size:14px;background:var(--acc-soft);color:var(--acc-ink)}
.feed .ico.neg{background:var(--neg-soft);color:var(--neg)}
.feed .txt{font-size:13.5px;min-width:0}
.feed .txt b{font-weight:600}
.feed .meta{font-size:11.5px;color:var(--faint);font-family:var(--mono);margin-top:2px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border-radius:99px;padding:3px 11px}
.badge.ok{background:var(--acc-soft);color:var(--acc-ink)}
.badge.bad{background:var(--neg-soft);color:var(--neg)}

/* ---------- auth panel ---------- */
.auth-wrap{max-width:400px;margin:34px auto}
.seg{display:flex;background:var(--surface2);border:1px solid var(--line);border-radius:9px;padding:3px;margin-bottom:16px}
.seg button{flex:1;border:0;background:transparent;border-radius:7px;padding:7px;color:var(--soft);font-weight:550;font-size:13.5px}
.seg button.on{background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}

.toast{position:fixed;bottom:24px;left:50%;transform:translate(-50%,16px);opacity:0;background:var(--ink);color:var(--bg);font-size:13px;font-weight:550;padding:10px 18px;border-radius:99px;transition:.22s;pointer-events:none;z-index:60;max-width:88vw}
.toast.show{opacity:1;transform:translate(-50%,0)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>

<header class="bar"><div class="bar-in">
  <a class="brand" href="#overview">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="12" r="3.1" stroke="var(--acc)" stroke-width="2"/>
      <path d="M14.5 7.5a6.4 6.4 0 0 1 0 9" stroke="var(--acc)" stroke-width="2" stroke-linecap="round"/>
      <path d="M17.8 5a10.4 10.4 0 0 1 0 14" stroke="var(--acc)" stroke-width="2" stroke-linecap="round" opacity=".45"/>
    </svg>
    ripple
  </a>
  <nav class="tabs" id="tabs">
    <a href="#overview" data-v="overview">Overview</a>
    <a href="#pay" data-v="pay">Pay</a>
    <a href="#lines" data-v="lines">Trustlines</a>
    <a href="#activity" data-v="activity">Activity</a>
  </nav>
  <div class="account" id="account"></div>
</div></header>

<main>

<!-- ============ AUTH ============ -->
<section class="view" id="v-auth">
  <div class="auth-wrap">
    <h1 style="text-align:center">Money is trust.</h1>
    <p class="lead" style="text-align:center;margin-bottom:22px">Extend credit to people you trust. Pay anyone your network can reach — value routes through the chain, no bank in the middle.</p>
    <div class="card"><div class="card-b">
      <div class="seg"><button id="seg-in" class="on">Sign in</button><button id="seg-up">Create account</button></div>
      <div class="field"><label for="a-user">Username</label><input type="text" id="a-user" autocomplete="username"></div>
      <div class="field"><label for="a-pass">Password</label><input type="password" id="a-pass" autocomplete="current-password"></div>
      <button class="btn primary" id="a-go" style="width:100%">Sign in</button>
      <div class="formmsg" id="a-msg"></div>
    </div></div>
  </div>
</section>

<!-- ============ OVERVIEW ============ -->
<section class="view" id="v-overview">
  <h1>Overview</h1>
  <p class="lead" id="ov-hello"></p>
  <div class="grid cols3" id="ov-tiles"></div>
  <div class="grid cols2" style="margin-top:16px">
    <div class="card">
      <div class="card-h"><h2>Your position</h2></div>
      <div class="tblwrap" id="ov-positions"></div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Recent activity</h2><span class="spacer"></span><a href="#activity" style="font-size:13px">View all</a></div>
      <ul class="feed" id="ov-feed"></ul>
    </div>
  </div>
</section>

<!-- ============ PAY ============ -->
<section class="view" id="v-pay">
  <h1>Send a payment</h1>
  <p class="lead">Type who and how much — the route through your trust network previews live before you commit.</p>
  <div class="grid cols2">
    <div class="card"><div class="card-b">
      <div class="field"><label for="p-to">To</label><input type="text" id="p-to" class="mono" list="peers" placeholder="bob — or a full WebID / did">
        <div class="help">A plain name resolves to a pod on this server.</div></div>
      <div class="row2">
        <div class="field"><label for="p-amt">Amount</label><input type="number" id="p-amt" min="0" step="any" placeholder="0.00"></div>
        <div class="field"><label for="p-cur">Currency</label><input type="text" id="p-cur" class="mono" value="USD" list="curs"></div>
      </div>
      <button class="btn primary" id="p-send" disabled>Send payment</button>
      <div class="formmsg" id="p-msg"></div>
    </div></div>
    <div class="card"><div class="card-h"><h2>Route</h2></div><div class="card-b">
      <div class="route" id="p-route"><span class="r-empty">Enter a recipient and amount to preview the route.</span></div>
      <div class="help" style="margin-top:10px">Every hop rides credit that peer already granted — intermediaries don't need to approve anything.</div>
    </div></div>
  </div>
</section>

<!-- ============ TRUSTLINES ============ -->
<section class="view" id="v-lines">
  <h1>Trustlines</h1>
  <p class="lead">Credit is one-way: what you extend is your risk, what others extend you is your spending power.</p>
  <div class="card" style="margin-bottom:16px">
    <div class="card-h"><h2>Extend new trust</h2></div>
    <div class="card-b">
      <div class="row2">
        <div class="field"><label for="t-peer">Peer</label><input type="text" id="t-peer" class="mono" list="peers" placeholder="bob — or a full WebID / did"></div>
        <div class="field"><label for="t-cur">Currency</label><input type="text" id="t-cur" class="mono" value="USD" list="curs"></div>
      </div>
      <div class="row2">
        <div class="field"><label for="t-lim">Credit limit</label><input type="number" id="t-lim" min="0" step="any" placeholder="100"></div>
        <div class="field" style="display:flex;align-items:flex-end"><button class="btn primary" id="t-go" style="width:100%">Extend trust</button></div>
      </div>
      <div class="formmsg" id="t-msg"></div>
    </div>
  </div>
  <div class="grid cols2">
    <div class="card"><div class="card-h"><h2>You extend</h2></div><div class="tblwrap" id="l-out"></div></div>
    <div class="card"><div class="card-h"><h2>Extended to you</h2></div><div class="tblwrap" id="l-in"></div></div>
  </div>
</section>

<!-- ============ ACTIVITY ============ -->
<section class="view" id="v-activity">
  <h1>Activity</h1>
  <p class="lead">Every transition is hash-chained — the ledger proves its own history.</p>
  <div class="card">
    <div class="card-h"><h2>Ledger</h2><span class="spacer"></span><span id="chainbadge"></span></div>
    <ul class="feed" id="feed"></ul>
  </div>
</section>

</main>
<datalist id="peers"></datalist>
<datalist id="curs"><option value="USD"><option value="EUR"><option value="GBP"><option value="SATS"><option value="HRS"></datalist>
<div class="toast" id="toast"></div>

<script>
"use strict";
(function(){
var P=${JSON.stringify(prefix)};
var S={me:null,graph:{trustlines:[],balances:[]},log:[],verify:null,route:null,signupMode:false};
var $=function(id){return document.getElementById(id)};

/* ---------------- utils ---------------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmt(n){return Number(n).toLocaleString(undefined,{maximumFractionDigits:6})}
function shortName(id){
  if(!id)return '—';
  var m=String(id).match(/\\/([^\\/]+)\\/profile\\/card/); if(m)return m[1];
  if(id.indexOf('did:')===0){var p=id.split(':');return p[1]+':'+(p[2]||'').slice(0,8)+'…'}
  return id.length>26?id.slice(0,12)+'…'+id.slice(-8):id;
}
function hue(id){var h=0;for(var i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))>>>0;return h%360}
function avatar(id,cls){return '<span class="avatar '+(cls||'')+'" style="background:hsl('+hue(String(id))+' 42% 46%)" title="'+esc(id)+'">'+esc(shortName(id).charAt(0).toUpperCase())+'</span>'}
function whoChip(id){return '<span class="who">'+avatar(id)+'<span class="nm" title="'+esc(id)+'">'+esc(shortName(id))+'</span></span>'}
function toast(m){var t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(function(){t.classList.remove('show')},2300)}
function token(){return localStorage.getItem('rippleToken')||''}
function hdrs(){var h={'content-type':'application/json'};if(token())h.authorization='Bearer '+token();return h}
function api(p,opt){return fetch(P+'/api'+p,opt).then(function(r){return r.json().then(function(b){return{ok:r.ok,status:r.status,body:b}}).catch(function(){return{ok:r.ok,status:r.status,body:{}}})})}
function resolvePeer(v){
  v=(v||'').trim(); if(!v)return null;
  if(/^[A-Za-z0-9._-]+$/.test(v)&&v.indexOf(':')<0)return location.origin+'/'+v+'/profile/card#me';
  return v;
}
function debounce(fn,ms){var t;return function(){var a=arguments;clearTimeout(t);t=setTimeout(function(){fn.apply(null,a)},ms)}}

/* ---------------- routing ---------------- */
var VIEWS=['overview','pay','lines','activity'];
function currentView(){var h=(location.hash||'#overview').slice(1);return VIEWS.indexOf(h)>=0?h:'overview'}
function route(){
  var v=S.me?currentView():'auth';
  document.querySelectorAll('.view').forEach(function(el){el.classList.remove('on')});
  $('v-'+v).classList.add('on');
  document.querySelectorAll('#tabs a').forEach(function(a){a.classList.toggle('on',a.dataset.v===v)});
}
window.addEventListener('hashchange',route);

/* ---------------- data ---------------- */
function refresh(){
  return Promise.all([
    api('/whoami',{headers:hdrs()}),
    api('/graph'),
    api('/log?limit=200'),
    api('/log/verify')
  ]).then(function(rs){
    S.me=rs[0].body.agent||null;
    S.graph=rs[1].body||S.graph;
    S.log=(rs[2].body.entries||[]);
    S.verify=rs[3].body;
    render();
  });
}

/* ---------------- derived ---------------- */
function myLines(dir){ // dir 'out': I am creditor; 'in': I am debtor
  return S.graph.trustlines.filter(function(l){return dir==='out'?l.creditor===S.me:l.debtor===S.me});
}
function owes(debtor,creditor,cur){
  var hit=S.graph.balances.find(function(b){return b.debtor===debtor&&b.creditor===creditor&&b.currency===cur});
  return hit?hit.amount:0;
}
function allAgents(){
  var s={};
  S.graph.trustlines.forEach(function(l){s[l.creditor]=1;s[l.debtor]=1});
  S.graph.balances.forEach(function(b){s[b.creditor]=1;s[b.debtor]=1});
  return Object.keys(s);
}
function perCur(fn){ // aggregate helper → {CUR: total}
  var out={};
  fn(function(cur,amt){out[cur]=(out[cur]||0)+amt});
  return out;
}

/* ---------------- render ---------------- */
function render(){renderAccount();renderPeers();if(!S.me){route();return}
  renderOverview();renderLines();renderActivity();route()}

function renderAccount(){
  var el=$('account');
  if(S.me){
    el.innerHTML=avatar(S.me)+'<span class="acct-name" title="'+esc(S.me)+'">'+esc(shortName(S.me))+'</span>'
      +'<button class="btn quiet sm" id="signout">Sign out</button>';
    $('signout').onclick=function(){localStorage.removeItem('rippleToken');S.me=null;location.hash='#overview';refresh()};
  }else{
    el.innerHTML='<button class="btn primary sm" onclick="location.hash=\\'#overview\\'">Sign in</button>';
  }
}
function renderPeers(){
  $('peers').innerHTML=allAgents().filter(function(a){return a!==S.me}).map(function(a){
    return '<option value="'+esc(a)+'">'+esc(shortName(a))+'</option>'}).join('');
}

function renderOverview(){
  $('ov-hello').textContent='Welcome back, '+shortName(S.me)+'.';
  // spendable = Σ available on lines extended TO me; receivable = Σ available on lines I extend
  var net=perCur(function(add){S.graph.balances.forEach(function(b){
    if(b.creditor===S.me)add(b.currency,b.amount);
    if(b.debtor===S.me)add(b.currency,-b.amount);
  })});
  var spend=perCur(function(add){myLines('in').forEach(function(l){add(l.currency,l.available)})});
  var recv=perCur(function(add){myLines('out').forEach(function(l){add(l.currency,l.available)})});
  function tile(label,map,sub,signed){
    var ks=Object.keys(map);
    var v=ks.length?ks.map(function(c){
      var n=map[c];var cls=signed?(n>0?'pos':(n<0?'negv':'')):'';
      return '<span class="'+cls+'">'+(signed&&n>0?'+':'')+fmt(n)+'<small>'+esc(c)+'</small></span>';
    }).join('<span style="color:var(--line);padding:0 8px">·</span>'):'<span style="color:var(--faint)">0</span>';
    return '<div class="tile"><div class="t-label">'+label+'</div><div class="t-value">'+v+'</div><div class="t-sub">'+sub+'</div></div>';
  }
  $('ov-tiles').innerHTML=
    tile('Net position',net,'What the network owes you, minus what you owe',true)
    +tile('You can spend',spend,'Unused credit extended to you')
    +tile('You can receive',recv,'Unused credit you extend to others');
  // positions table
  var rows=S.graph.balances.filter(function(b){return b.creditor===S.me||b.debtor===S.me}).map(function(b){
    var peer=b.creditor===S.me?b.debtor:b.creditor;
    var mine=b.creditor===S.me;
    return '<tr><td>'+whoChip(peer)+'</td><td>'+(mine?'owes you':'you owe')+'</td>'
      +'<td class="num '+(mine?'pos':'negv')+'">'+(mine?'+':'−')+fmt(b.amount)+'</td><td><span class="cur">'+esc(b.currency)+'</span></td></tr>';
  }).join('');
  $('ov-positions').innerHTML=rows
    ?'<table class="tbl"><tr><th>Peer</th><th></th><th style="text-align:right">Amount</th><th>Cur</th></tr>'+rows+'</table>'
    :'<div class="empty">No IOUs yet — extend trust and start paying.</div>';
  $('ov-feed').innerHTML=feedItems(S.log.slice(-5).reverse())||'<div class="empty">Nothing yet.</div>';
}

function usageBar(used,limit){
  var pct=limit>0?Math.min(100,100*used/limit):0;
  return '<div class="usage"><i style="width:'+pct.toFixed(1)+'%" class="'+(pct>80?'hot':'')+'"></i></div>';
}
function renderLines(){
  var out=myLines('out').map(function(l){
    var debt=owes(l.debtor,l.creditor,l.currency);
    var canRemove=debt<=0;
    return '<tr><td>'+whoChip(l.debtor)+'</td><td><span class="cur">'+esc(l.currency)+'</span></td>'
      +'<td class="num">'+fmt(l.limit)+'</td>'
      +'<td>'+usageBar(l.debt,l.limit)+'<div class="help" style="margin-top:3px">'+fmt(l.debt)+' used · '+fmt(l.available)+' free</div></td>'
      +'<td style="white-space:nowrap">'
      +(debt>0?'<button class="btn sm" data-act="settle" data-peer="'+esc(l.debtor)+'" data-cur="'+esc(l.currency)+'" data-max="'+debt+'">Record repayment</button> ':'')
      +'<button class="btn sm quiet" data-act="edit" data-peer="'+esc(l.debtor)+'" data-cur="'+esc(l.currency)+'" data-lim="'+l.limit+'">Adjust</button> '
      +'<button class="btn sm danger" data-act="remove" data-peer="'+esc(l.debtor)+'" data-cur="'+esc(l.currency)+'" '+(canRemove?'':'disabled title="Outstanding debt — settle first"')+'>Remove</button>'
      +'</td></tr>';
  }).join('');
  $('l-out').innerHTML=out
    ?'<table class="tbl"><tr><th>Peer</th><th>Cur</th><th style="text-align:right">Limit</th><th>Usage</th><th></th></tr>'+out+'</table>'
    :'<div class="empty">You extend no credit yet. Trust someone above.</div>';
  var inn=myLines('in').map(function(l){
    return '<tr><td>'+whoChip(l.creditor)+'</td><td><span class="cur">'+esc(l.currency)+'</span></td>'
      +'<td class="num">'+fmt(l.limit)+'</td>'
      +'<td>'+usageBar(l.debt,l.limit)+'<div class="help" style="margin-top:3px">'+fmt(l.debt)+' used · '+fmt(l.available)+' to spend</div></td></tr>';
  }).join('');
  $('l-in').innerHTML=inn
    ?'<table class="tbl"><tr><th>From</th><th>Cur</th><th style="text-align:right">Limit</th><th>Usage</th></tr>'+inn+'</table>'
    :'<div class="empty">Nobody extends you credit yet — ask a peer to trust you.</div>';
  $('l-out').querySelectorAll('button[data-act]').forEach(function(b){b.onclick=lineAction});
}

function feedItems(entries){
  return entries.map(function(e){
    var p=e.params||{};var t='',ico='↔',neg=false;
    if(e.type==='create-trustline'){ico='+';t='<b>'+esc(shortName(e.actor))+'</b> extended <b>'+esc(shortName(p.peer))+'</b> credit of '+fmt(p.limit)+' '+esc(p.currency)}
    else if(e.type==='update-trustline'){ico='±';t='<b>'+esc(shortName(e.actor))+'</b> adjusted <b>'+esc(shortName(p.peer))+'</b>\\u2019s credit to '+fmt(p.limit)+' '+esc(p.currency)}
    else if(e.type==='remove-trustline'){ico='×';neg=true;t='<b>'+esc(shortName(e.actor))+'</b> removed the '+esc(p.currency)+' trustline to <b>'+esc(shortName(p.peer))+'</b>'}
    else if(e.type==='send-payment'){ico='→';t='<b>'+esc(shortName(p.from))+'</b> paid <b>'+esc(shortName(p.to))+'</b> '+fmt(p.amount)+' '+esc(p.currency)
      +((p.path||[]).length>2?' via '+p.path.slice(1,-1).map(shortName).map(esc).join(', '):'')}
    else if(e.type==='settle'){ico='✓';t='<b>'+esc(shortName(e.actor))+'</b> recorded <b>'+esc(shortName(p.peer))+'</b> repaying '+fmt(p.amount)+' '+esc(p.currency)}
    else{t=esc(e.type)}
    return '<li><span class="ico'+(neg?' neg':'')+'">'+ico+'</span><div class="txt">'+t
      +'<div class="meta">#'+e.seq+' · '+esc((e.ts||'').replace('T',' ').replace(/\\..*/,''))+' · '+esc((e.hash||'').slice(0,18))+'…</div></div></li>';
  }).join('');
}
function renderActivity(){
  $('feed').innerHTML=feedItems(S.log.slice().reverse())||'<div class="empty">No transitions yet.</div>';
  var v=S.verify||{};
  $('chainbadge').innerHTML=v.valid
    ?'<span class="badge ok">⛓ chain verified · seq '+(v.seq||0)+'</span>'
    :'<span class="badge bad">⛓ chain BROKEN at '+esc(v.brokenAt)+'</span>';
}

/* ---------------- auth ---------------- */
function setSeg(up){S.signupMode=up;$('seg-in').classList.toggle('on',!up);$('seg-up').classList.toggle('on',up);
  $('a-go').textContent=up?'Create account':'Sign in'}
$('seg-in').onclick=function(){setSeg(false)};
$('seg-up').onclick=function(){setSeg(true)};
function authGo(){
  var u=$('a-user').value.trim(),p=$('a-pass').value;
  var m=$('a-msg');m.className='formmsg';m.textContent='';
  if(!u||!p){m.className='formmsg bad';m.textContent='Username and password required.';return}
  var pre=S.signupMode
    ?fetch('/idp/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p,confirmPassword:p})})
      .then(function(r){if(!r.ok&&r.status!==302)return r.json().catch(function(){return{}}).then(function(b){throw new Error(b.error||('registration failed ('+r.status+')'))})})
    :Promise.resolve();
  pre.then(function(){
    return fetch('/idp/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u,password:p})})
  }).then(function(r){return r.json()}).then(function(b){
    if(!b.access_token)throw new Error(S.signupMode
      ?'Could not sign in after registration — that username may already be taken.'
      :'Wrong username or password.');
    localStorage.setItem('rippleToken',b.access_token);
    toast(S.signupMode?'Account created — welcome!':'Signed in');
    $('a-pass').value='';
    return refresh();
  }).catch(function(e){m.className='formmsg bad';m.textContent=e.message});
}
$('a-go').onclick=authGo;
$('a-pass').addEventListener('keydown',function(e){if(e.key==='Enter')authGo()});

/* ---------------- pay ---------------- */
var previewRoute=debounce(function(){
  var to=resolvePeer($('p-to').value),amt=Number($('p-amt').value),cur=($('p-cur').value||'').toUpperCase().trim();
  var box=$('p-route');
  if(!S.me||!to||!(amt>0)||!cur){box.className='route';box.innerHTML='<span class="r-empty">Enter a recipient and amount to preview the route.</span>';$('p-send').disabled=true;S.route=null;return}
  api('/path?from='+encodeURIComponent(S.me)+'&to='+encodeURIComponent(to)+'&currency='+encodeURIComponent(cur)+'&amount='+encodeURIComponent(amt))
  .then(function(r){
    if(!r.ok){box.className='route err';box.innerHTML='<span class="r-empty">No route — nobody on a path to '+esc(shortName(to))+' has '+fmt(amt)+' '+esc(cur)+' of free credit.</span>';$('p-send').disabled=true;S.route=null;return}
    S.route=r.body.path;
    box.className='route';
    box.innerHTML=r.body.path.map(function(n){return '<span class="hopnode">'+avatar(n)+esc(shortName(n))+'</span>'})
      .join('<span class="arrow">→</span>');
    $('p-send').disabled=false;
  });
},280);
['p-to','p-amt','p-cur'].forEach(function(id){$(id).addEventListener('input',previewRoute)});
$('p-send').onclick=function(){
  var to=resolvePeer($('p-to').value),amt=Number($('p-amt').value),cur=($('p-cur').value||'').toUpperCase().trim();
  var m=$('p-msg');m.className='formmsg';m.textContent='Routing…';
  api('/payments',{method:'POST',headers:hdrs(),body:JSON.stringify({to:to,currency:cur,amount:amt})})
  .then(function(r){
    if(!r.ok){m.className='formmsg bad';m.textContent=r.body.error||('payment failed ('+r.status+')');return}
    m.className='formmsg ok';m.textContent='Delivered — '+fmt(amt)+' '+cur+' to '+shortName(to)+' over '+(r.body.payment.path.length-1)+' hop(s).';
    toast('Payment delivered');$('p-amt').value='';S.route=null;previewRoute();refresh();
  });
};

/* ---------------- trustlines ---------------- */
$('t-go').onclick=function(){
  var peer=resolvePeer($('t-peer').value),cur=($('t-cur').value||'').toUpperCase().trim(),lim=Number($('t-lim').value);
  var m=$('t-msg');m.className='formmsg';m.textContent='';
  api('/trustlines',{method:'POST',headers:hdrs(),body:JSON.stringify({peer:peer,currency:cur,limit:lim})})
  .then(function(r){
    if(!r.ok){m.className='formmsg bad';m.textContent=r.body.error||('failed ('+r.status+')');return}
    m.className='formmsg ok';m.textContent='Trustline set: '+shortName(peer)+' can owe you up to '+fmt(lim)+' '+cur+'.';
    toast('Trust extended');$('t-peer').value='';refresh();
  });
};
function lineAction(ev){
  var b=ev.currentTarget,act=b.dataset.act,peer=b.dataset.peer,cur=b.dataset.cur;
  if(act==='edit'){
    var v=prompt('New credit limit for '+shortName(peer)+' ('+cur+'):',b.dataset.lim);
    if(v===null)return;
    api('/trustlines',{method:'POST',headers:hdrs(),body:JSON.stringify({peer:peer,currency:cur,limit:Number(v)})})
      .then(function(r){toast(r.ok?'Limit updated':(r.body.error||'failed'));refresh()});
  }else if(act==='remove'){
    api('/trustlines/remove',{method:'POST',headers:hdrs(),body:JSON.stringify({peer:peer,currency:cur})})
      .then(function(r){toast(r.ok?'Trustline removed':(r.body.error||'failed'));refresh()});
  }else if(act==='settle'){
    var max=Number(b.dataset.max);
    var amt=prompt(shortName(peer)+' owes you '+fmt(max)+' '+cur+'. Amount repaid out-of-band:',String(max));
    if(amt===null)return;
    api('/settle',{method:'POST',headers:hdrs(),body:JSON.stringify({peer:peer,currency:cur,amount:Number(amt)})})
      .then(function(r){toast(r.ok?'Repayment recorded':(r.body.error||'failed'));refresh()});
  }
}

/* ---------------- boot ---------------- */
refresh();
setInterval(function(){if(document.visibilityState==='visible')refresh()},6000);
})();
</script>
</body></html>`;
}
