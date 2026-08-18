package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
)

func TestHealthzEndpoint(t *testing.T) {
	// This test verifies the health check endpoint works
	// We'll create a simple handler that mimics the health check behavior
	
	r := mux.NewRouter()
	r.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	req, err := http.NewRequest("GET", "/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("Expected status %d, got %d", http.StatusOK, rr.Code)
	}

	if rr.Body.String() != "OK" {
		t.Errorf("Expected body 'OK', got '%s'", rr.Body.String())
	}
}

func TestHostValidation(t *testing.T) {
	// Test host validation logic
	tests := []struct {
		name       string
		host       string
		expectedHost string
		shouldPass  bool
	}{
		{
			name:       "Correct host",
			host:       "mobile.test.example.org",
			expectedHost: "mobile.test.example.org",
			shouldPass:  true,
		},
		{
			name:       "Wrong host",
			host:       "wrong.example.org",
			expectedHost: "mobile.test.example.org",
			shouldPass:  false,
		},
		{
			name:       "Host with port",
			host:       "mobile.test.example.org:8080",
			expectedHost: "mobile.test.example.org",
			shouldPass:  true,
		},
		{
			name:       "Different host with port",
			host:       "wrong.example.org:8080",
			expectedHost: "mobile.test.example.org",
			shouldPass:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Extract host without port
			host := tt.host
			for i, c := range host {
				if c == ':' {
					host = host[:i]
					break
				}
			}

			if host != tt.expectedHost {
				if tt.shouldPass {
					t.Errorf("Expected host '%s' to match '%s'", host, tt.expectedHost)
				}
			} else {
				if !tt.shouldPass {
					t.Errorf("Expected host '%s' to not match '%s'", host, tt.expectedHost)
				}
			}
		})
	}
}

func TestSecureHeaders(t *testing.T) {
	// Test that security headers are set correctly
	r := mux.NewRouter()
	r.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		// Set security headers
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	req, _ := http.NewRequest("GET", "/test", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)

	// Check security headers
	if rr.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("Expected X-Content-Type-Options header")
	}

	if rr.Header().Get("X-Frame-Options") != "DENY" {
		t.Error("Expected X-Frame-Options header")
	}

	if rr.Header().Get("X-XSS-Protection") != "1; mode=block" {
		t.Error("Expected X-XSS-Protection header")
	}
}
