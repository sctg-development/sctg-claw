package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/config"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/db"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/handler"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/proxy"
	"github.com/sctg-development/sctg-claw/mobile-auth-broker/internal/tlscert"
)

func main() {
	// Load configuration
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize database
	dbCfg := &db.Config{Path: cfg.DatabasePath}
	database, err := db.NewDB(dbCfg)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer database.Close()

	// Cleanup expired entries on startup
	if err := database.CleanupExpired(); err != nil {
		log.Printf("WARNING: Failed to cleanup expired entries: %v", err)
	}

	// Start periodic cleanup
	ticker := time.NewTicker(5 * time.Minute)
	go func() {
		for range ticker.C {
			if err := database.CleanupExpired(); err != nil {
				log.Printf("WARNING: Failed to cleanup expired entries: %v", err)
			}
		}
	}()

	// Create handler
	handler := handler.NewHandler(cfg, database)

	// Create WebSocket proxy
	wsProxy := proxy.NewWebSocketProxy(cfg, database)

	// Create router
	r := mux.NewRouter()

	// Register routes
	handler.RegisterRoutes(r)

	// WebSocket route - must come after other routes
	r.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if isWebSocketUpgrade(r) {
			wsProxy.HandleWebSocket(w, r)
			return
		}

		// Not a WebSocket upgrade: forward to the Gateway's Dashboard/Canvas
		// Control UI (HandleHTTP scopes this to GET/HEAD and denies the
		// Gateway's wider chat/tool/admin HTTP surface on its own).
		wsProxy.HandleHTTP(w, r)
	})

	// Catch-all for other paths
	r.NotFoundHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isWebSocketUpgrade(r) {
			wsProxy.HandleWebSocket(w, r)
			return
		}

		wsProxy.HandleHTTP(w, r)
	})

	// Create server. One *http.Server, one listener per configured port --
	// Serve() can be called concurrently on the same server for as many
	// listeners as needed, and a single Shutdown() call below drains all of
	// them together.
	srv := &http.Server{
		Handler: r,
		// Timeouts
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	log.Printf("Hostname: %s", cfg.Hostname)
	log.Printf("Gateway Service URL: %s", cfg.GatewayServiceURL)
	log.Printf("Allowed Emails: %v", cfg.AllowedEmails)

	// Bind every port up front so a bad port (e.g. 80 without
	// CAP_NET_BIND_SERVICE) fails startup immediately instead of silently
	// running on a subset of the configured ports.
	listeners := make([]net.Listener, 0, len(cfg.ListenPorts))
	for _, port := range cfg.ListenPorts {
		addr := fmt.Sprintf(":%d", port)
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("Failed to listen on %s: %v", addr, err)
		}
		listeners = append(listeners, ln)
		log.Printf("Listening on %s", addr)
	}

	for _, ln := range listeners {
		ln := ln
		go func() {
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				log.Fatalf("Server error on %s: %v", ln.Addr(), err)
			}
		}()
	}

	// TLS listeners, for native clients whose sign-in flow requires
	// https:// (see internal/tlscert's package doc). Manager.Start obtains
	// the certificate synchronously before any TLS listener opens -- there
	// is nothing useful to serve otherwise -- then renews it in the
	// background for the life of the process.
	if cfg.TLSEnabled {
		certManager := tlscert.NewManager(
			cfg.TLSDomain, cfg.TLSEmail, cfg.TLSCloudflareToken, cfg.TLSCertCacheDir, cfg.TLSACMEStaging)
		if err := certManager.Start(); err != nil {
			log.Fatalf("Failed to start TLS certificate manager: %v", err)
		}

		tlsConfig := &tls.Config{GetCertificate: certManager.GetCertificate}
		tlsListeners := make([]net.Listener, 0, len(cfg.TLSPorts))
		for _, port := range cfg.TLSPorts {
			addr := fmt.Sprintf(":%d", port)
			ln, err := net.Listen("tcp", addr)
			if err != nil {
				log.Fatalf("Failed to listen on %s: %v", addr, err)
			}
			tlsListeners = append(tlsListeners, tls.NewListener(ln, tlsConfig))
			log.Printf("Listening on %s (TLS, %s)", addr, cfg.TLSDomain)
		}
		for _, ln := range tlsListeners {
			ln := ln
			go func() {
				if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
					log.Fatalf("Server error on %s: %v", ln.Addr(), err)
				}
			}()
		}
	}

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down...")

	// Stop server
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("Server shutdown error: %v", err)
	}

	// Stop cleanup ticker
	ticker.Stop()

	log.Println("Server stopped")
}

func isWebSocketUpgrade(r *http.Request) bool {
	// Check for WebSocket upgrade header
	if strings.ToLower(r.Header.Get("Upgrade")) != "websocket" {
		return false
	}

	// Check for Connection: Upgrade
	if strings.ToLower(r.Header.Get("Connection")) != "upgrade" {
		return false
	}

	return true
}
