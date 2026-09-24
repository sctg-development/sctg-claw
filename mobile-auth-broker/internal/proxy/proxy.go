package proxy

import (
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/db"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/models"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/tailnet"
)

// tailnetDeviceID/tailnetSessionID mark the synthetic device/session
// returned for a tailnet-authenticated request. They never correspond to a
// database row -- audit_events has no foreign key on device_id/session_id,
// so writing these sentinel values is safe and keeps the audit trail able to
// distinguish this path from a real paired device.
const (
	tailnetDeviceID  = "tailnet"
	tailnetSessionID = "tailnet"
)

// httpProxyDeniedPathPrefixes are Gateway namespaces HandleHTTP never
// forwards, even for an otherwise-authenticated paired device: they carry
// the Gateway's chat/tool/admin HTTP surface (e.g. /v1/chat/completions,
// /tools/invoke, /api/v1/admin/rpc), which can run with auth.mode "none"
// and rely on the Gateway's own trusted-proxy gate never being reachable
// from outside. These are the exact top-level prefixes the Gateway's own
// Control UI route classifier treats as "not Control UI" (control-ui-routing.ts),
// so excluding them here keeps this proxy's blast radius equal to what
// Dashboard/Canvas actually need: the Control UI SPA and its asset/config
// sub-routes, nothing else.
var httpProxyDeniedPathPrefixes = []string{"/api", "/v1", "/plugins", "/mcp"}

type WebSocketProxy struct {
	config      *config.Config
	db          *db.DB
	upgrader    *websocket.Upgrader
	gatewayHTTP *httputil.ReverseProxy
}

func NewWebSocketProxy(cfg *config.Config, database *db.DB) *WebSocketProxy {
	gatewayURL, err := url.Parse(cfg.GatewayServiceURL)
	if err != nil {
		log.Fatalf("Invalid Gateway service URL %q: %v", cfg.GatewayServiceURL, err)
	}

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
		gatewayHTTP: httputil.NewSingleHostReverseProxy(gatewayURL),
	}
}

