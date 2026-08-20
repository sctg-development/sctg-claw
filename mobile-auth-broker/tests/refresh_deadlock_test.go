package tests

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/handler"
)

// TestRefreshSessionDoesNotDeadlockDB reproduces the mobile-auth-broker pod
// readiness incident: db.NewDB uses SetMaxOpenConns(1), so a handler that
// checks out that single connection via an unused outer transaction while
// also issuing further h.db.* calls on the same pool self-deadlocks forever.
// Once wedged, every later DB-touching request -- notably /readyz's
// CleanupExpired -- hangs indefinitely, and only a pod restart recovers.
// This must fail (hang past the deadline) on the pre-fix handler and pass
// once handleRefreshSession stops holding a redundant outer tx.
func TestRefreshSessionDoesNotDeadlockDB(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()

	cfg := &config.Config{
		Hostname:        "mobile.test.example.org",
		ServerSecret:    "test-secret",
		AllowedEmails:   []string{"user@example.org"},
		AccessTokenTTL:  time.Hour,
		RefreshTokenTTL: 720 * time.Hour,
		DatabasePath:    dbPath,
	}

	deviceID := "device-1"
	if err := testDB.CreateMobileDevice(deviceID, "user@example.org", "{}"); err != nil {
		t.Fatalf("failed to seed mobile device: %v", err)
	}

	refreshToken := "seed-refresh-token"
	refreshTokenHash := cfg.HashSecret(refreshToken)
	now := time.Now()
	if err := testDB.CreateRefreshSession(
		"refresh-session-1", deviceID, refreshTokenHash, "", now, now.Add(cfg.RefreshTokenTTL),
	); err != nil {
		t.Fatalf("failed to seed refresh session: %v", err)
	}

	h := handler.NewHandler(cfg, testDB)
	r := mux.NewRouter()
	h.RegisterRoutes(r)
	server := httptest.NewServer(r)
	defer server.Close()

	body, _ := json.Marshal(map[string]string{"refresh_token": refreshToken})
	resp, err := http.Post(server.URL+"/v1/sessions/refresh", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("refresh request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected refresh to succeed, got status %d", resp.StatusCode)
	}

	// A wedged single connection would make this hang forever (readyz's real
	// symptom); bound it so the test fails fast instead of hanging the suite.
	done := make(chan error, 1)
	go func() { done <- testDB.CleanupExpired() }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("CleanupExpired failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("CleanupExpired deadlocked after refresh -- the pool's single connection was never released")
	}
}
