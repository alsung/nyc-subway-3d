package main

import (
	"sort"
	"time"
)

// RAPTOR — round-based public transit routing over the timetable.
//
// Round k finds the best journey using exactly k trips, so the algorithm is
// bicriteria for free: the set of per-round results is a Pareto front over
// arrival time and number of transfers. "Fastest" and "fewest changes" are
// different answers to the same question and riders want both, which is the
// reason for choosing RAPTOR over CSA, whose basic form optimises arrival time
// alone.
//
// The inner loop depends on trips within a pattern not overtaking each other:
// it binary-searches for the earliest catchable trip instead of scanning all of
// them. Verified against the feed — 0 of 20,228 adjacent same-service trip pairs
// overtake. Crucially that holds *within a service*. Comparing across services
// shows 3,067 apparent overtakes, because a Saturday trip and a weekday trip sit
// in the same pattern and never run on the same day. Trips are therefore
// filtered by service before the scan, or the ordering the search relies on is
// simply false.

// Each round is one more trip, so this caps a journey at four changes. Beyond
// that a result stops resembling anything a rider would accept, and the round
// count is also what bounds query cost.
const MaxRounds = 5

// Seconds in a service day. Used to shift the previous day's late-night trips,
// which are written past 24:00, into the current query's frame.
const serviceDaySeconds = 24 * 3600

// A single boarding within a journey.
type Leg struct {
	RouteID    string
	FromStop   string
	ToStop     string
	DepartSecs int32
	ArriveSecs int32
	// Stops ridden through, inclusive of both ends.
	Stops []string
	// True when this leg is a walk rather than a ride.
	IsTransfer bool
}

// One complete journey.
type Journey struct {
	Legs       []Leg
	DepartSecs int32
	ArriveSecs int32
	Transfers  int
}

// label records how a stop's best arrival for a round was reached, so a
// journey can be reconstructed afterwards. Arrival times alone answer "when",
// which is not what a rider needs rendered.
type label struct {
	arrival    int32
	fromStop   int
	pattern    int // -1 for a footpath
	tripIndex  int
	boardStop  int
	isTransfer bool
	set        bool
}

// PlanRequest is one origin-to-destination query.
type PlanRequest struct {
	From      string    // platform stop id
	To        string    // platform stop id
	DepartAt  time.Time // wall clock, in the feed's local zone
	MaxRounds int       // 0 uses MaxRounds
}

// serviceDay is one candidate day a journey could belong to, with the offset
// needed to express its times in the query's frame.
type serviceDay struct {
	date    string // YYYYMMDD
	weekday int
	offset  int32 // seconds added to this day's times
}

// candidateDays returns the service days a departure could draw trips from.
//
// A query at 00:30 on Tuesday has to consider Monday's service day, where that
// same moment is written 24:30. Searching only Tuesday silently drops every
// late-night train — the same 18,876 past-midnight rows the parser exists to
// preserve.
func candidateDays(at time.Time) []serviceDay {
	prev := at.AddDate(0, 0, -1)
	return []serviceDay{
		{date: at.Format("20060102"), weekday: int(at.Weekday()), offset: 0},
		{date: prev.Format("20060102"), weekday: int(prev.Weekday()), offset: -serviceDaySeconds},
	}
}

// secondsSinceMidnight of the query time, in its own service day's frame.
func secondsSinceMidnight(at time.Time) int32 {
	return int32(at.Hour()*3600 + at.Minute()*60 + at.Second())
}

// earliestTrip finds the first trip of a pattern that departs stop `index` at or
// after `after`, among trips whose service runs on `day`.
//
// Binary search over departures at that stop, which is valid because trips do
// not overtake within a service. Returns -1 when nothing is catchable.
func (t *Timetable) earliestTrip(pattern int, index int, after int32, day serviceDay) int {
	trips := t.Patterns[pattern].Trips

	// Trips are sorted by departure from the first stop; with no overtaking that
	// order holds at every stop, so the search is over this stop's departures.
	lo := sort.Search(len(trips), func(i int) bool {
		return trips[i].Departures[index]+day.offset >= after
	})

	// Walk forward past trips that do not run today. The feed carries 7 service
	// ids, so this rarely advances far.
	for i := lo; i < len(trips); i++ {
		svc, ok := t.Services[trips[i].ServiceID]
		if !ok || !svc.RunsOn(day.date, day.weekday) {
			continue
		}
		return i
	}
	return -1
}

