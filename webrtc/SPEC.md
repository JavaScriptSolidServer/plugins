# Pod Signaling Protocol — Draft 0.0.1

A WebSocket signaling protocol for WebRTC peers, as implemented by
JavaScriptSolidServer (`--webrtc`, mounted at `/.webrtc`) and the
out-of-tree `webrtc` plugin. One socket, three dialects: identity-routed
signaling, content-addressed rooms, and WebTorrent tracker
compatibility.

> **License of this document: CC0-1.0** (public domain dedication). It
> may be implemented, copied, and modified without restriction and
> without attribution. The JSS *reference implementation* is
> AGPL-3.0-only; implementing this specification independently creates
> no obligation under that license, and talking to an AGPL server from
> any client never does.

**Live endpoint for interop testing:** `wss://melvin.me/.webrtc`

The key words MUST, SHOULD, MAY are to be interpreted as in RFC 2119.

---

## 1. Design position

This protocol is one layer of a larger interoperable stack, and claims
only its own layer:

| layer | role | this spec? |
|---|---|---|
| wide-area discovery | "who has this content, anywhere?" (e.g. Nostr relay events) | no |
| **connection setup** | **rendezvous + SDP/ICE exchange, fast and stateful** | **yes** |
| identity | WebID / did:nostr, verified at the socket; optionally re-proved peer-to-peer | partly (§6, §8) |
| payload | HLS segments, torrent pieces, game state, calls — over RTCDataChannel/media | no |

The server's only job is to **introduce peers**. After offer/answer
exchange, media and data flow directly between them; the server never
sees payload traffic.

## 2. Transport and connection

- Transport is a WebSocket. Every frame is a single JSON object encoded
  as UTF-8 text.
