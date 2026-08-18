package tests

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/db"
)

func setupTestDB(t *testing.T) (*db.DB, string) {
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")
	
	cfg := &db.Config{Path: dbPath}
	database, err := db.NewDB(cfg)
	if err != nil {
		t.Fatalf("Failed to create test database: %v", err)
	}
	
	return database, dbPath
}

func TestCreateDeviceAuthorization(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	transactionID := "test-transaction-1"
	githubDeviceCodeEncrypted := "encrypted-device-code"
	userCode := "ABCD-1234"
	verificationURI := "https://github.com/login/device"
	githubPollInterval := 5
	githubExpiresAt := int(time.Now().Add(15 * time.Minute).Unix())
	pollAfterSeconds := 5

	err := testDB.CreateDeviceAuthorization(
		transactionID,
		githubDeviceCodeEncrypted,
		userCode,
		verificationURI,
		githubPollInterval,
		githubExpiresAt,
		pollAfterSeconds,
	)
	if err != nil {
		t.Fatalf("Failed to create device authorization: %v", err)
	}

	// Retrieve and verify
	auth, err := testDB.GetDeviceAuthorization(transactionID)
	if err != nil {
		t.Fatalf("Failed to get device authorization: %v", err)
	}

	if auth == nil {
		t.Fatal("Expected device authorization to exist")
	}

	if auth.ID != transactionID {
		t.Errorf("Expected ID '%s', got '%s'", transactionID, auth.ID)
	}

	if auth.UserCode != userCode {
		t.Errorf("Expected UserCode '%s', got '%s'", userCode, auth.UserCode)
	}

	if auth.VerificationURI != verificationURI {
		t.Errorf("Expected VerificationURI '%s', got '%s'", verificationURI, auth.VerificationURI)
	}

	if auth.GitHubPollInterval != githubPollInterval {
		t.Errorf("Expected GitHubPollInterval %d, got %d", githubPollInterval, auth.GitHubPollInterval)
	}
}

func TestUpdateDeviceAuthorizationStatus(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	transactionID := "test-transaction-2"
	testDB.CreateDeviceAuthorization(
		transactionID,
		"encrypted-code",
		"ABCD-5678",
		"https://github.com/login/device",
		5,
		int(time.Now().Add(15 * time.Minute).Unix()),
		5,
	)

	// Update status
	err := testDB.UpdateDeviceAuthorizationStatus(transactionID, "approved", "test@example.com")
	if err != nil {
		t.Fatalf("Failed to update device authorization status: %v", err)
	}

	// Verify
	auth, err := testDB.GetDeviceAuthorization(transactionID)
	if err != nil {
		t.Fatalf("Failed to get device authorization: %v", err)
	}

	if auth.Status != "approved" {
		t.Errorf("Expected status 'approved', got '%s'", auth.Status)
	}

	if auth.ApprovedEmail != "test@example.com" {
		t.Errorf("Expected approved email 'test@example.com', got '%s'", auth.ApprovedEmail)
	}
}

func TestCreateMobileDevice(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	deviceID := "test-device-1"
	email := "test@example.com"

	err := testDB.CreateMobileDevice(deviceID, email, "test metadata")
	if err != nil {
		t.Fatalf("Failed to create mobile device: %v", err)
	}

	// Retrieve and verify
	device, err := testDB.GetMobileDevice(deviceID)
	if err != nil {
		t.Fatalf("Failed to get mobile device: %v", err)
	}

	if device == nil {
		t.Fatal("Expected mobile device to exist")
	}

	if device.ID != deviceID {
		t.Errorf("Expected ID '%s', got '%s'", deviceID, device.ID)
	}

	if device.Email != email {
		t.Errorf("Expected email '%s', got '%s'", email, device.Email)
	}
}

