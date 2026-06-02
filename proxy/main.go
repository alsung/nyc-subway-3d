// proxy/main.go
// CORS proxy for MTA public feeds. Restricts outbound requests to a domain
// allowlist, caches responses with a 30-second TTL, and logs every request
// as structured JSON via log/slog.

package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// allowedHosts is the set of domains the proxy will forward requests to.
// All other target URLs are rejected with 403.
var allowedHosts = map[string]bool{
	"api-endpoint.mta.info":          true,
	"rrgtfsfeeds.s3.amazonaws.com":   true,
}

const cacheTTL = 30 * time.Second

type cacheEntry struct {
	body      []byte
	fetchedAt time.Time
}

type cache struct {
	mu      sync.RWMutex
	entries map[string]cacheEntry
}

func newCache() *cache {
	return &cache{entries: make(map[string]cacheEntry)}
}

func (c *cache) get(key string) ([]byte, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	if !ok || time.Since(e.fetchedAt) > cacheTTL {
		return nil, false
	}
	return e.body, true
}

func (c *cache) set(key string, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = cacheEntry{body: body, fetchedAt: time.Now()}
}

// isAllowed returns true when targetURL's host is in the allowlist.
func isAllowed(targetURL string) bool {
	u, err := url.Parse(targetURL)
	if err != nil || u.Host == "" {
		return false
	}
	return allowedHosts[u.Host]
}

func corsHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func makeProxyHandler(c *cache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		corsHeaders(w)

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		targetURL := r.URL.Query().Get("url")
		if targetURL == "" {
			http.Error(w, "missing url parameter", http.StatusBadRequest)
			return
		}

		if !isAllowed(targetURL) {
			slog.Warn("blocked request", "url", targetURL)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		if body, ok := c.get(targetURL); ok {
			w.Header().Set("X-Cache", "HIT")
			w.Header().Set("Content-Type", "application/x-protobuf")
			w.Write(body)
			slog.Info("cache hit", "url", targetURL)
			return
		}

		resp, err := http.Get(targetURL)
		if err != nil {
			slog.Error("upstream fetch failed", "url", targetURL, "err", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			slog.Error("body read failed", "url", targetURL, "err", err)
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}

		c.set(targetURL, body)

		w.Header().Set("X-Cache", "MISS")
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.Write(body)
		slog.Info("cache miss", "url", targetURL, "bytes", len(body))
	}
}

func makeHealthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	}
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	c := newCache()

	mux := http.NewServeMux()
	mux.HandleFunc("/proxy", makeProxyHandler(c))
	mux.HandleFunc("/health", makeHealthHandler())

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	go func() {
		slog.Info("proxy listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	slog.Info("shutting down")
	srv.Shutdown(ctx)
}
