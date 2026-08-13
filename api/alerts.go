package main

// Service alerts from MTA's dedicated GTFS-RT alerts feed.
//
// Two things about this feed shape the code below.
//
// First, the standard GTFS-RT `cause` and `effect` fields are UNKNOWN on every
// alert MTA publishes, so they cannot be used to classify anything. The usable
// labels live in MTA's "Mercury" extension at field 1001, which the generated
// bindings do not know about — so it is read off the decoded message's unknown
// bytes with protowire. That extension also carries a pre-rendered, human
// readable active-period string ("Sep 8 - 11 and Sep 14 - 18, Weekdays, 7:45 AM
// to 9:30 AM..."), already in Eastern Time, which saves reimplementing MTA's
// period collapsing and timezone handling.
//
// Second, the overwhelming majority of alerts are future planned work: a live
// sample had 201 alerts of which only 7 were currently in effect. Anything
// user-facing therefore has to filter by active period, or every line in the
// system reads as disrupted.
//
// Field 1001 is not part of the public GTFS-RT spec, so every value read from
// it is treated as optional. A missing or malformed extension degrades to the
// entity-ID prefix for classification and never drops the alert.

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/encoding/protowire"
)

const alertsURL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts"

// Alerts change far less often than train positions, and the payload is an
// order of magnitude larger than a single real-time feed.
const alertsRefreshInterval = 60 * time.Second

// Mercury extension field numbers, observed on the live feed.
const (
	mercuryField          = 1001 // extension on Alert
	mercuryUpdatedAt      = 2    // varint, unix seconds
	mercuryAlertType      = 3    // string: "Delays", "Planned - Reroute", ...
	mercuryDisplayBefore  = 7    // varint, seconds before a period to surface
	mercuryActivePeriodTx = 8    // TranslatedString, human-readable period text
)

// Alert is one service alert, flattened for the frontend.
type Alert struct {
	ID string `json:"id"`
	// "incident" for live disruptions, "planned" for scheduled work.
	Kind string `json:"kind"`
	// MTA's own label — "Delays", "Planned - Stops Skipped". Falls back to a
	// generic label derived from Kind when the extension is unreadable.
	Label       string `json:"label"`
	Header      string `json:"header"`
	Description string `json:"description,omitempty"`
	// PeriodText is MTA's pre-rendered schedule phrase, already in ET. Empty
	// for most live incidents, which have no meaningful schedule.
	PeriodText string   `json:"periodText,omitempty"`
	RouteIDs   []string `json:"routeIds"`
	StopIDs    []string `json:"stopIds"`
	UpdatedAt  string   `json:"updatedAt,omitempty"`
	// Surfaced reports whether the alert is in effect now (per MTA's own
	// display-before rule). Consumers asking for upcoming work get both, and
	// can tell them apart without recomputing the rule.
	Surfaced bool `json:"surfaced"`
}

type alertsResponse struct {
	Alerts    []Alert `json:"alerts"`
	UpdatedAt string  `json:"updatedAt"`
}

// TrunkStatus is one row of the status list: a colour-grouped set of routes and
// how many alerts currently touch it.
type TrunkStatus struct {
	Trunk    string   `json:"trunk"`
	RouteIDs []string `json:"routeIds"`
	// "none", "planned", or "incident" — worst wins, since a live disruption
	// matters more than scheduled work on the same trunk.
	Status string `json:"status"`
	Count  int    `json:"count"`
	// Label is the single alert's label when exactly one is active, so the UI
	// can show "Delays" rather than "1 alert".
	Label string `json:"label,omitempty"`
}

type summaryResponse struct {
	Trunks    []TrunkStatus `json:"trunks"`
	UpdatedAt string        `json:"updatedAt"`
	// Upcoming counts planned work not yet in effect — the "Planned service
	// changes" entry in the status list.
	Upcoming int `json:"upcoming"`
}

// Trunk grouping mirrors how the system is signed and how riders think about
// it: by colour, not by individual route.
var trunkOrder = []string{"ACE", "BDFM", "G", "JZ", "L", "NQRW", "123", "456", "7", "S", "SIR"}

var trunkRoutes = map[string][]string{
	"ACE":  {"A", "C", "E"},
	"BDFM": {"B", "D", "F", "M"},
	"G":    {"G"},
	"JZ":   {"J", "Z"},
	"L":    {"L"},
	"NQRW": {"N", "Q", "R", "W"},
	"123":  {"1", "2", "3"},
	"456":  {"4", "5", "6"},
	"7":    {"7"},
	"S":    {"GS", "FS", "H"},
	"SIR":  {"SI"},
}

var (
	alertsMu        sync.RWMutex
	alertsCache     *gtfs.FeedMessage
	alertsRefreshed time.Time
)

// ── Mercury extension ────────────────────────────────────────────────────────