func TestCreateRefreshSession(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	// First create a device
	deviceID := "test-device-2"
	testDB.CreateMobileDevice(deviceID, "test@example.com", "")

	// Create refresh session
	sessionID := "test-session-1"
	tokenHash := "hashed-token-1"
	parentHash := ""
	issuedAt := time.Now()
	expiresAt := issuedAt.Add(30 * 24 * time.Hour)

	err := testDB.CreateRefreshSession(sessionID, deviceID, tokenHash, parentHash, issuedAt, expiresAt)
	if err != nil {
		t.Fatalf("Failed to create refresh session: %v", err)
	}

	// Retrieve and verify
	session, err := testDB.GetRefreshSession(tokenHash)
	if err != nil {
		t.Fatalf("Failed to get refresh session: %v", err)
	}

	if session == nil {
		t.Fatal("Expected refresh session to exist")
	}

	if session.ID != sessionID {
		t.Errorf("Expected ID '%s', got '%s'", sessionID, session.ID)
	}

	if session.DeviceID != deviceID {
		t.Errorf("Expected DeviceID '%s', got '%s'", deviceID, session.DeviceID)
	}

	if session.TokenHash != tokenHash {
		t.Errorf("Expected TokenHash '%s', got '%s'", tokenHash, session.TokenHash)
	}
}

func TestRotateRefreshSession(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	// First create a device
	deviceID := "test-device-3"
	testDB.CreateMobileDevice(deviceID, "test@example.com", "")

	// Create initial refresh session
	oldSessionID := "test-session-2"
	oldTokenHash := "hashed-token-2"
	issuedAt := time.Now()
	expiresAt := issuedAt.Add(30 * 24 * time.Hour)
	testDB.CreateRefreshSession(oldSessionID, deviceID, oldTokenHash, "", issuedAt, expiresAt)

	// Rotate to new session
	newSessionID := "test-session-3"
	newTokenHash := "hashed-token-3"
	newExpiresAt := issuedAt.Add(30 * 24 * time.Hour)

	err := testDB.RotateRefreshSession(oldSessionID, oldTokenHash, newSessionID, newTokenHash, newExpiresAt)
	if err != nil {
		t.Fatalf("Failed to rotate refresh session: %v", err)
	}

	// Verify old session is marked as rotated
	oldSession, err := testDB.GetRefreshSession(oldTokenHash)
	if err != nil {
		t.Fatalf("Failed to get old refresh session: %v", err)
	}

	if oldSession == nil {
		t.Fatal("Expected old refresh session to exist")
	}

	if oldSession.RotatedAt == nil {
		t.Error("Expected old session to have RotatedAt set")
	}

	// Verify new session exists
	newSession, err := testDB.GetRefreshSession(newTokenHash)
	if err != nil {
		t.Fatalf("Failed to get new refresh session: %v", err)
	}

	if newSession == nil {
		t.Fatal("Expected new refresh session to exist")
	}

	if newSession.ID != newSessionID {
		t.Errorf("Expected new session ID '%s', got '%s'", newSessionID, newSession.ID)
	}

	if newSession.ParentHash != oldTokenHash {
		t.Errorf("Expected parent hash '%s', got '%s'", oldTokenHash, newSession.ParentHash)
	}
}

func TestCreateAccessSession(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	// First create a device
	deviceID := "test-device-4"
	testDB.CreateMobileDevice(deviceID, "test@example.com", "")

	// Create access session
	sessionID := "test-access-session-1"
	tokenHash := "hashed-access-token-1"
	issuedAt := time.Now()
	expiresAt := issuedAt.Add(1 * time.Hour)

	err := testDB.CreateAccessSession(sessionID, deviceID, tokenHash, issuedAt, expiresAt)
	if err != nil {
		t.Fatalf("Failed to create access session: %v", err)
	}

	// Retrieve and verify
	session, err := testDB.GetAccessSession(tokenHash)
	if err != nil {
		t.Fatalf("Failed to get access session: %v", err)
	}

	if session == nil {
		t.Fatal("Expected access session to exist")
	}

	if session.ID != sessionID {
		t.Errorf("Expected ID '%s', got '%s'", sessionID, session.ID)
	}

	if session.DeviceID != deviceID {
		t.Errorf("Expected DeviceID '%s', got '%s'", deviceID, session.DeviceID)
	}
}

