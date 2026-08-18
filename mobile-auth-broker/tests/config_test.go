package tests

import (
	"os"
	"testing"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
)

func TestLoadConfig(t *testing.T) {
	// Set required environment variables
	os.Setenv("GITHUB_CLIENT_ID", "test-client-id")
	os.Setenv("SERVER_SECRET", "test-secret-12345678901234567890123456789012")
	os.Setenv("ALLOWED_EMAILS", "test@example.com,user@example.com")
	defer func() {
		os.Unsetenv("GITHUB_CLIENT_ID")
		os.Unsetenv("SERVER_SECRET")
		os.Unsetenv("ALLOWED_EMAILS")
	}()

	cfg, err := config.LoadConfig()
	if err != nil {
		t.Fatalf("Failed to load config: %v", err)
	}

	if cfg.GitHubClientID != "test-client-id" {
		t.Errorf("Expected GitHubClientID to be 'test-client-id', got '%s'", cfg.GitHubClientID)
	}

	if cfg.ServerSecret != "test-secret-12345678901234567890123456789012" {
		t.Errorf("Expected ServerSecret to be 'test-secret-...', got '%s'", cfg.ServerSecret)
	}

	if len(cfg.AllowedEmails) != 2 {
		t.Errorf("Expected 2 allowed emails, got %d", len(cfg.AllowedEmails))
	}

	if cfg.AllowedEmails[0] != "test@example.com" {
		t.Errorf("Expected first email to be 'test@example.com', got '%s'", cfg.AllowedEmails[0])
	}
}

func TestLoadConfigMissingRequired(t *testing.T) {
	// Test missing GitHubClientID
	os.Unsetenv("GITHUB_CLIENT_ID")
	os.Setenv("SERVER_SECRET", "test-secret-12345678901234567890123456789012")
	os.Setenv("ALLOWED_EMAILS", "test@example.com")
	defer func() {
		os.Unsetenv("SERVER_SECRET")
		os.Unsetenv("ALLOWED_EMAILS")
	}()

	_, err := config.LoadConfig()
	if err == nil {
		t.Error("Expected error when GITHUB_CLIENT_ID is missing")
	}

	// Test missing ServerSecret
	os.Setenv("GITHUB_CLIENT_ID", "test-client-id")
	os.Unsetenv("SERVER_SECRET")
	os.Setenv("ALLOWED_EMAILS", "test@example.com")
	defer func() {
		os.Unsetenv("GITHUB_CLIENT_ID")
		os.Unsetenv("ALLOWED_EMAILS")
	}()

	_, err = config.LoadConfig()
	if err == nil {
		t.Error("Expected error when SERVER_SECRET is missing")
	}

	// Test short ServerSecret
	os.Setenv("SERVER_SECRET", "short")
	defer os.Unsetenv("SERVER_SECRET")

	_, err = config.LoadConfig()
	if err == nil {
		t.Error("Expected error when SERVER_SECRET is too short")
	}

	// Test missing AllowedEmails
	os.Setenv("SERVER_SECRET", "test-secret-12345678901234567890123456789012")
	os.Unsetenv("ALLOWED_EMAILS")
	defer os.Unsetenv("SERVER_SECRET")

	_, err = config.LoadConfig()
	if err == nil {
		t.Error("Expected error when ALLOWED_EMAILS is missing")
	}
}

func TestIsEmailAllowed(t *testing.T) {
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

func TestHashSecret(t *testing.T) {
	cfg := &config.Config{
		ServerSecret: "test-secret-key",
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