type mercury struct {
	alertType     string
	updatedAt     int64
	displayBefore int64
	periodText    string
}

// readMercury pulls MTA's extension off an Alert's unknown bytes. Every field
// is optional; a malformed blob yields a zero value rather than an error,
// because a partially-understood alert is still worth showing.
func readMercury(unknown []byte) mercury {
	var m mercury
	blob := fieldBytes(unknown, mercuryField)
	if blob == nil {
		return m
	}
	m.updatedAt = fieldVarint(blob, mercuryUpdatedAt)
	m.displayBefore = fieldVarint(blob, mercuryDisplayBefore)
	if s := fieldBytes(blob, mercuryAlertType); s != nil {
		m.alertType = string(s)
	}
	if tx := fieldBytes(blob, mercuryActivePeriodTx); tx != nil {
		m.periodText = translationText(tx)
	}
	return m
}

// fieldBytes returns the first length-delimited value with the given number.
func fieldBytes(b []byte, want protowire.Number) []byte {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return nil
		}
		b = b[n:]
		if num == want && typ == protowire.BytesType {
			v, k := protowire.ConsumeBytes(b)
			if k < 0 {
				return nil
			}
			return v
		}
		k := protowire.ConsumeFieldValue(num, typ, b)
		if k < 0 {
			return nil
		}
		b = b[k:]
	}
	return nil
}

// fieldVarint returns the first varint with the given number, or 0.
func fieldVarint(b []byte, want protowire.Number) int64 {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return 0
		}
		b = b[n:]
		if num == want && typ == protowire.VarintType {
			v, k := protowire.ConsumeVarint(b)
			if k < 0 {
				return 0
			}
			return int64(v)
		}
		k := protowire.ConsumeFieldValue(num, typ, b)
		if k < 0 {
			return 0
		}
		b = b[k:]
	}
	return 0
}

// translationText extracts the English text from a TranslatedString blob,
// preferring an explicit "en" and falling back to the first translation. The
// feed also ships an "en-html" variant; it is deliberately never selected here,
// because that markup would end up in the DOM.
func translationText(b []byte) string {
	first := ""
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return first
		}
		b = b[n:]
		if num == 1 && typ == protowire.BytesType {
			tr, k := protowire.ConsumeBytes(b)
			if k < 0 {
				return first
			}
			b = b[k:]
			text := string(fieldBytes(tr, 1))
			lang := string(fieldBytes(tr, 2))
			if lang == "en" {
				return text
			}
			if first == "" {
				first = text
			}
			continue
		}
		k := protowire.ConsumeFieldValue(num, typ, b)
		if k < 0 {
			return first
		}
		b = b[k:]
	}
	return first
}

// ── parsing ──────────────────────────────────────────────────────────────────

// isSurfaced reports whether an alert should be shown now, using MTA's own
// rule: a period counts from displayBefore seconds ahead of its start until its
// end. An end of 0 is open-ended, and an alert with no periods at all always
// counts. Multiple periods are OR-ed — planned work often has one per weekend.
func isSurfaced(periods []*gtfs.TimeRange, displayBefore int64, now time.Time) bool {
	if len(periods) == 0 {
		return true
	}
	ts := now.Unix()
	for _, p := range periods {
		start, end := int64(p.GetStart()), int64(p.GetEnd())
		if start != 0 && ts < start-displayBefore {
			continue
		}
		if end != 0 && ts > end {
			continue
		}
		return true
	}
	return false
}

// alertKind classifies from the entity ID, which is the only classification
// signal that does not depend on the extension. MTA namespaces planned work as
// "lmm:planned_work:<id>" and live incidents as "lmm:alert:<id>".
func alertKind(entityID string) string {
	if strings.Contains(entityID, ":planned_work:") {
		return "planned"
	}
	return "incident"
}

// englishText picks the "en" translation from a standard TranslatedString,
// avoiding the "en-html" variant for the same reason as translationText.
func englishText(ts *gtfs.TranslatedString) string {
	if ts == nil {
		return ""
	}
	first := ""
	for _, t := range ts.GetTranslation() {
		if t.GetLanguage() == "en" {
			return t.GetText()
		}
		if first == "" {
			first = t.GetText()
		}
	}
	return first
}

