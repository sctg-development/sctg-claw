package models

import (
	"time"
)

// DeviceAuthorization represents a GitHub Device Flow transaction
type DeviceAuthorization struct {
	ID                     string
	GitHubDeviceCode       string // Encrypted server-side only
	GitHubPollInterval     int
	GitHubExpiresAt        time.Time
	CreatedAt             time.Time
	Status                string // pending, slow_down, denied, expired, approved, forbidden
	ApprovedEmail         string
	ConsumedAt            *time.Time
	PollAfterSeconds      int
	UserCode              string
	VerificationURI        string
	ExpiresAt             time.Time
}

// MobileDevice represents a registered mobile device
type MobileDevice struct {
	ID        string
	Email     string
	CreatedAt time.Time
	LastSeenAt time.Time
	RevokedAt *time.Time
	Metadata string
}

// RefreshSession represents a refresh token session
type RefreshSession struct {
	ID            string
	DeviceID      string
	TokenHash     string
	ParentHash   string
	IssuedAt     time.Time
	ExpiresAt    time.Time
	RevokedAt    *time.Time
	RotatedAt    *time.Time
}

// AccessSession represents an access token session
type AccessSession struct {
	ID        string
	DeviceID  string
	TokenHash string
	IssuedAt  time.Time
	ExpiresAt time.Time
	RevokedAt *time.Time
}

// AuditEvent represents an audit log entry
type AuditEvent struct {
	ID        string
	EventCode string
	DeviceID  string
	SessionID string
	Email     string
	Timestamp time.Time
	Outcome   string
	Details   string
}

// TokenPair represents access and refresh tokens returned to client
type TokenPair struct {
	AccessToken     string    `json:"access_token"`
	AccessExpiresAt time.Time `json:"access_expires_at"`
	RefreshToken    string    `json:"refresh_token"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
	SubjectEmail    string    `json:"subject_email"`
}

// DeviceAuthResponse is the initial response for device authorization
type DeviceAuthResponse struct {
	TransactionID   string `json:"transaction_id"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresAt       string `json:"expires_at"`
	PollAfterSeconds int    `json:"poll_after_seconds"`
}

// DeviceAuthStatus represents the status of a device authorization
type DeviceAuthStatus struct {
	Status          string    `json:"status"`
	AccessToken     string    `json:"access_token,omitempty"`
	AccessExpiresAt string    `json:"access_expires_at,omitempty"`
	RefreshToken    string    `json:"refresh_token,omitempty"`
	RefreshExpiresAt string    `json:"refresh_expires_at,omitempty"`
	SubjectEmail    string    `json:"subject_email,omitempty"`
	Error           string    `json:"error,omitempty"`
	ErrorMessage    string    `json:"error_message,omitempty"`
}

// RefreshRequest represents a refresh token request
type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

// RefreshResponse represents a refresh token response
type RefreshResponse struct {
	AccessToken     string `json:"access_token"`
	AccessExpiresAt string `json:"access_expires_at"`
	RefreshToken    string `json:"refresh_token"`
	RefreshExpiresAt string `json:"refresh_expires_at"`
}

// GitHubDeviceAuth represents GitHub's device authorization response
type GitHubDeviceAuth struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
	GrantType       string `json:"grant_type"`
}

// GitHubToken represents GitHub's token response
type GitHubToken struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Scope       string `json:"scope"`
}

// GitHubEmail represents a GitHub user email
type GitHubEmail struct {
	Email   string `json:"email"`
	Primary bool   `json:"primary"`
	Verified bool   `json:"verified"`
	Visibility string `json:"visibility"`
}
