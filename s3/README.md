# s3 — an S3 object-storage gateway over a Solid pod

Expose a pod as **S3 object storage**. A path-style AWS-S3 REST subset is
served under the plugin prefix; every request is translated to a Solid/LDP
call against the host itself over **loopback HTTP carrying the caller's own
credentials** — the pattern `notifications/` established and `webdav/`,
`carddav/`, `caldav/`, `rss/`, `sparql/` reuse. The gateway has **no authority
of its own**: WAC governs, because it literally asks the server as the caller.

```js
plugins: [{
  id: 's3', module: 's3/plugin.js', prefix: '/s3',
  config: {
    baseUrl: 'http://localhost:3000',      // the server's own origin
    loopbackUrl: 'http://127.0.0.1:3000',  // where the gateway reaches the host
    bucketRoot: '/alice/',                  // where buckets live (see Findings)
  },
}]
```

## The mapping

| S3 concept | Solid concept |
|---|---|
| bucket | a container under `config.bucketRoot` |
| object key | a resource path under that container |
| `PUT /s3/<bucket>/<key>` | loopback `PUT` of the body; ETag = md5(body) |
| `GET /s3/<bucket>/<key>` | loopback `GET`; body + content-type + ETag |
| `HEAD /s3/<bucket>/<key>` | headers only: content-length, ETag, content-type |
| `DELETE /s3/<bucket>/<key>` | loopback `DELETE`; `204` |
| `GET /s3/<bucket>?list-type=2` | ListObjectsV2 XML (bounded recursive container walk) |
| `GET /s3/` | ListBuckets — containers under `bucketRoot` |
| `PUT /s3/<bucket>` | CreateBucket — loopback create container |
| `DELETE /s3/<bucket>` | DeleteBucket |

With `bucketRoot: '/alice/'`, bucket `photos` + key `holiday/beach.jpg`
⇄ `/alice/photos/holiday/beach.jpg`.

ETags are the **md5 hex of the object content, quoted** — S3's single-part
convention — computed by the gateway so `PutObject`, `GetObject`, `HeadObject`
and `ListObjectsV2` all agree. Errors are S3 XML
(`<Error><Code>NoSuchKey</Code>…`): `NoSuchKey`/`NoSuchBucket`→404,
`AccessDenied`→403, `SignatureDoesNotMatch`→403.

## Authentication — Bearer passthrough **and** SigV4

S3 authenticates with **AWS Signature V4** (`Authorization: AWS4-HMAC-SHA256
Credential=…, SignedHeaders=…, Signature=…`); real SDKs / aws-cli / rclone
always sign and will not send a bare Bearer. This gateway accepts **both**:

1. **Bearer passthrough** — `Authorization: Bearer <pod-token>` is forwarded
   verbatim to loopback. Trivial; for `curl` and bespoke clients.

2. **SigV4 verification (the strong path)** — the plugin re-derives the
   signature with `node:crypto` HMAC and constant-time-compares it. Because
   the plugin has no `accessKeyId → secret` store and cannot reuse core's
   `getAgent` for a non-Bearer scheme, the client configures **both**
   `aws_access_key_id` **and** `aws_secret_access_key` to the **pod token**.
   The plugin reads the pod token from the (cleartext) `Credential`
   accessKeyId, verifies the request was signed with that same value as the
   secret, and forwards `Bearer <accessKeyId>` to loopback so **WAC still
   decides**. This gives real S3-SDK compatibility and request integrity.

   The tradeoff: the "secret" travels in the `Credential` field, so it is not
   a true secret. Over TLS this is no weaker than sending a Bearer (the
   Authorization header is the credential either way), but a production
   deployment wanting real SigV4 secrecy needs a proper `accessKeyId → secret`
   store the plugin api does not provide — see **Findings**.

### aws-cli

```sh
aws configure set aws_access_key_id  "$POD_TOKEN"
aws configure set aws_secret_access_key "$POD_TOKEN"
aws --endpoint-url http://localhost:3000/s3 s3api list-objects-v2 --bucket photos
aws --endpoint-url http://localhost:3000/s3 s3 cp ./file.txt s3://photos/file.txt
```

### rclone

```ini
[pod]
type = s3
provider = Other
access_key_id = <POD_TOKEN>
secret_access_key = <POD_TOKEN>
endpoint = http://localhost:3000/s3
force_path_style = true
```

