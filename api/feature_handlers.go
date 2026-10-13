package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type feature struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	RequiredTier string `json:"requiredTier"`
}

type featureView struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	RequiredTier string `json:"requiredTier"`
	Accessible   bool   `json:"accessible"`
}

type featureCache struct {
	mu       sync.RWMutex
	features []feature
	byName   map[string]feature
}

var fc featureCache

func loadFeatures(ctx context.Context, pool *pgxpool.Pool) error {
	rows, err := pool.Query(ctx,
		`SELECT name, required_tier, description FROM features ORDER BY name`)
	if err != nil {
		return err
	}
	defer rows.Close()

	var features []feature
	byName := make(map[string]feature)
	for rows.Next() {
		var f feature
		if err := rows.Scan(&f.Name, &f.RequiredTier, &f.Description); err != nil {
			return err
		}
		features = append(features, f)
		byName[f.Name] = f
	}

	fc.mu.Lock()
	fc.features = features
	fc.byName = byName
	fc.mu.Unlock()
	return nil
}

func startFeatureCacheRefresher(ctx context.Context, pool *pgxpool.Pool) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := loadFeatures(ctx, pool); err != nil {
				slog.Error("feature cache refresh failed", "err", err)
			}
		}
	}
}

func featureAccessible(f feature, user *authedUser) bool {
	switch f.RequiredTier {
	case "everyone":
		return true
	case "disabled":
		return false
	case "pro":
		return user != nil && user.Tier == "pro"
	default:
		return false
	}
}

func (a *app) handleGetFeatures(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	fc.mu.RLock()
	features := fc.features
	fc.mu.RUnlock()

	views := make([]featureView, len(features))
	for i, f := range features {
		views[i] = featureView{
			Name:         f.Name,
			Description:  f.Description,
			RequiredTier: f.RequiredTier,
			Accessible:   featureAccessible(f, user),
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"features": views})
}

type updateFeatureRequest struct {
	RequiredTier string `json:"requiredTier"`
}

func (a *app) handleUpdateFeature(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	if !a.isAdmin(user.Email) {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	name := r.PathValue("name")

	var req updateFeatureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.RequiredTier != "everyone" && req.RequiredTier != "pro" && req.RequiredTier != "disabled" {
		http.Error(w, `{"error":"requiredTier must be everyone, pro, or disabled"}`, http.StatusBadRequest)
		return
	}

	var f feature
	err := a.dbPool.QueryRow(r.Context(),
		`UPDATE features SET required_tier = $1 WHERE name = $2
		 RETURNING name, required_tier, description`,
		req.RequiredTier, name,
	).Scan(&f.Name, &f.RequiredTier, &f.Description)

	if err != nil {
		http.Error(w, `{"error":"feature not found"}`, http.StatusNotFound)
		return
	}

	if err := loadFeatures(r.Context(), a.dbPool); err != nil {
		slog.Error("feature cache reload failed after update", "err", err)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(f)
}

func (a *app) requireFeature(name string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fc.mu.RLock()
			f, ok := fc.byName[name]
			fc.mu.RUnlock()

			if !ok {
				next.ServeHTTP(w, r)
				return
			}

			user := userFromContext(r.Context())
			w.Header().Set("Content-Type", "application/json")

			switch f.RequiredTier {
			case "everyone":
				next.ServeHTTP(w, r)
			case "disabled":
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]any{"error": "feature unavailable"})
			case "pro":
				if user == nil {
					w.WriteHeader(http.StatusUnauthorized)
					json.NewEncoder(w).Encode(map[string]any{
						"error":   "sign in required",
						"upgrade": true,
					})
					return
				}
				if user.Tier != "pro" {
					w.WriteHeader(http.StatusForbidden)
					json.NewEncoder(w).Encode(map[string]any{
						"error":   "pro feature",
						"upgrade": true,
						"feature": name,
					})
					return
				}
				next.ServeHTTP(w, r)
			}
		})
	}
}

func (a *app) isAdmin(email string) bool {
	for _, e := range a.adminEmails {
		if strings.EqualFold(e, email) {
			return true
		}
	}
	return false
}
