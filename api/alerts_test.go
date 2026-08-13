package main

import (
	"testing"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"
)

// ── helpers ──────────────────────────────────────────────────────────────────

// buildMercury encodes a Mercury extension blob the way MTA's feed does, so the
// parser is exercised against real wire bytes rather than a mock.
func buildMercury(alertType string, updatedAt, displayBefore int64, periodText string) []byte {
	var inner []byte
	if updatedAt != 0 {
		inner = protowire.AppendTag(inner, mercuryUpdatedAt, protowire.VarintType)
		inner = protowire.AppendVarint(inner, uint64(updatedAt))
	}
	if alertType != "" {
		inner = protowire.AppendTag(inner, mercuryAlertType, protowire.BytesType)
		inner = protowire.AppendString(inner, alertType)
	}
	if displayBefore != 0 {
		inner = protowire.AppendTag(inner, mercuryDisplayBefore, protowire.VarintType)
		inner = protowire.AppendVarint(inner, uint64(displayBefore))
	}
	if periodText != "" {
		// TranslatedString{ 1: Translation{ 1: text, 2: lang } }
		var tr []byte
		tr = protowire.AppendTag(tr, 1, protowire.BytesType)
		tr = protowire.AppendString(tr, periodText)
		tr = protowire.AppendTag(tr, 2, protowire.BytesType)
		tr = protowire.AppendString(tr, "en")

		var ts []byte
		ts = protowire.AppendTag(ts, 1, protowire.BytesType)
		ts = protowire.AppendBytes(ts, tr)

		inner = protowire.AppendTag(inner, mercuryActivePeriodTx, protowire.BytesType)
		inner = protowire.AppendBytes(inner, ts)
	}

	var out []byte
	out = protowire.AppendTag(out, mercuryField, protowire.BytesType)
	out = protowire.AppendBytes(out, inner)
	return out
}

func translated(text string) *gtfs.TranslatedString {
	lang := "en"
	return &gtfs.TranslatedString{
		Translation: []*gtfs.TranslatedString_Translation{{Text: &text, Language: &lang}},
	}
}

func alertEntity(id string, a *gtfs.Alert) *gtfs.FeedEntity {
	return &gtfs.FeedEntity{Id: &id, Alert: a}
}

// ── readMercury ──────────────────────────────────────────────────────────────

func TestReadMercury(t *testing.T) {
	blob := buildMercury("Planned - Reroute", 1786656875, 3600, "Sep 8 - 11, Weekdays")
	m := readMercury(blob)

	if m.alertType != "Planned - Reroute" {
		t.Errorf("alertType = %q, want %q", m.alertType, "Planned - Reroute")
	}
	if m.updatedAt != 1786656875 {
		t.Errorf("updatedAt = %d, want 1786656875", m.updatedAt)
	}
	if m.displayBefore != 3600 {
		t.Errorf("displayBefore = %d, want 3600", m.displayBefore)
	}
	if m.periodText != "Sep 8 - 11, Weekdays" {
		t.Errorf("periodText = %q", m.periodText)
	}
}

func TestReadMercuryMissingOrJunk(t *testing.T) {
	// The extension is not part of the public spec; unreadable input must
	// degrade to a zero value rather than panic or error.
	cases := map[string][]byte{
		"nil":            nil,
		"empty":          {},
		"no 1001 field":  {0x08, 0x01},
		"truncated blob": {0xca, 0x3e, 0x40, 0x01},
	}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			m := readMercury(b)
			if m.alertType != "" || m.updatedAt != 0 || m.periodText != "" {
				t.Errorf("expected zero value, got %+v", m)
			}
		})
	}
}

