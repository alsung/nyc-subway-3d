package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
)

func seedFeedCache(age time.Duration, count int) func() {
	feedsMu.Lock()
	origCache := feedCache
	origRefresh := lastRefresh
	feedCache = make(map[string]feedEntry)
	for i := 0; i < count; i++ {
		feedCache[string(rune('a'+i))] = feedEntry{msg: &gtfs.FeedMessage{}, fetchedAt: time.Now()}
	}
	if count > 0 {
		lastRefresh = time.Now().Add(-age)
	} else {
		lastRefresh = time.Time{}
	}
	feedsMu.Unlock()
	return func() {
		feedsMu.Lock()
		feedCache = origCache
		lastRefresh = origRefresh
		feedsMu.Unlock()
	}
}

func TestHealthOK(t *testing.T) {
	restore := seedFeedCache(10*time.Second, 8)
	defer restore()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	handleHealth(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected application/json, got %q", ct)
	}
	var resp healthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Status != "ok" {
		t.Errorf("expected status 'ok', got %q", resp.Status)
	}
	if resp.FeedAgeSec < 0 || resp.FeedAgeSec > 30 {
		t.Errorf("expected feedAgeSec ~10, got %f", resp.FeedAgeSec)
	}
	if resp.FeedsLoaded != 8 {
		t.Errorf("expected feedsLoaded 8, got %d", resp.FeedsLoaded)
	}
}

func TestHealthDegradedWhenStale(t *testing.T) {
	restore := seedFeedCache(4*time.Minute, 8)
	defer restore()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	handleHealth(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
	var resp healthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Status != "degraded" {
		t.Errorf("expected status 'degraded', got %q", resp.Status)
	}
}

func TestHealthDegradedWhenNoFeeds(t *testing.T) {
	restore := seedFeedCache(0, 0)
	defer restore()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	handleHealth(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", w.Code)
	}
	var resp healthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Status != "degraded" {
		t.Errorf("expected status 'degraded', got %q", resp.Status)
	}
	if resp.FeedAgeSec != -1 {
		t.Errorf("expected feedAgeSec -1 when never refreshed, got %f", resp.FeedAgeSec)
	}
}

func TestCORSAllowsProduction(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://localexpress.nyc")
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://localexpress.nyc" {
		t.Errorf("expected production origin, got %q", got)
	}
}

func TestCORSAllowsLocalhost(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Errorf("expected localhost origin, got %q", got)
	}
}

func TestCORSRejectsUnknownOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "https://evil-site.com")
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("expected no CORS header for unknown origin, got %q", got)
	}
}

func TestCORSPreflight(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/api/arrivals/123", nil)
	req.Header.Set("Origin", "https://localexpress.nyc")
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "https://localexpress.nyc" {
		t.Errorf("expected production origin, got %q", got)
	}
}
