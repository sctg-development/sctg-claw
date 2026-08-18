package db

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/models"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/utils"
)

// CreateAuditEvent creates a new audit event record
func (d *DB) CreateAuditEvent(eventCode, deviceID, sessionID, email, outcome, details string) error {
	id, err := utils.GenerateRandomString(16)
	if err != nil {
		return fmt.Errorf("failed to generate audit event ID: %w", err)
	}

	now := time.Now().Unix()
	_, err = d.db.Exec(`
		INSERT INTO audit_events (id, event_code, device_id, session_id, email, timestamp, outcome, details)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, id, eventCode, deviceID, sessionID, email, now, outcome, details)

	return err
}

// GetAuditEvents retrieves audit events with optional filters
func (d *DB) GetAuditEvents(limit int, eventCode, deviceID, email string) ([]*models.AuditEvent, error) {
	query := `
		SELECT id, event_code, device_id, session_id, email, timestamp, outcome, details
		FROM audit_events
	`
	args := []interface{}{}
	conditions := []string{}

	if eventCode != "" {
		conditions = append(conditions, "event_code = ?")
		args = append(args, eventCode)
	}

	if deviceID != "" {
		conditions = append(conditions, "device_id = ?")
		args = append(args, deviceID)
	}

	if email != "" {
		conditions = append(conditions, "email = ?")
		args = append(args, email)
	}

	if len(conditions) > 0 {
		query += " WHERE " + joinConditions(conditions)
	}

	query += " ORDER BY timestamp DESC LIMIT ?"
	args = append(args, limit)

	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query audit events: %w", err)
	}
	defer rows.Close()

	var events []*models.AuditEvent
	for rows.Next() {
		var event models.AuditEvent
		var timestamp sql.NullInt64

		if err := rows.Scan(
			&event.ID, &event.EventCode, &event.DeviceID, &event.SessionID,
			&event.Email, &timestamp, &event.Outcome, &event.Details,
		); err != nil {
			return nil, fmt.Errorf("failed to scan audit event: %w", err)
		}

		if timestamp.Valid {
			event.Timestamp = time.Unix(timestamp.Int64, 0)
		}

		events = append(events, &event)
	}

	return events, nil
}

func joinConditions(conditions []string) string {
	switch len(conditions) {
	case 0:
		return ""
	case 1:
		return conditions[0]
	default:
		result := conditions[0]
		for _, cond := range conditions[1:] {
			result += " AND " + cond
		}
		return result
	}
}
