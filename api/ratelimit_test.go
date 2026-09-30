package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/time/rate"
)

func TestClientIP_XForwardedFor(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 10.0.0.1")
	if got := clientIP(r); got != "1.2.3.4" {
		t.Errorf("clientIP = %q, want 1.2.3.4", got)
	}
}

func TestClientIP_SingleXFF(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("X-Forwarded-For", "5.6.7.8")
	if got := clientIP(r); got != "5.6.7.8" {
		t.Errorf("clientIP = %q, want 5.6.7.8", got)
	}
}

func TestClientIP_RemoteAddr(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "9.8.7.6:12345"
	if got := clientIP(r); got != "9.8.7.6" {
		t.Errorf("clientIP = %q, want 9.8.7.6", got)
	}
}

func TestRateLimiter_AllowsUnderLimit(t *testing.T) {
	rl := &ipRateLimiter{
		entries: make(map[string]*ipEntry),
		r:       10,
		burst:   10,
	}
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := rateLimitMiddleware(rl)(ok)

	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("GET", "/api/vehicles", nil)
		req.RemoteAddr = "1.2.3.4:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: got %d, want 200", i, rec.Code)
		}
	}
}

func TestRateLimiter_RejectsOverLimit(t *testing.T) {
	rl := &ipRateLimiter{
		entries: make(map[string]*ipEntry),
		r:       1,
		burst:   2,
	}
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := rateLimitMiddleware(rl)(ok)

	var rejected bool
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("GET", "/api/vehicles", nil)
		req.RemoteAddr = "1.2.3.4:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			rejected = true
			if rec.Header().Get("Retry-After") != "1" {
				t.Error("missing Retry-After header on 429")
			}
			break
		}
	}
	if !rejected {
		t.Error("expected at least one 429 response")
	}
}

func TestRateLimiter_IndependentPerIP(t *testing.T) {
	rl := &ipRateLimiter{
		entries: make(map[string]*ipEntry),
		r:       rate.Limit(1),
		burst:   2,
	}
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := rateLimitMiddleware(rl)(ok)

	// Exhaust IP A's burst.
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = "1.1.1.1:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
	}

	// IP B should still be allowed.
	req := httptest.NewRequest("GET", "/", nil)
	req.RemoteAddr = "2.2.2.2:1234"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("IP B got %d, want 200", rec.Code)
	}
}
