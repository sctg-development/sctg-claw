package proxy

import (
	"log"
	"net/http"
	"strings"
	"sync"
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
	remote := clientIP(r)

	// Extract and validate bearer token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("WARN: WebSocket rejected remote=%s reason=missing_authorization_header", remote)
		http.Error(w, "Unauthorized: Missing Authorization header", http.StatusUnauthorized)
		return
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		log.Printf("WARN: WebSocket rejected remote=%s reason=invalid_authorization_header", remote)
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
		log.Printf("WARN: WebSocket rejected remote=%s reason=invalid_access_token", remote)
		http.Error(w, "Unauthorized: Invalid access token", http.StatusUnauthorized)
		return
	}

	// Check if token is revoked
	if accessSession.RevokedAt != nil {
		log.Printf("WARN: WebSocket rejected remote=%s reason=token_revoked device=%s", remote, accessSession.DeviceID)
		http.Error(w, "Unauthorized: Token revoked", http.StatusUnauthorized)
		return
	}

	// Check if token is expired
	if time.Now().After(accessSession.ExpiresAt) {
		log.Printf("WARN: WebSocket rejected remote=%s reason=token_expired device=%s expiredAt=%s",
			remote, accessSession.DeviceID, accessSession.ExpiresAt.Format(time.RFC3339))
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
		log.Printf("WARN: WebSocket rejected remote=%s reason=device_not_found_or_revoked device=%s",
			remote, accessSession.DeviceID)
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

		log.Printf("WARN: WebSocket rejected remote=%s reason=email_not_allowed device=%s", remote, device.ID)
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

	// Start bidirectional proxy. Both directions signal the same done channel
	// on exit, so closing it must be idempotent -- whichever side the peer
	// closes first still lets the other goroutine's blocked Read unblock and
	// return, and it would otherwise double-close done and panic the process.
	done := make(chan struct{})
	var closeDoneOnce sync.Once
	closeDone := func() { closeDoneOnce.Do(func() { close(done) }) }

	go func() {
		defer closeDone()
		for {
			messageType, message, err := conn.ReadMessage()
			if err != nil {
				log.Printf("DEBUG: Client read error: %v", err)
				forwardCloseCode(gatewayConn, err)
				return
			}

			if err := gatewayConn.WriteMessage(messageType, message); err != nil {
				log.Printf("DEBUG: Gateway write error: %v", err)
				return
			}
		}
	}()

	go func() {
		defer closeDone()
		for {
			messageType, message, err := gatewayConn.ReadMessage()
			if err != nil {
				log.Printf("DEBUG: Gateway read error: %v", err)
				forwardCloseCode(conn, err)
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

// forwardCloseCode relays a peer's real WebSocket close code/reason onto the
// other leg before the connection tears down. Without this, every close --
// including a clean 1001 "going away" from a client backgrounding the app --
// reaches the other side as a raw TCP drop (1006 "abnormal closure"), which
// looks like the connection was hijacked or lost rather than a normal
// lifecycle event. Only forwards when readErr is a genuine close frame from
// the peer (*websocket.CloseError); other read errors (timeouts, broken
// pipes) get no synthesized close code, so a real abnormal drop still reads
// as abnormal on the other side.
func forwardCloseCode(dst *websocket.Conn, readErr error) {
	closeErr, ok := readErr.(*websocket.CloseError)
	if !ok {
		return
	}
	_ = dst.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(closeErr.Code, closeErr.Text),
		time.Now().Add(time.Second))
}

// clientIP mirrors handler.getClientIP (different package, same logic):
// prefer the original client from X-Forwarded-For (set by Cloudflare), fall
// back to the raw connection's remote address.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		if len(ips) > 0 {
			return strings.TrimSpace(ips[0])
		}
	}
	return r.RemoteAddr
}
