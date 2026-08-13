# sctg-claw

A personal, self-hosted [OpenClaw](https://github.com/openclaw/openclaw) gateway deployment for Kubernetes, packaged as a Helm chart. Currently developed against Docker Desktop's built-in Kubernetes cluster, with the target being a real 8-node cluster (7× arm64 + 1× amd64).

## Architecture

```
Browser / client
      |
      v
Cloudflare Tunnel (https://claw.example.org)
      |
      v
oauth2-proxy  (GitHub OAuth, allow-listed to 2 accounts)
      |
      v
OpenClaw Gateway  (gateway.auth.mode: trusted-proxy)
```

- **Cloudflare Tunnel** terminates the public hostname and forwards to oauth2-proxy inside the cluster — no inbound ports are opened on the cluster itself.
- **oauth2-proxy** gates access with GitHub login, restricted to an explicit `users.txt` allow-list (currently 2 accounts). It forwards the verified identity to the gateway via the `X-Forwarded-Email` header (`pass_user_headers: true`).
- **OpenClaw Gateway** runs with `gateway.auth.mode: trusted-proxy` and trusts that header (scoped to `gateway.auth.trustedProxy.allowUsers`) instead of a shared token. New Control UI/browser devices from an allow-listed identity are auto-approved with a capped, non-admin scope set (`gateway.auth.trustedProxy.deviceAutoApprove`) — the whole point being to avoid having to `kubectl exec` into the pod and run `openclaw devices approve <id>` for every new browser session.

## Repository layout

| Path | Purpose |
| --- | --- |
| `sctg-claw/` | The Helm chart (`Chart.yaml`, `values.yaml`, `values.schema.json`, `templates/`). Depends on the vendored `cloudflared` and `oauth2-proxy` sub-charts. |
| `openclaw/` | Git submodule pointing at the [openclaw/openclaw](https://github.com/openclaw/openclaw) source tree. Read-only reference — **never edited directly** — and also the actual build source for the runtime image (see below). |
| `Dockerfile` | Builds the `sctg/claw` runtime image **from the `openclaw/` submodule source**, not from the published `openclaw/openclaw` Docker Hub image. See [Why build from source](#why-build-openclaw-from-source). |
| `docker-build.sh` | Wrapper that builds the image with the correct context (`./openclaw`) and Dockerfile path. Use this instead of a bare `docker build .` — see the comment at the top of the `Dockerfile` for why the context matters. |
| `.github/workflows/docker-publish.yml` | CI: builds and publishes `sctg/claw` for both `linux/amd64` and `linux/arm64` natively (see [CI/CD](#cicd)). |
| `.values.yaml` | **Not committed** (listed in `.gitignore`). Private Helm values overlay containing real secrets, tunnel credentials, and OAuth client config for this specific deployment. |

## Providers

The image bundles 5 model/tool providers, each configured with a comma-separated pool of API keys for basic key rotation on rate limits:

- **Mistral**
- **Cohere**
- **Poolside** — vendored under `extensions/poolside` on the `sctg-claw` branch, not part of upstream OpenClaw. Poolside's own `@poolside/openclaw-provider` ClawHub package (MIT-licensed) ships only a built `dist/index.js`; its source repo is private. That build output is checked in as pseudo-source and patched for API-key rotation the same way as the other providers — see `openclaw/extensions/poolside/README.md`.
- **Exa** (web search)
- **Firecrawl** (web scraping)

The image also bundles the `parallel` search plugin and three extra CLI tools (`gog`, `goplaces`, `wacli`) used outside the 5 core providers.

## Why build OpenClaw from source

Two features this deployment relies on — trusted-proxy `deviceAutoApprove` and the `agents.defaults.modelPolicy.allow` model allow-list — are not yet part of any published OpenClaw release (confirmed against the `openclaw/openclaw:latest` image, which resolves to `2026.7.1`: `openclaw config validate` rejects both keys there). They only exist on the `openclaw` submodule's current commit.

The `Dockerfile` therefore builds the image directly from that pinned submodule commit using OpenClaw's own multi-stage build (copied verbatim from `openclaw/Dockerfile`, plus this repo's provider/plugin additions layered on top). This is an explicit trade-off: the deployment runs **unreleased** OpenClaw code. Advancing the submodule pin (`git submodule update`) should be a deliberate, reviewed action, not routine maintenance.

### Submodule branches

The submodule (`git@github.com:TEA-ching/openclaw.git`) tracks a `sctg-claw` branch, not upstream `main` directly:

- **`provider-rotate`** — a fix for mistral/cohere/exa/firecrawl: each provider's manifest only recognized the singular `<PROVIDER>_API_KEY` env var, so a key pool configured only via `<PROVIDER>_API_KEYS` (this chart's default) never activated the provider, and none of the four actually rotated across a configured pool on rate limits even when both vars were set. Proposed upstream; see the branch for the PR.
- **`sctg-claw`** — upstream `main` merged with `provider-rotate`, plus the vendored Poolside provider (`extensions/poolside`, see [Providers](#providers)) patched the same way. This is the branch the `Dockerfile`/CI actually build. Poolside isn't part of upstream OpenClaw, so it stays `sctg-claw`-only; once `provider-rotate` lands upstream, `sctg-claw` otherwise collapses back to upstream `main` plus just that one addition.

## Building the image

```bash
git submodule update --init --recursive   # first time / after a fresh clone

./docker-build.sh                         # local build, tag sctg/claw:local
./docker-build.sh -t sctg/claw:latest     # custom tag
./docker-build.sh --push                  # multi-arch (amd64+arm64) build + push via buildx
```

Do **not** run `docker build .` from this repo's root — the build context must be `./openclaw` (the submodule root), since the upstream build stages `COPY` the OpenClaw monorepo tree (`extensions/`, `packages/`, `scripts/`, ...) relative to the context root. `docker-build.sh` gets this right; a bare `docker build .` fails with `"/extensions": not found`.

## CI/CD

`.github/workflows/docker-publish.yml` builds both target platforms **natively** — no QEMU:

- `linux/amd64` on a `ubuntu-24.04` runner
- `linux/arm64` on a `ubuntu-24.04-arm` runner (GitHub-hosted, native arm64, free for public repos)

Each platform job pushes its image by digest; a final `merge` job combines both digests into one multi-arch manifest list under the release tags. This avoids QEMU cross-compilation deliberately: OpenClaw's own Dockerfile notes that its A2UI (canvas) bundle can silently fall back to a non-functional stub under QEMU, and this deployment's real cluster is majority arm64 (7 of 8 nodes) — that's not an acceptable trade-off for the primary target architecture.

The workflow triggers on changes to `Dockerfile` or to the `openclaw` submodule pointer itself, so bumping the pinned commit re-builds and re-publishes automatically.

## Configuration

The chart aims to keep 100% of the deployment-specific configuration in one private values file:

- `sctg-claw/values.yaml` — chart defaults, safe to commit, no secrets.
- `.values.yaml` (this repo's root, **git-ignored**) — the actual deployment overlay: API keys, Cloudflare Tunnel credentials, GitHub OAuth client secret, and any `openclaw.config` overrides.

`openclaw.config` is a free-form pass-through rendered directly into `/home/node/.openclaw/openclaw.json` inside the container, so OpenClaw config keys can be set there without touching chart templates, for example:

```yaml
openclaw:
  config:
    agents:
      defaults:
        model:
          primary: "poolside/laguna-s-2.1"       # default model
        modelPolicy:
          allow: ["poolside/*", "mistral/*"]      # optional allow-list; empty/absent = any model
    gateway:
      auth:
        mode: trusted-proxy
        trustedProxy:
          userHeader: "x-forwarded-email"
          allowUsers: ["you@example.com"]
          deviceAutoApprove:
            enabled: true
            scopes: ["operator.read", "operator.write", "operator.approvals"]  # never operator.admin here
```

Two things to keep in mind when editing this section:

- Helm deep-merges values files rather than replacing whole objects. Switching `gateway.auth.mode` away from `token` still requires explicitly nulling out the chart's default `gateway.auth.token` block (`token: null`), or the gateway refuses to start in `trusted-proxy` mode with a configured token also present.
- Keep `operator.admin` out of `deviceAutoApprove.scopes` — every allow-listed identity would otherwise auto-receive full admin on its first device with no approval step.

## Deploying

```bash
helm dependency build ./sctg-claw
helm upgrade --install sctg-claw ./sctg-claw -f .values.yaml --namespace claw --create-namespace
```

## Status and known follow-ups

- **Dev environment**: Docker Desktop's built-in Kubernetes cluster.
- **Target**: an 8-node cluster (7× arm64, 1× amd64).
- **Open item**: `gateway.auth.mode: trusted-proxy` trusts the `X-Forwarded-Email` header from any caller inside `gateway.trustedProxies` (currently the whole `10.0.0.0/8` pod CIDR by default). A `NetworkPolicy` restricting which pods can reach the OpenClaw `Service` to oauth2-proxy only is the natural hardening step before this is exposed beyond a single-tenant dev cluster.
- **Open item**: `sctg-claw/values.schema.json` documents the chart's own values but intentionally leaves the vendored `cloudflared`/`oauth2-proxy` sub-chart values and `openclaw.config`'s internals loosely typed, since those are owned upstream.
