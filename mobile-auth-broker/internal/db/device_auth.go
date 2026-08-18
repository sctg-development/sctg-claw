package db

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/models"
)

// CreateDeviceAuthorization creates a new device authorization record
func (d *DB) CreateDeviceAuthorization(transactionID, githubDeviceCodeEncrypted, userCode, verificationURI string, githubPollInterval, githubExpiresAt, pollAfterSeconds int) error {
	now := time.Now().Unix()

	_, err := d.db.Exec(`
		INSERT INTO device_authorizations (
			id, github_device_code_encrypted, github_poll_interval,
			created_at, status, approved_email, consumed_at, poll_after_seconds,
			user_code, verification_uri, expires_at
		) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
	`, transactionID, githubDeviceCodeEncrypted, githubPollInterval,
		now, "pending", pollAfterSeconds, userCode, verificationURI, githubExpiresAt)

	return err
}

// GetDeviceAuthorization retrieves a device authorization by ID
func (d *DB) GetDeviceAuthorization(transactionID string) (*models.DeviceAuthorization, error) {
	var auth models.DeviceAuthorization
	var consumedAt, expiresAt, createdAt sql.NullInt64
	var approvedEmail sql.NullString
	
	err := d.db.QueryRow(`
		SELECT id, github_device_code_encrypted, github_poll_interval,
			created_at, status, approved_email, consumed_at, poll_after_seconds,
			user_code, verification_uri, expires_at
		FROM device_authorizations WHERE id = ?
	`, transactionID).Scan(
		&auth.ID, &auth.GitHubDeviceCode, &auth.GitHubPollInterval,
		&createdAt, &auth.Status, &approvedEmail, &consumedAt, &auth.PollAfterSeconds,
		&auth.UserCode, &auth.VerificationURI, &expiresAt,
	)
	
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get device authorization: %w", err)
	}

	auth.CreatedAt = time.Unix(createdAt.Int64, 0)
	auth.GitHubExpiresAt = time.Unix(expiresAt.Int64, 0)
	auth.ExpiresAt = time.Unix(expiresAt.Int64, 0)
	
	if approvedEmail.Valid {
		auth.ApprovedEmail = approvedEmail.String
	}
	
	if consumedAt.Valid {
		t := time.Unix(consumedAt.Int64, 0)
		auth.ConsumedAt = &t
	}
	
	return &auth, nil
}

// UpdateDeviceAuthorizationStatus updates the status of a device authorization
func (d *DB) UpdateDeviceAuthorizationStatus(transactionID, status, approvedEmail string) error {
	now := time.Now().Unix()

	if status == "approved" {
		_, err := d.db.Exec(`
			UPDATE device_authorizations 
			SET status = ?, approved_email = ?, consumed_at = ? 
			WHERE id = ?
		`, status, approvedEmail, now, transactionID)
		return err
	}

	_, err := d.db.Exec(`
		UPDATE device_authorizations 
		SET status = ? 
		WHERE id = ?
	`, status, transactionID)
	return err
}

// UpdateDeviceAuthorizationPollInterval updates the poll interval for slow_down
func (d *DB) UpdateDeviceAuthorizationPollInterval(transactionID string, newInterval int) error {
	_, err := d.db.Exec(`
		UPDATE device_authorizations 
		SET poll_after_seconds = ?, status = 'slow_down' 
		WHERE id = ?
	`, newInterval, transactionID)
	return err
}

// MarkDeviceAuthorizationConsumed marks a device authorization as consumed
func (d *DB) MarkDeviceAuthorizationConsumed(transactionID string) error {
	now := time.Now().Unix()
	_, err := d.db.Exec(`
		UPDATE device_authorizations 
		SET consumed_at = ? 
		WHERE id = ?
	`, now, transactionID)
	return err
}

// ListPendingDeviceAuthorizations lists all pending device authorizations
func (d *DB) ListPendingDeviceAuthorizations() ([]*models.DeviceAuthorization, error) {
	rows, err := d.db.Query(`
		SELECT id, github_device_code_encrypted, github_poll_interval,
			created_at, status, approved_email, consumed_at, poll_after_seconds,
			user_code, verification_uri, expires_at
		FROM device_authorizations 
		WHERE status IN ('pending', 'slow_down') AND expires_at > ?
	`, time.Now().Unix())

	if err != nil {
		return nil, fmt.Errorf("failed to list pending device authorizations: %w", err)
	}
	defer rows.Close()

	var authorizations []*models.DeviceAuthorization
	for rows.Next() {
		var auth models.DeviceAuthorization
		var consumedAt, expiresAt, createdAt sql.NullInt64
		var approvedEmail sql.NullString

		if err := rows.Scan(
			&auth.ID, &auth.GitHubDeviceCode, &auth.GitHubPollInterval,
			&createdAt, &auth.Status, &approvedEmail, &consumedAt, &auth.PollAfterSeconds,
			&auth.UserCode, &auth.VerificationURI, &expiresAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan device authorization: %w", err)
		}

		auth.CreatedAt = time.Unix(createdAt.Int64, 0)
		auth.GitHubExpiresAt = time.Unix(expiresAt.Int64, 0)
		auth.ExpiresAt = time.Unix(expiresAt.Int64, 0)

		if approvedEmail.Valid {
			auth.ApprovedEmail = approvedEmail.String
		}

		if consumedAt.Valid {
			t := time.Unix(consumedAt.Int64, 0)
			auth.ConsumedAt = &t
		}

		authorizations = append(authorizations, &auth)
	}

	return authorizations, nil
}
