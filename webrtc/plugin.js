// WebRTC signaling as a #206 loader plugin.
//
//   plugins: [{ module: 'webrtc/plugin.js', prefix: '/webrtc' }]
//
// Out-of-tree port of JSS src/webrtc/index.js (AGPL-3.0-only). Same wire
// protocol as core's wss://pod/.webrtc, mounted at the entry's prefix:
//
//   Identity-based (authenticated; WebID or did:nostr via api.auth.getAgent):
//     → { type: offer|answer|candidate|hangup, to: "<agent>", ... }
//     ← same, with from: "<agent>"; plus peers / peer-joined / peer-left
//   Content-addressed (anonymous ok; resource = hex hash "room"):
//     → announce { resource, offers } / answer { resource, to, offer_id, sdp } / leave
//     ← offer / answer / resource-peers
//   WebTorrent tracker dialect ({ action: 'announce', info_hash, ... }).
//
// Differences from core, all deliberate:
//   - the WebSocket goes through api.ws.route — no @fastify/websocket dep,
//     no upgrade handling;
//   - auth is api.auth.getAgent(request) instead of internal
//     src/auth/token.js — same verifier, documented surface;
//   - messages arriving while auth is still resolving are buffered and
//     replayed in order (core attaches its handler only after the await,
//     so an eager client's first message could race the listener);
//   - deactivate() closes every socket, not just identity-registered ones;
//   - the size limits are configurable (config.maxMessageSize,
//     config.maxOffersPerAnnounce, config.maxResourcesPerPeer).

const DEFAULT_MAX_MESSAGE_SIZE = 64 * 1024; // 64KB
const DEFAULT_MAX_OFFERS_PER_ANNOUNCE = 10;
const DEFAULT_MAX_RESOURCES_PER_PEER = 50;
const ALLOWED_TYPES = new Set(['offer', 'answer', 'candidate', 'hangup']);
const RESOURCE_HASH_RE = /^[a-fA-F0-9]{8,128}$/;

// WebTorrent tracker uses 20-byte binary strings for info_hash and peer_id
function bin2hex(s) { return Buffer.from(s, 'binary').toString('hex'); }
function hex2bin(s) { return Buffer.from(s, 'hex').toString('binary'); }

