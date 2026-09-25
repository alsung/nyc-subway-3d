package main

// Prometheus instrumentation.
//
// Fly scrapes this endpoint automatically once api/fly.toml declares a
// [metrics] block, and exposes it through their managed Prometheus and Grafana
// at no extra cost — so these collectors are read by something real rather than
// existing for their own sake.
//
// Two deliberate choices below.
//
// First, route labels come from the router's own matched pattern rather than
// the request path. Labelling by r.URL.Path would mint a new time series for
// every station ID ever requested — 496 of them, plus whatever scanners try —
// which is the classic way to melt a Prometheus instance. Taking the pattern
// instead bounds cardinality by the number of registered routes, and every
// request that matches nothing costs exactly one shared series.
//
// This replaced a hand-maintained allowlist, which held cardinality just as
// well but depended on someone remembering to extend it. Nobody did: /api/plan
// shipped and spent months folded into "other", so the most expensive endpoint
// in the service was the one route that could not be measured.
//
// Second, /metrics is deliberately registered outside both the gzip middleware
// and this middleware (see newMux). promhttp negotiates its own encoding, so
// wrapping it in ours would double-encode and break scraping silently; and Fly
// scrapes every few seconds, which would otherwise dominate the request counter.

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	metricHTTPRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "Total HTTP requests by route, method and status.",
	}, []string{"route", "method", "status"})

	metricHTTPDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP request duration by route and method.",
		Buckets: prometheus.DefBuckets,
	}, []string{"route", "method"})

	// Feed health. A rising failure count with a flat success count is the
	// signal that an upstream MTA feed has gone away, which last-known-good
	// caching would otherwise hide from users and from us.
	metricFeedRefresh = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "feed_refresh_total",
		Help: "GTFS-RT feed refresh attempts by feed group and result.",
	}, []string{"group", "result"})

	// Labelled by group, and set only on success.
	//
	// This was one unlabelled gauge set once per refresh cycle, outside the
	// success check — so it advanced even when every feed had failed, and
	// reported a fresh timestamp over a cache holding nothing but last-known-
	// good. An alert on its age could not fire in the one situation it existed
	// to catch. Per group, because eight feeds fail independently and the whole
	// point of last-known-good is that seven healthy ones hide the eighth.
	metricFeedLastRefresh = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "feed_last_refresh_timestamp_seconds",
		Help: "Unix time of the last successful refresh, per feed group.",
	}, []string{"group"})

	metricAlertsEntities = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "alerts_entities",
		Help: "Alerts currently cached from the MTA alerts feed.",
	})

	// Paired with the gauge above on purpose: a gap between them means MTA's
	// Mercury extension stopped parsing and every alert has silently fallen
	// back to a generic label. Nothing crashes when that happens, which is
	// exactly why it needs a metric.
	metricAlertsLabeled = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "alerts_labeled",
		Help: "Cached alerts carrying a readable Mercury label.",
	})

	metricPlanNoRoute = promauto.NewCounter(prometheus.CounterOpts{
		Name: "plan_no_route_total",
		Help: "Plan requests that returned zero journeys.",
	})
)

// initFeedMetrics creates every feed counter series at zero, before the first
// refresh runs.
//
// A counter that has never been incremented has no series at all, and PromQL
// cannot alert on the rate of something that does not exist. Left alone,
// feed_refresh_total{result="failure"} would first appear at the moment of the
// outage it is supposed to warn about — which is too late to have been
// alerting on it.
//
// The staleness gauge is deliberately not initialised here. A gauge starting at
// zero reads as a refresh in 1970 and would fire a staleness alert on every
// deploy; it should simply appear after the first successful refresh.
func initFeedMetrics() {
	for group := range feedURLs {
		metricFeedRefresh.WithLabelValues(group, "success").Add(0)
		metricFeedRefresh.WithLabelValues(group, "failure").Add(0)
	}
}

// routeLabel turns a matched router pattern into a metric label.
//
// Go's ServeMux sets r.Pattern on the request itself when it matches, and it
// does so in place, so a middleware wrapping the mux from outside can read it
// once next.ServeHTTP has returned. Patterns arrive with the method attached
// ("GET /api/plan"), which is stripped because method is already its own label.
//
// An empty pattern means the router matched nothing — a 404, a 405 from a
// method mismatch, or a path traversal that redirected. All of those share the
// "other" series, which is what keeps a scanner from inventing new label values.
func routeLabel(pattern string) string {
	if pattern == "" {
		return "other"
	}
	if i := strings.IndexByte(pattern, ' '); i >= 0 {
		return pattern[i+1:]
	}
	return pattern
}

// statusRecorder captures the status code for the metrics labels. A handler
// that writes a body without calling WriteHeader has implicitly sent 200, so
// that is the zero value here rather than 0.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

		next.ServeHTTP(rec, r)

		// Read after the inner mux has routed: that is when r.Pattern is set.
		route := routeLabel(r.Pattern)
		metricHTTPDuration.WithLabelValues(route, r.Method).Observe(time.Since(start).Seconds())
		metricHTTPRequests.WithLabelValues(route, r.Method, strconv.Itoa(rec.status)).Inc()
	})
}
