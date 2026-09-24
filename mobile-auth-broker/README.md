# mobile-auth-broker

A small Go service that lets mobile/native OpenClaw clients authenticate against
an OpenClaw Gateway that is configured for [trusted-proxy
auth](https://docs.openclaw.ai/gateway/trusted-proxy-auth), without exposing
the Gateway itself to the public internet.

It does two things:

1. **Authenticates the user** via the [GitHub OAuth Device
   Authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
   flow (no browser redirect needed, works well on TV/CLI/mobile-style
   clients), or, optionally, via **Tailscale/Headscale tailnet membership**
   (see [Tailnet bypass](#tailnet-bypass) below).
2. **Reverse-proxies** the authenticated client's WebSocket and Control
   UI/Canvas HTTP traffic to the Gateway, injecting the
   `X-Forwarded-Email`/`X-Forwarded-For` headers the Gateway's trusted-proxy
   auth mode expects.

It is one of two ways into this deployment's Gateway — the other is the
Cloudflare Tunnel + oauth2-proxy path used by the Control UI. See the parent
[`sctg-claw`](../sctg-claw) Helm chart for how both are wired together.

## Why this exists

The Gateway's `trusted-proxy` auth mode delegates authentication entirely to
whatever sits in front of it, identified by source IP
(`gateway.trustedProxies`) and an identity header. That works well for a
browser behind oauth2-proxy, but native/mobile OpenClaw clients don't speak
oauth2-proxy's cookie-based session flow. mobile-auth-broker is the "front"
for that path: it runs inside the trusted network (in-cluster, listed in
`gateway.trustedProxies`), does its own user-facing authentication, and only
then forwards to the Gateway as a trusted identity.

## Architecture

```
                       ┌──────────────────────┐
 mobile / native  ───▶ │  mobile-auth-broker   │ ───▶  OpenClaw Gateway
 OpenClaw client       │  (this service)       │       (trusted-proxy auth)
                       └──────────────────────┘
                          │              │
                    GitHub Device   SQLite (device/session/
                    Authorization   audit records)
                    (or: tailnet
                    bypass, see below)
```

- `cmd/main.go` — process entrypoint, wires config, DB, handler and proxy together.
- `internal/handler` — the Device Flow and session HTTP endpoints (`/v1/...`).
- `internal/proxy` — the WebSocket/HTTP reverse proxy to the Gateway, and the
  shared `authenticateDevice` gate both paths call.
- `internal/github` — GitHub Device Flow + user-email lookup client.
- `internal/db` — SQLite storage (devices, access/refresh sessions, audit log).
- `internal/tailnet` — Tailscale/Headscale peer verification for the tailnet
  bypass.
- `internal/config` — environment-variable configuration and validation.
- `internal/models`, `internal/utils` — shared types and token/crypto helpers.
- `tools/device-flow-validate` — a standalone Rust CLI that exercises the full
  Device Flow end-to-end against a deployed broker (see
  [Testing a deployment](#testing-a-deployment)).

## Authentication flows

### GitHub Device Flow (default)

1. Client calls `POST /v1/device-authorizations`. The broker starts a GitHub
   Device Authorization transaction and returns a `user_code` and
   `verification_uri` for the user to open on any device.
2. Client polls `GET /v1/device-authorizations/{transaction_id}` until the
   user has approved on GitHub.
3. Once GitHub confirms, the broker fetches the user's primary verified
   email, checks it against `ALLOWED_EMAILS`, and — if allowed — creates a
   `MobileDevice` row plus an access/refresh token pair, returned to the
   client.
4. The client uses the access token as a `Bearer` token on the WebSocket
   upgrade (or HTTP GET/HEAD) request to `/`. `internal/proxy` validates it,
   loads the device, re-checks the allowlist, and proxies the connection to
   the Gateway with `X-Forwarded-Email: <device email>`.
5. `POST /v1/sessions/refresh` rotates an access/refresh token pair before
   expiry; `DELETE /v1/sessions/current` revokes the current device's
   sessions.

An email leaving `ALLOWED_EMAILS` is enforced on every proxied request, not
just at login: a live device whose email drops off the list gets its
sessions revoked on its next request.

### Tailnet bypass

`mobileAuthBroker.tailnet.enabled` (Helm chart) turns on an alternative,
**identity-agnostic** trust path: any request that arrives from a verified
Tailscale/Headscale peer of this node is authenticated outright, skipping the
GitHub Device Flow entirely, and forwarded to the Gateway as a single fixed
identity (`mobileAuthBroker.tailnet.identityScopes[0]`). There is no
per-user allowlist on this path — tailnet membership (your Headscale ACLs)
*is* the access control.

This requires the broker's container to run `tailscaled` with a **real TUN
device** (`-tun tailscale0`, not `userspace-networking`): the verification in
`internal/tailnet.IsPeer` calls `tailscale whois <ip>` against the local
control socket using the request's real `RemoteAddr`, which only reflects the
genuine tailnet peer address when tailscaled owns an actual network
interface. Under `userspace-networking`, tailscaled NATs inbound tailnet
connections to loopback before they reach the app, which would defeat this
check.

When enabled, cirond (the process manager already used by the main
`sctg-claw` image) supervises three processes instead of just the broker —
see `scripts/ciron.toml`:

| Program          | Role                                                             |
| ---------------- | ----------------------------------------------------------------- |
| `mobile-auth-broker` | this service                                                  |
| `tailscaled`     | userspace daemon, real TUN, socket at `/run/tailscale/tailscaled.sock` |
| `tailscale`      | one-shot `tailscale up` using `TAILNET_AUTHKEY`/`TAILNET_HOSTNAME`/`TAILNET_LOGIN_SERVER` |

When the bypass is disabled (the default), the Helm chart overrides the
container's command to run the broker binary directly, and none of the
tailscale plumbing is invoked.

See the [`sctg-claw` chart's `values.yaml`](../sctg-claw/values.yaml) under
`mobileAuthBroker.tailnet` for the Helm-level configuration (auth key,
hostname, login server, TUN mode, forwarded identity, and the tailnet CIDR
opened in the pod's `NetworkPolicy`).

## Configuration

All configuration is via environment variables (`internal/config`). See
[`.env.example`](.env.example) for a starting point.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GITHUB_CLIENT_ID` | yes | — | GitHub OAuth App client ID used for the Device Flow. |
| `SERVER_SECRET` | yes | — | ≥32-byte secret used to hash stored tokens and encrypt device codes at rest. |
| `ALLOWED_EMAILS` | yes | — | Comma-separated allowlist of GitHub primary emails permitted to pair a device. |
| `BROKER_HOSTNAME` | no | `mobile.claw.example.org` | This broker's own hostname (informational/logging; used as the `Host` header sent to the Gateway). |
| `GATEWAY_SERVICE_URL` | no | `http://sctg-claw:18789` | In-cluster URL of the OpenClaw Gateway to proxy to. |
| `ACCESS_TOKEN_TTL` | no | `1h` | Lifetime of an access token. |
| `REFRESH_TOKEN_TTL` | no | `720h` | Lifetime of a refresh token. |
| `LISTEN_ADDR` | no | `:8080` | Address the HTTP/WS server binds. |
| `DATABASE_PATH` | no | `/data/broker.db` | SQLite database file. |
| `GITHUB_API_BASE_URL` | no | `https://api.github.com` | REST API base (device-flow OAuth calls always go to `github.com`); override for a GitHub Enterprise instance. |
| `MAX_MESSAGE_SIZE` | no | `16777216` (16MB) | Max WebSocket message size, matched to the iOS client. |
| `POLL_INTERVAL_SCALE` | no | `1.5` | Multiplier applied to GitHub's `slow_down` poll interval. |
| `TAILNET_ENABLED` | no | `false` | Turn on the [tailnet bypass](#tailnet-bypass). |
| `TAILNET_SOCKET` | no | `/run/tailscale/tailscaled.sock` | Path to the local tailscaled control socket used for `tailscale whois`. |
| `TAILNET_IDENTITY` | required if `TAILNET_ENABLED=true` | — | Identity forwarded to the Gateway (`X-Forwarded-Email`) for every verified tailnet peer. |
| `TAILNET_AUTHKEY` | tailnet bypass only | — | Tailscale/Headscale pre-auth key (consumed by `scripts/ciron.toml`, not read by the Go binary). |
| `TAILNET_HOSTNAME` | tailnet bypass only | `mobile-claw-broker` | Tailnet hostname for this node (`ciron.toml`). |
| `TAILNET_LOGIN_SERVER` | tailnet bypass only | `https://login.tailscale.com` | Tailscale/Headscale control server (`ciron.toml`). |
| `TAILNET_TUN_MODE` | tailnet bypass only | `tailscale0` | `tailscaled -tun` value (`ciron.toml`); must be a real interface, not `userspace-networking`. |

## Development

```bash
go mod download
make dev              # go run ./cmd/main.go, reads env from the shell
make dev-env          # same, but loads variables from a local .env file first
```

```bash
make build             # builds ./bin/mobile-auth-broker
make test              # go test ./... -v
make test-cover        # ... plus an HTML coverage report
make test-race         # ... with the race detector
make fmt               # gofmt -w .
make lint              # golangci-lint run ./... (requires golangci-lint installed)
```

`go-sqlite3` requires cgo, so `CGO_ENABLED=1` and a C toolchain are needed to
build (the Makefile and Dockerfile both already set this up).

## Docker

```bash
make docker                       # docker build -t sctg/mobile-auth-broker:latest .
make DOCKER_TAG=v1.2.3 docker     # custom tag
make multi-arch                   # linux/amd64+arm64, buildx, pushes
```

The image is a multi-stage build: the Go binary and `cirond` (the process
manager used when the [tailnet bypass](#tailnet-bypass) is enabled) are each
built in their own stage and copied into a `debian:bookworm-slim` final
image alongside the apt-packaged `tailscale`/`tailscaled` binaries. The
final image runs as a non-root user; when the tailnet bypass is enabled, the
Helm chart grants that user the `NET_ADMIN`/`NET_RAW` capabilities needed for
a real TUN device instead of running the container as root.

## Deployment

This service is deployed as part of the [`sctg-claw`](../sctg-claw) Helm
chart, gated behind `mobileAuthBroker.enabled`. The chart wires up:

- a `Secret` for `SERVER_SECRET`/`GITHUB_CLIENT_ID`,
- a `ConfigMap` for `ALLOWED_EMAILS`,
- a `PersistentVolumeClaim` for the SQLite database,
- a `NetworkPolicy` restricting ingress to the Cloudflare Tunnel pod (plus, if
  the tailnet bypass is enabled, direct WireGuard ingress from the tailnet
  CIDR),
- and, for the tailnet bypass, the `/dev/net/tun` device mount and
  `TAILNET_*` environment variables described above.

See `sctg-claw/values.yaml`'s `mobileAuthBroker` section for the full set of
chart values.

## Testing a deployment

`tools/device-flow-validate` is a standalone Rust CLI that drives the full
GitHub Device Flow against a running broker and checks it resolves to
`approved`:

```bash
cd tools/device-flow-validate
cargo run --release -- --url https://mobile-claw.example.org
```

It prints the `user_code`/`verification_uri` for you to approve on GitHub,
polls `GET /v1/device-authorizations/{id}` the same way a real client would,
and exits `0` only if the flow completes as `approved` within `--timeout`
seconds (default 900, matching GitHub's own device-code expiry).

## Security notes

- `SERVER_SECRET` must be kept secret and stable: it hashes stored
  access/refresh tokens and encrypts in-flight GitHub device codes. Rotating
  it invalidates every issued token.
- The allowlist (`ALLOWED_EMAILS`) is checked both at pairing time and on
  every proxied request, so revoking access is as simple as removing an
  email and letting the next request fail closed.
- `HandleHTTP` only ever proxies `GET`/`HEAD` requests, and never the
  Gateway's `/api`, `/v1`, `/plugins`, or `/mcp` prefixes — it exists solely
  to serve the Control UI/Canvas asset surface, not as a general-purpose
  reverse proxy.
- The [tailnet bypass](#tailnet-bypass) trades per-user identity checks for
  network-level trust: enabling it means anyone who can join the tailnet (per
  your Headscale ACLs) gets Gateway access as the single configured identity,
  with no further allowlist. Keep Headscale ACLs tight if you turn it on.
- Keep this broker reachable only from where the Gateway's
  `gateway.trustedProxies` says it's reachable from — it is a trusted
  identity source for the Gateway, exactly like Cloudflare's oauth2-proxy.