// parseAlerts flattens a decoded alerts feed. Pure: no network, no globals, so
// it is testable directly. Returns alerts sorted with surfaced ones first, then
// incidents ahead of planned work.
func parseAlerts(msg *gtfs.FeedMessage, now time.Time) []Alert {
	if msg == nil {
		return []Alert{}
	}
	out := make([]Alert, 0, len(msg.GetEntity()))

	for _, e := range msg.GetEntity() {
		a := e.GetAlert()
		if a == nil {
			continue
		}
		m := readMercury(a.ProtoReflect().GetUnknown())
		kind := alertKind(e.GetId())

		label := m.alertType
		if label == "" {
			// Extension unreadable — say something true but generic rather
			// than guessing a specific effect from the prose.
			if kind == "planned" {
				label = "Planned work"
			} else {
				label = "Service change"
			}
		}

		routes, stops := informedEntities(a)

		updatedAt := ""
		if m.updatedAt > 0 {
			updatedAt = time.Unix(m.updatedAt, 0).UTC().Format(time.RFC3339)
		}

		out = append(out, Alert{
			ID:          e.GetId(),
			Kind:        kind,
			Label:       label,
			Header:      englishText(a.GetHeaderText()),
			Description: englishText(a.GetDescriptionText()),
			PeriodText:  m.periodText,
			RouteIDs:    routes,
			StopIDs:     stops,
			UpdatedAt:   updatedAt,
			Surfaced:    isSurfaced(a.GetActivePeriod(), m.displayBefore, now),
		})
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Surfaced != out[j].Surfaced {
			return out[i].Surfaced
		}
		return out[i].Kind == "incident" && out[j].Kind != "incident"
	})
	return out
}

// informedEntities collects the distinct routes and stops an alert touches.
// Most entries carry both a route and a stop — "the N, at this station" — so
// they are gathered independently rather than as pairs.
func informedEntities(a *gtfs.Alert) (routes, stops []string) {
	seenR, seenS := map[string]bool{}, map[string]bool{}
	routes, stops = []string{}, []string{}
	for _, ie := range a.GetInformedEntity() {
		if r := ie.GetRouteId(); r != "" && !seenR[r] {
			seenR[r] = true
			routes = append(routes, r)
		}
		// Stop IDs here are parent station IDs with no N/S suffix, so they key
		// directly against the arrival index without normalisation.
		if s := ie.GetStopId(); s != "" && !seenS[s] {
			seenS[s] = true
			stops = append(stops, s)
		}
	}
	sort.Strings(routes)
	sort.Strings(stops)
	return routes, stops
}

// summarise rolls alerts up per trunk for the status list. Only surfaced alerts
// count toward a trunk's status; upcoming planned work is reported separately
// so it does not mark every line as disrupted.
func summarise(alerts []Alert) ([]TrunkStatus, int) {
	routeToTrunk := map[string]string{}
	for trunk, routes := range trunkRoutes {
		for _, r := range routes {
			routeToTrunk[r] = trunk
		}
	}

	counts := map[string]int{}
	worst := map[string]string{}
	labels := map[string]string{}
	upcoming := 0

	for _, al := range alerts {
		if !al.Surfaced {
			if al.Kind == "planned" {
				upcoming++
			}
			continue
		}
		// An alert spanning several trunks counts once per trunk it touches.
		hit := map[string]bool{}
		for _, r := range al.RouteIDs {
			if t, ok := routeToTrunk[r]; ok {
				hit[t] = true
			}
		}
		for t := range hit {
			counts[t]++
			labels[t] = al.Label
			if al.Kind == "incident" || worst[t] == "" {
				if worst[t] != "incident" {
					worst[t] = al.Kind
				}
			}
		}
	}

	rows := make([]TrunkStatus, 0, len(trunkOrder))
	for _, t := range trunkOrder {
		status := worst[t]
		if status == "" {
			status = "none"
		}
		row := TrunkStatus{
			Trunk:    t,
			RouteIDs: trunkRoutes[t],
			Status:   status,
			Count:    counts[t],
		}
		// Exactly one alert: show its label instead of a count.
		if counts[t] == 1 {
			row.Label = labels[t]
		}
		rows = append(rows, row)
	}
	return rows, upcoming
}

// ── cache and refresh ────────────────────────────────────────────────────────

// refreshAlerts replaces the cache only on success, so a transient failure
// leaves the last known good alerts in place rather than blanking the UI.
// Reuses fetchFeed: same protobuf shape, same decode leniency.
func refreshAlerts(ctx context.Context) {
	msg, err := fetchFeed(ctx, alertsURL)
	if err != nil {
		slog.Warn("alerts refresh failed", "err", err)
		return
	}
	alertsMu.Lock()
	alertsCache = msg
	alertsRefreshed = time.Now()
	alertsMu.Unlock()
	slog.Info("alerts refreshed", "entities", len(msg.GetEntity()))
}

func cachedAlerts() (*gtfs.FeedMessage, time.Time) {
	alertsMu.RLock()
	defer alertsMu.RUnlock()
	return alertsCache, alertsRefreshed
}

func startAlertsRefresher(ctx context.Context) {
	refreshAlerts(ctx)

	ticker := time.NewTicker(alertsRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("alerts refresher stopped")
			return
		case <-ticker.C:
			refreshAlerts(ctx)
		}
	}
}
