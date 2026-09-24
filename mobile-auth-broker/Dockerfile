# Build the mobile-auth-broker service.
# go 1.25+ required by the go-acme/lego dependency (internal/tlscert, ACME
# DNS-01 cert issuance) -- see go.mod.
FROM golang:1.25-bookworm AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git build-essential && \
    rm -rf /var/lib/apt/lists/*

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# go-sqlite3 requires cgo; build-essential above provides the glibc gcc toolchain
RUN CGO_ENABLED=1 GOOS=linux go build -o /mobile-auth-broker ./cmd/main.go

# cirond, built from the same pinned "k8s" branch as the sctg-claw image (see
# ../Dockerfile's ciron_builder stage). Kept in its own stage so the builder
# image above doesn't carry a Rust toolchain.
FROM golang:1.25-bookworm AS ciron_builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates build-essential git pkg-config libssl-dev protobuf-compiler && \
    rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
RUN cd / && git clone --branch k8s https://github.com/sctg-development/ciron.git && \
    . ~/.cargo/env && cd ciron && cargo build --release

# Final stage. Debian (glibc), not Alpine: it has to run both the cgo/glibc
# Go binary above and the apt-packaged `tailscale`/`tailscaled` binaries
# (only needed for the optional tailnet bypass -- see internal/tailnet).
FROM debian:bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tzdata bash curl gnupg kmod libcap2-bin && \
    curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg && \
    curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list && \
    apt-get update && apt-get install -y --no-install-recommends tailscale && \
    apt-get purge -y --auto-remove curl gnupg && \
    rm -rf /var/lib/apt/lists/*
# kmod (modprobe): used by the Helm chart's privileged tailnet-bypass init
# container to load the host's `tun` kernel module -- see
# templates/mobile-auth-broker.yaml.

# cirond process manager -- supervises mobile-auth-broker plus, when the
# tailnet bypass is enabled (see scripts/ciron.toml), tailscaled/tailscale.
# When the bypass is disabled (the default), the Helm chart overrides this
# image's command to run /app/mobile-auth-broker directly and cirond is
# never invoked.
COPY --from=ciron_builder /ciron/target/release/cirond /usr/sbin/cirond
COPY --from=ciron_builder /ciron/target/release/cironctl /usr/sbin/cironctl
COPY --from=builder /mobile-auth-broker /app/mobile-auth-broker
COPY scripts/ciron.toml /etc/ciron/ciron.toml

# Non-root by default. tailscaled still gets a real TUN device when the
# bypass is enabled: the Helm chart grants this UID the NET_ADMIN/NET_RAW
# capabilities instead of running the container as root (the container's
# /dev/net/tun is host-provided and world-writable for exactly this
# rootless-with-capabilities pattern).
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser && \
    mkdir -p /data /run/tailscale /var/lib/tailscale && \
    chown -R appuser:appgroup /app /data /run/tailscale /var/lib/tailscale

# File capabilities: for a non-root container UID, Kubernetes/containerd
# only puts securityContext.capabilities.add into the process's BOUNDING
# set, not its effective/permitted set (confirmed live via /proc/1/status:
# CapBnd had the requested capabilities, CapEff was all zero) -- both
# tailscaled's TUNSETIFF (real TUN device, tailnet bypass) and
# mobile-auth-broker's own bind(2) on privileged TLS ports like 443 (see
# internal/tlscert) got EPERM despite the pod manifest correctly declaring
# the capabilities. File capabilities are the standard fix: exec'ing a
# binary with its own file caps pulls them from the (still-present)
# bounding set into the new process's effective set, without needing full
# root. This also requires allowPrivilegeEscalation: true in the pod's
# securityContext -- the default false sets PR_SET_NO_NEW_PRIVS, which the
# kernel explicitly uses to refuse granting file capabilities on exec
# regardless of this setcap.
#
# MUST run after the chown above, not before: chown strips a file's
# security.capability xattr (confirmed live -- setcap-then-chown silently
# produced a binary with no capabilities at all, while tailscaled, never
# touched by that chown since it lives outside /app, kept its own).
RUN setcap 'cap_net_admin,cap_net_raw+eip' /usr/sbin/tailscaled && \
    setcap 'cap_net_bind_service+eip' /app/mobile-auth-broker
USER appuser

EXPOSE 8080

ENTRYPOINT ["/usr/sbin/cirond", "-c", "/etc/ciron/ciron.toml"]