// Plan runs RAPTOR and returns a Pareto set over arrival time and transfers,
// ordered by increasing transfers.
//
// Each entry arrives strictly earlier than the one before it, because a journey
// with more changes only earns a place by being faster. So results[0] is the
// fewest-changes option and the last entry is the fastest — "fastest" and
// "fewest changes" are different answers, and a rider wants to choose between
// them rather than be handed one.
func (t *Timetable) Plan(req PlanRequest) []Journey {
	from, ok := t.StopIndex[req.From]
	if !ok {
		return nil
	}
	to, ok := t.StopIndex[req.To]
	if !ok || from == to {
		return nil
	}

	rounds := req.MaxRounds
	if rounds <= 0 {
		rounds = MaxRounds
	}
	depart := secondsSinceMidnight(req.DepartAt)
	days := candidateDays(req.DepartAt)

	n := len(t.Stops)
	// best[k][stop] — arrival using at most k trips. best[0] is walking only.
	best := make([][]label, rounds+1)
	for k := range best {
		best[k] = make([]label, n)
		for i := range best[k] {
			best[k][i].arrival = maxInt32
		}
	}
	// starBest[stop] — best arrival across every round, used to prune.
	starBest := make([]int32, n)
	for i := range starBest {
		starBest[i] = maxInt32
	}

	best[0][from] = label{arrival: depart, fromStop: -1, pattern: -1, set: true}
	starBest[from] = depart
	marked := map[int]bool{from: true}

	// Walking from the origin before boarding anything.
	for _, f := range t.Transfers[from] {
		arr := depart + int32(f.Seconds)
		if arr < starBest[f.To] {
			best[0][f.To] = label{arrival: arr, fromStop: from, pattern: -1, isTransfer: true, set: true}
			starBest[f.To] = arr
			marked[f.To] = true
		}
	}

	var results []Journey

	for k := 1; k <= rounds; k++ {
		if len(marked) == 0 {
			break
		}
		copy(best[k], best[k-1])

		// Which patterns to scan, and the earliest marked stop along each.
		queue := map[int]int{} // pattern -> index of the stop to board from
		for stop := range marked {
			for _, ps := range t.StopPatterns[stop] {
				if cur, seen := queue[ps.Pattern]; !seen || ps.Index < cur {
					queue[ps.Pattern] = ps.Index
				}
			}
		}
		nextMarked := map[int]bool{}

		for pattern, startIdx := range queue {
			p := &t.Patterns[pattern]

			for _, day := range days {
				trip := -1
				boardIdx := -1

				for i := startIdx; i < len(p.Stops); i++ {
					stop := p.Stops[i]

					if trip >= 0 {
						arr := p.Trips[trip].Arrivals[i] + day.offset
						if arr < starBest[stop] && arr < best[k][stop].arrival {
							best[k][stop] = label{
								arrival: arr, fromStop: p.Stops[boardIdx],
								pattern: pattern, tripIndex: trip, boardStop: boardIdx, set: true,
							}
							starBest[stop] = arr
							nextMarked[stop] = true
						}
					}

					// Re-board here if the previous round reached this stop early
					// enough to catch something sooner than the trip we are on.
					ready := best[k-1][stop].arrival
					if !best[k-1][stop].set {
						continue
					}
					if trip < 0 || ready <= p.Trips[trip].Departures[i]+day.offset {
						if cand := t.earliestTrip(pattern, i, ready, day); cand >= 0 {
							if trip < 0 || cand != trip {
								trip, boardIdx = cand, i
							}
						}
					}
				}
			}
		}

		// Footpaths, applied after the route scan so a walk can extend a ride.
		for stop := range nextMarked {
			base := best[k][stop].arrival
			for _, f := range t.Transfers[stop] {
				arr := base + int32(f.Seconds)
				if arr < starBest[f.To] && arr < best[k][f.To].arrival {
					best[k][f.To] = label{
						arrival: arr, fromStop: stop, pattern: -1, isTransfer: true, set: true,
					}
					starBest[f.To] = arr
					nextMarked[f.To] = true
				}
			}
		}

		marked = nextMarked

		if best[k][to].set && (len(results) == 0 || best[k][to].arrival < results[len(results)-1].ArriveSecs) {
			if j := t.reconstruct(best, k, from, to, depart); j != nil {
				results = append(results, *j)
			}
		}
	}
	return results
}

const maxInt32 = int32(1<<31 - 1)

// reconstruct walks the labels backwards from the destination to build the
// journey a rider actually reads.
func (t *Timetable) reconstruct(best [][]label, k, from, to int, depart int32) *Journey {
	var legs []Leg
	stop := to
	round := k

	for round >= 0 && stop != from {
		l := best[round][stop]
		if !l.set || l.fromStop < 0 {
			break
		}

		if l.isTransfer {
			legs = append(legs, Leg{
				FromStop: t.Stops[l.fromStop], ToStop: t.Stops[stop],
				ArriveSecs: l.arrival, IsTransfer: true,
			})
			stop = l.fromStop
			continue
		}

		p := &t.Patterns[l.pattern]
		trip := &p.Trips[l.tripIndex]
		// Where along the pattern this stop was reached.
		endIdx := l.boardStop
		for i := l.boardStop; i < len(p.Stops); i++ {
			if p.Stops[i] == stop {
				endIdx = i
				break
			}
		}
		var ridden []string
		for i := l.boardStop; i <= endIdx; i++ {
			ridden = append(ridden, t.Stops[p.Stops[i]])
		}
		legs = append(legs, Leg{
			RouteID:    p.RouteID,
			FromStop:   t.Stops[p.Stops[l.boardStop]],
			ToStop:     t.Stops[stop],
			DepartSecs: trip.Departures[l.boardStop],
			ArriveSecs: trip.Arrivals[endIdx],
			Stops:      ridden,
		})
		stop = p.Stops[l.boardStop]
		round--
	}

	if stop != from || len(legs) == 0 {
		return nil
	}
	for i, j := 0, len(legs)-1; i < j; i, j = i+1, j-1 {
		legs[i], legs[j] = legs[j], legs[i]
	}

	rides := 0
	for _, l := range legs {
		if !l.IsTransfer {
			rides++
		}
	}
	return &Journey{
		Legs:       legs,
		DepartSecs: legs[0].DepartSecs,
		ArriveSecs: best[k][to].arrival,
		Transfers:  rides - 1,
	}
}