- The server MUST enforce a maximum message size (default 64 KiB) and
  reply to oversized frames with an [error frame](#4-error-frames).
- Authentication is OPTIONAL and happens at connection time, from the
  upgrade request:
  - `Authorization: Bearer <token>` header, or
  - `?token=<token>` query parameter (browser `WebSocket` cannot set
    headers; servers MUST accept this equivalent).
  - Servers MAY accept other schemes carried on the upgrade request
    (DPoP, NIP-98).
- A successfully authenticated connection is bound to an **agent id**:
  a WebID URI or a [`did:nostr:`](https://did-nostr.com) DID. Anonymous
  connections are valid
  and may use the content-addressed and tracker dialects only.
- Every connection is assigned a server-scoped, opaque **peer id**
  (string). It appears as `from` in relayed room frames.

### 2.1 Timing rules (normative — both have bitten real implementations)

- The server MUST buffer any message that arrives before its
  authentication of the connection completes, and process the backlog
  in arrival order before newer messages. (An anonymous client may
  legally speak immediately after `open`.)
- The server MAY send its first frame (the §5 welcome) in the same TCP
  segment as the `101` upgrade response. Non-browser clients MUST
  therefore attach their message listener before yielding to the event
  loop after socket creation — a listener attached after `await open`
  can silently miss the first frame. Browser `WebSocket` queues events
  as tasks and is unaffected.

## 3. Dialect dispatch

For each incoming frame, in order:

1. `action == "announce"` → WebTorrent tracker dialect (§7).
2. `type == "announce"` → content-addressed room announce (§6).
3. `type == "answer"` **and** `resource` present → room answer (§6).
4. `type == "leave"` → room leave (§6).
5. Otherwise → identity dialect (§5); requires authentication.

Consequence (normative): an identity-dialect `answer` MUST NOT carry a
`resource` field, or it will be routed as a room answer.

## 4. Error frames

`{ "type": "error", "message": "<text>" }`, optionally with extra
fields (e.g. `peer`). Messages defined by this spec:

| condition | message |
|---|---|
| frame exceeds size limit | `Message too large` |
| frame is not valid JSON | `Invalid JSON` |
| no `type` and no `action` | `Missing "type" field` |
| room hash fails the grammar | `Invalid resource hash` |
| too many rooms for one peer | `Too many resources` |
| room answer target unknown/gone | `Peer not in resource group` |
| identity frame while anonymous | `Authentication required for identity-based signaling` |
| identity frame without `to` | `Missing "to" field` |
| identity frame with unknown type | `Unknown type "<type>"` |
| identity target absent/closed | `Peer not online` (+ `peer` field) |

Errors never close the connection.

## 5. Identity dialect (authenticated)

For calls and any peer-addressed session between known agents.

**Welcome.** On successful authentication the server MUST send:

```json
{ "type": "peers", "you": "<agentId>", "peerId": "<peer id>",
  "peers": ["<other agentId>", "..."] }
```

**Presence.** On a *fresh* join the server broadcasts
`{ "type": "peer-joined", "webId": "<agentId>" }` to all other
identity peers; on disconnect, `{ "type": "peer-left", "webId": ... }`.
The field name is `webId` for wire compatibility even when the value is
a DID.

**Reconnects.** A new authenticated connection for an agent already
registered MUST replace the old one: the server closes the old socket,
removes its room memberships, and MUST NOT broadcast `peer-joined`
(it is not a fresh join) — nor `peer-left` for the replaced socket.

**Relayed types.** `offer`, `answer`, `candidate`, `hangup`. The sender
addresses an agent: `{ "type": "offer", "to": "<agentId>",
"sdp": "..." }`. The server relays to the target with `to` replaced by
`from: "<sender agentId>"`. Relays are whitelisted — only `type`,
`from`, `sdp` (string) and `candidate` (non-array object) survive;
unknown fields MUST be dropped (no application side-channel through the
relay, no prototype-pollution vector).

A typical call: `offer` → `answer` → trickled `candidate`s both ways →
either side `hangup`.

## 6. Content-addressed rooms (anonymous OK)

The rendezvous primitive: a **room is a hex hash**, matching
`^[a-fA-F0-9]{8,128}$`. By convention the hash identifies content
(SHA-256 of a segment, manifest, or torrent info-hash) — making
discovery-by-content and integrity-by-construction the same act. The
server treats it as an opaque room key.

**Join / announce.**
`{ "type": "announce", "resource": "<hash>", "offers": [ { "offer_id":
"<id>", "sdp": "..." }, ... ] }`

- The server adds the peer to the room (creating it if needed) and
  replies `{ "type": "resource-peers", "resource": "<hash>",
  "count": <peers already present> }`.
- Offers are distributed **one per existing peer**, pairing offer *i*
  with existing peer *i*, at most `maxOffersPerAnnounce` (default 10):
  each receiving peer gets
  `{ "type": "offer", "resource": "<hash>", "from": "<peer id>",
  "offer_id": "<id>", "sdp": "..." }`.
  A client that wants to connect to *n* existing peers therefore
  announces *n* offers. Offers without a string `sdp` are skipped;
  a missing `offer_id` is replaced by the offer's index.
- Announcing again in the same room re-uses the membership (no
  duplicate join) and MAY carry fresh offers.
- A peer MAY be in at most `maxResourcesPerPeer` rooms (default 50).

**Answer.**
`{ "type": "answer", "resource": "<hash>", "to": "<peer id from the
offer's 'from'>", "offer_id": "<id>", "sdp": "..." }` — relayed to the
target as `{ "type": "answer", "resource", "from", "offer_id", "sdp" }`.
Answers into an unknown room are silently ignored; a known room with a
missing target yields `Peer not in resource group`.

**Leave.** `{ "type": "leave", "resource": "<hash>" }` — silent.
Disconnect leaves all rooms. Empty rooms MUST be garbage-collected.

After the answer arrives, both sides hold SDPs for
`RTCPeerConnection`; the server's role in the pair is over. ICE
candidates in this dialect travel inside the SDP (non-trickle) or over
the established DataChannel — the room protocol does not relay
standalone candidates.

## 7. WebTorrent tracker dialect

Stock [WebTorrent](https://webtorrent.io) clients speak their WSS
tracker protocol unmodified; the server answers as a tracker.

- Frames use `action: "announce"` with `info_hash` / `peer_id` as
  either 20-byte binary strings (WebTorrent convention) or 40-char hex.
  Binary ids are hex-normalized internally; replies MUST echo ids in
  the sender's original encoding.
- Announce with `offers: [{ offer_id, offer: { type, sdp } }, ...]`
  distributes offers one-per-existing-peer as
  `{ "action": "announce", "offer", "offer_id", "peer_id",
  "info_hash" }`.
- Answer relay: `{ "action": "announce", "answer", "offer_id",
  "to_peer_id", ... }` is forwarded to the peer whose announced
  `peer_id` matches, as `{ "action": "announce", "answer", "offer_id",
  "peer_id": <sender>, "info_hash" }`. Answer frames get no tracker
  response.
- Every non-answer announce is acknowledged with tracker stats:
  `{ "action": "announce", "info_hash", "complete": 0,
  "incomplete": <room size>, "interval": 120 }`.
- An invalid `info_hash` yields
  `{ "action": "announce", "failure reason": "invalid info_hash" }`.

**Shared namespace (normative).** Tracker info-hashes and §6 room
hashes occupy **one hex-keyed room namespace**: a WebTorrent client and
a content-addressed client announcing the same 40-hex-char hash meet in
the same room. Relayed frames are formatted in the *sender's* dialect,
so clients joining mixed rooms SHOULD accept both §6 (`type`) and §7
(`action`) offer/answer forms.

## 8. Peer-to-peer identity (extension, EXPERIMENTAL)

Socket-level auth proves identity to the *server*. Where peers need to
prove identity to *each other* (signed bandwidth receipts, validating
nodes, ranked games), they SHOULD run a challenge over the first
DataChannel: each side sends a random 32-byte nonce; the other returns
a signature over `(nonce ‖ its own SDP fingerprint)` with the key
behind its WebID/DID (e.g. Schnorr for `did:nostr`). Binding the DTLS
fingerprint prevents relaying a challenge to a third party. This
extension is intentionally minimal and carried entirely peer-to-peer;
it needs nothing from the server.

## 9. NAT traversal companion

Signaling alone connects peers on cooperative networks; strict NATs
need TURN. The companion endpoint (`turn` plugin) mints time-limited
credentials per draft-uberti-behave-turn-rest-00:
`GET /.turn/credentials` →
`{ username, password, ttl, uris, iceServers }`, where `iceServers`
drops directly into `new RTCPeerConnection({ iceServers })` and
`username` is a unix expiry so leaked credentials die on their own.
Servers MAY require authentication to mint.

## 10. Conformance

An implementation conforms as a **client** if it can play both roles of
the golden transcript below (fresh room, live server), observing the
§2.1 buffering rule; as a **server** if a conforming client can
complete it against the implementation, and every error case in §4
answers as specified.

```
# wss://melvin.me/.webrtc — room = c0ffee006a6f34f5 (fresh; the hex hash is the only rendezvous)
A -> {"type":"announce","resource":"c0ffee006a6f34f5","offers":[]}
A <- {"type":"resource-peers","resource":"c0ffee006a6f34f5","count":0}
B -> {"type":"announce","resource":"c0ffee006a6f34f5","offers":[{"offer_id":"o1","sdp":"v=0 (dummy offer B)"}]}
A <- {"type":"offer","resource":"c0ffee006a6f34f5","from":"4","offer_id":"o1","sdp":"v=0 (dummy offer B)"}
B <- {"type":"resource-peers","resource":"c0ffee006a6f34f5","count":1}
A -> {"type":"answer","resource":"c0ffee006a6f34f5","to":"4","offer_id":"o1","sdp":"v=0 (dummy answer A)"}
B <- {"type":"answer","resource":"c0ffee006a6f34f5","from":"5","offer_id":"o1","sdp":"v=0 (dummy answer A)"}
A -> {"type":"leave","resource":"c0ffee006a6f34f5"}
B -> {"type":"leave","resource":"c0ffee006a6f34f5"}
```

The reference test suite (`test.js`, AGPL like the implementation)
exercises all three dialects and every error path; transcripts replayed
from it are the recommended first tests for a new implementation —
before any UI, before any media.

## 11. Security considerations

- **SDP leaks addresses.** Offers/answers contain candidate IPs. Rooms
  are open to anyone knowing the hash; treat room membership as public
  and rely on DTLS (mandatory in WebRTC) for transport privacy.
- **Flooding.** The size limit, per-announce offer cap, and per-peer
  room cap are the protocol's only built-in throttles; servers SHOULD
  add connection-level rate limiting.
- **Relay hygiene.** Identity relays MUST whitelist fields (§5) so the
  server cannot be used as an arbitrary message bus between agents.
- **Impersonation.** Room peer ids are unauthenticated by design;
  anything requiring identity uses the identity dialect or the §8
  challenge. Content integrity comes from hash verification of the
  payload itself, never from trusting a peer.

---

*Draft 0.0.1, 2026-08-02. Derived from the behavior of JSS core
`--webrtc` (v0.0.219) and the out-of-tree plugin port; where they
differ (pre-auth buffering), this spec follows the plugin, which is the
stricter and safer behavior.*
