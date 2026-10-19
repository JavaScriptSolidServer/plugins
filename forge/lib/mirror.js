// forge/lib/mirror.js — mirror repos on their NIP-34 repository state.
//
// gitmark's `git mark announce` publishes a kind-30618 "repository state"
// after every mark: d = repo name, HEAD, one refs/heads/<branch> tag per
// branch with its commit, and the latest mark as chain/txo/commit tags. It
// is replaceable, so the newest one from the agent's key says where the repo
// is now. A forge that follows that key pulls when the state changes and
// moves a branch only to a commit it fetched and, when the state carries a
// mark, whose trail file lists the marked commit.
//
// This module is the pure part: config parsing, event checks, the plan for
// one state, and the verdict for one branch. No I/O; plugin.js does the
// sockets and the git.
import crypto from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1';

export const KIND_ANNOUNCE = 30617;
export const KIND_STATE = 30618;
export const MAX_FOLLOW = 50;
export const MIN_FETCH_INTERVAL_MS = 30_000;

const HEX64 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const RELAY = /^wss?:\/\/[^\s;'"]+$/i;
const CLONE = /^(https?:\/\/|file:\/\/)[^\s;'"]+$/i;

/**
 * config.mirror -> { relays, follow, minIntervalMs } or null when the mirror
 * is off. Off is the default: no sockets, no fetches. Every followed repo is
 * (pubkey, name): the agent key that signs the state and the d tag it uses.
 * A clone URL may be given; otherwise the newest 30617 from the same key
 * supplies one.
 */
export function parseMirrorConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const relays = (Array.isArray(cfg.relays) ? cfg.relays : []).filter((r) => typeof r === 'string' && RELAY.test(r));
  const follow = [];
  for (const f of Array.isArray(cfg.follow) ? cfg.follow : []) {
    if (!f || typeof f !== 'object') continue;
    const pubkey = String(f.pubkey || '').toLowerCase();
    const name = String(f.name || '');
    if (!HEX64.test(pubkey) || !NAME.test(name)) continue;
    const clone = typeof f.clone === 'string' && CLONE.test(f.clone) ? f.clone : null;
    if (!follow.some((x) => x.pubkey === pubkey && x.name === name)) follow.push({ pubkey, name, clone });
    if (follow.length >= MAX_FOLLOW) break;
  }
  if (!relays.length || !follow.length) return null;
  const minIntervalMs = Number.isInteger(cfg.minIntervalMs) && cfg.minIntervalMs >= 0 ? cfg.minIntervalMs : MIN_FETCH_INTERVAL_MS;
  return { relays, follow, minIntervalMs };
}

/** The followed entry a (pubkey, d) pair names, or null. Never by name alone. */
export function followedEntry(follow, pubkey, d) {
  return follow.find((f) => f.pubkey === pubkey && f.name === d) || null;
}

/** NIP-01: the id is the hash of the canonical form and the sig is over the id. */
export function verifyEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (!HEX64.test(String(ev.pubkey)) || !HEX64.test(String(ev.id)) || typeof ev.sig !== 'string') return false;
  if (!Number.isInteger(ev.created_at) || !Number.isInteger(ev.kind) || !Array.isArray(ev.tags) || typeof ev.content !== 'string') return false;
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'))) return false;
  const id = crypto.createHash('sha256')
    .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]), 'utf8').digest('hex');
  if (id !== ev.id) return false;
  try { return schnorr.verify(ev.sig, ev.id, ev.pubkey); } catch { return false; }
}

const tagValue = (ev, name) => { const t = ev.tags.find((x) => x[0] === name); return t ? t[1] : null; };

/**
 * What a 30618 says: its d, the symbolic HEAD, every well-formed branch ref
 * with its full sha, and the mark when all three tags are present.
 */
