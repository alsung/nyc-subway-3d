package main

import (
	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
)

// How many stops of a trip's remaining sequence each vehicle carries.
//
// The consumer reads two — the stop the vehicle is at or heading to, and the
// first one after it, which is what gives the direction of travel. Four leaves
// headroom without shipping a whole trip: the median vehicle's sequence is 15
// stops and the longest is 60, and at ~240 vehicles the untrimmed response is
// 286 kB raw / 31.8 kB gzipped against 74 kB / 7.9 kB trimmed. That is every 30
// seconds, per client.
//
// If a future feature needs a train's full remaining sequence, it should ask for
// one trip rather than pushing sixty stops for every train to every client.
const maxStopsPerVehicle = 4

// VehicleStopStatus values from the GTFS-RT spec.
const (
	vehicleStatusIncomingAt  int32 = 0
	vehicleStatusStoppedAt   int32 = 1
	vehicleStatusInTransitTo int32 = 2
)

// VehicleStop is one stop in the window of a vehicle's remaining sequence,
// carrying MTA's predicted times for it.
//
// Those times are the only thing in the feed that says where a train is between
// two stations. current_status is not a substitute: a probe of three live feeds
// found 45% of vehicles carry no current_status at all, and of the 55% that do,
// all but a handful report STOPPED_AT. The predicted times are close to
// complete by comparison — 99% of stop-time updates carry an arrival and 98% a
// departure — so a position interpolated from the wall clock against them is
// the honest one, and a fixed fraction of the gap between two stops is not.
//
// Epoch seconds, exactly as the feed publishes them. Zero means the feed omitted
// the field and omitempty drops it from the JSON, so a consumer has to read a
// missing time as unknown rather than as 1970.
type VehicleStop struct {
	StopID    string `json:"stopId"`
	Arrival   int64  `json:"arrival,omitempty"`
	Departure int64  `json:"departure,omitempty"`
}

// Vehicle is one live train. MTA's subway feed publishes no GPS, so each vehicle
// carries the next few stops of its trip and the predicted times for them,
// letting the frontend derive a position along the route geometry. JSON keys
// match what src/scene/trains.js already reads. See maxStopsPerVehicle for why
// the sequence is a window rather than the whole trip.
type Vehicle struct {
	RouteID        string        `json:"routeId"`
	TripID         string        `json:"tripId"`
	StopID         string        `json:"stopId"`        // directional stop the vehicle is at/approaching
	CurrentStatus  int32         `json:"currentStatus"` // 0 INCOMING_AT, 1 STOPPED_AT, 2 IN_TRANSIT_TO
	StopTimeUpdate []VehicleStop `json:"stopTimeUpdate"`
}

// vehiclesResponse is the JSON body for GET /api/vehicles.
type vehiclesResponse struct {
	Vehicles  []Vehicle `json:"vehicles"`
	UpdatedAt string    `json:"updatedAt"` // last feed refresh, RFC3339; "" before the first refresh
}

// parseVehiclePositions flattens decoded feeds into a list of live vehicles.
// Pure: no network, no globals. Port of parseVehiclePositions in
// src/core/rt-parser.js.
//
// MTA splits trip updates and vehicle positions into separate entities, so the
// stop sequence for a vehicle comes from the TripUpdate entity sharing its trip
// ID — collected first into stopsByTrip, then attached per vehicle.
func parseVehiclePositions(feeds []*gtfs.FeedMessage) []Vehicle {
	vehicles := []Vehicle{}

	for _, feed := range feeds {
		if feed == nil {
			continue
		}

		stopsByTrip := map[string][]VehicleStop{}
		for _, entity := range feed.Entity {
			tu := entity.TripUpdate
			if tu == nil {
				continue
			}
			tripID := tu.Trip.GetTripId()
			if tripID == "" {
				continue
			}
			stops := make([]VehicleStop, 0, len(tu.StopTimeUpdate))
			for _, stu := range tu.StopTimeUpdate {
				// Both getters are nil-safe all the way down: a stop-time update
				// with no arrival at all yields 0 rather than panicking, which is
				// the 1-2% of entries the feed leaves blank at a trip's ends.
				stops = append(stops, VehicleStop{
					StopID:    stu.GetStopId(),
					Arrival:   stu.GetArrival().GetTime(),
					Departure: stu.GetDeparture().GetTime(),
				})
			}
			stopsByTrip[tripID] = stops
		}

		for _, entity := range feed.Entity {
			v := entity.Vehicle
			if v == nil {
				continue
			}
			tripID := v.Trip.GetTripId()
			if v.GetStopId() == "" || tripID == "" {
				continue
			}

			// Absent current_status → STOPPED_AT, matching the frontend (NOT the
			// protobuf default of IN_TRANSIT_TO).
			//
			// This default carries more weight than it looks: 45% of vehicles in
			// the live feed omit current_status entirely, and nearly every
			// vehicle that does carry it reports STOPPED_AT. Status alone cannot
			// place a train, which is what VehicleStop's predicted times are
			// for.
			status := vehicleStatusStoppedAt
			if v.CurrentStatus != nil {
				status = int32(v.GetCurrentStatus())
			}

			stops := trimStops(stopsByTrip[tripID], v.GetStopId())

			vehicles = append(vehicles, Vehicle{
				RouteID:        v.Trip.GetRouteId(),
				TripID:         tripID,
				StopID:         v.GetStopId(),
				CurrentStatus:  status,
				StopTimeUpdate: stops,
			})
		}
	}

	return vehicles
}

// trimStops keeps the window of a trip's sequence that describes where this
// vehicle is: the stop it is at or heading to, and the few after it.
//
// Anchoring is not cosmetic, and this is not a pure size optimization. The feed
// keeps publishing stops a train has already left, and deriveVehicleT reads "the
// next stop" as the first entry differing from the vehicle's own — so an
// unanchored sequence hands it a stop behind the train. Replaying a live
// snapshot through both, 13 of 239 vehicles resolved a different next stop, and
// in every one of them the unanchored answer pointed backward:
//
//	vehicle at S16N, sequence [S14N S15N S16N S17N ...]
//	  unanchored -> S14N, two stops behind
//	  anchored   -> S17N, the stop ahead
//
// That reaches two things. Direction of travel inverts, placing an approaching
// train past the station it has not reached; and branch selection, which runs
// for every vehicle including stopped ones, can pick the branch the train came
// from. tests/unit/vehicle-position.test.js pins both.
//
// The search also costs nothing in the common case: 188 of 220 vehicles in that
// snapshot sat at index 0 already.
//
// Stop ids match exactly; normalizing the N/S suffix recovers nothing (measured:
// zero vehicles matched only after stripping it). A vehicle whose stop is absent
// from its own sequence — about 9% of them — keeps the head, which is what the
// consumer already resolved to before any of this was trimmed.
//
// Returns an empty slice rather than nil so the JSON is always an array.
func trimStops(stops []VehicleStop, stopID string) []VehicleStop {
	if len(stops) == 0 {
		return []VehicleStop{}
	}

	start := 0
	for i, s := range stops {
		if s.StopID == stopID {
			start = i
			break
		}
	}

	end := start + maxStopsPerVehicle
	if end > len(stops) {
		end = len(stops)
	}
	return stops[start:end]
}