func TestTranslationTextPrefersPlainEnglish(t *testing.T) {
	// The feed ships an "en-html" variant alongside "en". Selecting it would
	// put third-party markup into the DOM, so "en" must win.
	var trHTML []byte
	trHTML = protowire.AppendTag(trHTML, 1, protowire.BytesType)
	trHTML = protowire.AppendString(trHTML, "<p>markup</p>")
	trHTML = protowire.AppendTag(trHTML, 2, protowire.BytesType)
	trHTML = protowire.AppendString(trHTML, "en-html")

	var trPlain []byte
	trPlain = protowire.AppendTag(trPlain, 1, protowire.BytesType)
	trPlain = protowire.AppendString(trPlain, "plain text")
	trPlain = protowire.AppendTag(trPlain, 2, protowire.BytesType)
	trPlain = protowire.AppendString(trPlain, "en")

	var ts []byte
	ts = protowire.AppendTag(ts, 1, protowire.BytesType)
	ts = protowire.AppendBytes(ts, trHTML)
	ts = protowire.AppendTag(ts, 1, protowire.BytesType)
	ts = protowire.AppendBytes(ts, trPlain)

	if got := translationText(ts); got != "plain text" {
		t.Errorf("translationText = %q, want %q", got, "plain text")
	}
}

// ── isSurfaced ───────────────────────────────────────────────────────────────

func tr(start, end uint64) *gtfs.TimeRange {
	r := &gtfs.TimeRange{}
	if start != 0 {
		r.Start = &start
	}
	if end != 0 {
		r.End = &end
	}
	return r
}

func TestIsSurfaced(t *testing.T) {
	now := time.Unix(1_000_000, 0)

	tests := []struct {
		name          string
		periods       []*gtfs.TimeRange
		displayBefore int64
		want          bool
	}{
		{"no periods is always surfaced", nil, 0, true},
		{"inside a period", []*gtfs.TimeRange{tr(999_000, 1_001_000)}, 0, true},
		{"before a period", []*gtfs.TimeRange{tr(1_002_000, 1_003_000)}, 0, false},
		{"after a period", []*gtfs.TimeRange{tr(900_000, 950_000)}, 0, false},
		{"open-ended end", []*gtfs.TimeRange{tr(999_000, 0)}, 0, true},
		{"open-ended start", []*gtfs.TimeRange{tr(0, 1_001_000)}, 0, true},
		{
			"displayBefore brings an upcoming period into view",
			[]*gtfs.TimeRange{tr(1_003_000, 1_004_000)}, 3600, true,
		},
		{
			"displayBefore still too early",
			[]*gtfs.TimeRange{tr(1_010_000, 1_011_000)}, 3600, false,
		},
		{
			"any of several periods counts",
			[]*gtfs.TimeRange{tr(800_000, 810_000), tr(999_000, 1_001_000)}, 0, true,
		},
		{
			"none of several periods counts",
			[]*gtfs.TimeRange{tr(800_000, 810_000), tr(1_100_000, 1_200_000)}, 0, false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isSurfaced(tc.periods, tc.displayBefore, now); got != tc.want {
				t.Errorf("isSurfaced = %v, want %v", got, tc.want)
			}
		})
	}
}

// ── alertKind ────────────────────────────────────────────────────────────────

func TestAlertKind(t *testing.T) {
	if got := alertKind("lmm:planned_work:33970"); got != "planned" {
		t.Errorf("planned_work → %q", got)
	}
	if got := alertKind("lmm:alert:263008:26"); got != "incident" {
		t.Errorf("alert → %q", got)
	}
	// Unrecognised IDs default to incident: showing a live-looking alert that
	// is actually planned is a smaller error than hiding a real disruption.
	if got := alertKind("something-else"); got != "incident" {
		t.Errorf("unknown → %q", got)
	}
}

// ── parseAlerts ──────────────────────────────────────────────────────────────

