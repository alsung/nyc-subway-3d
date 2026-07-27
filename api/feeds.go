package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

// feedURLs is one MTA GTFS-RT endpoint per subway line group. These mirror the
// set the frontend fetches in src/core/rt-loader.js. The MTA endpoints are
// public and no longer require an API key.
var feedURLs = map[string]string{
	"1234567S": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
	"ACE":      "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
	"BDFM":     "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
	"G":        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
	"JZ":       "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
	"NQRW":     "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
	"L":        "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
	"SIR":      "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
}

const feedRefreshInterval = 30 * time.Second

// feedEntry is one decoded feed plus the time it was last successfully fetched.
type feedEntry struct {
	msg       *gtfs.FeedMessage
	fetchedAt time.Time
}

var (
	feedsMu     sync.RWMutex
	feedCache   = map[string]feedEntry{}
	lastRefresh time.Time
)

var feedHTTPClient = &http.Client{Timeout: 20 * time.Second}

// decodeFeed unmarshals raw protobuf bytes into a FeedMessage. It is pure
// (no network, no globals) so it can be unit-tested directly.
//
// AllowPartial mirrors the frontend's protobufjs decode, which does not enforce
// proto required fields — so a feed that technically omits one still parses
// instead of dropping the whole batch.
func decodeFeed(raw []byte) (*gtfs.FeedMessage, error) {
	var m gtfs.FeedMessage
	if err := (proto.UnmarshalOptions{AllowPartial: true}).Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode feed: %w", err)
	}
	return &m, nil
}

// fetchFeed downloads and decodes a single GTFS-RT feed.
func fetchFeed(ctx context.Context, url string) (*gtfs.FeedMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := feedHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return decodeFeed(raw)
}

type feedResult struct {
	group string
	msg   *gtfs.FeedMessage
	err   error
}

// refreshFeeds fetches all feeds concurrently and updates the cache. Only feeds
// that succeed are written, so a transient single-feed failure leaves that
// line's last-known-good data in place rather than blanking it out.
func refreshFeeds(ctx context.Context) {
	results := make(chan feedResult, len(feedURLs))
	var wg sync.WaitGroup
	for group, url := range feedURLs {
		wg.Add(1)
		go func(group, url string) {
			defer wg.Done()
			msg, err := fetchFeed(ctx, url)
			results <- feedResult{group: group, msg: msg, err: err}
		}(group, url)
	}
	wg.Wait()
	close(results)

	now := time.Now()
	ok := 0
	feedsMu.Lock()
	for r := range results {
		if r.err != nil {
			slog.Warn("feed refresh failed", "group", r.group, "err", r.err)
			continue
		}
		feedCache[r.group] = feedEntry{msg: r.msg, fetchedAt: now}
		ok++
	}
	lastRefresh = now
	feedsMu.Unlock()

	slog.Info("feeds refreshed", "ok", ok, "total", len(feedURLs))
}

// cachedFeeds returns a snapshot of the currently cached decoded feeds plus the
// time of the last refresh, taken under a read lock. Callers own the returned
// slice.
func cachedFeeds() ([]*gtfs.FeedMessage, time.Time) {
	feedsMu.RLock()
	defer feedsMu.RUnlock()
	feeds := make([]*gtfs.FeedMessage, 0, len(feedCache))
	for _, e := range feedCache {
		feeds = append(feeds, e.msg)
	}
	return feeds, lastRefresh
}

// startFeedRefresher runs an initial refresh, then refreshes on a fixed interval
// until ctx is cancelled. Intended to run in its own goroutine.
func startFeedRefresher(ctx context.Context) {
	refreshFeeds(ctx)

	ticker := time.NewTicker(feedRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("feed refresher stopped")
			return
		case <-ticker.C:
			refreshFeeds(ctx)
		}
	}
}
