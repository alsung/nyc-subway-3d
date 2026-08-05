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

// vehicleFeed builds a feed with a TripUpdate entity carrying tripStops and a
// separate Vehicle entity for the same trip. A nil status leaves current_status
// unset.
func vehicleFeed(tripID, routeID, vehicleStopID string, status *int32, tripStops []string) *gtfs.FeedMessage {
	stus := make([]*gtfs.TripUpdate_StopTimeUpdate, 0, len(tripStops))
	for _, s := range tripStops {
		stus = append(stus, &gtfs.TripUpdate_StopTimeUpdate{StopId: proto.String(s)})
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
		vehicleFeed("trip-1", "1", "127N", statusPtr(vehicleStatusStoppedAt), []string{"127N", "125N", "123N"}),
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
		vehicleFeed("trip-1", "1", "127N", nil, []string{"127N"}), // status unset
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
		"test": {msg: vehicleFeed("trip-1", "1", "127N", statusPtr(vehicleStatusInTransitTo), []string{"127N", "125N"}), fetchedAt: now},
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
