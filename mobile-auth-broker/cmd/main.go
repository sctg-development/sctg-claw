package main

import (
	"context"
	"log"
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
		// Check if this is a WebSocket upgrade request
		if isWebSocketUpgrade(r) {
			wsProxy.HandleWebSocket(w, r)
			return
		}
		
		// For non-WebSocket requests to root, return 404
		http.NotFound(w, r)
	})

	// Catch-all for other paths - return 404
	r.NotFoundHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check if this is a WebSocket upgrade request for any path
		if isWebSocketUpgrade(r) {
			wsProxy.HandleWebSocket(w, r)
			return
		}
		
		http.NotFound(w, r)
	})

	// Create server
	srv := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: r,
		// Timeouts
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Start server
	log.Printf("Starting mobile-auth-broker on %s", cfg.ListenAddr)
	log.Printf("Hostname: %s", cfg.Hostname)
	log.Printf("Gateway Service URL: %s", cfg.GatewayServiceURL)
	log.Printf("Allowed Emails: %v", cfg.AllowedEmails)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

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
