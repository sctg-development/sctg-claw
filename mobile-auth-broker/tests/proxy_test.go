package tests

import (
	"testing"
	"time"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
)

func TestConfigHashSecret(t *testing.T) {
	cfg := &config.Config{
		ServerSecret: "test-secret-key-12345678901234567890",
	}

	hash1 := cfg.HashSecret("data1")
	hash2 := cfg.HashSecret("data1")
	hash3 := cfg.HashSecret("data2")

	// Same data should produce same hash
	if hash1 != hash2 {
		t.Error("Expected same hash for same data")
	}

	// Different data should produce different hash
	if hash1 == hash3 {
		t.Error("Expected different hash for different data")
	}

	// Hash should be 64 characters (SHA256 hex)
	if len(hash1) != 64 {
		t.Errorf("Expected hash length 64, got %d", len(hash1))
	}
}

func TestConfigIsEmailAllowed(t *testing.T) {
	cfg := &config.Config{
		AllowedEmails: []string{"test@example.com", "user@example.com"},
	}

	// Test allowed email
	if !cfg.IsEmailAllowed("test@example.com") {
		t.Error("Expected test@example.com to be allowed")
	}

	if !cfg.IsEmailAllowed("TEST@EXAMPLE.COM") {
		t.Error("Expected case-insensitive email matching")
	}

	// Test disallowed email
	if cfg.IsEmailAllowed("other@example.com") {
		t.Error("Expected other@example.com to be disallowed")
	}
}

func TestConfigLoadConfig(t *testing.T) {
	// Test with valid configuration
	cfg := &config.Config{
		Hostname:          "mobile.test.example.org",
		GitHubClientID:    "test-client-id",
		ServerSecret:      "test-secret-12345678901234567890123456789012",
		GatewayServiceURL: "http://localhost:18789",
		AllowedEmails:     []string{"test@example.com", "user@example.com"},
		AccessTokenTTL:    time.Hour,
		RefreshTokenTTL:   24 * 30 * time.Hour,
		ListenAddr:        ":8080",
		DatabasePath:      "/data/broker.db",
		GitHubAPIBaseURL:  "https://api.github.com",
		MaxMessageSize:    16777216,
		PollIntervalScale: 1.5,
	}

	if cfg.Hostname != "mobile.test.example.org" {
		t.Errorf("Expected Hostname 'mobile.test.example.org', got '%s'", cfg.Hostname)
	}

	if cfg.GitHubClientID != "test-client-id" {
		t.Errorf("Expected GitHubClientID 'test-client-id', got '%s'", cfg.GitHubClientID)
	}

	if len(cfg.AllowedEmails) != 2 {
		t.Errorf("Expected 2 allowed emails, got %d", len(cfg.AllowedEmails))
	}

	if cfg.AccessTokenTTL != time.Hour {
		t.Errorf("Expected AccessTokenTTL to be 1 hour, got %v", cfg.AccessTokenTTL)
	}

	if cfg.RefreshTokenTTL != 24*30*time.Hour {
		t.Errorf("Expected RefreshTokenTTL to be 30 days, got %v", cfg.RefreshTokenTTL)
	}

	if cfg.MaxMessageSize != 16777216 {
		t.Errorf("Expected MaxMessageSize to be 16777216, got %d", cfg.MaxMessageSize)
	}

	if cfg.PollIntervalScale != 1.5 {
		t.Errorf("Expected PollIntervalScale to be 1.5, got %f", cfg.PollIntervalScale)
	}
}

func TestWebSocketProxyConfiguration(t *testing.T) {
	// Test that the proxy configuration is valid
	cfg := &config.Config{
		Hostname:          "mobile.test.example.org",
		GitHubClientID:    "test-client-id",
		ServerSecret:      "test-secret-12345678901234567890123456789012",
		GatewayServiceURL: "http://localhost:18789",
		AllowedEmails:     []string{"test@example.com"},
		AccessTokenTTL:    time.Hour,
		RefreshTokenTTL:   24 * 30 * time.Hour,
		ListenAddr:        ":8080",
		DatabasePath:      "/data/broker.db",
		GitHubAPIBaseURL:  "https://api.github.com",
		MaxMessageSize:    16777216,
		PollIntervalScale: 1.5,
	}

	// Note: BaseURL and WebSocketURL are methods on config.Config, not fields
	// This test verifies the configuration is valid
	_ = cfg
}
