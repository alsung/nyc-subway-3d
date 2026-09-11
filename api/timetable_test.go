package main

import (
	"fmt"
	"strings"
	"testing"
)

// ── trap 1: times past midnight ─────────────────────────────────────────────

func TestParseGTFSTimePastMidnight(t *testing.T) {
	// The feed's latest arrival is 28:02:00 and 18,876 rows sit at or past
	// midnight. A clock-time parse does not error on these — it quietly drops
	// the late-night network.
	cases := []struct {
		in   string
		want int32
	}{
		{"00:00:00", 0},
		{"10:03:30", 10*3600 + 3*60 + 30},
		{"23:59:59", 86399},
		{"24:00:00", 86400},
		{"25:30:00", 91800},
		{"28:02:00", 100920},
	}
	for _, c := range cases {
		got, err := parseGTFSTime(c.in)
		if err != nil {
			t.Errorf("%s: unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: got %d, want %d", c.in, got, c.want)
		}
	}
}

func TestParseGTFSTimeRejectsGarbage(t *testing.T) {
	for _, in := range []string{"", "10:00", "aa:00:00", "10:xx:00", "10:60:00", "10:00:60", "-1:00:00"} {
		if _, err := parseGTFSTime(in); err == nil {
			t.Errorf("%q: expected an error, got none", in)
		}
	}
}

func TestLateNightTripSurvivesParsing(t *testing.T) {
	st := "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n" +
		"late,101N,1,25:10:00,25:10:00\n" +
		"late,103N,2,25:14:00,25:14:00\n"
	byTrip, err := parseStopTimes([]byte(st))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	rows := byTrip["late"]
	if len(rows) != 2 {
		t.Fatalf("expected 2 stop times, got %d", len(rows))
	}
	if rows[0].arrival != 25*3600+10*60 {
		t.Errorf("late-night arrival lost: got %d", rows[0].arrival)
	}
	if rows[1].arrival <= rows[0].arrival {
		t.Error("arrival times should increase along the trip")
	}
}

// ── trap 2 and 3: transfers are written in parent stations ──────────────────

func TestTransfersExpandToPlatforms(t *testing.T) {
	// stop_times names platforms (101N, 101S); transfers names the parent (101).
	// Joining literally matches nothing at all, because no platform id ever
	// appears in transfers.txt.
	stopIndex := map[string]int{"101N": 0, "101S": 1, "103N": 2, "103S": 3}
	raw := "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n101,101,2,180\n"

	tr, err := parseTransfers([]byte(raw), stopIndex)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	total := 0
	for _, list := range tr {
		total += len(list)
	}
	if total != 2 {
		t.Fatalf("expected 101N<->101S as 2 footpaths, got %d", total)
	}
	if len(tr[0]) != 1 || tr[0][0].To != 1 || tr[0][0].Seconds != 180 {
		t.Errorf("101N should reach 101S in 180s, got %+v", tr[0])
	}
	// A platform never transfers to itself.
	for from, list := range tr {
		for _, x := range list {
			if x.To == from {
				t.Errorf("stop %d transfers to itself", from)
			}
		}
	}
}

func TestCrossStationTransfersExpand(t *testing.T) {
	// 150 of the feed's 613 transfers join different stations. 127 -> 725 is the
	// Times Sq 1/2/3 platforms to the 7, an out-of-system walk that makes many
	// journeys possible at all.
	stopIndex := map[string]int{"127N": 0, "127S": 1, "725N": 2, "725S": 3}
	raw := "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n127,725,2,300\n"

	tr, err := parseTransfers([]byte(raw), stopIndex)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tr[0]) != 2 || len(tr[1]) != 2 {
		t.Fatalf("each 127 platform should reach both 725 platforms, got %v", tr)
	}
	for _, x := range tr[0] {
		if x.Seconds != 300 {
			t.Errorf("expected the feed's 300s walk, got %d", x.Seconds)
		}
	}
}

func TestTransfersDefaultWhenTimeBlank(t *testing.T) {
	stopIndex := map[string]int{"101N": 0, "101S": 1}
	raw := "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n101,101,2,\n"
	tr, err := parseTransfers([]byte(raw), stopIndex)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tr[0]) != 1 || tr[0][0].Seconds != defaultTransferSeconds {
		t.Errorf("expected the default walk, got %+v", tr[0])
	}
}

// ── pattern grouping ────────────────────────────────────────────────────────

func TestBuildPatternsGroupsIdenticalSequences(t *testing.T) {
	byTrip := map[string][]stopTimeRow{
		"a": {{stopID: "1N", seq: 1, departure: 100}, {stopID: "2N", seq: 2, arrival: 200}},
		"b": {{stopID: "1N", seq: 1, departure: 300}, {stopID: "2N", seq: 2, arrival: 400}},
		"c": {{stopID: "1S", seq: 1, departure: 100}, {stopID: "2S", seq: 2, arrival: 200}},
	}
	meta := map[string][2]string{
		"a": {"1", "Weekday"}, "b": {"1", "Weekday"}, "c": {"1", "Weekday"},
	}
	patterns, stops, index := buildPatterns(byTrip, meta)

	if len(patterns) != 2 {
		t.Fatalf("expected 2 patterns (one per direction), got %d", len(patterns))
	}
	if len(stops) != 4 || len(index) != 4 {
		t.Errorf("expected 4 distinct platforms, got %d", len(stops))
	}
	for _, p := range patterns {
		if len(p.Trips) == 2 {
			if p.Trips[0].Departures[0] > p.Trips[1].Departures[0] {
				t.Error("trips within a pattern must be sorted by first departure")
			}
		}
	}
}

