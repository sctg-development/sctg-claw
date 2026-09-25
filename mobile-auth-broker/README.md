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
- `internal/tlscert` — self-managed Let's Encrypt certificate (ACME DNS-01
  against Cloudflare) for the [self-managed TLS](#self-managed-tls) HTTPS
  listeners.
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

tailscaled's actual state (its node/machine keys, i.e. its identity on the
tailnet) lives under `/data/tailscale-state` — the broker's existing
persistent volume, the same one the SQLite database and the [TLS
certificate cache](#self-managed-tls) already use — not a throwaway
`emptyDir`. Losing that state on every pod restart would make tailscaled
re-register as a brand new tailnet node each time (a new node key, and
likely a new tailnet IP), rather than reconnecting as the same node Headscale
already knows about. Only `/run/tailscale` (the control socket directory) is
still an `emptyDir`; that one is fine to lose on every restart.

See the [`sctg-claw` chart's `values.yaml`](../sctg-claw/values.yaml) under
`mobileAuthBroker.tailnet` for the Helm-level configuration (auth key,
hostname, login server, TUN mode, forwarded identity, and the tailnet CIDR
opened in the pod's `NetworkPolicy`).

## Self-managed TLS

The official OpenClaw native clients (iOS, macOS, Android) hard-require an
`https://` gateway address for their sign-in flow — a `ws://`/`http://` URL is
rejected client-side before any connection is even attempted (see the macOS
app's `CloudflareAccessLogin.validateGateway`, which requires
`url.scheme == "https"`). That's a problem for the [tailnet
bypass](#tailnet-bypass): a tailnet MagicDNS hostname has no
browser/OS-trusted certificate of its own, and `tailscale cert` (Tailscale's
own free-certificate feature) needs ACME support on the control server, which
most self-hosted Headscale deployments don't have.

`internal/tlscert` solves this by having the broker obtain and renew its own
publicly-trusted Let's Encrypt certificate, directly — no `cert-manager`, no
external `lego`/`certbot` process, no separate supervised program, just the
[`go-acme/lego`](https://github.com/go-acme/lego) library used programmatically
inside this same binary:

1. On startup, if `TLS_ENABLED=true`, it looks for a cached certificate under
   `TLS_CERT_CACHE_DIR`. If found and not close to expiry, it's loaded and used
   as-is.
2. Otherwise it requests one from Let's Encrypt via **ACME DNS-01** against
   **Cloudflare DNS**: it proves ownership of `TLS_DOMAIN` by creating a
   short-lived `_acme-challenge` TXT record through the Cloudflare API (token
   in `TLS_CLOUDFLARE_API_TOKEN`), then removes it once validated. DNS-01 needs
   no public inbound traffic at all (unlike HTTP-01), which fits a tailnet
   hostname that plain internet clients can't reach anyway.
3. The certificate and the ACME account's own key are written to
   `TLS_CERT_CACHE_DIR` so restarts reuse them instead of re-issuing (and don't
   burn Let's Encrypt's rate limits).
4. A background loop checks every 12h and renews starting 30 days before
   expiry, without needing a restart — `tls.Config.GetCertificate` always
   returns the current in-memory certificate.
5. `TLS_PORTS` (default `443`) opens additional HTTPS listeners alongside
   whatever `LISTEN_PORTS`/`LISTEN_ADDR` already serve in plain HTTP. Both use
   the exact same handler; only the transport differs.

### Getting a Cloudflare API token

Create one at <https://dash.cloudflare.com/profile/api-tokens> → **Create
Token** → **Custom token**, scoped to the zone that hosts `TLS_DOMAIN`:

- **Permissions**: `Zone` → `DNS` → `Edit`, and `Zone` → `Zone` → `Read` (the
  DNS-01 solver looks up the zone before creating the challenge record).
- **Zone Resources**: `Include` → `Specific zone` → your zone (not "All
  zones").

Don't reuse a broader token (e.g. one already used for a Cloudflare Tunnel) —
create a dedicated one scoped to just this zone, and don't commit it; pass it
via `TLS_CLOUDFLARE_API_TOKEN` (or the chart's `mobileAuthBroker.tls.existingSecret`
to source it from a Secret you manage yourself).

### Privileged ports

`TLS_PORTS`' default (`443`) is below 1024 and needs `CAP_NET_BIND_SERVICE` to
bind as the non-root container user. Rather than running as root, the
Dockerfile sets that as a **file capability** directly on the compiled binary
(`setcap cap_net_bind_service+eip /app/mobile-auth-broker`) — the same
approach already used for `tailscaled`'s `CAP_NET_ADMIN`/`CAP_NET_RAW` in the
[tailnet bypass](#tailnet-bypass).

This capability is baked into the binary **unconditionally**, by every build
of this image — the Dockerfile has no way to know at build time whether a
given deployment will ever set `TLS_ENABLED=true`. That matters because a
capability-bearing binary can only be `exec`'d by a process whose own
capability *bounding set* already contains that capability; otherwise the
kernel refuses the `exec` outright with `EPERM`, before the program even
starts running — it doesn't matter that the process would never actually
*use* the capability. Concretely, this means the Helm chart grants
`NET_BIND_SERVICE` (and `allowPrivilegeEscalation: true`, required for file
capabilities to be honored on `exec` at all — `allowPrivilegeEscalation:
false`, the container's normal default, sets `PR_SET_NO_NEW_PRIVS`, which the
kernel uses to explicitly refuse them) **in every mode**, including the
plain default with TLS and the tailnet bypass both disabled — not only when
`TLS_ENABLED=true`. Omitting it there was an actual outage caught during
development ("exec /app/mobile-auth-broker: operation not permitted",
crash-looping every deployment of the image regardless of configuration), not
a theoretical concern.

One more Dockerfile-ordering detail this depends on: `setcap` must run
**after** any `chown` of the binary, not before — `chown` strips a file's
`security.capability` xattr.

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
| `LISTEN_ADDR` | no | `:8080` | Address the HTTP/WS server binds. Ignored when `LISTEN_PORTS` is set. |
| `LISTEN_PORTS` | no | derived from `LISTEN_ADDR` | Comma-separated list of plain-HTTP ports to listen on simultaneously (e.g. `80,8080,18789`), all serving the same handler. |
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
| `TLS_ENABLED` | no | `false` | Turn on [self-managed TLS](#self-managed-tls). |
| `TLS_PORTS` | no | `443` | Comma-separated list of HTTPS ports, in addition to `LISTEN_PORTS`/`LISTEN_ADDR` (which stay plain HTTP). |
| `TLS_DOMAIN` | required if `TLS_ENABLED=true` | — | Hostname the certificate covers; must resolve to wherever clients actually reach this broker. |
| `TLS_ACME_EMAIL` | required if `TLS_ENABLED=true` | — | Contact address for the Let's Encrypt account (expiry/problem notifications). |
| `TLS_CLOUDFLARE_API_TOKEN` | required if `TLS_ENABLED=true` | — | Cloudflare API token scoped to `Zone:Read` + `DNS:Edit` on the zone hosting `TLS_DOMAIN`. See [Getting a Cloudflare API token](#getting-a-cloudflare-api-token). |
| `TLS_CERT_CACHE_DIR` | no | `/data/certs` | Where the obtained certificate and ACME account key are cached across restarts. Put this on a persistent volume. |
| `TLS_ACME_STAGING` | no | `false` | Use Let's Encrypt's staging environment (browser-untrusted, effectively unlimited) instead of production — for testing the ACME flow without burning rate limits. |

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
image alongside the apt-packaged `tailscale`/`tailscaled` binaries. The final
image runs as a non-root user throughout; both `tailscaled` (real TUN,
tailnet bypass) and the broker binary itself (privileged TLS ports, see
[Self-managed TLS](#self-managed-tls)) get their required capabilities as
**file capabilities** (`setcap`) rather than by running as root — the Helm
chart grants the matching pod-level capabilities and
`allowPrivilegeEscalation: true` only when a feature that needs them is
actually enabled.

Building requires Go 1.25+ (bumped from 1.21 by the `go-acme/lego` ACME
client dependency).

## Deployment

This service is deployed as part of the [`sctg-claw`](../sctg-claw) Helm
chart, gated behind `mobileAuthBroker.enabled`. The chart wires up:

- a `Secret` for `SERVER_SECRET`/`GITHUB_CLIENT_ID` (and, when self-managed
  TLS is enabled without `mobileAuthBroker.tls.existingSecret`, the
  Cloudflare API token alongside them),
- a `ConfigMap` for `ALLOWED_EMAILS`,
- a `PersistentVolumeClaim` for the SQLite database, shared by the [TLS
  certificate cache](#self-managed-tls) and, for the tailnet bypass,
  tailscaled's own node state (both under the same volume, so neither needs
  a PVC of its own),
- a `NetworkPolicy` restricting ingress to the Cloudflare Tunnel pod (plus, if
  the tailnet bypass is enabled, direct WireGuard ingress from the tailnet
  CIDR),
- for the tailnet bypass, the `/dev/net/tun` device mount and `TAILNET_*`
  environment variables described above,
- and, for self-managed TLS, the `TLS_*` environment variables. The
  `NET_BIND_SERVICE` capability (see [Privileged ports](#privileged-ports))
  is granted unconditionally in every mode, not only when TLS is enabled.

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
- The Cloudflare API token for [self-managed TLS](#self-managed-tls) can
  create/delete DNS records in the zone it's scoped to. Scope it to exactly
  that one zone (`Zone:Read` + `DNS:Edit`, nothing broader), keep it out of
  version control, and don't reuse a token already used for something else
  (e.g. a Cloudflare Tunnel) — a leaked broader token has a correspondingly
  broader blast radius.
