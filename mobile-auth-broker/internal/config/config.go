package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Hostname          string
	GitHubClientID    string
	ServerSecret      string
	GatewayServiceURL string
	AllowedEmails     []string
	AccessTokenTTL    time.Duration
	RefreshTokenTTL   time.Duration
	ListenAddr        string
	ListenPorts       []int
	DatabasePath      string
	GitHubAPIBaseURL  string
	MaxMessageSize    int64
	PollIntervalScale float64

	// TailnetEnabled authenticates any verified Tailscale/Headscale peer
	// (see internal/tailnet) as TailnetIdentity, bypassing the GitHub Device
	// Flow entirely. Tailnet membership is the trust boundary; every peer
	// gets the same forwarded identity, there is no per-user allowlist.
	TailnetEnabled  bool
	TailnetSocket   string
	TailnetIdentity string

	// TLSEnabled serves an additional, self-managed HTTPS listener on
	// TLSPorts using a real Let's Encrypt certificate for TLSDomain,
	// obtained via ACME DNS-01 against Cloudflare (see internal/tlscert).
	// This exists for native OpenClaw clients (iOS/macOS/Android), whose
	// sign-in flow hard-requires https:// -- ws:///http:// gateway URLs are
	// rejected client-side before any connection is attempted.
	TLSEnabled         bool
	TLSPorts           []int
	TLSDomain          string
	TLSEmail           string
	TLSCloudflareToken string
	TLSCertCacheDir    string
	TLSACMEStaging     bool
}

func LoadConfig() (*Config, error) {
	listenAddr := getEnv("LISTEN_ADDR", ":8080")
	cfg := &Config{
		Hostname:          getEnv("BROKER_HOSTNAME", "mobile.claw.example.org"),
		GitHubClientID:    getEnv("GITHUB_CLIENT_ID", ""),
		ServerSecret:      getEnv("SERVER_SECRET", ""),
		GatewayServiceURL: getEnv("GATEWAY_SERVICE_URL", "http://sctg-claw:18789"),
		AllowedEmails:     parseEmails(getEnv("ALLOWED_EMAILS", "")),
		AccessTokenTTL:    parseDuration(getEnv("ACCESS_TOKEN_TTL", "1h")),
		RefreshTokenTTL:   parseDuration(getEnv("REFRESH_TOKEN_TTL", "720h")),
		ListenAddr:        listenAddr,
		ListenPorts:       parseListenPorts(getEnv("LISTEN_PORTS", ""), listenAddr),
		DatabasePath:      getEnv("DATABASE_PATH", "/data/broker.db"),
		GitHubAPIBaseURL:  getEnv("GITHUB_API_BASE_URL", "https://api.github.com"),
		MaxMessageSize:    parseInt(getEnv("MAX_MESSAGE_SIZE", "16777216"), 16777216),
		PollIntervalScale: parseFloat(getEnv("POLL_INTERVAL_SCALE", "1.5"), 1.5),
		TailnetEnabled:    getEnv("TAILNET_ENABLED", "false") == "true",
		TailnetSocket:     getEnv("TAILNET_SOCKET", "/run/tailscale/tailscaled.sock"),
		TailnetIdentity:   getEnv("TAILNET_IDENTITY", ""),

		TLSEnabled:         getEnv("TLS_ENABLED", "false") == "true",
		TLSPorts:           parseListenPorts(getEnv("TLS_PORTS", "443"), ":443"),
		TLSDomain:          getEnv("TLS_DOMAIN", ""),
		TLSEmail:           getEnv("TLS_ACME_EMAIL", ""),
		TLSCloudflareToken: getEnv("TLS_CLOUDFLARE_API_TOKEN", ""),
		TLSCertCacheDir:    getEnv("TLS_CERT_CACHE_DIR", "/data/certs"),
		TLSACMEStaging:     getEnv("TLS_ACME_STAGING", "false") == "true",
	}

	if cfg.GitHubClientID == "" {
		return nil, fmt.Errorf("GITHUB_CLIENT_ID is required")
	}

	if cfg.ServerSecret == "" {
		return nil, fmt.Errorf("SERVER_SECRET is required")
	}

	if len(cfg.ServerSecret) < 32 {
		return nil, fmt.Errorf("SERVER_SECRET must be at least 32 bytes")
	}

	if len(cfg.AllowedEmails) == 0 {
		return nil, fmt.Errorf("ALLOWED_EMAILS must contain at least one email")
	}

	if cfg.TailnetEnabled && cfg.TailnetIdentity == "" {
		return nil, fmt.Errorf("TAILNET_IDENTITY is required when TAILNET_ENABLED is true")
	}

	if cfg.TLSEnabled {
		if cfg.TLSDomain == "" {
			return nil, fmt.Errorf("TLS_DOMAIN is required when TLS_ENABLED is true")
		}
		if cfg.TLSEmail == "" {
			return nil, fmt.Errorf("TLS_ACME_EMAIL is required when TLS_ENABLED is true")
		}
		if cfg.TLSCloudflareToken == "" {
			return nil, fmt.Errorf("TLS_CLOUDFLARE_API_TOKEN is required when TLS_ENABLED is true")
		}
	}

	return cfg, nil
}

func getEnv(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultValue
}

func parseEmails(s string) []string {
	emails := strings.Split(s, ",")
	result := make([]string, 0, len(emails))
	for _, email := range emails {
		trimmed := strings.TrimSpace(email)
		if trimmed != "" {
			result = append(result, strings.ToLower(trimmed))
		}
	}
	return result
}

// parseListenPorts reads a comma-separated port list from LISTEN_PORTS
// (e.g. "80,8080,18789", letting the broker accept connections on several
// ports at once -- useful for the tailnet bypass, where clients may expect
// a bare hostname (port 80) or the Gateway's own conventional port
// (18789) instead of the broker's default 8080). Falls back to the single
// port already parsed from LISTEN_ADDR when LISTEN_PORTS is unset, so
// existing single-port deployments are unaffected.
func parseListenPorts(listenPorts, listenAddr string) []int {
	if s := strings.TrimSpace(listenPorts); s != "" {
		var ports []int
		for _, p := range strings.Split(s, ",") {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			port, err := strconv.Atoi(p)
			if err != nil {
				continue
			}
			ports = append(ports, port)
		}
		if len(ports) > 0 {
			return ports
		}
	}

	_, portStr, err := net.SplitHostPort(listenAddr)
	if err != nil {
		return []int{8080}
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return []int{8080}
	}
	return []int{port}
}

func parseDuration(s string) time.Duration {
	duration, err := time.ParseDuration(s)
	if err != nil {
		return time.Hour
	}
	return duration
}

func parseInt(s string, defaultValue int64) int64 {
	value, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return defaultValue
	}
	return value
}

func parseFloat(s string, defaultValue float64) float64 {
	value, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return defaultValue
	}
	return value
}

func (c *Config) HashSecret(data string) string {
	h := sha256.New()
	h.Write([]byte(c.ServerSecret))
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func (c *Config) IsEmailAllowed(email string) bool {
	email = strings.ToLower(email)
	for _, allowed := range c.AllowedEmails {
		if allowed == email {
			return true
		}
	}
	return false
}
