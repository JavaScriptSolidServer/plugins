// forge — a personal git forge (tier 1: hosting + browsing) as a #206
// loader plugin. The useful slice of Gogs/Gitea: push a repo, get a
// GitHub-style web UI for it — with the constraints that killed the last
// attempt made absolute: zero npm dependencies, zero build step, every page
// server-rendered HTML with inline CSS, all git work done by the system
// `git` binary. The only JavaScript on any page is the 3-line clone-URL
// copy button, and it degrades to a selectable input.
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
//
// Ownership: owner = the pod username derived from the pusher's WebID
// (mastodon/'s podFromWebid rule). Push-to-create: an authenticated agent
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
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

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

const RENDER_CAP = 512 * 1024; // blobs/READMEs above this: "view raw"
const PER_PAGE = 30;
const MAX_EXEC_BUFFER = 64 * 1024 * 1024;

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

/** WebID -> pod username (mastodon/'s podFromWebid rule), or null. */
function ownerFromAgent(agent) {
  if (!agent) return null;
  let u;
  try { u = new URL(agent); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // did:nostr etc: no pod namespace
  const segs = u.pathname.split('/').filter(Boolean);
  const name = (segs.length >= 2 && segs[0] !== 'profile') ? segs[0] : (u.hostname.split('.')[0] || null);
  return name && OWNER_NAME.test(name) && !name.includes('..') ? name : null;
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
`;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

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
  const privateRepos = api.config.privateRepos ?? false;
  const backend = await findBackend(api.config);

  const reposDir = path.join(api.storage.pluginDir(), 'repos');
  fs.mkdirSync(reposDir, { recursive: true });

  // Clone URLs are absolute: origin from api.serverInfo (#601), resolved at
  // REQUEST time (with port 0 it only exists once listening); config.baseUrl
  // stays as the reverse-proxy override. Falls back to origin-relative.
  function publicOrigin() {
    if (api.config.baseUrl) return String(api.config.baseUrl).replace(/\/$/, '');
    try { return String(api.serverInfo().baseUrl).replace(/\/$/, ''); } catch { return ''; }
  }
  const cloneUrlOf = (owner, name) => `${publicOrigin()}${prefix}/${owner}/${name}.git`;

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
    return { owner, name, description, lastPush };
  }

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
    fs.writeFileSync(path.join(dir, 'hooks', 'post-receive'), POST_RECEIVE_HOOK, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify({ createdAt: Date.now(), creator: agent ?? null }, null, 2));
    api.log.info(`forge: created ${owner}/${name}.git for ${agent}`);
    return dir;
  }

  // ------------------------------------------------------------- CGI bridge
  // gitscratch's runBackend, re-rooted at repos/<owner>/<name>.git.
  function runBackend(request, reply, { owner, name, subPath, agent }) {
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
        } else if (code !== 0 && stderr) {
          api.log.warn(`forge: git-http-backend exited ${code}: ${stderr.trim()}`);
        }
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
      .header('content-security-policy', CSP)
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
    const tabs = [
      ['code', 'Code', base],
      ['commits', 'Commits', `${base}/commits/${branch}`],
      ['branches', 'Branches', `${base}/branches`],
      ['tags', 'Tags', `${base}/tags`],
    ].map(([id, label, href]) => `<a class="tab${tab === id ? ' active' : ''}" href="${href}">${label}</a>`).join('');
    return `<div class="repo-strip"><div class="container">
<div class="crumb">${ICON_REPO} <a href="${prefix}/${owner}">${esc(owner)}</a><span class="muted">/</span><a href="${base}"><b>${esc(name)}</b></a>
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

  async function indexPage(reply, ownerFilter = null) {
    const cards = [];
    for (const owner of (ownerFilter ? [ownerFilter] : listOwners())) {
      for (const name of listRepoNames(owner)) {
        if (cards.length >= 200) break;
        cards.push(await repoSummary(owner, name));
      }
    }
    cards.sort((a, b) => (b.lastPush ?? 0) - (a.lastPush ?? 0));
    const body = cards.length ? cards.map((r) => `<div class="repocard">
<h3>${ICON_REPO} <a href="${prefix}/${r.owner}">${esc(r.owner)}</a><span class="muted">/</span><a href="${prefix}/${r.owner}/${r.name}"><b>${esc(r.name)}</b></a> <span class="badge">${privateRepos ? 'Private' : 'Public'}</span></h3>
${r.description ? `<div class="muted">${esc(r.description)}</div>` : ''}
${r.lastPush ? `<div class="muted" style="font-size:12px;margin-top:4px">Updated ${relTime(r.lastPush)}</div>` : '<div class="muted" style="font-size:12px;margin-top:4px">Empty repository</div>'}
</div>`).join('\n')
      : `<div class="empty"><h3>No repositories yet</h3><p class="muted">Push to create one:</p>
<pre>git remote add forge &lt;origin&gt;${prefix}/&lt;your-username&gt;/&lt;name&gt;.git
git push forge main</pre></div>`;
    return sendHtml(reply, 200, page('Repositories · Forge', `<main><div class="container"><h1 class="page">Repositories</h1>${body}</div></main>`));
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
${r.description ? `<div class="muted">${esc(r.description)}</div>` : ''}
${r.lastPush ? `<div class="muted" style="font-size:12px;margin-top:4px">Updated ${relTime(r.lastPush)}</div>` : '<div class="muted" style="font-size:12px;margin-top:4px">Empty repository</div>'}
</div>`).join('\n') || '<p class="muted">No repositories.</p>';
    return sendHtml(reply, 200, page(`${owner} · Forge`, `<main><div class="container"><h1 class="page">${identicon(owner, 28)} ${esc(owner)}</h1>${body}</div></main>`));
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

  async function repoHome(reply, owner, name) {
    const dir = repoDirOf(owner, name);
    const branch = await defaultBranch(dir);
    const branches = await listRefs(dir, 'heads');
    const tags = await listRefs(dir, 'tags');
    const base = `${prefix}/${owner}/${name}`;

    if (!branches.length) {
      const body = `${repoStrip(owner, name, 'code', branch)}<main><div class="container">
<div style="display:flex;justify-content:flex-end">${cloneBox(owner, name)}</div>
<div class="empty"><h3>This repository is empty</h3>
<p class="muted">Push an existing repository to populate it:</p>
<pre>git remote add forge &lt;origin&gt;${base}.git
git push -u forge ${esc(branch)}</pre></div></div></main>`;
      return sendHtml(reply, 200, page(`${owner}/${name} · Forge`, body));
    }

    const entries = await lsTree(dir, branch, '');
    const tip = await lastCommit(dir, branch, '');
    const readme = await findReadme(dir, branch, entries);
    const body = `${repoStrip(owner, name, 'code', branch)}<main><div class="container">
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
${branchSelector(owner, name, 'tree', branch, branches, tags, '')}
${cloneBox(owner, name)}
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
<h1 class="page">${kind === 'branches' ? 'Branches' : 'Tags'}</h1>
<div class="list">${rows || `<div class="row muted">No ${kind} yet.</div>`}</div>
</div></main>`;
    return sendHtml(reply, 200, page(`${kind} · ${owner}/${name}`, body));
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

  /** Dispatch <prefix>/api/... (segs excludes the leading 'api'). */
  async function apiHandler(request, reply, segs) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return apiErr(reply, 405, 'method not allowed');
    if (segs[0] !== 'repos') return apiErr(reply, 404, 'not found');
    const rest = segs.slice(1);

    let agentOwner = null;
    if (privateRepos) {
      const agent = await api.auth.getAgent(request);
      if (!agent) {
        reply.header('WWW-Authenticate', 'Basic realm="jss-forge", charset="UTF-8"');
        return apiErr(reply, 401, 'authentication required');
      }
      agentOwner = ownerFromAgent(agent);
      if (!agentOwner) return apiErr(reply, 403, 'no pod namespace for this agent');
    }

    if (rest.length === 0) return apiRepoList(reply, privateRepos ? [agentOwner] : listOwners());

    const owner = rest[0];
    if (!OWNER_NAME.test(owner) || owner.includes('..')) return apiErr(reply, 404, 'not found');
    if (privateRepos && owner !== agentOwner) return apiErr(reply, 403, 'private forge');
    if (rest.length === 1) return apiRepoList(reply, [owner]);

    const name = rest[1];
    if (!REPO_NAME.test(name) || name.includes('..') || name.endsWith('.git')) return apiErr(reply, 404, 'not found');
    if (!repoExists(owner, name)) return apiErr(reply, 404, 'not found');
    if (rest.length === 2) return apiRepoMeta(reply, owner, name);

    const action = rest[2];
    const tail = rest.slice(3);
    try {
      switch (action) {
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
          const agent = await api.auth.getAgent(request);
          const agentOwner = ownerFromAgent(agent);
          if (!agent) {
            reply.header('WWW-Authenticate', 'Basic realm="jss-forge", charset="UTF-8"');
            return reply.code(401).send('authentication required\n');
          }
          if (!agentOwner) return reply.code(403).send('private forge\n');
          return indexPage(reply, agentOwner);
        }
        return indexPage(reply);
      }

      // <prefix>/api/... — the JSON surface. 'api' is a reserved owner
      // name: a pod user literally named "api" cannot have a namespace.
      if (segs[0] === 'api') return apiHandler(request, reply, segs.slice(1));

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
        const agent = await api.auth.getAgent(request);
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
        return runBackend(request, reply, { owner, name, subPath, agent });
      }

      // ---- web UI lane (GET only from here on)
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send();

      if (privateRepos) {
        const agent = await api.auth.getAgent(request);
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
          default: return notFound(reply);
        }
      } catch (err) {
        api.log.warn(`forge: ${request.method} ${request.url} failed: ${err.message}`);
        return notFound(reply);
      }
    };

    scope.route({ method: ['GET', 'POST'], url: prefix || '/', handler });
    scope.route({ method: ['GET', 'POST'], url: `${prefix}/*`, handler });
  });

  api.log.info(
    `forge: repos at ${prefix}/<owner>/<name>.git, UI at ${prefix}/ (backend ${backend}, reads ${privateRepos ? 'owner-only' : 'public'})`,
  );

  return { deactivate() { /* nothing persistent to tear down */ } };
}