func (p *WebSocketProxy) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	remote := clientIP(r)

	device, accessSession, ok := p.authenticateDevice(w, r, remote)
	if !ok {
		return
	}

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

	// Build headers for Gateway. X-Forwarded-For is load-bearing: the Gateway's
	// ingress-attribution only trusts this proxy's peer IP (in its
	// trustedProxies list) when a forwarded-for chain is also present --
	// without it, attribution fails closed with 403 even though the peer is
	// trusted. HandleHTTP gets this for free from httputil.ReverseProxy;
	// the hand-rolled WebSocket dial here does not, so it must set it explicitly.
	//
	// Origin is equally load-bearing and was previously dropped entirely:
	// the Gateway's Control UI auth rejects WebSocket upgrades with no
	// Origin ("origin missing or invalid") once gateway.controlUi.allowedOrigins
	// is configured, regardless of X-Forwarded-Email/-For being valid. The
	// dial below only sends the headers listed here -- unlike HandleHTTP's
	// httputil.ReverseProxy, it does not start from a copy of the client's
	// original request headers, so Origin (and User-Agent, forwarded here
	// too for useful Gateway-side client identification/audit logging) must
	// be copied through explicitly or the Gateway never sees them.
	gatewayHeaders := http.Header{
		"X-Forwarded-Email": []string{device.Email},
		"X-Forwarded-For":   []string{remote},
		"X-Forwarded-Proto": []string{"https"},
		"X-Forwarded-Host":  []string{p.config.Hostname},
		"Host":              []string{p.config.Hostname},
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		gatewayHeaders.Set("Origin", origin)
	}
	if ua := r.Header.Get("User-Agent"); ua != "" {
		gatewayHeaders.Set("User-Agent", ua)
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

// HandleHTTP reverse-proxies a paired device's plain HTTP request (Dashboard
// and Canvas asset/config loads) to the Gateway, injecting the same
// X-Forwarded-Email trusted-proxy header HandleWebSocket already relies on.
// Scoped narrowly: only GET/HEAD (Dashboard/Canvas only ever read), and never
// httpProxyDeniedPathPrefixes, so this cannot become a general-purpose
// reverse proxy for the Gateway's wider HTTP API.
func (p *WebSocketProxy) HandleHTTP(w http.ResponseWriter, r *http.Request) {
	remote := clientIP(r)

	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	for _, prefix := range httpProxyDeniedPathPrefixes {
		if r.URL.Path == prefix || strings.HasPrefix(r.URL.Path, prefix+"/") {
			http.NotFound(w, r)
			return
		}
	}

	device, _, ok := p.authenticateDevice(w, r, remote)
	if !ok {
		return
	}

	r.Header.Set("X-Forwarded-Email", device.Email)
	r.Host = p.config.Hostname
	p.gatewayHTTP.ServeHTTP(w, r)
}

// authenticateDevice validates the bearer token, session, and device/email
// allow-list shared by HandleWebSocket and HandleHTTP. On failure it writes
// the appropriate HTTP error response itself and returns ok=false.
func (p *WebSocketProxy) authenticateDevice(
	w http.ResponseWriter,
	r *http.Request,
	remote string) (*models.MobileDevice, *models.AccessSession, bool) {
	// Tailnet bypass: any peer the local tailscaled control socket vouches
	// for is trusted outright and forwarded as the single configured
	// identity, no GitHub Device Flow and no per-user allowlist. Tailnet
	// membership (Headscale ACLs) is the security boundary for this path.
	if p.config.TailnetEnabled && tailnet.IsPeer(p.config.TailnetSocket, remote) {
		log.Printf("INFO: tailnet-authenticated request remote=%s identity=%s", remote, p.config.TailnetIdentity)
		return &models.MobileDevice{ID: tailnetDeviceID, Email: p.config.TailnetIdentity},
			&models.AccessSession{ID: tailnetSessionID}, true
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("WARN: Request rejected remote=%s reason=missing_authorization_header", remote)
		http.Error(w, "Unauthorized: Missing Authorization header", http.StatusUnauthorized)
		return nil, nil, false
	}

	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		log.Printf("WARN: Request rejected remote=%s reason=invalid_authorization_header", remote)
		http.Error(w, "Unauthorized: Invalid Authorization header", http.StatusUnauthorized)
		return nil, nil, false
	}

	accessToken := parts[1]
	tokenHash := p.config.HashSecret(accessToken)

	// Validate the access token
	accessSession, err := p.db.GetAccessSession(tokenHash)
	if err != nil {
		log.Printf("ERROR: Failed to get access session: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return nil, nil, false
	}

	if accessSession == nil {
		log.Printf("WARN: Request rejected remote=%s reason=invalid_access_token", remote)
		http.Error(w, "Unauthorized: Invalid access token", http.StatusUnauthorized)
		return nil, nil, false
	}

	// Check if token is revoked
	if accessSession.RevokedAt != nil {
		log.Printf("WARN: Request rejected remote=%s reason=token_revoked device=%s", remote, accessSession.DeviceID)
		http.Error(w, "Unauthorized: Token revoked", http.StatusUnauthorized)
		return nil, nil, false
	}

	// Check if token is expired
	if time.Now().After(accessSession.ExpiresAt) {
		log.Printf("WARN: Request rejected remote=%s reason=token_expired device=%s expiredAt=%s",
			remote, accessSession.DeviceID, accessSession.ExpiresAt.Format(time.RFC3339))
		http.Error(w, "Unauthorized: Token expired", http.StatusUnauthorized)
		return nil, nil, false
	}

	// Get the device to get the email
	device, err := p.db.GetMobileDevice(accessSession.DeviceID)
	if err != nil {
		log.Printf("ERROR: Failed to get mobile device: %v", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return nil, nil, false
	}

	if device == nil || device.RevokedAt != nil {
		log.Printf("WARN: Request rejected remote=%s reason=device_not_found_or_revoked device=%s",
			remote, accessSession.DeviceID)
		http.Error(w, "Unauthorized: Device not found or revoked", http.StatusUnauthorized)
		return nil, nil, false
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

		log.Printf("WARN: Request rejected remote=%s reason=email_not_allowed device=%s", remote, device.ID)
		http.Error(w, "Unauthorized: Email not authorized", http.StatusUnauthorized)
		return nil, nil, false
	}

	// Update last seen for device
	p.db.UpdateMobileDeviceLastSeen(device.ID)

	return device, accessSession, true
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
	// RemoteAddr is "ip:port"; the Gateway's X-Forwarded-For parser expects a
	// bare IP, so strip the port instead of forwarding it as part of the host.
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
