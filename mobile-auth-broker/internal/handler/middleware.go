package handler

import (
	"log"
	"net/http"
	"strings"
)

// HostValidationMiddleware validates that the Host header matches the configured hostname
func (h *Handler) HostValidationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		// Remove port if present
		if idx := strings.Index(host, ":"); idx != -1 {
			host = host[:idx]
		}

		if host != h.config.Hostname {
			log.Printf("WARNING: Request with invalid Host header: %s (expected: %s)", r.Host, h.config.Hostname)
			http.Error(w, `{"error": "invalid_host", "error_message": "Invalid hostname"}`, http.StatusForbidden)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// LoggingMiddleware logs request information (without sensitive data)
func (h *Handler) LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Log request
		log.Printf("INFO: %s %s %s", r.Method, r.URL.Path, r.RemoteAddr)

		// Call next handler
		next.ServeHTTP(w, r)
	})
}

// SecureHeadersMiddleware adds security headers to responses
func (h *Handler) SecureHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Add security headers
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Content-Security-Policy", "default-src 'self'")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

		next.ServeHTTP(w, r)
	})
}
