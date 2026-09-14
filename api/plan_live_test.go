package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// TestPlanEndpointLive exercises /api/plan against the real timetable and the
// live GTFS-RT feeds. Skipped unless GTFS_DIR points at an extracted feed.
//
//	unzip gtfs_subway.zip -d /tmp/gtfs && GTFS_DIR=/tmp/gtfs go test -run Live -v ./api
func TestPlanEndpointLive(t *testing.T) {
	dir := os.Getenv("GTFS_DIR")
	if dir == "" {
		t.Skip("set GTFS_DIR to an extracted GTFS feed to run this")
	}
	read := func(name string) []byte {
		b, err := os.ReadFile(dir + "/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return b
	}
	tt, err := BuildTimetable(read("stop_times.txt"), read("trips.txt"),
		read("transfers.txt"), read("calendar.txt"), read("calendar_dates.txt"))
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	gtfsMu.Lock()
	prevTT := timetable
	timetable = tt
	gtfsMu.Unlock()
	defer func() {
		gtfsMu.Lock()
		timetable = prevTT
		gtfsMu.Unlock()
	}()

	// Pull the live feeds and build the departure index the way the refresher
	// does, so the endpoint sees real predictions.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	refreshFeeds(ctx)

	rt := cachedDepartures()
	if rt == nil {
		t.Fatal("no departure index after refresh")
	}
	t.Logf("departure index covers %d platforms", rt.StopCount())

	cases := []struct{ name, from, to string }{
		{"Times Sq to Grand Central", "127", "631"},
		{"96 St to Union Sq", "120", "635"},
		{"Bedford Av to Times Sq", "L08", "127"},
		{"Jackson Hts to Atlantic Av", "G14", "617"},
	}

	realtimeLegs, totalLegs := 0, 0
	for _, c := range cases {
		start := time.Now()
		req := httptest.NewRequest(http.MethodGet, "/api/plan?from="+c.from+"&to="+c.to, nil)
		rec := httptest.NewRecorder()
		handlePlan(rec, req)
		elapsed := time.Since(start)

		if rec.Code != http.StatusOK {
			t.Errorf("%s: expected 200, got %d — %s", c.name, rec.Code, rec.Body.String())
			continue
		}
		var body planResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: decode: %v", c.name, err)
		}
		if len(body.Journeys) == 0 {
			t.Errorf("%s: no journeys", c.name)
			continue
		}
		j := body.Journeys[len(body.Journeys)-1]

		var routes []string
		for _, l := range j.Legs {
			totalLegs++
			if l.Timing == "realtime" {
				realtimeLegs++
			}
			if l.Kind == "ride" {
				routes = append(routes, l.RouteID)
			}
		}
		t.Logf("%-28s %3d min, %d transfers, via %v  (%v, feed %ds old)",
			c.name, j.Minutes, j.Transfers, routes, elapsed.Round(time.Microsecond), body.FeedAgeSeconds)

		if j.Minutes <= 0 || j.Minutes > 180 {
			t.Errorf("%s: %d minutes is not plausible", c.name, j.Minutes)
		}
		if body.FeedAgeSeconds < 0 {
			t.Errorf("%s: expected realtime to be available", c.name)
		}
	}
	t.Logf("legs using live predictions: %d of %d", realtimeLegs, totalLegs)
}