> **Path-style only.** Virtual-host addressing (`<bucket>.host`) is not
> supported — set `force_path_style`/`--endpoint-url` accordingly. Note that a
> path-prefixed endpoint (`/s3`) is a known friction point for some SDKs that
> assume the endpoint is an origin; pointing the plugin `prefix` at `/` (with
> the operator's `appPaths`) sidesteps it.

## What maps / what doesn't

**Implemented:** PutObject, GetObject, HeadObject, DeleteObject,
ListObjectsV2 (with `prefix` and `delimiter`), ListBuckets, CreateBucket,
DeleteBucket; content-md5 ETags; S3 error XML; SigV4 verification + Bearer.

**Not implemented (deliberate, out of scope):**

- **Multipart upload** (`CreateMultipartUpload`/`UploadPart`/`Complete`) —
  needs server-side part staging + assembly; a pod `PUT` is whole-object.
- **Versioning**, object tagging, lifecycle, object lock.
- **ACLs / bucket policy** — access control is WAC on the pod, not S3 ACLs.
  `x-amz-acl` is ignored; use the pod's `.acl`.
- **Presigned URLs**, `SelectObjectContent`, torrent, website config.
- **`list-type=1`** (legacy ListObjects) and pagination
  (`continuation-token`): the walk returns a single bounded page and sets
  `IsTruncated` when it overflows `MaxKeys`; no continuation cursor.
- **Range GET / conditional headers** are not translated (the LDP host
  supports them, but the md5-ETag buffering here reads the whole object).

## Findings

The webdav-family **loopback bridge generalizes to object storage.** The same
"translate a foreign protocol to LDP over loopback with forwarded auth,
hand-roll the wire XML" recipe that produced WebDAV/CalDAV/CardDAV produces an
S3 gateway with no new api surface — a seventh witness that the loopback
pattern is the plugin api's load-bearing primitive.

Specific seams this port surfaced:

- **The SigV4-vs-Bearer auth tension is the headline.** A plugin *can* verify
  SigV4 itself (`node:crypto` has the HMAC), and this one does — but it
  **cannot reuse core's `getAgent`** for a non-Bearer scheme: `getAgent` only
  resolves the credential schemes core knows (Bearer/DPoP/nostr). So a plugin
  bringing its *own* auth scheme has to both (a) verify it and (b) still
  produce a core-recognized credential to reach pod data. Here that forces the
  accessKeyId-carries-the-token compromise: the only way the plugin can end up
  holding a Bearer to forward is if the token is recoverable from the request,
  and SigV4 never transmits the secret — only the `Credential` accessKeyId is
  in cleartext. **Candidate seam:** either a pluggable `getAgent` credential
  resolver (let a plugin register a scheme verifier), or an
  `api.authorizeAs(token)` that mints a loopback-usable credential from a
  plugin-verified identity. Until then, "verify SigV4 with the token as the
  secret access key" is the strongest honest form, and it works with real S3
  SDKs (the test drives aws-style signatures end-to-end, including query
  signing and a tampered-signature rejection).

- **"The pod's top-level containers" is not an agent-visible concept.** The
  original spec said ListBuckets = the pod's top-level containers. In practice
  the server root `/` is **server-owned**: an ordinary agent can neither
  `PUT /newbucket/` there (403) nor `GET /` as a JSON-LD listing (it serves
  HTML). The writable, enumerable root *for an agent* is its own pod
  container. Hence `config.bucketRoot` (default `/`, but set to `/alice/` in
  practice): buckets are the pod's sub-containers. This is the honest mapping,
  and the gap — no notion of an agent-scoped "storage root" the api could hand
  a plugin — is worth recording.

- **`config.baseUrl`/`serverInfo` repetition, again.** Like
  `notifications/webdav/rss/sparql`, the plugin must be told its own origin
  because there is **no `api.serverInfo`**; it `throw`s in `activate` when
  `config.baseUrl` is missing. ~10 plugins now carry the identical stanza —
  the strongest quantitative case in the repo for adding `api.serverInfo`.

- **No write-time index (`api.events`) → O(N) list.** ListObjectsV2 is a
  read-time bounded recursive crawl (same limitation `sparql/` and `rss/`
  hit), and each listed object is additionally fetched to compute its
  content-md5 ETag so it matches PutObject. That is O(objects) loopback calls
  per list — acceptable at test scale, capped by `WALK_MAX_RESOURCES`, but a
  real deployment would want a write-time size/hash index, which needs the
  `api.events.onResourceChange` seam that is still absent.

- **Raw-body parser needed for byte-exact objects + payload hashing.** Like
  `corsproxy/` and `gitscratch/`, the plugin registers a scoped
  `addContentTypeParser('*', { parseAs: 'buffer' })` so object bodies arrive
  as raw `Buffer`s — required both for byte-exact `PutObject` and for the
  SigV4 `x-amz-content-sha256` payload hash to match. Relates to #583.

## Run

```sh
cd .. && node --test --test-concurrency=1 s3/test.js
```

16 tests, all green: CreateBucket, Put/Get/Head/Delete object (ETag/body/
content-length assertions), ListObjectsV2 (keys + Size + ETag, `prefix`
filter, `delimiter` CommonPrefixes), NoSuchKey on a deleted key, ListBuckets,
AccessDenied (anonymous and bogus-Bearer), and the full SigV4 path
(signed Create/Put/Get/List + a tampered-signature `SignatureDoesNotMatch`).
