// forge/lib/helpers.js — pure presentation & validation helpers extracted from
// plugin.js's "// helpers" section: HTML escaping, path/ref validators, small
// server-side formatters, and the GitHub-style SVG icon constants. No forge
// state; only node:crypto (identicon). REF_RE is re-exported because plugin.js
// also validates branch names with it.
import crypto from 'node:crypto';

// Path/ref validation regexes (BAD_SEG stays internal; REF_RE is also used by
// the caller for branch validation, so it's exported).
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const BAD_SEG = /^\.|\.\.|[\\\x00-\x1f]|%2e|%2f|%5c/i;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

export function okSegment(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && !BAD_SEG.test(s);
}
export function okPath(segs) {
  return segs.every(okSegment);
}
export function okRef(ref) {
  return REF_RE.test(ref) && !ref.includes('..') && !ref.endsWith('/') && !ref.includes('//');
}

/** Unix seconds -> "3 days ago" (server-side; no client JS needed). */
export function relTime(unixSecs) {
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
export function labelTextColor(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? '#1f2328' : '#ffffff';
}

/** Rounded-full colored chips for resolved label defs [{name, color}]. */
export function labelChips(labels) {
  return labels.map((l) => `<span class="label-chip" style="background:#${esc(l.color)};color:${labelTextColor(l.color)}">${esc(l.name)}</span>`).join(' ');
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i ? v.toFixed(1) : v} ${units[i]}`;
}

/** NUL in the first 8000 bytes => binary (git's own heuristic). */
export function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/**
 * Deterministic GitHub-style identicon: 5x5 mirrored pixel SVG from
 * md5(email), hue from the trailing hash bytes, #f0f0f0 background.
 */
export function identicon(email, px = 20) {
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

export const ICON_DIR = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#54aeff" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
export const ICON_FILE = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#59636e" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>';
export const ICON_REPO = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#59636e" aria-hidden="true"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>';
export const ICON_BRANCH = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';
export const ICON_TAG = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg>';
// GitHub's issue-opened (green circle-dot) and issue-closed (purple check).
export const ICON_ISSUE_OPEN = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#1a7f37" aria-hidden="true"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>';
export const ICON_ISSUE_CLOSED = '<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="#8250df" aria-hidden="true"><path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/></svg>';
// GitHub's git-pull-request (green open), git-merge (purple merged) and
// git-pull-request-closed (red closed) octicons — tier 3a.
const PR_PATH = 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z';
export const ICON_PR_OPEN = `<svg class="icon pr-open" width="16" height="16" viewBox="0 0 16 16" fill="#1a7f37" aria-hidden="true"><path d="${PR_PATH}"/></svg>`;
export const ICON_PR_TAB = `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${PR_PATH}"/></svg>`;
export const ICON_PR_MERGED = '<svg class="icon pr-merged" width="16" height="16" viewBox="0 0 16 16" fill="#8250df" aria-hidden="true"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/></svg>';
export const ICON_PR_CLOSED = '<svg class="icon pr-closed" width="16" height="16" viewBox="0 0 16 16" fill="#cf222e" aria-hidden="true"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';
