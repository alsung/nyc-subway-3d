package main

import (
	"testing"
	"time"
)

// A small hand-built network where every answer is known by construction:
//
//	route X:  A --5m--> B --5m--> C          departs A at 10:00 and 10:30
//	route Y:  D --5m--> E                    departs D at 10:12 and 10:40
//	footpath: B <-> D, 120s
//
// So A->C is one ride, and A->E needs a change at B/D.
func toyTimetable(t *testing.T) *Timetable {
	t.Helper()
	st := "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n" +
		"x1,A,1,10:00:00,10:00:00\nx1,B,2,10:05:00,10:05:00\nx1,C,3,10:10:00,10:10:00\n" +
		"x2,A,1,10:30:00,10:30:00\nx2,B,2,10:35:00,10:35:00\nx2,C,3,10:40:00,10:40:00\n" +
		"y1,D,1,10:12:00,10:12:00\ny1,E,2,10:17:00,10:17:00\n" +
		"y2,D,1,10:40:00,10:40:00\ny2,E,2,10:45:00,10:45:00\n"
	trips := "route_id,trip_id,service_id\nX,x1,Weekday\nX,x2,Weekday\nY,y1,Weekday\nY,y2,Weekday\n"
	transfers := "from_stop_id,to_stop_id,transfer_type,min_transfer_time\nB,D,2,120\nD,B,2,120\n"
	cal := "service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date\n" +
		"Weekday,0,1,1,1,1,1,0,20260101,20261231\n"

	tt, err := BuildTimetable([]byte(st), []byte(trips), []byte(transfers), []byte(cal), nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	return tt
}

// A Wednesday, inside the toy calendar's date range.
func at(hhmm string) time.Time {
	d, _ := time.Parse("2006-01-02 15:04", "2026-09-09 "+hhmm)
	return d
}

func hhmmss(secs int32) string {
	return time.Date(0, 1, 1, 0, 0, int(secs), 0, time.UTC).Format("15:04:05")
}

func TestPlanDirectRide(t *testing.T) {
	tt := toyTimetable(t)
	js := tt.Plan(PlanRequest{From: "A", To: "C", DepartAt: at("09:50")})
	if len(js) == 0 {
		t.Fatal("expected a journey")
	}
	j := js[0]
	if j.Transfers != 0 {
		t.Errorf("A to C is one ride; got %d transfers", j.Transfers)
	}
	if got := hhmmss(j.ArriveSecs); got != "10:10:00" {
		t.Errorf("expected arrival 10:10:00, got %s", got)
	}
	if len(j.Legs) != 1 || j.Legs[0].RouteID != "X" {
		t.Fatalf("expected a single X leg, got %+v", j.Legs)
	}
	if len(j.Legs[0].Stops) != 3 {
		t.Errorf("expected the ridden stops A,B,C; got %v", j.Legs[0].Stops)
	}
}

func TestPlanWaitsForTheNextTrip(t *testing.T) {
	// Arriving after the 10:00 departure must catch the 10:30, not report the
	// earlier train.
	tt := toyTimetable(t)
	js := tt.Plan(PlanRequest{From: "A", To: "C", DepartAt: at("10:15")})
	if len(js) == 0 {
		t.Fatal("expected a journey")
	}
	if got := hhmmss(js[0].ArriveSecs); got != "10:40:00" {
		t.Errorf("expected the 10:30 train arriving 10:40:00, got %s", got)
	}
	// Waiting is the thing a static-weight graph cannot express, and the reason
	// this is a timetable algorithm rather than Dijkstra.
	if js[0].DepartSecs != 10*3600+30*60 {
		t.Errorf("expected to board at 10:30, got %s", hhmmss(js[0].DepartSecs))
	}
}

func TestPlanTransfersAcrossAFootpath(t *testing.T) {
	tt := toyTimetable(t)
	js := tt.Plan(PlanRequest{From: "A", To: "E", DepartAt: at("09:50")})
	if len(js) == 0 {
		t.Fatal("expected a journey from A to E")
	}
	j := js[len(js)-1]
	if got := hhmmss(j.ArriveSecs); got != "10:17:00" {
		t.Errorf("expected arrival 10:17:00 via the 10:12 Y train, got %s", got)
	}
	if j.Transfers != 1 {
		t.Errorf("A to E needs one change; got %d", j.Transfers)
	}

	var routes []string
	var walked bool
	for _, l := range j.Legs {
		if l.IsTransfer {
			walked = true
			continue
		}
		routes = append(routes, l.RouteID)
	}
	if len(routes) != 2 || routes[0] != "X" || routes[1] != "Y" {
		t.Errorf("expected X then Y, got %v", routes)
	}
	if !walked {
		t.Error("expected a walking leg between B and D")
	}
}

func TestPlanRespectsTransferTime(t *testing.T) {
	// The X train reaches B at 10:05 and the walk to D costs 120s, so the
	// earliest boardable Y is the 10:12. A zero-cost transfer would be a lie
	// riders notice the first time they miss a train because of it.
	tt := toyTimetable(t)
	js := tt.Plan(PlanRequest{From: "A", To: "E", DepartAt: at("09:50")})
	if len(js) == 0 {
		t.Fatal("expected a journey")
	}
	for _, l := range js[len(js)-1].Legs {
		if l.RouteID == "Y" && l.DepartSecs < 10*3600+7*60 {
			t.Errorf("boarded Y at %s, before the walk could finish", hhmmss(l.DepartSecs))
		}
	}
}

func TestPlanUnknownOrIdenticalStops(t *testing.T) {
	tt := toyTimetable(t)
	if js := tt.Plan(PlanRequest{From: "A", To: "ZZ", DepartAt: at("10:00")}); js != nil {
		t.Error("unknown destination should yield no journey")
	}
	if js := tt.Plan(PlanRequest{From: "ZZ", To: "C", DepartAt: at("10:00")}); js != nil {
		t.Error("unknown origin should yield no journey")
	}
	if js := tt.Plan(PlanRequest{From: "A", To: "A", DepartAt: at("10:00")}); js != nil {
		t.Error("origin equal to destination should yield no journey")
	}
}

func TestPlanNoServiceOnThatDay(t *testing.T) {
	tt := toyTimetable(t)
	// A Saturday: the toy calendar runs weekdays only.
	sat, _ := time.Parse("2006-01-02 15:04", "2026-09-12 09:50")
	if js := tt.Plan(PlanRequest{From: "A", To: "C", DepartAt: sat}); len(js) != 0 {
		t.Errorf("expected no service on a Saturday, got %d journeys", len(js))
	}
}

func TestEarliestTripSkipsTripsNotRunningToday(t *testing.T) {
	tt := toyTimetable(t)
	day := serviceDay{date: "20260912", weekday: 6} // Saturday
	if got := tt.earliestTrip(0, 0, 0, day); got != -1 {
		t.Errorf("expected no catchable trip on a Saturday, got index %d", got)
	}
	wed := serviceDay{date: "20260909", weekday: 3}
	if got := tt.earliestTrip(0, 0, 0, wed); got < 0 {
		t.Error("expected a catchable trip on a Wednesday")
	}
}

func TestStopPatternsIndex(t *testing.T) {
	tt := toyTimetable(t)
	if len(tt.StopPatterns) != len(tt.Stops) {
		t.Fatalf("index has %d entries for %d stops", len(tt.StopPatterns), len(tt.Stops))
	}
	b := tt.StopIndex["B"]
	if len(tt.StopPatterns[b]) != 1 {
		t.Fatalf("B should be served by one pattern, got %d", len(tt.StopPatterns[b]))
	}
	if tt.StopPatterns[b][0].Index != 1 {
		t.Errorf("B is the second stop of route X; got index %d", tt.StopPatterns[b][0].Index)
	}
}
