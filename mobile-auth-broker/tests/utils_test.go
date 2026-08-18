package tests

import (
	"strings"
	"testing"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/utils"
)

func TestEncryptDecrypt(t *testing.T) {
	key := "test-secret-key-1234567890123456"
	plaintext := "test data to encrypt"

	encrypted, err := utils.Encrypt(plaintext, key)
	if err != nil {
		t.Fatalf("Failed to encrypt: %v", err)
	}

	decrypted, err := utils.Decrypt(encrypted, key)
	if err != nil {
		t.Fatalf("Failed to decrypt: %v", err)
	}

	if decrypted != plaintext {
		t.Errorf("Expected decrypted text to be '%s', got '%s'", plaintext, decrypted)
	}

	// Test with wrong key
	_, err = utils.Decrypt(encrypted, "wrong-key")
	if err == nil {
		t.Error("Expected error when decrypting with wrong key")
	}

	// Test with invalid ciphertext
	_, err = utils.Decrypt("invalid-ciphertext", key)
	if err == nil {
		t.Error("Expected error when decrypting invalid ciphertext")
	}
}

func TestGenerateRandomString(t *testing.T) {
	// Test length
	str, err := utils.GenerateRandomString(32)
	if err != nil {
		t.Fatalf("Failed to generate random string: %v", err)
	}

	if len(str) != 32 {
		t.Errorf("Expected length 32, got %d", len(str))
	}

	// Test uniqueness
	str2, err := utils.GenerateRandomString(32)
	if err != nil {
		t.Fatalf("Failed to generate second random string: %v", err)
	}

	if str == str2 {
		t.Error("Expected unique random strings")
	}

	// Test character set
	for _, c := range str {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", c) {
			t.Errorf("Unexpected character in random string: %c", c)
		}
	}
}

func TestGenerateTokenPair(t *testing.T) {
	accessToken, refreshToken, err := utils.GenerateTokenPair()
	if err != nil {
		t.Fatalf("Failed to generate token pair: %v", err)
	}

	// Test lengths
	if len(accessToken) != 32 {
		t.Errorf("Expected access token length 32, got %d", len(accessToken))
	}

	if len(refreshToken) != 48 {
		t.Errorf("Expected refresh token length 48, got %d", len(refreshToken))
	}

	// Test uniqueness
	accessToken2, refreshToken2, err := utils.GenerateTokenPair()
	if err != nil {
		t.Fatalf("Failed to generate second token pair: %v", err)
	}

	if accessToken == accessToken2 {
		t.Error("Expected unique access tokens")
	}

	if refreshToken == refreshToken2 {
		t.Error("Expected unique refresh tokens")
	}

	// Access and refresh tokens should be different
	if accessToken == refreshToken {
		t.Error("Expected access token and refresh token to be different")
	}
}

func TestTimeUtilities(t *testing.T) {
	// Test NowUnix
	before := utils.NowUnix()
	after := utils.NowUnix()

	if before > after {
		t.Error("Expected NowUnix to return increasing values")
	}

	// Test TimeFromUnix and UnixFromTime
	now := utils.Now()
	unix := utils.UnixFromTime(now)
	back := utils.TimeFromUnix(unix)

	// Should be within 1 second
	if now.Sub(back).Abs() > 1000000000 {
		t.Error("Expected TimeFromUnix(UnixFromTime(now)) to be close to now")
	}
}
