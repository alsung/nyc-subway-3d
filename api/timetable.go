package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// A compact in-memory timetable, built once at startup and read-only after.
//
// RAPTOR scans patterns and their trips on every round, so everything the inner
// loop touches is an integer index into a slice rather than a map lookup on a
// string. The feed's 989 platform ids become indices at parse time for the same
// reason: string hashing in the round loop would dominate the work the round
// actually does.
type Timetable struct {
	// Stop ids, index-addressable. StopIndex maps the other way.
	Stops     []string
	StopIndex map[string]int

	// One entry per distinct stop sequence. 218 of them across 20,621 trips,
	// which is the number that makes RAPTOR cheap: it scans patterns per round,
	// not trips.
	Patterns []Pattern

	// Footpaths between platforms, indexed by origin stop. Expanded from
	// transfers.txt, which is written in parent stations.
	Transfers [][]Transfer

	// Which service ids run on which dates.
	Services map[string]Service
}

// A group of trips sharing the same ordered stop sequence.
type Pattern struct {
	RouteID string
	Stops   []int  // indices into Timetable.Stops
	Trips   []Trip // sorted by departure from the first stop
}

// One vehicle running a pattern. Arrivals and Departures are parallel to the
// pattern's Stops, in seconds from the start of the service day.
type Trip struct {
	TripID     string
	ServiceID  string
	Arrivals   []int32
	Departures []int32
}

// A walk between two platforms, in seconds.
type Transfer struct {
	To      int
	Seconds int
}

// Which days a service id runs.
type Service struct {
	Days    [7]bool // Sunday..Saturday, matching time.Weekday
	Start   string  // YYYYMMDD
	End     string
	Added   map[string]bool // exception_type 1
	Removed map[string]bool // exception_type 2
}

// parseGTFSTime converts a GTFS HH:MM:SS into seconds from the start of the
// service day.
//
// The hour field is deliberately not bounded at 24. The feed's latest arrival is
// 28:02:00 and 18,876 rows sit at or past midnight — a train that departs
// Tuesday at 01:30 belongs to Monday's service day and is written 25:30:00.
// Parsing these as clock times does not error; it silently drops the entire
// late-night network, which is the worst kind of bug this data can produce.
func parseGTFSTime(s string) (int32, error) {
	s = strings.TrimSpace(s)
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return 0, fmt.Errorf("malformed time %q", s)
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, fmt.Errorf("malformed hour in %q", s)
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil || m < 0 || m > 59 {
		return 0, fmt.Errorf("malformed minute in %q", s)
	}
	sec, err := strconv.Atoi(parts[2])
	if err != nil || sec < 0 || sec > 59 {
		return 0, fmt.Errorf("malformed second in %q", s)
	}
	if h < 0 {
		return 0, fmt.Errorf("negative hour in %q", s)
	}
	return int32(h*3600 + m*60 + sec), nil
}

// The MTA feed writes a UTF-8 byte order mark before the first header field, so
// a naive lookup of "trip_id" misses on every file.
const bomPrefix = "\xef\xbb\xbf"

// columns reads a CSV header into a name -> index map, tolerating that BOM.
func columns(header []string) map[string]int {
	out := make(map[string]int, len(header))
	for i, name := range header {
		out[strings.TrimPrefix(strings.TrimSpace(name), bomPrefix)] = i
	}
	return out
}

func newReader(b []byte) *csv.Reader {
	r := csv.NewReader(strings.NewReader(string(b)))
	r.ReuseRecord = true // 565,093 rows; one allocation per row is 565,093 too many
	r.FieldsPerRecord = -1
	return r
}

type stopTimeRow struct {
	tripID    string
	stopID    string
	seq       int
	arrival   int32
	departure int32
}

// parseStopTimes reads stop_times.txt into per-trip stop sequences.
func parseStopTimes(raw []byte) (map[string][]stopTimeRow, error) {
	r := newReader(raw)
	head, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("stop_times header: %w", err)
	}
	c := columns(head)
	for _, need := range []string{"trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"} {
		if _, ok := c[need]; !ok {
			return nil, fmt.Errorf("stop_times missing column %q", need)
		}
	}

	byTrip := make(map[string][]stopTimeRow, 21000)
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("stop_times row: %w", err)
		}
		seq, err := strconv.Atoi(strings.TrimSpace(rec[c["stop_sequence"]]))
		if err != nil {
			return nil, fmt.Errorf("stop_times stop_sequence: %w", err)
		}
		arr, err := parseGTFSTime(rec[c["arrival_time"]])
		if err != nil {
			return nil, fmt.Errorf("stop_times arrival_time: %w", err)
		}
		dep, err := parseGTFSTime(rec[c["departure_time"]])
		if err != nil {
			return nil, fmt.Errorf("stop_times departure_time: %w", err)
		}
		tripID := rec[c["trip_id"]]
		byTrip[tripID] = append(byTrip[tripID], stopTimeRow{
			tripID: tripID, stopID: rec[c["stop_id"]], seq: seq, arrival: arr, departure: dep,
		})
	}

	for _, rows := range byTrip {
		sort.Slice(rows, func(i, j int) bool { return rows[i].seq < rows[j].seq })
	}
	return byTrip, nil
}

