# federation-demo — two Solid servers federating over loopback, no cloud

A runnable, narrated **demo scenario** (not a plugin — there is no
`plugin.js` here): TWO independent JavaScript Solid Server instances on one
machine, each composed from `webfinger/` (actor discovery) + `activitypub/`
(the actor itself), walking real ActivityPub federation mechanics over
loopback HTTP. Server A hosts **alice**, server B hosts **bob**; every
actor URL, webfinger JRD, Follow, Accept and Create in the flow is a real
cross-origin HTTP exchange between the two live servers.

```bash
node federation-demo/demo.js                                # the narrated show
node --test --test-concurrency=1 federation-demo/test.js    # the assertions (9 tests)
```

Loopback only — no external network, no flags, exit 0 on success.

## What it walks

| step | mechanic | who does the work |
|---|---|---|
| discovery | `acct:alice@127.0.0.1:<portA>` → A's `/.well-known/webfinger` → JRD → actor doc | webfinger + activitypub plugins |
| follow | bob's Follow (his **real B-hosted actor URL**) into alice's inbox on A | driver couriers the Follow (Phase-1 plugin has no outbound-Follow client) |
| accept | A fetches bob's actor doc **from B**, resolves his inbox, delivers a **signed Accept** to B | **plugin-initiated** (A runs `allowPrivateDelivery: true`) |
| publish | alice posts a Note via her outbox (owner Bearer); stored in her pod over loopback LDP under real WAC | activitypub plugin |
| delivery A→B | the Create fans out to bob's inbox on B, HTTP-signed | **plugin-initiated** (same opt-in) |
| reverse follow | alice follows bob on **default-config** B | B records the follower but its SSRF gate refuses to resolve the loopback actor URL — `inbox: null`, no Accept |
| reverse delivery B→A | bob posts; B cannot deliver to a loopback peer | **driver couriers it** (read bob's outbox, POST to alice's inbox) and the narration says so |

The two directions are deliberately asymmetric. Server **A** uses the
activitypub plugin's **documented** opt-in for private-network/test
deployments (`allowPrivateDelivery: true`) — without it a loopback-only
demo could never see server-initiated delivery, because the plugin's SSRF
gate refuses loopback/private targets **by default**. Server **B** keeps
that production default, so the same demo also shows the gate holding: the
gate's logic is not weakened, bypassed or reimplemented anywhere — one
server opts in via config, the other demonstrates the refusal.

## Transcript excerpt

```
── Step 3: DISCOVERY — B's side resolves alice via webfinger on A
   GET http://127.0.0.1:43235/.well-known/webfinger?resource=acct%3Aalice%40127.0.0.1%3A43235
   JRD:
     { "subject": "acct:alice@127.0.0.1:43235",
       "links": [ …, { "rel": "self", "type": "application/activity+json",
                       "href": "http://127.0.0.1:43235/ap/alice/actor" } ] }
…
── Step 6: DELIVERY — A fans the Create out to bob's inbox on B (plugin-initiated)
   arrived in bob's inbox log on B:
     { "receivedAt": "2026-07-12T13:14:55.211Z",
       "activity": { "type": "Create",
                     "actor": "http://127.0.0.1:43235/ap/alice/actor",
                     "object": { "content": "Hello from server A — federation with no cloud!" } } }
   no driver involved: A's activitypub plugin signed and POSTed this to
   http://127.0.0.1:44835/ap/bob/inbox on its own, at publish time.
…
── Step 7: REVERSE — alice follows bob on B, which runs the PRODUCTION default
   B recorded the follower BUT refused to fetch alice's actor URL:
      follower record on B: { actor: alice@A, inbox: null }
   that is the SSRF gate doing its job — 127.0.0.1 is a private target
   and B never opted into allowPrivateDelivery. No Accept was sent.
```

## The files