export async function activate(api) {
  const wsPath = api.prefix || '/webrtc';
  const maxMessageSize = api.config.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
  const maxOffersPerAnnounce = api.config.maxOffersPerAnnounce ?? DEFAULT_MAX_OFFERS_PER_ANNOUNCE;
  const maxResourcesPerPeer = api.config.maxResourcesPerPeer ?? DEFAULT_MAX_RESOURCES_PER_PEER;

  // Identity-based peer state: Map<agentId, socket>
  const peers = new Map();
  // Content-addressed state: Map<resourceHash, Map<peerId, socket>>
  const resources = new Map();
  // Which resources each peer joined: Map<peerId, Set<resourceHash>>
  const peerResources = new Map();
  // Every live socket, for teardown (identity, content-addressed, or neither)
  const sockets = new Set();
  let nextPeerId = 1;

  function send(socket, msg) {
    try { socket.send(JSON.stringify(msg)); } catch { /* socket gone */ }
  }

  function broadcast(senderAgent, msg) {
    const data = JSON.stringify(msg);
    for (const [id, socket] of peers) {
      if (id !== senderAgent && socket.readyState === 1) {
        try { socket.send(data); } catch { /* closed between check and send */ }
      }
    }
  }

  // --- Content-addressed helpers ---

  function getResourcePeers(resourceHash) {
    let group = resources.get(resourceHash);
    if (!group) {
      group = new Map();
      resources.set(resourceHash, group);
    }
    return group;
  }

  function addPeerToResource(peerId, socket, resourceHash) {
    getResourcePeers(resourceHash).set(peerId, socket);
    let tracked = peerResources.get(peerId);
    if (!tracked) {
      tracked = new Set();
      peerResources.set(peerId, tracked);
    }
    tracked.add(resourceHash);
  }

  function removePeerFromResource(peerId, resourceHash) {
    const group = resources.get(resourceHash);
    if (group) {
      group.delete(peerId);
      if (group.size === 0) resources.delete(resourceHash);
    }
    const tracked = peerResources.get(peerId);
    if (tracked) {
      tracked.delete(resourceHash);
      if (tracked.size === 0) peerResources.delete(peerId);
    }
  }

  function removePeerFromAllResources(peerId) {
    const tracked = peerResources.get(peerId);
    if (!tracked) return;
    for (const hash of tracked) {
      const group = resources.get(hash);
      if (group) {
        group.delete(peerId);
        if (group.size === 0) resources.delete(hash);
      }
    }
    peerResources.delete(peerId);
  }

  function handleAnnounce(socket, peerId, msg) {
    const hash = msg.resource;
    if (!hash || typeof hash !== 'string' || !RESOURCE_HASH_RE.test(hash)) {
      send(socket, { type: 'error', message: 'Invalid resource hash' });
      return;
    }

    const tracked = peerResources.get(peerId);
    if (tracked && tracked.size >= maxResourcesPerPeer && !tracked.has(hash)) {
      send(socket, { type: 'error', message: 'Too many resources' });
      return;
    }

    const group = getResourcePeers(hash);
    addPeerToResource(peerId, socket, hash);

    // Relay offers to existing peers in the group, one offer per peer
    const offers = Array.isArray(msg.offers) ? msg.offers.slice(0, maxOffersPerAnnounce) : [];
    const existingPeers = [...group.entries()].filter(([id]) => id !== peerId);

    for (let i = 0; i < offers.length && i < existingPeers.length; i++) {
      const offer = offers[i];
      const [, targetSocket] = existingPeers[i];
      if (targetSocket.readyState !== 1) continue;
      if (typeof offer.sdp !== 'string') continue;

      const relay = Object.create(null);
      relay.type = 'offer';
      relay.resource = hash;
      relay.from = peerId;
      relay.offer_id = typeof offer.offer_id === 'string' ? offer.offer_id : String(i);
      relay.sdp = offer.sdp;
      send(targetSocket, relay);
    }

    send(socket, { type: 'resource-peers', resource: hash, count: group.size - 1 });
  }

  function handleResourceAnswer(socket, peerId, msg) {
    const hash = msg.resource;
    if (!hash || typeof hash !== 'string') return;

    const group = resources.get(hash);
    if (!group) return;

    const targetSocket = group.get(msg.to);
    if (!targetSocket || targetSocket.readyState !== 1) {
      send(socket, { type: 'error', message: 'Peer not in resource group' });
      return;
    }

    const relay = Object.create(null);
    relay.type = 'answer';
    relay.resource = hash;
    relay.from = peerId;
    if (typeof msg.offer_id === 'string') relay.offer_id = msg.offer_id;
    if (typeof msg.sdp === 'string') relay.sdp = msg.sdp;
    send(targetSocket, relay);
  }

  function handleLeave(socket, peerId, msg) {
    const hash = msg.resource;
    if (!hash || typeof hash !== 'string') return;
    removePeerFromResource(peerId, hash);
  }

  // --- WebTorrent tracker dialect ---

  function handleWebtorrentAnnounce(socket, peerId, msg) {
    const infoHash = typeof msg.info_hash === 'string' && msg.info_hash.length === 20
      ? bin2hex(msg.info_hash) : msg.info_hash;
    const msgPeerId = typeof msg.peer_id === 'string' && msg.peer_id.length === 20
      ? bin2hex(msg.peer_id) : msg.peer_id;

    if (!infoHash || typeof infoHash !== 'string') {
      send(socket, { action: 'announce', 'failure reason': 'invalid info_hash' });
      return;
    }

    const group = getResourcePeers(infoHash);
    addPeerToResource(peerId, socket, infoHash);
    socket._wtPeerId = msgPeerId || peerId;

    // Answer relay: find the target by its WebTorrent peer_id
    if (msg.answer && msg.to_peer_id) {
      const toPeerId = typeof msg.to_peer_id === 'string' && msg.to_peer_id.length === 20
        ? bin2hex(msg.to_peer_id) : msg.to_peer_id;
      for (const [, peerSocket] of group) {
        if (peerSocket._wtPeerId === toPeerId && peerSocket.readyState === 1) {
          send(peerSocket, {
            action: 'announce',
            answer: msg.answer,
            offer_id: msg.offer_id,
            peer_id: typeof msg.peer_id === 'string' && msg.peer_id.length === 20
              ? msg.peer_id : hex2bin(msgPeerId || peerId),
            info_hash: typeof msg.info_hash === 'string' && msg.info_hash.length === 20
              ? msg.info_hash : hex2bin(infoHash),
          });
          break;
        }
      }
      return; // no response for answers
    }

    // Relay offers to existing peers in the group
    if (Array.isArray(msg.offers) && msg.offers.length > 0) {
      const existingPeers = [...group.entries()].filter(([id]) => id !== peerId);
      for (let i = 0; i < msg.offers.length && i < existingPeers.length; i++) {
        const [, targetSocket] = existingPeers[i];
        if (targetSocket.readyState !== 1) continue;
        send(targetSocket, {
          action: 'announce',
          offer: msg.offers[i].offer,
          offer_id: msg.offers[i].offer_id,
          peer_id: typeof msg.peer_id === 'string' && msg.peer_id.length === 20
            ? msg.peer_id : hex2bin(msgPeerId || peerId),
          info_hash: typeof msg.info_hash === 'string' && msg.info_hash.length === 20
            ? msg.info_hash : hex2bin(infoHash),
        });
      }
    }

    send(socket, {
      action: 'announce',
      info_hash: typeof msg.info_hash === 'string' && msg.info_hash.length === 20
        ? msg.info_hash : hex2bin(infoHash),
      complete: 0,
      incomplete: group.size,
      interval: 120,
    });
  }

  // --- WebSocket endpoint ---

  await api.ws.route(wsPath, async (socket, request) => {
    sockets.add(socket);

    // Buffer anything that arrives while auth resolves; replayed below.
    const pending = [];
    const bufferMessage = (data) => pending.push(data);
    socket.on('message', bufferMessage);
    socket.on('error', () => { /* close follows and cleans up */ });

    // Browser WebSocket can't set headers — accept ?token= as Bearer.
    const queryToken = request.query?.token;
    if (queryToken && !request.headers.authorization) {
      request.headers.authorization = `Bearer ${queryToken}`;
    }
    // Auth is optional: anonymous sockets get content-addressed/tracker
    // modes only. agentId is a WebID or did:nostr DID.
    const agentId = await api.auth.getAgent(request);

    const peerId = String(nextPeerId++);
    socket._peerId = peerId;

    if (agentId) {
      const existing = peers.get(agentId);
      const isReconnect = !!existing;
      if (existing) {
        if (existing._peerId) removePeerFromAllResources(existing._peerId);
        peers.delete(agentId);
        existing.close();
      }
      peers.set(agentId, socket);
      socket.agentId = agentId;

      send(socket, {
        type: 'peers',
        you: agentId,
        peerId,
        peers: [...peers.keys()].filter((id) => id !== agentId),
      });

      if (!isReconnect) {
        broadcast(agentId, { type: 'peer-joined', webId: agentId });
      }
    }

    function handleMessage(data) {
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (raw.byteLength > maxMessageSize) {
        send(socket, { type: 'error', message: 'Message too large' });
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      // WebTorrent tracker dialect uses 'action' instead of 'type'
      if (msg.action === 'announce') {
        handleWebtorrentAnnounce(socket, peerId, msg);
        return;
      }

      if (!msg.type) {
        send(socket, { type: 'error', message: 'Missing "type" field' });
        return;
      }

      // Content-addressed messages (no auth required)
      if (msg.type === 'announce') {
        handleAnnounce(socket, peerId, msg);
        return;
      }
      if (msg.type === 'answer' && msg.resource) {
        handleResourceAnswer(socket, peerId, msg);
        return;
      }
      if (msg.type === 'leave') {
        handleLeave(socket, peerId, msg);
        return;
      }

      // Identity-based messages require authentication and a target
      if (!agentId) {
        send(socket, { type: 'error', message: 'Authentication required for identity-based signaling' });
        return;
      }
      if (!msg.to) {
        send(socket, { type: 'error', message: 'Missing "to" field' });
        return;
      }
      if (!ALLOWED_TYPES.has(msg.type)) {
        send(socket, { type: 'error', message: `Unknown type "${msg.type}"` });
        return;
      }

      const target = peers.get(msg.to);
      if (!target || target.readyState !== 1) {
        send(socket, { type: 'error', message: 'Peer not online', peer: msg.to });
        return;
      }

      // Whitelisted fields only (null prototype: no pollution vector)
      const relay = Object.create(null);
      relay.type = msg.type;
      relay.from = agentId;
      if (typeof msg.sdp === 'string') relay.sdp = msg.sdp;
      if (msg.candidate != null && typeof msg.candidate === 'object' && !Array.isArray(msg.candidate)) {
        relay.candidate = msg.candidate;
      }
      try { target.send(JSON.stringify(relay)); } catch {
        send(socket, { type: 'error', message: 'Peer not online', peer: msg.to });
      }
    }

    // Swap the buffer for the real handler and replay in order. This block
    // is synchronous, so no message can slip between the two listeners.
    socket.off('message', bufferMessage);
    for (const data of pending) handleMessage(data);
    socket.on('message', handleMessage);

    socket.on('close', () => {
      sockets.delete(socket);
      removePeerFromAllResources(peerId);
      // Only unregister if this socket is still the one on record
      // (a reconnect may have replaced it already)
      if (agentId && peers.get(agentId) === socket) {
        peers.delete(agentId);
        broadcast(agentId, { type: 'peer-left', webId: agentId });
      }
    });
  });

  api.log.info(`webrtc: signaling websocket at ${wsPath}`);

  return {
    deactivate() {
      for (const socket of sockets) {
        try { socket.close(); } catch { /* already gone */ }
      }
      sockets.clear();
      peers.clear();
      resources.clear();
      peerResources.clear();
    },
  };
}
