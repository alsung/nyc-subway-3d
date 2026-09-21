package main

import (
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// ── route labels ─────────────────────────────────────────────────────────────

// routeLabel now takes the router's matched pattern, not the request path.
func TestRouteLabel(t *testing.T) {
	tests := map[string]string{
		"GET /health":                   "/health",
		"GET /api/vehicles":             "/api/vehicles",
		"GET /api/plan":                 "/api/plan",
		"GET /api/alerts/summary":       "/api/alerts/summary",
		"GET /api/arrivals/{stationId}": "/api/arrivals/{stationId}",
		"GET /api/gtfs/{file}":          "/api/gtfs/{file}",
		// Method is already its own label; carrying it here would split every
		// route in two for no added information.
		"POST /api/plan": "/api/plan",
		// Nothing matched: a 404, a 405, or a traversal that redirected.
		"": "other",
		// A pattern with no method still yields the path.
		"/api/vehicles": "/api/vehicles",
	}
	for pattern, want := range tests {
		if got := routeLabel(pattern); got != want {
			t.Errorf("routeLabel(%q) = %q, want %q", pattern, got, want)
		}
	}
}

// Cardinality is the whole reason routeLabel exists. Under the old allowlist
// this was a claim about the function; now it is a claim about the router —
// a matched request can only ever produce a pattern someone registered, and
// everything else shares one series.
func TestRouteLabelBoundsCardinality(t *testing.T) {
	// Every station ID resolves to the same registered pattern, so 496 stations
	// cost one series rather than 496.
	seen := map[string]bool{}
	for range []string{"127", "R20", "635", "A41", "D24", "Q01"} {
		seen[routeLabel("GET /api/arrivals/{stationId}")] = true
	}
	if len(seen) != 1 {
		t.Errorf("station IDs produced %d labels, want 1", len(seen))
	}

	// Scanners match nothing, so ServeMux hands us an empty pattern for all of
	// them however many distinct URLs they try.
	junk := map[string]bool{}
	for range []string{"/wp-login.php", "/.env", "/admin", "/xyz"} {
		junk[routeLabel("")] = true
	}
	if len(junk) != 1 || !junk["other"] {
		t.Errorf("unmatched requests produced %v, want exactly {\"other\"}", junk)
	}
}

// The label a route gets must be the one the router actually matched, end to
// end through the real mux. This is the regression test for /api/plan, which
// shipped and spent months counted as "other" because the old allowlist was
// never extended.
func TestRouteLabelsComeFromTheRealMux(t *testing.T) {
	mux := newMux()

	for _, tc := range []struct{ path, wantRoute string }{
		{"/health", "/health"},
		{"/api/vehicles", "/api/vehicles"},
		{"/api/arrivals/127N", "/api/arrivals/{stationId}"},
		{"/nonsense", "other"},
		{"/wp-admin/setup-config.php", "other"},
	} {
		before := countRequests(tc.wantRoute)
		mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", tc.path, nil))
		if after := countRequests(tc.wantRoute); after <= before {
			t.Errorf("GET %s did not increment route=%q (%v → %v)",
				tc.path, tc.wantRoute, before, after)
		}
	}
}

// Sums a route's counter across every status, since a handler's status depends
// on live state this test does not control.
func countRequests(route string) float64 {
	total := 0.0
	for _, status := range []string{"200", "204", "400", "404", "405", "500", "503"} {
		total += testutil.ToFloat64(metricHTTPRequests.WithLabelValues(route, "GET", status))
	}
	return total
}

// ── middleware ───────────────────────────────────────────────────────────────

// Exercised without a mux behind it, so nothing sets r.Pattern and the request
// is correctly counted as unmatched. The routed case is covered end to end in
// TestRouteLabelsComeFromTheRealMux.
func TestMetricsMiddlewareRecordsStatusAndCount(t *testing.T) {
	before := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("other", "GET", "200"))

	h := metricsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/health", nil))

	after := testutil.ToFloat64(metricHTTPRequests.WithLabelValues("other", "GET", "200"))
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
	// A GaugeVec exposes nothing until a series exists, and this one is
	// deliberately not pre-created — see initFeedMetrics.
	metricFeedLastRefresh.WithLabelValues("ACE").Set(1_700_000_000)

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

// ── feed metrics ─────────────────────────────────────────────────────────────

// Every counter series must exist before the first refresh. PromQL cannot alert
// on the rate of a series that does not exist, so a failure counter that first
// appears during an outage is a counter nobody was alerting on.
func TestInitFeedMetricsCreatesEverySeriesAtZero(t *testing.T) {
	initFeedMetrics()

	for group := range feedURLs {
		for _, result := range []string{"success", "failure"} {
			m, err := metricFeedRefresh.GetMetricWithLabelValues(group, result)
			if err != nil {
				t.Fatalf("GetMetricWithLabelValues(%q, %q): %v", group, result, err)
			}
			if got := testutil.ToFloat64(m); got < 0 {
				t.Errorf("%s/%s = %v, want a present series", group, result, got)
			}
		}
	}

	// Specifically the one that would otherwise be absent: no feed has failed
	// in production since the service was deployed.
	if !strings.Contains(exposition(t), `feed_refresh_total{group="ACE",result="failure"}`) {
		t.Error("failure series for ACE is missing from /metrics")
	}
}

// The staleness gauge must advance only for feeds that actually refreshed.
//
// It was previously a single unlabelled gauge set once per cycle, outside the
// success check, so it reported a fresh timestamp even when every feed had
// failed — and an alert on its age could not fire in the situation it existed
// to catch.
func TestStalenessGaugeIsPerGroupAndOnlyOnSuccess(t *testing.T) {
	const ts = 1_700_000_500

	metricFeedLastRefresh.WithLabelValues("JZ").Set(ts)

	if got := testutil.ToFloat64(metricFeedLastRefresh.WithLabelValues("JZ")); got != ts {
		t.Errorf("refreshed group = %v, want %v", got, float64(ts))
	}

	// A group that never refreshed has no series at all, which is what lets
	// `time() - feed_last_refresh_timestamp_seconds > 180` fire per feed rather
	// than being masked by seven healthy ones.
	body := exposition(t)
	if strings.Contains(body, `feed_last_refresh_timestamp_seconds{group="NEVER"}`) {
		t.Error("a group that never succeeded should have no staleness series")
	}
}

func exposition(t *testing.T) string {
	t.Helper()
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	return rec.Body.String()
}

// The regression test for the bug this replaced: refreshFeeds set a single
// unlabelled gauge once per cycle, outside the success check, so a cycle in
// which every feed failed still reported a fresh timestamp. An alert on the
// gauge's age could not fire in the one situation it existed to catch.
//
// Drives the real refreshFeeds against feeds that cannot be reached.
func TestRefreshFeedsDoesNotAdvanceStalenessOnTotalFailure(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusBadGateway)
	}))
	defer dead.Close()

	originalURLs := feedURLs
	feedURLs = map[string]string{"TESTA": dead.URL, "TESTB": dead.URL}
	defer func() { feedURLs = originalURLs }()

	// refreshFeeds writes global state even when every feed fails: it stamps
	// lastRefresh and rebuilds the departure index. Restored here so this test
	// cannot leak a "realtime data is present" signal into tests that assert
	// its absence.
	feedsMu.Lock()
	savedRefresh, savedDepartures := lastRefresh, departures
	feedsMu.Unlock()
	defer func() {
		feedsMu.Lock()
		lastRefresh, departures = savedRefresh, savedDepartures
		feedsMu.Unlock()
	}()

	before := countFailures("TESTA") + countFailures("TESTB")

	refreshFeeds(context.Background())

	if after := countFailures("TESTA") + countFailures("TESTB"); after != before+2 {
		t.Errorf("failure counter went %v → %v, want +2", before, after)
	}

	// The point of the test: nothing refreshed, so nothing may claim to have.
	body := exposition(t)
	for _, group := range []string{"TESTA", "TESTB"} {
		series := `feed_last_refresh_timestamp_seconds{group="` + group + `"}`
		if strings.Contains(body, series) {
			t.Errorf("%s reported a refresh timestamp after failing", group)
		}
	}
}

func countFailures(group string) float64 {
	return testutil.ToFloat64(metricFeedRefresh.WithLabelValues(group, "failure"))
}
