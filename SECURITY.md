# SECURITY.md — audit record

A four-axis adversarial review of all 33 plugins (2026-07), and what it
found. Axes: authentication/authorization, SSRF/path/parser input,
resource-safety/DoS/lifecycle, and correctness/protocol conformance. Each
reviewer read every `plugin.js` and cross-checked findings against
[NOTES.md](./NOTES.md)/[REPORT.md](./REPORT.md) so documented limitations
were not reported as bugs.

**Headline:** the fleet held up well. The dominant pattern —
resolve identity with `api.auth.getAgent`, forward the client's
`Authorization` on every loopback call, and let the host's WAC decide —
is applied correctly and consistently across the whole data plane. Real
defects clustered exactly where a plugin *invented its own* behavior
instead of deferring to WAC (activitypub's unauthenticated federation
surface, sparql's user-supplied regex). All confirmed findings are
fixed, each with a regression test; the suite went 374 → 386 tests.

## Fixed

| Severity | Plugin(s) | Finding | Fix | Commit |
|---|---|---|---|---|
| High | activitypub | Unauthenticated inbox fetched an attacker-controlled `actor`/`inbox` URL with `redirect: follow` and no gate → SSRF pivot (e.g. `169.254.169.254`); unbounded per-user state growth; non-atomic write | `gatedFetch` (corsproxy's private-IP guard + DNS `resolvesToPublic`, fail-closed, manual per-hop redirect re-validation); inbox trimmed to `maxInbox`, followers deduped; atomic state write; bodies consumed; outbox walk capped | `03e4db5` |
| High | sparql | `FILTER(REGEX(...))` compiled a user pattern and ran it on pod-plantable strings with no bound → ReDoS event-loop hang | Reject patterns over `maxRegexLength` (512) and catastrophic nested-quantifier shapes; truncate tested input to `maxRegexInput` (10k) | `f1255a7` |
| High | caldav, carddav | free-busy/query/multiget/PROPFIND walked every member with a full-body buffer each, uncapped → DoS amplification | `config.maxResources` cap (default 10k) truncates the member/href list before the walk; oversized → truncated-but-valid 207 | `642dec2` |
| Med | otp, capability, shortlink | Direct `writeFileSync` of the whole table → a crash mid-write truncates it; loader swallows the parse error into `{}` (capability: a revoked token silently revives) | Atomic write (unique temp file + `renameSync`) | `ca52373` |
| Med | jmap | `Email/set` create omitted server-set props (`blobId`/`threadId`/`size`) required by RFC 8621 §4.6 | Echo them in the create response (blobId = sha256 of stored JSON, threadId = id, size = byte length) | `e54aba2` |
| Low-Med | gitscratch | Auth gate required *an* agent but never checked it against the repo creator → any authed user could push to another's repo | Opt-in `config.owned` binds a repo to its first materializer (default stays shared) | `a8847a3` |
| Low | rss | Atom output missing the RFC 4287 §4.1.1-required `<author>` | Feed-level `<author>` from `config.author`/title | `e54aba2` |
| Low | remotestorage | Forwarded host `content-length` over a fetch-decoded stream (latent framing bug) | Drop it, matching the webdav sibling | `e54aba2` |
| Low | terminal | Query-token compare early-exited on length mismatch (timing side-channel on token length) | Constant-time sha256 + `timingSafeEqual` | `e54aba2` |

## Accepted risk / deferred (documented, not fixed)

- **activitypub inbound signature verification is still Phase 2.** The
  inbox remains unauthenticated by design; the SSRF gate + state caps are
  the mitigation. Full HTTP-Signature verification is a larger feature,
  tracked as a known limitation in activitypub/README.md.
- **DNS-rebinding TOCTOU** in `gatedFetch` (activitypub) and `corsproxy/`:
  the address is validated at `dns.lookup` time, but `fetch` resolves
  again independently, so a hostname that flips between the two resolutions
  can slip past. Same residual both places; closing it needs pinning the
  resolved IP into the connection (no clean dep-free seam today).
- **s3 ListObjectsV2 fetches every object to compute its md5 ETag**
  (`s3/`): the crawl is capped (`WALK_MAX_RESOURCES`) and cycle-safe, but a
  single list of large objects buffers each in turn. Performance, not a
  vulnerability; a write-time metadata cache (the `api.events` seam) would
  fix it properly.
- **relay rewrites its whole event file per stored EVENT** (`relay/`):
  blocking O(N) I/O on the event loop under sustained traffic (per-socket
  rate-limited to 60/min). Bounded by `maxEvents`; an append-only log is
  the real fix. Performance, deferred.
- **No per-resource body-size ceiling** on buffered loopback reads (rss,
  backup, s3, caldav/carddav): one-at-a-time bounds it to the largest
  single resource, but a multi-GB pod file could OOM. `corsproxy/` is the
  counter-example (streamed with `maxBodyBytes`). A shared capped-read
  helper would generalize the fix; deferred.
- **Read-modify-write TOCTOU** in the pluginDir JSON writers (otp,
  capability, shortlink, activitypub): the *write* is now atomic, but two
  concurrent request handlers can still interleave read→modify→write and
  lose one update. Distinct from the atomicity fix above and from core
  [#600](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/600)
  (the host's own conditional-write non-atomicity). Low impact at scratch
  scale; a per-key lock is the fix.

## What was checked and found solid

- **WAC deferral**: every data-plane plugin forwards the caller's
  `Authorization` on loopback and lets WAC decide; none forward it
  off-host. `corsproxy/` strips pod credentials from upstream and drops
  them on cross-origin redirect. Liveness probes (metrics/dashboard/admin)
  deliberately send no auth and see only public responses.
- **Token/secret handling**: capability, otp, s3, metrics all verify the
  signature before trusting the payload, compare with `timingSafeEqual`
  over equal-length buffers, and gate JSON parse behind the MAC. No
  `Math.random` in any security path; secrets from `crypto.randomBytes`.
- **Traversal / containment**: webfinger, didweb, nip05 reject `..`/dot
  segments before `path.join`; admin's podsRoot walk is realpath-contained
  and skips symlinks; the DAV/s3/backup/remotestorage path handlers reject
  traversal and rely on host WAC over loopback.
- **Parsers**: the backup ustar writer, oembed image-dimension parsers,
  caldav iCal RRULE expansion (capped), and the sparql tokenizer are
  bounds-checked and always advance (no over-read, no infinite loop); s3
  and oembed build XML with escaping and parse no untrusted XML (no XXE).
- **XSS**: oembed refuses rich HTML and escapes XML; dashboard and admin
  inject values only via client-side `.textContent` (config via
  `JSON.stringify` into a script tag), so pod-derived data never lands as
  markup.
- **Lifecycle**: the WebSocket plugins (relay, webrtc, terminal, tunnel,
  notifications) track sockets and clean up on close/error with a working
  `deactivate()`; timers/watchers (metrics, gitscratch, search,
  notifications) are cleared on teardown.

## Reporting

This is an experimental research repo, not a production deployment. If you
find a security issue, open an issue on the repo (or, for the core server,
on JavaScriptSolidServer/JavaScriptSolidServer). None of these plugins
should be run on a public deployment without the operator reviewing the
accepted-risk items above.
