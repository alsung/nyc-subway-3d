package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/time/rate"
)

func TestClientIP_FlyClientIPWinsOverForgedXFF(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Fly-Client-IP", "1.2.3.4")
	r.Header.Set("X-Forwarded-For", "6.6.6.6, 10.0.0.1")
	if got := clientIP(r); got != "1.2.3.4" {
		t.Errorf("clientIP = %q, want 1.2.3.4", got)
	}
}

func TestClientIP_IgnoresXFF(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "9.8.7.6:12345"
	r.Header.Set("X-Forwarded-For", "5.6.7.8")
	if got := clientIP(r); got != "9.8.7.6" {
		t.Errorf("clientIP = %q, want 9.8.7.6 (RemoteAddr)", got)
	}
}

func TestClientIP_RemoteAddr(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "9.8.7.6:12345"
	if got := clientIP(r); got != "9.8.7.6" {
		t.Errorf("clientIP = %q, want 9.8.7.6", got)
	}
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func TestRateLimiter_AllowsUnderLimit(t *testing.T) {
	handler := rateLimitMiddleware(newIPRateLimiter("test", 10, 10))(okHandler())

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
	handler := rateLimitMiddleware(newIPRateLimiter("test", 1, 2))(okHandler())

	var rejected bool
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("GET", "/api/vehicles", nil)
		req.RemoteAddr = "1.2.3.4:1234"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			rejected = true
			if rec.Header().Get("Retry-After") != "1" {
				t.Errorf("Retry-After = %q, want 1", rec.Header().Get("Retry-After"))
			}
			break
		}
	}
	if !rejected {
		t.Error("expected at least one 429 response")
	}
}

// Rotating X-Forwarded-For must not buy a fresh bucket: on Fly every request
// carries the real address in Fly-Client-IP.
func TestRateLimiter_ForgedXFFSharesBucket(t *testing.T) {
	handler := rateLimitMiddleware(newIPRateLimiter("test", 1, 2))(okHandler())

	var codes []int
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("POST", "/api/auth/login", nil)
		req.Header.Set("Fly-Client-IP", "1.2.3.4")
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("10.0.0.%d", i))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		codes = append(codes, rec.Code)
	}
	if codes[2] != http.StatusTooManyRequests {
		t.Errorf("codes = %v, want the 3rd request limited", codes)
	}
}

func TestRateLimiter_EvictsLeastRecentlySeenWhenFull(t *testing.T) {
	rl := newIPRateLimiter("test", 10, 10)
	ip := func(i int) string { return fmt.Sprintf("10.0.%d.%d", i/256, i%256) }
	for i := 0; i < maxLimiterEntries; i++ {
		rl.get(ip(i))
	}
	// Touch the oldest entry so it becomes the most recent; ip(1) is now the
	// least recently seen.
	kept := rl.get(ip(0))

	handler := rateLimitMiddleware(rl)(okHandler())
	req := httptest.NewRequest("GET", "/api/vehicles", nil)
	req.RemoteAddr = "99.99.99.99:1234"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("new IP when table full: got %d, want 200", rec.Code)
	}

	if len(rl.entries) != maxLimiterEntries || rl.order.Len() != maxLimiterEntries {
		t.Errorf("table size = %d (list %d), want %d", len(rl.entries), rl.order.Len(), maxLimiterEntries)
	}
	if _, ok := rl.entries[ip(1)]; ok {
		t.Error("least recently seen IP was not evicted")
	}
	if rl.entries[ip(0)] == nil || rl.entries[ip(0)].limiter != kept {
		t.Error("recently used IP lost its bucket")
	}
	if _, ok := rl.entries["99.99.99.99"]; !ok {
		t.Error("new IP was not added")
	}
}

