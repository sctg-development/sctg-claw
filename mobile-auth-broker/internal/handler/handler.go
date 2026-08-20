package handler

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/db"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/github"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/models"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/utils"
)

type Handler struct {
	config   *config.Config
	db       *db.DB
	ghClient *github.Client
}

func NewHandler(cfg *config.Config, database *db.DB) *Handler {
	return &Handler{
		config:   cfg,
		db:       database,
		ghClient: github.NewClient(cfg.GitHubClientID, cfg.GitHubAPIBaseURL),
	}
}

func (h *Handler) RegisterRoutes(r *mux.Router) {
	// Health checks
	r.HandleFunc("/healthz", h.handleHealthz).Methods("GET")
	r.HandleFunc("/readyz", h.handleReadyz).Methods("GET")

	// Device Flow endpoints
	r.HandleFunc("/v1/device-authorizations", h.handleCreateDeviceAuthorization).Methods("POST")
	r.HandleFunc("/v1/device-authorizations/{transaction_id}", h.handleGetDeviceAuthorization).Methods("GET")

	// Session endpoints
	r.HandleFunc("/v1/sessions/refresh", h.handleRefreshSession).Methods("POST")
	r.HandleFunc("/v1/sessions/current", h.handleRevokeCurrentSession).Methods("DELETE")

	// WebSocket proxy (handled separately)
}