func TestParseAlertsUsesMercuryLabel(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	a := &gtfs.Alert{
		ActivePeriod: []*gtfs.TimeRange{tr(999_000, 1_001_000)},
		HeaderText:   translated("Uptown [B][Q] trains are delayed"),
		InformedEntity: []*gtfs.EntitySelector{
			{RouteId: strptr("B"), StopId: strptr("D24")},
			{RouteId: strptr("Q"), StopId: strptr("D24")},
		},
	}
	a.ProtoReflect().SetUnknown(buildMercury("Delays", 1_000_000, 0, ""))

	got := parseAlerts(&gtfs.FeedMessage{Entity: []*gtfs.FeedEntity{
		alertEntity("lmm:alert:1", a),
	}}, now)

	if len(got) != 1 {
		t.Fatalf("got %d alerts, want 1", len(got))
	}
	if got[0].Label != "Delays" {
		t.Errorf("Label = %q, want Delays", got[0].Label)
	}
	if got[0].Kind != "incident" {
		t.Errorf("Kind = %q", got[0].Kind)
	}
	if !got[0].Surfaced {
		t.Error("expected surfaced")
	}
	if len(got[0].RouteIDs) != 2 {
		t.Errorf("RouteIDs = %v, want B and Q", got[0].RouteIDs)
	}
	// Both informed entities name the same stop; it must appear once.
	if len(got[0].StopIDs) != 1 || got[0].StopIDs[0] != "D24" {
		t.Errorf("StopIDs = %v, want [D24]", got[0].StopIDs)
	}
}

func TestParseAlertsFallsBackWithoutMercury(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	msg := &gtfs.FeedMessage{Entity: []*gtfs.FeedEntity{
		alertEntity("lmm:planned_work:1", &gtfs.Alert{HeaderText: translated("work")}),
		alertEntity("lmm:alert:2", &gtfs.Alert{HeaderText: translated("problem")}),
	}}
	got := parseAlerts(msg, now)

	labels := map[string]string{}
	for _, a := range got {
		labels[a.Kind] = a.Label
	}
	if labels["planned"] != "Planned work" {
		t.Errorf("planned label = %q", labels["planned"])
	}
	if labels["incident"] != "Service change" {
		t.Errorf("incident label = %q", labels["incident"])
	}
}

func TestParseAlertsSortsSurfacedAndIncidentsFirst(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	future := []*gtfs.TimeRange{tr(2_000_000, 2_100_000)}
	current := []*gtfs.TimeRange{tr(999_000, 1_001_000)}

	msg := &gtfs.FeedMessage{Entity: []*gtfs.FeedEntity{
		alertEntity("lmm:planned_work:future", &gtfs.Alert{ActivePeriod: future}),
		alertEntity("lmm:planned_work:now", &gtfs.Alert{ActivePeriod: current}),
		alertEntity("lmm:alert:now", &gtfs.Alert{ActivePeriod: current}),
	}}
	got := parseAlerts(msg, now)

	if got[0].ID != "lmm:alert:now" {
		t.Errorf("first = %q, want the surfaced incident", got[0].ID)
	}
	if got[2].ID != "lmm:planned_work:future" {
		t.Errorf("last = %q, want the unsurfaced alert", got[2].ID)
	}
}

func TestParseAlertsHandlesNilAndEmpty(t *testing.T) {
	if got := parseAlerts(nil, time.Now()); len(got) != 0 {
		t.Errorf("nil feed → %d alerts", len(got))
	}
	if got := parseAlerts(&gtfs.FeedMessage{}, time.Now()); len(got) != 0 {
		t.Errorf("empty feed → %d alerts", len(got))
	}
	// A FeedEntity carrying only a trip update must be skipped, not counted.
	msg := &gtfs.FeedMessage{Entity: []*gtfs.FeedEntity{{Id: strptr("x")}}}
	if got := parseAlerts(msg, time.Now()); len(got) != 0 {
		t.Errorf("non-alert entity → %d alerts", len(got))
	}
}

// ── summarise ────────────────────────────────────────────────────────────────

