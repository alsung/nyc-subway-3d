package main

import (
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"golang.org/x/time/rate"
)

var metricRateLimited = promauto.NewCounter(prometheus.CounterOpts{
	Name: "rate_limited_total",
	Help: "Requests rejected by the per-IP rate limiter.",
})

type ipEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

const maxLimiterEntries = 10_000

type ipRateLimiter struct {
	mu      sync.Mutex
	entries map[string]*ipEntry
	r       rate.Limit
	burst   int
}

func newIPRateLimiter(r rate.Limit, burst int) *ipRateLimiter {
	rl := &ipRateLimiter{
		entries: make(map[string]*ipEntry),
		r:       r,
		burst:   burst,
	}
	go rl.cleanup()
	return rl
}

func (l *ipRateLimiter) get(ip string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[ip]
	if ok {
		e.lastSeen = time.Now()
		return e.limiter
	}
	if len(l.entries) >= maxLimiterEntries {
		return nil
	}
	e = &ipEntry{limiter: rate.NewLimiter(l.r, l.burst), lastSeen: time.Now()}
	l.entries[ip] = e
	return e.limiter
}

func (l *ipRateLimiter) cleanup() {
	for {
		time.Sleep(5 * time.Minute)
		l.mu.Lock()
		for ip, e := range l.entries {
			if time.Since(e.lastSeen) > 5*time.Minute {
				delete(l.entries, ip)
			}
		}
		l.mu.Unlock()
	}
}

// clientIP extracts the caller's IP. Fly.io sets X-Forwarded-For on every
// request; when present, the first entry is the original client. Falling back
// to RemoteAddr covers local development and direct connections.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := len(xff); i > 0 {
			for j := 0; j < len(xff); j++ {
				if xff[j] == ',' {
					return xff[:j]
				}
			}
			return xff
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func rateLimitMiddleware(limiter *ipRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r)
			lim := limiter.get(ip)
			if lim == nil || !lim.Allow() {
				metricRateLimited.Inc()
				w.Header().Set("Retry-After", "1")
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
