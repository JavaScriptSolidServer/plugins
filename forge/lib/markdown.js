// forge/lib/markdown.js — the forge's bounded, escape-first markdown renderer,
// extracted from plugin.js. Deliberately small grammar, structurally XSS-proof:
// raw text is HTML-escaped BEFORE any tag is introduced. Blocks: #..###### h1-h6,
// ``` fenced code, > blockquote, -/* and 1. lists, GFM tables, paragraphs. No
// nesting, no HTML passthrough. Inline: `code` **bold** *em*/_em_ [t](href)
// ![alt](src). Only renderMarkdown is public (mdInline/safeHref stay internal).
import { esc } from './helpers.js';

const TABLE_COL_CAP = 100;   // columns rendered per table (defense in depth)
const TABLE_ROW_CAP = 1000;  // body rows rendered per table

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

// --- GFM tables: a header row (any line with a pipe) immediately followed by a
// delimiter row of dashes/colons — | --- | :--: | ---: | — with optional outer
// pipes. Colons set per-column alignment. Cells are inline-only, escaped first.
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  t = t.replace(/\|\s*$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}
function alignOf(cell) {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
}

export function renderMarkdown(src, ctx) {
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
    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      flushAll();
      const header = splitRow(line).slice(0, TABLE_COL_CAP);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && !/^\s*$/.test(lines[j]) && rows.length < TABLE_ROW_CAP) {
        rows.push(splitRow(lines[j])); j += 1;
      }
      const cell = (txt, tag, al) => `<${tag}${al ? ` style="text-align:${al}"` : ''}>${mdInline(esc(txt ?? ''), ctx)}</${tag}>`;
      const thead = `<tr>${header.map((c, k) => cell(c, 'th', aligns[k])).join('')}</tr>`;
      const tbody = rows.map((r) => `<tr>${header.map((_, k) => cell(r[k], 'td', aligns[k])).join('')}</tr>`).join('');
      out.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
      i = j - 1;
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
