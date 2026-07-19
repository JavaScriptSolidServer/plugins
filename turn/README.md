# turn — TURN REST credentials

The JSS half of a [coturn](https://github.com/coturn/coturn) deployment.
coturn relays WebRTC traffic for peers whose NATs defeat STUN; this plugin
mints the **time-limited credentials** (draft-uberti-behave-turn-rest-00)
browsers use to reach it, so no static TURN password ever ships in a public
page — a leaked credential expires by itself.

```js
plugins: [{ module: 'turn/plugin.js', prefix: '/.turn',
            config: { uris: ['turn:pod.example:3478?transport=udp',
                             'turns:pod.example:5349'],
                      ttl: 3600 } }]
```

## Endpoint

`GET <prefix>/credentials[?user=<tag>]` →

```json
{ "username": "1784495000",
  "password": "base64(HMAC-SHA1(secret, username))",
  "ttl": 3600,
  "uris": ["turn:pod.example:3478?transport=udp"],
  "iceServers": [{ "urls": ["…"], "username": "…", "credential": "…" }] }
```

`username` is the unix expiry, optionally `:tagged` (`[A-Za-z0-9._-]{1,64}`)
for per-client attribution in coturn's logs. `iceServers` drops straight
into `new RTCPeerConnection({ iceServers })`. Responses are `no-store`.

## Config

| key | default | notes |
|---|---|---|
| `secret` | — | must equal coturn's `static-auth-secret`; falls back to the env var below |
| `secretEnv` | `TURN_STATIC_AUTH_SECRET` | env fallback — a CLI `--plugin module@prefix` entry carries no config |
| `uris` | env `TURN_URIS` (comma-separated) | `turn:`/`turns:` URIs handed to clients |
| `ttl` | `3600` | credential lifetime, seconds |
| `requireAuth` | `false` | gate minting on `api.auth.getAgent` (401 anonymous) |

Activation **fails listen() loudly** without a secret or uris.

## The coturn side

```
use-auth-secret
static-auth-secret=<same secret>
realm=pod.example
fingerprint
no-multicast-peers
# keep the relay off your internal network
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
```

## Notes

- Anonymous minting is the default on purpose: expiry makes handing
  credentials to any visitor survivable, and mesh pages run accountless.
  `requireAuth` exists for relays that should serve known agents only.
- The relay sees IPs and encrypted DTLS bytes, never plaintext content;
  ICE prefers direct paths, so the relay carries traffic only for pairs
  that could not connect otherwise.
- `turns:` on TCP 443 is what defeats strict firewalls, but 443 usually
  belongs to the pod — a second IP (or 5349 and accepting the loss) is the
  deployment decision this plugin stays out of.