func TestSummarise(t *testing.T) {
	alerts := []Alert{
		{Kind: "incident", Label: "Delays", RouteIDs: []string{"B", "Q"}, Surfaced: true},
		{Kind: "planned", Label: "Planned - Reroute", RouteIDs: []string{"7"}, Surfaced: true},
		{Kind: "planned", Label: "Planned - Reroute", RouteIDs: []string{"N"}, Surfaced: false},
		{Kind: "planned", Label: "Planned - Reroute", RouteIDs: []string{"L"}, Surfaced: false},
	}
	trunks, upcoming := summarise(alerts)

	byTrunk := map[string]TrunkStatus{}
	for _, tk := range trunks {
		byTrunk[tk.Trunk] = tk
	}

	// B spans BDFM, Q spans NQRW — one alert counts once per trunk it touches.
	if byTrunk["BDFM"].Status != "incident" || byTrunk["BDFM"].Count != 1 {
		t.Errorf("BDFM = %+v", byTrunk["BDFM"])
	}
	if byTrunk["NQRW"].Status != "incident" {
		t.Errorf("NQRW = %+v, want incident from the Q", byTrunk["NQRW"])
	}
	if byTrunk["7"].Status != "planned" || byTrunk["7"].Count != 1 {
		t.Errorf("7 = %+v", byTrunk["7"])
	}
	// A single alert shows its label instead of a count.
	if byTrunk["7"].Label != "Planned - Reroute" {
		t.Errorf("7 label = %q", byTrunk["7"].Label)
	}
	// Unsurfaced planned work must not mark a trunk as disrupted.
	if byTrunk["L"].Status != "none" || byTrunk["L"].Count != 0 {
		t.Errorf("L = %+v, want untouched", byTrunk["L"])
	}
	if upcoming != 2 {
		t.Errorf("upcoming = %d, want 2", upcoming)
	}
	if len(trunks) != len(trunkOrder) {
		t.Errorf("got %d trunks, want %d", len(trunks), len(trunkOrder))
	}
}

func TestSummariseIncidentBeatsPlannedOnSameTrunk(t *testing.T) {
	alerts := []Alert{
		{Kind: "planned", RouteIDs: []string{"1"}, Surfaced: true},
		{Kind: "incident", RouteIDs: []string{"2"}, Surfaced: true},
	}
	trunks, _ := summarise(alerts)
	for _, tk := range trunks {
		if tk.Trunk == "123" {
			if tk.Status != "incident" {
				t.Errorf("status = %q, want incident to win", tk.Status)
			}
			if tk.Count != 2 {
				t.Errorf("count = %d, want 2", tk.Count)
			}
			if tk.Label != "" {
				t.Errorf("label = %q, want empty when count > 1", tk.Label)
			}
		}
	}
}

func TestSummariseNoAlerts(t *testing.T) {
	trunks, upcoming := summarise(nil)
	if upcoming != 0 {
		t.Errorf("upcoming = %d", upcoming)
	}
	for _, tk := range trunks {
		if tk.Status != "none" || tk.Count != 0 {
			t.Errorf("%s = %+v, want none/0", tk.Trunk, tk)
		}
	}
}

// ── round trip through proto ─────────────────────────────────────────────────

// The extension survives a marshal/unmarshal cycle as unknown bytes, which is
// exactly how it reaches us from the wire.
func TestMercurySurvivesProtoRoundTrip(t *testing.T) {
	a := &gtfs.Alert{HeaderText: translated("x")}
	a.ProtoReflect().SetUnknown(buildMercury("Part Suspended", 42, 60, "tonight"))

	raw, err := proto.Marshal(&gtfs.FeedMessage{
		Header: &gtfs.FeedHeader{GtfsRealtimeVersion: strptr("2.0")},
		Entity: []*gtfs.FeedEntity{alertEntity("lmm:alert:1", a)},
	})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeFeed(raw)
	if err != nil {
		t.Fatal(err)
	}
	m := readMercury(decoded.GetEntity()[0].GetAlert().ProtoReflect().GetUnknown())
	if m.alertType != "Part Suspended" || m.periodText != "tonight" || m.displayBefore != 60 {
		t.Errorf("after round trip: %+v", m)
	}
}

func strptr(s string) *string { return &s }
