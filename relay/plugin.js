// NIP-01 nostr relay as a #206 loader plugin.
//
//   plugins: [{ module: 'relay/plugin.js', prefix: '/relay',
//               config: { maxEvents: 1000, persist: true } }]
//
// Out-of-tree port of JSS src/nostr/relay.js (AGPL-3.0-only). Differences
// from core, all deliberate:
//   - the WebSocket goes through api.ws.route — no @fastify/websocket dep,
//     no touching the server's upgrade handling;
//   - event verification is vendored (relay/nip01.js) because core's
//     src/nostr/event.js is internal — see NOTES.md;
//   - optionally persists events to api.storage.pluginDir() as JSONL, so a
//     restart keeps the relay's memory (core's is in-memory only).

import fs from 'node:fs';
import path from 'node:path';
import { validateEvent, verifyEvent } from './nip01.js';

const DEFAULT_MAX_EVENTS = 1000;
const DEFAULT_RATE_LIMIT = 60; // events per socket per minute
const RATE_WINDOW_MS = 60_000;

function eventPassesFilter(event, filter) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  if (filter.until && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && key.length === 2) {
      const tagName = key[1];
      const eventTagValues = event.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
      if (!values.some((v) => eventTagValues.includes(v))) return false;
    }
  }
  return true;
}

const isReplaceable = (kind) => (kind >= 10000 && kind < 20000) || kind === 0 || kind === 3;
const isEphemeral = (kind) => kind >= 20000 && kind < 30000;
const isParamReplaceable = (kind) => kind >= 30000 && kind < 40000;
const dTag = (tags) => tags.find((t) => t[0] === 'd')?.[1];

export async function activate(api) {
  const wsPath = api.prefix || '/relay';
  const maxEvents = api.config.maxEvents ?? DEFAULT_MAX_EVENTS;
  const rateLimit = api.config.rateLimit ?? DEFAULT_RATE_LIMIT;
  const persist = api.config.persist ?? true;

  const events = [];
  const subscribers = new Map(); // socket -> filters
  const rateLimits = new Map(); // socket -> { count, resetTime }

  // -------------------------------------------------------- persistence
  const eventsFile = persist ? path.join(api.storage.pluginDir(), 'events.jsonl') : null;
  if (eventsFile && fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (validateEvent(event)) events.push(event);
      } catch { /* torn write at shutdown; skip */ }
    }
    while (events.length > maxEvents) events.shift();
    api.log.info(`relay: restored ${events.length} events`);
  }
  function persistAll() {
    if (!eventsFile) return;
    fs.writeFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  }

  function checkRateLimit(socket) {
    const now = Date.now();
    let limit = rateLimits.get(socket);
    if (!limit || now > limit.resetTime) {
      limit = { count: 0, resetTime: now + RATE_WINDOW_MS };
      rateLimits.set(socket, limit);
    }
    limit.count++;
    return limit.count <= rateLimit;
  }

  function storeEvent(event) {
    if (isEphemeral(event.kind)) return;
    if (isReplaceable(event.kind) || isParamReplaceable(event.kind)) {
      const i = events.findIndex((e) =>
        e.pubkey === event.pubkey && e.kind === event.kind &&
        (!isParamReplaceable(event.kind) || dTag(e.tags) === dTag(event.tags)));
      if (i !== -1) {
        events[i] = event;
        persistAll();
        return;
      }
    }
    if (events.length >= maxEvents) events.shift();
    events.push(event);
    persistAll();
  }

  function processMessage(type, value, rest, socket) {
    switch (type) {
      case 'EVENT': {
        if (!checkRateLimit(socket)) {
          socket.send(JSON.stringify(['OK', value?.id || '', false, 'rate-limited: too many events']));
          return;
        }
        const event = value;
        if (!(validateEvent(event) && verifyEvent(event))) {
          socket.send(JSON.stringify(['OK', event?.id || '', false, 'invalid: bad signature or format']));
          return;
        }
        storeEvent(event);
        subscribers.forEach((filters, subscriber) => {
          for (const filter of filters) {
            if (eventPassesFilter(event, filter)) {
              try {
                subscriber.send(JSON.stringify(['EVENT', filter.subscription_id, event]));
              } catch { /* closing socket; cleaned up on close */ }
            }
          }
        });
        socket.send(JSON.stringify(['OK', event.id, true, '']));
        return;
      }
      case 'REQ': {
        const subscriptionId = value;
        const filters = rest.map((f) => ({ ...f, subscription_id: subscriptionId }));
        subscribers.set(socket, filters);
        for (const filter of filters) {
          const matching = events.filter((e) => eventPassesFilter(e, filter));
          const limited = filter.limit ? matching.slice(-filter.limit) : matching;
          for (const event of limited) {
            socket.send(JSON.stringify(['EVENT', filter.subscription_id, event]));
          }
        }
        socket.send(JSON.stringify(['EOSE', subscriptionId]));
        return;
      }
      case 'CLOSE': {
        const remaining = (subscribers.get(socket) || []).filter((f) => f.subscription_id !== value);
        if (remaining.length === 0) subscribers.delete(socket);
        else subscribers.set(socket, remaining);
        return;
      }
      default:
        socket.send(JSON.stringify(['NOTICE', `Unknown message type: ${type}`]));
    }
  }

  await api.ws.route(wsPath, (socket) => {
    socket.on('message', (data) => {
      try {
        const [type, value, ...rest] = JSON.parse(String(data));
        processMessage(type, value, rest, socket);
      } catch (e) {
        socket.send(JSON.stringify(['NOTICE', `Error: ${e.message}`]));
      }
    });
    const cleanup = () => {
      subscribers.delete(socket);
      rateLimits.delete(socket);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  api.log.info(`relay: NIP-01 websocket at ${wsPath}${eventsFile ? ' (persistent)' : ''}`);
  return {
    deactivate() {
      persistAll();
      for (const socket of subscribers.keys()) {
        try { socket.close(); } catch { /* already gone */ }
      }
    },
  };
}
