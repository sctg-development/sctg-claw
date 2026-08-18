package handler

import (
	"net/http"
)

// HealthCheckHandler handles health check endpoints
func (h *Handler) HealthCheckHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status": "healthy"}`))
}

// ReadyCheckHandler handles readiness check endpoints
func (h *Handler) ReadyCheckHandler(w http.ResponseWriter, r *http.Request) {
	// Check database connectivity
	if err := h.db.CleanupExpired(); err != nil {
		http.Error(w, `{"status": "unhealthy", "error": "database error"}`, http.StatusInternalServerError)
		return
	}

	// Check Gateway reachability
	if err := h.checkGatewayReachable(); err != nil {
		http.Error(w, `{"status": "unhealthy", "error": "gateway unreachable"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status": "ready"}`))
}
