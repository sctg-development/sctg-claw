package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Hostname           string
	GitHubClientID     string
	ServerSecret       string
	GatewayServiceURL  string
	AllowedEmails      []string
	AccessTokenTTL     time.Duration
	RefreshTokenTTL    time.Duration
	ListenAddr         string
	DatabasePath       string
	GitHubAPIBaseURL   string
	MaxMessageSize     int64
	PollIntervalScale  float64
}

func LoadConfig() (*Config, error) {
	cfg := &Config{
		Hostname:          getEnv("BROKER_HOSTNAME", "mobile.claw.example.org"),
		GitHubClientID:    getEnv("GITHUB_CLIENT_ID", ""),
		ServerSecret:      getEnv("SERVER_SECRET", ""),
		GatewayServiceURL: getEnv("GATEWAY_SERVICE_URL", "http://sctg-claw:18789"),
		AllowedEmails:     parseEmails(getEnv("ALLOWED_EMAILS", "")),
		AccessTokenTTL:    parseDuration(getEnv("ACCESS_TOKEN_TTL", "1h")),
		RefreshTokenTTL:   parseDuration(getEnv("REFRESH_TOKEN_TTL", "720h")),
		ListenAddr:        getEnv("LISTEN_ADDR", ":8080"),
		DatabasePath:      getEnv("DATABASE_PATH", "/data/broker.db"),
		GitHubAPIBaseURL:  getEnv("GITHUB_API_BASE_URL", "https://api.github.com"),
		MaxMessageSize:    parseInt(getEnv("MAX_MESSAGE_SIZE", "16777216"), 16777216),
		PollIntervalScale: parseFloat(getEnv("POLL_INTERVAL_SCALE", "1.5"), 1.5),
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
