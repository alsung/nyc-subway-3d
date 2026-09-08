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

// arrivalFeed builds a one-entity feed with a single stop-time update whose
// arrival time is arrivalUnix.
func arrivalFeed(stopID string, arrivalUnix int64, routeID, tripID string) *gtfs.FeedMessage {
	return &gtfs.FeedMessage{
		Header: &gtfs.FeedHeader{GtfsRealtimeVersion: proto.String("2.0")},
		Entity: []*gtfs.FeedEntity{
			{
				Id: proto.String("e1"),
				TripUpdate: &gtfs.TripUpdate{
					Trip: &gtfs.TripDescriptor{
						RouteId: proto.String(routeID),
						TripId:  proto.String(tripID),
					},
					StopTimeUpdate: []*gtfs.TripUpdate_StopTimeUpdate{
						{
							StopId:  proto.String(stopID),
							Arrival: &gtfs.TripUpdate_StopTimeEvent{Time: proto.Int64(arrivalUnix)},
						},
					},
				},
			},
		},
	}
}

func TestNormalizeStopId(t *testing.T) {
	cases := map[string]string{
		"127N": "127",
		"127S": "127",
		"127":  "127",
		"":     "",
		"L08N": "L08",
	}
	for in, want := range cases {
		if got := normalizeStopId(in); got != want {
			t.Errorf("normalizeStopId(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildArrivalIndexBasic(t *testing.T) {
	now := time.Now()
	feeds := []*gtfs.FeedMessage{arrivalFeed("127N", now.Unix()+180, "1", "trip-1")}

	index := buildArrivalIndex(feeds, now)

	// Indexed under both the directional and parent IDs.
	for _, key := range []string{"127N", "127"} {
		got := index[key]
		if len(got) != 1 {
			t.Fatalf("index[%q]: expected 1 arrival, got %d", key, len(got))
		}
		a := got[0]
		if a.Minutes != 3 {
			t.Errorf("index[%q].Minutes = %d, want 3", key, a.Minutes)
		}
		if a.Direction != "N" {
			t.Errorf("index[%q].Direction = %q, want N", key, a.Direction)
		}
		if a.RouteID != "1" || a.TripID != "trip-1" {
			t.Errorf("index[%q] = %+v, want route 1 / trip-1", key, a)
		}
	}
}

func TestBuildArrivalIndexFiltersWindow(t *testing.T) {
	now := time.Now()
	feeds := []*gtfs.FeedMessage{
		arrivalFeed("100N", now.Unix()+70*60, "1", "future"), // >60 min ahead
		arrivalFeed("200N", now.Unix()-120, "1", "past"),     // >1 min in the past
	}

	index := buildArrivalIndex(feeds, now)

	if len(index) != 0 {
		t.Errorf("expected empty index (both out of window), got %v", index)
	}
}

func TestBuildArrivalIndexSorted(t *testing.T) {
	now := time.Now()
	feeds := []*gtfs.FeedMessage{
		arrivalFeed("127N", now.Unix()+600, "1", "later"),  // 10 min
		arrivalFeed("127N", now.Unix()+120, "2", "sooner"), // 2 min
		arrivalFeed("127N", now.Unix()+360, "3", "middle"), // 6 min
	}

	got := buildArrivalIndex(feeds, now)["127"]
	if len(got) != 3 {
		t.Fatalf("expected 3 arrivals, got %d", len(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i-1].Minutes > got[i].Minutes {
			t.Errorf("arrivals not sorted ascending: %+v", got)
		}
	}
}

func TestHandleArrivalsEndpoint(t *testing.T) {
	now := time.Now()
	feedsMu.Lock()
	feedCache = map[string]feedEntry{
		"test": {msg: arrivalFeed("127N", now.Unix()+300, "1", "trip-x"), fetchedAt: now},
	}
	lastRefresh = now
	feedsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/arrivals/127", nil)
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp arrivalsResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.StationID != "127" {
		t.Errorf("StationID = %q, want 127", resp.StationID)
	}
	if len(resp.Arrivals) != 1 {
		t.Fatalf("expected 1 arrival, got %d", len(resp.Arrivals))
	}
	if resp.Arrivals[0].RouteID != "1" {
		t.Errorf("RouteID = %q, want 1", resp.Arrivals[0].RouteID)
	}
	if resp.UpdatedAt == "" {
		t.Error("expected non-empty updatedAt")
	}
}

func TestHandleArrivalsUnknownStation(t *testing.T) {
	now := time.Now()
	feedsMu.Lock()
	feedCache = map[string]feedEntry{
		"test": {msg: arrivalFeed("127N", now.Unix()+300, "1", "trip-x"), fetchedAt: now},
	}
	lastRefresh = now
	feedsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/arrivals/999", nil)
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for unknown station, got %d", w.Code)
	}

	raw := w.Body.Bytes()
	var resp arrivalsResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Arrivals) != 0 {
		t.Errorf("expected empty arrivals for unknown station, got %d", len(resp.Arrivals))
	}
	// Must serialize as [] not null so the frontend can always iterate.
	if !bytes.Contains(raw, []byte(`"arrivals":[]`)) {
		t.Errorf("expected arrivals to serialize as [], got: %s", raw)
	}
}

// multiStopFeed builds one trip update spanning several stops, each one minute
// apart, so the destination logic has a real sequence to reduce.
func multiStopFeed(stopIDs []string, firstUnix int64, routeID, tripID string) *gtfs.FeedMessage {
	stus := make([]*gtfs.TripUpdate_StopTimeUpdate, 0, len(stopIDs))
	for i, s := range stopIDs {
		stu := &gtfs.TripUpdate_StopTimeUpdate{
			Arrival: &gtfs.TripUpdate_StopTimeEvent{Time: proto.Int64(firstUnix + int64(i)*60)},
		}
		// An empty string means "this entry carries no stop id", which the feed
		// does occasionally emit; proto.String("") would not be the same thing.
		if s != "" {
			stu.StopId = proto.String(s)
		}
		stus = append(stus, stu)
	}
	return &gtfs.FeedMessage{
		Header: &gtfs.FeedHeader{GtfsRealtimeVersion: proto.String("2.0")},
		Entity: []*gtfs.FeedEntity{{
			Id: proto.String("e1"),
			TripUpdate: &gtfs.TripUpdate{
				Trip:           &gtfs.TripDescriptor{RouteId: proto.String(routeID), TripId: proto.String(tripID)},
				StopTimeUpdate: stus,
			},
		}},
	}
}

func TestTripDestination(t *testing.T) {
	cases := []struct {
		name  string
		stops []string
		want  string
	}{
		{"last stop of the sequence", []string{"127N", "126N", "125N"}, "125"},
		{"directional suffix stripped", []string{"L01S", "L29S"}, "L29"},
		{"single stop is its own destination", []string{"R29N"}, "R29"},
		{"trailing entry without a stop id is skipped", []string{"A41N", "A40N", ""}, "A40"},
		{"no usable stop id at all", []string{"", ""}, ""},
		{"no stop time updates", nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			feed := multiStopFeed(c.stops, time.Now().Unix()+60, "1", "trip-x")
			got := tripDestination(feed.Entity[0].TripUpdate)
			if got != c.want {
				t.Errorf("tripDestination(%v) = %q, want %q", c.stops, got, c.want)
			}
		})
	}
}

// Every arrival from one trip reports the same destination, including the entry
// for the final stop itself — a rider standing at the terminal should still see
// where the train terminates rather than a blank.
func TestArrivalsCarryDestination(t *testing.T) {
	now := time.Now()
	feeds := []*gtfs.FeedMessage{
		multiStopFeed([]string{"R30N", "R29N", "R27N"}, now.Unix()+120, "R", "trip-r"),
	}
	index := buildArrivalIndex(feeds, now)

	for _, stop := range []string{"R30", "R29", "R27"} {
		arrivals := index[stop]
		if len(arrivals) == 0 {
			t.Fatalf("no arrivals indexed for %s", stop)
		}
		if arrivals[0].Destination != "R27" {
			t.Errorf("%s: Destination = %q, want %q", stop, arrivals[0].Destination, "R27")
		}
	}
}

// A trip whose stops carry no ids must not poison the arrivals that do resolve.
func TestDestinationEmptyDoesNotDropArrivals(t *testing.T) {
	now := time.Now()
	feeds := []*gtfs.FeedMessage{arrivalFeed("127N", now.Unix()+180, "1", "trip-1")}
	index := buildArrivalIndex(feeds, now)
	if len(index["127"]) != 1 {
		t.Fatalf("expected 1 arrival at 127, got %d", len(index["127"]))
	}
	// The only stop in this feed is the arrival stop, so it is also the terminus.
	if got := index["127"][0].Destination; got != "127" {
		t.Errorf("Destination = %q, want %q", got, "127")
	}
}
