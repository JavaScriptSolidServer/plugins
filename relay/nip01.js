// NIP-01 event utilities — verifier + (test-facing) signer.
// Adapted from JSS src/nostr/event.js (AGPL-3.0-only), trimmed to what the
// relay plugin needs. Lives here because event verification is *internal*
// to JSS (src/nostr/event.js is not a documented import) — an out-of-tree
// relay brings its own crypto. See NOTES.md: "internal utility modules".

import { schnorr } from '@noble/curves/secp256k1';
import { createHash } from 'node:crypto';

const HEX_64 = /^[a-f0-9]{64}$/;
const HEX_128 = /^[a-f0-9]{128}$/;

export function getEventHash(event) {
  const payload = JSON.stringify([
    0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function validateEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (!HEX_64.test(event.id ?? '')) return false;
  if (!HEX_64.test(event.pubkey ?? '')) return false;
  if (!HEX_128.test(event.sig ?? '')) return false;
  if (!Number.isInteger(event.created_at)) return false;
  if (!Number.isInteger(event.kind) || event.kind < 0) return false;
  if (typeof event.content !== 'string') return false;
  if (!Array.isArray(event.tags)) return false;
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.some((t) => typeof t !== 'string')) return false;
  }
  return true;
}

export function verifyEvent(event) {
  try {
    if (getEventHash(event) !== event.id) return false;
    return schnorr.verify(event.sig, event.id, event.pubkey);
  } catch {
    return false;
  }
}

// ---- signer half: used by tests and dev tooling, not by the relay ----

export function generateSecretKey() {
  return schnorr.utils.randomPrivateKey();
}

export function getPublicKey(secretKey) {
  return Buffer.from(schnorr.getPublicKey(secretKey)).toString('hex');
}

export function finalizeEvent(template, secretKey) {
  const event = {
    kind: template.kind ?? 1,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    tags: template.tags ?? [],
    content: template.content ?? '',
    pubkey: getPublicKey(secretKey),
  };
  event.id = getEventHash(event);
  event.sig = Buffer.from(schnorr.sign(event.id, secretKey)).toString('hex');
  return event;
}
