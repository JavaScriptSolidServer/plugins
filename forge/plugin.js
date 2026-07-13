// forge — a personal git forge (tier 1: hosting + browsing; tier 2: issues
// + comments; tier 2.5: first-class did:nostr agents + the xlogin widget;
// tier 3a: forks, compare, and pull requests with REAL merges; polish:
// labels, read-time search, releases/archives, hidden compare refs;
// tier 3.5: git-mark anchoring via Blocktrails — Bitcoin(testnet)-anchored,
// tamper-evident repo history) as a #206 loader plugin. The useful slice of
// Gogs/Gitea: push a repo, get a GitHub-style web UI for it — with the
// constraints that killed the last attempt made absolute: zero build step,
// every page server-rendered HTML with inline CSS, all git work done
// by the system `git` binary, and one npm dependency, @noble/curves — the
// host's own crypto library — for the Blocktrails secp256k1 point math
// (the blocktrails npm package is deliberately NOT imported; the spec math
// is implemented here and cross-checked against a reference-impl vector in
// test.js). Client JavaScript is the 3-line clone-URL
// copy button plus one dependency-free inline module on the issues pages
// (login + fetch against the JSON API; the server always renders the truth).
//
//   plugins: [{ id: 'forge', module: 'forge/plugin.js', prefix: '/forge',
//               config: { privateRepos: false } }]
//
// Layout (everything under the one prefix — no reservePath needed):
//
//   smart HTTP    <prefix>/<owner>/<name>.git/{info/refs,git-upload-pack,git-receive-pack}
//   index         <prefix>/                          all repos, all owners
//   owner         <prefix>/<owner>                   that owner's repos
//   repo home     <prefix>/<owner>/<name>            file table + README
//   tree/blob     <prefix>/<owner>/<name>/{tree,blob}/<ref>/<path>
//   raw           <prefix>/<owner>/<name>/raw/<ref>/<path>
//   commits       <prefix>/<owner>/<name>/commits/<ref>?page=N
//   commit        <prefix>/<owner>/<name>/commit/<sha>
//   refs          <prefix>/<owner>/<name>/{branches,tags}
//   issues        <prefix>/<owner>/<name>/issues[?state=&label=|/new|/<n>]
//   search        <prefix>/<owner>/<name>/search?q=          (default branch, read-time)
//   releases      <prefix>/<owner>/<name>/releases           (every tag, newest first)
//   archive       <prefix>/<owner>/<name>/archive/<ref>.{tar.gz,zip}
//   labels        <prefix>/api/repos/<o>/<n>/labels[/<name>] (+ PUT .../{issues,pulls}/<n>/labels)
//   compare       <prefix>/<owner>/<name>/compare/<base>...[<owner>:]<ref>
//   pulls         <prefix>/<owner>/<name>/pulls[?state=|/new|/<n>[/commits|/files]]
//   anchors       <prefix>/<owner>/<name>/marks     (HTML) + api/repos/<o>/<n>/marks (JSON)
//                 POST api/repos/<o>/<n>/marks/enable        (owner: genesis mark)
//                 POST api/repos/<o>/<n>/marks/<i>/txo       (owner: record on-chain txo)
//                 GET  <prefix>/<owner>/<name>/blocktrails.json  (CORS-readable trail doc)
//   nostr         POST api/repos/<o>/<n>/announce    (owner: publish NIP-34 30617 + 30618 to relays)
//                 GET  api/repos/<o>/<n>/nostr        (the signed 30617 + 30618 that WOULD be published)
//   fork          POST <prefix>/api/repos/<o>/<n>/fork
//   web edit      POST api/repos/<o>/<n>/edit  {path,content,message?,branch?}
//                 (owner-signed by default; config.openEdit => anon DEMO; CORS+preflight)
//   push tokens   <prefix>/api/token                 (POST, any getAgent credential)
//   hosted words  <prefix>/api/hosted/<hex>/<uuid>   (GET public, DELETE author-only)
//   xlogin        <prefix>/xlogin.js                 (vendored widget, byte-identical)
//
// TIER 2 — issues and comments, pod-native (see README Findings):
// the WORDS live in the author's pod (loopback PUT of a JSON-LD resource
// under <author's pod>/public/forge/<owner>--<repo>/ with the author's own
// forwarded Bearer, so real WAC governs the write and the resource is the
// author's property); the SPINE lives in pluginDir/issues/<owner>/<repo>.json
// (next number, per-issue title/state/author + an ordered thread of
// {author, resourceUrl, at} pointers — never body text). Bodies are
// re-fetched from the pods at read time; a deleted resource renders as
// "content removed by its author".
//
// TIER 2.5 — did:nostr agents are first-class (see README "Nostr agents"):
// the canonical nostr identity is `did:nostr:<64-hex-pubkey>` (exactly what
// getAgent returns for a NIP-98 signature with no WebID mapping); the hex
// pubkey IS the agent's forge namespace (`<prefix>/<hex>/<repo>.git`).
// npub (bech32) is DISPLAY-ONLY — storage paths, index keys and API ids
// stay hex everywhere. Because git's static http.extraHeader cannot sign
// per-request NIP-98 (a push is several requests with different URLs and
// methods), `POST <prefix>/api/token` exchanges ANY getAgent-accepted
// credential for a short-lived macaroon-lite HMAC bearer (capability/'s
// pattern) that the git lane accepts in addition to getAgent. did:nostr
// agents have no pod, so their issue/comment bodies are stored under
// pluginDir/hosted/<hex>/ ("hosted by the forge" — the podless-agent
// asymmetry is a named Finding), deletable by their author over the API.
// The issues pages also serve/load the vendored xlogin widget (NIP-98 /
// DPoP client-side auth) beside the local username/password fallback.
//
// TIER 3.5 — git-mark anchoring via Blocktrails (see README "Anchors"):
// the server DERIVES AND RECORDS; it NEVER touches the network. Per-repo
// trail state (a forge-held testnet trail key + the mark list) lives at
// pluginDir/marks/<owner>/<repo>.json. Each mark commits one state
// { commit, repo, branch }; its P2TR address is derived by chained
// BIP-341 TapTweak (blocktrails spec v0.2) over
// sha256(JSON.stringify(state)) — pure @noble/curves + node:crypto.
// Spending the PREVIOUS mark's UTXO to the NEW mark's address IS the
// advance; the transactions happen elsewhere (the maintainer's fund-agent
// / git-mark CLIs), the owner reports { txid, vout, amount } back and the
// hosted blocktrails verifier checks the chain client-side. Bitcoin
// appears here only as derived bech32m addresses, mempool.space links in
// HTML, and the served blocktrails.json. Testnet-only defaults
// (chain 'tbtc4'); mainnet chains are refused at activate unless
// config.allowMainnet is explicitly true.
//
// Ownership: owner = the pod username derived from the pusher's WebID
// (mastodon/'s podFromWebid rule), or the 64-hex pubkey for did:nostr
// agents. Push-to-create: an authenticated agent
// pushing into its OWN namespace materializes the bare repo under
// pluginDir/repos/<owner>/<name>.git — persistent, no TTL (this is a
// forge, not a scratchpad). Pushing into someone else's namespace is 403;
// anonymous push is 401 + WWW-Authenticate. Clone/fetch and the web UI are
// public by default; config.privateRepos flips ALL reads to owner-only.
//
// The git wire protocol is NOT reimplemented: requests are delegated to
// the stock git-http-backend CGI with the raw request body streamed
// through (gitscratch's proven scoped pass-through parser — this plugin
// does not need api.mountApp). All server-side git runs hermetic:
// GIT_CONFIG_NOSYSTEM=1 and no HOME in the environment.
//
// SECURITY posture (see README Findings):
//   - raw blobs are NEVER served as text/html: text-ish content goes out
//     as text/plain, everything else as application/octet-stream with
//     content-disposition: attachment, plus X-Content-Type-Options:
//     nosniff — a pushed .html file cannot become stored XSS on the API
//     origin (GitHub solves this with a separate raw domain; we solve it
//     with content-type neutralization).
//   - every interpolated string in HTML goes through one esc() helper —
//     filenames, commit messages, author names, diff bodies are all
//     attacker-controlled.
//   - the README markdown renderer escapes FIRST, then transforms a
//     bounded subset; hrefs are allowlisted to http/https/relative.
//   - every owner/repo/ref/path segment is validated against strict
//     patterns; '..', backslash, leading dots and encoded traversal are
//     rejected before any path or git argument is built.

import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import {
  npubEncode, p2trAddressEncode, markStateHash, trailProgram, trailAddress, npubShort,
} from './lib/blocktrails.js';
// re-export the four the test suite imports from plugin.js (back-compat)
export { markStateHash, npubEncode, trailAddress, trailProgram } from './lib/blocktrails.js';

const execFileP = promisify(execFile);

const DEFAULT_BACKEND = '/usr/lib/git-core/git-http-backend';
const META_FILE = 'jss-forge.json';
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

// Conservative names, gitscratch rigor. Owner and repo (UI name, no .git)
// must start alphanumeric; no slashes, no traversal, no trailing .git.
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Refs may contain '/' (feature/x) but never '..'; shas are plain hex.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const SHA_RE = /^[0-9a-f]{4,64}$/;
// Path segments: reject empties, traversal, backslash, control chars and
// percent-encoded dot/slash/backslash (belt and braces if decoding varies).
const BAD_SEG = /^\.|\.\.|[\\\x00-\x1f]|%2e|%2f|%5c/i;

// Web-edit (tier 3.7): a single repo-relative file path the browser edits.
// One segment = a conservative filename charset (no spaces, no exotica —
// the demo edits ordinary files); '..', '.git' and a leading-dot root are
// refused explicitly below. Content is capped so one edit cannot balloon.
const EDIT_SEG = /^[A-Za-z0-9._-]+$/;
const EDIT_CONTENT_CAP = 1024 * 1024; // 1 MiB of file content per edit
const EDIT_MSG_CAP = 1000;            // commit-message chars
const EDIT_PATH_CAP = 1024;           // whole path chars
// The UNSTAGED tier: a preview edit rides a NIP-01 EPHEMERAL event (kind in
// 20000..29999 — relays SHOULD NOT store it), carrying the file content but
// touching neither git nor Bitcoin. Every currently-connected viewer applies
// it and throws it away; nothing is persisted anywhere. Promotion to the
// committed tier is the /edit endpoint; to the marked tier, an anchor.
const EPHEMERAL_PREVIEW_KIND = 21617;

// Tier-2.5: nostr identity. A did:nostr agent's namespace is its 64-hex
// pubkey — unambiguous in practice (pod names are human-chosen; a pod
// literally named as 64 lowercase hex chars is theoretically possible under
// OWNER_NAME, in which case hex-as-nostr-namespace wins — see README).
const NOSTR_HEX = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORGE_TOKEN_MAX_TTL = 30 * 24 * 3600;

const RENDER_CAP = 512 * 1024; // blobs/READMEs above this: "view raw"
const PER_PAGE = 30;
const MAX_EXEC_BUFFER = 64 * 1024 * 1024;

// Tier-2 bounds: caps first, so a hostile client cannot balloon the index
// or make read-time thread resolution unbounded.
const ISSUES_PER_PAGE = 25;
const ISSUE_TITLE_CAP = 256;
const ISSUE_BODY_CAP = 64 * 1024;       // markdown source, per issue/comment
const DESCRIPTION_CAP = 512;
const THREAD_CAP = 500;                 // entries per issue (1 body + comments)
const THREAD_FETCH_CONCURRENCY = 8;     // parallel loopback GETs at read time
const THREAD_FETCH_TIMEOUT_MS = 8000;
const ISSUE_NUM_RE = /^[1-9][0-9]{0,8}$/;

// Polish wave: labels (GitHub's default set), search bounds, archive bounds.
const DEFAULT_LABELS = [
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'wontfix', color: 'ffffff' },
];
const LABEL_NAME_RE = /^[^\x00-\x1f\x7f]{1,50}$/; // printable, 1-50 chars
const LABEL_COLOR_RE = /^[0-9a-fA-F]{6}$/;
const LABELS_PER_ITEM = 20;
const SEARCH_QUERY_CAP = 256;   // chars of query
const SEARCH_HIT_CAP = 100;     // total grep hits returned
const SEARCH_PATH_CAP = 100;    // total path matches returned
const SEARCH_PER_FILE_CAP = 5;  // grep --max-count per file
const SEARCH_EXCERPT_CAP = 200; // chars of line excerpt

// Tier-3.5: Blocktrails anchoring. chain -> bech32(m) HRP (BIP-173/350)
// and mempool.space explorer path. Mainnet identifiers are refused at
// activate unless config.allowMainnet — this plugin's custody posture is
// testnet-grade (see README Findings).
const CHAIN_HRP = { btc: 'bc', mainnet: 'bc', bitcoin: 'bc', tbtc4: 'tb', tbtc3: 'tb', signet: 'tb', regtest: 'bcrt' };
const MAINNET_CHAINS = new Set(['btc', 'mainnet', 'bitcoin']);
const MEMPOOL_PATH = { btc: '', mainnet: '', bitcoin: '', tbtc4: '/testnet4', tbtc3: '/testnet', signet: '/signet' };
const TXID64 = /^[0-9a-f]{64}$/;
const MARK_INDEX_RE = /^(0|[1-9][0-9]{0,5})$/;
const MARKS_CAP = 500;           // marks per trail (each push stacks one)
const SATS_CAP = 2_100_000_000_000_000; // 21M BTC in sats

// ---------------------------------------------------------------- helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function okSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && !BAD_SEG.test(s);
}
function okPath(segs) {
  return segs.every(okSegment);
}
function okRef(ref) {
  return REF_RE.test(ref) && !ref.includes('..') && !ref.endsWith('/') && !ref.includes('//');
}

/** Unix seconds -> "3 days ago" (server-side; no client JS needed). */
function relTime(unixSecs) {
  const s = Math.floor(Date.now() / 1000) - unixSecs;
  if (!Number.isFinite(s)) return '';
  if (s < 45) return 'just now';
  const steps = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
  for (let i = 0; i < steps.length; i++) {
    const next = steps[i + 1];
    if (!next || s < next[0]) {
      const n = Math.max(1, Math.round(s / steps[i][0]));
      return `${n} ${steps[i][1]}${n === 1 ? '' : 's'} ago`;
    }
  }
  return '';
}

/**
 * GitHub-style chip readability: perceptual luminance of the (validated
 * 6-hex) label color decides black-ish or white text on the chip.
 */
function labelTextColor(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? '#1f2328' : '#ffffff';
}

/** Rounded-full colored chips for resolved label defs [{name, color}]. */
function labelChips(labels) {
  return labels.map((l) => `<span class="label-chip" style="background:#${esc(l.color)};color:${labelTextColor(l.color)}">${esc(l.name)}</span>`).join(' ');
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i ? v.toFixed(1) : v} ${units[i]}`;
}

/** NUL in the first 8000 bytes => binary (git's own heuristic). */
function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Deterministic GitHub-style identicon: 5x5 mirrored pixel SVG from
 * md5(email), hue from the trailing hash bytes, #f0f0f0 background.
 */
function identicon(email, px = 20) {
  const hash = crypto.createHash('md5').update(String(email || '?').trim().toLowerCase()).digest();
  const hue = ((hash[12] << 8) | hash[13]) % 360;
  const fg = `hsl(${hue},46%,52%)`;
  let rects = '';
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if (hash[r * 3 + c] % 2 === 0) {
        rects += `<rect x="${c + 1}" y="${r + 1}" width="1" height="1"/>`;
        if (c < 2) rects += `<rect x="${5 - c}" y="${r + 1}" width="1" height="1"/>`;
      }
    }
  }
  return `<svg class="avatar" width="${px}" height="${px}" viewBox="0 0 7 7" shape-rendering="crispEdges" role="img" aria-label="identicon">`
    + `<rect width="7" height="7" fill="#f0f0f0"/><g fill="${fg}">${rects}</g></svg>`;
}

const ICON_DIR = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#54aeff" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
const ICON_FILE = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#59636e" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>';
const ICON_REPO = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#59636e" aria-hidden="true"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>';
const ICON_BRANCH = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';
const ICON_TAG = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>';
// GitHub's issue-opened (green circle-dot) and issue-closed (purple check).
const ICON_ISSUE_OPEN = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#1a7f37" aria-hidden="true"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>';
const ICON_ISSUE_CLOSED = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#8250df" aria-hidden="true"><path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/></svg>';
// GitHub's git-pull-request (green open), git-merge (purple merged) and
// git-pull-request-closed (red closed) octicons — tier 3a.
const PR_PATH = 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z';
const ICON_PR_OPEN = `<svg class="icon pr-open" width="16" height="16" viewBox="0 0 16 16" fill="#1a7f37" aria-hidden="true"><path d="${PR_PATH}"/></svg>`;
const ICON_PR_TAB = `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${PR_PATH}"/></svg>`;
const ICON_PR_MERGED = '<svg class="icon pr-merged" width="16" height="16" viewBox="0 0 16 16" fill="#8250df" aria-hidden="true"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>';
const ICON_PR_CLOSED = '<svg class="icon pr-closed" width="16" height="16" viewBox="0 0 16 16" fill="#cf222e" aria-hidden="true"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';

// ------------------------------------------------- nostr identity (2.5)
// Canonical form everywhere: did:nostr:<64-hex> (did-nostr.com — exactly
// what getAgent returns for an unmapped NIP-98 key). npub is DISPLAY-ONLY.

/** did:nostr:<hex> -> the 64-char lowercase hex pubkey, else null. */
function nostrHexOf(agent) {
  const m = /^did:nostr:([0-9a-f]{64})$/.exec(String(agent ?? ''));
  return m ? m[1] : null;
}

// bech32 (npub) + bech32m (P2TR) + Blocktrails TapTweak trail math moved to
// ./lib/blocktrails.js (pure, no forge state) — imported & re-exported above.

/** Agent -> pod username OR 64-hex nostr namespace (2.5), or null. */
function ownerFromAgent(agent) {
  if (!agent) return null;
  const hex = nostrHexOf(agent);
  if (hex) return hex; // the pubkey IS the namespace
  let u;
  try { u = new URL(agent); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // other DID methods: no namespace
  const segs = u.pathname.split('/').filter(Boolean);
  const name = (segs.length >= 2 && segs[0] !== 'profile') ? segs[0] : (u.hostname.split('.')[0] || null);
  return name && OWNER_NAME.test(name) && !name.includes('..') ? name : null;
}

/** WebID -> pod root path ('/casey/' or '/'), mastodon/'s podFromWebid rule. */
function podPathFromAgent(agent) {
  if (!agent) return null;
  let u;
  try { u = new URL(agent); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length >= 2 && segs[0] !== 'profile') {
    return OWNER_NAME.test(segs[0]) ? `/${segs[0]}/` : null;
  }
  return '/';
}

/**
 * Collect a streamed JSON body (the forge scope's wildcard parser hands the
 * raw stream through for the git CGI lane, so API writes read it here).
 * Returns the parsed object, or null when missing/oversized/unparseable.
 *
 * Tier-2.5 wrinkle: this MUST run before getAgent on any authed write.
 * NIP-98's optional `payload` tag is sha256 over the wire bytes, and the
 * host verifier hashes `request.rawBody` (or a Buffer body) — in this
 * scope `request.body` is the raw stream, which the verifier would
 * JSON.stringify into garbage. So the buffered wire string is stashed on
 * `request.rawBody` (and the parsed object on `request.body`) here, which
 * makes body-carrying NIP-98 requests verify exactly as on core routes.
 */
async function readJsonBody(request, cap = ISSUE_BODY_CAP + 8192) {
  let body = request.body;
  if (body == null) return null;
  if (typeof body === 'object' && !Buffer.isBuffer(body) && typeof body.pipe !== 'function'
      && !(body instanceof Uint8Array) && !(Symbol.asyncIterator in body)) {
    return body; // already parsed (not the case in this scope, but harmless)
  }
  let buf;
  if (Buffer.isBuffer(body)) buf = body;
  else if (typeof body === 'string') buf = Buffer.from(body);
  else {
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of body) {
        total += chunk.length;
        if (total > cap) return null;
        chunks.push(chunk);
      }
    } catch { return null; }
    buf = Buffer.concat(chunks);
  }
  if (buf.length > cap) return null;
  const text = buf.toString('utf8');
  request.rawBody = text; // NIP-98 payload-tag verification hashes this
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      request.body = parsed;
      return parsed;
    }
    return null;
  } catch { return null; }
}

// ------------------------------------------------------ markdown (bounded)
// Grammar (deliberately small; escape-first, so it is structurally
// XSS-proof — raw text is HTML-escaped BEFORE any tag is introduced):
//   blocks:  # h1..###### h6 | ``` fenced code | > blockquote |
//            -/* unordered list | 1. ordered list | paragraphs (blank-line
//            separated). No nesting, no tables, no HTML passthrough.
//   inline:  `code` | **bold** | *em* / _em_ | [text](href) |
//            ![alt](src). hrefs: http(s) or relative only (no other
//            schemes, no scheme-relative //); relative images are routed
//            through the raw endpoint, relative links through blob view.

function safeHref(url, base) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('#')) return url;
  if (url.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // javascript:, data:, …
  let rel = url.replace(/^\.\//, '');
  if (rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '')) return null;
  return `${base}/${rel}`;
}

