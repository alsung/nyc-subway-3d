package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
)

type healthResponse struct {
	Status      string `json:"status"`
	FeedsLoaded int    `json:"feedsLoaded"`
	LastRefresh string `json:"lastRefresh"`
}

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
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(healthResponse{
		Status:      "ok",
		FeedsLoaded: 0,
		LastRefresh: "",
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
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func handleVehicles(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func newMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /api/gtfs/{file}", handleGTFSFile)
	mux.HandleFunc("GET /api/arrivals/{stationId}", handleArrivals)
	mux.HandleFunc("GET /api/vehicles", handleVehicles)
	return corsMiddleware(mux)
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

	slog.Info("server starting", "port", port)
	if err := http.ListenAndServe(":"+port, newMux()); err != nil {
		slog.Error("server error", "err", err)
		os.Exit(1)
	}
}
