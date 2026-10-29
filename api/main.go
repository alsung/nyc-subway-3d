package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/time/rate"
)

const maxFeedAge = 3 * time.Minute

type healthResponse struct {
	Status      string  `json:"status"`
	FeedsLoaded int     `json:"feedsLoaded"`
	FeedAgeSec  float64 `json:"feedAgeSec"`
	LastRefresh string  `json:"lastRefresh"`
	// AlertsLoaded is the cached alert count; AlertsLabeled is how many of
	// those carry a readable Mercury label. The two should track each other
	// closely — a gap means MTA's extension shape changed and the UI has
	// quietly fallen back to generic labels.
	AlertsLoaded  int     `json:"alertsLoaded"`
	AlertsLabeled int     `json:"alertsLabeled"`
	Database      *string `json:"database,omitempty"`
}

// app holds shared dependencies that handlers need beyond the in-memory feed
// cache. Fields may be nil when the dependency is unavailable (e.g. no
// DATABASE_URL set).
type app struct {
	dbPool         *pgxpool.Pool
	googleClientID string
	adminEmails    []string
	commutes       CommuteStore
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
		origin := r.Header.Get("Origin")
		if origin == "https://localexpress.nyc" ||
			strings.HasPrefix(origin, "http://localhost:") ||
			strings.HasSuffix(origin, ".vercel.app") {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) handleHealth(w http.ResponseWriter, r *http.Request) {
	feedsMu.RLock()
	loaded := len(feedCache)
	last := lastRefresh
	feedsMu.RUnlock()

	lastStr := ""
	var ageSec float64 = -1
	if !last.IsZero() {
		lastStr = last.UTC().Format(time.RFC3339)
		ageSec = time.Since(last).Seconds()
	}

	status := "ok"
	code := http.StatusOK
	if last.IsZero() || time.Since(last) > maxFeedAge || loaded == 0 {
		status = "degraded"
		code = http.StatusServiceUnavailable
	}

	labeled, alertTotal := extensionHealth()

	resp := healthResponse{
		Status:        status,
		FeedsLoaded:   loaded,
		FeedAgeSec:    ageSec,
		LastRefresh:   lastStr,
		AlertsLoaded:  alertTotal,
		AlertsLabeled: labeled,
	}

	if a.dbPool != nil {
		dbStatus := "ok"
		if !pingDB(r.Context(), a.dbPool) {
			dbStatus = "unreachable"
			status = "degraded"
			code = http.StatusServiceUnavailable
		}
		resp.Database = &dbStatus
		resp.Status = status
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(resp)
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

// purgeExpired hard-deletes accounts soft-deleted more than 30 days ago, then
// expired tokens on live accounts. Users go first because the delete cascades
// to their tokens.
func purgeExpired(ctx context.Context, pool *pgxpool.Pool) error {
	steps := []struct{ table, sql string }{
		{"users", `DELETE FROM users WHERE deleted_at < now() - interval '30 days'`},
		{"refresh_tokens", `DELETE FROM refresh_tokens WHERE expires_at < now()`},
		{"verification_tokens", `DELETE FROM verification_tokens WHERE expires_at < now()`},
	}
	for _, s := range steps {
		tag, err := pool.Exec(ctx, s.sql)
		if err != nil {
			return fmt.Errorf("purge %s: %w", s.table, err)
		}
		if n := tag.RowsAffected(); n > 0 {
			slog.Info("purge", "table", s.table, "deleted", n)
		}
	}
	metricPurgeLastSuccess.SetToCurrentTime()
	return nil
}

// startAccountCleanup purges at boot and then hourly. A daily ticker almost
// never fired, because every push to master redeploys and resets it.
func startAccountCleanup(ctx context.Context, pool *pgxpool.Pool) {
	if err := purgeExpired(ctx, pool); err != nil {
		slog.Error("purge failed", "err", err)
	}
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := purgeExpired(ctx, pool); err != nil {
				slog.Error("purge failed", "err", err)
			}
		}
	}
}

func newMux(a *app) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.handleHealth)
	mux.HandleFunc("GET /api/gtfs/{file}", handleGTFSFile)
	mux.HandleFunc("GET /api/arrivals/{stationId}", handleArrivals)
	mux.HandleFunc("GET /api/vehicles", handleVehicles)
	mux.HandleFunc("GET /api/alerts", handleAlerts)
	mux.HandleFunc("GET /api/alerts/summary", handleAlertsSummary)
	if a.dbPool != nil {
		mux.Handle("GET /api/plan",
			optionalAuth(a.requireFeature("trip_planner")(http.HandlerFunc(handlePlan))))
	} else {
		mux.HandleFunc("GET /api/plan", handlePlan)
	}

	if a.dbPool != nil {
		// Routes that check a password or send an email get a much tighter
		// per-IP limit than the global one: 10 a minute, burst 5. Each route
		// has its own bucket, so failed logins don't block a password reset.
		// It wraps requireAuth too, so it runs before token checks and bcrypt.
		passwordLimit := func(name string) func(http.Handler) http.Handler {
			return rateLimitMiddleware(newIPRateLimiter(name, rate.Every(6*time.Second), 5))
		}

		mux.Handle("POST /api/auth/register", passwordLimit("register")(http.HandlerFunc(a.handleRegister)))
		mux.Handle("POST /api/auth/login", passwordLimit("login")(http.HandlerFunc(a.handleLogin)))
		mux.HandleFunc("POST /api/auth/refresh", a.handleRefresh)
		mux.HandleFunc("POST /api/auth/logout", a.handleLogout)
		mux.Handle("GET /api/auth/me", requireAuth(http.HandlerFunc(a.handleMe)))
		mux.HandleFunc("POST /api/auth/verify-email", a.handleVerifyEmail)
		mux.Handle("POST /api/auth/resend-verification", passwordLimit("resend-verification")(http.HandlerFunc(a.handleResendVerification)))
		mux.Handle("POST /api/auth/forgot-password", passwordLimit("forgot-password")(http.HandlerFunc(a.handleForgotPassword)))
		mux.Handle("POST /api/auth/reset-password", passwordLimit("reset-password")(http.HandlerFunc(a.handleResetPassword)))
		mux.Handle("PATCH /api/auth/account", requireAuth(http.HandlerFunc(a.handleUpdateAccount)))
		mux.Handle("DELETE /api/auth/account", requireAuth(http.HandlerFunc(a.handleDeleteAccount)))
		mux.Handle("POST /api/auth/change-password",
			passwordLimit("change-password")(requireAuth(http.HandlerFunc(a.handleChangePassword))))
		mux.Handle("GET /api/features", optionalAuth(http.HandlerFunc(a.handleGetFeatures)))
		mux.Handle("PUT /api/features/{name}", requireAuth(http.HandlerFunc(a.handleUpdateFeature)))

		mux.Handle("GET /api/commutes",
			requireAuth(a.requireFeature("saved_commutes")(http.HandlerFunc(a.handleListCommutes))))
		mux.Handle("POST /api/commutes",
			requireAuth(a.requireFeature("saved_commutes")(http.HandlerFunc(a.handleCreateCommute))))
		mux.Handle("PATCH /api/commutes/{id}",
			requireAuth(http.HandlerFunc(a.handleUpdateCommute)))
		mux.Handle("DELETE /api/commutes/{id}",
			requireAuth(http.HandlerFunc(a.handleDeleteCommute)))

		if a.googleClientID != "" {
			mux.HandleFunc("POST /api/auth/google", a.handleGoogleAuth)
		}
	}

	// /metrics is mounted outside both gzipMiddleware and metricsMiddleware.
	// promhttp negotiates its own content encoding, so wrapping it in ours
	// would double-encode and break scraping with no visible error; and Fly
	// scrapes every few seconds, which would otherwise swamp the request
	// counter with traffic nobody made.
	//
	// corsMiddleware runs before the rate limiter so a 429 still carries
	// Access-Control-Allow-Origin; without it the browser can't read the
	// error and the app reports a network failure.
	rl := newIPRateLimiter("global", 10, 30)
	root := http.NewServeMux()
	root.Handle("GET /metrics", promhttp.Handler())
	root.Handle("/", metricsMiddleware(corsMiddleware(rateLimitMiddleware(rl)(gzipMiddleware(mux)))))
	return root
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

	// Before the refreshers start, so every feed counter exists at zero rather
	// than appearing for the first time during the outage it should have warned
	// about.
	initFeedMetrics()

	initJWT(os.Getenv("JWT_SECRET"))
	initEmail(
		os.Getenv("RESEND_API_KEY"),
		os.Getenv("APP_BASE_URL"),
		os.Getenv("DEV_AUTO_VERIFY") == "true",
	)

	a := &app{}

	if raw := os.Getenv("ADMIN_EMAILS"); raw != "" {
		for _, e := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(e); trimmed != "" {
				a.adminEmails = append(a.adminEmails, trimmed)
			}
		}
	}

	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		if err := runMigrations(dbURL); err != nil {
			slog.Error("failed to run migrations", "err", err)
			os.Exit(1)
		}

		pool, err := connectDB(context.Background(), dbURL)
		if err != nil {
			slog.Error("failed to connect to database", "err", err)
			os.Exit(1)
		}
		defer pool.Close()
		a.dbPool = pool
		a.commutes = newPGStore(pool)
		slog.Info("database connected")

		if err := loadFeatures(context.Background(), pool); err != nil {
			slog.Error("failed to load feature flags", "err", err)
			os.Exit(1)
		}
		slog.Info("feature flags loaded")

		if gid := os.Getenv("GOOGLE_CLIENT_ID"); gid != "" {
			a.googleClientID = gid
			slog.Info("google oauth enabled")
		}
	} else {
		slog.Warn("DATABASE_URL not set, running without database (auth endpoints will be unavailable)")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go startFeedRefresher(ctx)
	// Separate goroutine and interval: alerts change far less often than train
	// positions, and a slow alerts fetch must not delay a vehicle refresh.
	go startAlertsRefresher(ctx)
	if a.dbPool != nil {
		go startFeatureCacheRefresher(ctx, a.dbPool)
		go startAccountCleanup(ctx, a.dbPool)
	}

	slog.Info("server starting", "port", port)
	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      newMux(a),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
}