function mdInline(escaped, { rawBase, blobBase }) {
  const codes = [];
  let s = escaped.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\x01${codes.length - 1}\x01`; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const href = safeHref(url, rawBase);
    return href ? `<img src="${href}" alt="${alt}">` : m;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const href = safeHref(url, blobBase);
    return href ? `<a href="${href}">${text}</a>` : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\s][^*]*)\*/g, '<em>$1</em>');
  s = s.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
  return s.replace(/\x01(\d+)\x01/g, (m, i) => `<code>${codes[i] ?? ''}</code>`);
}

function renderMarkdown(src, ctx) {
  const lines = String(src).replace(/[\x00\x01]/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  let quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(esc(para.join(' ')), ctx)}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote><p>${mdInline(esc(quote.join(' ')), ctx)}</p></blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```/.exec(line);
    if (fence) {
      flushAll();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${mdInline(esc(h[2].trim()), ctx)}</h${h[1].length}>`); continue; }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(mdInline(esc(ul[1]), ctx));
      continue;
    }
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara(); flushQuote();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(mdInline(esc(ol[1]), ctx));
      continue;
    }
    if (/^\s*$/.test(line)) { flushAll(); continue; }
    flushList(); flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

// ------------------------------------------------------------- diff parse
// ONE structured parse feeds both the HTML renderer and the JSON API's
// files[]/hunks[] shape (the Gitea-parity surface): each file is
// { name, binary, adds, dels, hunks: [{ header, lines: [{ type: 'add'|
// 'del'|'ctx'|'meta', oldLine, newLine, text }] }] }.

function parsePatch(patch) {
  const files = [];
  let cur = null;
  let hunk = null;
  let oldN = 0;
  let newN = 0;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { name: null, binary: false, adds: 0, dels: 0, hunks: [] };
      hunk = null;
      files.push(cur);
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) cur.name = m[2];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++ ')) { const n = line.slice(4); if (n !== '/dev/null') cur.name = n.replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ')) { const n = line.slice(4); if (!cur.name && n !== '/dev/null') cur.name = n.replace(/^a\//, ''); continue; }
    if (line.startsWith('Binary files')) { cur.binary = true; continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldN = +h[1]; newN = +h[2];
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // index/mode/rename preamble: not table content
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', oldLine: null, newLine: newN++, text: line.slice(1) }); cur.adds += 1; continue; }
    if (line.startsWith('-')) { hunk.lines.push({ type: 'del', oldLine: oldN++, newLine: null, text: line.slice(1) }); cur.dels += 1; continue; }
    if (line.startsWith(' ')) { hunk.lines.push({ type: 'ctx', oldLine: oldN++, newLine: newN++, text: line.slice(1) }); continue; }
    if (line.startsWith('\\')) hunk.lines.push({ type: 'meta', oldLine: null, newLine: null, text: line });
  }
  return files;
}

function renderDiff(files) {
  if (!files.length) return '<p class="muted">No changes.</p>';
  return files.map((f) => {
    const name = esc(f.name ?? '(unknown)');
    let body;
    if (f.binary) {
      body = '<div class="dbinary muted">Binary file not shown.</div>';
    } else {
      const rows = f.hunks.map((h) => [
        `<tr class="hunk"><td class="num" colspan="2"></td><td class="code">${esc(h.header)}</td></tr>`,
        ...h.lines.map((l) => {
          if (l.type === 'meta') return `<tr class="ctx"><td class="num" colspan="2"></td><td class="code muted">${esc(l.text)}</td></tr>`;
          const cls = l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx';
          const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          return `<tr class="${cls}"><td class="num">${l.oldLine ?? ''}</td><td class="num">${l.newLine ?? ''}</td><td class="code">${sign}${esc(l.text)}</td></tr>`;
        }),
      ].join('')).join('');
      body = `<table class="diff">${rows}</table>`;
    }
    return `<details class="dfile" open><summary class="dhead"><span class="fname">${name}</span>`
      + `<span class="counts"><span class="adds">+${f.adds}</span> <span class="dels">&minus;${f.dels}</span></span></summary>${body}</details>`;
  }).join('\n');
}

// ----------------------------------------------------------- the html shell

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
  font-size:14px;line-height:1.5;color:#1f2328;background:#ffffff}
a{color:#0969da;text-decoration:none}
a:hover{text-decoration:underline}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
.container{max-width:1216px;margin:0 auto;padding:0 24px}
.muted{color:#59636e}
.icon{vertical-align:text-bottom}
.avatar{border-radius:4px;vertical-align:middle}
.topbar{background:#f6f8fa;border-bottom:1px solid #d0d7de;padding:12px 0}
.topbar .container{display:flex;align-items:center;gap:8px}
.topbar a.brand{color:#1f2328;font-weight:600}
.repo-strip{background:#f6f8fa;border-bottom:1px solid #d0d7de;padding-top:16px}
.crumb{font-size:20px;display:flex;align-items:center;gap:8px}
.crumb a{color:#0969da}
.badge{display:inline-block;border:1px solid #d0d7de;color:#59636e;border-radius:999px;
  padding:0 7px;font-size:12px;font-weight:500;line-height:18px;vertical-align:middle}
.tabs{display:flex;gap:8px;margin-top:12px}
.tab{display:inline-flex;align-items:center;gap:6px;padding:8px 14px 10px;color:#1f2328;
  border-bottom:2px solid transparent;font-size:14px}
.tab:hover{text-decoration:none;border-bottom-color:#d0d7de}
.tab.active{font-weight:600;border-bottom-color:#fd8c73}
main{padding:24px 0}
.btn{display:inline-block;padding:5px 16px;font-size:14px;font-weight:500;line-height:20px;
  border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#1f2328;cursor:pointer}
.btn:hover{background:#eef1f4;text-decoration:none}
.btn-primary{background:#1f883d;border-color:rgba(31,35,40,0.15);color:#ffffff}
.btn-primary:hover{background:#1a7f37}
.box{border:1px solid #d0d7de;border-radius:8px;overflow:hidden}
.commitbar{display:flex;align-items:center;gap:8px;background:#f6f8fa;padding:10px 16px;
  border-bottom:1px solid #d0d7de;font-size:13px}
.commitbar .msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
table.files{width:100%;border-spacing:0;font-size:14px}
table.files td{padding:0 16px;height:40px;border-top:1px solid #d0d7de}
table.files tr:first-child td{border-top:0}
table.files tr:hover{background:#f6f8fa}
table.files td.name{width:35%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
table.files td.name a{color:#1f2328}
table.files td.name a:hover{color:#0969da}
table.files td.cmsg{color:#59636e;max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
table.files td.cmsg a{color:#59636e}
table.files td.age{color:#59636e;text-align:right;white-space:nowrap}
.readme{border:1px solid #d0d7de;border-radius:8px;margin-top:16px}
.readme .rtitle{padding:10px 16px;border-bottom:1px solid #d0d7de;font-weight:600;font-size:14px}
.markdown-body{padding:16px 32px;font-size:16px;overflow-x:auto}
.markdown-body h1,.markdown-body h2{border-bottom:1px solid #d0d7de;padding-bottom:.3em}
.markdown-body h1{font-size:2em;margin:.67em 0 16px}
.markdown-body h2{font-size:1.5em}
.markdown-body code{background:rgba(129,139,152,0.12);border-radius:6px;padding:.2em .4em;font-size:85%}
.markdown-body pre{background:#f6f8fa;border-radius:6px;padding:16px;overflow:auto;font-size:85%;line-height:1.45}
.markdown-body pre code{background:transparent;padding:0;font-size:100%}
.markdown-body blockquote{margin:0 0 16px;padding:0 1em;color:#59636e;border-left:.25em solid #d0d7de}
.markdown-body img{max-width:100%}
.clonebox{display:flex;gap:8px;align-items:center}
.clonebox input{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;
  padding:5px 12px;border:1px solid #d0d7de;border-radius:6px;color:#1f2328;background:#f6f8fa;min-width:280px}
details.dd{position:relative;display:inline-block}
details.dd summary{list-style:none;cursor:pointer}
details.dd summary::-webkit-details-marker{display:none}
details.dd .menu{position:absolute;z-index:10;margin-top:6px;background:#ffffff;border:1px solid #d0d7de;
  border-radius:8px;box-shadow:0 8px 24px rgba(140,149,159,0.2);padding:8px;min-width:300px}
.menu .mtitle{font-weight:600;font-size:12px;padding:4px 8px;border-bottom:1px solid #d0d7de;margin-bottom:6px}
.menu a{display:block;padding:6px 8px;border-radius:6px;color:#1f2328;font-size:13px}
.menu a:hover{background:#f6f8fa;text-decoration:none}
table.blob{width:100%;border-spacing:0;font-size:12px;line-height:20px}
table.blob td.num{width:1%;min-width:50px;text-align:right;padding:0 10px;color:#59636e;
  background:rgba(0,0,0,0.01);user-select:none;vertical-align:top}
table.blob td.code{padding:0 10px;white-space:pre;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.blobhead{display:flex;align-items:center;gap:12px;background:#f6f8fa;border-bottom:1px solid #d0d7de;
  padding:8px 16px;font-size:12px}
.dfile{border:1px solid #d0d7de;border-radius:8px;margin-bottom:16px;overflow:hidden}
.dhead{display:flex;justify-content:space-between;align-items:center;background:#f6f8fa;
  padding:8px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;cursor:pointer}
.dhead .counts{font-weight:600}
.adds{color:#1a7f37}
.dels{color:#cf222e}
table.diff{width:100%;border-spacing:0;font-size:12px;line-height:20px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
table.diff td{padding:0 10px}
table.diff td.num{width:1%;min-width:40px;text-align:right;color:#59636e;background:rgba(0,0,0,0.01);user-select:none}
table.diff td.code{white-space:pre-wrap;word-break:break-all;width:100%}
tr.add td.code{background:#dafbe1}
tr.add td.num{background:#aceebb}
tr.del td.code{background:#ffebe9}
tr.del td.num{background:#ffcecb}
tr.hunk td{background:#ddf4ff;color:#0969da}
.dbinary{padding:16px}
.list{border:1px solid #d0d7de;border-radius:8px}
.list .row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid #d0d7de}
.list .row:first-child{border-top:0}
.list .grow{flex:1;min-width:0}
.pager{display:flex;justify-content:center;gap:8px;margin-top:16px}
.repocard{border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:12px}
.repocard h3{margin:0 0 4px;font-size:16px}
.empty{border:1px solid #d0d7de;border-radius:8px;padding:32px;margin-top:16px}
h1.page{font-size:24px;margin:0 0 16px}
.commitpage h2{margin:0;font-size:18px}
.cmeta{display:flex;align-items:center;gap:8px;background:#f6f8fa;border:1px solid #d0d7de;
  border-radius:8px;padding:10px 16px;margin:12px 0 20px;font-size:13px}
.sha{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#59636e}
.state-pill{display:inline-block;padding:5px 14px;border-radius:999px;color:#ffffff;font-size:14px;font-weight:500}
.state-open{background:#1f883d}
.state-closed{background:#8250df}
.fstate{display:flex;gap:16px;padding:12px 16px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font-size:14px}
.fstate a{color:#59636e}
.fstate a.active{color:#1f2328;font-weight:600}
.ititle{color:#1f2328;font-weight:600;font-size:16px}
.ititle:hover{color:#0969da}
.cbox{border:1px solid #d0d7de;border-radius:8px;margin-bottom:16px;overflow:hidden}
.chead{display:flex;align-items:center;gap:8px;background:#f6f8fa;border-bottom:1px solid #d0d7de;
  padding:8px 16px;font-size:13px}
.chead a{color:#1f2328}
.cbox .markdown-body{font-size:14px;padding:16px}
.removed{padding:16px;color:#59636e;font-style:italic;background:#f6f8fa}
.authbox{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:16px;padding:8px 12px;
  border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;font-size:13px}
.authbox input{padding:5px 12px;border:1px solid #d0d7de;border-radius:6px;font-size:13px}
.issueform input[type="text"],.issueform textarea{width:100%;padding:8px 12px;border:1px solid #d0d7de;
  border-radius:6px;font-size:14px;font-family:inherit;margin-bottom:8px;background:#ffffff}
.issueform textarea{min-height:140px;line-height:1.5;resize:vertical}
.formmsg{color:#cf222e;font-size:13px}
.state-merged{background:#8250df}
.state-closed-red{background:#cf222e}
.mergebox{border:1px solid #d0d7de;border-radius:8px;margin-bottom:16px;padding:12px 16px}
.mergebox.clean{border-color:#1f883d}
.mergebox.conflict{border-color:#cf222e}
.mergebox h3{margin:0 0 4px;font-size:14px}
.mergebox .clean-note{color:#1a7f37}
.mergebox .conflict-note{color:#cf222e}
.pushhint{display:flex;align-items:center;gap:8px;border:1px solid #d4a72c66;background:#fff8c5;
  border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px}
.aheadbehind{display:inline-block;border:1px solid #d0d7de;border-radius:6px;padding:2px 10px;
  font-size:12px;color:#59636e}
.label-chip{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;font-weight:500;
  line-height:18px;border:1px solid rgba(31,35,40,0.12);vertical-align:middle;white-space:nowrap}
.searchform{display:flex;gap:8px;align-items:center}
.searchform input{padding:5px 12px;border:1px solid #d0d7de;border-radius:6px;font-size:14px;
  background:#ffffff;min-width:220px}
.excerpt{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;
  white-space:pre-wrap;word-break:break-all;color:#1f2328}
.chip{display:inline-block;padding:0 10px;border-radius:999px;font-size:12px;font-weight:500;line-height:20px;white-space:nowrap}
.chip-pending{background:#fff8c5;color:#7d4e00;border:1px solid #d4a72c66}
.chip-marked{background:#dafbe1;color:#1a7f37;border:1px solid #1f883d55}
table.marks{width:100%;border-spacing:0;font-size:13px}
table.marks th,table.marks td{padding:8px 12px;border-top:1px solid #d0d7de;text-align:left;vertical-align:top}
table.marks th{border-top:0;background:#f6f8fa;font-size:12px;color:#59636e;font-weight:600}
table.marks code{font-size:12px;word-break:break-all}
.fundbox{border:1px solid #d4a72c66;background:#fff8c5;border-radius:8px;padding:12px 16px;margin-top:16px}
.fundbox pre{background:#ffffffaa;border-radius:6px;padding:12px;overflow-x:auto;font-size:12px}
`;

// connect-src 'self' is load-bearing for tier 2: the issues client drives
// the JSON API and /idp/credentials with fetch(), which CSP counts as
// connect-src — under `default-src 'none'` alone every fetch is blocked.
//
// Tier 2.5: script-src gains 'self' (the vendored xlogin widget loads via
// <script src="<prefix>/xlogin.js">) and https://esm.sh — a measured,
// documented concession: xlogin 0.0.15 hard-codes dynamic import()s of its
// crypto (@noble), nip98 and solid-oidc from esm.sh, and dynamic import is
// governed by script-src, NOT connect-src (a Finding — see README).
// connect-src stays 'self' by default, so xlogin's NOSTR flows work
// (client-side signing + same-origin fetch) while EXTERNAL Solid-IdP login
// stays blocked unless the operator opts origins in via config.cspConnect.
function buildCsp(cspConnect) {
  const extra = (Array.isArray(cspConnect) ? cspConnect : [])
    .filter((o) => typeof o === 'string' && /^https?:\/\/[^\s;'"]+$/.test(o));
  const connect = ["'self'", ...extra].join(' ');
  // form-action is 'self', not 'none': the search boxes are plain GET
  // forms (no JS), and CSP form-action blocks even those (a Finding).
  return "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; "
    + `script-src 'unsafe-inline' 'self' https://esm.sh; connect-src ${connect}; `
    + "base-uri 'none'; form-action 'self'";
}

// ---------------------------------------------------------------- activate

async function findBackend(config) {
  for (const candidate of [config.gitHttpBackend, DEFAULT_BACKEND]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const { stdout } = await execFileP('git', ['--exec-path']);
  const derived = path.join(stdout.trim(), 'git-http-backend');
  if (fs.existsSync(derived)) return derived;
  throw new Error('forge: git-http-backend not found; set config.gitHttpBackend');
}

export async function activate(api) {
  const prefix = api.prefix || '/forge';
  // CLI --plugin mounts (jspod, `jss --plugin module@prefix`) pass no per-plugin
  // config. When FORGE_CONFIG names a JSON file, merge it in as DEFAULTS so a
  // CLI-mounted forge can still opt into Nostr/marks/etc. Explicit api.config
  // wins; unset env or unreadable file is a silent no-op (behavior unchanged).
  if (process.env.FORGE_CONFIG) {
    try {
      api.config = api.config || {};
      const fc = JSON.parse(fs.readFileSync(process.env.FORGE_CONFIG, 'utf8'));
      for (const k of Object.keys(fc)) if (api.config[k] === undefined) api.config[k] = fc[k];
    } catch (e) { api.log?.warn?.(`forge: FORGE_CONFIG load failed: ${e.message}`); }
  }
  const privateRepos = api.config.privateRepos ?? false;
  // Web-edit DEMO relaxation (tier 3.7): when true, the single-file edit
  // endpoint accepts ANONYMOUS edits (no owner signature). This is never a
  // default and exists only for throwaway testnet-demo repos — see README's
  // spam/abuse caveat. Warn ONCE, loudly, at activate.
  const openEdit = api.config.openEdit === true;
  if (openEdit) {
    api.log.warn('forge: config.openEdit is ON — anyone can edit repos via the web-edit endpoint '
      + '(no owner signature required). DEMO ONLY; never enable on a real forge.');
  }

  // Sparse marking (opt-in): instead of stacking one pending mark per commit,
  // RE-TARGET the trailing UNFUNDED mark at each new tip — so the chain gains a
  // link only per actual (funded) mark and anchoring HEAD is ONE tx regardless
  // of how many commits landed since. Lets a fast commit cadence (fresh mirrors)
  // coexist with a slow mark cadence (one super-commit per period). See recordTip.
  const sparseMarks = api.config.sparseMarks === true;

  // Tier 3.5: anchoring chain, testnet4 by default. Checked FIRST, before
  // any other activation work. Mainnet is REFUSED at
  // activate unless the operator opts in explicitly — this plugin derives
  // addresses for a forge-held key with testnet-grade custody (the trail
  // key sits in pluginDir; see README Findings). Refusing loudly here
  // beats deriving mainnet addresses someone might actually fund.
  const chain = String(api.config.chain ?? 'tbtc4');
  if (MAINNET_CHAINS.has(chain) && api.config.allowMainnet !== true) {
    throw new Error(
      `forge: config.chain "${chain}" is Bitcoin MAINNET — refusing to derive mainnet anchor addresses. `
      + 'This plugin holds the trail key server-side (testnet posture) and never verifies or broadcasts; '
      + 'anchoring defaults to tbtc4 (testnet4). Set config.allowMainnet: true only if you accept that custody.',
    );
  }
  const chainHrp = CHAIN_HRP[chain];
  if (!chainHrp) {
    throw new Error(`forge: unknown config.chain "${chain}" (supported: ${Object.keys(CHAIN_HRP).join(', ')})`);
  }
  // mempool.space explorer base for txid links; undefined (regtest) means
  // "no explorer" and the marks page renders plain text instead of a link.
  const mempoolBase = MEMPOOL_PATH[chain] !== undefined ? `https://mempool.space${MEMPOOL_PATH[chain]}` : null;

  const backend = await findBackend(api.config);
  const csp = buildCsp(api.config.cspConnect);

  // Tier 3a: real merges need `git merge-tree --write-tree` (git >= 2.38).
  // Checked once at activate; the merge route 501s with the version when
  // the installed git is too old (a Finding, not a crash).
  let gitVersion = 'unknown';
  let mergeTreeOk = false;
  try {
    gitVersion = (await execFileP('git', ['--version'])).stdout.trim();
    const vm = /(\d+)\.(\d+)/.exec(gitVersion);
    mergeTreeOk = !!vm && (+vm[1] > 2 || (+vm[1] === 2 && +vm[2] >= 38));
  } catch { /* no git at all fails later, loudly */ }

  const reposDir = path.join(api.storage.pluginDir(), 'repos');
  fs.mkdirSync(reposDir, { recursive: true });

  // The vendored xlogin widget (forge/xlogin.js), served byte-identical at
  // <prefix>/xlogin.js. Read once — it is immutable for a running server.
  const xloginSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'xlogin.js'),
  );

  // ------------------------------------------- push-token exchange (2.5)
  // git's static `http.extraHeader` cannot sign per-request NIP-98 (each
  // 27235 event binds one url+method; a push is info/refs GET + receive-
  // pack POST at least), so `POST <prefix>/api/token` exchanges any
  // getAgent-accepted credential for a macaroon-lite HMAC bearer
  // (capability/'s token pattern): f1.<b64url payload>.<b64url hmac>,
  // payload { v:1, agent, iat, exp }. Accepted wherever this plugin
  // authenticates, IN ADDITION to getAgent — WebID users don't need it
  // (the pod bearer already works) but may use it.
  const tokenSecretFile = path.join(api.storage.pluginDir(), 'token-secret');
  if (!fs.existsSync(tokenSecretFile)) {
    fs.writeFileSync(tokenSecretFile, crypto.randomBytes(32), { mode: 0o600 });
  }
  const tokenSecret = fs.readFileSync(tokenSecretFile);
  const pushTokenTtl = api.config.pushTokenTtl ?? 3600;

  function mintForgeToken(agent, ttl) {
    const iat = Math.floor(Date.now() / 1000);
    const payload = { v: 1, agent, iat, exp: iat + Math.floor(ttl) };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', tokenSecret).update(`f1.${body}`).digest('base64url');
    return { token: `f1.${body}.${sig}`, iat, exp: payload.exp };
  }

  /** `Authorization: Bearer f1.*` -> agent, or null (bad sig / expired). */
  function forgeTokenAgent(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer f1\./.test(header)) return null;
    const token = header.slice(7).trim();
    if (token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expected = crypto.createHmac('sha256', tokenSecret).update(`f1.${parts[1]}`).digest();
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
    if (!payload || payload.v !== 1 || typeof payload.agent !== 'string'
      || typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload.agent;
  }

  /** Forge push token first (cheap prefix check), then every core scheme. */
  async function requestAgent(request) {
    return forgeTokenAgent(request) ?? api.auth.getAgent(request);
  }

  // Clone URLs are absolute: origin from api.serverInfo (#601), resolved at
  // REQUEST time (with port 0 it only exists once listening); config.baseUrl
  // stays as the reverse-proxy override. Falls back to origin-relative.
  function publicOrigin() {
    if (api.config.baseUrl) return String(api.config.baseUrl).replace(/\/$/, '');
    try { return String(api.serverInfo().baseUrl).replace(/\/$/, ''); } catch { return ''; }
  }
  const cloneUrlOf = (owner, name) => `${publicOrigin()}${prefix}/${owner}/${name}.git`;

  // Loopback origin (gallery/'s pattern): pod reads/writes go through the
  // host's own HTTP surface, never the filesystem — LDP and WAC stay in
  // charge. Resolved lazily (port 0 boots have no real port at activate).
  function loopbackOrigin() {
    if (api.config.loopbackUrl) return String(api.config.loopbackUrl).replace(/\/$/, '');
    const { protocol, host, port } = api.serverInfo();
    const h = host.includes(':') ? `[${host}]` : host;
    return `${protocol}://${h}:${port}`;
  }

  /** Loopback fetch, forwarding the caller's Authorization when present. */
  const lb = (p, { method = 'GET', headers = {}, auth, body, signal } = {}) => fetch(loopbackOrigin() + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
    ...(signal ? { signal } : {}),
  });

  // Hermetic server-side git: no ~/.gitconfig (no HOME), no /etc/gitconfig.
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' };

  const repoDirOf = (owner, name) => path.join(reposDir, owner, `${name}.git`);
  const repoExists = (owner, name) => fs.existsSync(repoDirOf(owner, name));

  async function gitText(dir, args) {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], { env: gitEnv, maxBuffer: MAX_EXEC_BUFFER });
    return stdout;
  }
  async function gitBuf(dir, args) {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], { env: gitEnv, maxBuffer: MAX_EXEC_BUFFER, encoding: 'buffer' });
    return stdout;
  }

  // -------------------------------------------------------------- git model

  async function defaultBranch(dir) {
    try { return (await gitText(dir, ['symbolic-ref', '--short', 'HEAD'])).trim(); } catch { return 'main'; }
  }

  /** [{name, sha, when, subject}] for refs/heads or refs/tags. */
  async function listRefs(dir, kind) {
    const out = await gitText(dir, ['for-each-ref', '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname:short)%00%(creatordate:unix)%00%(subject)', `refs/${kind}`]);
    return out.split('\n').filter(Boolean).map((l) => {
      const [name, sha, when, subject] = l.split('\0');
      return { name, sha, when: +when, subject };
    });
  }

  /** Longest ref-name match wins: ['feature','x','src'] -> ['feature/x', ['src']]. */
  async function splitRefPath(dir, segs) {
    const names = new Set([...(await listRefs(dir, 'heads')), ...(await listRefs(dir, 'tags'))].map((r) => r.name));
    for (let i = Math.min(segs.length, 20); i >= 1; i--) {
      const cand = segs.slice(0, i).join('/');
      if (names.has(cand)) return [cand, segs.slice(i)];
    }
    return [segs[0], segs.slice(1)]; // a sha, or a ref that just vanished
  }

  /** ls-tree of ref:dirpath -> [{mode,type,sha,size,name}], dirs first. */
  async function lsTree(dir, ref, dirPath) {
    const spec = dirPath ? `${ref}:${dirPath}` : ref;
    const out = await gitText(dir, ['ls-tree', '-z', '-l', spec]);
    const entries = out.split('\0').filter(Boolean).map((e) => {
      const tab = e.indexOf('\t');
      const [mode, type, sha, size] = e.slice(0, tab).split(/\s+/);
      return { mode, type, sha, size: size === '-' ? null : +size, name: e.slice(tab + 1) };
    });
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1));
    return entries;
  }

  /** Last commit touching path (or the ref tip when path is ''). */
  async function lastCommit(dir, ref, p) {
    try {
      const args = ['log', '-1', '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s', ref];
      if (p) args.push('--', p);
      const out = (await gitText(dir, args)).trim();
      if (!out) return null;
      const [sha, short, author, email, at, subject] = out.split('\0');
      return { sha, short, author, email, at: +at, subject };
    } catch { return null; }
  }

  async function commitLog(dir, ref, page) {
    const skip = (page - 1) * PER_PAGE;
    const out = await gitText(dir, ['log', '-z', `--skip=${skip}`, `-n${PER_PAGE + 1}`,
      '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s', ref]);
    const fields = out.split('\0');
    const commits = [];
    for (let i = 0; i + 5 < fields.length; i += 6) {
      commits.push({ sha: fields[i].replace(/^\n/, ''), short: fields[i + 1], author: fields[i + 2], email: fields[i + 3], at: +fields[i + 4], subject: fields[i + 5] });
    }
    const hasMore = commits.length > PER_PAGE;
    return { commits: commits.slice(0, PER_PAGE), hasMore };
  }

  /** Full metadata for one commit, or null. */
  async function commitMeta(dir, sha) {
    try {
      const out = await gitText(dir, ['show', '--no-patch',
        '--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%B', sha]);
      const [full, short, author, email, at, parents, ...msg] = out.split('\0');
      return { full, short, author, email, at: +at, parents: parents.split(' ').filter(Boolean), message: msg.join('\0').trim() };
    } catch { return null; }
  }

  async function commitDiff(dir, sha) {
    const patch = await gitText(dir, ['show', '--format=', '--patch', '--no-color', sha]).catch(() => '');
    return parsePatch(patch);
  }

  async function catBlob(dir, ref, p) {
    return gitBuf(dir, ['cat-file', 'blob', `${ref}:${p}`]);
  }
  async function blobSize(dir, ref, p) {
    return +(await gitText(dir, ['cat-file', '-s', `${ref}:${p}`])).trim();
  }
  async function objectType(dir, ref, p) {
    try { return (await gitText(dir, ['cat-file', '-t', p ? `${ref}:${p}` : ref])).trim(); } catch { return null; }
  }

  function listOwners() {
    try {
      return fs.readdirSync(reposDir).filter((o) => OWNER_NAME.test(o)).sort();
    } catch { return []; }
  }
  function listRepoNames(owner) {
    try {
      return fs.readdirSync(path.join(reposDir, owner))
        .filter((n) => n.endsWith('.git') && REPO_NAME.test(n.slice(0, -4)))
        .map((n) => n.slice(0, -4)).sort();
    } catch { return []; }
  }

  /** description: git's `description` file if customized, else README line 1. */
  async function repoSummary(owner, name) {
    const dir = repoDirOf(owner, name);
    let description = '';
    try {
      const d = fs.readFileSync(path.join(dir, 'description'), 'utf8').trim();
      if (d && !d.startsWith('Unnamed repository')) description = d;
    } catch { /* no description file */ }
    let lastPush = null;
    try {
      const out = (await gitText(dir, ['for-each-ref', '--sort=-committerdate', '--count=1', '--format=%(committerdate:unix)'])).trim();
      if (out) lastPush = +out;
    } catch { /* empty repo */ }
    if (!description && lastPush) {
      try {
        const branch = await defaultBranch(dir);
        const entries = await lsTree(dir, branch, '');
        const readme = entries.find((e) => e.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
        if (readme && readme.size !== null && readme.size < RENDER_CAP) {
          const buf = await catBlob(dir, branch, readme.name);
          if (!looksBinary(buf)) {
            const first = buf.toString('utf8').split('\n').find((l) => l.trim());
            if (first) description = first.replace(/^#+\s*/, '').trim().slice(0, 160);
          }
        }
      } catch { /* unreadable README is not an error */ }
    }
    const parent = readForkParent(owner, name);
    return { owner, name, description, lastPush, parent: parent ? parent.full : null };
  }

  /** The bare repo's `description` file, only if explicitly customized. */
  function repoDescription(owner, name) {
    try {
      const d = fs.readFileSync(path.join(repoDirOf(owner, name), 'description'), 'utf8').trim();
      if (d && !d.startsWith('Unnamed repository')) return d;
    } catch { /* no description file */ }
    return '';
  }

  // --------------------------------------------- forks + compare (tier 3a)

  async function revParse(dir, spec) {
    try { return (await gitText(dir, ['rev-parse', '--verify', '--quiet', spec])).trim() || null; } catch { return null; }
  }
  async function isAncestor(dir, a, b) {
    try {
      await execFileP('git', ['-C', dir, 'merge-base', '--is-ancestor', a, b], { env: gitEnv });
      return true;
    } catch { return false; }
  }

  // Fork lineage lives in the fork's own bare-repo config (forge.parent =
  // <owner>/<name>, written with `git config` at fork time). Reading it is
  // a plain file read, not a git spawn — the value is forge-written, so the
  // `[forge]\n\tparent = …` shape is known — which keeps repo cards and
  // fork counts cheap (Finding 5's cost profile, not worse).
  function readForkParent(owner, name) {
    try {
      const conf = fs.readFileSync(path.join(repoDirOf(owner, name), 'config'), 'utf8');
      const section = /^\[forge\]\n((?:[ \t]+[^\n]*\n?)*)/m.exec(conf);
      if (!section) return null;
      const m = /^[ \t]+parent\s*=\s*(\S+)\s*$/m.exec(section[1]);
      if (!m) return null;
      const [po, pn, extra] = m[1].split('/');
      if (extra !== undefined || !OWNER_NAME.test(po ?? '') || !REPO_NAME.test(pn ?? '')) return null;
      return { owner: po, name: pn, full: `${po}/${pn}` };
    } catch { return null; }
  }

  /** How many repos name <owner>/<name> as forge.parent (bounded scan). */
  function countForks(owner, name) {
    const target = `${owner}/${name}`;
    let count = 0;
    let scanned = 0;
    for (const o of listOwners()) {
      for (const n of listRepoNames(o)) {
        if (scanned >= 400) return count;
        scanned += 1;
        if (readForkParent(o, n)?.full === target) count += 1;
      }
    }
    return count;
  }

  /**
   * Finding 15's cure (ref hygiene): the internal compare refs
   * (refs/forge/*) must not ride ls-remote. Set at repo creation, and
   * lazily here for repos that predate the config — the cheap fs read
   * skips the git spawn once the line exists.
   */
  async function ensureForgeRefsHidden(dir) {
    try {
      if (/hideRefs\s*=\s*refs\/forge\//.test(fs.readFileSync(path.join(dir, 'config'), 'utf8'))) return;
    } catch { /* unreadable config: attempt the write anyway */ }
    await execFileP('git', ['-C', dir, 'config', 'uploadpack.hideRefs', 'refs/forge/'], { env: gitEnv }).catch(() => {});
  }

  /** 'ref' or 'owner:ref' -> { owner, ref } (validated), or null. */
  function parseHeadSpec(baseOwner, headSpec) {
    if (typeof headSpec !== 'string' || headSpec.length > 320) return null;
    let headOwner = baseOwner;
    let ref = headSpec;
    const c = headSpec.indexOf(':');
    if (c !== -1) { headOwner = headSpec.slice(0, c); ref = headSpec.slice(c + 1); }
    if (!OWNER_NAME.test(headOwner) || headOwner.includes('..') || !okRef(ref)) return null;
    return { owner: headOwner, ref };
  }

  /**
   * Resolve the head of a compare/PR: a branch of THIS repo, or
   * `<owner>:<ref>` — a branch of the named owner's SAME-NAMED repo (the
   * documented fork rule: lineage is not chased, the name is the link).
   * Cross-repo heads are path-fetched into the base repo under a hidden,
   * REUSABLE ref (refs/forge/heads/<owner>/<ref>, force-updated each call
   * — repeat compares refresh it, nothing to clean up). Both ends of the
   * fetch are forge-owned paths; no user-supplied URLs.
   */
  async function resolveHead(baseOwner, name, headSpec) {
    const parsed = parseHeadSpec(baseOwner, headSpec);
    if (!parsed) return null;
    const dir = repoDirOf(baseOwner, name);
    if (parsed.owner === baseOwner) {
      const sha = await revParse(dir, `refs/heads/${parsed.ref}`);
      return sha ? { ...parsed, repo: name, sha } : null;
    }
    const headDir = repoDirOf(parsed.owner, name);
    if (!fs.existsSync(headDir)) return null;
    await ensureForgeRefsHidden(dir); // lazy heal for pre-polish repos
    const localRef = `refs/forge/heads/${parsed.owner}/${parsed.ref}`;
    try {
      await execFileP('git', ['-C', dir, 'fetch', '--quiet', '--no-tags', headDir,
        `+refs/heads/${parsed.ref}:${localRef}`], { env: gitEnv, maxBuffer: MAX_EXEC_BUFFER });
    } catch { return null; }
    const sha = await revParse(dir, localRef);
    return sha ? { ...parsed, repo: name, sha } : null;
  }

  /** Everything a compare view needs, or null (bad refs, no such head). */
  async function compareData(owner, name, baseRef, headSpec) {
    if (!okRef(baseRef)) return null;
    const dir = repoDirOf(owner, name);
    const baseSha = (await revParse(dir, `refs/heads/${baseRef}`))
      ?? (await revParse(dir, `refs/tags/${baseRef}^{commit}`))
      ?? (SHA_RE.test(baseRef) ? await revParse(dir, `${baseRef}^{commit}`) : null);
    if (!baseSha) return null;
    const head = await resolveHead(owner, name, headSpec);
    if (!head) return null;
    const counts = (await gitText(dir, ['rev-list', '--left-right', '--count', `${baseSha}...${head.sha}`]))
      .trim().split(/\s+/);
    const behindBy = +counts[0];
    const aheadBy = +counts[1];
    let mergeBase = null;
    try { mergeBase = (await gitText(dir, ['merge-base', baseSha, head.sha])).trim() || null; } catch { /* unrelated histories */ }
    const { commits, hasMore } = await commitLog(dir, `${baseSha}..${head.sha}`, 1);
    const patch = await gitText(dir, ['diff', '--no-color', mergeBase ?? baseSha, head.sha]).catch(() => '');
    return { baseRef, baseSha, head, aheadBy, behindBy, mergeBase, commits, hasMore, files: parsePatch(patch) };
  }

  /**
   * `git merge-tree --write-tree` (git >= 2.38), bare-repo safe: computes
   * the merged tree without a worktree. Exit 0 -> { clean, tree }; exit 1
   * -> conflicted file list (--name-only section, deduped).
   */
  async function mergeTreeOf(dir, baseSha, headSha) {
    try {
      const out = await gitText(dir, ['merge-tree', '--write-tree', '--name-only', baseSha, headSha]);
      return { clean: true, tree: out.split('\n')[0].trim(), conflicts: [] };
    } catch (err) {
      if (err.code === 1 && typeof err.stdout === 'string') {
        const lines = err.stdout.split('\n');
        const conflicts = [];
        for (let i = 1; i < lines.length && lines[i]; i++) {
          if (!conflicts.includes(lines[i])) conflicts.push(lines[i]);
        }
        return { clean: false, tree: null, conflicts };
      }
      throw err;
    }
  }

  // ------------------------------------------------------------ issues model
  // Content in the AUTHOR's pod, index + state in pluginDir:
  //
  //   pods hold the WORDS                    pluginDir holds the SPINE
  //   /casey/public/forge/o--r/issue-<uuid>.jsonld    issues/<owner>/<repo>.json:
  //   /dana/public/forge/o--r/comment-<uuid>.jsonld     { next, issues: { <n>:
  //     { type: ForgeIssue|ForgeComment, repo,            { number, title, state,
  //       issue, title?, body, published, author }          author, createdAt,
  //                                                         thread: [{author,
  //                                                          resourceUrl, at}] } } }
  //
  // The index NEVER copies body text; bodies are re-fetched from the pods at
  // read time over loopback (public read), bounded. If an author deletes the
  // resource from their pod, the pointer stays and the slot renders as
  // "content removed by its author" — see README Findings.

  const issuesDir = path.join(api.storage.pluginDir(), 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  const indexPathOf = (owner, name) => path.join(issuesDir, owner, `${name}.json`);

  // ------------------------------------------- podless content (2.5)
  // A did:nostr agent can authenticate and own a namespace but has no pod
  // to loopback-PUT its words into (the api.podOf ask — README Findings).
  // Its issue/comment bodies live under pluginDir/hosted/<hex>/<uuid>.json,
  // thread pointers carry {hosted: true}, the UI renders a muted "hosted
  // by the forge" tag, and the author (same did:nostr identity) can DELETE
  // the document over the API — the same beat as deleting a pod resource.
  const hostedDir = path.join(api.storage.pluginDir(), 'hosted');
  fs.mkdirSync(hostedDir, { recursive: true });
  const hostedPathOf = (hex, id) => path.join(hostedDir, hex, `${id}.json`);

  function storeHosted(hex, doc) {
    const id = crypto.randomUUID();
    fs.mkdirSync(path.join(hostedDir, hex), { recursive: true });
    fs.writeFileSync(hostedPathOf(hex, id), JSON.stringify(doc));
    return { url: `${publicOrigin()}${prefix}/api/hosted/${hex}/${id}` };
  }

  /** Hosted resource URL -> { hex, id } (validated), or null. */
  function hostedRefOf(resourceUrl) {
    const p = resourcePathOf(resourceUrl);
    if (!p || !p.startsWith(`${prefix}/api/hosted/`)) return null;
    const segs = p.slice(`${prefix}/api/hosted/`.length).split('/');
    if (segs.length !== 2 || !NOSTR_HEX.test(segs[0]) || !UUID_RE.test(segs[1])) return null;
    return { hex: segs[0], id: segs[1] };
  }

  function readHosted(hex, id) {
    try {
      const doc = JSON.parse(fs.readFileSync(hostedPathOf(hex, id), 'utf8'));
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
    } catch { return null; }
  }

  function loadIssueIndex(owner, name) {
    try {
      const idx = JSON.parse(fs.readFileSync(indexPathOf(owner, name), 'utf8'));
      if (idx && Number.isInteger(idx.next) && idx.next >= 1 && idx.issues && typeof idx.issues === 'object') {
        return idx;
      }
    } catch { /* no issues yet */ }
    return { next: 1, issues: {} };
  }
  function saveIssueIndex(owner, name, idx) {
    const file = indexPathOf(owner, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx)); // atomic: tmp + rename
    fs.renameSync(tmp, file);
  }
  function openIssueCount(owner, name) {
    return Object.values(loadIssueIndex(owner, name).issues).filter((i) => i.state === 'open').length;
  }

  // One writer at a time per repo index — number allocation must not race.
  // The same serializer guards the pulls index (and, through it, merges:
  // a merge mutates refs, so per-repo merge serialization rides the lock).
  function serializeOn(locks, owner, name, fn) {
    const key = `${owner}/${name}`;
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(key, run.then(() => {}, () => {}));
    return run;
  }
  const issueLocks = new Map();
  const withIssueLock = (owner, name, fn) => serializeOn(issueLocks, owner, name, fn);
  const pullLocks = new Map();
  const withPullLock = (owner, name, fn) => serializeOn(pullLocks, owner, name, fn);

  // ---------------------------------------------------- pulls model (3a)
  // Same shape discipline as issues — atomic tmp+rename index at
  // pluginDir/pulls/<owner>/<repo>.json, bodies in pods (or forge-hosted
  // for podless agents), thread machinery verbatim. Numbering is SEPARATE
  // from issues (a documented GitHub deviation — see README).
  const pullsDir = path.join(api.storage.pluginDir(), 'pulls');
  fs.mkdirSync(pullsDir, { recursive: true });
  const pullIndexPathOf = (owner, name) => path.join(pullsDir, owner, `${name}.json`);

  function loadPullIndex(owner, name) {
    try {
      const idx = JSON.parse(fs.readFileSync(pullIndexPathOf(owner, name), 'utf8'));
      if (idx && Number.isInteger(idx.next) && idx.next >= 1 && idx.pulls && typeof idx.pulls === 'object') {
        return idx;
      }
    } catch { /* no pulls yet */ }
    return { next: 1, pulls: {} };
  }
  function savePullIndex(owner, name, idx) {
    const file = pullIndexPathOf(owner, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx)); // atomic: tmp + rename
    fs.renameSync(tmp, file);
  }
  function openPullCount(owner, name) {
    return Object.values(loadPullIndex(owner, name).pulls).filter((p) => p.state === 'open').length;
  }

  // ---------------------------------------------------- marks model (3.5)
  // Per-repo Blocktrails trail at pluginDir/marks/<owner>/<repo>.json:
  // { v, chain, privkey, pubkeyBase, createdAt, marks: [...] } — same
  // atomic tmp+rename + per-repo serializer discipline as issues/pulls.
  // Each mark = { index, state: {commit, repo, branch}, stateHash,
  // program, address, status: 'pending'|'marked', txid?, vout?, amount? }.
  // The PRIVKEY never crosses an API boundary: it is the forge-held
  // (testnet) trail key, written 0600, read only to be excluded — the
  // custody trade-off is a named README Finding. The file existing IS the
  // "anchoring enabled" bit.
  const marksDir = path.join(api.storage.pluginDir(), 'marks');
  fs.mkdirSync(marksDir, { recursive: true });
  const marksPathOf = (owner, name) => path.join(marksDir, owner, `${name}.json`);
  const marksEnabled = (owner, name) => fs.existsSync(marksPathOf(owner, name));
  const markLocks = new Map();
  const withMarkLock = (owner, name, fn) => serializeOn(markLocks, owner, name, fn);

  function loadTrail(owner, name) {
    try {
      const t = JSON.parse(fs.readFileSync(marksPathOf(owner, name), 'utf8'));
      if (t && typeof t.pubkeyBase === 'string' && Array.isArray(t.marks)) return t;
    } catch { /* not enabled */ }
    return null;
  }
  function saveTrail(owner, name, trail) {
    const file = marksPathOf(owner, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trail), { mode: 0o600 }); // key inside: 0600
    fs.renameSync(tmp, file);
  }

  /** A mark as served over every API surface — everything BUT the key. */
  function publicMark(m) {
    return {
      index: m.index,
      state: m.state,
      stateHash: m.stateHash,
      program: m.program,
      address: m.address,
      status: m.status,
      at: m.at,
      ...(m.status === 'marked' ? { txid: m.txid, vout: m.vout, amount: m.amount, markedAt: m.markedAt } : {}),
    };
  }

  /** The verifier's TXO URI shape (git-mark's format, parseTxo-compatible). */
  const txoUriOf = (trail, m) => `txo:${trail.chain}:${m.txid}:${m.vout}?amount=${m.amount}&commit=${m.state.commit}&pubkey=${m.program}`;

  /** Derive and append one mark for `state`; caller holds the mark lock. */
  function appendMark(trail, state) {
    const stateHash = markStateHash(state);
    const hashes = [...trail.marks.map((m) => m.stateHash), stateHash];
    const program = trailProgram(trail.pubkeyBase, hashes);
    const mark = {
      index: trail.marks.length,
      state,
      stateHash,
      program,
      address: p2trAddressEncode(chainHrp, Buffer.from(program, 'hex')),
      status: 'pending',
      at: Math.floor(Date.now() / 1000),
    };
    trail.marks.push(mark);
    return mark;
  }

  /**
   * THE one advance beat (3.5): whenever the default-branch tip may have
   * moved on an anchoring-enabled repo — receive-pack completing, a PR
   * merge landing via update-ref — compare the tip to the last mark's
   * state and append a new PENDING mark for the new {commit, repo,
   * branch}. Deriving the address is the whole job: spending the previous
   * mark's UTXO to this address IS the on-chain advance, and it happens
   * elsewhere (the owner's own CLIs). Multiple pushes stack pending marks
   * honestly — each mark is one state; only funded/spent marks are ever
   * reported 'marked'.
   */
  async function recordTip(owner, name) {
    if (!marksEnabled(owner, name)) return;
    const dir = repoDirOf(owner, name);
    const branch = await defaultBranch(dir);
    const tip = await revParse(dir, `refs/heads/${branch}`);
    if (!tip) return;
    await withMarkLock(owner, name, async () => {
      const trail = loadTrail(owner, name);
      if (!trail) return;
      const last = trail.marks.at(-1);
      if (last && last.state.commit === tip && last.state.branch === branch) return; // tip unchanged
      if (sparseMarks && last && last.status === 'pending') {
        // sparse: the trailing mark is unfunded, so RE-TARGET it at the new tip
        // (re-derive its program/address chaining the same MARKED prefix) rather
        // than stacking. The chain gains a link only when a mark is actually
        // funded, so anchoring HEAD stays one tx however many commits landed.
        const state = { commit: tip, repo: `${owner}/${name}`, branch };
        const stateHash = markStateHash(state);
        const hashes = [...trail.marks.slice(0, -1).map((m) => m.stateHash), stateHash];
        const program = trailProgram(trail.pubkeyBase, hashes);
        last.state = state;
        last.stateHash = stateHash;
        last.program = program;
        last.address = p2trAddressEncode(chainHrp, Buffer.from(program, 'hex'));
        last.at = Math.floor(Date.now() / 1000);
        saveTrail(owner, name, trail);
        api.log.info(`forge: mark #${last.index} re-targeted (sparse) for ${owner}/${name}@${branch} (${tip.slice(0, 7)}) -> ${last.address}`);
        return;
      }
      if (trail.marks.length >= MARKS_CAP) {
        api.log.warn(`forge: ${owner}/${name} hit the ${MARKS_CAP}-mark cap — not recording ${tip.slice(0, 7)}`);
        return;
      }
      const mark = appendMark(trail, { commit: tip, repo: `${owner}/${name}`, branch });
      saveTrail(owner, name, trail);
      api.log.info(`forge: mark #${mark.index} pending for ${owner}/${name}@${branch} (${tip.slice(0, 7)}) -> ${mark.address}`);
    });
  }

  /** recordTip as a fire-safe hook: log, never throw into the caller. */
  const recordTipSafe = (owner, name) => recordTip(owner, name)
    .catch((err) => api.log.warn(`forge: recordTip ${owner}/${name} failed: ${err.message}`));

  // ------------------------------------------ nostr discovery (NIP-34)
  // A repo lives on many forges (mirrors); the Blocktrails mark (a Bitcoin
  // tx) is the source of truth; Nostr NIP-34 events are the discovery +
  // notification layer. This forge PUBLISHES a kind-30617 "repo
  // announcement" (name, description, clone/web mirror URLs, relays,
  // maintainers, and — when anchored — the blocktrails.json + genesis txid)
  // signed by a stable per-instance forge key, to the operator-configured
  // relays. ngit (a kind-30617 viewer) then shows the repo.
  //
  // WHO SIGNS: the forge signs with a FORGE-INSTANCE key, not the
  // maintainer's own nostr key (README Finding). For a mirror announcement
  // that is the honest claim — "this instance hosts these clone URLs" — and
  // it needs no custody of the maintainer's key; the `maintainers` tag still
  // names the maintainer's pubkey (for nostr-owned repos, the owner IS that
  // hex pubkey) so a canonical maintainer-signed announcement can supersede
  // it. Testnet/POC posture, same as the anchor key (also forge-held).

  // Announce identity: config.announceKey (32-byte hex) wins; else a key
  // persisted at pluginDir/announce-key (0600), generated once. Stable
  // across restarts so the forge keeps one nostr identity.
  const announceKeyFile = path.join(api.storage.pluginDir(), 'announce-key');
  let announceSk;
  if (typeof api.config.announceKey === 'string' && NOSTR_HEX.test(api.config.announceKey.toLowerCase())) {
    announceSk = api.config.announceKey.toLowerCase();
  } else {
    try {
      const onDisk = fs.readFileSync(announceKeyFile, 'utf8').trim();
      announceSk = NOSTR_HEX.test(onDisk) ? onDisk : null;
    } catch { announceSk = null; }
    if (!announceSk) {
      announceSk = Buffer.from(schnorr.utils.randomPrivateKey()).toString('hex');
      fs.writeFileSync(announceKeyFile, `${announceSk}\n`, { mode: 0o600 });
    }
  }
  const announcePubkey = Buffer.from(schnorr.getPublicKey(announceSk)).toString('hex');

  // config.announceRelays: opt-in list of ws(s):// relay URLs. Empty/unset
  // => emission DISABLED (a documented no-op; relays are NEVER hardcoded
  // always-on — the operator opts in, see the README ngit relay suggestion).
  const announceRelays = (Array.isArray(api.config.announceRelays) ? api.config.announceRelays : [])
    .filter((r) => typeof r === 'string' && /^wss?:\/\/[^\s;'"]+$/i.test(r));
  const NOSTR_RELAY_TIMEOUT_MS = 5000;

  /**
   * A signed NIP-01 event over the announce key: id = sha256 of the
   * canonical serialize [0,pubkey,created_at,kind,tags,content]; sig =
   * schnorr(id). Runtime Date.now() is fine here (plugin runtime, not a
   * workflow script).
   */
  function signAnnounceEvent({ kind, tags, content }) {
    const ev = { pubkey: announcePubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content };
    ev.id = crypto.createHash('sha256')
      .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]), 'utf8')
      .digest('hex');
    ev.sig = Buffer.from(schnorr.sign(ev.id, announceSk)).toString('hex');
    return ev;
  }

  /**
   * buildRepoEvent(owner, name) -> a signed kind-30617 NIP-34 repo
   * announcement. Tags: d (repo id), name, description, web, clone, relays
   * (when configured), maintainers (nostr-owned repos: owner IS the hex
   * pubkey), and — when the repo is anchored (a marks file with a 'marked'
   * mark) — r (the blocktrails.json verification doc) + a custom anchor tag
   * ['anchor', <chain>, <genesis-txid>] pointing at the Bitcoin
   * source-of-truth. content = the description.
   */
  async function buildRepoEvent(owner, name) {
    const summary = await repoSummary(owner, name);
    const description = String(summary.description || '').slice(0, DESCRIPTION_CAP);
    const base = `${publicOrigin()}${prefix}/${owner}/${name}`;
    const tags = [
      ['d', `${owner}/${name}`],
      ['name', name],
      ['description', description],
      ['web', base],
      ['clone', `${base}.git`],
    ];
    if (announceRelays.length) tags.push(['relays', ...announceRelays]);
    if (NOSTR_HEX.test(owner)) tags.push(['maintainers', owner]); // owner IS the pubkey
    const trail = loadTrail(owner, name);
    // Marks are recorded strictly in order (N spends N-1), so a marked mark 0
    // IS the genesis anchor — the Bitcoin tx a consumer treats as truth.
    const genesis = trail && trail.marks[0];
    if (genesis && genesis.status === 'marked') {
      tags.push(['r', `${base}/blocktrails.json`]);
      tags.push(['anchor', trail.chain, genesis.txid]);
    }
    return signAnnounceEvent({ kind: 30617, tags, content: description });
  }

  /**
   * buildStateEvent(owner, name) -> a signed kind-30618 NIP-34 repo STATE
   * event. Replaceable (NIP-33), keyed by the SAME d = `<owner>/<name>` as
   * the 30617, so a consumer correlates announcement and state. Carries the
   * repo's refs so a subscriber (e.g. nostr-git-sync) can `git checkout` a
   * precise commit:
   *   - one ['refs/heads/<branch>', '<full-sha>'] tag PER local head (the
   *     default branch always present when the repo is non-empty)
   *   - ['HEAD', 'ref: refs/heads/<defaultBranch>'] (the symbolic default)
   *   - when anchored (marks file with a 'marked' genesis) the SAME
   *     ['anchor', <chain>, <genesis-txid>] + ['r', <blocktrails.json url>]
   *     as the 30617 — so a subscriber can require Bitcoin-anchored state
   *     before pulling.
   * content is '' (empty, per the state-event convention). Signed with the
   * SAME announce key as the 30617.
   */
  async function buildStateEvent(owner, name) {
    const dir = repoDirOf(owner, name);
    const branch = await defaultBranch(dir);
    const base = `${publicOrigin()}${prefix}/${owner}/${name}`;
    const tags = [['d', `${owner}/${name}`]];
    // Every local head with its FULL commit sha (rev-parse-precise). Empty
    // repo => no head tags; the HEAD tag still names the default branch.
    let heads = [];
    try {
      const out = await gitText(dir, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads']);
      heads = out.split('\n').filter(Boolean).map((l) => l.split('\0'));
    } catch { /* empty/bare-only repo has no heads yet */ }
    // Default branch first (the ref a consumer treats as the tip), then the rest.
    heads.sort((a, b) => (a[0] === `refs/heads/${branch}` ? -1 : b[0] === `refs/heads/${branch}` ? 1 : a[0].localeCompare(b[0])));
    for (const [refname, sha] of heads) tags.push([refname, sha]);
    tags.push(['HEAD', `ref: refs/heads/${branch}`]);
    const trail = loadTrail(owner, name);
    const genesis = trail && trail.marks[0];
    if (genesis && genesis.status === 'marked') {
      tags.push(['r', `${base}/blocktrails.json`]);
      tags.push(['anchor', trail.chain, genesis.txid]);
    }
    return signAnnounceEvent({ kind: 30618, tags, content: '' });
  }

  // ws (the WebSocket client) is loaded LAZILY, only when a publish actually
  // happens — emission is opt-in, so the common (no-relays) path never
  // touches it and activation never depends on it.
  let WebSocketImpl = null;
  async function getWebSocket() {
    if (WebSocketImpl) return WebSocketImpl;
    const mod = await import('ws');
    WebSocketImpl = mod.default;
    return WebSocketImpl;
  }

  /** Publish one event to one relay: send ["EVENT",e], await the relay's
   *  ["OK",id,ok,reason]. Bounded ~5s; never throws — resolves a result. */
  function publishToRelay(WS, event, relay, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let ws;
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (ws) ws.close(); } catch { /* already closing */ }
        resolve(r);
      };
      const timer = setTimeout(() => done({ relay, ok: false, error: 'timeout' }), timeoutMs);
      try { ws = new WS(relay); } catch (err) { return done({ relay, ok: false, error: err.message }); }
      ws.on('open', () => {
        try { ws.send(JSON.stringify(['EVENT', event])); } catch (err) { done({ relay, ok: false, error: err.message }); }
      });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
          done(msg[2] ? { relay, ok: true } : { relay, ok: false, error: String(msg[3] ?? 'rejected') });
        }
      });
      ws.on('error', (err) => done({ relay, ok: false, error: err.message }));
      ws.on('close', () => done({ relay, ok: false, error: 'closed before OK' }));
    });
  }

  /** Publish to every configured relay in parallel. Returns per-relay
   *  {relay, ok, error?}[]; a single relay failing never rejects the whole. */
  async function publishEvent(event, relays = announceRelays, timeoutMs = NOSTR_RELAY_TIMEOUT_MS) {
    if (!relays.length) return [];
    const WS = await getWebSocket();
    return Promise.all(relays.map((relay) => publishToRelay(WS, event, relay, timeoutMs)));
  }

  /**
   * Build + publish BOTH NIP-34 events for one repo: the 30617 announcement
   * (discovery: clone/web URLs, anchor) AND the 30618 repo-state (the refs a
   * subscriber checks out). Returns both. `event`/`relays` stay the 30617
   * (backward-compat); `state`/`stateRelays` are the 30618; `events` lists
   * both in emission order (30617 then 30618).
   */
  async function announceRepo(owner, name) {
    if (!announceRelays.length) return { published: false, event: null, state: null, events: [], relays: [], stateRelays: [] };
    const event = await buildRepoEvent(owner, name);
    const state = await buildStateEvent(owner, name);
    const relays = await publishEvent(event);
    const stateRelays = await publishEvent(state);
    return { published: true, event, state, events: [event, state], relays, stateRelays };
  }

  /** announceRepo as a fire-safe hook: log the tally, never throw. */
  const announceRepoSafe = (owner, name) => announceRepo(owner, name)
    .then((r) => {
      if (r.published) {
        api.log.info(`forge: announced ${owner}/${name} (NIP-34 30617 ${r.event.id.slice(0, 8)}… + 30618 state ${r.state.id.slice(0, 8)}…) to `
          + `${r.relays.filter((x) => x.ok).length}/${r.relays.length} relay(s)`);
      }
    })
    .catch((err) => api.log.warn(`forge: announce ${owner}/${name} failed: ${err.message}`));

  api.log.info(`forge: nostr announce identity ${npubShort(announcePubkey)} (${announcePubkey.slice(0, 8)}…) — `
    + (announceRelays.length
      ? `NIP-34 emission to ${announceRelays.length} relay(s)`
      : 'emission DISABLED (set config.announceRelays to opt in)'));

  // ------------------------------------------------- labels model (polish)
  // The per-repo label SET lives in the repo's issues index file
  // (idx.labels); GitHub's default set applies until the first label write
  // materializes it. Items (issues AND pulls) store label NAMES only, so a
  // recolor needs no cascade; rename/delete cascade over both indexes.

  /** The effective label set: idx.labels, or the (unmaterialized) defaults. */
  function labelDefs(owner, name) {
    const idx = loadIssueIndex(owner, name);
    return Array.isArray(idx.labels) ? idx.labels : DEFAULT_LABELS.map((l) => ({ ...l }));
  }
  /** First label WRITE materializes the defaults into the index. */
  function ensureLabels(idx) {
    if (!Array.isArray(idx.labels)) idx.labels = DEFAULT_LABELS.map((l) => ({ ...l }));
    return idx.labels;
  }
  /** Item label names -> [{name, color}] against the repo's defs. */
  function resolveLabels(names, defs) {
    return (Array.isArray(names) ? names : []).map((n) => defs.find((d) => d.name === n) ?? { name: n, color: 'ededed' });
  }

  // ------------------------------------------------- search model (polish)
  // Read-time only, deliberately UNindexed: one `git ls-tree` for path
  // matches plus one `git grep -I -n -i -F` over the DEFAULT branch,
  // bounded (query 256 chars, 100 hits, 100 paths, 5 hits/file, 200-char
  // excerpts). The documented cost: O(repo) per query, fine at forge scale.
  async function searchData(owner, name, q) {
    const dir = repoDirOf(owner, name);
    const branch = await defaultBranch(dir);
    const out = { q, ref: branch, paths: [], matches: [], truncated: false };
    const needle = q.toLowerCase();
    try {
      for (const p of (await gitText(dir, ['ls-tree', '-r', '--name-only', '-z', branch])).split('\0')) {
        if (!p || !p.toLowerCase().includes(needle)) continue;
        if (out.paths.length >= SEARCH_PATH_CAP) { out.truncated = true; break; }
        out.paths.push(p);
      }
    } catch { /* empty repo: nothing to search */ }
    try {
      // -I skips binaries; -F is literal (no regex injection); -z makes the
      // output parseable even for paths containing ':' — the record shape
      // is `<tree>:<path>\0<line>\0<text>\n`. --max-count needs git >= 2.38
      // (the merge-tree floor, already probed); without it the total cap
      // still holds, one file can just dominate.
      const args = ['grep', '-I', '-n', '-i', '-F', '-z'];
      if (mergeTreeOk) args.push(`--max-count=${SEARCH_PER_FILE_CAP}`);
      const hits = await gitText(dir, [...args, '-e', q, branch]);
      for (const line of hits.split('\n')) {
        if (!line) continue;
        const [treePath, lineNo, ...text] = line.split('\0');
        if (lineNo === undefined) continue;
        if (out.matches.length >= SEARCH_HIT_CAP) { out.truncated = true; break; }
        out.matches.push({
          path: treePath.slice(treePath.indexOf(':') + 1),
          line: +lineNo,
          text: text.join('\0').slice(0, SEARCH_EXCERPT_CAP),
        });
      }
    } catch { /* git grep exits 1 on no match — an empty result, not an error */ }
    return out;
  }

  // ----------------------------------------------- releases model (polish)
  /** Every tag, newest first; annotated tags carry their message line. */
  async function listReleases(owner, name) {
    const dir = repoDirOf(owner, name);
    const out = await gitText(dir, ['for-each-ref', '--sort=-creatordate', 'refs/tags',
      '--format=%(refname:short)%00%(objecttype)%00%(creatordate:unix)%00%(objectname)%00%(*objectname)%00%(contents:subject)']);
    const base = `${prefix}/${owner}/${name}`;
    return out.split('\n').filter(Boolean).map((l) => {
      const [tag, otype, when, oname, peeled, subject] = l.split('\0');
      const annotated = otype === 'tag';
      return {
        tag,
        sha: annotated ? (peeled || oname) : oname, // the commit the tag points at
        at: +when,
        annotated,
        message: annotated ? subject : null, // first line of the tag message
        tarball: `${base}/archive/${tag}.tar.gz`,
        zipball: `${base}/archive/${tag}.zip`,
      };
    });
  }

  /** The head of a PR as a compare spec (owner:ref — same-repo included). */
  const prHeadSpec = (pr) => `${pr.head.owner}:${pr.head.ref}`;

  /**
   * Live mergeability for an OPEN PR's banner/JSON: resolves both ends
   * (re-fetching the fork head), then ff-check or merge-tree. mergeable is
   * null when an end is gone or merge-tree is unavailable.
   */
  async function pullMergeInfo(owner, name, pr) {
    const dir = repoDirOf(owner, name);
    const baseSha = await revParse(dir, `refs/heads/${pr.base}`);
    const head = await resolveHead(owner, name, prHeadSpec(pr));
    const info = { baseSha, headSha: head?.sha ?? null, mergeable: null, conflicts: [], fastForward: false, upToDate: false };
    if (!baseSha || !head) return info;
    if (await isAncestor(dir, head.sha, baseSha)) {
      return { ...info, mergeable: false, upToDate: true }; // nothing to merge
    }
    if (await isAncestor(dir, baseSha, head.sha)) {
      return { ...info, mergeable: true, fastForward: true };
    }
    if (!mergeTreeOk) return info;
    const mt = await mergeTreeOf(dir, baseSha, head.sha);
    return { ...info, mergeable: mt.clean, conflicts: mt.conflicts };
  }

  /**
   * Commit list + structured diff for a PR's Commits / Files-changed tabs.
   * Merged PRs use the shas frozen at merge time (the objects outlive the
   * branch), open/closed ones compute live from base...head.
   */
  async function pullDiffData(owner, name, pr) {
    const dir = repoDirOf(owner, name);
    if (pr.state === 'merged' && pr.merged?.baseSha && pr.merged?.headSha) {
      const { baseSha, headSha } = pr.merged;
      let mergeBase = null;
      try { mergeBase = (await gitText(dir, ['merge-base', baseSha, headSha])).trim() || null; } catch { /* kept shas */ }
      const { commits, hasMore } = await commitLog(dir, `${baseSha}..${headSha}`, 1);
      const patch = await gitText(dir, ['diff', '--no-color', mergeBase ?? baseSha, headSha]).catch(() => '');
      return { commits, hasMore, files: parsePatch(patch) };
    }
    const cmp = await compareData(owner, name, pr.base, prHeadSpec(pr));
    return cmp ? { commits: cmp.commits, hasMore: cmp.hasMore, files: cmp.files } : { commits: [], hasMore: false, files: [] };
  }

  /**
   * Loopback-PUT an issue/comment document into the AUTHOR's pod with the
   * author's own forwarded Bearer: real WAC governs the write and the
   * resource is the author's property, not the forge's.
   */
  async function storeAuthored(request, podPath, owner, name, doc, filename) {
    const resourcePath = `${podPath}public/forge/${owner}--${name}/${filename}`;
    let put;
    try {
      put = await lb(resourcePath, {
        method: 'PUT',
        headers: { 'content-type': 'application/ld+json' },
        body: JSON.stringify(doc),
        auth: request.headers.authorization,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      return { status: 502, error: `pod write failed: ${err.message}` };
    }
    try { await put.body?.cancel(); } catch { /* drained */ }
    if (put.status === 401 || put.status === 403) return { status: 403, error: 'your pod refused the write' };
    if (!(put.ok || put.status === 204)) return { status: 502, error: `pod write failed (${put.status})` };
    return { url: `${publicOrigin()}${resourcePath}` };
  }

  /**
   * The one storage beat for authored words (tier-2 semantics, shared by
   * issues and pulls): pod users get a loopback PUT into their own pod,
   * podless did:nostr agents get forge-hosted storage. Returns
   * { url, hosted } or { status, error }.
   */
  async function persistBody(request, agent, owner, name, doc, filePrefix) {
    const podPath = podPathFromAgent(agent);
    const hex = nostrHexOf(agent);
    if (!podPath && !hex) return { status: 403, error: 'no pod namespace for this agent' };
    const stored = hex
      ? storeHosted(hex, { ...doc, hosted: true })
      : await storeAuthored(request, podPath, owner, name, doc, `${filePrefix}-${crypto.randomUUID()}.jsonld`);
    if (stored.error) return stored;
    return { url: stored.url, hosted: !!hex };
  }

  /**
   * The capstone storage beat (WAC-native authored words). A WebID/Solid
   * (DPoP) — or NIP-98 — proof is cryptographically bound to ONE request URI
   * (DPoP `htu`, NIP-98 `u`): the forge CANNOT forward the caller's
   * credential to a SECOND URL (the pod write) because the proof names the
   * API URL, not the pod resource. So the BROWSER writes the body into its
   * OWN pod (a fresh per-request proof, minted by xlogin.authFetch), and the
   * forge is handed only a POINTER. Here the forge VALIDATES that pointer:
   *  - it must name a resource inside THIS author's OWN pod forge area for
   *    THIS repo — `${podPath}public/forge/${owner}--${name}/…​.jsonld`, no
   *    traversal (pointer-injection defense: a caller can register only its
   *    own pod's resources for this one repo);
   *  - it must really be there and PUBLICLY readable — an UNAUTHENTICATED
   *    loopback GET, exactly how resolveEntry re-fetches bodies for display
   *    (bodies live under public/forge/, so the read is request-agnostic and
   *    needs no forwarded proof).
   * On success the pointer is stored identically to a server-written one.
   * Returns { url } or { status, error }.
   */
  async function registerPointer(request, agent, owner, name, resourceUrl) {
    const podPath = podPathFromAgent(agent);
    if (!podPath) return { status: 403, error: 'pointer registration requires a pod agent' };
    const p = resourcePathOf(resourceUrl);
    if (!p) return { status: 400, error: 'invalid resourceUrl' };
    const allowed = `${podPath}public/forge/${owner}--${name}/`;
    if (!p.startsWith(allowed) || !p.endsWith('.jsonld') || p.includes('..')) {
      return { status: 403, error: 'resourceUrl must be inside your own pod forge area for this repo' };
    }
    let res;
    try {
      res = await lb(p, {
        headers: { accept: 'application/ld+json' },
        signal: AbortSignal.timeout(THREAD_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return { status: 400, error: `pointer not found in your pod: ${err.message}` };
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* drained */ }
      return { status: 400, error: 'pointer not found in your pod' };
    }
    let doc;
    try { doc = await res.json(); } catch { doc = null; }
    if (!doc || typeof doc.body !== 'string' || doc.body.length > ISSUE_BODY_CAP) {
      return { status: 400, error: 'pointer is not a readable forge document' };
    }
    return { url: `${publicOrigin()}${p}` };
  }

  /** Loopback path of a stored resource URL (absolute or path form). */
  function resourcePathOf(resourceUrl) {
    if (typeof resourceUrl !== 'string') return null;
    if (resourceUrl.startsWith('/')) return resourceUrl;
    try { return new URL(resourceUrl).pathname; } catch { return null; }
  }

  /**
   * One thread slot, re-fetched from its author's pod — or, for hosted
   * (podless did:nostr) entries, read straight from pluginDir/hosted.
   * Deleted => removed, identically for both storage homes.
   */
  async function resolveEntry(e) {
    const slot = { author: e.author, at: e.at, resourceUrl: e.resourceUrl, hosted: e.hosted === true };
    if (e.hosted === true) {
      const ref = hostedRefOf(e.resourceUrl);
      const doc = ref ? readHosted(ref.hex, ref.id) : null;
      if (!doc || typeof doc.body !== 'string') return { ...slot, body: null, removed: true };
      return { ...slot, body: doc.body.slice(0, ISSUE_BODY_CAP), removed: false };
    }
    const p = resourcePathOf(e.resourceUrl);
    if (!p) return { ...slot, body: null, removed: true };
    try {
      const res = await lb(p, {
        headers: { accept: 'application/ld+json' },
        signal: AbortSignal.timeout(THREAD_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* drained */ }
        return { ...slot, body: null, removed: true };
      }
      const doc = await res.json();
      if (typeof doc?.body !== 'string') return { ...slot, body: null, removed: true };
      return { ...slot, body: doc.body.slice(0, ISSUE_BODY_CAP), removed: false };
    } catch { return { ...slot, body: null, removed: true }; }
  }

  /**
   * Resolve a whole thread: N pointers -> N loopback GETs, bounded to
   * THREAD_FETCH_CONCURRENCY in flight (the read-time fan-out cost of
   * keeping bodies in pods — measured and written down in README Findings).
   */
  async function resolveThread(thread) {
    const out = new Array(thread.length);
    let next = 0;
    const worker = async () => {
      while (next < thread.length) {
        const i = next;
        next += 1;
        out[i] = await resolveEntry(thread[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(THREAD_FETCH_CONCURRENCY, thread.length) }, worker));
    return out;
  }

  // Rendering identity (2.5): nostr agents display as shortened npub —
  // NEVER as raw hex — and link to core's did:nostr DID-document route
  // (/.well-known/did/nostr/<hex>, src/idp/well-known-did-nostr.js, real
  // in the published server). Hex stays canonical in every path/id.
  const displayName = (agent) => {
    const hex = nostrHexOf(agent);
    if (hex) return npubShort(hex);
    return ownerFromAgent(agent) ?? String(agent);
  };
  const authorHref = (agent) => {
    const hex = nostrHexOf(agent);
    return hex ? `/.well-known/did/nostr/${hex}` : String(agent);
  };
  /** Owner path segment -> display form (npub-short for hex namespaces). */
  const dispOwner = (owner) => (NOSTR_HEX.test(owner) ? npubShort(owner) : owner);
  /** Additive author metadata for the JSON API (list + thread). */
  function authorMeta(agent) {
    const hex = nostrHexOf(agent);
    if (hex) return { id: agent, displayName: npubShort(hex), npub: npubEncode(hex), kind: 'nostr' };
    return { id: String(agent), displayName: displayName(agent), kind: 'webid' };
  }
  const issueMdCtx = (owner, name) => ({
    rawBase: `${prefix}/${owner}/${name}/raw/HEAD`,
    blobBase: `${prefix}/${owner}/${name}/blob/HEAD`,
  });

  // ------------------------------------------------------------ materialize

  const POST_RECEIVE_HOOK = [
    '#!/bin/sh',
    '# jss forge: keep HEAD on a branch that exists after the first push.',
    'if ! git rev-parse --verify -q HEAD >/dev/null; then',
    "  first=$(git for-each-ref --format='%(refname)' refs/heads | head -n 1)",
    '  [ -n "$first" ] && git symbolic-ref HEAD "$first"',
    'fi',
    '',
  ].join('\n');

  async function materialize(owner, name, agent) {
    const dir = repoDirOf(owner, name);
    if (fs.existsSync(dir)) return dir;
    fs.mkdirSync(path.join(reposDir, owner), { recursive: true });
    await execFileP('git', ['init', '--bare', '--quiet', dir], { env: gitEnv });
    await execFileP('git', ['-C', dir, 'config', 'http.receivepack', 'true'], { env: gitEnv });
    await execFileP('git', ['-C', dir, 'config', 'uploadpack.hideRefs', 'refs/forge/'], { env: gitEnv });
    fs.writeFileSync(path.join(dir, 'hooks', 'post-receive'), POST_RECEIVE_HOOK, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify({ createdAt: Date.now(), creator: agent ?? null }, null, 2));
    api.log.info(`forge: created ${owner}/${name}.git for ${agent}`);
    return dir;
  }

  // ------------------------------------------------------------- CGI bridge
  // gitscratch's runBackend, re-rooted at repos/<owner>/<name>.git.
  // onExit (3.5) fires when the CGI child CLOSES after a served response —
  // for git-receive-pack that is "the receive finished, refs are final",
  // which is exactly the post-receive moment the anchoring advance needs
  // (core ISSUES.md #271 called this hook "core, not a plugin" — owning
  // the receive path moved that line; see README Findings).
  function runBackend(request, reply, { owner, name, subPath, agent, onExit }) {
    return new Promise((resolve, reject) => {
      const env = {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PROJECT_ROOT: reposDir,
        GIT_HTTP_EXPORT_ALL: '1',
        GATEWAY_INTERFACE: 'CGI/1.1',
        SERVER_PROTOCOL: 'HTTP/1.1',
        REQUEST_METHOD: request.method,
        PATH_INFO: `/${owner}/${name}.git/${subPath}`,
        QUERY_STRING: request.raw.url.split('?')[1] ?? '',
        REMOTE_ADDR: request.ip ?? '',
      };
      const contentType = request.headers['content-type'];
      const contentLength = request.headers['content-length'];
      const contentEncoding = request.headers['content-encoding'];
      const gitProtocol = request.headers['git-protocol'];
      if (contentType) env.CONTENT_TYPE = contentType;
      if (contentLength) env.CONTENT_LENGTH = contentLength;
      if (contentEncoding) env.HTTP_CONTENT_ENCODING = contentEncoding;
      if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
      if (agent) env.REMOTE_USER = agent;

      const child = spawn(backend, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });

      child.stdin.on('error', () => { /* EPIPE if backend exits early */ });
      if (request.body && typeof request.body.pipe === 'function') {
        request.body.pipe(child.stdin);
      } else {
        child.stdin.end(request.body ?? undefined);
      }

      let head = Buffer.alloc(0);
      let headersDone = false;
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        let sep = head.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (sep === -1) { sep = head.indexOf('\n\n'); sepLen = 2; }
        if (sep === -1) {
          if (head.length > 64 * 1024) {
            child.kill();
            reject(new Error('forge: CGI header block never terminated'));
          }
          return;
        }
        headersDone = true;
        child.stdout.off('data', onData);

        let status = 200;
        for (const line of head.subarray(0, sep).toString('latin1').split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') status = parseInt(value, 10) || 200;
          else reply.header(key, value);
        }
        reply.code(status);

        const out = new PassThrough();
        out.write(head.subarray(sep + sepLen));
        child.stdout.pipe(out);
        resolve(reply.send(out));
      };
      child.stdout.on('data', onData);

      child.on('error', (err) => {
        if (!headersDone) reject(new Error(`forge: cannot spawn ${backend}: ${err.message}`));
      });
      child.on('close', (code) => {
        if (!headersDone) {
          reject(new Error(`forge: git-http-backend exited ${code} before headers${stderr ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0 && stderr) {
          api.log.warn(`forge: git-http-backend exited ${code}: ${stderr.trim()}`);
        }
        // Refs may have moved even on a non-zero exit (partial pushes);
        // the hook compares tips itself, so fire it either way.
        onExit?.();
      });

      reply.raw.on('close', () => {
        if (child.exitCode === null && !reply.raw.writableFinished) child.kill();
      });
    });
  }

  // ------------------------------------------------------------- html pages

  function sendHtml(reply, status, html) {
    return reply.code(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', csp)
      .send(html);
  }

  function page(title, body) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body>
<div class="topbar"><div class="container">${ICON_REPO} <a class="brand" href="${prefix}/">Forge</a></div></div>
${body}
</body></html>`;
  }

  function repoStrip(owner, name, tab, branch) {
    const base = `${prefix}/${owner}/${name}`;
    const open = openIssueCount(owner, name);
    const openPulls = openPullCount(owner, name);
    const tabs = [
      ['code', 'Code', base],
      ['issues', `Issues${open ? ` <span class="badge">${open}</span>` : ''}`, `${base}/issues`],
      ['pulls', `${ICON_PR_TAB} Pull requests${openPulls ? ` <span class="badge">${openPulls}</span>` : ''}`, `${base}/pulls`],
      ['commits', 'Commits', `${base}/commits/${branch}`],
      ['branches', 'Branches', `${base}/branches`],
      ['tags', 'Tags', `${base}/tags`],
      // Anchors only surfaces once the owner enabled anchoring (the marks
      // page itself always exists — it carries the Enable pitch).
      ...(marksEnabled(owner, name) ? [['anchors', 'Anchors', `${base}/marks`]] : []),
    ].map(([id, label, href]) => `<a class="tab${tab === id ? ' active' : ''}" href="${href}">${label}</a>`).join('');
    return `<div class="repo-strip"><div class="container">
<div class="crumb">${ICON_REPO} <a href="${prefix}/${owner}">${esc(dispOwner(owner))}</a><span class="muted">/</span><a href="${base}"><b>${esc(name)}</b></a>
<span class="badge">${privateRepos ? 'Private' : 'Public'}</span></div>
<nav class="tabs">${tabs}</nav>
</div></div>`;
  }

  function branchSelector(owner, name, kind, current, branches, tags, pathSuffix) {
    const base = `${prefix}/${owner}/${name}`;
    const links = [
      ...branches.map((b) => `<a href="${base}/${kind}/${esc(b.name)}${pathSuffix}">${ICON_BRANCH} ${esc(b.name)}</a>`),
      ...tags.map((t) => `<a href="${base}/${kind}/${esc(t.name)}${pathSuffix}">${ICON_TAG} ${esc(t.name)}</a>`),
    ].join('');
    return `<details class="dd"><summary class="btn">${ICON_BRANCH} <b>${esc(current)}</b> &#9662;</summary>
<div class="menu"><div class="mtitle">Switch branches/tags</div>${links || '<span class="muted">none</span>'}</div></details>`;
  }

  function cloneBox(owner, name) {
    const url = cloneUrlOf(owner, name);
    return `<details class="dd"><summary class="btn btn-primary">Code &#9662;</summary>
<div class="menu"><div class="mtitle">Clone over smart HTTP</div>
<div class="clonebox"><input id="cloneurl" readonly value="${esc(url)}" onfocus="this.select()">
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('cloneurl').value)">Copy</button></div>
</div></details>`;
  }

  function commitLine(owner, name, c) {
    const base = `${prefix}/${owner}/${name}`;
    return `${identicon(c.email)} <b>${esc(c.author)}</b>
<span class="msg"><a href="${base}/commit/${c.sha}" style="color:#1f2328">${esc(c.subject)}</a></span>
<a class="sha" href="${base}/commit/${c.sha}">${esc(c.short)}</a>
<span class="muted">${relTime(c.at)}</span>`;
  }

  async function indexPage(reply, ownerFilter = null, query = null) {
    const q = typeof query?.q === 'string' ? query.q.trim().slice(0, SEARCH_QUERY_CAP) : '';
    let cards = [];
    for (const owner of (ownerFilter ? [ownerFilter] : listOwners())) {
      for (const name of listRepoNames(owner)) {
        if (cards.length >= 200) break;
        cards.push(await repoSummary(owner, name));
      }
    }
    cards.sort((a, b) => (b.lastPush ?? 0) - (a.lastPush ?? 0));
    const hadAny = cards.length > 0;
    if (q) {
      const needle = q.toLowerCase();
      cards = cards.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(needle)
        || r.description.toLowerCase().includes(needle));
    }
    // A plain GET form — server-side substring filter, no JS involved.
    const searchBox = `<form class="searchform" method="get" action="${prefix}/" style="margin-bottom:16px">
<input type="search" name="q" value="${esc(q)}" placeholder="Find a repository&hellip;" aria-label="Find a repository">
<button class="btn" type="submit">Search</button></form>`;
    const emptyCard = q && hadAny
      ? `<div class="empty"><h3>No repositories match</h3><p class="muted">Nothing named or described like <code>${esc(q)}</code>.</p></div>`
      : null;
    const body = cards.length ? cards.map((r) => `<div class="repocard">
<h3>${ICON_REPO} <a href="${prefix}/${r.owner}">${esc(dispOwner(r.owner))}</a><span class="muted">/</span><a href="${prefix}/${r.owner}/${r.name}"><b>${esc(r.name)}</b></a> <span class="badge">${privateRepos ? 'Private' : 'Public'}</span></h3>
${r.parent ? `<div class="muted" style="font-size:12px">forked from <a href="${prefix}/${r.parent}">${esc(r.parent)}</a></div>` : ''}
${r.description ? `<div class="muted">${esc(r.description)}</div>` : ''}
${r.lastPush ? `<div class="muted" style="font-size:12px;margin-top:4px">Updated ${relTime(r.lastPush)}</div>` : '<div class="muted" style="font-size:12px;margin-top:4px">Empty repository</div>'}
</div>`).join('\n')
      : emptyCard ?? `<div class="empty"><h3>No repositories yet</h3><p class="muted">Push to create one:</p>
<pre>git remote add forge &lt;origin&gt;${prefix}/&lt;your-username&gt;/&lt;name&gt;.git
git push forge main</pre></div>`;
    return sendHtml(reply, 200, page('Repositories · Forge', `<main><div class="container"><h1 class="page">Repositories</h1>${searchBox}${body}</div></main>`));
  }

  async function ownerPage(reply, owner) {
    const names = listRepoNames(owner);
    if (!names.length && !fs.existsSync(path.join(reposDir, owner))) {
      return sendHtml(reply, 404, page('Not found', '<main><div class="container"><h1 class="page">Not found</h1></div></main>'));
    }
    const cards = [];
    for (const name of names) cards.push(await repoSummary(owner, name));
    cards.sort((a, b) => (b.lastPush ?? 0) - (a.lastPush ?? 0));
    const body = cards.map((r) => `<div class="repocard">
<h3>${ICON_REPO} <a href="${prefix}/${r.owner}/${r.name}"><b>${esc(r.name)}</b></a> <span class="badge">${privateRepos ? 'Private' : 'Public'}</span></h3>
${r.parent ? `<div class="muted" style="font-size:12px">forked from <a href="${prefix}/${r.parent}">${esc(r.parent)}</a></div>` : ''}
${r.description ? `<div class="muted">${esc(r.description)}</div>` : ''}
${r.lastPush ? `<div class="muted" style="font-size:12px;margin-top:4px">Updated ${relTime(r.lastPush)}</div>` : '<div class="muted" style="font-size:12px;margin-top:4px">Empty repository</div>'}
</div>`).join('\n') || '<p class="muted">No repositories.</p>';
    return sendHtml(reply, 200, page(`${dispOwner(owner)} · Forge`, `<main><div class="container"><h1 class="page">${identicon(owner, 28)} ${esc(dispOwner(owner))}</h1>${body}</div></main>`));
  }

  /** File table for a tree, with per-entry last-commit info (capped). */
  async function fileTable(owner, name, dir, ref, dirPath, entries) {
    const base = `${prefix}/${owner}/${name}`;
    const enrich = entries.slice(0, 100);
    const infos = await Promise.all(enrich.map((e) => lastCommit(dir, ref, dirPath ? `${dirPath}/${e.name}` : e.name)));
    const rows = entries.map((e, i) => {
      const p = dirPath ? `${dirPath}/${e.name}` : e.name;
      const href = `${base}/${e.type === 'tree' ? 'tree' : 'blob'}/${ref}/${p}`;
      const c = infos[i] ?? null;
      return `<tr>
<td class="name">${e.type === 'tree' ? ICON_DIR : ICON_FILE} <a href="${href}">${esc(e.name)}</a></td>
<td class="cmsg">${c ? `<a href="${base}/commit/${c.sha}">${esc(c.subject)}</a>` : ''}</td>
<td class="age">${c ? relTime(c.at) : ''}</td>
</tr>`;
    }).join('\n');
    return `<table class="files">${rows}</table>`;
  }

  async function findReadme(dir, ref, entries) {
    const e = entries.find((x) => x.type === 'blob' && /^readme(\.(md|markdown|txt))?$/i.test(x.name));
    if (!e) return null;
    if (e.size !== null && e.size > RENDER_CAP) return { name: e.name, tooLarge: true };
    const buf = await catBlob(dir, ref, e.name);
    if (looksBinary(buf)) return null;
    return { name: e.name, text: buf.toString('utf8'), markdown: /\.(md|markdown)$/i.test(e.name) };
  }

  function readmeCard(owner, name, ref, readme) {
    if (!readme) return '';
    const base = `${prefix}/${owner}/${name}`;
    let inner;
    if (readme.tooLarge) {
      inner = `<p class="muted">README is too large to render — <a href="${base}/raw/${ref}/${esc(readme.name)}">view raw</a>.</p>`;
    } else if (readme.markdown) {
      inner = renderMarkdown(readme.text, { rawBase: `${base}/raw/${ref}`, blobBase: `${base}/blob/${ref}` });
    } else {
      inner = `<pre>${esc(readme.text)}</pre>`;
    }
    return `<div class="readme"><div class="rtitle">${esc(readme.name)}</div><div class="markdown-body">${inner}</div></div>`;
  }

  /** "forked from parent / N forks" line under the repo crumb, or ''. */
  function lineageLine(owner, name, parent) {
    const bits = [];
    if (parent) {
      bits.push(`forked from <a href="${prefix}/${parent.owner}/${parent.name}">${esc(dispOwner(parent.owner))}/${esc(parent.name)}</a>`);
    }
    const forks = countForks(owner, name);
    if (forks) bits.push(`${forks} fork${forks === 1 ? '' : 's'}`);
    return bits.length ? `<p class="muted" style="margin:0 0 12px;font-size:13px">${bits.join(' &middot; ')}</p>` : '';
  }

  async function repoHome(reply, owner, name) {
    const dir = repoDirOf(owner, name);
    const branch = await defaultBranch(dir);
    const branches = await listRefs(dir, 'heads');
    const tags = await listRefs(dir, 'tags');
    const base = `${prefix}/${owner}/${name}`;
    const parent = readForkParent(owner, name);
    const lineage = lineageLine(owner, name, parent);

    if (!branches.length) {
      const body = `${repoStrip(owner, name, 'code', branch)}<main><div class="container">
${lineage}
<div style="display:flex;justify-content:flex-end">${cloneBox(owner, name)}</div>
<div class="empty"><h3>This repository is empty</h3>
<p class="muted">Push an existing repository to populate it:</p>
<pre>git remote add forge &lt;origin&gt;${base}.git
git push -u forge ${esc(branch)}</pre></div></div></main>`;
      return sendHtml(reply, 200, page(`${owner}/${name} · Forge`, body));
    }

    // A recently pushed non-default branch on a FORK earns a gentle
    // "open a PR?" hint — cheap: the branch list is already in hand.
    let pushHint = '';
    if (parent && repoExists(parent.owner, parent.name)) {
      const recent = branches.find((b) => b.name !== branch && (Date.now() / 1000 - b.when) < 3600);
      if (recent) {
        const parentBranch = await defaultBranch(repoDirOf(parent.owner, parent.name));
        pushHint = `<div class="pushhint">${ICON_BRANCH} <b>${esc(recent.name)}</b> had recent pushes ${relTime(recent.when)} &mdash;
<a href="${prefix}/${parent.owner}/${parent.name}/compare/${esc(parentBranch)}...${owner}:${esc(recent.name)}">open a pull request?</a></div>`;
      }
    }

    const entries = await lsTree(dir, branch, '');
    const tip = await lastCommit(dir, branch, '');
    const readme = await findReadme(dir, branch, entries);
    const description = repoDescription(owner, name);
    const body = `${repoStrip(owner, name, 'code', branch)}<main><div class="container">
${lineage}${pushHint}
${description ? `<p class="muted" style="margin:0 0 16px">${esc(description)}</p>` : ''}
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
${branchSelector(owner, name, 'tree', branch, branches, tags, '')}
<div style="display:flex;gap:8px;align-items:center">
<form class="searchform" method="get" action="${base}/search"><input type="search" name="q" placeholder="Search code&hellip;" aria-label="Search code" style="min-width:180px"></form>
${cloneBox(owner, name)}
</div>
</div>
<div class="box">
<div class="commitbar">${tip ? commitLine(owner, name, tip) : ''}</div>
${await fileTable(owner, name, dir, branch, '', entries)}
</div>
${readmeCard(owner, name, branch, readme)}
</div></main>`;
    return sendHtml(reply, 200, page(`${owner}/${name} · Forge`, body));
  }

  function crumbPath(base, kind, ref, dirPath, name) {
    const segs = dirPath ? dirPath.split('/') : [];
    let acc = '';
    const parts = segs.map((s, i) => {
      acc += (acc ? '/' : '') + s;
      const last = i === segs.length - 1;
      return last ? `<b>${esc(s)}</b>` : `<a href="${base}/tree/${ref}/${acc}">${esc(s)}</a>`;
    });
    return [`<a href="${base}"><b>${esc(name)}</b></a>`, ...parts].join('<span class="muted"> / </span>');
  }

  async function treePage(reply, owner, name, segs) {
    const dir = repoDirOf(owner, name);
    const [ref, rest] = await splitRefPath(dir, segs);
    if (!okRef(ref) || !okPath(rest)) return notFound(reply);
    const dirPath = rest.join('/');
    let entries;
    try { entries = await lsTree(dir, ref, dirPath); } catch { return notFound(reply); }
    const branches = await listRefs(dir, 'heads');
    const tags = await listRefs(dir, 'tags');
    const base = `${prefix}/${owner}/${name}`;
    const tip = await lastCommit(dir, ref, dirPath);
    const up = dirPath
      ? `<tr><td class="name">${ICON_DIR} <a href="${rest.length > 1 ? `${base}/tree/${ref}/${rest.slice(0, -1).join('/')}` : `${base}/tree/${ref}`}">..</a></td><td class="cmsg"></td><td class="age"></td></tr>`
      : '';
    const table = await fileTable(owner, name, dir, ref, dirPath, entries);
    const body = `${repoStrip(owner, name, 'code', ref)}<main><div class="container">
<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
${branchSelector(owner, name, 'tree', ref, branches, tags, dirPath ? `/${dirPath}` : '')}
<span style="font-size:16px">${crumbPath(base, 'tree', ref, dirPath, name)}</span>
</div>
<div class="box">
<div class="commitbar">${tip ? commitLine(owner, name, tip) : ''}</div>
${up ? table.replace('<table class="files">', `<table class="files">${up}`) : table}
</div>
</div></main>`;
    return sendHtml(reply, 200, page(`${dirPath || name} at ${ref} · ${owner}/${name}`, body));
  }

  async function blobPage(reply, owner, name, segs) {
    const dir = repoDirOf(owner, name);
    const [ref, rest] = await splitRefPath(dir, segs);
    if (!okRef(ref) || !rest.length || !okPath(rest)) return notFound(reply);
    const p = rest.join('/');
    const type = await objectType(dir, ref, p);
    if (type === 'tree') return reply.redirect(`${prefix}/${owner}/${name}/tree/${ref}/${p}`);
    if (type !== 'blob') return notFound(reply);
    const base = `${prefix}/${owner}/${name}`;
    const rawHref = `${base}/raw/${ref}/${p}`;
    const size = await blobSize(dir, ref, p);
    let inner;
    let lineInfo = '';
    if (size > RENDER_CAP) {
      inner = `<div class="dbinary muted">File too large to render (${fmtBytes(size)}) — <a href="${rawHref}">view raw</a>.</div>`;
    } else {
      const buf = await catBlob(dir, ref, p);
      if (looksBinary(buf)) {
        inner = `<div class="dbinary muted">Binary file (${fmtBytes(size)}) — <a href="${rawHref}">view raw</a>.</div>`;
      } else {
        const text = buf.toString('utf8');
        const lines = text.split('\n');
        if (lines.at(-1) === '') lines.pop();
        lineInfo = `${lines.length} lines &middot; ${fmtBytes(size)}`;
        const rows = lines.map((l, i) => `<tr><td class="num" id="L${i + 1}">${i + 1}</td><td class="code">${esc(l) || '&nbsp;'}</td></tr>`).join('\n');
        inner = `<div style="overflow-x:auto"><table class="blob">${rows}</table></div>`;
      }
    }
    const tip = await lastCommit(dir, ref, p);
    const body = `${repoStrip(owner, name, 'code', ref)}<main><div class="container">
<div style="margin-bottom:16px;font-size:16px">${crumbPath(base, 'blob', ref, p, name)}</div>
<div class="box">
<div class="blobhead"><span>${lineInfo}</span><span style="flex:1"></span>
${tip ? `<span class="muted">Latest commit <a class="sha" href="${base}/commit/${tip.sha}">${esc(tip.short)}</a> ${relTime(tip.at)}</span>` : ''}
<a class="btn" href="${rawHref}">Raw</a></div>
${inner}
</div>
</div></main>`;
    return sendHtml(reply, 200, page(`${p} at ${ref} · ${owner}/${name}`, body));
  }

  async function rawResp(reply, owner, name, segs) {
    const dir = repoDirOf(owner, name);
    const [ref, rest] = await splitRefPath(dir, segs);
    if (!okRef(ref) || !rest.length || !okPath(rest)) return notFound(reply);
    const p = rest.join('/');
    let buf;
    try { buf = await catBlob(dir, ref, p); } catch { return notFound(reply); }
    // NEVER text/html: a pushed .html file must not execute on this origin.
    reply.header('x-content-type-options', 'nosniff');
    if (looksBinary(buf)) {
      const fname = path.basename(p).replace(/["\\\x00-\x1f]/g, '_');
      return reply.code(200)
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${fname}"`)
        .send(buf);
    }
    return reply.code(200).header('content-type', 'text/plain; charset=utf-8').send(buf);
  }

  async function commitsPage(reply, owner, name, segs, query) {
    const dir = repoDirOf(owner, name);
    const ref = segs.join('/');
    if (!okRef(ref) && !SHA_RE.test(ref)) return notFound(reply);
    const pageNo = Math.max(1, Math.min(10000, parseInt(query?.page, 10) || 1));
    let log;
    try { log = await commitLog(dir, ref, pageNo); } catch { return notFound(reply); }
    const base = `${prefix}/${owner}/${name}`;
    const rows = log.commits.map((c) => `<div class="row">${identicon(c.email)}
<div class="grow"><div><a href="${base}/commit/${c.sha}" style="color:#1f2328;font-weight:600">${esc(c.subject)}</a></div>
<div class="muted" style="font-size:12px"><b>${esc(c.author)}</b> committed ${relTime(c.at)}</div></div>
<a class="sha" href="${base}/commit/${c.sha}">${esc(c.short)}</a></div>`).join('\n');
    const pager = `<div class="pager">
${pageNo > 1 ? `<a class="btn" href="${base}/commits/${ref}?page=${pageNo - 1}">&larr; Newer</a>` : ''}
${log.hasMore ? `<a class="btn" href="${base}/commits/${ref}?page=${pageNo + 1}">Older &rarr;</a>` : ''}
</div>`;
    const body = `${repoStrip(owner, name, 'commits', ref)}<main><div class="container">
<h1 class="page">Commits <span class="muted" style="font-size:14px">on ${ICON_BRANCH} ${esc(ref)}</span></h1>
<div class="list">${rows || '<div class="row muted">No commits yet.</div>'}</div>
${pager}
</div></main>`;
    return sendHtml(reply, 200, page(`Commits · ${owner}/${name}`, body));
  }

  async function commitPage(reply, owner, name, sha) {
    if (!SHA_RE.test(sha)) return notFound(reply);
    const dir = repoDirOf(owner, name);
    const meta = await commitMeta(dir, sha);
    if (!meta) return notFound(reply);
    const files = await commitDiff(dir, sha);
    const base = `${prefix}/${owner}/${name}`;
    const branch = await defaultBranch(dir);
    const [subject, ...bodyLines] = meta.message.split('\n');
    const body = `${repoStrip(owner, name, 'commits', branch)}<main><div class="container commitpage">
<h2>${esc(subject)}</h2>
${bodyLines.filter((l) => l.trim()).length ? `<pre style="background:#f6f8fa;border-radius:6px;padding:12px">${esc(bodyLines.join('\n').trim())}</pre>` : ''}
<div class="cmeta">${identicon(meta.email)} <b>${esc(meta.author)}</b>
<span class="muted">committed ${relTime(meta.at)}</span><span style="flex:1"></span>
${meta.parents.map((p) => `<span class="muted">parent <a class="sha" href="${base}/commit/${p}">${esc(p.slice(0, 7))}</a></span>`).join(' ')}
<span class="sha">commit ${esc(meta.full)}</span></div>
${renderDiff(files)}
</div></main>`;
    return sendHtml(reply, 200, page(`${meta.short} · ${owner}/${name}`, body));
  }

  async function refsPage(reply, owner, name, kind) {
    const dir = repoDirOf(owner, name);
    const refs = await listRefs(dir, kind === 'branches' ? 'heads' : 'tags');
    const branch = await defaultBranch(dir);
    const base = `${prefix}/${owner}/${name}`;
    const icon = kind === 'branches' ? ICON_BRANCH : ICON_TAG;
    const rows = refs.map((r) => `<div class="row">${icon}
<div class="grow"><a href="${base}/tree/${esc(r.name)}"><b>${esc(r.name)}</b></a>
${kind === 'branches' && r.name === branch ? '<span class="badge">default</span>' : ''}
<div class="muted" style="font-size:12px">${esc(r.subject ?? '')}</div></div>
<a class="sha" href="${base}/commit/${esc(r.sha)}">${esc(r.sha)}</a>
<span class="muted" style="font-size:12px">${relTime(r.when)}</span></div>`).join('\n');
    const body = `${repoStrip(owner, name, kind, branch)}<main><div class="container">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
<h1 class="page" style="margin:0">${kind === 'branches' ? 'Branches' : 'Tags'}</h1>
${kind === 'tags' ? `<a class="btn" href="${base}/releases">${ICON_TAG} Releases</a>` : ''}
</div>
<div class="list">${rows || `<div class="row muted">No ${kind} yet.</div>`}</div>
</div></main>`;
    return sendHtml(reply, 200, page(`${kind} · ${owner}/${name}`, body));
  }

  // ------------------------------------------------------------ issues pages
  // Server-rendered like everything else; the ONLY interactive layer is one
  // inline dependency-free module (below) that logs in against
  // /idp/credentials, drives writes through the JSON API with a Bearer, and
  // reloads — the server always renders the truth. DOM writes go through
  // textContent/createElement only; fetched strings never meet innerHTML.

  function issuesScript(cfg) {
    // cfg values are validated owner/repo names, refs (okRef/OWNER_NAME —
    // no quotes or angle brackets possible), shas and numbers —
    // JSON.stringify of them cannot contain a </script> breaker.
    // The vendored xlogin widget loads first (script-src 'self'); when it is
    // present the auth area offers its button beside the local
    // username/password fallback, and writes go through
    // window.xlogin.authFetch (NIP-98 or DPoP — both verified server-side
    // by getAgent). All DOM writes stay textContent/createElement.
    return `<script src="${prefix}/xlogin.js"></script>
<script type="module">
const CFG=${JSON.stringify(cfg)};
const T=()=>localStorage.getItem('forgeToken');
const U=()=>localStorage.getItem('forgeUser');
const X=()=>(window.xlogin&&window.xlogin.type&&window.xlogin.id)?window.xlogin:null;
function el(tag,props){const e=document.createElement(tag);Object.assign(e,props||{});
  for(let i=2;i<arguments.length;i++)e.append(arguments[i]);return e}
function setMsg(text){const m=document.getElementById('form-msg');if(m)m.textContent=text}
function shortId(id){return id.length>28?id.slice(0,16)+'…'+id.slice(-6):id}
function wireForms(){for(const id of ['submit-issue','submit-comment','toggle-state','submit-pull','do-merge','do-enable','submit-txo']){
  const b=document.getElementById(id);if(b)b.disabled=!(T()||X())}}
function renderAuth(){
  const box=document.getElementById('forge-auth');if(!box)return;
  box.textContent='';
  const x=X();
  if(x){
    box.append('Signed in via xlogin ('+x.type+') as ',el('b',{},shortId(String(x.id))),' ',
      el('button',{className:'btn',type:'button',onclick:function(){window.xlogin.logout()}},'Sign out'));
    return;
  }
  if(T()){
    box.append('Signed in as ',el('b',{},U()||'?'),' ',
      el('button',{className:'btn',type:'button',onclick:function(){
        localStorage.removeItem('forgeToken');localStorage.removeItem('forgeUser');
        renderAuth();wireForms();}},'Sign out'));
    return;
  }
  if(window.xlogin){
    box.append(el('button',{className:'btn',type:'button',
      onclick:function(){window.xlogin.login()}},'Sign in with xlogin'),
      el('span',{className:'muted'},' (Nostr / Solid) or local account: '));
  }else{
    box.append('Sign in to participate: ');
  }
  const u=el('input',{placeholder:'username',autocomplete:'username'});
  const p=el('input',{type:'password',placeholder:'password',autocomplete:'current-password'});
  const msg=el('span',{className:'formmsg'});
  box.append(u,p,
    el('button',{className:'btn',type:'button',onclick:async function(){
      msg.textContent='';
      try{
        const res=await fetch('/idp/credentials',{method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({username:u.value,password:p.value})});
        const j=await res.json();
        if(!j.access_token)throw new Error(j.error||'sign-in failed');
        localStorage.setItem('forgeToken',j.access_token);
        localStorage.setItem('forgeUser',u.value);
        renderAuth();wireForms();
      }catch(e){msg.textContent=String(e&&e.message||e)}
    }},'Sign in'),msg);
}
async function call(path,body,method){
  const opts={method:method||'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body||{})};
  let res;
  if(X()){res=await window.xlogin.authFetch(CFG.api+path,opts)}
  else{opts.headers.authorization='Bearer '+T();res=await fetch(CFG.api+path,opts)}
  let j=null;try{j=await res.json()}catch(e){}
  if(!res.ok)throw new Error((j&&j.error)||('HTTP '+res.status));
  return j||{};
}
// A Solid/DPoP proof is bound to ONE request URI, so the SERVER cannot
// forward it to write the pod: the browser signs a FRESH proof per request
// and writes the body into its own pod, then hands the forge a pointer.
const Sol=()=>{const x=X();return (x&&x.type==='solid')?x:null};
async function podWrite(doc,filePrefix){
  const id=new URL(String(window.xlogin.id));
  const segs=id.pathname.split('/').filter(Boolean);
  const podPath=(segs.length>=2&&segs[0]!=='profile')?'/'+segs[0]+'/':'/';
  const resourcePath=podPath+'public/forge/'+CFG.owner+'--'+CFG.name+'/'+filePrefix+'-'+crypto.randomUUID()+'.jsonld';
  const res=await window.xlogin.authFetch(id.origin+resourcePath,
    {method:'PUT',headers:{'content-type':'application/ld+json'},body:JSON.stringify(doc)});
  if(!(res.ok||res.status===201||res.status===204))throw new Error('could not write to your pod: '+res.status);
  return resourcePath;
}
const si=document.getElementById('submit-issue');
if(si)si.onclick=async function(){
  setMsg('');
  try{
    const title=document.getElementById('f-title').value;
    const bodyText=document.getElementById('f-body').value;
    let payload={title:title,body:bodyText};
    if(Sol()){
      const doc={type:'ForgeIssue',repo:CFG.owner+'/'+CFG.name,title:title,body:bodyText,
        published:new Date().toISOString(),author:window.xlogin.id};
      payload={title:title,resourceUrl:await podWrite(doc,'issue')};
    }
    const r=await call('/issues',payload);
    location.href=CFG.base+'/issues/'+r.number;
  }catch(e){setMsg(String(e.message||e))}
};
const sp=document.getElementById('submit-pull');
if(sp)sp.onclick=async function(){
  setMsg('');
  try{
    const title=document.getElementById('f-title').value;
    const bodyText=document.getElementById('f-body').value;
    let payload={title:title,body:bodyText,base:CFG.prBase,head:CFG.prHead};
    if(Sol()){
      const doc={type:'ForgePullRequest',repo:CFG.owner+'/'+CFG.name,title:title,body:bodyText,
        base:CFG.prBase,head:CFG.prHead,published:new Date().toISOString(),author:window.xlogin.id};
      payload={title:title,base:CFG.prBase,head:CFG.prHead,resourceUrl:await podWrite(doc,'pull')};
    }
    const r=await call('/pulls',payload);
    location.href=CFG.base+'/pulls/'+r.number;
  }catch(e){setMsg(String(e.message||e))}
};
const sc=document.getElementById('submit-comment');
if(sc)sc.onclick=async function(){
  setMsg('');
  try{
    const bodyText=document.getElementById('f-body').value;
    let payload={body:bodyText};
    if(Sol()){
      const isPull=String(CFG.thread||'').indexOf('/pulls/')===0;
      const num=parseInt(String(CFG.thread||'').split('/').pop(),10);
      const doc={type:'ForgeComment',repo:CFG.owner+'/'+CFG.name,
        published:new Date().toISOString(),author:window.xlogin.id,body:bodyText};
      if(isPull)doc.pull=num;else doc.issue=num;
      payload={resourceUrl:await podWrite(doc,'comment')};
    }
    await call(CFG.thread+'/comments',payload);
    location.reload();
  }catch(e){setMsg(String(e.message||e))}
};
const ts=document.getElementById('toggle-state');
if(ts)ts.onclick=async function(){
  setMsg('');
  try{
    await call(CFG.thread+'/'+(CFG.state==='open'?'close':'reopen'),{});
    location.reload();
  }catch(e){setMsg(String(e.message||e))}
};
const mg=document.getElementById('do-merge');
if(mg)mg.onclick=async function(){
  setMsg('');
  try{
    await call(CFG.thread+'/merge',{expectedBase:CFG.expectedBase});
    location.reload();
  }catch(e){setMsg(String(e.message||e))}
};
const de=document.getElementById('do-enable');
if(de)de.onclick=async function(){
  setMsg('');
  try{
    await call('/marks/enable',{});
    location.reload();
  }catch(e){setMsg(String(e.message||e))}
};
const tx=document.getElementById('submit-txo');
if(tx)tx.onclick=async function(){
  setMsg('');
  try{
    await call('/marks/'+CFG.markIndex+'/txo',{
      txid:document.getElementById('f-txid').value.trim(),
      vout:parseInt(document.getElementById('f-vout').value,10),
      amount:parseInt(document.getElementById('f-amount').value,10)});
    location.reload();
  }catch(e){setMsg(String(e.message||e))}
};
document.addEventListener('xlogin',function(){renderAuth();wireForms()});
document.addEventListener('xlogout',function(){renderAuth();wireForms()});
if(window.xlogin&&window.xlogin.ready)window.xlogin.ready.then(function(){renderAuth();wireForms()});
renderAuth();wireForms();
</script>`;
  }

  const authBox = (verb) => `<div id="forge-auth" class="authbox">`
    + `<noscript>${verb} needs JavaScript and sign-in; without it this page is read-only.</noscript></div>`;

  async function issuesListPage(reply, owner, name, query) {
    const branch = await defaultBranch(repoDirOf(owner, name));
    const idx = loadIssueIndex(owner, name);
    const all = Object.values(idx.issues).sort((a, b) => b.number - a.number);
    const openCount = all.filter((i) => i.state === 'open').length;
    const closedCount = all.length - openCount;
    const state = query?.state === 'closed' ? 'closed' : 'open';
    const label = typeof query?.label === 'string' && query.label ? query.label.slice(0, 50) : null;
    const lq = label ? `&label=${encodeURIComponent(label)}` : '';
    const defs = Array.isArray(idx.labels) ? idx.labels : DEFAULT_LABELS;
    const pageNo = Math.max(1, Math.min(10000, parseInt(query?.page, 10) || 1));
    const filtered = all.filter((i) => i.state === state
      && (!label || (Array.isArray(i.labels) && i.labels.includes(label))));
    const slice = filtered.slice((pageNo - 1) * ISSUES_PER_PAGE, pageNo * ISSUES_PER_PAGE);
    const base = `${prefix}/${owner}/${name}`;
    const rows = slice.map((i) => {
      const n = i.thread.length - 1;
      return `<div class="row">${i.state === 'open' ? ICON_ISSUE_OPEN : ICON_ISSUE_CLOSED}
<div class="grow"><a class="ititle" href="${base}/issues/${i.number}">${esc(i.title)}</a> ${labelChips(resolveLabels(i.labels, defs))}
<div class="muted" style="font-size:12px">#${i.number} opened ${relTime(i.createdAt)} by <a href="${esc(authorHref(i.author))}">${esc(displayName(i.author))}</a></div></div>
${n ? `<span class="muted" style="font-size:12px">${n} comment${n === 1 ? '' : 's'}</span>` : ''}</div>`;
    }).join('\n');
    const filterTabs = `<div class="fstate">
<a class="${state === 'open' ? 'active' : ''}" href="${base}/issues?state=open${lq}">${ICON_ISSUE_OPEN} ${openCount} Open</a>
<a class="${state === 'closed' ? 'active' : ''}" href="${base}/issues?state=closed${lq}">${ICON_ISSUE_CLOSED} ${closedCount} Closed</a>
${label ? `<span class="muted">label: ${labelChips(resolveLabels([label], defs))} <a href="${base}/issues?state=${state}">&times; clear</a></span>` : ''}
</div>`;
    const pager = `<div class="pager">
${pageNo > 1 ? `<a class="btn" href="${base}/issues?state=${state}${lq}&page=${pageNo - 1}">&larr; Newer</a>` : ''}
${filtered.length > pageNo * ISSUES_PER_PAGE ? `<a class="btn" href="${base}/issues?state=${state}${lq}&page=${pageNo + 1}">Older &rarr;</a>` : ''}
</div>`;
    const body = `${repoStrip(owner, name, 'issues', branch)}<main><div class="container">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
<h1 class="page" style="margin:0">Issues</h1>
<a class="btn btn-primary" href="${base}/issues/new">New issue</a>
</div>
<div class="list">${filterTabs}${rows || `<div class="row muted">No ${state} issues.</div>`}</div>
${pager}
</div></main>`;
    return sendHtml(reply, 200, page(`Issues · ${owner}/${name}`, body));
  }

  /** The comment boxes of a thread — issues and pulls render identically. */
  function threadBoxes(entries, ctx, owner, openVerb) {
    return entries.map((e, i) => {
      const who = displayName(e.author);
      const ownerBadge = ownerFromAgent(e.author) === owner ? ' <span class="badge">owner</span>' : '';
      // Podless authors: their words live in pluginDir, not a pod — say so.
      const hostedTag = e.hosted ? ' <span class="badge">hosted by the forge</span>' : '';
      const head = `${identicon(who)} <a href="${esc(authorHref(e.author))}"><b>${esc(who)}</b></a>${ownerBadge}${hostedTag}
<span class="muted">${i === 0 ? openVerb : 'commented'} ${relTime(e.at)}</span>`;
      const slot = e.removed
        ? '<div class="removed">content removed by its author</div>'
        : `<div class="markdown-body">${renderMarkdown(e.body, ctx)}</div>`;
      return `<div class="cbox"><div class="chead">${head}</div>${slot}</div>`;
    }).join('\n');
  }

  async function issueThreadPage(reply, owner, name, number) {
    const idx = loadIssueIndex(owner, name);
    const issue = idx.issues[number];
    if (!issue) return notFound(reply);
    const branch = await defaultBranch(repoDirOf(owner, name));
    const entries = await resolveThread(issue.thread);
    const ctx = issueMdCtx(owner, name);
    const base = `${prefix}/${owner}/${name}`;
    const boxes = threadBoxes(entries, ctx, owner, 'opened this issue');
    const open = issue.state === 'open';
    const nComments = issue.thread.length - 1;
    const body = `${repoStrip(owner, name, 'issues', branch)}<main><div class="container">
<h1 class="page" style="margin-bottom:8px">${esc(issue.title)} <span class="muted" style="font-weight:400">#${issue.number}</span></h1>
<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
<span class="state-pill ${open ? 'state-open' : 'state-closed'}">${open ? 'Open' : 'Closed'}</span>
${labelChips(resolveLabels(issue.labels, Array.isArray(idx.labels) ? idx.labels : DEFAULT_LABELS))}
<span class="muted"><b>${esc(displayName(issue.author))}</b> opened this issue ${relTime(issue.createdAt)} &middot; ${nComments} comment${nComments === 1 ? '' : 's'}</span>
</div>
${boxes}
${authBox('Commenting, closing, or reopening')}
<div class="cbox issueform"><div class="chead"><b>Add a comment</b> <span class="muted">(stored in YOUR pod, markdown supported)</span></div>
<div style="padding:16px">
<textarea id="f-body" placeholder="Leave a comment"></textarea>
<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px">
<span id="form-msg" class="formmsg"></span>
<button id="toggle-state" class="btn" type="button" disabled>${open ? 'Close issue' : 'Reopen issue'}</button>
<button id="submit-comment" class="btn btn-primary" type="button" disabled>Comment</button>
</div></div></div>
</div></main>
${issuesScript({ api: `${prefix}/api/repos/${owner}/${name}`, owner, name, base, thread: `/issues/${issue.number}`, state: issue.state })}`;
    return sendHtml(reply, 200, page(`${issue.title} · #${issue.number} · ${owner}/${name}`, body));
  }

  async function newIssuePage(reply, owner, name) {
    const branch = await defaultBranch(repoDirOf(owner, name));
    const base = `${prefix}/${owner}/${name}`;
    const body = `${repoStrip(owner, name, 'issues', branch)}<main><div class="container">
<h1 class="page">New issue</h1>
${authBox('Opening an issue')}
<div class="cbox issueform"><div class="chead"><b>Describe the issue</b> <span class="muted">(the body is stored in YOUR pod, markdown supported)</span></div>
<div style="padding:16px">
<input type="text" id="f-title" placeholder="Title">
<textarea id="f-body" placeholder="Steps, expectations, versions&hellip;"></textarea>
<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px">
<span id="form-msg" class="formmsg"></span>
<button id="submit-issue" class="btn btn-primary" type="button" disabled>Submit new issue</button>
</div></div></div>
</div></main>
${issuesScript({ api: `${prefix}/api/repos/${owner}/${name}`, owner, name, base, thread: null, state: null })}`;
    return sendHtml(reply, 200, page(`New issue · ${owner}/${name}`, body));
  }

  // -------------------------------------------- compare + pulls pages (3a)

  const PR_STATE = {
    open: { icon: ICON_PR_OPEN, pill: 'state-open', label: 'Open' },
    merged: { icon: ICON_PR_MERGED, pill: 'state-merged', label: 'Merged' },
    closed: { icon: ICON_PR_CLOSED, pill: 'state-closed-red', label: 'Closed' },
  };

  function commitRows(owner, name, commits) {
    const base = `${prefix}/${owner}/${name}`;
    return commits.map((c) => `<div class="row">${identicon(c.email)}
<div class="grow"><div><a href="${base}/commit/${c.sha}" style="color:#1f2328;font-weight:600">${esc(c.subject)}</a></div>
<div class="muted" style="font-size:12px"><b>${esc(c.author)}</b> committed ${relTime(c.at)}</div></div>
<a class="sha" href="${base}/commit/${c.sha}">${esc(c.short)}</a></div>`).join('\n');
  }

  async function comparePage(reply, owner, name, spec) {
    const dots = spec.indexOf('...');
    if (dots < 1) return notFound(reply);
    const baseRef = spec.slice(0, dots);
    const headSpec = spec.slice(dots + 3);
    const cmp = await compareData(owner, name, baseRef, headSpec);
    if (!cmp) return notFound(reply);
    const branch = await defaultBranch(repoDirOf(owner, name));
    const base = `${prefix}/${owner}/${name}`;
    const headLabel = `${dispOwner(cmp.head.owner)}:${cmp.head.ref}`;
    const prHref = `${base}/pulls/new?base=${encodeURIComponent(baseRef)}&head=${encodeURIComponent(headSpec)}`;
    const n = cmp.commits.length;
    const body = `${repoStrip(owner, name, 'pulls', branch)}<main><div class="container">
<h1 class="page">Comparing <span class="mono">${esc(baseRef)}...${esc(headLabel)}</span></h1>
<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
<span class="aheadbehind">${cmp.aheadBy} ahead, ${cmp.behindBy} behind ${esc(baseRef)}</span>
${cmp.aheadBy ? `<a class="btn btn-primary" href="${prHref}">Open pull request</a>` : '<span class="muted">Nothing to compare: the base contains the head.</span>'}
</div>
<h3>${n}${cmp.hasMore ? '+' : ''} commit${n === 1 ? '' : 's'}</h3>
<div class="list" style="margin-bottom:20px">${commitRows(owner, name, cmp.commits) || '<div class="row muted">No commits.</div>'}</div>
${renderDiff(cmp.files)}
</div></main>`;
    return sendHtml(reply, 200, page(`Comparing ${baseRef}...${headLabel} · ${owner}/${name}`, body));
  }

  async function pullsListPage(reply, owner, name, query) {
    const branch = await defaultBranch(repoDirOf(owner, name));
    const idx = loadPullIndex(owner, name);
    const all = Object.values(idx.pulls).sort((a, b) => b.number - a.number);
    const count = (s) => all.filter((p) => p.state === s).length;
    const state = ['merged', 'closed'].includes(query?.state) ? query.state : 'open';
    const label = typeof query?.label === 'string' && query.label ? query.label.slice(0, 50) : null;
    const lq = label ? `&label=${encodeURIComponent(label)}` : '';
    const defs = labelDefs(owner, name); // the label SET lives with the issues index
    const pageNo = Math.max(1, Math.min(10000, parseInt(query?.page, 10) || 1));
    const filtered = all.filter((p) => p.state === state
      && (!label || (Array.isArray(p.labels) && p.labels.includes(label))));
    const slice = filtered.slice((pageNo - 1) * ISSUES_PER_PAGE, pageNo * ISSUES_PER_PAGE);
    const base = `${prefix}/${owner}/${name}`;
    const rows = slice.map((p) => {
      const nc = p.thread.length - 1;
      return `<div class="row">${PR_STATE[p.state].icon}
<div class="grow"><a class="ititle" href="${base}/pulls/${p.number}">${esc(p.title)}</a> ${labelChips(resolveLabels(p.labels, defs))}
<div class="muted" style="font-size:12px">#${p.number} opened ${relTime(p.createdAt)} by <a href="${esc(authorHref(p.author))}">${esc(displayName(p.author))}</a>
&middot; <span class="mono">${esc(dispOwner(p.head.owner))}:${esc(p.head.ref)} &rarr; ${esc(p.base)}</span></div></div>
${nc ? `<span class="muted" style="font-size:12px">${nc} comment${nc === 1 ? '' : 's'}</span>` : ''}</div>`;
    }).join('\n');
    const filterTabs = `<div class="fstate">
<a class="${state === 'open' ? 'active' : ''}" href="${base}/pulls?state=open${lq}">${ICON_PR_OPEN} ${count('open')} Open</a>
<a class="${state === 'merged' ? 'active' : ''}" href="${base}/pulls?state=merged${lq}">${ICON_PR_MERGED} ${count('merged')} Merged</a>
<a class="${state === 'closed' ? 'active' : ''}" href="${base}/pulls?state=closed${lq}">${ICON_PR_CLOSED} ${count('closed')} Closed</a>
${label ? `<span class="muted">label: ${labelChips(resolveLabels([label], defs))} <a href="${base}/pulls?state=${state}">&times; clear</a></span>` : ''}
</div>`;
    const pager = `<div class="pager">
${pageNo > 1 ? `<a class="btn" href="${base}/pulls?state=${state}${lq}&page=${pageNo - 1}">&larr; Newer</a>` : ''}
${filtered.length > pageNo * ISSUES_PER_PAGE ? `<a class="btn" href="${base}/pulls?state=${state}${lq}&page=${pageNo + 1}">Older &rarr;</a>` : ''}
</div>`;
    const body = `${repoStrip(owner, name, 'pulls', branch)}<main><div class="container">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
<h1 class="page" style="margin:0">Pull requests</h1>
</div>
<div class="list">${filterTabs}${rows || `<div class="row muted">No ${state} pull requests.</div>`}</div>
${pager}
</div></main>`;
    return sendHtml(reply, 200, page(`Pull requests · ${owner}/${name}`, body));
  }

  function pullSubTabs(base, number, active) {
    const tabs = [
      ['conversation', 'Conversation', `${base}/pulls/${number}`],
      ['commits', 'Commits', `${base}/pulls/${number}/commits`],
      ['files', 'Files changed', `${base}/pulls/${number}/files`],
    ].map(([id, label, href]) => `<a class="${active === id ? 'active' : ''}" href="${href}">${label}</a>`).join('\n');
    return `<div class="fstate" style="border:1px solid #d0d7de;border-radius:8px;margin-bottom:16px">${tabs}</div>`;
  }

  function pullHeadline(pr, owner, name) {
    const st = PR_STATE[pr.state];
    const who = pr.state === 'merged' ? displayName(pr.merged?.mergedBy ?? pr.author) : displayName(pr.author);
    const verb = pr.state === 'merged'
      ? `merged ${(pr.merged?.headSha ?? '').slice(0, 7) ? `<span class="sha">${esc(pr.merged.headSha.slice(0, 7))}</span> ` : ''}into <b>${esc(pr.base)}</b> ${relTime(pr.merged?.at ?? pr.createdAt)}`
      : `wants to merge <span class="mono">${esc(dispOwner(pr.head.owner))}:${esc(pr.head.ref)}</span> into <b>${esc(pr.base)}</b>`;
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
<span class="state-pill ${st.pill}">${st.label}</span>
${labelChips(resolveLabels(pr.labels, labelDefs(owner, name)))}
<span class="muted"><b>${esc(who)}</b> ${verb}</span>
</div>`;
  }

  async function pullPage(reply, owner, name, number) {
    const pr = loadPullIndex(owner, name).pulls[number];
    if (!pr) return notFound(reply);
    const branch = await defaultBranch(repoDirOf(owner, name));
    const entries = await resolveThread(pr.thread);
    const ctx = issueMdCtx(owner, name);
    const base = `${prefix}/${owner}/${name}`;
    const boxes = threadBoxes(entries, ctx, owner, 'opened this pull request');
    const open = pr.state === 'open';
    const info = open ? await pullMergeInfo(owner, name, pr) : null;

    // The state banner: merged (purple), closed (red), open with a clean /
    // conflicting / unavailable merge verdict (GitHub's beats).
    let mergeBox = '';
    if (pr.state === 'merged') {
      mergeBox = `<div class="mergebox"><h3>${ICON_PR_MERGED} Merged</h3>
<div class="muted">merge commit <span class="sha">${esc((pr.merged?.sha ?? '').slice(0, 12))}</span> by <b>${esc(displayName(pr.merged?.mergedBy ?? ''))}</b> ${relTime(pr.merged?.at ?? pr.createdAt)}${pr.merged?.fastForward ? ' (fast-forward)' : ''}</div></div>`;
    } else if (pr.state === 'closed') {
      mergeBox = `<div class="mergebox"><h3>${ICON_PR_CLOSED} Closed</h3>
<div class="muted">This pull request was closed without merging.</div></div>`;
    } else if (info.mergeable === true) {
      mergeBox = `<div class="mergebox clean"><h3 class="clean-note">This branch has no conflicts with the base branch</h3>
<div class="muted" style="margin-bottom:8px">${info.fastForward ? 'Fast-forward merge (no merge commit needed).' : 'A merge commit will join the histories.'}</div>
<button id="do-merge" class="btn btn-primary" type="button" disabled>Merge pull request</button></div>`;
    } else if (info.mergeable === false && info.upToDate) {
      mergeBox = `<div class="mergebox"><h3>Nothing to merge</h3>
<div class="muted">The base branch already contains every commit of this branch.</div></div>`;
    } else if (info.mergeable === false) {
      mergeBox = `<div class="mergebox conflict"><h3 class="conflict-note">This branch has conflicts that must be resolved</h3>
<div class="muted">Conflicting file${info.conflicts.length === 1 ? '' : 's'}:</div>
<ul>${info.conflicts.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul></div>`;
    } else {
      mergeBox = `<div class="mergebox"><h3>Merge status unknown</h3>
<div class="muted">${mergeTreeOk ? 'The head branch (or the base branch) is no longer available.' : `This server's ${esc(gitVersion)} lacks merge-tree --write-tree (needs git &ge; 2.38).`}</div></div>`;
    }

    const nComments = pr.thread.length - 1;
    const body = `${repoStrip(owner, name, 'pulls', branch)}<main><div class="container">
<h1 class="page" style="margin-bottom:8px">${esc(pr.title)} <span class="muted" style="font-weight:400">#${pr.number}</span></h1>
${pullHeadline(pr, owner, name)}
${pullSubTabs(base, pr.number, 'conversation')}
${boxes}
${mergeBox}
${authBox('Commenting, merging, closing, or reopening')}
<div class="cbox issueform"><div class="chead"><b>Add a comment</b> <span class="muted">(stored in YOUR pod, markdown supported)</span></div>
<div style="padding:16px">
<textarea id="f-body" placeholder="Leave a comment"></textarea>
<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px">
<span id="form-msg" class="formmsg"></span>
${pr.state !== 'merged' ? `<button id="toggle-state" class="btn" type="button" disabled>${open ? 'Close pull request' : 'Reopen pull request'}</button>` : ''}
<button id="submit-comment" class="btn btn-primary" type="button" disabled>Comment</button>
</div></div></div>
</div></main>
${issuesScript({ api: `${prefix}/api/repos/${owner}/${name}`, owner, name, base, thread: `/pulls/${pr.number}`, state: pr.state, expectedBase: info?.baseSha ?? null })}`;
    return sendHtml(reply, 200, page(`${pr.title} · #${pr.number} · ${owner}/${name}`, body));
  }

  async function pullCommitsPage(reply, owner, name, number) {
    const pr = loadPullIndex(owner, name).pulls[number];
    if (!pr) return notFound(reply);
    const branch = await defaultBranch(repoDirOf(owner, name));
    const { commits, hasMore } = await pullDiffData(owner, name, pr);
    const base = `${prefix}/${owner}/${name}`;
    const body = `${repoStrip(owner, name, 'pulls', branch)}<main><div class="container">
<h1 class="page" style="margin-bottom:8px">${esc(pr.title)} <span class="muted" style="font-weight:400">#${pr.number}</span></h1>
${pullHeadline(pr, owner, name)}
${pullSubTabs(base, pr.number, 'commits')}
<div class="list">${commitRows(owner, name, commits) || '<div class="row muted">No commits.</div>'}</div>
${hasMore ? '<p class="muted">Only the first 30 commits are shown.</p>' : ''}
</div></main>`;
    return sendHtml(reply, 200, page(`Commits · #${pr.number} · ${owner}/${name}`, body));
  }

  async function pullFilesPage(reply, owner, name, number) {
    const pr = loadPullIndex(owner, name).pulls[number];
    if (!pr) return notFound(reply);
    const branch = await defaultBranch(repoDirOf(owner, name));
    const { files } = await pullDiffData(owner, name, pr);
    const base = `${prefix}/${owner}/${name}`;
    const body = `${repoStrip(owner, name, 'pulls', branch)}<main><div class="container">
<h1 class="page" style="margin-bottom:8px">${esc(pr.title)} <span class="muted" style="font-weight:400">#${pr.number}</span></h1>
${pullHeadline(pr, owner, name)}
${pullSubTabs(base, pr.number, 'files')}
${renderDiff(files)}
</div></main>`;
    return sendHtml(reply, 200, page(`Files changed · #${pr.number} · ${owner}/${name}`, body));
  }

  async function newPullPage(reply, owner, name, query) {
    const baseRef = typeof query?.base === 'string' ? query.base : '';
    const headSpec = typeof query?.head === 'string' ? query.head : '';
    const cmp = await compareData(owner, name, baseRef, headSpec);
    if (!cmp) return notFound(reply);
    const branch = await defaultBranch(repoDirOf(owner, name));
    const base = `${prefix}/${owner}/${name}`;
    const headLabel = `${dispOwner(cmp.head.owner)}:${cmp.head.ref}`;
    const body = `${repoStrip(owner, name, 'pulls', branch)}<main><div class="container">
<h1 class="page">Open a pull request</h1>
<p class="muted"><span class="mono">${esc(headLabel)}</span> &rarr; <b>${esc(baseRef)}</b>
&middot; <span class="aheadbehind">${cmp.aheadBy} commit${cmp.aheadBy === 1 ? '' : 's'} ahead</span>
&middot; <a href="${base}/compare/${esc(baseRef)}...${esc(headSpec)}">view the full comparison</a></p>
${authBox('Opening a pull request')}
<div class="cbox issueform"><div class="chead"><b>Describe the change</b> <span class="muted">(the body is stored in YOUR pod, markdown supported)</span></div>
<div style="padding:16px">
<input type="text" id="f-title" placeholder="Title">
<textarea id="f-body" placeholder="What does this change, and why?"></textarea>
<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px">
<span id="form-msg" class="formmsg"></span>
<button id="submit-pull" class="btn btn-primary" type="button" disabled>Create pull request</button>
</div></div></div>
</div></main>
${issuesScript({ api: `${prefix}/api/repos/${owner}/${name}`, owner, name, base, thread: null, state: null, prBase: baseRef, prHead: headSpec })}`;
    return sendHtml(reply, 200, page(`New pull request · ${owner}/${name}`, body));
  }

  // ------------------------------------- search + releases pages (polish)

  async function searchPage(reply, owner, name, query) {
    const q = typeof query?.q === 'string' ? query.q.trim().slice(0, SEARCH_QUERY_CAP) : '';
    const branch = await defaultBranch(repoDirOf(owner, name));
    const base = `${prefix}/${owner}/${name}`;
    const form = `<form class="searchform" method="get" action="${base}/search">
<input type="search" name="q" value="${esc(q)}" placeholder="Search this repository&hellip;" aria-label="Search this repository">
<button class="btn" type="submit">Search</button></form>`;
    let results;
    if (!q) {
      results = `<p class="muted">Greps the default branch (<b>${esc(branch)}</b>) for a literal, case-insensitive substring — bounded, no index.</p>`;
    } else {
      const data = await searchData(owner, name, q);
      const matchRows = data.matches.map((m) => `<div class="row">${ICON_FILE}
<div class="grow"><a class="mono" style="font-size:12px" href="${base}/blob/${branch}/${esc(m.path)}#L${m.line}">${esc(m.path)}:${m.line}</a>
<div class="excerpt">${esc(m.text)}</div></div></div>`).join('\n');
      const pathRows = data.paths.map((p) => `<div class="row">${ICON_FILE}
<div class="grow"><a href="${base}/blob/${branch}/${esc(p)}">${esc(p)}</a></div></div>`).join('\n');
      results = (data.matches.length || data.paths.length)
        ? `${data.matches.length ? `<h3>${data.matches.length}${data.truncated ? '+' : ''} code match${data.matches.length === 1 ? '' : 'es'}</h3><div class="list">${matchRows}</div>` : ''}
${data.paths.length ? `<h3>${data.paths.length} matching file path${data.paths.length === 1 ? '' : 's'}</h3><div class="list">${pathRows}</div>` : ''}
${data.truncated ? `<p class="muted">Results are capped (${SEARCH_HIT_CAP} code matches, ${SEARCH_PATH_CAP} paths); narrow the query for the rest.</p>` : ''}`
        : `<div class="empty"><h3>No results</h3><p class="muted">Nothing on <b>${esc(branch)}</b> matches <code>${esc(q)}</code>.</p></div>`;
    }
    const body = `${repoStrip(owner, name, 'code', branch)}<main><div class="container">
<h1 class="page">Search</h1>
${form}
<div style="margin-top:16px">${results}</div>
</div></main>`;
    return sendHtml(reply, 200, page(`Search · ${owner}/${name}`, body));
  }

  async function releasesPage(reply, owner, name) {
    const branch = await defaultBranch(repoDirOf(owner, name));
    const rels = await listReleases(owner, name);
    const base = `${prefix}/${owner}/${name}`;
    const cards = rels.map((r) => `<div class="repocard">
<h3>${ICON_TAG} <a href="${base}/tree/${esc(r.tag)}">${esc(r.tag)}</a>${r.annotated ? '' : ' <span class="badge">lightweight</span>'}</h3>
${r.message ? `<div>${esc(r.message)}</div>` : ''}
<div class="muted" style="font-size:12px;margin-top:4px"><a class="sha" href="${base}/commit/${esc(r.sha)}">${esc(r.sha.slice(0, 7))}</a> &middot; ${relTime(r.at)}</div>
<div style="margin-top:8px"><a class="btn" href="${base}/archive/${esc(r.tag)}.tar.gz">tar.gz</a>
<a class="btn" href="${base}/archive/${esc(r.tag)}.zip">zip</a></div>
</div>`).join('\n');
    const body = `${repoStrip(owner, name, 'tags', branch)}<main><div class="container">
<h1 class="page">Releases <span class="muted" style="font-size:14px;font-weight:400">every tag, newest first</span></h1>
${cards || '<div class="empty"><h3>No releases yet</h3><p class="muted">Push a tag and it appears here with tarball and zip downloads.</p></div>'}
</div></main>`;
    return sendHtml(reply, 200, page(`Releases · ${owner}/${name}`, body));
  }

  /**
   * GET .../archive/<ref>.tar.gz|.zip — `git archive` STREAMED to the
   * response (child stdout, no buffering), --prefix=<repo>-<flatref>/.
   * The ref is validated and resolved BEFORE any header goes out, so a
   * bogus ref is a clean 404.
   */
  async function archiveResp(reply, owner, name, tail) {
    const spec = tail.join('/');
    let format = null;
    let ext = null;
    if (spec.endsWith('.tar.gz')) { format = 'tar.gz'; ext = '.tar.gz'; }
    else if (spec.endsWith('.zip')) { format = 'zip'; ext = '.zip'; }
    if (!format) return notFound(reply);
    const ref = spec.slice(0, -ext.length);
    if (!okRef(ref) && !SHA_RE.test(ref)) return notFound(reply);
    const dir = repoDirOf(owner, name);
    if (!(await revParse(dir, `${ref}^{commit}`))) return notFound(reply);
    const flat = ref.replace(/\//g, '-'); // feature/x -> feature-x (validated charset: header-safe)
    const child = spawn('git', ['-C', dir, 'archive', `--format=${format}`, `--prefix=${name}-${flat}/`, ref],
      { env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code !== 0) api.log.warn(`forge: git archive ${owner}/${name} ${ref} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
    });
    reply.raw.on('close', () => {
      if (child.exitCode === null && !reply.raw.writableFinished) child.kill();
    });
    return reply.code(200)
      .header('content-type', format === 'zip' ? 'application/zip' : 'application/gzip')
      .header('content-disposition', `attachment; filename="${name}-${flat}${ext}"`)
      .header('x-content-type-options', 'nosniff')
      .send(child.stdout);
  }

  // ------------------------------------------------- marks page (3.5)

  /** Human chain badge: tbtc4 -> "testnet4", plus an honest testnet tag. */
  function chainBadge(c) {
    const label = c === 'tbtc4' ? 'testnet4' : c === 'tbtc3' ? 'testnet3' : c;
    return `<span class="badge">${esc(label)}</span>${MAINNET_CHAINS.has(c) ? '' : ' <span class="muted" style="font-size:12px">(testnet — demonstrations, not value)</span>'}`;
  }

  async function marksPage(reply, owner, name) {
    const branch = await defaultBranch(repoDirOf(owner, name));
    const base = `${prefix}/${owner}/${name}`;
    const trail = loadTrail(owner, name);

    if (!trail) {
      // Not enabled: the Enable pitch. The button is the house client-JS
      // beat (sign in, authFetch POST, reload); the API enforces owner.
      const body = `${repoStrip(owner, name, 'anchors', branch)}<main><div class="container">
<h1 class="page">Anchors ${chainBadge(chain)}</h1>
<div class="empty"><h3>Anchoring is not enabled</h3>
<p class="muted">Anchor this repository's history to Bitcoin (${esc(chain)}) via
<a href="https://blocktrails.org">Blocktrails</a>: each default-branch tip derives a fresh taproot
address by BIP-341 TapTweak; spending the previous mark's output to the new address advances a
tamper-evident, Bitcoin-ordered trail. The forge only <b>derives and records</b> — funding,
spending and verification all happen off-server.</p>
<p class="muted">Enabling mints a forge-held trail key (${esc(chain)} custody — see the README)
and derives mark&nbsp;0 from the current <b>${esc(branch)}</b> tip.</p>
${authBox('Enabling anchoring')}
<div style="display:flex;align-items:center;gap:8px">
<button id="do-enable" class="btn btn-primary" type="button" disabled>Enable anchoring</button>
<span id="form-msg" class="formmsg"></span>
</div>
</div>
</div></main>
${issuesScript({ api: `${prefix}/api/repos/${owner}/${name}`, owner, name, base, thread: null, state: null })}`;
      return sendHtml(reply, 200, page(`Anchors · ${owner}/${name}`, body));
    }

    const explorerTx = (txid) => (mempoolBase
      ? `<a class="sha" href="${esc(`${mempoolBase}/tx/${txid}`)}">${esc(txid.slice(0, 10))}…</a>`
      : `<span class="sha">${esc(txid.slice(0, 10))}…</span>`);
    const rows = trail.marks.map((m) => `<tr>
<td>#${m.index}</td>
<td><a class="sha" href="${base}/commit/${esc(m.state.commit)}">${esc(m.state.commit.slice(0, 7))}</a>
<div class="muted" style="font-size:11px">${esc(m.state.branch)}</div></td>
<td><code>${esc(m.stateHash.slice(0, 12))}…</code></td>
<td><code>${esc(m.address)}</code>
<button class="btn" style="padding:1px 8px;font-size:11px" type="button"
 onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy</button></td>
<td><span class="chip chip-${m.status === 'marked' ? 'marked' : 'pending'}">${m.status === 'marked' ? 'marked' : 'pending'}</span></td>
<td>${m.status === 'marked' ? explorerTx(m.txid) : '<span class="muted">—</span>'}</td>
</tr>`).join('\n');

    const trailUrl = `${publicOrigin()}${base}/blocktrails.json`;
    const verifyHref = `https://blocktrails.github.io/verify/?uri=${encodeURIComponent(trailUrl)}`;
    // The next mark to land on-chain: first pending (marks are recorded
    // in order — the trail is a linear spend chain).
    const firstPending = trail.marks.find((m) => m.status !== 'marked') ?? null;
    const latest = trail.marks.at(-1);
    const fundBox = latest && latest.status !== 'marked' ? `<div class="fundbox">
<h3 style="margin:0 0 4px">Fund this mark <span class="chip chip-pending">pending</span></h3>
<p class="muted" style="margin:4px 0 8px">Mark #${firstPending.index} is waiting for its on-chain output. Send ${esc(chain)}
sats to the derived address${firstPending.index > 0 ? ' — by <b>spending the previous mark’s output</b>, which IS the advance' : ' (the genesis funding)'} — the forge never broadcasts anything itself.</p>
<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
<code>${esc(firstPending.address)}</code>
<button class="btn" style="padding:1px 8px;font-size:11px" type="button"
 onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy</button>
</div>
<pre># on YOUR machine — funding and spending happen off-server
# 1. redeem a TXO voucher into git config nostr.privkey (maintainer's fund-agent):
npx fund-agent "txo:${esc(chain)}:&lt;txid&gt;:&lt;vout&gt;?amount=&lt;sats&gt;&amp;key=&lt;privkey&gt;"
# 2. send/spend to the address above (any ${esc(chain)} wallet, or the git-mark CLI, npm: git-seal):
git mark ${firstPending.index === 0 ? 'genesis' : 'advance'} --txid &lt;txid&gt; --vout &lt;n&gt; --amount &lt;sats&gt;
# 3. report where it landed (repo owner), and the mark turns green:
#    POST ${esc(`${prefix}/api/repos/${owner}/${name}/marks/${firstPending.index}/txo`)}  {"txid":"…","vout":0,"amount":…}</pre>
${authBox('Recording a transaction')}
<div class="issueform" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
<input type="text" id="f-txid" placeholder="txid (64 hex)" style="flex:2;min-width:280px;margin-bottom:0">
<input type="text" id="f-vout" placeholder="vout" style="width:80px;margin-bottom:0">
<input type="text" id="f-amount" placeholder="amount (sats)" style="width:140px;margin-bottom:0">
<button id="submit-txo" class="btn btn-primary" type="button" disabled>Record</button>
<span id="form-msg" class="formmsg"></span>
</div>
</div>` : '';

    const body = `${repoStrip(owner, name, 'anchors', branch)}<main><div class="container">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
<h1 class="page" style="margin:0">Anchors ${chainBadge(trail.chain)}</h1>
<div style="display:flex;gap:8px">
<a class="btn" href="${base}/blocktrails.json">blocktrails.json</a>
<a class="btn btn-primary" href="${esc(verifyHref)}">Verify independently</a>
</div>
</div>
<p class="muted" style="margin:4px 0 16px">Trail key <code>${esc(trail.pubkeyBase.slice(0, 10))}…</code> (forge-held, ${esc(trail.chain)}) &middot;
${trail.marks.length} mark${trail.marks.length === 1 ? '' : 's'} &middot; the server derives and records; verification runs
<b>client-side</b> in the hosted verifier against the chain.</p>
<div class="box"><table class="marks">
<tr><th>mark</th><th>commit</th><th>state hash</th><th>derived address</th><th>status</th><th>tx</th></tr>
${rows}
</table></div>
${fundBox}
</div></main>
${issuesScript({ api: `${prefix}/api/repos/${owner}/${name}`, owner, name, base, thread: null, state: null, markIndex: firstPending ? firstPending.index : null })}`;
    return sendHtml(reply, 200, page(`Anchors · ${owner}/${name}`, body));
  }

  function notFound(reply) {
    return sendHtml(reply, 404, page('Not found · Forge',
      '<main><div class="container"><h1 class="page">404</h1><p class="muted">This is not the repository you are looking for.</p></div></main>'));
  }

  // --------------------------------------------------------------- JSON API
  // The same model, machine-readable, under <prefix>/api — the Gitea-parity
  // surface. Strings are RAW (JSON is the escape); the one exception is
  // readme.html, which is the server-side renderer's already-escaped HTML.
  // Shapes are documented in README.md and exercised by test.js.

  function sendJson(reply, status, obj) {
    return reply.code(status)
      .header('content-type', 'application/json; charset=utf-8')
      .header('x-content-type-options', 'nosniff')
      .send(JSON.stringify(obj));
  }
  const apiErr = (reply, status, error) => sendJson(reply, status, { error });

  // CORS for the web-edit lane: the demo edit page runs on another origin and
  // must be able to read the JSON reply (success AND error). Same permissive
  // grant as blocktrails.json — the edit endpoint is auth-gated (or explicitly
  // openEdit), so the CORS header widens reach, not authority. The matching
  // OPTIONS preflight is answered generically in the routing scope.
  const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
  };
  function withCors(reply) {
    for (const [k, v] of Object.entries(CORS_HEADERS)) reply.header(k, v);
    return reply;
  }
  const corsJson = (reply, status, obj) => sendJson(withCors(reply), status, obj);
  const corsErr = (reply, status, error) => corsJson(reply, status, { error });

  async function apiRepoList(reply, owners) {
    const repos = [];
    for (const owner of owners) {
      for (const name of listRepoNames(owner)) {
        if (repos.length >= 200) break;
        const s = await repoSummary(owner, name);
        repos.push({ ...s, cloneUrl: cloneUrlOf(owner, name), url: `${prefix}/${owner}/${name}` });
      }
    }
    repos.sort((a, b) => (b.lastPush ?? 0) - (a.lastPush ?? 0));
    return sendJson(reply, 200, { repos });
  }

  async function apiRepoMeta(reply, owner, name) {
    const dir = repoDirOf(owner, name);
    const summary = await repoSummary(owner, name);
    const branch = await defaultBranch(dir);
    const branches = await listRefs(dir, 'heads');
    const tags = await listRefs(dir, 'tags');
    let readme = null;
    if (branches.length) {
      try {
        const entries = await lsTree(dir, branch, '');
        const r = await findReadme(dir, branch, entries);
        if (r && !r.tooLarge) {
          const base = `${prefix}/${owner}/${name}`;
          readme = {
            name: r.name,
            html: r.markdown
              ? renderMarkdown(r.text, { rawBase: `${base}/raw/${branch}`, blobBase: `${base}/blob/${branch}` })
              : `<pre>${esc(r.text)}</pre>`,
          };
        }
      } catch { /* unreadable README is not an error */ }
    }
    return sendJson(reply, 200, {
      owner,
      name,
      description: summary.description,
      lastPush: summary.lastPush,
      parent: summary.parent, // additive (3a): "<owner>/<name>" | null
      forks: countForks(owner, name), // additive (3a)
      empty: branches.length === 0,
      defaultBranch: branch,
      branches,
      tags,
      cloneUrl: cloneUrlOf(owner, name),
      readme,
    });
  }

  async function apiTree(reply, owner, name, segs) {
    const dir = repoDirOf(owner, name);
    const [ref, rest] = await splitRefPath(dir, segs);
    if (!okRef(ref) || !okPath(rest)) return apiErr(reply, 404, 'not found');
    const dirPath = rest.join('/');
    let entries;
    try { entries = await lsTree(dir, ref, dirPath); } catch { return apiErr(reply, 404, 'not found'); }
    const enriched = await Promise.all(entries.map(async (e, i) => ({
      ...e,
      lastCommit: i < 100 ? await lastCommit(dir, ref, dirPath ? `${dirPath}/${e.name}` : e.name) : null,
    })));
    return sendJson(reply, 200, { ref, path: dirPath, entries: enriched });
  }

  async function apiBlob(reply, owner, name, segs) {
    const dir = repoDirOf(owner, name);
    const [ref, rest] = await splitRefPath(dir, segs);
    if (!okRef(ref) || !rest.length || !okPath(rest)) return apiErr(reply, 404, 'not found');
    const p = rest.join('/');
    if ((await objectType(dir, ref, p)) !== 'blob') return apiErr(reply, 404, 'not found');
    const size = await blobSize(dir, ref, p);
    const out = { ref, path: p, size, binary: false, tooLarge: false, content: null };
    if (size > RENDER_CAP) {
      out.tooLarge = true;
    } else {
      const buf = await catBlob(dir, ref, p);
      if (looksBinary(buf)) out.binary = true;
      else out.content = buf.toString('utf8');
    }
    return sendJson(reply, 200, out);
  }

  async function apiCommits(reply, owner, name, segs, query) {
    const dir = repoDirOf(owner, name);
    const ref = segs.join('/');
    if (!okRef(ref) && !SHA_RE.test(ref)) return apiErr(reply, 404, 'not found');
    const pageNo = Math.max(1, Math.min(10000, parseInt(query?.page, 10) || 1));
    try {
      const { commits, hasMore } = await commitLog(dir, ref, pageNo);
      return sendJson(reply, 200, { ref, page: pageNo, perPage: PER_PAGE, hasMore, commits });
    } catch { return apiErr(reply, 404, 'not found'); }
  }

  async function apiCommit(reply, owner, name, sha) {
    if (!SHA_RE.test(sha)) return apiErr(reply, 404, 'not found');
    const dir = repoDirOf(owner, name);
    const meta = await commitMeta(dir, sha);
    if (!meta) return apiErr(reply, 404, 'not found');
    const files = await commitDiff(dir, sha);
    return sendJson(reply, 200, {
      sha: meta.full,
      short: meta.short,
      author: meta.author,
      email: meta.email,
      at: meta.at,
      parents: meta.parents,
      message: meta.message,
      files,
    });
  }

  // ---- tier 2: issue endpoints (writes are Bearer-authed via getAgent) ----

  /**
   * requestAgent (forge push token OR any getAgent scheme) or a JSON 401.
   * Returns null after replying. Callers that may receive a body MUST
   * buffer it (readJsonBody) BEFORE calling this — see readJsonBody's
   * NIP-98 payload-tag note.
   */
  async function apiAgent(request, reply) {
    const agent = await requestAgent(request);
    if (!agent) {
      reply.header('WWW-Authenticate', 'Bearer realm="jss-forge"');
      await apiErr(reply, 401, 'authentication required');
      return null;
    }
    return agent;
  }

  function apiIssueList(reply, owner, name, query) {
    const idx = loadIssueIndex(owner, name);
    const all = Object.values(idx.issues).sort((a, b) => b.number - a.number);
    const openCount = all.filter((i) => i.state === 'open').length;
    const state = query?.state === 'closed' ? 'closed' : 'open';
    const label = typeof query?.label === 'string' && query.label ? query.label.slice(0, 50) : null;
    const defs = Array.isArray(idx.labels) ? idx.labels : DEFAULT_LABELS;
    const pageNo = Math.max(1, Math.min(10000, parseInt(query?.page, 10) || 1));
    const filtered = all.filter((i) => i.state === state
      && (!label || (Array.isArray(i.labels) && i.labels.includes(label))));
    return sendJson(reply, 200, {
      state,
      page: pageNo,
      perPage: ISSUES_PER_PAGE,
      hasMore: filtered.length > pageNo * ISSUES_PER_PAGE,
      openCount,
      closedCount: all.length - openCount,
      issues: filtered.slice((pageNo - 1) * ISSUES_PER_PAGE, pageNo * ISSUES_PER_PAGE).map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.author,
        authorInfo: authorMeta(i.author), // additive (2.5): {id, displayName, npub?, kind}
        createdAt: i.createdAt,
        labels: resolveLabels(i.labels, defs), // additive (polish): [{name, color}]
        comments: i.thread.length - 1,
      })),
    });
  }

  async function apiIssueGet(reply, owner, name, number) {
    const idx = loadIssueIndex(owner, name);
    const issue = idx.issues[number];
    if (!issue) return apiErr(reply, 404, 'not found');
    const resolved = await resolveThread(issue.thread);
    const ctx = issueMdCtx(owner, name);
    return sendJson(reply, 200, {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.author,
      authorInfo: authorMeta(issue.author), // additive (2.5)
      createdAt: issue.createdAt,
      labels: resolveLabels(issue.labels, Array.isArray(idx.labels) ? idx.labels : DEFAULT_LABELS), // additive (polish)
      thread: resolved.map((e) => ({
        ...e, // includes hosted (2.5): true for forge-hosted podless content
        authorInfo: authorMeta(e.author),
        html: e.removed ? null : renderMarkdown(e.body, ctx),
      })),
    });
  }

  async function apiIssueCreate(request, reply, owner, name) {
    // Body BEFORE auth: NIP-98 payload-tag verification needs the buffered
    // wire bytes on request.rawBody (see readJsonBody).
    const p = await readJsonBody(request);
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    const podPath = podPathFromAgent(agent);
    const nostrHex = nostrHexOf(agent);
    if (!podPath && !nostrHex) return apiErr(reply, 403, 'no pod namespace for this agent');
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    const bodyText = typeof p.body === 'string' ? p.body : '';
    // Capstone: a pod agent may hand a POINTER (client already wrote the body
    // into its own pod via authFetch) instead of a server-written body.
    const usePointer = !!podPath && typeof p.resourceUrl === 'string' && p.resourceUrl.length > 0;
    if (!title || title.length > ISSUE_TITLE_CAP) return apiErr(reply, 422, `title required (1-${ISSUE_TITLE_CAP} chars)`);
    if (bodyText.length > ISSUE_BODY_CAP) return apiErr(reply, 422, 'body too large');
    return withIssueLock(owner, name, async () => {
      const idx = loadIssueIndex(owner, name);
      const number = idx.next;
      const doc = {
        type: 'ForgeIssue',
        repo: `${owner}/${name}`,
        issue: number,
        title,
        body: bodyText,
        published: new Date().toISOString(),
        author: agent,
      };
      // did:nostr agents have no pod: the forge hosts their words (2.5).
      const stored = nostrHex
        ? storeHosted(nostrHex, { ...doc, hosted: true })
        : usePointer
          ? await registerPointer(request, agent, owner, name, p.resourceUrl)
          : await storeAuthored(request, podPath, owner, name, doc, `issue-${crypto.randomUUID()}.jsonld`);
      if (stored.error) return apiErr(reply, stored.status, stored.error);
      const at = Math.floor(Date.now() / 1000);
      idx.next = number + 1;
      idx.issues[number] = {
        number,
        title,
        state: 'open',
        author: agent,
        createdAt: at,
        thread: [{ author: agent, resourceUrl: stored.url, at, ...(nostrHex ? { hosted: true } : {}) }],
      };
      saveIssueIndex(owner, name, idx);
      return sendJson(reply, 201, {
        number,
        url: `${prefix}/${owner}/${name}/issues/${number}`,
        resourceUrl: stored.url,
        ...(nostrHex ? { hosted: true } : {}),
      });
    });
  }

  async function apiIssueComment(request, reply, owner, name, number) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    const podPath = podPathFromAgent(agent);
    const nostrHex = nostrHexOf(agent);
    if (!podPath && !nostrHex) return apiErr(reply, 403, 'no pod namespace for this agent');
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const bodyText = typeof p.body === 'string' ? p.body : '';
    const usePointer = !!podPath && typeof p.resourceUrl === 'string' && p.resourceUrl.length > 0;
    if (!usePointer && !bodyText.trim()) return apiErr(reply, 422, 'body required');
    if (bodyText.length > ISSUE_BODY_CAP) return apiErr(reply, 422, 'body too large');
    return withIssueLock(owner, name, async () => {
      const idx = loadIssueIndex(owner, name);
      const issue = idx.issues[number];
      if (!issue) return apiErr(reply, 404, 'not found');
      if (issue.thread.length >= THREAD_CAP) return apiErr(reply, 422, 'thread is full');
      const doc = {
        type: 'ForgeComment',
        repo: `${owner}/${name}`,
        issue: number,
        body: bodyText,
        published: new Date().toISOString(),
        author: agent,
      };
      const stored = nostrHex
        ? storeHosted(nostrHex, { ...doc, hosted: true })
        : usePointer
          ? await registerPointer(request, agent, owner, name, p.resourceUrl)
          : await storeAuthored(request, podPath, owner, name, doc, `comment-${crypto.randomUUID()}.jsonld`);
      if (stored.error) return apiErr(reply, stored.status, stored.error);
      issue.thread.push({
        author: agent,
        resourceUrl: stored.url,
        at: Math.floor(Date.now() / 1000),
        ...(nostrHex ? { hosted: true } : {}),
      });
      saveIssueIndex(owner, name, idx);
      return sendJson(reply, 201, {
        number,
        comments: issue.thread.length - 1,
        resourceUrl: stored.url,
        ...(nostrHex ? { hosted: true } : {}),
      });
    });
  }

  /** close/reopen/retitle: index-only operations, repo owner OR issue author. */
  const mayModerate = (agent, owner, issue) => ownerFromAgent(agent) === owner || agent === issue.author;

  async function apiIssueState(request, reply, owner, name, number, state) {
    await readJsonBody(request); // content unused; buffered for NIP-98 payload tags
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    return withIssueLock(owner, name, async () => {
      const idx = loadIssueIndex(owner, name);
      const issue = idx.issues[number];
      if (!issue) return apiErr(reply, 404, 'not found');
      if (!mayModerate(agent, owner, issue)) return apiErr(reply, 403, 'only the repo owner or the issue author may do that');
      issue.state = state;
      saveIssueIndex(owner, name, idx);
      return sendJson(reply, 200, { number, state });
    });
  }

  async function apiIssueRetitle(request, reply, owner, name, number) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (!title || title.length > ISSUE_TITLE_CAP) return apiErr(reply, 422, `title required (1-${ISSUE_TITLE_CAP} chars)`);
    return withIssueLock(owner, name, async () => {
      const idx = loadIssueIndex(owner, name);
      const issue = idx.issues[number];
      if (!issue) return apiErr(reply, 404, 'not found');
      if (!mayModerate(agent, owner, issue)) return apiErr(reply, 403, 'only the repo owner or the issue author may do that');
      issue.title = title;
      saveIssueIndex(owner, name, idx);
      return sendJson(reply, 200, { number, title });
    });
  }

  async function apiRepoPatch(request, reply, owner, name) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may edit the repo');
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const description = typeof p.description === 'string' ? p.description.trim() : null;
    if (description === null || description.length > DESCRIPTION_CAP) {
      return apiErr(reply, 422, `description must be a string (max ${DESCRIPTION_CAP} chars)`);
    }
    fs.writeFileSync(path.join(repoDirOf(owner, name), 'description'), `${description}\n`);
    return sendJson(reply, 200, { owner, name, description });
  }

  // ---- polish: label CRUD (owner-only) + per-item assignment -------------

  async function apiLabelCreate(request, reply, owner, name) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may manage labels');
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const lname = typeof p.name === 'string' ? p.name.trim() : '';
    if (!LABEL_NAME_RE.test(lname)) return apiErr(reply, 422, 'label name required (1-50 printable chars)');
    if (typeof p.color !== 'string' || !LABEL_COLOR_RE.test(p.color)) return apiErr(reply, 422, 'color must be 6 hex digits');
    const color = p.color.toLowerCase();
    return withIssueLock(owner, name, async () => {
      const idx = loadIssueIndex(owner, name);
      const defs = ensureLabels(idx); // first write materializes the defaults
      if (defs.some((d) => d.name.toLowerCase() === lname.toLowerCase())) return apiErr(reply, 409, 'label exists');
      defs.push({ name: lname, color });
      saveIssueIndex(owner, name, idx);
      return sendJson(reply, 201, { name: lname, color });
    });
  }

  /** Rename cascades over items in BOTH indexes (items store names). */
  async function apiLabelPatch(request, reply, owner, name, labelName) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may manage labels');
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    return withIssueLock(owner, name, async () => {
      const idx = loadIssueIndex(owner, name);
      const defs = ensureLabels(idx);
      const def = defs.find((d) => d.name === labelName);
      if (!def) return apiErr(reply, 404, 'not found');
      let newName = def.name;
      if (p.name !== undefined) {
        newName = typeof p.name === 'string' ? p.name.trim() : '';
        if (!LABEL_NAME_RE.test(newName)) return apiErr(reply, 422, 'label name required (1-50 printable chars)');
        if (newName !== def.name && defs.some((d) => d !== def && d.name.toLowerCase() === newName.toLowerCase())) {
          return apiErr(reply, 409, 'label exists');
        }
      }
      if (p.color !== undefined) {
        if (typeof p.color !== 'string' || !LABEL_COLOR_RE.test(p.color)) return apiErr(reply, 422, 'color must be 6 hex digits');
        def.color = p.color.toLowerCase();
      }
      const oldName = def.name;
      def.name = newName;
      if (newName !== oldName) {
        for (const i of Object.values(idx.issues)) {
          if (Array.isArray(i.labels)) i.labels = i.labels.map((n) => (n === oldName ? newName : n));
        }
      }
      saveIssueIndex(owner, name, idx);
      if (newName !== oldName) {
        await withPullLock(owner, name, async () => {
          const pidx = loadPullIndex(owner, name);
          let touched = false;
          for (const pr of Object.values(pidx.pulls)) {
            if (Array.isArray(pr.labels) && pr.labels.includes(oldName)) {
              pr.labels = pr.labels.map((n) => (n === oldName ? newName : n));
              touched = true;
            }
          }
          if (touched) savePullIndex(owner, name, pidx);
        });
      }
      return sendJson(reply, 200, { name: def.name, color: def.color });
    });
  }

  /** Delete cascades the label OFF every issue and pull that carries it. */
  async function apiLabelDelete(request, reply, owner, name, labelName) {
    await readJsonBody(request); // content unused; buffered for NIP-98 payload tags
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may manage labels');
    return withIssueLock(owner, name, async () => {
      const idx = loadIssueIndex(owner, name);
      const defs = ensureLabels(idx);
      const at = defs.findIndex((d) => d.name === labelName);
      if (at === -1) return apiErr(reply, 404, 'not found');
      defs.splice(at, 1);
      for (const i of Object.values(idx.issues)) {
        if (Array.isArray(i.labels)) i.labels = i.labels.filter((n) => n !== labelName);
      }
      saveIssueIndex(owner, name, idx);
      await withPullLock(owner, name, async () => {
        const pidx = loadPullIndex(owner, name);
        let touched = false;
        for (const pr of Object.values(pidx.pulls)) {
          if (Array.isArray(pr.labels) && pr.labels.includes(labelName)) {
            pr.labels = pr.labels.filter((n) => n !== labelName);
            touched = true;
          }
        }
        if (touched) savePullIndex(owner, name, pidx);
      });
      return sendJson(reply, 200, { name: labelName, deleted: true });
    });
  }

  async function apiLabelsHandler(request, reply, owner, name, tail) {
    const method = request.method;
    if (tail.length === 0) {
      if (method === 'GET' || method === 'HEAD') return sendJson(reply, 200, { labels: labelDefs(owner, name) });
      if (method === 'POST') return apiLabelCreate(request, reply, owner, name);
      return apiErr(reply, 405, 'method not allowed');
    }
    if (tail.length === 1) {
      let labelName; // the segment arrives raw-encoded (the dispatcher does not decode)
      try { labelName = decodeURIComponent(tail[0]); } catch { return apiErr(reply, 404, 'not found'); }
      if (method === 'PATCH') return apiLabelPatch(request, reply, owner, name, labelName);
      if (method === 'DELETE') return apiLabelDelete(request, reply, owner, name, labelName);
      return apiErr(reply, 405, 'method not allowed');
    }
    return apiErr(reply, 404, 'not found');
  }

  /**
   * PUT .../{issues,pulls}/<n>/labels {labels: [names]} — replaces the
   * item's label set; repo owner or the item's author. Every name must
   * exist in the repo's label set (names are validated, never invented).
   */
  async function apiItemLabels(request, reply, owner, name, number, kind) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (!p || !Array.isArray(p.labels)) return apiErr(reply, 400, 'body must be { labels: [names] }');
    if (p.labels.length > LABELS_PER_ITEM) return apiErr(reply, 422, `at most ${LABELS_PER_ITEM} labels per item`);
    const defs = labelDefs(owner, name);
    const names = [];
    for (const n of p.labels) {
      if (typeof n !== 'string' || !defs.some((d) => d.name === n)) {
        return apiErr(reply, 422, `unknown label: ${String(n).slice(0, 60)}`);
      }
      if (!names.includes(n)) names.push(n);
    }
    const [withLock, load, save, itemsKey] = kind === 'issues'
      ? [withIssueLock, loadIssueIndex, saveIssueIndex, 'issues']
      : [withPullLock, loadPullIndex, savePullIndex, 'pulls'];
    return withLock(owner, name, async () => {
      const idx = load(owner, name);
      const item = idx[itemsKey][number];
      if (!item) return apiErr(reply, 404, 'not found');
      if (!mayModerate(agent, owner, item)) return apiErr(reply, 403, 'only the repo owner or the item author may set labels');
      item.labels = names;
      save(owner, name, idx);
      return sendJson(reply, 200, { number: item.number, labels: names });
    });
  }

  // ---- polish: read-time search + releases -------------------------------

  async function apiSearch(reply, owner, name, query) {
    const q = typeof query?.q === 'string' ? query.q.trim() : '';
    if (!q) return apiErr(reply, 422, 'q required');
    if (q.length > SEARCH_QUERY_CAP) return apiErr(reply, 422, `q too long (max ${SEARCH_QUERY_CAP} chars)`);
    return sendJson(reply, 200, await searchData(owner, name, q));
  }

  async function apiReleases(reply, owner, name) {
    return sendJson(reply, 200, { releases: await listReleases(owner, name) });
  }

  async function apiIssuesHandler(request, reply, owner, name, tail) {
    const method = request.method;
    if (tail.length === 0) {
      if (method === 'POST') return apiIssueCreate(request, reply, owner, name);
      if (method === 'GET' || method === 'HEAD') return apiIssueList(reply, owner, name, request.query);
      return apiErr(reply, 405, 'method not allowed');
    }
    if (!ISSUE_NUM_RE.test(tail[0])) return apiErr(reply, 404, 'not found');
    const number = +tail[0];
    if (tail.length === 1) {
      if (method === 'GET' || method === 'HEAD') return apiIssueGet(reply, owner, name, number);
      if (method === 'PATCH') return apiIssueRetitle(request, reply, owner, name, number);
      return apiErr(reply, 405, 'method not allowed');
    }
    if (tail.length === 2 && tail[1] === 'labels') {
      if (method !== 'PUT') return apiErr(reply, 405, 'method not allowed');
      return apiItemLabels(request, reply, owner, name, number, 'issues');
    }
    if (tail.length === 2 && ['comments', 'close', 'reopen'].includes(tail[1])) {
      if (method !== 'POST') return apiErr(reply, 405, 'method not allowed');
      if (tail[1] === 'comments') return apiIssueComment(request, reply, owner, name, number);
      return apiIssueState(request, reply, owner, name, number, tail[1] === 'close' ? 'closed' : 'open');
    }
    return apiErr(reply, 404, 'not found');
  }

  // ---- tier 3a: forks, compare, pull requests with real merges ----------

  /**
   * POST api/repos/<o>/<n>/fork — `git clone --local --bare` into the
   * CALLER's namespace (same name; optional {name} override so an owner
   * can fork their own repo — GitHub allows self-forks, and a same-name
   * self-fork would always collide). 409 when the target exists. Lineage
   * is recorded in the fork's git config (forge.parent = <o>/<n>).
   */
  async function apiForkCreate(request, reply, owner, name) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    const caller = ownerFromAgent(agent);
    if (!caller) return apiErr(reply, 403, 'no namespace for this agent');
    let target = name;
    if (p && p.name !== undefined) {
      if (typeof p.name !== 'string' || !REPO_NAME.test(p.name) || p.name.includes('..') || p.name.endsWith('.git')) {
        return apiErr(reply, 422, 'invalid fork name');
      }
      target = p.name;
    }
    if (repoExists(caller, target)) return apiErr(reply, 409, `${caller}/${target} already exists`);
    const dir = repoDirOf(caller, target);
    fs.mkdirSync(path.join(reposDir, caller), { recursive: true });
    await execFileP('git', ['clone', '--local', '--bare', '--quiet', repoDirOf(owner, name), dir],
      { env: gitEnv, maxBuffer: MAX_EXEC_BUFFER });
    await execFileP('git', ['-C', dir, 'config', 'http.receivepack', 'true'], { env: gitEnv });
    await execFileP('git', ['-C', dir, 'config', 'uploadpack.hideRefs', 'refs/forge/'], { env: gitEnv });
    await execFileP('git', ['-C', dir, 'config', 'forge.parent', `${owner}/${name}`], { env: gitEnv });
    // the clone's origin remote is an internal filesystem path — drop it
    await execFileP('git', ['-C', dir, 'remote', 'remove', 'origin'], { env: gitEnv }).catch(() => {});
    fs.writeFileSync(path.join(dir, 'hooks', 'post-receive'), POST_RECEIVE_HOOK, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, META_FILE),
      JSON.stringify({ createdAt: Date.now(), creator: agent, forkedFrom: `${owner}/${name}` }, null, 2));
    api.log.info(`forge: ${agent} forked ${owner}/${name} -> ${caller}/${target}`);
    return sendJson(reply, 201, {
      owner: caller,
      name: target,
      parent: `${owner}/${name}`,
      url: `${prefix}/${caller}/${target}`,
      cloneUrl: cloneUrlOf(caller, target),
    });
  }

  // ---- tier 3.7: web-edit — commit one file over HTTP (GitHub's web editor)

  /**
   * Validate a repo-relative edit path. Returns the clean path or null.
   * Rejects: non-strings, empties, a leading '/', '..', backslashes, control
   * chars, empty/oversized segments, any '.git' segment, and a leading-dot
   * path at the repo ROOT (.acl / .htaccess surprises). Each segment must
   * match EDIT_SEG. Kept deliberately strict — the demo edits ordinary files.
   */
  function cleanEditPath(p) {
    if (typeof p !== 'string' || p.length === 0 || p.length > EDIT_PATH_CAP) return null;
    if (p[0] === '/' || p.includes('\\') || /[\x00-\x1f]/.test(p)) return null;
    const segs = p.split('/');
    for (const s of segs) {
      if (s === '' || s === '..' || s === '.git' || !EDIT_SEG.test(s)) return null;
    }
    if (segs[0].startsWith('.')) return null; // no dotfile at the repo root
    return segs.join('/');
  }

  /**
   * POST api/repos/<o>/<n>/preview { path, content, branch? } — the UNSTAGED
   * tier. Publishes an EPHEMERAL Nostr event (kind 21617) carrying the file
   * content; makes NO commit, no push, no anchor, writes nothing to disk.
   * Relays don't store ephemeral events, so only currently-connected viewers
   * receive it — a live, throwaway preview that vanishes the moment you stop
   * looking. Same auth as /edit (owner-signed unless config.openEdit). Returns
   * {ok, published, kind, id, path, relays}; {published:false} if no relays.
   */
  async function apiRepoPreview(request, reply, owner, name) {
    const p = await readJsonBody(request, EDIT_CONTENT_CAP + 128 * 1024);
    const agent = await requestAgent(request);
    const authedOwner = agent ? ownerFromAgent(agent) : null;
    if (!openEdit) {
      if (!agent) {
        reply.header('WWW-Authenticate', 'Bearer realm="jss-forge"');
        return corsErr(reply, 401, 'authentication required');
      }
      if (authedOwner !== owner) return corsErr(reply, 403, 'only the repo owner may preview this repository');
    }
    if (!p || typeof p !== 'object') return corsErr(reply, 400, 'invalid JSON body');
    const relPath = cleanEditPath(p.path);
    if (!relPath) return corsErr(reply, 400, 'invalid path');
    if (typeof p.content !== 'string') return corsErr(reply, 400, 'content must be a string');
    if (Buffer.byteLength(p.content, 'utf8') > EDIT_CONTENT_CAP) {
      return corsErr(reply, 413, `content exceeds the ${EDIT_CONTENT_CAP}-byte cap`);
    }
    if (!repoExists(owner, name)) return corsErr(reply, 404, 'not found');
    let branch;
    if (p.branch !== undefined) {
      if (typeof p.branch !== 'string' || !REF_RE.test(p.branch) || p.branch.includes('..')) {
        return corsErr(reply, 400, 'invalid branch');
      }
      branch = p.branch;
    } else {
      branch = await defaultBranch(repoDirOf(owner, name));
    }
    if (!announceRelays.length) {
      return corsJson(reply, 200, { ok: true, published: false, reason: 'no relays configured (set config.announceRelays)' });
    }
    const ev = signAnnounceEvent({
      kind: EPHEMERAL_PREVIEW_KIND,
      tags: [['d', `${owner}/${name}`], ['f', relPath], ['branch', branch]],
      content: p.content,
    });
    const relays = await publishEvent(ev);
    return corsJson(reply, 200, { ok: true, published: true, kind: ev.kind, id: ev.id, path: relPath, relays });
  }

  /**
   * POST api/repos/<o>/<n>/edit { path, content, message?, branch? } — the
   * GitHub-web-editor equivalent: commit ONE file change over HTTP, then let
   * the change ride the forge's NIP-34 emission. Owner-signed by default
   * (401 anon / 403 wrong owner); config.openEdit relaxes to anonymous for a
   * throwaway demo. The commit is made in a disposable local clone (a temp
   * working tree) and pushed back to the bare — no server-side index games.
   * A no-op edit (identical content) makes NO commit ({changed:false}).
   */
  async function apiRepoEdit(request, reply, owner, name) {
    // Body BEFORE auth: a NIP-98 payload tag hashes the wire bytes.
    const p = await readJsonBody(request, EDIT_CONTENT_CAP + 128 * 1024);
    const agent = await requestAgent(request);
    const authedOwner = agent ? ownerFromAgent(agent) : null;
    if (!openEdit) {
      if (!agent) {
        reply.header('WWW-Authenticate', 'Bearer realm="jss-forge"');
        return corsErr(reply, 401, 'authentication required');
      }
      if (authedOwner !== owner) return corsErr(reply, 403, 'only the repo owner may edit this repository');
    }
    if (!p || typeof p !== 'object') return corsErr(reply, 400, 'invalid JSON body');

    const relPath = cleanEditPath(p.path);
    if (!relPath) return corsErr(reply, 400, 'invalid path');
    if (typeof p.content !== 'string') return corsErr(reply, 400, 'content must be a string');
    if (Buffer.byteLength(p.content, 'utf8') > EDIT_CONTENT_CAP) {
      return corsErr(reply, 413, `content exceeds the ${EDIT_CONTENT_CAP}-byte cap`);
    }
    let message = typeof p.message === 'string' ? p.message.replace(/[\x00-\x1f]+/g, ' ').trim() : '';
    if (message.length > EDIT_MSG_CAP) message = message.slice(0, EDIT_MSG_CAP);
    if (!message) message = `web edit: ${relPath}`;

    const bareDir = repoDirOf(owner, name);
    if (!repoExists(owner, name)) return corsErr(reply, 404, 'not found');
    let branch;
    if (p.branch !== undefined) {
      if (typeof p.branch !== 'string' || !REF_RE.test(p.branch) || p.branch.includes('..')) {
        return corsErr(reply, 400, 'invalid branch');
      }
      branch = p.branch;
    } else {
      branch = await defaultBranch(bareDir);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-edit-'));
    const gitTmp = (args) => execFileP('git', ['-C', tmpDir, ...args], { env: gitEnv, maxBuffer: MAX_EXEC_BUFFER });
    try {
      // Disposable local clone (fast, hard-linked), then land on the branch —
      // creating it off the current HEAD if it does not exist yet.
      await execFileP('git', ['clone', '--local', '--quiet', bareDir, tmpDir], { env: gitEnv, maxBuffer: MAX_EXEC_BUFFER });
      await gitTmp(['checkout', branch]).catch(() => gitTmp(['checkout', '-b', branch]));

      // Write the file (parents made), stage it, and detect a real change.
      const abs = path.join(tmpDir, relPath);
      const resolved = path.resolve(abs);
      if (resolved !== path.resolve(tmpDir) && !resolved.startsWith(path.resolve(tmpDir) + path.sep)) {
        return corsErr(reply, 400, 'invalid path'); // defense in depth; cleanEditPath already blocks this
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, p.content);
      await gitTmp(['add', '--', relPath]);

      let changed = true;
      try { await gitTmp(['diff', '--cached', '--quiet']); changed = false; } catch { changed = true; }
      if (!changed) {
        const head = (await gitTmp(['rev-parse', 'HEAD']).then((r) => r.stdout.trim()).catch(() => '')) || null;
        return corsJson(reply, 200, { ok: true, commit: head, changed: false });
      }

      // Committer identity is forced via -c (no HOME, GIT_CONFIG_NOSYSTEM):
      // the author of record is whoever authenticated (or 'anonymous' in
      // openEdit demo mode); the committer is the forge itself.
      const who = authedOwner || 'anonymous';
      const env = {
        ...gitEnv,
        GIT_AUTHOR_NAME: who,
        GIT_AUTHOR_EMAIL: `${who}@forge.invalid`,
      };
      await execFileP('git', ['-C', tmpDir,
        '-c', 'user.name=forge web edit', '-c', 'user.email=forge@forge.invalid',
        'commit', '--quiet', '-m', message], { env, maxBuffer: MAX_EXEC_BUFFER });
      await gitTmp(['push', '--quiet', bareDir, `HEAD:refs/heads/${branch}`]);
      const commit = (await gitTmp(['rev-parse', 'HEAD'])).stdout.trim();

      api.log.info(`forge: web edit ${owner}/${name}@${branch} ${relPath} -> ${commit.slice(0, 7)} by ${agent ?? 'anonymous'}`);
      // The tip moved: advance any Blocktrails anchor exactly as a push would,
      // then fire the NIP-34 emission (fire-and-forget; a no-op with no relays).
      await recordTipSafe(owner, name);
      announceRepoSafe(owner, name);
      return corsJson(reply, 200, { ok: true, commit, changed: true, url: `${prefix}/${owner}/${name}` });
    } catch (err) {
      // Never leak the tmp path or raw git stderr.
      api.log.warn(`forge: web edit ${owner}/${name} failed: ${err.message}`);
      return corsErr(reply, 500, 'edit failed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async function apiCompare(reply, owner, name, spec) {
    const dots = spec.indexOf('...');
    if (dots < 1) return apiErr(reply, 404, 'not found');
    const cmp = await compareData(owner, name, spec.slice(0, dots), spec.slice(dots + 3));
    if (!cmp) return apiErr(reply, 404, 'not found');
    return sendJson(reply, 200, {
      base: { ref: cmp.baseRef, sha: cmp.baseSha },
      head: { owner: cmp.head.owner, repo: cmp.head.repo, ref: cmp.head.ref, sha: cmp.head.sha },
      aheadBy: cmp.aheadBy,
      behindBy: cmp.behindBy,
      mergeBase: cmp.mergeBase,
      hasMore: cmp.hasMore,
      commits: cmp.commits,
      files: cmp.files,
    });
  }

  function apiPullList(reply, owner, name, query) {
    const idx = loadPullIndex(owner, name);
    const all = Object.values(idx.pulls).sort((a, b) => b.number - a.number);
    const count = (s) => all.filter((p) => p.state === s).length;
    const state = ['merged', 'closed'].includes(query?.state) ? query.state : 'open';
    const label = typeof query?.label === 'string' && query.label ? query.label.slice(0, 50) : null;
    const defs = labelDefs(owner, name);
    const pageNo = Math.max(1, Math.min(10000, parseInt(query?.page, 10) || 1));
    const filtered = all.filter((p) => p.state === state
      && (!label || (Array.isArray(p.labels) && p.labels.includes(label))));
    return sendJson(reply, 200, {
      state,
      page: pageNo,
      perPage: ISSUES_PER_PAGE,
      hasMore: filtered.length > pageNo * ISSUES_PER_PAGE,
      openCount: count('open'),
      mergedCount: count('merged'),
      closedCount: count('closed'),
      pulls: filtered.slice((pageNo - 1) * ISSUES_PER_PAGE, pageNo * ISSUES_PER_PAGE).map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        author: p.author,
        authorInfo: authorMeta(p.author),
        createdAt: p.createdAt,
        base: p.base,
        head: p.head,
        merged: p.merged ?? null,
        labels: resolveLabels(p.labels, defs), // additive (polish)
        comments: p.thread.length - 1,
      })),
    });
  }

  async function apiPullGet(reply, owner, name, number) {
    const pr = loadPullIndex(owner, name).pulls[number];
    if (!pr) return apiErr(reply, 404, 'not found');
    const resolved = await resolveThread(pr.thread);
    const ctx = issueMdCtx(owner, name);
    const info = pr.state === 'open'
      ? await pullMergeInfo(owner, name, pr)
      : { baseSha: await revParse(repoDirOf(owner, name), `refs/heads/${pr.base}`), headSha: null, mergeable: null, conflicts: [], fastForward: false };
    return sendJson(reply, 200, {
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.author,
      authorInfo: authorMeta(pr.author),
      createdAt: pr.createdAt,
      base: pr.base,
      baseSha: info.baseSha,
      head: { ...pr.head, sha: info.headSha ?? undefined },
      merged: pr.merged ?? null,
      mergeable: info.mergeable,
      conflicts: info.conflicts,
      labels: resolveLabels(pr.labels, labelDefs(owner, name)), // additive (polish)
      thread: resolved.map((e) => ({
        ...e,
        authorInfo: authorMeta(e.author),
        html: e.removed ? null : renderMarkdown(e.body, ctx),
      })),
    });
  }

  async function apiPullCreate(request, reply, owner, name) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    const bodyText = typeof p.body === 'string' ? p.body : '';
    if (!title || title.length > ISSUE_TITLE_CAP) return apiErr(reply, 422, `title required (1-${ISSUE_TITLE_CAP} chars)`);
    if (bodyText.length > ISSUE_BODY_CAP) return apiErr(reply, 422, 'body too large');
    const baseRef = typeof p.base === 'string' ? p.base : '';
    if (!okRef(baseRef)) return apiErr(reply, 422, 'base must be a branch of this repository');
    const dir = repoDirOf(owner, name);
    const baseSha = await revParse(dir, `refs/heads/${baseRef}`);
    if (!baseSha) return apiErr(reply, 422, `base branch ${baseRef} does not exist`);
    const head = await resolveHead(owner, name, typeof p.head === 'string' ? p.head : '');
    if (!head) return apiErr(reply, 422, 'head must be <branch> or <owner>:<branch> of a same-named repo');
    const counts = (await gitText(dir, ['rev-list', '--left-right', '--count', `${baseSha}...${head.sha}`]))
      .trim().split(/\s+/);
    if (!+counts[1]) return apiErr(reply, 422, 'no commits between base and head');
    return withPullLock(owner, name, async () => {
      const idx = loadPullIndex(owner, name);
      const number = idx.next;
      const doc = {
        type: 'ForgePullRequest',
        repo: `${owner}/${name}`,
        pull: number,
        title,
        body: bodyText,
        base: baseRef,
        head: `${head.owner}:${head.ref}`,
        published: new Date().toISOString(),
        author: agent,
      };
      const usePointer = !!podPathFromAgent(agent) && typeof p.resourceUrl === 'string' && p.resourceUrl.length > 0;
      const stored = usePointer
        ? await registerPointer(request, agent, owner, name, p.resourceUrl)
        : await persistBody(request, agent, owner, name, doc, 'pull');
      if (stored.error) return apiErr(reply, stored.status, stored.error);
      const at = Math.floor(Date.now() / 1000);
      idx.next = number + 1;
      idx.pulls[number] = {
        number,
        title,
        state: 'open',
        author: agent,
        createdAt: at,
        base: baseRef,
        head: { owner: head.owner, repo: head.repo, ref: head.ref },
        merged: null,
        thread: [{ author: agent, resourceUrl: stored.url, at, ...(stored.hosted ? { hosted: true } : {}) }],
      };
      savePullIndex(owner, name, idx);
      return sendJson(reply, 201, {
        number,
        url: `${prefix}/${owner}/${name}/pulls/${number}`,
        resourceUrl: stored.url,
        ...(stored.hosted ? { hosted: true } : {}),
      });
    });
  }

  async function apiPullComment(request, reply, owner, name, number) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const bodyText = typeof p.body === 'string' ? p.body : '';
    const usePointer = !!podPathFromAgent(agent) && typeof p.resourceUrl === 'string' && p.resourceUrl.length > 0;
    if (!usePointer && !bodyText.trim()) return apiErr(reply, 422, 'body required');
    if (bodyText.length > ISSUE_BODY_CAP) return apiErr(reply, 422, 'body too large');
    return withPullLock(owner, name, async () => {
      const idx = loadPullIndex(owner, name);
      const pr = idx.pulls[number];
      if (!pr) return apiErr(reply, 404, 'not found');
      if (pr.thread.length >= THREAD_CAP) return apiErr(reply, 422, 'thread is full');
      const doc = {
        type: 'ForgeComment',
        repo: `${owner}/${name}`,
        pull: number,
        body: bodyText,
        published: new Date().toISOString(),
        author: agent,
      };
      const stored = usePointer
        ? await registerPointer(request, agent, owner, name, p.resourceUrl)
        : await persistBody(request, agent, owner, name, doc, 'comment');
      if (stored.error) return apiErr(reply, stored.status, stored.error);
      pr.thread.push({
        author: agent,
        resourceUrl: stored.url,
        at: Math.floor(Date.now() / 1000),
        ...(stored.hosted ? { hosted: true } : {}),
      });
      savePullIndex(owner, name, idx);
      return sendJson(reply, 201, {
        number,
        comments: pr.thread.length - 1,
        resourceUrl: stored.url,
        ...(stored.hosted ? { hosted: true } : {}),
      });
    });
  }

  /** close/reopen: target repo owner or the PR author; merged is final. */
  async function apiPullState(request, reply, owner, name, number, state) {
    await readJsonBody(request); // content unused; buffered for NIP-98 payload tags
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    return withPullLock(owner, name, async () => {
      const idx = loadPullIndex(owner, name);
      const pr = idx.pulls[number];
      if (!pr) return apiErr(reply, 404, 'not found');
      if (!mayModerate(agent, owner, pr)) return apiErr(reply, 403, 'only the repo owner or the pull-request author may do that');
      if (pr.state === 'merged') return apiErr(reply, 422, 'a merged pull request cannot be reopened or closed');
      pr.state = state;
      savePullIndex(owner, name, idx);
      return sendJson(reply, 200, { number, state });
    });
  }

  /**
   * POST .../pulls/<n>/merge — a REAL merge on the bare repo (target repo
   * owner only): fetch the head objects, `merge-tree --write-tree` (or a
   * fast-forward when the base is an ancestor — ff-when-possible policy),
   * `commit-tree` with two parents, then `update-ref` with an old-value
   * guard. Optional {expectedBase: <sha>} is the UI's CAS token: 409 when
   * the base moved since the diff the merger saw.
   */
  async function apiPullMerge(request, reply, owner, name, number) {
    const p = await readJsonBody(request);
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may merge');
    if (!mergeTreeOk) {
      return apiErr(reply, 501,
        `merging needs git >= 2.38 (merge-tree --write-tree); this server has "${gitVersion}"`);
    }
    return withPullLock(owner, name, async () => {
      const idx = loadPullIndex(owner, name);
      const pr = idx.pulls[number];
      if (!pr) return apiErr(reply, 404, 'not found');
      if (pr.state !== 'open') return apiErr(reply, 422, `pull request is ${pr.state}`);
      const dir = repoDirOf(owner, name);
      const baseSha = await revParse(dir, `refs/heads/${pr.base}`);
      if (!baseSha) return apiErr(reply, 422, `base branch ${pr.base} no longer exists`);
      const expected = typeof p?.expectedBase === 'string' && p.expectedBase ? p.expectedBase : null;
      if (expected !== null && !SHA_RE.test(expected)) return apiErr(reply, 422, 'expectedBase must be a sha');
      if (expected !== null && !baseSha.startsWith(expected)) {
        return sendJson(reply, 409, { error: `the base branch has moved since the diff you saw (now at ${baseSha.slice(0, 7)}) — review and retry`, baseSha });
      }
      const head = await resolveHead(owner, name, prHeadSpec(pr));
      if (!head) return apiErr(reply, 422, 'the head branch no longer exists');
      if (head.sha === baseSha || await isAncestor(dir, head.sha, baseSha)) {
        return apiErr(reply, 422, 'nothing to merge: the base already contains the head');
      }
      let mergedSha;
      let fastForward = false;
      if (await isAncestor(dir, baseSha, head.sha)) {
        // ff-when-possible: no synthetic merge commit when none is needed.
        fastForward = true;
        mergedSha = head.sha;
      } else {
        const mt = await mergeTreeOf(dir, baseSha, head.sha);
        if (!mt.clean) {
          return sendJson(reply, 409, { error: 'merge conflict', conflicts: mt.conflicts });
        }
        // Honest authorship: author = the merging agent, committer = forge.
        const who = ownerFromAgent(agent) ?? 'agent';
        const env = {
          ...gitEnv,
          GIT_AUTHOR_NAME: displayName(agent),
          GIT_AUTHOR_EMAIL: `${who}@forge.invalid`,
          GIT_COMMITTER_NAME: 'forge',
          GIT_COMMITTER_EMAIL: 'forge@forge.invalid',
        };
        const msg = `Merge pull request #${pr.number} from ${prHeadSpec(pr)}`;
        const { stdout } = await execFileP('git',
          ['-C', dir, 'commit-tree', mt.tree, '-p', baseSha, '-p', head.sha, '-m', msg], { env });
        mergedSha = stdout.trim();
      }
      // Compare-and-swap: update-ref's old-value guard rejects the write
      // if the base moved between our read and now (e.g. a racing push).
      try {
        await execFileP('git', ['-C', dir, 'update-ref', `refs/heads/${pr.base}`, mergedSha, baseSha], { env: gitEnv });
      } catch {
        return sendJson(reply, 409, { error: 'the base branch moved during the merge — retry' });
      }
      pr.state = 'merged';
      pr.merged = {
        sha: mergedSha,
        mergedBy: agent,
        at: Math.floor(Date.now() / 1000),
        baseSha,
        headSha: head.sha,
        fastForward,
      };
      savePullIndex(owner, name, idx);
      api.log.info(`forge: merged PR #${pr.number} into ${owner}/${name}@${pr.base} (${mergedSha.slice(0, 7)}${fastForward ? ', ff' : ''})`);
      // Anchoring advance (3.5): a merge moves the base ref via update-ref
      // — the same tip-change beat as a push, routed through the same
      // helper. recordTip no-ops when the DEFAULT branch didn't move
      // (e.g. a merge into a side branch). Awaited so the response only
      // goes out once the mark (if any) is derived and recorded.
      await recordTipSafe(owner, name);
      return sendJson(reply, 200, { number: pr.number, state: 'merged', sha: mergedSha, fastForward });
    });
  }

  async function apiPullsHandler(request, reply, owner, name, tail) {
    const method = request.method;
    if (tail.length === 0) {
      if (method === 'POST') return apiPullCreate(request, reply, owner, name);
      if (method === 'GET' || method === 'HEAD') return apiPullList(reply, owner, name, request.query);
      return apiErr(reply, 405, 'method not allowed');
    }
    if (!ISSUE_NUM_RE.test(tail[0])) return apiErr(reply, 404, 'not found');
    const number = +tail[0];
    if (tail.length === 1) {
      if (method === 'GET' || method === 'HEAD') return apiPullGet(reply, owner, name, number);
      return apiErr(reply, 405, 'method not allowed');
    }
    if (tail.length === 2 && tail[1] === 'labels') {
      if (method !== 'PUT') return apiErr(reply, 405, 'method not allowed');
      return apiItemLabels(request, reply, owner, name, number, 'pulls');
    }
    if (tail.length === 2 && ['comments', 'close', 'reopen', 'merge'].includes(tail[1])) {
      if (method !== 'POST') return apiErr(reply, 405, 'method not allowed');
      if (tail[1] === 'comments') return apiPullComment(request, reply, owner, name, number);
      if (tail[1] === 'merge') return apiPullMerge(request, reply, owner, name, number);
      return apiPullState(request, reply, owner, name, number, tail[1] === 'close' ? 'closed' : 'open');
    }
    return apiErr(reply, 404, 'not found');
  }

  // ---- tier 3.5: git-mark anchoring via Blocktrails --------------------

  /**
   * POST api/repos/<o>/<n>/marks/enable (owner only) — genesis: mint a
   * fresh trail key (forge-held, testnet posture — README Findings) and
   * derive mark 0's address from the CURRENT default-branch tip. Needs a
   * commit to commit to; an empty repo is 422.
   */
  async function apiMarksEnable(request, reply, owner, name) {
    await readJsonBody(request); // content unused; buffered for NIP-98 payload tags
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may enable anchoring');
    const dir = repoDirOf(owner, name);
    const branch = await defaultBranch(dir);
    const tip = await revParse(dir, `refs/heads/${branch}`);
    if (!tip) return apiErr(reply, 422, 'anchoring needs a commit on the default branch — push first');
    return withMarkLock(owner, name, async () => {
      if (loadTrail(owner, name)) return apiErr(reply, 409, 'anchoring is already enabled for this repository');
      const priv = secp256k1.utils.randomPrivateKey(); // throwaway-grade custody, by design
      const trail = {
        v: 1,
        chain,
        privkey: Buffer.from(priv).toString('hex'),
        pubkeyBase: Buffer.from(secp256k1.getPublicKey(priv, true)).toString('hex'),
        createdAt: Math.floor(Date.now() / 1000),
        marks: [],
      };
      const mark = appendMark(trail, { commit: tip, repo: `${owner}/${name}`, branch });
      saveTrail(owner, name, trail);
      api.log.info(`forge: anchoring enabled for ${owner}/${name} on ${chain} — genesis mark ${mark.address} `
        + '(trail key is FORGE-HELD in pluginDir/marks; testnet custody)');
      return sendJson(reply, 201, { enabled: true, chain, pubkeyBase: trail.pubkeyBase, mark: publicMark(mark) });
    });
  }

  /**
   * POST api/repos/<o>/<n>/marks/<i>/txo (owner only) { txid, vout,
   * amount } — record where the mark landed on-chain. Shape-validated and
   * RECORDED, never verified: the server does no chain fetches, ever —
   * independent verification is the hosted verifier's job, client-side
   * (that split is the point; README Findings). Marks are recorded in
   * order because the trail is a linear spend chain.
   */
  async function apiMarkTxo(request, reply, owner, name, index) {
    const p = await readJsonBody(request); // body before auth (NIP-98 payload tag)
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may record a mark transaction');
    if (!p) return apiErr(reply, 400, 'invalid JSON body');
    const txid = typeof p.txid === 'string' ? p.txid.toLowerCase() : '';
    if (!TXID64.test(txid)) return apiErr(reply, 422, 'txid must be 64 hex chars');
    if (!Number.isInteger(p.vout) || p.vout < 0 || p.vout > 0x7fffffff) return apiErr(reply, 422, 'vout must be a non-negative integer');
    if (!Number.isInteger(p.amount) || p.amount <= 0 || p.amount > SATS_CAP) return apiErr(reply, 422, 'amount must be a positive integer (satoshis)');
    return withMarkLock(owner, name, async () => {
      const trail = loadTrail(owner, name);
      if (!trail) return apiErr(reply, 404, 'anchoring is not enabled for this repository');
      const mark = trail.marks[index];
      if (!mark) return apiErr(reply, 404, 'no such mark');
      if (mark.status === 'marked') return apiErr(reply, 409, 'this mark already has a recorded transaction');
      if (index > 0 && trail.marks[index - 1].status !== 'marked') {
        return apiErr(reply, 409, 'record marks in order: the trail is a linear spend chain (mark N spends mark N-1)');
      }
      Object.assign(mark, { txid, vout: p.vout, amount: p.amount, status: 'marked', markedAt: Math.floor(Date.now() / 1000) });
      saveTrail(owner, name, trail);
      api.log.info(`forge: mark #${mark.index} of ${owner}/${name} recorded as ${txid.slice(0, 10)}…:${p.vout} (claim recorded, not verified)`);
      // Discovery layer (NIP-34): a mark flipping to 'marked' means the repo
      // now has a Bitcoin anchor — announce it (WITH its anchor tags) so ngit
      // and relays learn the source-of-truth. Fire-and-forget: a no-op when
      // no relays are configured, and never blocks the txo response.
      announceRepoSafe(owner, name);
      return sendJson(reply, 200, { index: mark.index, status: 'marked', txid, vout: p.vout, amount: p.amount });
    });
  }

  /** GET api/repos/<o>/<n>/marks — the full mark list (never the key). */
  function apiMarksList(reply, owner, name) {
    const trail = loadTrail(owner, name);
    if (!trail) return sendJson(reply, 200, { enabled: false, chain });
    return sendJson(reply, 200, {
      enabled: true,
      chain: trail.chain,
      pubkeyBase: trail.pubkeyBase,
      marks: trail.marks.map(publicMark),
    });
  }

  async function apiMarksHandler(request, reply, owner, name, tail) {
    const method = request.method;
    if (tail.length === 0) {
      if (method === 'GET' || method === 'HEAD') return apiMarksList(reply, owner, name);
      return apiErr(reply, 405, 'method not allowed');
    }
    if (tail.length === 1 && tail[0] === 'enable') {
      if (method !== 'POST') return apiErr(reply, 405, 'method not allowed');
      return apiMarksEnable(request, reply, owner, name);
    }
    if (tail.length === 2 && tail[1] === 'txo' && MARK_INDEX_RE.test(tail[0])) {
      if (method !== 'POST') return apiErr(reply, 405, 'method not allowed');
      return apiMarkTxo(request, reply, owner, name, +tail[0]);
    }
    return apiErr(reply, 404, 'not found');
  }

  // ---- tier 3.6: NIP-34 nostr discovery (announce + read-back) --------

  /**
   * POST api/repos/<o>/<n>/announce (owner only) — build BOTH the kind-30617
   * repo announcement and the kind-30618 repo-state event and publish them to
   * the configured relays. With no relays configured this is a clear 200 no-op
   * (so callers/tests need no live relay). Returns { published, event:
   * {id, kind, tags} (30617), state: {id, kind, tags} (30618), relays:
   * [{relay, ok}], stateRelays: [{relay, ok}] }.
   */
  async function apiAnnounce(request, reply, owner, name) {
    await readJsonBody(request); // no body needed; buffered for NIP-98 payload tags
    const agent = await apiAgent(request, reply);
    if (!agent) return reply;
    if (ownerFromAgent(agent) !== owner) return apiErr(reply, 403, 'only the repo owner may announce this repository');
    const event = await buildRepoEvent(owner, name);
    const state = await buildStateEvent(owner, name);
    const viewOf = (e) => ({ id: e.id, pubkey: e.pubkey, kind: e.kind, tags: e.tags });
    const eventView = viewOf(event);
    const stateView = viewOf(state);
    if (!announceRelays.length) {
      return sendJson(reply, 200, {
        published: false,
        reason: 'no relays configured — set config.announceRelays to publish (NIP-34 emission is opt-in)',
        event: eventView,
        state: stateView,
        relays: [],
      });
    }
    const relays = await publishEvent(event);
    const stateRelays = await publishEvent(state);
    api.log.info(`forge: ${owner}/${name} announced on demand (30617 ${event.id.slice(0, 8)}… + 30618 ${state.id.slice(0, 8)}…) to `
      + `${relays.filter((r) => r.ok).length}/${relays.length} relay(s)`);
    const relayView = (rs) => rs.map((r) => ({ relay: r.relay, ok: r.ok, ...(r.error ? { error: r.error } : {}) }));
    return sendJson(reply, 200, {
      published: true,
      event: eventView,
      state: stateView,
      relays: relayView(relays),
      stateRelays: relayView(stateRelays),
    });
  }

  /**
   * GET api/repos/<o>/<n>/nostr — the (freshly built, signed) events that
   * WOULD be published: the kind-30617 announcement (`event`) AND the
   * kind-30618 repo-state (`state`), plus both in `events`, the announce
   * pubkey/npub and the configured relays. A human/subscriber can inspect the
   * exact NIP-34 shapes (and the commit-precise refs) without a relay.
   */
  async function apiNostr(reply, owner, name) {
    const event = await buildRepoEvent(owner, name);
    const state = await buildStateEvent(owner, name);
    return sendJson(reply, 200, {
      pubkey: announcePubkey,
      npub: npubEncode(announcePubkey),
      relays: announceRelays,
      relaysConfigured: announceRelays.length > 0,
      event,       // the kind-30617 announcement (backward-compat field)
      state,       // the kind-30618 repo-state event (commit-precise refs)
      events: [event, state],
    });
  }

  /**
   * GET <prefix>/<owner>/<name>/blocktrails.json — the verifier-compatible
   * trail document (the shape blocktrails/verify consumes: pubkeyBase,
   * chain, states[], txo[] as `txo:` URIs whose amounts/spend-chain the
   * verifier checks on-chain, client-side). Served with
   * Access-Control-Allow-Origin: * — this ONE route is a public
   * verification document whose whole purpose is to be fetched
   * cross-origin by the hosted verifier page; everything in it is already
   * public via the marks page, so the CORS grant widens reach, not
   * exposure (README Findings). Only MARKED marks enter states/txo (the
   * verifier walks the spend chain; pending marks have nothing on-chain
   * yet) — the full list, pending included, rides in the additive `marks`
   * field.
   */
  function blocktrailsResp(reply, owner, name) {
    const trail = loadTrail(owner, name);
    if (!trail) {
      return reply.code(404)
        .header('content-type', 'application/json; charset=utf-8')
        .header('access-control-allow-origin', '*')
        .header('x-content-type-options', 'nosniff')
        .send(JSON.stringify({ error: 'anchoring is not enabled for this repository' }));
    }
    const marked = [];
    for (const m of trail.marks) {
      if (m.status !== 'marked') break; // recorded strictly in order; the chain stops at the first pending
      marked.push(m);
    }
    const doc = {
      ...(marked.length ? { '@id': txoUriOf(trail, marked[0]) } : {}),
      '@type': 'Blocktrail',
      version: '0.0.3',
      profile: 'gitmark',
      pubkeyBase: trail.pubkeyBase,
      chain: trail.chain,
      // Additive, self-describing fields (the verifier ignores them):
      // how addresses are derived and how states are hashed, so a future
      // re-deriving verifier needs nothing out-of-band.
      derivation: 'blocktrails-v0.2 chained BIP-341 TapTweak',
      stateHash: 'sha256(JSON.stringify({commit,repo,branch}))',
      states: marked.map((m) => m.state.commit),
      txo: marked.map((m) => txoUriOf(trail, m)),
      marks: trail.marks.map(publicMark),
    };
    return reply.code(200)
      .header('content-type', 'application/json; charset=utf-8')
      .header('access-control-allow-origin', '*')
      .header('x-content-type-options', 'nosniff')
      .send(JSON.stringify(doc, null, 2));
  }

  // ---- tier 2.5: NIP-98 -> push-token exchange + hosted-content routes ----

  /**
   * POST <prefix>/api/token[?ttl=seconds] — exchange ANY credential
   * getAgent accepts (NIP-98 included) for a forge bearer the git lane
   * takes in a static http.extraHeader. Deliberately getAgent-only: a
   * forge token cannot mint another forge token (no self-refresh — the
   * TTL is real). ttl is uncapped downward (ttl<=0 mints an already-
   * expired token, handy for testing) and capped upward at 30 days.
   * The exchange request itself needs no body, so a NIP-98 event with
   * just [["u",...],["method","POST"]] verifies.
   */
  async function apiTokenMint(request, reply) {
    if (request.method !== 'POST') return apiErr(reply, 405, 'method not allowed');
    await readJsonBody(request); // tolerate an (unused) JSON body under NIP-98 payload tags
    const agent = await api.auth.getAgent(request);
    if (!agent) {
      reply.header('WWW-Authenticate', 'Bearer realm="jss-forge"');
      return apiErr(reply, 401, 'authentication required');
    }
    let ttl = pushTokenTtl;
    if (request.query?.ttl !== undefined) {
      const n = Number(request.query.ttl);
      if (!Number.isFinite(n) || n > FORGE_TOKEN_MAX_TTL) {
        return apiErr(reply, 422, `ttl must be a number of seconds <= ${FORGE_TOKEN_MAX_TTL}`);
      }
      ttl = n;
    }
    const { token, iat, exp } = mintForgeToken(agent, ttl);
    api.log.info(`forge: minted push token for ${agent} (ttl ${ttl}s)`);
    return sendJson(reply, 201, { token, tokenType: 'Bearer', agent, iat, exp });
  }

  /**
   * <prefix>/api/hosted/<hex>/<uuid> — a podless agent's words, hosted by
   * the forge. GET is public (like a public pod resource); DELETE is the
   * author-only removal beat (same did:nostr identity that wrote it).
   */
  async function apiHosted(request, reply, segs) {
    if (segs.length !== 2 || !NOSTR_HEX.test(segs[0]) || !UUID_RE.test(segs[1])) {
      return apiErr(reply, 404, 'not found');
    }
    const [hex, id] = segs;
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (privateRepos && !(await requestAgent(request))) {
        reply.header('WWW-Authenticate', 'Bearer realm="jss-forge"');
        return apiErr(reply, 401, 'authentication required');
      }
      const doc = readHosted(hex, id);
      return doc ? sendJson(reply, 200, doc) : apiErr(reply, 404, 'not found');
    }
    if (request.method === 'DELETE') {
      const agent = await apiAgent(request, reply);
      if (!agent) return reply;
      if (agent !== `did:nostr:${hex}`) return apiErr(reply, 403, 'only the author may delete hosted content');
      if (!fs.existsSync(hostedPathOf(hex, id))) return apiErr(reply, 404, 'not found');
      fs.rmSync(hostedPathOf(hex, id));
      api.log.info(`forge: hosted content ${hex}/${id} deleted by its author`);
      return sendJson(reply, 200, { deleted: true });
    }
    return apiErr(reply, 405, 'method not allowed');
  }

  /** Dispatch <prefix>/api/... (segs excludes the leading 'api'). */
  async function apiHandler(request, reply, segs) {
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return apiErr(reply, 405, 'method not allowed');
    if (segs.length === 1 && segs[0] === 'token') return apiTokenMint(request, reply);
    if (segs[0] === 'hosted') return apiHosted(request, reply, segs.slice(1));
    if (segs[0] !== 'repos') return apiErr(reply, 404, 'not found');
    const rest = segs.slice(1);

    let agentOwner = null;
    if (privateRepos) {
      const agent = await requestAgent(request);
      if (!agent) {
        reply.header('WWW-Authenticate', 'Basic realm="jss-forge", charset="UTF-8"');
        return apiErr(reply, 401, 'authentication required');
      }
      agentOwner = ownerFromAgent(agent);
      if (!agentOwner) return apiErr(reply, 403, 'no pod namespace for this agent');
    }

    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (rest.length === 0) {
      return isRead ? apiRepoList(reply, privateRepos ? [agentOwner] : listOwners()) : apiErr(reply, 405, 'method not allowed');
    }

    const owner = rest[0];
    if (!OWNER_NAME.test(owner) || owner.includes('..')) return apiErr(reply, 404, 'not found');
    if (privateRepos && owner !== agentOwner) return apiErr(reply, 403, 'private forge');
    if (rest.length === 1) {
      return isRead ? apiRepoList(reply, [owner]) : apiErr(reply, 405, 'method not allowed');
    }

    const name = rest[1];
    if (!REPO_NAME.test(name) || name.includes('..') || name.endsWith('.git')) return apiErr(reply, 404, 'not found');
    if (!repoExists(owner, name)) return apiErr(reply, 404, 'not found');
    if (rest.length === 2) {
      if (request.method === 'PATCH') return apiRepoPatch(request, reply, owner, name);
      return isRead ? apiRepoMeta(reply, owner, name) : apiErr(reply, 405, 'method not allowed');
    }

    const action = rest[2];
    const tail = rest.slice(3);
    if (!['issues', 'pulls', 'fork', 'labels', 'marks', 'announce', 'edit', 'preview'].includes(action) && !isRead) return apiErr(reply, 405, 'method not allowed');
    try {
      switch (action) {
        case 'issues': return await apiIssuesHandler(request, reply, owner, name, tail);
        case 'pulls': return await apiPullsHandler(request, reply, owner, name, tail);
        case 'labels': return await apiLabelsHandler(request, reply, owner, name, tail);
        case 'marks': return await apiMarksHandler(request, reply, owner, name, tail);
        case 'announce':
          if (tail.length !== 0) return apiErr(reply, 404, 'not found');
          if (request.method !== 'POST') return apiErr(reply, 405, 'method not allowed');
          return await apiAnnounce(request, reply, owner, name);
        case 'edit':
          if (tail.length !== 0) return apiErr(reply, 404, 'not found');
          if (request.method !== 'POST') return apiErr(reply, 405, 'method not allowed');
          return await apiRepoEdit(request, reply, owner, name);
        case 'preview':
          if (tail.length !== 0) return apiErr(reply, 404, 'not found');
          if (request.method !== 'POST') return apiErr(reply, 405, 'method not allowed');
          return await apiRepoPreview(request, reply, owner, name);
        case 'nostr': return tail.length === 0 && isRead ? await apiNostr(reply, owner, name) : apiErr(reply, 404, 'not found');
        case 'search': return tail.length === 0 ? await apiSearch(reply, owner, name, request.query) : apiErr(reply, 404, 'not found');
        case 'releases': return tail.length === 0 ? await apiReleases(reply, owner, name) : apiErr(reply, 404, 'not found');
        case 'fork':
          if (tail.length !== 0) return apiErr(reply, 404, 'not found');
          if (request.method !== 'POST') return apiErr(reply, 405, 'method not allowed');
          return await apiForkCreate(request, reply, owner, name);
        case 'compare': return tail.length ? await apiCompare(reply, owner, name, tail.join('/')) : apiErr(reply, 404, 'not found');
        case 'tree': return tail.length ? await apiTree(reply, owner, name, tail) : apiErr(reply, 404, 'not found');
        case 'blob': return tail.length >= 2 ? await apiBlob(reply, owner, name, tail) : apiErr(reply, 404, 'not found');
        case 'commits': return tail.length ? await apiCommits(reply, owner, name, tail, request.query) : apiErr(reply, 404, 'not found');
        case 'commit': return tail.length === 1 ? await apiCommit(reply, owner, name, tail[0]) : apiErr(reply, 404, 'not found');
        default: return apiErr(reply, 404, 'not found');
      }
    } catch (err) {
      api.log.warn(`forge: api ${request.url} failed: ${err.message}`);
      return apiErr(reply, 404, 'not found');
    }
  }

  // ---------------------------------------------------------------- routing
  // ONE catch-all in a scope whose content-type parser hands the raw stream
  // through (gitscratch's pattern): git POST bodies reach the CGI byte-exact
  // and every UI route is a bodyless GET. A single dispatcher also dodges
  // find-my-way's param-name conflicts between /<owner>/<repo>.git/* and
  // /<owner>/<repo>/tree/... shapes.
  await api.fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (req, payload, done) => done(null, payload));

    const handler = async (request, reply) => {
      // CORS preflight: the cross-origin web-edit page sends OPTIONS before the
      // POST. Answer generically (the actual grant rides on the JSON reply).
      if (request.method === 'OPTIONS') {
        return withCors(reply).code(204).send();
      }
      const rest = request.params['*'] ?? '';
      if (rest.includes('%')) {
        // Percent-forms of . / \ never name a real object here; refuse
        // rather than guess at double-decoding.
        if (/%2e|%2f|%5c|%00/i.test(rest)) return reply.code(400).send('bad path\n');
      }
      const segs = rest.split('/').filter((s) => s !== '');

      if (segs.length === 0) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send();
        if (privateRepos) {
          const agent = await requestAgent(request);
          const agentOwner = ownerFromAgent(agent);
          if (!agent) {
            reply.header('WWW-Authenticate', 'Basic realm="jss-forge", charset="UTF-8"');
            return reply.code(401).send('authentication required\n');
          }
          if (!agentOwner) return reply.code(403).send('private forge\n');
          return indexPage(reply, agentOwner, request.query);
        }
        return indexPage(reply, null, request.query);
      }

      // <prefix>/api/... — the JSON surface. 'api' is a reserved owner
      // name: a pod user literally named "api" cannot have a namespace.
      if (segs[0] === 'api') return apiHandler(request, reply, segs.slice(1));

      // <prefix>/xlogin.js — the vendored widget, byte-identical, cached
      // hard (it only changes by re-vendoring + restart). 'xlogin.js' is
      // a reserved owner name like 'api'. Served without auth even under
      // privateRepos: it is static widget code, not forge data.
      if (segs.length === 1 && segs[0] === 'xlogin.js') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send();
        return reply.code(200)
          .header('content-type', 'application/javascript; charset=utf-8')
          .header('cache-control', 'public, max-age=31536000, immutable')
          .header('x-content-type-options', 'nosniff')
          .send(xloginSrc);
      }

      const owner = segs[0];
      if (!OWNER_NAME.test(owner) || owner.includes('..')) return notFound(reply);

      // ---- git smart-HTTP lane: /<owner>/<name>.git/...
      if (segs.length >= 2 && segs[1].endsWith('.git')) {
        const name = segs[1].slice(0, -4);
        if (!REPO_NAME.test(name) || name.includes('..') || name.endsWith('.git')) return notFound(reply);
        const subPath = segs.slice(2).join('/');
        if (!subPath && (request.method === 'GET' || request.method === 'HEAD')) {
          return reply.redirect(`${prefix}/${owner}/${name}`);
        }

        const isInfoRefs = request.method === 'GET' && subPath === 'info/refs';
        const isService = request.method === 'POST' && SERVICES.has(subPath);
        if (!isInfoRefs && !isService) return reply.code(404).send('smart HTTP endpoints only\n');
        const service = isInfoRefs ? String(request.query?.service ?? '') : subPath;
        if (!SERVICES.has(service)) {
          return reply.code(400).send('dumb HTTP protocol is not supported; use git >= 1.6.6\n');
        }

        const isWrite = service === 'git-receive-pack';
        // Forge push tokens (the NIP-98 exchange) are accepted here in
        // addition to every core scheme — a static extraHeader cannot
        // sign per-request NIP-98, a pod bearer works as before.
        const agent = await requestAgent(request);
        const agentOwner = ownerFromAgent(agent);

        if ((isWrite || privateRepos) && !agent) {
          reply.header('WWW-Authenticate', 'Basic realm="jss-forge", charset="UTF-8"');
          return reply.code(401).send('authentication required\n');
        }
        if ((isWrite || privateRepos) && agentOwner !== owner) {
          return reply.code(403).send(`this namespace belongs to ${owner}\n`);
        }

        if (!repoExists(owner, name)) {
          if (!isWrite) return reply.code(404).send('no such repository\n');
          await materialize(owner, name, agent); // push-to-create, own namespace only
        }
        // Anchoring advance (3.5): when a receive-pack on an enabled repo
        // finishes, compare the default-branch tip and stack a pending
        // mark if it moved. recordTip re-checks everything under the lock.
        const onExit = (isWrite && marksEnabled(owner, name))
          ? () => recordTipSafe(owner, name)
          : undefined;
        return runBackend(request, reply, { owner, name, subPath, agent, onExit });
      }

      // ---- web UI lane (GET only from here on)
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send();

      if (privateRepos) {
        const agent = await requestAgent(request);
        if (!agent) {
          reply.header('WWW-Authenticate', 'Basic realm="jss-forge", charset="UTF-8"');
          return reply.code(401).send('authentication required\n');
        }
        if (ownerFromAgent(agent) !== owner) return reply.code(403).send('private forge\n');
      }

      if (segs.length === 1) return ownerPage(reply, owner);

      const name = segs[1];
      if (!REPO_NAME.test(name) || name.includes('..') || name.endsWith('.git')) return notFound(reply);
      if (!repoExists(owner, name)) return notFound(reply);

      if (segs.length === 2) return repoHome(reply, owner, name);

      const action = segs[2];
      const tail = segs.slice(3);
      try {
        switch (action) {
          case 'tree': return tail.length ? await treePage(reply, owner, name, tail) : notFound(reply);
          case 'blob': return tail.length >= 2 ? await blobPage(reply, owner, name, tail) : notFound(reply);
          case 'raw': return tail.length >= 2 ? await rawResp(reply, owner, name, tail) : notFound(reply);
          case 'commits': return tail.length ? await commitsPage(reply, owner, name, tail, request.query) : notFound(reply);
          case 'commit': return tail.length === 1 ? await commitPage(reply, owner, name, tail[0]) : notFound(reply);
          case 'branches': return tail.length === 0 ? await refsPage(reply, owner, name, 'branches') : notFound(reply);
          case 'tags': return tail.length === 0 ? await refsPage(reply, owner, name, 'tags') : notFound(reply);
          case 'search': return tail.length === 0 ? await searchPage(reply, owner, name, request.query) : notFound(reply);
          case 'releases': return tail.length === 0 ? await releasesPage(reply, owner, name) : notFound(reply);
          case 'marks': return tail.length === 0 ? await marksPage(reply, owner, name) : notFound(reply);
          case 'blocktrails.json': return tail.length === 0 ? blocktrailsResp(reply, owner, name) : notFound(reply);
          case 'archive': return tail.length ? await archiveResp(reply, owner, name, tail) : notFound(reply);
          case 'compare': return tail.length ? await comparePage(reply, owner, name, tail.join('/')) : notFound(reply);
          case 'pulls': {
            if (tail.length === 0) return await pullsListPage(reply, owner, name, request.query);
            if (tail.length === 1 && tail[0] === 'new') return await newPullPage(reply, owner, name, request.query);
            if (ISSUE_NUM_RE.test(tail[0])) {
              if (tail.length === 1) return await pullPage(reply, owner, name, +tail[0]);
              if (tail.length === 2 && tail[1] === 'commits') return await pullCommitsPage(reply, owner, name, +tail[0]);
              if (tail.length === 2 && tail[1] === 'files') return await pullFilesPage(reply, owner, name, +tail[0]);
            }
            return notFound(reply);
          }
          case 'issues': {
            if (tail.length === 0) return await issuesListPage(reply, owner, name, request.query);
            if (tail.length === 1 && tail[0] === 'new') return await newIssuePage(reply, owner, name);
            if (tail.length === 1 && ISSUE_NUM_RE.test(tail[0])) return await issueThreadPage(reply, owner, name, +tail[0]);
            return notFound(reply);
          }
          default: return notFound(reply);
        }
      } catch (err) {
        api.log.warn(`forge: ${request.method} ${request.url} failed: ${err.message}`);
        return notFound(reply);
      }
    };

    scope.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: prefix || '/', handler });
    scope.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: `${prefix}/*`, handler });
  });

  api.log.info(
    `forge: repos at ${prefix}/<owner>/<name>.git, UI at ${prefix}/, issues at ${prefix}/<owner>/<name>/issues, `
    + `pulls at ${prefix}/<owner>/<name>/pulls, push tokens at ${prefix}/api/token, xlogin at ${prefix}/xlogin.js `
    + `(backend ${backend}, reads ${privateRepos ? 'owner-only' : 'public'}, `
    + `merges ${mergeTreeOk ? 'on' : `OFF — ${gitVersion} lacks merge-tree --write-tree`}, `
    + `anchoring on ${chain} — derive-and-record only, no chain I/O)`,
  );

  return { deactivate() { /* nothing persistent to tear down */ } };
}