- `demo.js` — the narrated standalone script (`node federation-demo/demo.js`).
- `test.js` — the same flow as 9 `node:test` assertions (picked up by the
  repo's `npm test` glob).
- `harness.js` — shared driver helpers (spawn an instance, register a user,
  post activities, poll the activitypub plugin's persisted state).
- `instance.js` — the child-process entry that boots ONE federated JSS
  (webfinger + activitypub) and prints `READY {json}`. See the first
  finding for why this file must exist.

Publishing goes through the ActivityPub **outbox**, not `micropub/`:
micropub stores h-entries under `public/posts/…` while the AP outbox reads
`public/statuses/…`, so a micropub post would never appear in the federated
outbox — the AP-native path is the cleaner story and micropub adds nothing
here.

## Findings

What a TWO-instance topology exercises that no single-instance suite can —
and the walls it hit.

1. **Two live JSS instances cannot share one process — the module-global
   `DATA_ROOT` footgun is a hard wall for multi-server topologies, not just
   a test-ordering hazard.** `createServer` writes the storage root into
   process-global state (`src/server.js:203` sets `process.env.DATA_ROOT`)
   and the IdP + storage layers re-read it lazily **per request**
   (`src/idp/accounts.js` `getAccountsDir()`, `src/idp/keys.js`,
   `src/utils/url.js` `getDataRoot()`, `src/handlers/pay.js`, …). AGENT.md
   documents this for *sequential* boots ("order the failing boot first");
   for **concurrent** servers there is no ordering trick: the second boot
   repoints the global and the first server's account lookups, token
   verification and pod reads silently hit the second server's data root.
   This demo therefore spawns each instance as a **child process**
   (`instance.js`), which works cleanly — but it means "run two JSS servers
   in one Node process" is off the table until the root is carried per
   instance rather than per process.

2. **Plugin-initiated outbound federation genuinely works on loopback — but
   only through `allowPrivateDelivery`, and the demo makes the SSRF/loopback
   tension visible in both directions.** With the documented opt-in on
   server A, the activitypub plugin did everything itself: fetched bob's
   actor document cross-origin from B, resolved his inbox, delivered an
   HTTP-signed Accept, and fanned a Create out to B at publish time — real
   server-to-server delivery, observed in B's persisted inbox log. Server B,
   on the default config (the one three security regression tests in
   `activitypub/test.js` protect), correctly refused to resolve or deliver
   to a loopback peer (`inbox: null` in its follower record, no Accept, no
   Create), so the reverse direction had to be **couriered by the driver**
   (read B's outbox, POST to A's inbox) — recorded honestly in the
   narration. The tension is structural: any LAN/air-gapped "federation with
   no cloud" deployment is exactly the case the anti-SSRF default refuses,
   and the per-instance boolean is the entire policy surface. A finer
   delivery policy (e.g. an allowlist of peer origins rather than
   all-private-or-nothing) would let a private-network deployment federate
   without opening delivery to *every* private address; that's a plugin
   improvement, not a core seam.

3. **Delivery only exists where the plugin owns the write path — the
   missing seams are `api.events` (#603) and an outbound-Follow client, and
   the driver's courier role names them.** The plugin delivers at exactly
   two moments it controls: Accept-on-Follow and Create-on-outbox-POST. A
   Note PUT straight into the pod via LDP (or by another plugin) federates
   to nobody, because nothing tells the plugin the pod changed — that's the
   `api.events.onResourceChange` gap. And nothing in Phase 1 *initiates* a
   Follow (the `following` collection is empty by design), which is why the
   demo's Follows are couriered by the driver even though the Accepts and
   Creates are not. Retries/queues for failed deliveries would sit on the
   same missing event/queue seam.

4. **`api.serverInfo` (#601) pays off across origins: webfinger bound each
   JRD to the right host with zero config.** Two instances on the same
   machine differ only by port; webfinger (given no `baseUrl`) minted
   `href`s on each server's own live origin via `api.serverInfo()`, so the
   same plugin config produced correct, distinct JRDs on A and B. The
   activitypub plugin predates the seam and still requires a hand-fed
   `config.baseUrl` per instance — visible here as the one per-server
   config line the demo has to compute (NOTES §3).

5. **Cross-origin actor URLs are the thing single-instance tests fake — and
   the composed layout held up.** `activitypub/test.js` uses a fictitious
   `https://remote.example/...` follower it never dereferences; here bob's
   actor id is a live URL on another server that A actually fetches, and
   alice's followers collection ends up holding a B-hosted URL (and vice
   versa). That also exercised the composed discovery chain across origins:
   webfinger's `actorPathTemplate: '/ap/<user>/actor'` gluing the JRD to the
   activitypub plugin's `api.reservePath`-claimed `/ap` root (#602) worked
   unchanged on both instances — and B accepting A's signed deliveries
   without verification is the plugin's documented Phase-2 boundary
   (inbound HTTP-Signature verify), unchanged by this demo.

Seams named: module-global `DATA_ROOT` (finding 1, new emphasis: concurrent
instances), `api.events.onResourceChange` #603 + delivery policy (findings
2–3), `api.serverInfo` #601 (consumed by webfinger, still missing from
activitypub's config surface), `api.reservePath` #602 (consumed, held up
across two origins).