func TestBuildPatternsSkipsSingleStopTrips(t *testing.T) {
	byTrip := map[string][]stopTimeRow{"stub": {{stopID: "1N", seq: 1}}}
	meta := map[string][2]string{"stub": {"1", "Weekday"}}
	patterns, _, _ := buildPatterns(byTrip, meta)
	if len(patterns) != 0 {
		t.Errorf("a one-stop trip carries nobody anywhere; got %d patterns", len(patterns))
	}
}

func TestBuildPatternsIsDeterministic(t *testing.T) {
	byTrip := map[string][]stopTimeRow{}
	meta := map[string][2]string{}
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("t%02d", i)
		byTrip[id] = []stopTimeRow{
			{stopID: fmt.Sprintf("%dN", i%3), seq: 1, departure: int32(i * 60)},
			{stopID: fmt.Sprintf("%dN", (i%3)+10), seq: 2, arrival: int32(i*60 + 120)},
		}
		meta[id] = [2]string{fmt.Sprintf("r%d", i%3), "Weekday"}
	}
	first, _, _ := buildPatterns(byTrip, meta)
	second, _, _ := buildPatterns(byTrip, meta)

	if len(first) != len(second) {
		t.Fatalf("pattern count differs between runs")
	}
	for i := range first {
		if first[i].RouteID != second[i].RouteID || first[i].Trips[0].TripID != second[i].Trips[0].TripID {
			t.Fatalf("pattern order is not stable at index %d", i)
		}
	}
}

// ── calendar ────────────────────────────────────────────────────────────────

func TestCalendarRunsOn(t *testing.T) {
	cal := "service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date\n" +
		"Weekday,0,1,1,1,1,1,0,20260101,20261231\n"
	dates := "service_id,date,exception_type\nWeekday,20261225,2\nWeekday,20260704,1\n"

	svc, err := parseCalendar([]byte(cal), []byte(dates))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	w := svc["Weekday"]

	if !w.RunsOn("20260908", 1) { // a Monday
		t.Error("Weekday should run on a Monday")
	}
	if w.RunsOn("20260912", 6) { // a Saturday
		t.Error("Weekday should not run on a Saturday")
	}
	if w.RunsOn("20261225", 5) {
		t.Error("an exception_type 2 date must remove the service")
	}
	if !w.RunsOn("20260704", 6) {
		t.Error("an exception_type 1 date must add the service, overriding the weekly pattern")
	}
	if w.RunsOn("20250101", 3) {
		t.Error("a date before start_date should not run")
	}
}

// ── end to end, and the header BOM ──────────────────────────────────────────

func TestBuildTimetableEndToEnd(t *testing.T) {
	// The MTA feed writes a BOM before the first header field, so this fixture
	// carries one: without handling it, every column lookup misses.
	st := bomPrefix + "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n" +
		"t1,101N,1,10:00:00,10:00:00\n" +
		"t1,103N,2,10:04:00,10:04:00\n" +
		"t2,101N,1,25:00:00,25:00:00\n" +
		"t2,103N,2,25:04:00,25:04:00\n"
	trips := "route_id,trip_id,service_id\n1,t1,Weekday\n1,t2,Weekday\n"
	transfers := "from_stop_id,to_stop_id,transfer_type,min_transfer_time\n101,103,2,240\n"
	cal := "service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date\n" +
		"Weekday,0,1,1,1,1,1,0,20260101,20261231\n"

	tt, err := BuildTimetable([]byte(st), []byte(trips), []byte(transfers), []byte(cal), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tt.Patterns) != 1 {
		t.Fatalf("expected 1 pattern, got %d", len(tt.Patterns))
	}
	if got := tt.TripCount(); got != 2 {
		t.Errorf("expected 2 trips, got %d", got)
	}
	if len(tt.Stops) != 2 {
		t.Errorf("expected 2 platforms, got %d", len(tt.Stops))
	}
	// The late-night trip must still be there, at its full past-midnight time.
	late := tt.Patterns[0].Trips[1]
	if late.Departures[0] != 25*3600 {
		t.Errorf("late-night trip lost its time: got %d", late.Departures[0])
	}
	if len(tt.Services) != 1 {
		t.Errorf("expected 1 service, got %d", len(tt.Services))
	}
	total := 0
	for _, list := range tt.Transfers {
		total += len(list)
	}
	if total == 0 {
		t.Error("station-level transfer did not expand to any platform pair")
	}
}

func TestBuildTimetableRejectsMissingColumns(t *testing.T) {
	_, err := BuildTimetable([]byte("trip_id,stop_id\nt1,101N\n"), nil, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "missing column") {
		t.Errorf("expected a missing-column error, got %v", err)
	}
}

// ── the served/routing split ────────────────────────────────────────────────

func TestServedAndRoutingFilesAreDisjoint(t *testing.T) {
	// The safety of this change is that stop_times.txt is parsed and dropped.
	// gtfsFiles is what /gtfs/* hands to clients, and stop_times alone is 36 MB.
	for name := range routingGTFSFiles {
		if servedGTFSFiles[name] {
			t.Errorf("%s is both served and routing-only", name)
		}
	}
	for _, name := range []string{"stop_times.txt", "transfers.txt", "calendar.txt", "calendar_dates.txt"} {
		if !routingGTFSFiles[name] {
			t.Errorf("%s should be a routing file", name)
		}
		if servedGTFSFiles[name] {
			t.Errorf("%s must never be served", name)
		}
	}
	if !wantedGTFSFile("stop_times.txt") || wantedGTFSFile("agency.txt") {
		t.Error("wantedGTFSFile should accept routing files and reject the rest")
	}
}
