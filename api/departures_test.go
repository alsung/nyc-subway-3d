package main

import (
	"testing"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

// feedWithDeparture builds a one-update feed predicting `route` leaving `stop`
// at the given instant.
func feedWithDeparture(route, stop string, at time.Time) *gtfs.FeedMessage {
	epoch := at.Unix()
	return &gtfs.FeedMessage{
		Entity: []*gtfs.FeedEntity{{
			Id: proto.String("e1"),
			TripUpdate: &gtfs.TripUpdate{
				Trip: &gtfs.TripDescriptor{RouteId: proto.String(route)},
				StopTimeUpdate: []*gtfs.TripUpdate_StopTimeUpdate{{
					StopId:    proto.String(stop),
					Departure: &gtfs.TripUpdate_StopTimeEvent{Time: proto.Int64(epoch)},
				}},
			},
		}},
	}
}

func TestDepartureIndexUsesTheFeedsMidnight(t *testing.T) {
	// The index expresses predictions as seconds from the start of the service
	// day, and the timetable's scheduled times mean the same thing. If the two
	// disagree about which midnight, every delay comes out hours wide, every
	// shift is discarded as implausible, and the realtime overlay silently does
	// nothing — which is exactly what shipped.
	ny := feedLocation()
	depart := time.Date(2026, 9, 14, 13, 30, 0, 0, ny) // 13:30 in New York
	want := int32(13*3600 + 30*60)

	feeds := []*gtfs.FeedMessage{feedWithDeparture("7", "725N", depart)}

	// The same instant, observed by a server in each zone. Both must agree.
	for _, now := range []time.Time{
		depart.Add(-5 * time.Minute),       // a New York server
		depart.Add(-5 * time.Minute).UTC(), // Fly
	} {
		idx := buildDepartureIndex(feeds, now)
		got, ok := idx.NextDeparture("725N", "7", 0)
		if !ok {
			t.Fatalf("now=%v: no prediction indexed", now.Location())
		}
		if got != want {
			t.Errorf("now=%v: expected %d seconds (13:30 local), got %d — %d hours off",
				now.Location(), want, got, (got-want)/3600)
		}
	}
}

func TestDepartureIndexOrdersAndSearches(t *testing.T) {
	ny := feedLocation()
	base := time.Date(2026, 9, 14, 13, 0, 0, 0, ny)
	feeds := []*gtfs.FeedMessage{
		feedWithDeparture("7", "725N", base.Add(12*time.Minute)),
		feedWithDeparture("7", "725N", base.Add(4*time.Minute)),
		feedWithDeparture("7", "725N", base.Add(8*time.Minute)),
	}
	idx := buildDepartureIndex(feeds, base)

	got, ok := idx.NextDeparture("725N", "7", int32(13*3600+5*60))
	if !ok {
		t.Fatal("expected a prediction after 13:05")
	}
	if want := int32(13*3600 + 8*60); got != want {
		t.Errorf("expected the 13:08 departure, got %d", got)
	}
	if _, ok := idx.NextDeparture("725N", "7", int32(23*3600)); ok {
		t.Error("expected nothing after the last prediction")
	}
	if _, ok := idx.NextDeparture("999N", "7", 0); ok {
		t.Error("expected nothing for an unknown stop")
	}
	if _, ok := idx.NextDeparture("725N", "Z", 0); ok {
		t.Error("expected nothing for a route not at that stop")
	}
}

func TestDepartureIndexDropsPredictionsBeyondTheHorizon(t *testing.T) {
	ny := feedLocation()
	base := time.Date(2026, 9, 14, 13, 0, 0, 0, ny)
	feeds := []*gtfs.FeedMessage{
		feedWithDeparture("7", "725N", base.Add(10*time.Minute)),
		feedWithDeparture("7", "725N", base.Add(90*time.Minute)), // past the horizon
	}
	idx := buildDepartureIndex(feeds, base)
	if got, _ := idx.NextDeparture("725N", "7", 0); got != int32(13*3600+10*60) {
		t.Errorf("expected the 13:10 prediction, got %d", got)
	}
	if _, ok := idx.NextDeparture("725N", "7", int32(13*3600+20*60)); ok {
		t.Error("a prediction 90 minutes out should have been dropped")
	}
}

func TestDepartureIndexNilSafe(t *testing.T) {
	var idx *DepartureIndex
	if _, ok := idx.NextDeparture("725N", "7", 0); ok {
		t.Error("a nil index should report nothing")
	}
	if idx.StopCount() != 0 {
		t.Error("a nil index should have no stops")
	}
}
