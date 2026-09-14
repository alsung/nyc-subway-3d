package main

import (
	"log/slog"
	"sync"
	"time"

	// Embeds the timezone database in the binary. The runtime image is
	// debian-slim, which does not ship tzdata, so without this
	// LoadLocation("America/New_York") fails in production and silently
	// succeeds on any developer machine that has the system database.
	_ "time/tzdata"
)

// The zone the GTFS feed's times are written in. A service day starts at local
// midnight in New York, not wherever the server happens to run.
const feedTimezone = "America/New_York"

var (
	feedLocOnce sync.Once
	feedLoc     *time.Location
)

// feedLocation returns the feed's timezone.
//
// This exists because the server runs in UTC and the timetable does not. Every
// scheduled time in the feed is seconds from local midnight, so interpreting
// time.Now() directly would shift every query by the UTC offset — four hours in
// summer, five in winter. The failure is invisible locally, since a developer
// machine in New York already agrees with the feed, and only appears in
// production.
// Anything that turns a wall clock into a service-day offset must go through
// here first. As of this writing that is secondsSinceMidnight and candidateDays
// in raptor.go, both fed an already-converted time by Plan, and the midnight
// anchor in departures.go. Every other time.Now() in the package measures a
// duration or compares epoch seconds, and neither cares about the zone.
func feedLocation() *time.Location {
	feedLocOnce.Do(func() {
		loc, err := time.LoadLocation(feedTimezone)
		if err != nil {
			slog.Error("failed to load feed timezone; falling back to UTC, plans will be wrong",
				"tz", feedTimezone, "err", err)
			loc = time.UTC
		}
		feedLoc = loc
	})
	return feedLoc
}
