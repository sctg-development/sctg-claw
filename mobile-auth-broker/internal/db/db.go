package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type DB struct {
	db     *sql.DB
	config *Config
}

type Config struct {
	Path string
}

func NewDB(cfg *Config) (*DB, error) {
	// Ensure directory exists
	dir := filepath.Dir(cfg.Path)
	if err := os.MkdirAll(dir, 0600); err != nil {
		return nil, fmt.Errorf("failed to create db directory: %w", err)
	}

	// Open database with strict permissions
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?mode=rwc&cache=private", cfg.Path))
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Set busy timeout and enable WAL mode
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		return nil, fmt.Errorf("failed to set busy timeout: %w", err)
	}
	
	if _, err := db.Exec("PRAGMA journal_mode = WAL"); err != nil {
		return nil, fmt.Errorf("failed to set WAL mode: %w", err)
	}

	// Run migrations
	if err := runMigrations(db); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return &DB{db: db, config: cfg}, nil
}

func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) BeginTx() (*sql.Tx, error) {
	return d.db.Begin()
}

func runMigrations(db *sql.DB) error {
	migrations := []string{
		`-- Device authorizations table
		CREATE TABLE IF NOT EXISTS device_authorizations (
			id TEXT PRIMARY KEY,
			github_device_code_encrypted TEXT NOT NULL,
			github_poll_interval INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			status TEXT NOT NULL,
			approved_email TEXT,
			consumed_at INTEGER,
			poll_after_seconds INTEGER NOT NULL,
			user_code TEXT NOT NULL,
			verification_uri TEXT NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`-- Mobile devices table
		CREATE TABLE IF NOT EXISTS mobile_devices (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			revoked_at INTEGER,
			metadata TEXT
		)`,
		`-- Refresh sessions table
		CREATE TABLE IF NOT EXISTS refresh_sessions (
			id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			token_hash TEXT NOT NULL,
			parent_token_hash TEXT,
			issued_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			revoked_at INTEGER,
			rotated_at INTEGER,
			FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE
		)`,
		`-- Access sessions table
		CREATE TABLE IF NOT EXISTS access_sessions (
			id TEXT PRIMARY KEY,
			device_id TEXT NOT NULL,
			token_hash TEXT NOT NULL,
			issued_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			revoked_at INTEGER,
			FOREIGN KEY (device_id) REFERENCES mobile_devices(id) ON DELETE CASCADE
		)`,
		`-- Audit events table
		CREATE TABLE IF NOT EXISTS audit_events (
			id TEXT PRIMARY KEY,
			event_code TEXT NOT NULL,
			device_id TEXT,
			session_id TEXT,
			email TEXT,
			timestamp INTEGER NOT NULL,
			outcome TEXT NOT NULL,
			details TEXT
		)`,
		`-- Indexes for performance
		CREATE INDEX IF NOT EXISTS idx_device_authorizations_status ON device_authorizations(status);
		CREATE INDEX IF NOT EXISTS idx_device_authorizations_expires ON device_authorizations(expires_at);
		CREATE INDEX IF NOT EXISTS idx_refresh_sessions_token_hash ON refresh_sessions(token_hash);
		CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires ON refresh_sessions(expires_at);
		CREATE INDEX IF NOT EXISTS idx_access_sessions_token_hash ON access_sessions(token_hash);
		CREATE INDEX IF NOT EXISTS idx_access_sessions_expires ON access_sessions(expires_at);
		CREATE INDEX IF NOT EXISTS idx_mobile_devices_email ON mobile_devices(email);
		CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
	`,
	}

	for _, migration := range migrations {
		if _, err := db.Exec(migration); err != nil {
			return fmt.Errorf("failed to execute migration: %w", err)
		}
	}

	return nil
}

func (d *DB) CleanupExpired() error {
	now := time.Now().Unix()
	
	// Cleanup expired device authorizations
	_, err := d.db.Exec(
		"DELETE FROM device_authorizations WHERE expires_at < ? AND status != 'approved'",
		now,
	)
	if err != nil {
		return fmt.Errorf("failed to cleanup device authorizations: %w", err)
	}

	// Cleanup expired refresh sessions
	_, err = d.db.Exec(
		"DELETE FROM refresh_sessions WHERE expires_at < ?",
		now,
	)
	if err != nil {
		return fmt.Errorf("failed to cleanup refresh sessions: %w", err)
	}

	// Cleanup expired access sessions
	_, err = d.db.Exec(
		"DELETE FROM access_sessions WHERE expires_at < ?",
		now,
	)
	if err != nil {
		return fmt.Errorf("failed to cleanup access sessions: %w", err)
	}

	return nil
}
