package main

import (
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

// Invariants of MTA's real-time feed that this service now depends on.
//
// The static feed got the same treatment in feed_invariants_test.go: assumptions
// that hold today and are checked weekly, so the day MTA changes something we
// find out from a CI issue rather than from a map full of trains parked at
// stations.
//
// The dependency being guarded here is new. VehicleStop carries predicted
// arrival and departure times because those are the only thing in the feed that
// says where a train is between two stations — current_status is absent on 45%
// of vehicles and reports STOPPED_AT on nearly all the rest. If the times ever
// stop arriving, position derivation silently degrades to "every train is at a
// station" and nothing else in the suite notices.
//
// Hits the network, so it is gated separately from the GTFS_DIR tests:
//
//	RT_LIVE=1 go test -count=1 -run TestRTFeed -v ./api
func liveFeeds(t *testing.T) []*gtfs.FeedMessage {
	t.Helper()
	if os.Getenv("RT_LIVE") == "" {
		t.Skip("set RT_LIVE=1 to run this against MTA's live feeds")
	}

	// Two of the eight, not all of them: enough to catch a feed-wide change
	// without eight requests every run.
	names := []string{"1234567S", "ACE"}
	client := &http.Client{Timeout: 30 * time.Second}
	out := make([]*gtfs.FeedMessage, 0, len(names))

	for _, name := range names {
		url, ok := feedURLs[name]
		if !ok {
			t.Fatalf("no feed URL named %q", name)
		}
		resp, err := client.Get(url)
		if err != nil {
			t.Fatalf("fetch %s: %v", name, err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s -> HTTP %d", name, resp.StatusCode)
		}
		msg := &gtfs.FeedMessage{}
		if err := proto.Unmarshal(body, msg); err != nil {
			t.Fatalf("unmarshal %s: %v", name, err)
		}
		out = append(out, msg)
	}
	return out
}

// The feed still predicts arrival times for the stops it publishes.
//
// Thresholded well below what is actually observed — 99% of stop-time updates
// carry an arrival and 98% a departure — so ordinary variation does not open an
// issue every week. Anything near or below 90% is a real change in what MTA
// publishes.
func TestRTFeedStillCarriesStopTimes(t *testing.T) {
	const minCoverage = 0.90

	var stus, withArrival, withDeparture int
	for _, feed := range liveFeeds(t) {
		for _, entity := range feed.Entity {
			tu := entity.TripUpdate
			if tu == nil {
				continue
			}
			for _, stu := range tu.StopTimeUpdate {
				stus++
				if stu.GetArrival().GetTime() != 0 {
					withArrival++
				}
				if stu.GetDeparture().GetTime() != 0 {
					withDeparture++
				}
			}
		}
	}

	if stus == 0 {
		t.Fatal("no stop-time updates in the live feed at all")
	}

	arrivalRate := float64(withArrival) / float64(stus)
	departureRate := float64(withDeparture) / float64(stus)
	t.Logf("%d stop-time updates: %.0f%% carry an arrival, %.0f%% a departure",
		stus, 100*arrivalRate, 100*departureRate)

	if arrivalRate < minCoverage {
		t.Errorf("arrival times on %.0f%% of stop-time updates, want >= %.0f%% — "+
			"train positions depend on these", 100*arrivalRate, 100*minCoverage)
	}
	if departureRate < minCoverage {
		t.Errorf("departure times on %.0f%% of stop-time updates, want >= %.0f%% — "+
			"without them a train cannot be held at a platform for its dwell",
			100*departureRate, 100*minCoverage)
	}
}

// The feed still publishes vehicles, and parseVehiclePositions still gets times
// onto the ones it can. Guards the join between the TripUpdate and
// VehiclePosition entities, which is where a trip-id format change would show
// up first.
//
// The rate is measured over vehicles that *have* a stop sequence, not over all
// of them. About 10% of vehicles arrive with no matching TripUpdate entity at
// all — measured twice, twenty seconds apart: 10 of 103 and 10 of 102 — and a
// vehicle with no sequence says nothing about whether times are still being
// published. Counting those in the denominator pins the rate at ~90.2%, right
// on top of a 90% threshold, which is a weekly coin flip rather than a test.
// Measured over vehicles that carry a sequence, the rate is 100%.
func TestRTFeedVehiclesCarryTimes(t *testing.T) {
	const minCoverage = 0.95

	vehicles := parseVehiclePositions(liveFeeds(t))
	if len(vehicles) == 0 {
		t.Fatal("no vehicles parsed from the live feed")
	}

	withSequence, withTimedStop := 0, 0
	for _, v := range vehicles {
		if len(v.StopTimeUpdate) == 0 {
			continue
		}
		withSequence++
		for _, s := range v.StopTimeUpdate {
			if s.Arrival != 0 || s.Departure != 0 {
				withTimedStop++
				break
			}
		}
	}

	if withSequence == 0 {
		t.Fatal("no vehicle carried a stop sequence — the TripUpdate/VehiclePosition join by trip id has broken")
	}

	rate := float64(withTimedStop) / float64(withSequence)
	t.Logf("%d vehicles, %d carry a stop sequence, %.0f%% of those carry a timed stop",
		len(vehicles), withSequence, 100*rate)

	if rate < minCoverage {
		t.Errorf("only %.0f%% of vehicles with a stop sequence carry a timed stop, want >= %.0f%%",
			100*rate, 100*minCoverage)
	}
}
