package main

import (
	"sort"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
)

// Predicted departures from the live feeds, keyed on platform and route.
//
// Deliberately not keyed on trip id. Live trip ids do not match static ones at
// all — measured at 0% exact overlap across 746 trip updates, because the feed
// writes "070550_N..S34R" where trips.txt writes
// "BSP26GEN-R097-Weekday-00_070200_R..S71R". A suffix join recovers 73% of them
// and leaves 22.5% with no static counterpart: the live-only reroute variants
// (J..N41R, Q..N36R, N..S) that arrivals.go already documents.
//
// Keying on (platform, route) sidesteps the join entirely and reaches every
// running train, at the cost of not knowing *which* scheduled trip a prediction
// belongs to. That is the right trade here: the dominant realtime effect on a
// journey is waiting for a train that has not come, and this captures it.
type DepartureIndex struct {
	// platform stop id -> route id -> predicted departures, ascending, as
	// seconds from the start of the service day.
	byStop map[string]map[string][]int32
	// When the feeds behind this index were fetched.
	builtAt time.Time
}

// Predictions further ahead than this are ignored. The realtime feeds only
// cover currently-active trips, so beyond roughly this horizon there is nothing
// to say and the schedule is the honest answer.
const realtimeHorizon = 60 * time.Minute

// buildDepartureIndex flattens trip updates into per-platform, per-route
// predicted departure times. Pure: no globals, no network.
func buildDepartureIndex(feeds []*gtfs.FeedMessage, now time.Time) *DepartureIndex {
	idx := &DepartureIndex{byStop: map[string]map[string][]int32{}, builtAt: now}

	// Seconds from the start of *today's* service day, so predictions land in
	// the same frame as the timetable's scheduled times.
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	horizon := now.Add(realtimeHorizon).Unix()

	for _, feed := range feeds {
		for _, entity := range feed.GetEntity() {
			tu := entity.GetTripUpdate()
			if tu == nil {
				continue
			}
			route := tu.GetTrip().GetRouteId()
			if route == "" {
				continue
			}
			for _, stu := range tu.GetStopTimeUpdate() {
				stop := stu.GetStopId()
				if stop == "" {
					continue
				}
				// Departure where the feed gives one, arrival otherwise: a
				// terminal arrival is still useful, and most MTA updates carry
				// both.
				var epoch int64
				if d := stu.GetDeparture(); d != nil && d.GetTime() > 0 {
					epoch = d.GetTime()
				} else if a := stu.GetArrival(); a != nil && a.GetTime() > 0 {
					epoch = a.GetTime()
				} else {
					continue
				}
				if epoch > horizon {
					continue
				}
				secs := int32(time.Unix(epoch, 0).In(now.Location()).Sub(midnight).Seconds())
				if idx.byStop[stop] == nil {
					idx.byStop[stop] = map[string][]int32{}
				}
				idx.byStop[stop][route] = append(idx.byStop[stop][route], secs)
			}
		}
	}

	for _, routes := range idx.byStop {
		for r := range routes {
			sort.Slice(routes[r], func(i, j int) bool { return routes[r][i] < routes[r][j] })
		}
	}
	return idx
}

// NextDeparture returns the earliest predicted departure of `route` from
// `stop` at or after `after`, and whether one exists.
func (d *DepartureIndex) NextDeparture(stop, route string, after int32) (int32, bool) {
	if d == nil {
		return 0, false
	}
	times := d.byStop[stop][route]
	i := sort.Search(len(times), func(i int) bool { return times[i] >= after })
	if i == len(times) {
		return 0, false
	}
	return times[i], true
}

// StopCount is the number of platforms carrying at least one prediction.
func (d *DepartureIndex) StopCount() int {
	if d == nil {
		return 0
	}
	return len(d.byStop)
}