// parseTrips reads trips.txt into trip id -> (route id, service id).
func parseTrips(raw []byte) (map[string][2]string, error) {
	r := newReader(raw)
	head, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("trips header: %w", err)
	}
	c := columns(head)
	for _, need := range []string{"trip_id", "route_id", "service_id"} {
		if _, ok := c[need]; !ok {
			return nil, fmt.Errorf("trips missing column %q", need)
		}
	}

	out := make(map[string][2]string, 21000)
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("trips row: %w", err)
		}
		out[rec[c["trip_id"]]] = [2]string{rec[c["route_id"]], rec[c["service_id"]]}
	}
	return out, nil
}

// buildPatterns groups trips by their ordered stop sequence.
//
// 20,621 trips collapse to 218 patterns, and that ratio is what makes RAPTOR
// cheap: a round scans patterns, not trips, and only descends into a pattern's
// trips to find the earliest catchable one.
//
// Trips within a pattern are sorted by departure from the first stop so that
// search can stop at the first catchable trip rather than scanning all of them.
func buildPatterns(byTrip map[string][]stopTimeRow, tripMeta map[string][2]string) ([]Pattern, []string, map[string]int) {
	stopIndex := map[string]int{}
	var stops []string
	indexOf := func(id string) int {
		if i, ok := stopIndex[id]; ok {
			return i
		}
		stopIndex[id] = len(stops)
		stops = append(stops, id)
		return len(stops) - 1
	}

	type key struct {
		route string
		seq   string
	}
	grouped := map[key]*Pattern{}

	for tripID, rows := range byTrip {
		if len(rows) < 2 {
			continue // a single-stop trip cannot carry anyone anywhere
		}
		meta := tripMeta[tripID]
		routeID, serviceID := meta[0], meta[1]

		idxs := make([]int, len(rows))
		parts := make([]string, len(rows))
		arr := make([]int32, len(rows))
		dep := make([]int32, len(rows))
		for i, row := range rows {
			idxs[i] = indexOf(row.stopID)
			parts[i] = row.stopID
			arr[i] = row.arrival
			dep[i] = row.departure
		}

		k := key{route: routeID, seq: strings.Join(parts, ">")}
		p := grouped[k]
		if p == nil {
			p = &Pattern{RouteID: routeID, Stops: idxs}
			grouped[k] = p
		}
		p.Trips = append(p.Trips, Trip{
			TripID: tripID, ServiceID: serviceID, Arrivals: arr, Departures: dep,
		})
	}

	patterns := make([]Pattern, 0, len(grouped))
	for _, p := range grouped {
		sort.Slice(p.Trips, func(i, j int) bool { return p.Trips[i].Departures[0] < p.Trips[j].Departures[0] })
		patterns = append(patterns, *p)
	}
	// Deterministic order, so two loads of the same feed produce the same
	// timetable and a test can assert on indices.
	sort.Slice(patterns, func(i, j int) bool {
		if patterns[i].RouteID != patterns[j].RouteID {
			return patterns[i].RouteID < patterns[j].RouteID
		}
		if len(patterns[i].Stops) != len(patterns[j].Stops) {
			return len(patterns[i].Stops) > len(patterns[j].Stops)
		}
		return patterns[i].Trips[0].TripID < patterns[j].Trips[0].TripID
	})
	return patterns, stops, stopIndex
}

// parseTransfers expands transfers.txt into platform-to-platform footpaths.
//
// The two files disagree on granularity and nothing warns you about it:
// stop_times names platforms (101N, 101S) while transfers names parent stations
// (101). Joining them literally produces a transfer table that matches nothing,
// because no platform id ever appears in transfers.txt. Every station-level rule
// therefore has to be expanded to the platform pairs it actually connects.
//
// 150 of the feed's 613 transfers join *different* stations — 127 to 725 is the
// Times Sq 1/2/3 platforms to the 7 — and those out-of-system walks are what
// make many journeys possible at all.
func parseTransfers(raw []byte, stopIndex map[string]int) ([][]Transfer, error) {
	// Platform ids are the parent id plus a direction suffix, so group the
	// platforms we actually have by their parent.
	platformsOf := map[string][]int{}
	for id, idx := range stopIndex {
		parent := strings.TrimRight(id, "NS")
		platformsOf[parent] = append(platformsOf[parent], idx)
	}

	r := newReader(raw)
	head, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("transfers header: %w", err)
	}
	c := columns(head)
	for _, need := range []string{"from_stop_id", "to_stop_id"} {
		if _, ok := c[need]; !ok {
			return nil, fmt.Errorf("transfers missing column %q", need)
		}
	}

	out := make([][]Transfer, len(stopIndex))
	seen := map[[2]int]bool{}

	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("transfers row: %w", err)
		}
		from, to := rec[c["from_stop_id"]], rec[c["to_stop_id"]]

		secs := defaultTransferSeconds
		if i, ok := c["min_transfer_time"]; ok && strings.TrimSpace(rec[i]) != "" {
			if v, err := strconv.Atoi(strings.TrimSpace(rec[i])); err == nil {
				secs = v
			}
		}

		for _, a := range platformsOf[from] {
			for _, b := range platformsOf[to] {
				if a == b || seen[[2]int{a, b}] {
					continue
				}
				seen[[2]int{a, b}] = true
				out[a] = append(out[a], Transfer{To: b, Seconds: secs})
			}
		}
	}
	return out, nil
}

