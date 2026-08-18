package db

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/models"
)

// CreateMobileDevice creates a new mobile device record
func (d *DB) CreateMobileDevice(deviceID, email, metadata string) error {
	now := time.Now().Unix()

	_, err := d.db.Exec(`
		INSERT INTO mobile_devices (id, email, created_at, last_seen_at, revoked_at, metadata)
		VALUES (?, ?, ?, ?, NULL, ?)
	`, deviceID, email, now, now, metadata)

	return err
}

// GetMobileDevice retrieves a mobile device by ID
func (d *DB) GetMobileDevice(deviceID string) (*models.MobileDevice, error) {
	var device models.MobileDevice
	var createdAt, lastSeenAt, revokedAt sql.NullInt64

	err := d.db.QueryRow(`
		SELECT id, email, created_at, last_seen_at, revoked_at, metadata
		FROM mobile_devices WHERE id = ?
	`, deviceID).Scan(
		&device.ID, &device.Email, &createdAt, &lastSeenAt, &revokedAt, &device.Metadata,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get mobile device: %w", err)
	}

	device.CreatedAt = time.Unix(createdAt.Int64, 0)
	device.LastSeenAt = time.Unix(lastSeenAt.Int64, 0)

	if revokedAt.Valid {
		t := time.Unix(revokedAt.Int64, 0)
		device.RevokedAt = &t
	}

	return &device, nil
}

// UpdateMobileDeviceLastSeen updates the last seen timestamp for a device
func (d *DB) UpdateMobileDeviceLastSeen(deviceID string) error {
	now := time.Now().Unix()
	_, err := d.db.Exec("UPDATE mobile_devices SET last_seen_at = ? WHERE id = ?", now, deviceID)
	return err
}

// RevokeMobileDevice revokes a mobile device and all its sessions
func (d *DB) RevokeMobileDevice(deviceID string) error {
	now := time.Now().Unix()

	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Revoke the device
	if _, err := tx.Exec("UPDATE mobile_devices SET revoked_at = ? WHERE id = ?", now, deviceID); err != nil {
		return fmt.Errorf("failed to revoke mobile device: %w", err)
	}

	// Revoke all refresh sessions
	if _, err := tx.Exec("UPDATE refresh_sessions SET revoked_at = ? WHERE device_id = ?", now, deviceID); err != nil {
		return fmt.Errorf("failed to revoke refresh sessions: %w", err)
	}

	// Revoke all access sessions
	if _, err := tx.Exec("UPDATE access_sessions SET revoked_at = ? WHERE device_id = ?", now, deviceID); err != nil {
		return fmt.Errorf("failed to revoke access sessions: %w", err)
	}

	return tx.Commit()
}

// CreateRefreshSession creates a new refresh session
func (d *DB) CreateRefreshSession(sessionID, deviceID, tokenHash, parentHash string, issuedAt, expiresAt time.Time) error {
	_, err := d.db.Exec(`
		INSERT INTO refresh_sessions (
			id, device_id, token_hash, parent_token_hash, issued_at, expires_at, revoked_at, rotated_at
		) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
	`, sessionID, deviceID, tokenHash, parentHash, issuedAt.Unix(), expiresAt.Unix())

	return err
}

// GetRefreshSession retrieves a refresh session by token hash
func (d *DB) GetRefreshSession(tokenHash string) (*models.RefreshSession, error) {
	var session models.RefreshSession
	var issuedAt, expiresAt, revokedAt, rotatedAt sql.NullInt64

	err := d.db.QueryRow(`
		SELECT id, device_id, token_hash, parent_token_hash, issued_at, expires_at, revoked_at, rotated_at
		FROM refresh_sessions WHERE token_hash = ?
	`, tokenHash).Scan(
		&session.ID, &session.DeviceID, &session.TokenHash, &session.ParentHash,
		&issuedAt, &expiresAt, &revokedAt, &rotatedAt,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get refresh session: %w", err)
	}

	session.IssuedAt = time.Unix(issuedAt.Int64, 0)
	session.ExpiresAt = time.Unix(expiresAt.Int64, 0)

	if revokedAt.Valid {
		t := time.Unix(revokedAt.Int64, 0)
		session.RevokedAt = &t
	}

	if rotatedAt.Valid {
		t := time.Unix(rotatedAt.Int64, 0)
		session.RotatedAt = &t
	}

	return &session, nil
}

// RotateRefreshSession marks an old refresh session as rotated and creates a new one
func (d *DB) RotateRefreshSession(oldSessionID string, oldTokenHash string, newSessionID string, newTokenHash string, newExpiresAt time.Time) error {
	now := time.Now().Unix()
	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Mark old session as rotated
	if _, err := tx.Exec("UPDATE refresh_sessions SET rotated_at = ? WHERE id = ?", now, oldSessionID); err != nil {
		return fmt.Errorf("failed to mark old session as rotated: %w", err)
	}

	// Create new session
	if _, err := tx.Exec(`
		INSERT INTO refresh_sessions (
			id, device_id, token_hash, parent_token_hash, issued_at, expires_at, revoked_at, rotated_at
		) VALUES (?, (SELECT device_id FROM refresh_sessions WHERE token_hash = ?), ?, ?, ?, ?, NULL, NULL)
	`, newSessionID, oldTokenHash, newTokenHash, oldTokenHash, now, newExpiresAt.Unix()); err != nil {
		return fmt.Errorf("failed to create new refresh session: %w", err)
	}

	return tx.Commit()
}

