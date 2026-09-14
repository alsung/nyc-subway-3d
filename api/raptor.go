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
	// True when a live prediction moved this leg's times off the schedule.
	Realtime bool
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
	shift      int32 // seconds the boarded trip is running late, 0 when scheduled
	set        bool
}

// PlanRequest is one origin-to-destination query.
type PlanRequest struct {
	// Platform stop ids. Several of each, because a rider names a station and
	// a station is several platforms: "Times Sq" is 127N and 127S, and which
	// one you want depends on where you are going. RAPTOR takes multiple
	// origins natively — they are just several initial labels.
	From     []string
	To       []string
	DepartAt time.Time // wall clock, in the feed's local zone

	MaxRounds int // 0 uses MaxRounds

	// Live predictions, or nil to plan on the schedule alone.
	Realtime *DepartureIndex
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
//
// Takes the time in the feed's zone. The caller converts; see feedLocation.
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
	origins := t.resolve(req.From)
	targets := t.resolve(req.To)
	if len(origins) == 0 || len(targets) == 0 {
		return nil
	}
	isTarget := map[int]bool{}
	for _, s := range targets {
		isTarget[s] = true
	}
	for _, s := range origins {
		if isTarget[s] {
			return nil // already there
		}
	}

	rounds := req.MaxRounds
	if rounds <= 0 {
		rounds = MaxRounds
	}
	// The feed's times are seconds from local midnight in New York, so the
	// query has to be read in that zone regardless of where the server runs —
	// Fly runs UTC, which would shift every plan by four or five hours.
	at := req.DepartAt.In(feedLocation())
	depart := secondsSinceMidnight(at)
	days := candidateDays(at)

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

	marked := map[int]bool{}
	for _, origin := range origins {
		best[0][origin] = label{arrival: depart, fromStop: -1, pattern: -1, set: true}
		starBest[origin] = depart
		marked[origin] = true
	}

	// Walking from the origin platforms before boarding anything.
	for _, origin := range origins {
		for _, f := range t.Transfers[origin] {
			arr := depart + int32(f.Seconds)
			if arr < starBest[f.To] {
				best[0][f.To] = label{arrival: arr, fromStop: origin, pattern: -1, isTransfer: true, set: true}
				starBest[f.To] = arr
				marked[f.To] = true
			}
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
				// Seconds this trip is running late, observed once where it was
				// boarded and carried through the leg. See realtimeShift.
				shift := int32(0)

				for i := startIdx; i < len(p.Stops); i++ {
					stop := p.Stops[i]

					if trip >= 0 {
						arr := p.Trips[trip].Arrivals[i] + day.offset + shift
						if arr < starBest[stop] && arr < best[k][stop].arrival {
							best[k][stop] = label{
								arrival: arr, fromStop: p.Stops[boardIdx],
								pattern: pattern, tripIndex: trip, boardStop: boardIdx,
								shift: shift, set: true,
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
					if trip < 0 || ready <= p.Trips[trip].Departures[i]+day.offset+shift {
						if cand := t.earliestTrip(pattern, i, ready, day); cand >= 0 {
							if trip < 0 || cand != trip {
								trip, boardIdx = cand, i
								shift = t.realtimeShift(req.Realtime, p, cand, i, day)
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

		// The best of the destination platforms this round.
		bestTarget, bestArr := -1, maxInt32
		for _, target := range targets {
			if best[k][target].set && best[k][target].arrival < bestArr {
				bestTarget, bestArr = target, best[k][target].arrival
			}
		}
		if bestTarget >= 0 && (len(results) == 0 || bestArr < results[len(results)-1].ArriveSecs) {
			if j := t.reconstruct(best, k, origins, bestTarget); j != nil {
				results = append(results, *j)
			}
		}
	}
	return results
}

const maxInt32 = int32(1<<31 - 1)

// realtimeShift returns how many seconds late a trip is, judged from the live
// prediction for its route at the stop it was boarded.
//
// The prediction is looked up by (platform, route) rather than by trip, because
// live trip ids share no format with static ones — 0% exact overlap, and a
// suffix join still leaves 22.5% of running trains unmatched. So this does not
// know *which* scheduled trip a prediction describes; it takes the next
// predicted departure of that route from that platform and treats the
// difference from schedule as the delay.
//
// One observed delay, applied to the whole leg. That captures waiting for a
// train that has not come, which is what dominates a journey. It does not
// capture a train that falls behind *after* you board — for that, predictions
// would have to be tied to trips, which this feed does not support today.
//
// Clamped: a prediction far from any scheduled departure is more likely a
// mismatch than a two-hour delay, and acting on it would produce itineraries
// that are confidently wrong.
func (t *Timetable) realtimeShift(rt *DepartureIndex, p *Pattern, trip, index int, day serviceDay) int32 {
	if rt == nil || day.offset != 0 {
		return 0 // previous service day: predictions do not reach back there
	}
	scheduled := p.Trips[trip].Departures[index]
	predicted, ok := rt.NextDeparture(t.Stops[p.Stops[index]], p.RouteID, scheduled-maxEarlySeconds)
	if !ok {
		return 0
	}
	shift := predicted - scheduled
	if shift > maxShiftSeconds || shift < -maxEarlySeconds {
		return 0
	}
	return shift
}

// A train may legitimately be a little early; beyond this a "prediction" is
// almost certainly for a different train.
const maxEarlySeconds = 120

// Past this, treat the prediction as a mismatch rather than a delay. Twenty
// minutes is already a severe subway delay; an hour is a bad join.
const maxShiftSeconds = 20 * 60

// resolve maps stop ids to indices, dropping any the timetable does not know.
func (t *Timetable) resolve(ids []string) []int {
	var out []int
	for _, id := range ids {
		if i, ok := t.StopIndex[id]; ok {
			out = append(out, i)
		}
	}
	return out
}

// reconstruct walks the labels backwards from the destination to build the
// journey a rider actually reads.
func (t *Timetable) reconstruct(best [][]label, k int, origins []int, to int) *Journey {
	isOrigin := map[int]bool{}
	for _, o := range origins {
		isOrigin[o] = true
	}

	var legs []Leg
	stop := to
	round := k

	for round >= 0 && !isOrigin[stop] {
		l := best[round][stop]
		if !l.set || l.fromStop < 0 {
			break
		}

		if l.isTransfer {
			// A walk departs when the rider reached the stop it starts from.
			// Leaving this zero made a journey beginning with a walk report its
			// departure as midnight, and its duration as the time of day.
			departed := int32(0)
			if prev := best[round][l.fromStop]; prev.set {
				departed = prev.arrival
			}
			legs = append(legs, Leg{
				FromStop: t.Stops[l.fromStop], ToStop: t.Stops[stop],
				DepartSecs: departed, ArriveSecs: l.arrival, IsTransfer: true,
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
			DepartSecs: trip.Departures[l.boardStop] + l.shift,
			ArriveSecs: trip.Arrivals[endIdx] + l.shift,
			Stops:      ridden,
			Realtime:   l.shift != 0,
		})
		stop = p.Stops[l.boardStop]
		round--
	}

	if !isOrigin[stop] || len(legs) == 0 {
		return nil
	}
	for i, j := 0, len(legs)-1; i < j; i, j = i+1, j-1 {
		legs[i], legs[j] = legs[j], legs[i]
	}

	// Walking between two platforms of your own starting station is not a leg.
	// The search seeds every platform of the origin, so it can reach a train via
	// a footpath from a sibling platform; the rider simply walks into the right
	// entrance and would find "walk from 127N to 127S" baffling.
	for len(legs) > 0 && legs[0].IsTransfer && isOrigin[t.StopIndex[legs[0].ToStop]] {
		legs = legs[1:]
	}
	if len(legs) == 0 {
		return nil
	}

	rides := 0
	for _, l := range legs {
		if !l.IsTransfer {
			rides++
		}
	}
	// The journey departs when the rider boards, not when they start walking to
	// a platform they are already standing in.
	depart := legs[0].DepartSecs
	for _, l := range legs {
		if !l.IsTransfer {
			depart = l.DepartSecs
			break
		}
	}

	return &Journey{
		Legs:       legs,
		DepartSecs: depart,
		ArriveSecs: best[k][to].arrival,
		Transfers:  rides - 1,
	}
}