export function readState(ev) {
  const d = tagValue(ev, 'd');
  if (d === null) return null;
  const refs = {};
  for (const t of ev.tags) if (BRANCH.test(t[0]) && SHA40.test(String(t[1] || '').toLowerCase())) refs[t[0]] = t[1].toLowerCase();
  const headTag = tagValue(ev, 'HEAD');
  const head = headTag && /^ref: (refs\/heads\/\S+)$/.test(headTag) ? headTag.slice(5) : null;
  const chain = tagValue(ev, 'chain');
  const txo = tagValue(ev, 'txo');
  const commit = tagValue(ev, 'commit');
  const mark = chain && txo && SHA40.test(String(commit || '').toLowerCase()) ? { chain, txo, commit: commit.toLowerCase() } : null;
  return { d, head, refs, mark, createdAt: ev.created_at, id: ev.id };
}

/** The clone URLs a 30617 offers, in order, https and http only. */
export function readClones(ev) {
  const out = [];
  for (const t of ev.tags) if (t[0] === 'clone') for (const u of t.slice(1)) if (CLONE.test(u) && !u.startsWith('file:') && !out.includes(u)) out.push(u);
  return out;
}

/**
 * Whether to fetch for a state, and which branches it would move.
 * @param {object} o
 * @param {object} o.state - from readState
 * @param {Record<string,string>} o.local - refs/heads/<b> -> sha the mirror has now
 * @param {number} [o.lastSeenAt] - created_at of the last state acted on
 * @param {number} [o.lastFetchAt] - ms clock of the last fetch
 * @param {number} o.now - ms clock
 * @param {number} o.minIntervalMs
 * @returns {{action: 'fetch'|'skip', reason: string, changed: [string, string][]}}
 */
export function planMirror({ state, local, lastSeenAt = 0, lastFetchAt = 0, now, minIntervalMs }) {
  if (!state) return { action: 'skip', reason: 'not a repository state', changed: [] };
  if (state.createdAt <= lastSeenAt) return { action: 'skip', reason: 'not newer than the last state acted on', changed: [] };
  const changed = Object.entries(state.refs).filter(([ref, sha]) => local[ref] !== sha);
  if (!Object.keys(state.refs).length) return { action: 'skip', reason: 'the state names no branch', changed: [] };
  if (!changed.length) return { action: 'skip', reason: 'already at this state', changed: [] };
  if (now - lastFetchAt < minIntervalMs) return { action: 'skip', reason: `fetched ${Math.round((now - lastFetchAt) / 1000)} s ago; next in ${Math.ceil((minIntervalMs - (now - lastFetchAt)) / 1000)} s`, changed };
  return { action: 'fetch', reason: `${changed.length} branch${changed.length === 1 ? '' : 'es'} moved`, changed };
}

/** Does a gitmark trail document list this commit among its states? */
export function trailLists(raw, commit) {
  let doc;
  try { doc = JSON.parse(raw); } catch { return false; }
  if (!doc || doc.profile !== 'gitmark' || !Array.isArray(doc.states)) return false;
  return doc.states.some((s) => String(s).toLowerCase() === commit);
}

/**
 * The verdict for one branch after the fetch.
 * @param {object} o
 * @param {boolean} o.fetched - the commit is in the mirror after the fetch
 * @param {object|null} o.mark - the state's mark, if any
 * @param {string|null} o.trail - the trail file at the commit, or null when absent
 * @returns {{move: boolean, verdict: string}}
 */
export function branchVerdict({ fetched, mark, trail }) {
  if (!fetched) return { move: false, verdict: 'the remote does not have the commit the state names' };
  if (!mark) return { move: true, verdict: 'fetched; the state carries no mark' };
  if (trail === null) return { move: false, verdict: 'the state carries a mark but the commit has no trail file' };
  if (!trailLists(trail, mark.commit)) return { move: false, verdict: `the trail at the commit does not list the marked commit ${mark.commit.slice(0, 8)}` };
  return { move: true, verdict: `fetched; the trail lists mark ${mark.commit.slice(0, 8)} on ${mark.chain}` };
}
