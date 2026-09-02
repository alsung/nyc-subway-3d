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
// First, route labels come from an explicit allowlist rather than the request
// path. Labelling by r.URL.Path would mint a new time series for every station
// ID ever requested — 496 of them, plus whatever scanners try — which is the
// classic way to melt a Prometheus instance. Unrecognised paths collapse into
// "other" and cost exactly one series.
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

	metricFeedLastRefresh = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "feed_last_refresh_timestamp_seconds",
		Help: "Unix time of the last successful real-time feed refresh.",
	})

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
)

// routeLabel maps a request path to a bounded label, holding cardinality fixed:
// labelling by raw path would mint a series per station ID and per URL a scanner
// invents.
//
// This was written when the module targeted Go 1.22, whose ServeMux did not
// expose the matched pattern. Since the 1.27 upgrade r.Pattern is available and
// does work from this middleware (verified: it reads
// "GET /api/arrivals/{stationId}"), and it would adapt automatically as routes
// are added, where this allowlist silently buckets anything new into "other".
// Worth revisiting — deliberately not changed alongside a build fix.
func routeLabel(path string) string {
	switch {
	case path == "/health":
		return "/health"
	case path == "/api/vehicles":
		return "/api/vehicles"
	case path == "/api/alerts":
		return "/api/alerts"
	case path == "/api/alerts/summary":
		return "/api/alerts/summary"
	case strings.HasPrefix(path, "/api/arrivals/"):
		return "/api/arrivals/{stationId}"
	case strings.HasPrefix(path, "/api/gtfs/"):
		return "/api/gtfs/{file}"
	default:
		return "other"
	}
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

		route := routeLabel(r.URL.Path)
		metricHTTPDuration.WithLabelValues(route, r.Method).Observe(time.Since(start).Seconds())
		metricHTTPRequests.WithLabelValues(route, r.Method, strconv.Itoa(rec.status)).Inc()
	})
}
