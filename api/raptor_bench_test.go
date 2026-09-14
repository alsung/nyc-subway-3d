package main

import (
	"os"
	"testing"
	"time"
)

// TestPlanAgainstRealFeed routes journeys a New Yorker can check by eye, and
// measures query latency. Skipped unless GTFS_DIR points at an extracted feed.
//
//	unzip gtfs_subway.zip -d /tmp/gtfs && GTFS_DIR=/tmp/gtfs go test -run RealFeed -v ./api
//
// Latency here should be read as roughly 3-4x faster than Fly will deliver: the
// timetable build measured 227 ms on a developer machine and 777 ms on the
// shared-cpu-1x machine in production.
func TestPlanAgainstRealFeed(t *testing.T) {
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
		t.Fatalf("build: %v", err)
	}

	// A Wednesday at 09:00.
	depart, _ := time.Parse("2006-01-02 15:04", "2026-09-09 09:00")

	cases := []struct {
		name     string
		from, to string
	}{
		{"Times Sq to Grand Central (the shuttle)", "127S", "631S"},
		{"96 St (1) to 14 St-Union Sq (4/5/6)", "120S", "635S"},
		{"Bedford Av (L) to Times Sq", "L08S", "127S"},
		{"Coney Island to Times Sq", "D43N", "127N"},
		{"Inwood-207 (A) to Far Rockaway", "A02S", "H11S"},
		{"Flushing-Main St (7) to Bay Ridge-95 St (R)", "701S", "R45S"},
	}

	var total time.Duration
	for _, c := range cases {
		start := time.Now()
		js := tt.Plan(PlanRequest{From: c.from, To: c.to, DepartAt: depart})
		elapsed := time.Since(start)
		total += elapsed

		if len(js) == 0 {
			t.Errorf("%s: no journey found", c.name)
			continue
		}
		best := js[0]
		for _, j := range js {
			if j.ArriveSecs < best.ArriveSecs {
				best = j
			}
		}
		mins := (best.ArriveSecs - int32(depart.Hour()*3600+depart.Minute()*60)) / 60
		var routes []string
		for _, l := range best.Legs {
			if !l.IsTransfer {
				routes = append(routes, l.RouteID)
			}
		}
		t.Logf("%-42s %3d min, %d transfers, via %v  (%v, %d options)",
			c.name, mins, best.Transfers, routes, elapsed.Round(time.Microsecond), len(js))

		if mins <= 0 || mins > 180 {
			t.Errorf("%s: %d minutes is not a plausible journey", c.name, mins)
		}
		if best.ArriveSecs <= best.DepartSecs {
			t.Errorf("%s: arrives before it departs", c.name)
		}
		for i := 1; i < len(best.Legs); i++ {
			if best.Legs[i].DepartSecs != 0 && best.Legs[i].DepartSecs < best.Legs[i-1].ArriveSecs {
				t.Errorf("%s: leg %d departs before the previous one arrives", c.name, i)
			}
		}
	}
	t.Logf("mean query %v across %d journeys", (total / time.Duration(len(cases))).Round(time.Microsecond), len(cases))
}
