package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func withToyTimetable(t *testing.T) func() {
	t.Helper()
	gtfsMu.Lock()
	prev := timetable
	timetable = toyTimetable(t)
	gtfsMu.Unlock()
	return func() {
		gtfsMu.Lock()
		timetable = prev
		gtfsMu.Unlock()
	}
}

func getPlan(t *testing.T, query string) (*httptest.ResponseRecorder, planResponse) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/plan?"+query, nil)
	rec := httptest.NewRecorder()
	handlePlan(rec, req)

	var body planResponse
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode body: %v — %s", err, rec.Body.String())
		}
	}
	return rec, body
}

func TestHandlePlanReturnsAnItinerary(t *testing.T) {
	defer withToyTimetable(t)()
	rec, body := getPlan(t, "from=A&to=C&departAt=2026-09-09T09:50:00-04:00")

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d — %s", rec.Code, rec.Body.String())
	}
	if len(body.Journeys) == 0 {
		t.Fatal("expected at least one journey")
	}
	j := body.Journeys[0]
	if j.ArriveAt != "10:10:00" {
		t.Errorf("expected arrival 10:10:00, got %s", j.ArriveAt)
	}
	if len(j.Legs) != 1 || j.Legs[0].Kind != "ride" || j.Legs[0].RouteID != "X" {
		t.Fatalf("expected one ride on X, got %+v", j.Legs)
	}
	// With no realtime index loaded, every leg must say so rather than implying
	// a precision the plan does not have.
	if j.Legs[0].Timing != "scheduled" {
		t.Errorf("expected scheduled timing, got %q", j.Legs[0].Timing)
	}
	if body.FeedAgeSeconds != -1 {
		t.Errorf("expected feedAge -1 without realtime, got %d", body.FeedAgeSeconds)
	}
}

func TestHandlePlanMarksWalkingLegs(t *testing.T) {
	defer withToyTimetable(t)()
	_, body := getPlan(t, "from=A&to=E&departAt=2026-09-09T09:50:00-04:00")
	if len(body.Journeys) == 0 {
		t.Fatal("expected a journey")
	}
	var kinds []string
	for _, l := range body.Journeys[len(body.Journeys)-1].Legs {
		kinds = append(kinds, l.Kind)
	}
	var sawWalk bool
	for _, k := range kinds {
		if k == "walk" {
			sawWalk = true
		}
	}
	if !sawWalk {
		t.Errorf("expected a walk leg between B and D, got %v", kinds)
	}
}

func TestHandlePlanValidatesInput(t *testing.T) {
	defer withToyTimetable(t)()

	cases := []struct {
		name  string
		query string
		want  int
	}{
		{"missing both", "", http.StatusBadRequest},
		{"missing to", "from=A", http.StatusBadRequest},
		{"unknown origin", "from=ZZ&to=C", http.StatusNotFound},
		{"unknown destination", "from=A&to=ZZ", http.StatusNotFound},
		{"unparseable departAt", "from=A&to=C&departAt=tomorrow", http.StatusBadRequest},
	}
	for _, c := range cases {
		rec, _ := getPlan(t, c.query)
		if rec.Code != c.want {
			t.Errorf("%s: expected %d, got %d", c.name, c.want, rec.Code)
		}
	}
}

func TestHandlePlanWithoutTimetable(t *testing.T) {
	gtfsMu.Lock()
	prev := timetable
	timetable = nil
	gtfsMu.Unlock()
	defer func() {
		gtfsMu.Lock()
		timetable = prev
		gtfsMu.Unlock()
	}()

	rec, _ := getPlan(t, "from=A&to=C")
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 before the timetable loads, got %d", rec.Code)
	}
}

func TestHandlePlanReturnsEmptyArrayNotNull(t *testing.T) {
	// A JSON null would make the frontend branch on it; an empty array just
	// renders nothing.
	defer withToyTimetable(t)()
	rec, _ := getPlan(t, "from=A&to=C&departAt=2026-09-12T09:50:00-04:00") // a Saturday
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(rec.Body.Bytes(), &raw)
	if string(raw["journeys"]) != "[]" {
		t.Errorf("expected an empty array, got %s", raw["journeys"])
	}
}

func TestPlatformsForExpandsAStation(t *testing.T) {
	tt := toyTimetable(t)
	// The toy feed has no directional suffixes, so a known id passes through.
	if got := platformsFor(tt, "A"); len(got) != 1 || got[0] != "A" {
		t.Errorf("expected a known id to pass through, got %v", got)
	}
	if got := platformsFor(tt, "nope"); got != nil {
		t.Errorf("expected nil for an unknown station, got %v", got)
	}
	if got := platformsFor(tt, "  "); got != nil {
		t.Errorf("expected nil for blank input, got %v", got)
	}
}

func TestPlatformsForExpandsDirectionalIDs(t *testing.T) {
	// The real feed's stops are platforms: a rider names "127" and the
	// timetable knows 127N and 127S.
	st := "trip_id,stop_id,stop_sequence,arrival_time,departure_time\n" +
		"n1,127N,1,10:00:00,10:00:00\nn1,128N,2,10:04:00,10:04:00\n" +
		"s1,127S,1,10:00:00,10:00:00\ns1,126S,2,10:04:00,10:04:00\n"
	trips := "route_id,trip_id,service_id\n1,n1,Weekday\n1,s1,Weekday\n"
	cal := "service_id,sunday,monday,tuesday,wednesday,thursday,friday,saturday,start_date,end_date\n" +
		"Weekday,0,1,1,1,1,1,0,20260101,20261231\n"
	tt, err := BuildTimetable([]byte(st), []byte(trips), []byte(""), []byte(cal), nil)
	if err != nil {
		// transfers.txt is empty here, which has no header; tolerate that.
		tt, err = BuildTimetable([]byte(st), []byte(trips),
			[]byte("from_stop_id,to_stop_id\n"), []byte(cal), nil)
		if err != nil {
			t.Fatalf("build: %v", err)
		}
	}

	got := platformsFor(tt, "127")
	if len(got) != 2 {
		t.Fatalf("expected both platforms of 127, got %v", got)
	}
	if got[0] != "127N" || got[1] != "127S" {
		t.Errorf("expected 127N and 127S, got %v", got)
	}
	// A caller that already knows the direction gets exactly that platform.
	if one := platformsFor(tt, "127S"); len(one) != 1 || one[0] != "127S" {
		t.Errorf("expected a directional id to pass through, got %v", one)
	}
}
