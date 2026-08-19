package tests

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/github"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/models"
)

func TestGitHubClient_RequestDeviceAuthorization(t *testing.T) {
	// Create a test server that mocks GitHub's device authorization endpoint
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify request
		if r.Method != "POST" {
			t.Errorf("Expected POST method, got %s", r.Method)
		}

		if r.URL.Path != "/login/device/code" {
			t.Errorf("Expected path /login/device/code, got %s", r.URL.Path)
		}

		// Verify client_id
		body, _ := io.ReadAll(r.Body)
		if !bytes.Contains(body, []byte("client_id=test-client-id")) {
			t.Errorf("Expected client_id in body, got %s", string(body))
		}

		if !bytes.Contains(body, []byte("scope=user:email")) {
			t.Errorf("Expected scope in body, got %s", string(body))
		}

		// Return mock response
		response := models.GitHubDeviceAuth{
			DeviceCode:      "test-device-code",
			UserCode:        "ABCD-1234",
			VerificationURI: "https://github.com/login/device",
			ExpiresIn:       900,
			Interval:        5,
			GrantType:       "urn:ietf:params:oauth:grant-type:device_code",
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	client := github.NewClient("test-client-id", server.URL)
	client.SetOAuthBaseURL(server.URL)

	resp, err := client.RequestDeviceAuthorization("user:email")
	if err != nil {
		t.Fatalf("Failed to request device authorization: %v", err)
	}

	if resp.DeviceCode != "test-device-code" {
		t.Errorf("Expected device code 'test-device-code', got '%s'", resp.DeviceCode)
	}

	if resp.UserCode != "ABCD-1234" {
		t.Errorf("Expected user code 'ABCD-1234', got '%s'", resp.UserCode)
	}

	if resp.VerificationURI != "https://github.com/login/device" {
		t.Errorf("Expected verification URI 'https://github.com/login/device', got '%s'", resp.VerificationURI)
	}

	if resp.ExpiresIn != 900 {
		t.Errorf("Expected expires_in 900, got %d", resp.ExpiresIn)
	}

	if resp.Interval != 5 {
		t.Errorf("Expected interval 5, got %d", resp.Interval)
	}
}

func TestGitHubClient_PollDeviceAuthorization_Pending(t *testing.T) {
	// Create a test server that returns authorization_pending
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify request
		if r.Method != "POST" {
			t.Errorf("Expected POST method, got %s", r.Method)
		}

		if r.URL.Path != "/login/oauth/access_token" {
			t.Errorf("Expected path /login/oauth/access_token, got %s", r.URL.Path)
		}

		// GitHub always answers 200 OK; the pending state lives in the body.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":             "authorization_pending",
			"error_description": "Authorization pending",
		})
	}))
	defer server.Close()

	client := github.NewClient("test-client-id", server.URL)
	client.SetOAuthBaseURL(server.URL)

	token, auth, err := client.PollDeviceAuthorization("test-device-code")
	if err != nil {
		t.Fatalf("Failed to poll device authorization: %v", err)
	}

	if token != nil {
		t.Error("Expected no token for pending authorization")
	}

	if auth != nil {
		t.Error("Expected no auth response for plain pending authorization (only slow_down carries one)")
	}
}

func TestGitHubClient_PollDeviceAuthorization_SlowDown(t *testing.T) {
	// Create a test server that returns slow_down
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// GitHub always answers 200 OK; slow_down lives in the body too.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":             "slow_down",
			"error_description": "Slow down",
			"interval":          10,
		})
	}))
	defer server.Close()

	client := github.NewClient("test-client-id", server.URL)
	client.SetOAuthBaseURL(server.URL)

	token, auth, err := client.PollDeviceAuthorization("test-device-code")
	if err != nil {
		t.Fatalf("Failed to poll device authorization: %v", err)
	}

	if token != nil {
		t.Error("Expected no token for slow_down")
	}

	if auth == nil {
		t.Error("Expected auth response for slow_down")
	}

	if auth.Interval != 10 {
		t.Errorf("Expected interval 10, got %d", auth.Interval)
	}
}

func TestGitHubClient_PollDeviceAuthorization_Success(t *testing.T) {
	// Create a test server that returns a token
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "test-access-token",
			"token_type":   "bearer",
			"scope":       "user:email",
		})
	}))
	defer server.Close()

	client := github.NewClient("test-client-id", server.URL)
	client.SetOAuthBaseURL(server.URL)

	token, auth, err := client.PollDeviceAuthorization("test-device-code")
	if err != nil {
		t.Fatalf("Failed to poll device authorization: %v", err)
	}

	if token == nil {
		t.Error("Expected token for successful authorization")
	}

	if token.AccessToken != "test-access-token" {
		t.Errorf("Expected access token 'test-access-token', got '%s'", token.AccessToken)
	}

	if token.TokenType != "bearer" {
		t.Errorf("Expected token type 'bearer', got '%s'", token.TokenType)
	}

	if auth != nil {
		t.Error("Expected no auth response for successful authorization")
	}
}

func TestGitHubClient_GetUserEmails(t *testing.T) {
	// Create a test server that returns user emails
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify Authorization header
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-access-token" {
			t.Errorf("Expected Authorization header 'Bearer test-access-token', got '%s'", auth)
		}

		// Return mock emails
		emails := []models.GitHubEmail{
			{
				Email:   "primary@example.com",
				Primary: true,
				Verified: true,
			},
			{
				Email:   "secondary@example.com",
				Primary: false,
				Verified: true,
			},
			{
				Email:   "unverified@example.com",
				Primary: false,
				Verified: false,
			},
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(emails)
	}))
	defer server.Close()

	client := github.NewClient("test-client-id", server.URL)

	emails, err := client.GetUserEmails("test-access-token")
	if err != nil {
		t.Fatalf("Failed to get user emails: %v", err)
	}

	if len(emails) != 3 {
		t.Errorf("Expected 3 emails, got %d", len(emails))
	}

	// Find primary verified email
	var primaryEmail string
	for _, email := range emails {
		if email.Primary && email.Verified {
			primaryEmail = email.Email
			break
		}
	}

	if primaryEmail != "primary@example.com" {
		t.Errorf("Expected primary email 'primary@example.com', got '%s'", primaryEmail)
	}
}

func TestGitHubClient_RevokeToken(t *testing.T) {
	// Create a test server that accepts token revocation
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify Authorization header
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-access-token" {
			t.Errorf("Expected Authorization header 'Bearer test-access-token', got '%s'", auth)
		}

		// Verify method
		if r.Method != "DELETE" {
			t.Errorf("Expected DELETE method, got %s", r.Method)
		}

		// Return success
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := github.NewClient("test-client-id", server.URL)

	err := client.RevokeToken("test-access-token")
	if err != nil {
		t.Fatalf("Failed to revoke token: %v", err)
	}
}
