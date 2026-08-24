package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/proxy"
)

func TestHandleHTTPForwardsAllowedPathWithTrustedProxyHeader(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	t.Cleanup(func() { testDB.Close() })
	_ = dbPath

	var gatewayRequest *http.Request
	gatewayServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gatewayRequest = r
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("<html>control-ui</html>"))
	}))
	t.Cleanup(gatewayServer.Close)

	cfg := &config.Config{
		Hostname:          "mobile.test.example.org",
		ServerSecret:      "test-secret",
		AllowedEmails:     []string{"user@example.org"},
		AccessTokenTTL:    time.Hour,
		GatewayServiceURL: gatewayServer.URL,
	}

	deviceID := "device-http-1"
	if err := testDB.CreateMobileDevice(deviceID, "user@example.org", "{}"); err != nil {
		t.Fatalf("failed to seed mobile device: %v", err)
	}
	accessToken := "test-access-token"
	now := time.Now()
	if err := testDB.CreateAccessSession(
		"access-session-1", deviceID, cfg.HashSecret(accessToken), now, now.Add(cfg.AccessTokenTTL),
	); err != nil {
		t.Fatalf("failed to seed access session: %v", err)
	}

	wsProxy := proxy.NewWebSocketProxy(cfg, testDB)
	server := httptest.NewServer(http.HandlerFunc(wsProxy.HandleHTTP))
	t.Cleanup(server.Close)

	req, _ := http.NewRequest(http.MethodGet, server.URL+"/__openclaw__/config", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if gatewayRequest == nil {
		t.Fatal("Gateway never received the forwarded request")
	}
	if got := gatewayRequest.Header.Get("X-Forwarded-Email"); got != "user@example.org" {
		t.Errorf("expected X-Forwarded-Email=user@example.org, got %q", got)
	}
	if gatewayRequest.URL.Path != "/__openclaw__/config" {
		t.Errorf("expected forwarded path /__openclaw__/config, got %q", gatewayRequest.URL.Path)
	}
}

func TestHandleHTTPDeniesGatewayAPIPrefixes(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	t.Cleanup(func() { testDB.Close() })
	_ = dbPath

	gatewayReached := false
	gatewayServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gatewayReached = true
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(gatewayServer.Close)

	cfg := &config.Config{
		Hostname:          "mobile.test.example.org",
		ServerSecret:      "test-secret",
		AllowedEmails:     []string{"user@example.org"},
		AccessTokenTTL:    time.Hour,
		GatewayServiceURL: gatewayServer.URL,
	}

	deviceID := "device-http-2"
	testDB.CreateMobileDevice(deviceID, "user@example.org", "{}")
	accessToken := "test-access-token-2"
	now := time.Now()
	testDB.CreateAccessSession("access-session-2", deviceID, cfg.HashSecret(accessToken), now, now.Add(cfg.AccessTokenTTL))

	wsProxy := proxy.NewWebSocketProxy(cfg, testDB)
	server := httptest.NewServer(http.HandlerFunc(wsProxy.HandleHTTP))
	t.Cleanup(server.Close)

	deniedPaths := []string{"/v1/chat/completions", "/api/v1/admin/rpc", "/plugins/foo", "/mcp"}
	for _, path := range deniedPaths {
		req, _ := http.NewRequest(http.MethodGet, server.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+accessToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request to %s failed: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("path %s: expected 404, got %d", path, resp.StatusCode)
		}
	}
	if gatewayReached {
		t.Error("denied path reached the Gateway backend")
	}
}

func TestHandleHTTPRejectsNonReadMethods(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	t.Cleanup(func() { testDB.Close() })
	_ = dbPath

	gatewayReached := false
	gatewayServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gatewayReached = true
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(gatewayServer.Close)

	cfg := &config.Config{
		Hostname:          "mobile.test.example.org",
		ServerSecret:      "test-secret",
		AllowedEmails:     []string{"user@example.org"},
		AccessTokenTTL:    time.Hour,
		GatewayServiceURL: gatewayServer.URL,
	}

	deviceID := "device-http-3"
	testDB.CreateMobileDevice(deviceID, "user@example.org", "{}")
	accessToken := "test-access-token-3"
	now := time.Now()
	testDB.CreateAccessSession("access-session-3", deviceID, cfg.HashSecret(accessToken), now, now.Add(cfg.AccessTokenTTL))

	wsProxy := proxy.NewWebSocketProxy(cfg, testDB)
	server := httptest.NewServer(http.HandlerFunc(wsProxy.HandleHTTP))
	t.Cleanup(server.Close)

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/__openclaw__/config", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for POST, got %d", resp.StatusCode)
	}
	if gatewayReached {
		t.Error("POST reached the Gateway backend")
	}
}
