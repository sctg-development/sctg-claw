package proxy

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/db"
)

type WebSocketProxy struct {
	config   *config.Config
	db       *db.DB
	upgrader *websocket.Upgrader
}

func NewWebSocketProxy(cfg *config.Config, database *db.DB) *WebSocketProxy {
	return &WebSocketProxy{
		config: cfg,
		db:     database,
		upgrader: &websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				// Allow all origins for now (Cloudflare will handle CORS)
				return true
			},
		},
	}
}

func (p *WebSocketProxy) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Extract and validate bearer token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, "Unauthorized: Missing Authorization header", http.StatusUnauthorized)
		return
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		http.Error(w, "Unauthorized: Invalid Authorization header", http.StatusUnauthorized)
		return
	}

	accessToken := parts[1]
	tokenHash := p.config.HashSecret(accessToken)

	// Validate the access token
	accessSession, err := p.db.GetAccessSession(tokenHash)
	if err != nil {
		log.Printf("ERROR: Failed to get access session: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	if accessSession == nil {
		http.Error(w, "Unauthorized: Invalid access token", http.StatusUnauthorized)
		return
	}

	// Check if token is revoked
	if accessSession.RevokedAt != nil {
		http.Error(w, "Unauthorized: Token revoked", http.StatusUnauthorized)
		return
	}

	// Check if token is expired
	if time.Now().After(accessSession.ExpiresAt) {
		http.Error(w, "Unauthorized: Token expired", http.StatusUnauthorized)
		return
	}

	// Get the device to get the email
	device, err := p.db.GetMobileDevice(accessSession.DeviceID)
	if err != nil {
		log.Printf("ERROR: Failed to get mobile device: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	if device == nil || device.RevokedAt != nil {
		http.Error(w, "Unauthorized: Device not found or revoked", http.StatusUnauthorized)
		return
	}

	// Check if device email is still in allow list
	if !p.config.IsEmailAllowed(device.Email) {
		// Revoke all sessions for this device
		p.db.RevokeAllSessionsForDevice(device.ID)

		p.db.CreateAuditEvent(
			"proxy_denied",
			device.ID,
			accessSession.ID,
			device.Email,
			"email_not_allowed",
			"Email no longer in allow list",
		)

		http.Error(w, "Unauthorized: Email not authorized", http.StatusUnauthorized)
		return
	}

	// Update last seen for device
	p.db.UpdateMobileDeviceLastSeen(device.ID)

	// Create audit event for connection
	p.db.CreateAuditEvent(
		"websocket_connection",
		device.ID,
		accessSession.ID,
		device.Email,
		"started",
		"WebSocket connection initiated",
	)

	// Upgrade to WebSocket
	conn, err := p.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ERROR: WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	// Connect to Gateway WebSocket
	gatewayURL := p.config.GatewayServiceURL
	if strings.HasPrefix(gatewayURL, "http://") {
		gatewayURL = "ws://" + strings.TrimPrefix(gatewayURL, "http://")
	} else if strings.HasPrefix(gatewayURL, "https://") {
		gatewayURL = "wss://" + strings.TrimPrefix(gatewayURL, "https://")
	}

	// Build headers for Gateway
	gatewayHeaders := http.Header{
		"X-Forwarded-Email": []string{device.Email},
		"Host":              []string{p.config.Hostname},
	}

	// Connect to Gateway
	gatewayConn, resp, err := websocket.DefaultDialer.Dial(gatewayURL, gatewayHeaders)
	if err != nil {
		log.Printf("ERROR: Failed to connect to Gateway: %v", err)
		if resp != nil {
			log.Printf("ERROR: Gateway response status: %d", resp.StatusCode)
		}
		return
	}
	defer gatewayConn.Close()

	// Set message size limit
	gatewayConn.SetReadLimit(p.config.MaxMessageSize)
	conn.SetReadLimit(p.config.MaxMessageSize)

	// Set ping/pong handlers
	gatewayConn.SetPingHandler(func(appData string) error {
		return gatewayConn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
	})
	gatewayConn.SetPongHandler(func(appData string) error {
		return nil
	})

	conn.SetPingHandler(func(appData string) error {
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(time.Second))
	})
	conn.SetPongHandler(func(appData string) error {
		return nil
	})

	// Start bidirectional proxy
	done := make(chan struct{})

	go func() {
		defer close(done)
		for {
			messageType, message, err := conn.ReadMessage()
			if err != nil {
				log.Printf("DEBUG: Client read error: %v", err)
				return
			}

			if err := gatewayConn.WriteMessage(messageType, message); err != nil {
				log.Printf("DEBUG: Gateway write error: %v", err)
				return
			}
		}
	}()

	go func() {
		defer close(done)
		for {
			messageType, message, err := gatewayConn.ReadMessage()
			if err != nil {
				log.Printf("DEBUG: Gateway read error: %v", err)
				return
			}

			if err := conn.WriteMessage(messageType, message); err != nil {
				log.Printf("DEBUG: Client write error: %v", err)
				return
			}
		}
	}()

	// Wait for one of the goroutines to finish
	<-done

	// Create audit event for disconnection
	p.db.CreateAuditEvent(
		"websocket_disconnection",
		device.ID,
		accessSession.ID,
		device.Email,
		"completed",
		"WebSocket connection closed",
	)
}