// What the feed uses when a transfer carries no min_transfer_time. MTA leaves it
// blank for same-station platform changes, where the walk is short but not free.
const defaultTransferSeconds = 120

// parseCalendar reads calendar.txt and calendar_dates.txt.
//
// Genuinely simple here: the feed carries 7 service ids (Weekday, Saturday,
// Sunday and holiday variants) and 6 exception dates.
func parseCalendar(cal, dates []byte) (map[string]Service, error) {
	out := map[string]Service{}

	r := newReader(cal)
	head, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("calendar header: %w", err)
	}
	c := columns(head)
	dayCols := []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}
	for _, need := range append([]string{"service_id", "start_date", "end_date"}, dayCols...) {
		if _, ok := c[need]; !ok {
			return nil, fmt.Errorf("calendar missing column %q", need)
		}
	}

	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("calendar row: %w", err)
		}
		s := Service{
			Start:   strings.TrimSpace(rec[c["start_date"]]),
			End:     strings.TrimSpace(rec[c["end_date"]]),
			Added:   map[string]bool{},
			Removed: map[string]bool{},
		}
		for i, name := range dayCols {
			s.Days[i] = strings.TrimSpace(rec[c[name]]) == "1"
		}
		out[rec[c["service_id"]]] = s
	}

	if len(dates) == 0 {
		return out, nil
	}

	r = newReader(dates)
	head, err = r.Read()
	if err != nil {
		return nil, fmt.Errorf("calendar_dates header: %w", err)
	}
	c = columns(head)
	for _, need := range []string{"service_id", "date", "exception_type"} {
		if _, ok := c[need]; !ok {
			return nil, fmt.Errorf("calendar_dates missing column %q", need)
		}
	}
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("calendar_dates row: %w", err)
		}
		id := rec[c["service_id"]]
		s, ok := out[id]
		if !ok {
			s = Service{Added: map[string]bool{}, Removed: map[string]bool{}}
		}
		date := strings.TrimSpace(rec[c["date"]])
		switch strings.TrimSpace(rec[c["exception_type"]]) {
		case "1":
			s.Added[date] = true
		case "2":
			s.Removed[date] = true
		}
		out[id] = s
	}
	return out, nil
}

// RunsOn reports whether a service id is active on a YYYYMMDD date with the
// given weekday. Exceptions win over the weekly pattern, which is what makes a
// holiday schedule work.
func (s Service) RunsOn(date string, weekday int) bool {
	if s.Removed[date] {
		return false
	}
	if s.Added[date] {
		return true
	}
	if s.Start != "" && date < s.Start {
		return false
	}
	if s.End != "" && date > s.End {
		return false
	}
	return s.Days[weekday]
}

// BuildTimetable assembles the routing structures from the raw GTFS files.
//
// Pure: it takes bytes and returns data, touching no globals and no network, so
// the whole thing is testable without a feed.
func BuildTimetable(stopTimes, trips, transfers, calendar, calendarDates []byte) (*Timetable, error) {
	byTrip, err := parseStopTimes(stopTimes)
	if err != nil {
		return nil, err
	}
	meta, err := parseTrips(trips)
	if err != nil {
		return nil, err
	}
	patterns, stops, stopIndex := buildPatterns(byTrip, meta)

	tr, err := parseTransfers(transfers, stopIndex)
	if err != nil {
		return nil, err
	}
	svc, err := parseCalendar(calendar, calendarDates)
	if err != nil {
		return nil, err
	}

	return &Timetable{
		Stops: stops, StopIndex: stopIndex,
		Patterns: patterns, Transfers: tr, Services: svc,
	}, nil
}

// TripCount is the number of trips across every pattern.
func (t *Timetable) TripCount() int {
	n := 0
	for _, p := range t.Patterns {
		n += len(p.Trips)
	}
	return n
}
