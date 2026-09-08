package main

import (
	"math"
	"sort"
	"strings"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
)

// Arrival is one predicted train arrival at a stop. Mirrors the shape the
// frontend's rt-parser.js produces.
type Arrival struct {
	RouteID   string `json:"routeId"`
	Direction string `json:"direction"` // "N", "S", or "" when the stop has no directional suffix
	Minutes   int    `json:"minutes"`   // whole minutes from now; may be slightly negative
	TripID    string `json:"tripId"`
	// Destination is the parent stop ID of the trip's final stop — what the
	// rider reads as "where this train is going". Empty when the feed gives no
	// usable last stop.
	//
	// Taken from the trip update rather than from GTFS static on purpose. The
	// obvious static route is trip_id -> shape_id -> trip_headsign, but MTA
	// issues live-only path variants that trips.txt has never heard of
	// ("4..N", "6..N01X009", "1..S12X001"), concentrated on the numbered lines
	// where rerouting is most common: that lookup resolved 49% of live
	// arrivals against this one's 99%. It is also correct through a reroute,
	// where a static headsign would confidently name the wrong terminal.
	Destination string `json:"destination"`
}

// arrivalsResponse is the JSON body for GET /api/arrivals/{stationId}.
type arrivalsResponse struct {
	StationID string    `json:"stationId"`
	Arrivals  []Arrival `json:"arrivals"`
	UpdatedAt string    `json:"updatedAt"` // last feed refresh, RFC3339; "" before the first refresh
}

// normalizeStopId strips a single trailing N/S direction suffix to get the
// parent station ID. MTA real-time feeds use directional IDs (127N, 127S);
// stops.txt uses parent IDs (127).
func normalizeStopId(stopID string) string {
	if n := len(stopID); n > 0 {
		if last := stopID[n-1]; last == 'N' || last == 'S' {
			return stopID[:n-1]
		}
	}
	return stopID
}

// buildArrivalIndex flattens decoded feeds into an arrival index keyed on both
// the directional stop ID and the parent stop ID, so lookups work either way.
// Arrivals more than 1 minute in the past or more than 60 minutes ahead are
// dropped; each station's arrivals are sorted ascending by minutes. Pure: no
// network, no globals. Port of buildArrivalIndex in src/core/rt-parser.js.
func buildArrivalIndex(feeds []*gtfs.FeedMessage, now time.Time) map[string][]Arrival {
	index := map[string][]Arrival{}
	nowSec := float64(now.Unix())

	for _, feed := range feeds {
		if feed == nil {
			continue
		}
		for _, entity := range feed.Entity {
			tu := entity.TripUpdate
			if tu == nil {
				continue
			}
			routeID := tu.Trip.GetRouteId() // nil-safe getters
			tripID := tu.Trip.GetTripId()
			destination := tripDestination(tu)

			for _, stu := range tu.StopTimeUpdate {
				stopID := stu.GetStopId()
				if stopID == "" {
					continue
				}

				raw, ok := stopEventTime(stu)
				if !ok {
					continue
				}

				minutes := (float64(raw) - nowSec) / 60
				if minutes < -1 || minutes > 60 {
					continue
				}

				direction := ""
				if strings.HasSuffix(stopID, "N") {
					direction = "N"
				} else if strings.HasSuffix(stopID, "S") {
					direction = "S"
				}

				arr := Arrival{
					RouteID:     routeID,
					Direction:   direction,
					Minutes:     int(math.Round(minutes)),
					TripID:      tripID,
					Destination: destination,
				}

				index[stopID] = append(index[stopID], arr)
				if parentID := normalizeStopId(stopID); parentID != stopID {
					index[parentID] = append(index[parentID], arr)
				}
			}
		}
	}

	for key := range index {
		arrivals := index[key]
		sort.Slice(arrivals, func(i, j int) bool { return arrivals[i].Minutes < arrivals[j].Minutes })
	}
	return index
}

// tripDestination is the parent stop ID of the last stop in a trip update.
//
// A trip update lists the stops still ahead of the train, in order, so its last
// entry is where the trip ends. Scanning backwards skips trailing entries that
// carry no stop ID rather than giving up on the whole trip because of one.
func tripDestination(tu *gtfs.TripUpdate) string {
	for i := len(tu.StopTimeUpdate) - 1; i >= 0; i-- {
		if stopID := tu.StopTimeUpdate[i].GetStopId(); stopID != "" {
			return normalizeStopId(stopID)
		}
	}
	return ""
}

// stopEventTime returns the arrival time, falling back to the departure time,
// as Unix seconds. ok is false when neither is present.
func stopEventTime(stu *gtfs.TripUpdate_StopTimeUpdate) (int64, bool) {
	if stu.Arrival != nil && stu.Arrival.Time != nil {
		return stu.Arrival.GetTime(), true
	}
	if stu.Departure != nil && stu.Departure.Time != nil {
		return stu.Departure.GetTime(), true
	}
	return 0, false
}
