package main

import (
	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
)

// VehicleStopStatus values from the GTFS-RT spec.
const (
	vehicleStatusIncomingAt  int32 = 0
	vehicleStatusStoppedAt   int32 = 1
	vehicleStatusInTransitTo int32 = 2
)

// VehicleStop is one stop in a vehicle's remaining stop sequence, carrying MTA's
// predicted times for it.
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
// carries its trip's stop sequence and the predicted times for it, letting the
// frontend derive a position along the route geometry. JSON keys match what
// src/scene/trains.js already reads.
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

			stops := stopsByTrip[tripID]
			if stops == nil {
				stops = []VehicleStop{}
			}

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
