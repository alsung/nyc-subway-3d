package main

import (
	"container/list"
	"fmt"
	"math"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"golang.org/x/time/rate"
)

var metricRateLimited = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "rate_limited_total",
	Help: "Requests rejected by a per-IP rate limiter.",
}, []string{"limiter"})

type ipEntry struct {
	ip       string
	limiter  *rate.Limiter
	lastSeen time.Time
	elem     *list.Element
}

const maxLimiterEntries = 10_000

// ipRateLimiter keeps one token bucket per client IP. order runs from most to
// least recently seen, so a full table evicts its stalest IP in constant time
// instead of turning new IPs away.
type ipRateLimiter struct {
	name    string
	mu      sync.Mutex
	entries map[string]*ipEntry
	order   *list.List
	r       rate.Limit
	burst   int
}

func newIPRateLimiter(name string, r rate.Limit, burst int) *ipRateLimiter {
	rl := &ipRateLimiter{
		name:    name,
		entries: make(map[string]*ipEntry),
		order:   list.New(),
		r:       r,
		burst:   burst,
	}
	go rl.cleanup()
	return rl
}

func (l *ipRateLimiter) get(ip string) *rate.Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if e, ok := l.entries[ip]; ok {
		e.lastSeen = now
		l.order.MoveToFront(e.elem)
		return e.limiter
	}
	if len(l.entries) >= maxLimiterEntries {
		oldest := l.order.Back()
		l.order.Remove(oldest)
		delete(l.entries, oldest.Value.(*ipEntry).ip)
	}
	e := &ipEntry{ip: ip, limiter: rate.NewLimiter(l.r, l.burst), lastSeen: now}
	e.elem = l.order.PushFront(e)
	l.entries[ip] = e
	return e.limiter
}

func (l *ipRateLimiter) cleanup() {
	for {
		time.Sleep(5 * time.Minute)
		l.mu.Lock()
		// The back of the list is the least recently seen, so stop at the
		// first entry that is still fresh.
		for el := l.order.Back(); el != nil; el = l.order.Back() {
			e := el.Value.(*ipEntry)
			if time.Since(e.lastSeen) <= 5*time.Minute {
				break
			}
			l.order.Remove(el)
			delete(l.entries, e.ip)
		}
		l.mu.Unlock()
	}
}

// clientIP extracts the caller's IP. Fly's proxy sets Fly-Client-IP on every
// request and overwrites any value the client sent, so it can't be forged.
// X-Forwarded-For is not read: its first entry comes from the client, and a
// new value per request would give an attacker a fresh bucket every time.
// RemoteAddr covers local development and tests.
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("Fly-Client-IP"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimitMiddleware answers 429 with a JSON error, the same shape as the
// handlers' errors, so the auth modals can show it.
func rateLimitMiddleware(limiter *ipRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			res := limiter.get(clientIP(r)).Reserve()
			if wait := res.Delay(); wait > 0 {
				// Give the token back; a rejected request shouldn't push the
				// caller's next allowed request further out.
				res.Cancel()
				metricRateLimited.WithLabelValues(limiter.name).Inc()
				secs := int(math.Ceil(wait.Seconds()))
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				fmt.Fprintf(w, `{"error":"Too many attempts. Try again in %d seconds."}`, secs)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