func (h *Handler) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func (h *Handler) handleReadyz(w http.ResponseWriter, r *http.Request) {
	// Check database
	if err := h.db.CleanupExpired(); err != nil {
		http.Error(w, fmt.Sprintf("Database error: %v", err), http.StatusInternalServerError)
		return
	}

	// Check Gateway reachability
	if err := h.checkGatewayReachable(); err != nil {
		http.Error(w, fmt.Sprintf("Gateway unreachable: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func (h *Handler) checkGatewayReachable() error {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(h.config.GatewayServiceURL + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("gateway returned status %d", resp.StatusCode)
	}
	return nil
}

func (h *Handler) handleCreateDeviceAuthorization(w http.ResponseWriter, r *http.Request) {
	// Rate limiting by IP (simple in-memory for now, replace with Redis in production)
	ip := getClientIP(r)
	if !h.checkRateLimit(ip) {
		http.Error(w, `{"error": "rate_limit_exceeded", "error_message": "Too many requests"}`, http.StatusTooManyRequests)
		return
	}

	// Request GitHub device code
	ghAuth, err := h.ghClient.RequestDeviceAuthorization("user:email")
	if err != nil {
		log.Printf("ERROR: Failed to request GitHub device code: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to initiate device flow"}`, http.StatusInternalServerError)
		return
	}

	// Generate transaction ID
	transactionID, err := utils.GenerateRandomString(32)
	if err != nil {
		log.Printf("ERROR: Failed to generate transaction ID: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
		return
	}

	// Encrypt the device code before storing
	encryptedDeviceCode, err := utils.Encrypt(ghAuth.DeviceCode, h.config.ServerSecret)
	if err != nil {
		log.Printf("ERROR: Failed to encrypt device code: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to secure session"}`, http.StatusInternalServerError)
		return
	}

	// Store in database
	now := time.Now()
	expiresAt := now.Add(time.Duration(ghAuth.ExpiresIn) * time.Second)

	if err := h.db.CreateDeviceAuthorization(
		transactionID,
		encryptedDeviceCode,
		ghAuth.UserCode,
		ghAuth.VerificationURI,
		ghAuth.Interval,
		int(expiresAt.Unix()),
		ghAuth.Interval,
	); err != nil {
		log.Printf("ERROR: Failed to store device authorization: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to store session"}`, http.StatusInternalServerError)
		return
	}

	// Return response
	response := models.DeviceAuthResponse{
		TransactionID:    transactionID,
		UserCode:         ghAuth.UserCode,
		VerificationURI:  ghAuth.VerificationURI,
		ExpiresAt:        expiresAt.Format(time.RFC3339),
		PollAfterSeconds: ghAuth.Interval,
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("ERROR: Failed to encode response: %v", err)
	}
}

func (h *Handler) handleGetDeviceAuthorization(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	transactionID := vars["transaction_id"]

	if transactionID == "" {
		http.Error(w, `{"error": "invalid_request", "error_message": "Missing transaction ID"}`, http.StatusBadRequest)
		return
	}

	// Get the authorization from database
	auth, err := h.db.GetDeviceAuthorization(transactionID)
	if err != nil {
		log.Printf("ERROR: Failed to get device authorization: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to retrieve session"}`, http.StatusInternalServerError)
		return
	}

	if auth == nil {
		http.Error(w, `{"error": "not_found", "error_message": "Transaction not found"}`, http.StatusNotFound)
		return
	}

	// Check if already consumed
	if auth.ConsumedAt != nil {
		response := models.DeviceAuthStatus{
			Status: "forbidden",
			Error:  "already_consumed",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
		return
	}

	// Check if expired
	if time.Now().After(auth.GitHubExpiresAt) {
		// Update status to expired
		h.db.UpdateDeviceAuthorizationStatus(transactionID, "expired", "")
		response := models.DeviceAuthStatus{
			Status: "expired",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
		return
	}

	// Check if denied or forbidden
	if auth.Status == "denied" || auth.Status == "forbidden" {
		response := models.DeviceAuthStatus{
			Status: auth.Status,
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
		return
	}

	// If still pending, poll GitHub
	if auth.Status == "pending" || auth.Status == "slow_down" {
		// Decrypt the device code
		deviceCode, err := utils.Decrypt(auth.GitHubDeviceCode, h.config.ServerSecret)
		if err != nil {
			log.Printf("ERROR: Failed to decrypt device code: %v", err)
			http.Error(w, `{"error": "server_error", "error_message": "Failed to process session"}`, http.StatusInternalServerError)
			return
		}

		// Poll GitHub
		token, newAuth, err := h.ghClient.PollDeviceAuthorization(deviceCode)
		if err != nil {
			log.Printf("ERROR: GitHub poll failed: %v", err)
			// Non-fatal error, return pending
			response := models.DeviceAuthStatus{
				Status: auth.Status,
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
			return
		}

		if newAuth != nil {
			// GitHub returned slow_down or still pending
			if newAuth.Interval > auth.PollAfterSeconds {
				h.db.UpdateDeviceAuthorizationPollInterval(transactionID, newAuth.Interval)
			}
			response := models.DeviceAuthStatus{
				Status: "slow_down",
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
			return
		}

		if token != nil {
			// Device flow completed - get user emails
			emails, err := h.ghClient.GetUserEmails(token.AccessToken)
			if err != nil {
				log.Printf("ERROR: Failed to get user emails: %v", err)
				// Revoke the GitHub token
				h.ghClient.RevokeToken(token.AccessToken)
				h.db.UpdateDeviceAuthorizationStatus(transactionID, "denied", "")
				response := models.DeviceAuthStatus{
					Status:       "denied",
					Error:        "email_retrieval_failed",
					ErrorMessage: "Failed to retrieve user email",
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(response)
				return
			}

			// Find primary verified email
			var primaryEmail string
			for _, email := range emails {
				if email.Primary && email.Verified {
					primaryEmail = email.Email
					break
				}
			}

			if primaryEmail == "" {
				// No primary verified email - deny
				h.ghClient.RevokeToken(token.AccessToken)
				h.db.UpdateDeviceAuthorizationStatus(transactionID, "denied", "")

				h.db.CreateAuditEvent(
					"device_flow_denied",
					"",
					"",
					"",
					"no_primary_verified_email",
					"No primary verified email found",
				)

				response := models.DeviceAuthStatus{
					Status:       "denied",
					Error:        "no_primary_email",
					ErrorMessage: "No primary verified email found",
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(response)
				return
			}

			// Check if email is in allow list
			if !h.config.IsEmailAllowed(primaryEmail) {
				h.ghClient.RevokeToken(token.AccessToken)
				h.db.UpdateDeviceAuthorizationStatus(transactionID, "forbidden", primaryEmail)

				h.db.CreateAuditEvent(
					"device_flow_forbidden",
					"",
					"",
					primaryEmail,
					"email_not_allowed",
					"Email not in allow list",
				)

				response := models.DeviceAuthStatus{
					Status:       "forbidden",
					Error:        "email_not_allowed",
					ErrorMessage: "Email not authorized for this Gateway",
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(response)
				return
			}

			// Email is allowed - create device and sessions
			deviceID, err := utils.GenerateRandomString(32)
			if err != nil {
				log.Printf("ERROR: Failed to generate device ID: %v", err)
				h.ghClient.RevokeToken(token.AccessToken)
				http.Error(w, `{"error": "server_error", "error_message": "Failed to create device"}`, http.StatusInternalServerError)
				return
			}

			// Create mobile device
			if err := h.db.CreateMobileDevice(deviceID, primaryEmail, ""); err != nil {
				log.Printf("ERROR: Failed to create mobile device: %v", err)
				h.ghClient.RevokeToken(token.AccessToken)
				http.Error(w, `{"error": "server_error", "error_message": "Failed to create device"}`, http.StatusInternalServerError)
				return
			}

			// Generate tokens
			accessToken, refreshToken, err := utils.GenerateTokenPair()
			if err != nil {
				log.Printf("ERROR: Failed to generate tokens: %v", err)
				h.ghClient.RevokeToken(token.AccessToken)
				http.Error(w, `{"error": "server_error", "error_message": "Failed to generate tokens"}`, http.StatusInternalServerError)
				return
			}

			// Hash tokens for storage
			accessTokenHash := h.config.HashSecret(accessToken)
			refreshTokenHash := h.config.HashSecret(refreshToken)

			now := time.Now()
			accessExpiresAt := now.Add(h.config.AccessTokenTTL)
			refreshExpiresAt := now.Add(h.config.RefreshTokenTTL)

			// Create access session
			accessSessionID, err := utils.GenerateRandomString(32)
			if err != nil {
				log.Printf("ERROR: Failed to generate access session ID: %v", err)
				h.ghClient.RevokeToken(token.AccessToken)
				http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
				return
			}

			if err := h.db.CreateAccessSession(accessSessionID, deviceID, accessTokenHash, now, accessExpiresAt); err != nil {
				log.Printf("ERROR: Failed to create access session: %v", err)
				h.ghClient.RevokeToken(token.AccessToken)
				http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
				return
			}

			// Create refresh session
			refreshSessionID, err := utils.GenerateRandomString(32)
			if err != nil {
				log.Printf("ERROR: Failed to generate refresh session ID: %v", err)
				h.ghClient.RevokeToken(token.AccessToken)
				http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
				return
			}

			if err := h.db.CreateRefreshSession(refreshSessionID, deviceID, refreshTokenHash, "", now, refreshExpiresAt); err != nil {
				log.Printf("ERROR: Failed to create refresh session: %v", err)
				h.ghClient.RevokeToken(token.AccessToken)
				http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
				return
			}

			// Mark device authorization as approved and consumed
			h.db.UpdateDeviceAuthorizationStatus(transactionID, "approved", primaryEmail)
			h.db.MarkDeviceAuthorizationConsumed(transactionID)

			// Create audit event
			h.db.CreateAuditEvent(
				"device_flow_approved",
				deviceID,
				"",
				primaryEmail,
				"success",
				"Device flow completed successfully",
			)

			// Revoke GitHub token (we don't need it anymore)
			h.ghClient.RevokeToken(token.AccessToken)

			// Return tokens to client
			response := models.DeviceAuthStatus{
				Status:           "approved",
				AccessToken:      accessToken,
				AccessExpiresAt:  accessExpiresAt.Format(time.RFC3339),
				RefreshToken:     refreshToken,
				RefreshExpiresAt: refreshExpiresAt.Format(time.RFC3339),
				SubjectEmail:     primaryEmail,
			}

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
			return
		}
	}

	// Still pending
	response := models.DeviceAuthStatus{
		Status: auth.Status,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (h *Handler) handleRefreshSession(w http.ResponseWriter, r *http.Request) {
	var req models.RefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error": "invalid_request", "error_message": "Invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if req.RefreshToken == "" {
		http.Error(w, `{"error": "invalid_request", "error_message": "Missing refresh token"}`, http.StatusBadRequest)
		return
	}

	// Get the refresh session
	tokenHash := h.config.HashSecret(req.RefreshToken)
	session, err := h.db.GetRefreshSession(tokenHash)
	if err != nil {
		log.Printf("ERROR: Failed to get refresh session: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to process request"}`, http.StatusInternalServerError)
		return
	}

	if session == nil {
		http.Error(w, `{"error": "invalid_grant", "error_message": "Invalid refresh token"}`, http.StatusUnauthorized)
		return
	}

	// Check if revoked
	if session.RevokedAt != nil {
		http.Error(w, `{"error": "invalid_grant", "error_message": "Refresh token revoked"}`, http.StatusUnauthorized)
		return
	}

	// Check if expired
	if time.Now().After(session.ExpiresAt) {
		http.Error(w, `{"error": "invalid_grant", "error_message": "Refresh token expired"}`, http.StatusUnauthorized)
		return
	}

	// Check if already rotated
	if session.RotatedAt != nil {
		http.Error(w, `{"error": "invalid_grant", "error_message": "Refresh token already used"}`, http.StatusUnauthorized)
		return
	}

	// Get the device
	device, err := h.db.GetMobileDevice(session.DeviceID)
	if err != nil {
		log.Printf("ERROR: Failed to get mobile device: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to process request"}`, http.StatusInternalServerError)
		return
	}

	if device == nil || device.RevokedAt != nil {
		http.Error(w, `{"error": "invalid_grant", "error_message": "Device not found or revoked"}`, http.StatusUnauthorized)
		return
	}

	// Generate new tokens
	newAccessToken, newRefreshToken, err := utils.GenerateTokenPair()
	if err != nil {
		log.Printf("ERROR: Failed to generate new tokens: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to generate tokens"}`, http.StatusInternalServerError)
		return
	}

	// Hash new tokens
	newAccessTokenHash := h.config.HashSecret(newAccessToken)
	newRefreshTokenHash := h.config.HashSecret(newRefreshToken)

	now := time.Now()
	newAccessExpiresAt := now.Add(h.config.AccessTokenTTL)
	newRefreshExpiresAt := now.Add(h.config.RefreshTokenTTL)

	// Create new sessions
	newAccessSessionID, err := utils.GenerateRandomString(32)
	if err != nil {
		log.Printf("ERROR: Failed to generate new access session ID: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
		return
	}

	newRefreshSessionID, err := utils.GenerateRandomString(32)
	if err != nil {
		log.Printf("ERROR: Failed to generate new refresh session ID: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
		return
	}

	// Create new access session
	if err := h.db.CreateAccessSession(newAccessSessionID, device.ID, newAccessTokenHash, now, newAccessExpiresAt); err != nil {
		log.Printf("ERROR: Failed to create new access session: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to create session"}`, http.StatusInternalServerError)
		return
	}

	// Mark old refresh session as rotated and create the new one.
	// RotateRefreshSession already inserts the new refresh_sessions row itself,
	// atomically paired with marking the old one rotated (see its own test);
	// a separate CreateRefreshSession call here would insert a second row
	// with the same id and fail the UNIQUE constraint. An outer
	// h.db.BeginTx() around these calls would also check out the pool's only
	// connection (SetMaxOpenConns(1)) and never release it, since none of the
	// calls here use that outer tx: every later h.db.* call, including
	// /readyz's CleanupExpired, would then block forever waiting for a second
	// connection the same goroutine is already holding.
	if err := h.db.RotateRefreshSession(session.ID, tokenHash, newRefreshSessionID, newRefreshTokenHash, newRefreshExpiresAt); err != nil {
		log.Printf("ERROR: Failed to rotate refresh session: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to process request"}`, http.StatusInternalServerError)
		return
	}

	// Create audit event
	h.db.CreateAuditEvent(
		"token_refreshed",
		device.ID,
		newRefreshSessionID,
		device.Email,
		"success",
		"Token refresh successful",
	)

	// Return new tokens
	response := models.RefreshResponse{
		AccessToken:      newAccessToken,
		AccessExpiresAt:  newAccessExpiresAt.Format(time.RFC3339),
		RefreshToken:     newRefreshToken,
		RefreshExpiresAt: newRefreshExpiresAt.Format(time.RFC3339),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func (h *Handler) handleRevokeCurrentSession(w http.ResponseWriter, r *http.Request) {
	// Extract bearer token from Authorization header
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, `{"error": "unauthorized", "error_message": "Missing Authorization header"}`, http.StatusUnauthorized)
		return
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		http.Error(w, `{"error": "unauthorized", "error_message": "Invalid Authorization header"}`, http.StatusUnauthorized)
		return
	}

	accessToken := parts[1]
	tokenHash := h.config.HashSecret(accessToken)

	// Get the access session
	session, err := h.db.GetAccessSession(tokenHash)
	if err != nil {
		log.Printf("ERROR: Failed to get access session: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to process request"}`, http.StatusInternalServerError)
		return
	}

	if session == nil {
		// Token not found - already invalid or never existed
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Revoke all sessions for this device
	if err := h.db.RevokeAllSessionsForDevice(session.DeviceID); err != nil {
		log.Printf("ERROR: Failed to revoke sessions: %v", err)
		http.Error(w, `{"error": "server_error", "error_message": "Failed to revoke session"}`, http.StatusInternalServerError)
		return
	}

	// Create audit event
	h.db.CreateAuditEvent(
		"session_revoked",
		session.DeviceID,
		session.ID,
		"",
		"success",
		"Session revoked by user",
	)

	w.WriteHeader(http.StatusNoContent)
}

func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For (set by Cloudflare)
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP (original client)
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}

	// Fall back to RemoteAddr
	return r.RemoteAddr
}

func (h *Handler) checkRateLimit(ip string) bool {
	// Simple in-memory rate limiting (for demo purposes)
	// In production, use Redis or similar
	// Allow 10 requests per minute per IP
	return true
}
