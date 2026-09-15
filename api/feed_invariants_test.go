package main

import (
	"fmt"
	"os"
	"sort"
	"testing"
	"time"
)

// Assertions about MTA's feed rather than about this code.
//
// These exist because the router depends on properties of the data that nothing
// in this repository controls. If a future feed breaks one, RAPTOR keeps
// returning plausible itineraries that are quietly wrong, and every other test
// still passes — the same shape as the two bugs that reached production.
//
// Skipped unless GTFS_DIR points at an extracted feed, so ordinary `go test`
// and the PR pipeline are unaffected. A scheduled workflow runs them weekly
// against a freshly downloaded feed; see .github/workflows/feed-check.yml.

func loadRealTimetable(t *testing.T) *Timetable {
	t.Helper()
	dir := os.Getenv("GTFS_DIR")
	if dir == "" {
		t.Skip("set GTFS_DIR to an extracted GTFS feed to run this")
	}
	read := func(name string) []byte {
		b, err := os.ReadFile(dir + "/" + name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return b
	}
	tt, err := BuildTimetable(read("stop_times.txt"), read("trips.txt"),
		read("transfers.txt"), read("calendar.txt"), read("calendar_dates.txt"))
	if err != nil {
		t.Fatalf("build timetable: %v", err)
	}
	return tt
}

// TestFeedTripsDoNotOvertakeWithinAService is the load-bearing one.
//
// earliestTrip binary-searches a pattern's trips rather than scanning them,
// which is only correct if a trip that departs later never arrives earlier. If
// that stops being true, the search returns a trip that is not the best one,
// every itinerary still looks reasonable, and nothing errors.
//
// Measured when this was written: 0 violations across 20,228 adjacent pairs.
//
// The comparison has to be *within a service*. Across services the same feed
// shows 3,067 apparent overtakes, because a Saturday trip and a weekday trip
// share a pattern and never run on the same day — which is exactly why
// earliestTrip filters by service before searching.
func TestFeedTripsDoNotOvertakeWithinAService(t *testing.T) {
	tt := loadRealTimetable(t)

	pairs, violations := 0, 0
	var examples []string

	for pi := range tt.Patterns {
		p := &tt.Patterns[pi]

		byService := map[string][]int{}
		for i := range p.Trips {
			byService[p.Trips[i].ServiceID] = append(byService[p.Trips[i].ServiceID], i)
		}

		for service, idxs := range byService {
			sort.Slice(idxs, func(a, b int) bool {
				return p.Trips[idxs[a]].Departures[0] < p.Trips[idxs[b]].Departures[0]
			})
			for k := 0; k+1 < len(idxs); k++ {
				earlier, later := &p.Trips[idxs[k]], &p.Trips[idxs[k+1]]
				pairs++
				for s := range earlier.Departures {
					if later.Departures[s] < earlier.Departures[s] {
						violations++
						if len(examples) < 5 {
							examples = append(examples, fmt.Sprintf(
								"route %s service %s stop %d: %s departs %d, %s departs %d",
								p.RouteID, service, s,
								earlier.TripID, earlier.Departures[s],
								later.TripID, later.Departures[s]))
						}
						break
					}
				}
			}
		}
	}

	t.Logf("checked %d adjacent same-service trip pairs across %d patterns", pairs, len(tt.Patterns))
	if pairs == 0 {
		t.Fatal("no pairs checked — the timetable looks empty")
	}
	if violations > 0 {
		t.Errorf("%d trip pairs overtake within a service; earliestTrip's binary search is no longer sound", violations)
		for _, e := range examples {
			t.Errorf("   %s", e)
		}
	}
}

// TestFeedShapeHasNotCollapsed catches a feed that parses but has lost most of
// itself — a truncated upload, a changed id scheme, a dropped file.
func TestFeedShapeHasNotCollapsed(t *testing.T) {
	tt := loadRealTimetable(t)

	footpaths := 0
	for _, list := range tt.Transfers {
		footpaths += len(list)
	}
	t.Logf("patterns=%d trips=%d platforms=%d services=%d footpaths=%d",
		len(tt.Patterns), tt.TripCount(), len(tt.Stops), len(tt.Services), footpaths)

	// Ranges, not exact values: the feed legitimately changes week to week.
	// Recorded when written: 218 / 20,621 / 989 / 7 / 1,522.
	for _, c := range []struct {
		name     string
		got      int
		min, max int
	}{
		{"patterns", len(tt.Patterns), 150, 400},
		{"trips", tt.TripCount(), 15000, 30000},
		{"platforms", len(tt.Stops), 900, 1100},
		{"services", len(tt.Services), 3, 20},
		{"footpaths", footpaths, 800, 3000},
	} {
		if c.got < c.min || c.got > c.max {
			t.Errorf("%s = %d, outside the expected %d..%d — the feed's shape changed",
				c.name, c.got, c.min, c.max)
		}
	}
}

// TestFeedStillRunsPastMidnight guards the late-night network.
//
// GTFS writes a 1:30am train as 25:30, and 18,876 rows sit at or past 24:00. If
// they disappear, either MTA changed how it expresses them or the parser started
// dropping them — and overnight trips would vanish without any error.
func TestFeedStillRunsPastMidnight(t *testing.T) {
	tt := loadRealTimetable(t)

	past, latest := 0, int32(0)
	for pi := range tt.Patterns {
		for ti := range tt.Patterns[pi].Trips {
			for _, sec := range tt.Patterns[pi].Trips[ti].Arrivals {
				if sec >= serviceDaySeconds {
					past++
				}
				if sec > latest {
					latest = sec
				}
			}
		}
	}
	t.Logf("stop times at or past 24:00: %d, latest %s", past, formatServiceTime(latest))

	if past < 5000 {
		t.Errorf("only %d stop times past midnight; the late-night network may have been dropped", past)
	}
	if latest < serviceDaySeconds {
		t.Error("no stop time reaches 24:00 at all")
	}
}

func formatServiceTime(secs int32) string {
	return fmt.Sprintf("%02d:%02d:%02d", secs/3600, (secs%3600)/60, secs%60)
}

// TestFeedStillRoutesReferenceJourneys checks the whole pipeline end to end on
// journeys a New Yorker can sanity-check.
func TestFeedStillRoutesReferenceJourneys(t *testing.T) {
	tt := loadRealTimetable(t)

	// A Wednesday at 09:00, in the feed's zone, so results do not depend on when
	// the job happens to run.
	depart := time.Date(2026, 9, 9, 9, 0, 0, 0, feedLocation())

	cases := []struct {
		name         string
		from, to     string
		maxMinutes   int32
		maxTransfers int
	}{
		{"Times Sq to Grand Central", "127", "631", 25, 2},
		{"96 St to Union Sq", "120", "635", 45, 2},
		{"Bedford Av to Times Sq", "L08", "127", 45, 2},
		{"Inwood-207 to Far Rockaway", "A02", "H11", 160, 2},
		{"Coney Island to Times Sq", "D43", "127", 100, 2},
	}

	for _, c := range cases {
		from := platformsForAll(tt, c.from)
		to := platformsForAll(tt, c.to)
		if len(from) == 0 || len(to) == 0 {
			t.Errorf("%s: station id no longer resolves (%s -> %s)", c.name, c.from, c.to)
			continue
		}

		journeys := tt.Plan(PlanRequest{From: from, To: to, DepartAt: depart})
		if len(journeys) == 0 {
			t.Errorf("%s: no journey found", c.name)
			continue
		}

		best := journeys[len(journeys)-1]
		mins := (best.ArriveSecs - best.DepartSecs) / 60
		t.Logf("%-30s %3d min, %d transfers", c.name, mins, best.Transfers)

		if mins <= 0 || mins > c.maxMinutes {
			t.Errorf("%s: %d minutes is outside the plausible range (max %d)", c.name, mins, c.maxMinutes)
		}
		if best.Transfers > c.maxTransfers {
			t.Errorf("%s: %d transfers, expected at most %d", c.name, best.Transfers, c.maxTransfers)
		}
	}
}
