package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ── isAllowed ────────────────────────────────────────────────────────────────

func TestIsAllowedPermitsMTADomain(t *testing.T) {
	if !isAllowed("https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs") {
		t.Fatal("expected MTA domain to be allowed")
	}
}

func TestIsAllowedPermitsMTAS3(t *testing.T) {
	if !isAllowed("https://rrgtfsfeeds.s3.amazonaws.com/gtfssubway.zip") {
		t.Fatal("expected MTA S3 bucket to be allowed")
	}
}

func TestIsAllowedBlocksArbitraryDomain(t *testing.T) {
	if isAllowed("https://evil.com/steal") {
		t.Fatal("expected arbitrary domain to be blocked")
	}
}

func TestIsAllowedBlocksMalformedURL(t *testing.T) {
	if isAllowed("not-a-url") {
		t.Fatal("expected malformed URL to be blocked")
	}
}

// ── cache ────────────────────────────────────────────────────────────────────

func TestCacheHitReturnsStoredBody(t *testing.T) {
	c := newCache()
	c.set("key1", []byte("hello"))
	body, ok := c.get("key1")
	if !ok {
		t.Fatal("expected cache hit")
	}
	if string(body) != "hello" {
		t.Fatalf("expected 'hello', got %q", string(body))
	}
}

func TestCacheMissOnUnknownKey(t *testing.T) {
	c := newCache()
	_, ok := c.get("nonexistent")
	if ok {
		t.Fatal("expected cache miss for unknown key")
	}
}

func TestCacheExpiry(t *testing.T) {
	c := newCache()
	c.set("key2", []byte("data"))
	// backdate the entry beyond TTL
	c.mu.Lock()
	e := c.entries["key2"]
	e.fetchedAt = time.Now().Add(-2 * cacheTTL)
	c.entries["key2"] = e
	c.mu.Unlock()

	_, ok := c.get("key2")
	if ok {
		t.Fatal("expected expired entry to be a cache miss")
	}
}

func TestCacheOverwrite(t *testing.T) {
	c := newCache()
	c.set("key3", []byte("first"))
	c.set("key3", []byte("second"))
	body, ok := c.get("key3")
	if !ok {
		t.Fatal("expected cache hit after overwrite")
	}
	if string(body) != "second" {
		t.Fatalf("expected 'second', got %q", string(body))
	}
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

func TestHealthReturns200AndJSON(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	makeHealthHandler()(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("expected application/json, got %q", ct)
	}
}

func TestProxyMissingURLReturns400(t *testing.T) {
	c := newCache()
	req := httptest.NewRequest(http.MethodGet, "/proxy", nil)
	w := httptest.NewRecorder()
	makeProxyHandler(c)(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestProxyBlockedURLReturns403(t *testing.T) {
	c := newCache()
	req := httptest.NewRequest(http.MethodGet, "/proxy?url=https://evil.com/data", nil)
	w := httptest.NewRecorder()
	makeProxyHandler(c)(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func TestProxyPOSTReturns405(t *testing.T) {
	c := newCache()
	req := httptest.NewRequest(http.MethodPost, "/proxy?url=https://api-endpoint.mta.info/feed", nil)
	w := httptest.NewRecorder()
	makeProxyHandler(c)(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestProxyOPTIONSReturns204WithCORSHeader(t *testing.T) {
	c := newCache()
	req := httptest.NewRequest(http.MethodOptions, "/proxy", nil)
	w := httptest.NewRecorder()
	makeProxyHandler(c)(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("expected CORS header Access-Control-Allow-Origin: *")
	}
}

func TestProxyCacheHitReturnsCachedBody(t *testing.T) {
	c := newCache()
	targetURL := "https://api-endpoint.mta.info/feed"
	c.set(targetURL, []byte("cached-protobuf-data"))

	req := httptest.NewRequest(http.MethodGet, "/proxy?url="+targetURL, nil)
	w := httptest.NewRecorder()
	makeProxyHandler(c)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if w.Header().Get("X-Cache") != "HIT" {
		t.Fatal("expected X-Cache: HIT")
	}
	if w.Body.String() != "cached-protobuf-data" {
		t.Fatalf("expected cached body, got %q", w.Body.String())
	}
}
