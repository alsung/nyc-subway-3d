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
					RouteID:   routeID,
					Direction: direction,
					Minutes:   int(math.Round(minutes)),
					TripID:    tripID,
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
