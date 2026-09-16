package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

func statusPtr(s int32) *int32 { return &s }

// tripStop describes one stop-time update to build. A zero arrival or departure
// leaves that field unset on the protobuf, which is how the live feed publishes
// the ends of a trip.
type tripStop struct {
	id        string
	arrival   int64
	departure int64
}

// stopsAt builds a stop sequence where every stop carries both times, spaced
// gapSecs apart from start. The common case; tests that care about a missing
// time build the slice themselves.
func stopsAt(start, gapSecs int64, ids ...string) []tripStop {
	out := make([]tripStop, 0, len(ids))
	for i, id := range ids {
		t := start + int64(i)*gapSecs
		out = append(out, tripStop{id: id, arrival: t, departure: t + 30})
	}
	return out
}

// vehicleFeed builds a feed with a TripUpdate entity carrying tripStops and a
// separate Vehicle entity for the same trip. A nil status leaves current_status
// unset.
func vehicleFeed(tripID, routeID, vehicleStopID string, status *int32, tripStops []tripStop) *gtfs.FeedMessage {
	stus := make([]*gtfs.TripUpdate_StopTimeUpdate, 0, len(tripStops))
	for _, s := range tripStops {
		stu := &gtfs.TripUpdate_StopTimeUpdate{StopId: proto.String(s.id)}
		if s.arrival != 0 {
			stu.Arrival = &gtfs.TripUpdate_StopTimeEvent{Time: proto.Int64(s.arrival)}
		}
		if s.departure != 0 {
			stu.Departure = &gtfs.TripUpdate_StopTimeEvent{Time: proto.Int64(s.departure)}
		}
		stus = append(stus, stu)
	}

	veh := &gtfs.VehiclePosition{
		Trip:   &gtfs.TripDescriptor{RouteId: proto.String(routeID), TripId: proto.String(tripID)},
		StopId: proto.String(vehicleStopID),
	}
	if status != nil {
		st := gtfs.VehiclePosition_VehicleStopStatus(*status)
		veh.CurrentStatus = &st
	}

	return &gtfs.FeedMessage{
		Header: &gtfs.FeedHeader{GtfsRealtimeVersion: proto.String("2.0")},
		Entity: []*gtfs.FeedEntity{
			{
				Id: proto.String("tu"),
				TripUpdate: &gtfs.TripUpdate{
					Trip:           &gtfs.TripDescriptor{TripId: proto.String(tripID)},
					StopTimeUpdate: stus,
				},
			},
			{Id: proto.String("veh"), Vehicle: veh},
		},
	}
}

func TestParseVehiclePositionsBasic(t *testing.T) {
	feeds := []*gtfs.FeedMessage{
		vehicleFeed("trip-1", "1", "127N", statusPtr(vehicleStatusStoppedAt), stopsAt(1_700_000_000, 90, "127N", "125N", "123N")),
	}

	vehicles := parseVehiclePositions(feeds)

	if len(vehicles) != 1 {
		t.Fatalf("expected 1 vehicle, got %d", len(vehicles))
	}
	v := vehicles[0]
	if v.RouteID != "1" || v.TripID != "trip-1" || v.StopID != "127N" {
		t.Errorf("unexpected vehicle identity: %+v", v)
	}
	if v.CurrentStatus != vehicleStatusStoppedAt {
		t.Errorf("CurrentStatus = %d, want %d", v.CurrentStatus, vehicleStatusStoppedAt)
	}
	if len(v.StopTimeUpdate) != 3 {
		t.Fatalf("expected 3 stop-time updates, got %d", len(v.StopTimeUpdate))
	}
	if v.StopTimeUpdate[0].StopID != "127N" || v.StopTimeUpdate[2].StopID != "123N" {
		t.Errorf("unexpected stop sequence: %+v", v.StopTimeUpdate)
	}
	// The times are the whole point of carrying the sequence: they are what
	// lets a consumer place a train between two stations rather than on one.
	if v.StopTimeUpdate[0].Arrival != 1_700_000_000 || v.StopTimeUpdate[0].Departure != 1_700_000_030 {
		t.Errorf("first stop times = %d/%d, want 1700000000/1700000030",
			v.StopTimeUpdate[0].Arrival, v.StopTimeUpdate[0].Departure)
	}
	if v.StopTimeUpdate[2].Arrival != 1_700_000_180 {
		t.Errorf("third stop arrival = %d, want 1700000180", v.StopTimeUpdate[2].Arrival)
	}
}

