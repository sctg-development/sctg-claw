// Package tailnet verifies that a request genuinely originates from a
// Tailscale/Headscale peer of this node, as an alternative trust boundary to
// the GitHub Device Flow. It requires a real TUN interface (gateway.tailscale
// tunMode "tailscale0", not "userspace-networking"): with a real TUN device,
// tailscaled hands the app the peer's actual tailnet address on r.RemoteAddr,
// so a plain `tailscale whois` against the local control socket is enough --
// no loopback-NAT identity trick needed, unlike OpenClaw's own Gateway under
// userspace-networking (see docs/gateway/tailscale.md).
package tailnet

import (
	"context"
	"os/exec"
	"time"
)

// whoisTimeout bounds how long a single verification waits on the local
// tailscaled control socket before treating the peer as unverified.
const whoisTimeout = 3 * time.Second

// IsPeer reports whether ip is a live peer of this node on the tailnet,
// verified against the local tailscaled control socket at socket. It never
// trusts the source IP alone -- a non-tailnet process spoofing an address in
// the tailnet range still has to pass this daemon-backed check.
func IsPeer(socket, ip string) bool {
	if socket == "" || ip == "" {
		return false
	}

	ctx, cancel := context.WithTimeout(context.Background(), whoisTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "tailscale", "--socket="+socket, "whois", ip)
	return cmd.Run() == nil
}