func TestRevokeMobileDevice(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	// Create a device with sessions
	deviceID := "test-device-5"
	testDB.CreateMobileDevice(deviceID, "test@example.com", "")

	// Create refresh session
	refreshSessionID := "test-session-4"
	refreshTokenHash := "hashed-refresh-token-4"
	issuedAt := time.Now()
	expiresAt := issuedAt.Add(30 * 24 * time.Hour)
	testDB.CreateRefreshSession(refreshSessionID, deviceID, refreshTokenHash, "", issuedAt, expiresAt)

	// Create access session
	accessSessionID := "test-access-session-2"
	accessTokenHash := "hashed-access-token-2"
	testDB.CreateAccessSession(accessSessionID, deviceID, accessTokenHash, issuedAt, issuedAt.Add(1*time.Hour))

	// Revoke device
	err := testDB.RevokeMobileDevice(deviceID)
	if err != nil {
		t.Fatalf("Failed to revoke mobile device: %v", err)
	}

	// Verify device is revoked
	device, err := testDB.GetMobileDevice(deviceID)
	if err != nil {
		t.Fatalf("Failed to get mobile device: %v", err)
	}

	if device == nil {
		t.Fatal("Expected mobile device to exist")
	}

	if device.RevokedAt == nil {
		t.Error("Expected device to have RevokedAt set")
	}

	// Verify refresh session is revoked
	refreshSession, err := testDB.GetRefreshSession(refreshTokenHash)
	if err != nil {
		t.Fatalf("Failed to get refresh session: %v", err)
	}

	if refreshSession == nil {
		t.Fatal("Expected refresh session to exist")
	}

	if refreshSession.RevokedAt == nil {
		t.Error("Expected refresh session to have RevokedAt set")
	}

	// Verify access session is revoked
	accessSession, err := testDB.GetAccessSession(accessTokenHash)
	if err != nil {
		t.Fatalf("Failed to get access session: %v", err)
	}

	if accessSession == nil {
		t.Fatal("Expected access session to exist")
	}

	if accessSession.RevokedAt == nil {
		t.Error("Expected access session to have RevokedAt set")
	}
}

func TestCleanupExpired(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	// Create expired device authorization
	pastTime := time.Now().Add(-1 * time.Hour)
	testDB.CreateDeviceAuthorization(
		"expired-transaction",
		"encrypted-code",
		"ABCD-9999",
		"https://github.com/login/device",
		5,
		int(pastTime.Unix()),
		5,
	)

	// Create non-expired device authorization
	futureTime := time.Now().Add(1 * time.Hour)
	testDB.CreateDeviceAuthorization(
		"valid-transaction",
		"encrypted-code",
		"ABCD-0000",
		"https://github.com/login/device",
		5,
		int(futureTime.Unix()),
		5,
	)

	// Run cleanup
	err := testDB.CleanupExpired()
	if err != nil {
		t.Fatalf("Failed to cleanup expired: %v", err)
	}

	// Verify valid still exists
	_, err = testDB.GetDeviceAuthorization("valid-transaction")
	if err != nil {
		t.Fatalf("Failed to get valid device authorization: %v", err)
	}
}

func TestAuditEvents(t *testing.T) {
	testDB, dbPath := setupTestDB(t)
	defer testDB.Close()
	defer os.RemoveAll(filepath.Dir(dbPath))

	// Create audit event
	err := testDB.CreateAuditEvent(
		"test_event",
		"device-1",
		"session-1",
		"test@example.com",
		"success",
		"Test event",
	)
	if err != nil {
		t.Fatalf("Failed to create audit event: %v", err)
	}

	// Retrieve events
	events, err := testDB.GetAuditEvents(10, "", "", "")
	if err != nil {
		t.Fatalf("Failed to get audit events: %v", err)
	}

	if len(events) != 1 {
		t.Errorf("Expected 1 audit event, got %d", len(events))
	}

	if events[0].EventCode != "test_event" {
		t.Errorf("Expected event code 'test_event', got '%s'", events[0].EventCode)
	}

	if events[0].Outcome != "success" {
		t.Errorf("Expected outcome 'success', got '%s'", events[0].Outcome)
	}
}
