package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// planLeg is one leg of an itinerary as the frontend reads it.
type planLeg struct {
	// "ride" or "walk".
	Kind     string   `json:"kind"`
	RouteID  string   `json:"routeId,omitempty"`
	FromStop string   `json:"fromStop"`
	ToStop   string   `json:"toStop"`
	DepartAt string   `json:"departAt,omitempty"` // HH:MM:SS, service-day clock
	ArriveAt string   `json:"arriveAt"`
	Stops    []string `json:"stops,omitempty"`

	// Where this leg's times came from. "realtime" when a live prediction moved
	// them, "scheduled" otherwise — the distinction matters to a rider and the
	// UI should not have to guess.
	Timing string `json:"timing"`
}

type planJourney struct {
	Transfers int       `json:"transfers"`
	DepartAt  string    `json:"departAt"`
	ArriveAt  string    `json:"arriveAt"`
	Minutes   int       `json:"minutes"`
	Legs      []planLeg `json:"legs"`
}

type planResponse struct {
	From     string        `json:"from"`
	To       string        `json:"to"`
	Journeys []planJourney `json:"journeys"`
	// Age of the realtime feeds behind this plan, in seconds. -1 when planning
	// on the schedule alone.
	FeedAgeSeconds int `json:"feedAgeSeconds"`
}

// platformsFor expands a station id into the platform ids the timetable knows.
//
// A rider names a station; RAPTOR indexes platforms. "Times Sq" is 127N and
// 127S, and which one you want depends on where you are going — so both are
// offered and the algorithm picks. Passing a platform id straight through is
// also allowed, since the frontend may already know the direction.
func platformsFor(tt *Timetable, id string) []string {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	if _, ok := tt.StopIndex[id]; ok {
		return []string{id}
	}
	var out []string
	for _, suffix := range []string{"N", "S"} {
		if _, ok := tt.StopIndex[id+suffix]; ok {
			out = append(out, id+suffix)
		}
	}
	return out
}

func secsToClock(secs int32) string {
	if secs < 0 {
		return ""
	}
	h := secs / 3600
	m := (secs % 3600) / 60
	s := secs % 60
	return time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC).
		Add(time.Duration(h)*time.Hour + time.Duration(m)*time.Minute + time.Duration(s)*time.Second).
		Format("15:04:05")
}

func handlePlan(w http.ResponseWriter, r *http.Request) {
	tt := currentTimetable()
	if tt == nil {
		http.Error(w, "timetable not loaded yet", http.StatusServiceUnavailable)
		return
	}

	q := r.URL.Query()
	fromID, toID := q.Get("from"), q.Get("to")
	if fromID == "" || toID == "" {
		http.Error(w, "from and to are required", http.StatusBadRequest)
		return
	}

	from := platformsFor(tt, fromID)
	to := platformsFor(tt, toID)
	if len(from) == 0 {
		http.Error(w, "unknown origin station "+fromID, http.StatusNotFound)
		return
	}
	if len(to) == 0 {
		http.Error(w, "unknown destination station "+toID, http.StatusNotFound)
		return
	}

	departAt := time.Now().In(feedLocation())
	if raw := q.Get("departAt"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			http.Error(w, "departAt must be RFC3339", http.StatusBadRequest)
			return
		}
		departAt = parsed.In(feedLocation())
	}

	rt := cachedDepartures()
	_, lastFeed := cachedFeeds()
	feedAge := -1
	if rt != nil && !lastFeed.IsZero() {
		feedAge = int(time.Since(lastFeed).Seconds())
	}

	journeys := tt.Plan(PlanRequest{From: from, To: to, DepartAt: departAt, Realtime: rt})

	resp := planResponse{From: fromID, To: toID, FeedAgeSeconds: feedAge, Journeys: []planJourney{}}
	for _, j := range journeys {
		pj := planJourney{
			Transfers: j.Transfers,
			DepartAt:  secsToClock(j.DepartSecs),
			ArriveAt:  secsToClock(j.ArriveSecs),
			Minutes:   int((j.ArriveSecs - j.DepartSecs) / 60),
			Legs:      []planLeg{},
		}
		for _, l := range j.Legs {
			kind, timing := "ride", "scheduled"
			if l.IsTransfer {
				kind = "walk"
			} else if l.Realtime {
				timing = "realtime"
			}
			pj.Legs = append(pj.Legs, planLeg{
				Kind: kind, RouteID: l.RouteID,
				FromStop: l.FromStop, ToStop: l.ToStop,
				DepartAt: secsToClock(l.DepartSecs), ArriveAt: secsToClock(l.ArriveSecs),
				Stops: l.Stops, Timing: timing,
			})
		}
		resp.Journeys = append(resp.Journeys, pj)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