// A stop with no predicted times must round-trip as absent, not as 1970. The
// live feed leaves one or both unset on roughly 1-2% of stop-time updates,
// typically at the ends of a trip.
func TestParseVehicleMissingStopTimes(t *testing.T) {
	feeds := []*gtfs.FeedMessage{
		vehicleFeed("trip-1", "1", "127N", statusPtr(vehicleStatusStoppedAt), []tripStop{
			{id: "127N"},                           // neither time
			{id: "125N", arrival: 1_700_000_090},   // arrival only
			{id: "123N", departure: 1_700_000_210}, // departure only
		}),
	}

	v := parseVehiclePositions(feeds)[0]
	if v.StopTimeUpdate[0].Arrival != 0 || v.StopTimeUpdate[0].Departure != 0 {
		t.Errorf("absent times should be zero, got %+v", v.StopTimeUpdate[0])
	}
	if v.StopTimeUpdate[1].Arrival != 1_700_000_090 || v.StopTimeUpdate[1].Departure != 0 {
		t.Errorf("arrival-only stop = %+v", v.StopTimeUpdate[1])
	}
	if v.StopTimeUpdate[2].Arrival != 0 || v.StopTimeUpdate[2].Departure != 1_700_000_210 {
		t.Errorf("departure-only stop = %+v", v.StopTimeUpdate[2])
	}

	raw, err := json.Marshal(v.StopTimeUpdate[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// omitempty, so a consumer sees a missing key rather than a time of zero.
	if string(raw) != `{"stopId":"127N"}` {
		t.Errorf("absent times should be omitted from JSON, got %s", raw)
	}
}

// The sequence is trimmed to the window the consumer can use, anchored on the
// vehicle's own stop rather than on the head of the trip.
func TestParseVehicleTrimsStopSequence(t *testing.T) {
	ids := []string{"127N", "126N", "125N", "124N", "123N", "122N"}

	t.Run("vehicle at the head", func(t *testing.T) {
		feeds := []*gtfs.FeedMessage{
			vehicleFeed("trip-1", "1", "127N", statusPtr(vehicleStatusStoppedAt), stopsAt(1_700_000_000, 90, ids...)),
		}
		got := parseVehiclePositions(feeds)[0].StopTimeUpdate
		if len(got) != maxStopsPerVehicle {
			t.Fatalf("kept %d stops, want %d", len(got), maxStopsPerVehicle)
		}
		if got[0].StopID != "127N" || got[3].StopID != "124N" {
			t.Errorf("unexpected window: %+v", got)
		}
	})

	t.Run("vehicle partway down its own sequence", func(t *testing.T) {
		// The feed does this for roughly 6% of vehicles: the trip's sequence
		// still lists stops the train has already left.
		feeds := []*gtfs.FeedMessage{
			vehicleFeed("trip-1", "1", "125N", statusPtr(vehicleStatusStoppedAt), stopsAt(1_700_000_000, 90, ids...)),
		}
		got := parseVehiclePositions(feeds)[0].StopTimeUpdate
		if len(got) != maxStopsPerVehicle {
			t.Fatalf("kept %d stops, want %d", len(got), maxStopsPerVehicle)
		}
		if got[0].StopID != "125N" {
			t.Errorf("window should start at the vehicle's own stop, got %+v", got)
		}
		// The times must travel with the window, not be re-indexed.
		if got[0].Arrival != 1_700_000_180 {
			t.Errorf("arrival at 125N = %d, want 1700000180", got[0].Arrival)
		}
	})

	t.Run("vehicle stop absent from its sequence", func(t *testing.T) {
		// ~9% of vehicles. Keeping the head preserves what the consumer already
		// resolved to before any trimming existed.
		feeds := []*gtfs.FeedMessage{
			vehicleFeed("trip-1", "1", "999N", statusPtr(vehicleStatusStoppedAt), stopsAt(1_700_000_000, 90, ids...)),
		}
		got := parseVehiclePositions(feeds)[0].StopTimeUpdate
		if len(got) != maxStopsPerVehicle || got[0].StopID != "127N" {
			t.Errorf("expected the head of the sequence, got %+v", got)
		}
	})

	t.Run("sequence shorter than the cap", func(t *testing.T) {
		feeds := []*gtfs.FeedMessage{
			vehicleFeed("trip-1", "1", "126N", statusPtr(vehicleStatusStoppedAt), stopsAt(1_700_000_000, 90, "127N", "126N")),
		}
		got := parseVehiclePositions(feeds)[0].StopTimeUpdate
		if len(got) != 1 || got[0].StopID != "126N" {
			t.Errorf("expected the tail of a short sequence, got %+v", got)
		}
	})
}

func TestParseVehicleSkipsIncomplete(t *testing.T) {
	feed := &gtfs.FeedMessage{
		Header: &gtfs.FeedHeader{GtfsRealtimeVersion: proto.String("2.0")},
		Entity: []*gtfs.FeedEntity{
			// No stop ID.
			{Id: proto.String("v1"), Vehicle: &gtfs.VehiclePosition{
				Trip: &gtfs.TripDescriptor{TripId: proto.String("t1")},
			}},
			// No trip ID.
			{Id: proto.String("v2"), Vehicle: &gtfs.VehiclePosition{
				StopId: proto.String("127N"),
			}},
		},
	}

	if got := parseVehiclePositions([]*gtfs.FeedMessage{feed}); len(got) != 0 {
		t.Errorf("expected incomplete vehicles to be skipped, got %d", len(got))
	}
}

func TestParseVehicleDefaultStatus(t *testing.T) {
	feeds := []*gtfs.FeedMessage{
		vehicleFeed("trip-1", "1", "127N", nil, stopsAt(1_700_000_000, 90, "127N")), // status unset
	}

	vehicles := parseVehiclePositions(feeds)
	if len(vehicles) != 1 {
		t.Fatalf("expected 1 vehicle, got %d", len(vehicles))
	}
	if vehicles[0].CurrentStatus != vehicleStatusStoppedAt {
		t.Errorf("absent status: CurrentStatus = %d, want %d (STOPPED_AT)",
			vehicles[0].CurrentStatus, vehicleStatusStoppedAt)
	}
}

func TestHandleVehiclesEndpoint(t *testing.T) {
	now := time.Now()
	feedsMu.Lock()
	feedCache = map[string]feedEntry{
		"test": {msg: vehicleFeed("trip-1", "1", "127N", statusPtr(vehicleStatusInTransitTo), stopsAt(1_700_000_000, 90, "127N", "125N")), fetchedAt: now},
	}
	lastRefresh = now
	feedsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/vehicles", nil)
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp vehiclesResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Vehicles) != 1 {
		t.Fatalf("expected 1 vehicle, got %d", len(resp.Vehicles))
	}
	if resp.Vehicles[0].RouteID != "1" || resp.Vehicles[0].StopID != "127N" {
		t.Errorf("unexpected vehicle: %+v", resp.Vehicles[0])
	}
	if got := resp.Vehicles[0].StopTimeUpdate[1].Arrival; got != 1_700_000_090 {
		t.Errorf("next stop arrival over the wire = %d, want 1700000090", got)
	}
	if resp.UpdatedAt == "" {
		t.Error("expected non-empty updatedAt")
	}
}

func TestHandleVehiclesEmpty(t *testing.T) {
	feedsMu.Lock()
	feedCache = map[string]feedEntry{}
	lastRefresh = time.Time{}
	feedsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/vehicles", nil)
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	raw := w.Body.Bytes()
	// Must serialize as [] not null so the frontend can always iterate.
	if !bytes.Contains(raw, []byte(`"vehicles":[]`)) {
		t.Errorf("expected vehicles to serialize as [], got: %s", raw)
	}
}