// RevokeRefreshSession revokes a specific refresh session
func (d *DB) RevokeRefreshSession(sessionID string) error {
	now := time.Now().Unix()
	_, err := d.db.Exec("UPDATE refresh_sessions SET revoked_at = ? WHERE id = ?", now, sessionID)
	return err
}

// CreateAccessSession creates a new access session
func (d *DB) CreateAccessSession(sessionID, deviceID, tokenHash string, issuedAt, expiresAt time.Time) error {
	_, err := d.db.Exec(`
		INSERT INTO access_sessions (id, device_id, token_hash, issued_at, expires_at, revoked_at)
		VALUES (?, ?, ?, ?, ?, NULL)
	`, sessionID, deviceID, tokenHash, issuedAt.Unix(), expiresAt.Unix())

	return err
}

// GetAccessSession retrieves an access session by token hash
func (d *DB) GetAccessSession(tokenHash string) (*models.AccessSession, error) {
	var session models.AccessSession
	var issuedAt, expiresAt, revokedAt sql.NullInt64

	err := d.db.QueryRow(`
		SELECT id, device_id, token_hash, issued_at, expires_at, revoked_at
		FROM access_sessions WHERE token_hash = ?
	`, tokenHash).Scan(
		&session.ID, &session.DeviceID, &session.TokenHash,
		&issuedAt, &expiresAt, &revokedAt,
	)

	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to get access session: %w", err)
	}

	session.IssuedAt = time.Unix(issuedAt.Int64, 0)
	session.ExpiresAt = time.Unix(expiresAt.Int64, 0)

	if revokedAt.Valid {
		t := time.Unix(revokedAt.Int64, 0)
		session.RevokedAt = &t
	}

	return &session, nil
}

// RevokeAccessSession revokes a specific access session
func (d *DB) RevokeAccessSession(sessionID string) error {
	now := time.Now().Unix()
	_, err := d.db.Exec("UPDATE access_sessions SET revoked_at = ? WHERE id = ?", now, sessionID)
	return err
}

// RevokeAllSessionsForDevice revokes all sessions for a device
func (d *DB) RevokeAllSessionsForDevice(deviceID string) error {
	now := time.Now().Unix()

	tx, err := d.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	// Revoke all refresh sessions
	if _, err := tx.Exec("UPDATE refresh_sessions SET revoked_at = ? WHERE device_id = ?", now, deviceID); err != nil {
		return fmt.Errorf("failed to revoke refresh sessions: %w", err)
	}

	// Revoke all access sessions
	if _, err := tx.Exec("UPDATE access_sessions SET revoked_at = ? WHERE device_id = ?", now, deviceID); err != nil {
		return fmt.Errorf("failed to revoke access sessions: %w", err)
	}

	return tx.Commit()
}

// GetDeviceSessions retrieves all active sessions for a device
func (d *DB) GetDeviceSessions(deviceID string) ([]*models.AccessSession, []*models.RefreshSession, error) {
	// Get access sessions
	accessRows, err := d.db.Query(`
		SELECT id, device_id, token_hash, issued_at, expires_at, revoked_at
		FROM access_sessions WHERE device_id = ? AND (revoked_at IS NULL OR revoked_at > ?)
	`, deviceID, time.Now().Unix())
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query access sessions: %w", err)
	}
	defer accessRows.Close()

	var accessSessions []*models.AccessSession
	for accessRows.Next() {
		var session models.AccessSession
		var issuedAt, expiresAt, revokedAt sql.NullInt64

		if err := accessRows.Scan(
			&session.ID, &session.DeviceID, &session.TokenHash,
			&issuedAt, &expiresAt, &revokedAt,
		); err != nil {
			return nil, nil, fmt.Errorf("failed to scan access session: %w", err)
		}

		session.IssuedAt = time.Unix(issuedAt.Int64, 0)
		session.ExpiresAt = time.Unix(expiresAt.Int64, 0)

		if revokedAt.Valid {
			t := time.Unix(revokedAt.Int64, 0)
			session.RevokedAt = &t
		}

		accessSessions = append(accessSessions, &session)
	}

	// Get refresh sessions
	refreshRows, err := d.db.Query(`
		SELECT id, device_id, token_hash, parent_token_hash, issued_at, expires_at, revoked_at, rotated_at
		FROM refresh_sessions WHERE device_id = ? AND (revoked_at IS NULL OR revoked_at > ?)
	`, deviceID, time.Now().Unix())
	if err != nil {
		return nil, nil, fmt.Errorf("failed to query refresh sessions: %w", err)
	}
	defer refreshRows.Close()

	var refreshSessions []*models.RefreshSession
	for refreshRows.Next() {
		var session models.RefreshSession
		var issuedAt, expiresAt, revokedAt, rotatedAt sql.NullInt64

		if err := refreshRows.Scan(
			&session.ID, &session.DeviceID, &session.TokenHash, &session.ParentHash,
			&issuedAt, &expiresAt, &revokedAt, &rotatedAt,
		); err != nil {
			return nil, nil, fmt.Errorf("failed to scan refresh session: %w", err)
		}

		session.IssuedAt = time.Unix(issuedAt.Int64, 0)
		session.ExpiresAt = time.Unix(expiresAt.Int64, 0)

		if revokedAt.Valid {
			t := time.Unix(revokedAt.Int64, 0)
			session.RevokedAt = &t
		}

		if rotatedAt.Valid {
			t := time.Unix(rotatedAt.Int64, 0)
			session.RotatedAt = &t
		}

		refreshSessions = append(refreshSessions, &session)
	}

	return accessSessions, refreshSessions, nil
}