func TestRateLimiter_IndependentPerIP(t *testing.T) {
	handler := rateLimitMiddleware(newIPRateLimiter("test", rate.Limit(1), 2))(okHandler())

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

// muxRequest sends one request through the full newMux stack as ip.
func muxRequest(h http.Handler, method, path, ip, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Fly-Client-IP", ip)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPasswordLimit_Login(t *testing.T) {
	a, _ := authTestApp(t)
	h := newMux(a)
	body := `{"email":"nobody-ratelimit@example.com","password":"wrong-password"}`

	for i := 1; i <= 5; i++ {
		if rec := muxRequest(h, "POST", "/api/auth/login", "1.2.3.4", body); rec.Code != http.StatusUnauthorized {
			t.Fatalf("login %d: got %d, want 401", i, rec.Code)
		}
	}

	rec := muxRequest(h, "POST", "/api/auth/login", "1.2.3.4", body)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("login 6: got %d, want 429", rec.Code)
	}
	if secs, err := strconv.Atoi(rec.Header().Get("Retry-After")); err != nil || secs < 1 {
		t.Errorf("Retry-After = %q, want a whole number of seconds >= 1", rec.Header().Get("Retry-After"))
	}
	var resp struct{ Error string }
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || !strings.HasPrefix(resp.Error, "Too many attempts") {
		t.Errorf("body = %q, want a JSON error the modal can show", rec.Body.String())
	}

	// The global limiter is separate: the same IP can still load the map.
	if rec := muxRequest(h, "GET", "/api/vehicles", "1.2.3.4", ""); rec.Code == http.StatusTooManyRequests {
		t.Error("/api/vehicles was limited by the password limiter")
	}
	// Another IP has its own bucket.
	if rec := muxRequest(h, "POST", "/api/auth/login", "5.6.7.8", body); rec.Code != http.StatusUnauthorized {
		t.Errorf("login from another IP: got %d, want 401", rec.Code)
	}
}

// Each password route has its own bucket: using up login's doesn't block a
// password reset from the same IP.
func TestPasswordLimit_SeparateBucketPerRoute(t *testing.T) {
	a, _ := authTestApp(t)
	h := newMux(a)
	login := `{"email":"nobody-ratelimit@example.com","password":"wrong-password"}`

	for i := 1; i <= 6; i++ {
		muxRequest(h, "POST", "/api/auth/login", "1.2.3.4", login)
	}
	if rec := muxRequest(h, "POST", "/api/auth/login", "1.2.3.4", login); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("login after 6 attempts: got %d, want 429", rec.Code)
	}
	rec := muxRequest(h, "POST", "/api/auth/forgot-password", "1.2.3.4", `{"email":"nobody-ratelimit@example.com"}`)
	if rec.Code != http.StatusOK {
		t.Errorf("forgot-password after login was limited: got %d, want 200", rec.Code)
	}
}

// The global 429 must carry CORS headers, or the browser hides the response
// and the app reports a network error.
func TestGlobalLimit_429HasCORSHeaders(t *testing.T) {
	h := newMux(&app{})
	var rec *httptest.ResponseRecorder
	for i := 0; i < 40; i++ {
		req := httptest.NewRequest("GET", "/api/vehicles", nil)
		req.Header.Set("Fly-Client-IP", "1.2.3.4")
		req.Header.Set("Origin", "https://localexpress.nyc")
		rec = httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			break
		}
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("40 requests never hit the global limit (last %d)", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://localexpress.nyc" {
		t.Errorf("Access-Control-Allow-Origin = %q on 429, want https://localexpress.nyc", got)
	}
	if want := `{"error":"Too many attempts. Try again in 1 second."}`; rec.Body.String() != want {
		t.Errorf("body = %q, want %q", rec.Body.String(), want)
	}
}

// The limit runs before requireAuth, so calls without a token still use up
// the bucket and never reach bcrypt.
func TestPasswordLimit_ChangePasswordBeforeAuth(t *testing.T) {
	a, _ := authTestApp(t)
	h := newMux(a)

	for i := 1; i <= 5; i++ {
		if rec := muxRequest(h, "POST", "/api/auth/change-password", "1.2.3.4", `{}`); rec.Code != http.StatusUnauthorized {
			t.Fatalf("change-password %d: got %d, want 401", i, rec.Code)
		}
	}
	if rec := muxRequest(h, "POST", "/api/auth/change-password", "1.2.3.4", `{}`); rec.Code != http.StatusTooManyRequests {
		t.Errorf("change-password 6: got %d, want 429", rec.Code)
	}
}
