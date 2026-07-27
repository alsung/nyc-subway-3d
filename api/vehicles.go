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

// VehicleStop is one stop in a vehicle's remaining stop sequence. Only the stop
// ID is carried — the frontend's deriveVehicleT reads nothing else from it.
type VehicleStop struct {
	StopID string `json:"stopId"`
}

// Vehicle is one live train. MTA's subway feed publishes no GPS, so each vehicle
// carries its trip's stop sequence, letting the frontend derive an approximate
// position along the route geometry. JSON keys match what src/scene/trains.js
// already reads.
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
				stops = append(stops, VehicleStop{StopID: stu.GetStopId()})
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
