package main

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// ── route labels ─────────────────────────────────────────────────────────────

func TestRouteLabel(t *testing.T) {
	tests := map[string]string{
		"/health":                "/health",
		"/api/vehicles":          "/api/vehicles",
		"/api/alerts":            "/api/alerts",
		"/api/alerts/summary":    "/api/alerts/summary",
		"/api/arrivals/127":      "/api/arrivals/{stationId}",
		"/api/arrivals/R20":      "/api/arrivals/{stationId}",
		"/api/gtfs/stops.txt":    "/api/gtfs/{file}",
		"/":                      "other",
		"/wp-admin":              "other",
		"/api/alerts/summary/xx": "other",
	}
	for path, want := range tests {
		if got := routeLabel(path); got != want {
			t.Errorf("routeLabel(%q) = %q, want %q", path, got, want)
		}
	}
}

// Cardinality is the whole reason routeLabel exists: labelling by raw path
// would mint one time series per station, of which there are ~496, plus one for
// every URL a scanner invents.
func TestRouteLabelBoundsCardinality(t *testing.T) {
	seen := map[string]bool{}
	for _, id := range []string{"127", "R20", "635", "A41", "D24", "Q01"} {
		seen[routeLabel("/api/arrivals/"+id)] = true
	}
	if len(seen) != 1 {
		t.Errorf("station IDs produced %d labels, want 1", len(seen))
	}

	junk := map[string]bool{}
	for _, p := range []string{"/wp-login.php", "/.env", "/admin", "/xyz"} {
		junk[routeLabel(p)] = true
	}
	if len(junk) != 1 {
		t.Errorf("unknown paths produced %d labels, want 1 (\"other\")", len(junk))
	}
}

// ── middleware ───────────────────────────────────────────────────────────────

func TestMetricsMiddlewareRecordsStatusAndCount(t *testing.T) {
	before := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("/health", "GET", "200"))

	h := metricsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/health", nil))

	after := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("/health", "GET", "200"))
	if after != before+1 {
		t.Errorf("counter went %v → %v, want +1", before, after)
	}
}

// A handler that writes a body without calling WriteHeader has implicitly sent
// 200; the recorder must not report 0.
func TestMetricsMiddlewareDefaultsTo200(t *testing.T) {
	rec := &statusRecorder{ResponseWriter: httptest.NewRecorder(), status: http.StatusOK}
	if rec.status != 200 {
		t.Fatalf("zero value = %d, want 200", rec.status)
	}
}

func TestMetricsMiddlewareRecordsErrorStatus(t *testing.T) {
	before := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("other", "GET", "404"))

	h := metricsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/nonsense", nil))

	after := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("other", "GET", "404"))
	if after != before+1 {
		t.Errorf("404 counter went %v → %v, want +1", before, after)
	}
}

// ── endpoint wiring ──────────────────────────────────────────────────────────

// /metrics must be reachable, must not be gzip-wrapped by our middleware, and
// must not be counted by it — Fly scrapes every few seconds and would otherwise
// dominate the request counter.
func TestMetricsEndpointIsUnwrappedAndUncounted(t *testing.T) {
	mux := newMux()

	// Plain request: promhttp serves text, and our gzip middleware must not
	// have touched it.
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("Content-Encoding = %q on a plain request, want none", enc)
	}
	if !strings.Contains(rec.Body.String(), "# HELP") {
		t.Error("plain response is not Prometheus exposition format")
	}

	// gzip request: promhttp compresses it itself. The invariant that matters
	// is that it is encoded exactly ONCE — if our middleware also wrapped it,
	// a single decompression would yield more gzip bytes rather than text, and
	// Fly would silently scrape nothing.
	before := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("other", "GET", "200"))

	req := httptest.NewRequest("GET", "/metrics", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	gzRec := httptest.NewRecorder()
	mux.ServeHTTP(gzRec, req)

	if gzRec.Header().Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(gzRec.Body)
		if err != nil {
			t.Fatalf("response claims gzip but does not decode: %v", err)
		}
		defer zr.Close()
		body, err := io.ReadAll(zr)
		if err != nil {
			t.Fatalf("decompressing once failed — likely double-encoded: %v", err)
		}
		if !strings.Contains(string(body), "# HELP") {
			t.Error("one decompression did not yield exposition format — double-encoded")
		}
	}

	after := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("other", "GET", "200"))
	if after != before {
		t.Errorf("scraping /metrics incremented the request counter (%v → %v)", before, after)
	}
}

func TestMetricsEndpointExposesOurCollectors(t *testing.T) {
	metricAlertsEntities.Set(195)
	metricAlertsLabeled.Set(195)
	metricFeedRefresh.WithLabelValues("ACE", "success").Inc()

	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	body := rec.Body.String()

	for _, name := range []string{
		"http_requests_total",
		"http_request_duration_seconds",
		"feed_refresh_total",
		"feed_last_refresh_timestamp_seconds",
		"alerts_entities",
		"alerts_labeled",
		"go_goroutines", // free from the client library's default collectors
	} {
		if !strings.Contains(body, name) {
			t.Errorf("missing metric %q", name)
		}
	}
}
