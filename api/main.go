package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"
)

type healthResponse struct {
	Status       string `json:"status"`
	FeedsLoaded  int    `json:"feedsLoaded"`
	LastRefresh  string `json:"lastRefresh"`
	AlertsLoaded int    `json:"alertsLoaded"`
}

// gzipMiddleware compresses responses for clients that accept it. Added for the
// alerts endpoints: the upstream feed is ~520 KB and the flattened JSON is the
// largest thing this server returns by an order of magnitude.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		// Length applies to the uncompressed body; leaving it would be wrong.
		w.Header().Del("Content-Length")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		next.ServeHTTP(gzipResponseWriter{Writer: gz, ResponseWriter: w}, r)
	})
}

type gzipResponseWriter struct {
	io.Writer
	http.ResponseWriter
}

func (w gzipResponseWriter) Write(b []byte) (int, error) { return w.Writer.Write(b) }

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	feedsMu.RLock()
	loaded := len(feedCache)
	last := lastRefresh
	feedsMu.RUnlock()

	lastStr := ""
	if !last.IsZero() {
		lastStr = last.UTC().Format(time.RFC3339)
	}

	alertsMsg, _ := cachedAlerts()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(healthResponse{
		Status:       "ok",
		FeedsLoaded:  loaded,
		LastRefresh:  lastStr,
		AlertsLoaded: len(alertsMsg.GetEntity()),
	})
}

// handleAlerts returns alerts currently in effect. Upcoming planned work — the
// large majority of the feed — is only included with ?upcoming=true, so the
// default response stays small enough for station badges and popups.
func handleAlerts(w http.ResponseWriter, r *http.Request) {
	msg, updated := cachedAlerts()
	all := parseAlerts(msg, time.Now())

	includeUpcoming := r.URL.Query().Get("upcoming") == "true"
	alerts := make([]Alert, 0, len(all))
	for _, a := range all {
		if a.Surfaced || includeUpcoming {
			alerts = append(alerts, a)
		}
	}

	updatedAt := ""
	if !updated.IsZero() {
		updatedAt = updated.UTC().Format(time.RFC3339)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(alertsResponse{Alerts: alerts, UpdatedAt: updatedAt})
}

// handleAlertsSummary returns the per-trunk rollup behind the status list, so
// that view renders without downloading every alert.
func handleAlertsSummary(w http.ResponseWriter, r *http.Request) {
	msg, updated := cachedAlerts()
	trunks, upcoming := summarise(parseAlerts(msg, time.Now()))

	updatedAt := ""
	if !updated.IsZero() {
		updatedAt = updated.UTC().Format(time.RFC3339)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(summaryResponse{
		Trunks:    trunks,
		UpdatedAt: updatedAt,
		Upcoming:  upcoming,
	})
}

func handleGTFSFile(w http.ResponseWriter, r *http.Request) {
	file := r.PathValue("file")
	gtfsMu.RLock()
	data, ok := gtfsFiles[file]
	gtfsMu.RUnlock()
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(data)
}

func handleArrivals(w http.ResponseWriter, r *http.Request) {
	stationID := r.PathValue("stationId")

	feeds, updated := cachedFeeds()
	index := buildArrivalIndex(feeds, time.Now())

	arrivals := index[stationID]
	if arrivals == nil {
		arrivals = []Arrival{}
	}

	updatedAt := ""
	if !updated.IsZero() {
		updatedAt = updated.UTC().Format(time.RFC3339)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(arrivalsResponse{
		StationID: stationID,
		Arrivals:  arrivals,
		UpdatedAt: updatedAt,
	})
}

func handleVehicles(w http.ResponseWriter, r *http.Request) {
	feeds, updated := cachedFeeds()
	vehicles := parseVehiclePositions(feeds)

	updatedAt := ""
	if !updated.IsZero() {
		updatedAt = updated.UTC().Format(time.RFC3339)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(vehiclesResponse{
		Vehicles:  vehicles,
		UpdatedAt: updatedAt,
	})
}

func newMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /api/gtfs/{file}", handleGTFSFile)
	mux.HandleFunc("GET /api/arrivals/{stationId}", handleArrivals)
	mux.HandleFunc("GET /api/vehicles", handleVehicles)
	mux.HandleFunc("GET /api/alerts", handleAlerts)
	mux.HandleFunc("GET /api/alerts/summary", handleAlertsSummary)
	return corsMiddleware(gzipMiddleware(mux))
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if err := loadGTFSStatic(); err != nil {
		slog.Error("failed to load gtfs static data", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go startFeedRefresher(ctx)
	// Separate goroutine and interval: alerts change far less often than train
	// positions, and a slow alerts fetch must not delay a vehicle refresh.
	go startAlertsRefresher(ctx)

	slog.Info("server starting", "port", port)
	if err := http.ListenAndServe(":"+port, newMux()); err != nil {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
}
