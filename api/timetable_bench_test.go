package main

import (
	"os"
	"runtime"
	"testing"
	"time"
)

// TestTimetableAgainstRealFeed measures the build against an actual extracted
// GTFS feed. Skipped unless GTFS_DIR points at one, so CI and ordinary `go test`
// runs are unaffected — the feed is 36 MB and not in the repo.
//
//	unzip gtfs_subway.zip -d /tmp/gtfs && GTFS_DIR=/tmp/gtfs go test -run RealFeed -v ./api
//
// Recorded on 2026-09-11 against the July 2026 feed:
//
//	build 227ms | patterns 218 | trips 20,621 | platforms 989 | services 7 | footpaths 1,522
//	heap retained +9.9 MB | allocated during build 270 MB
//
// Retained is what lives on the 512 MB machine, and 9.9 MB is comfortable.
// Allocated is cumulative churn through the build, not a high-water mark — it is
// reported instead of a peak because a peak read from HeapAlloc right after the
// build depends entirely on whether the collector happened to run, and measured
// 92 MB and 150 MB on consecutive runs of the same code.
//
// Most of that churn is the per-trip stop-time map, which is garbage the moment
// the patterns exist. If startup memory ever becomes a constraint, the fix is to
// stream stop_times.txt into patterns rather than materializing every row first.
func TestTimetableAgainstRealFeed(t *testing.T) {
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

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)

	start := time.Now()
	tt, err := BuildTimetable(read("stop_times.txt"), read("trips.txt"),
		read("transfers.txt"), read("calendar.txt"), read("calendar_dates.txt"))
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	elapsed := time.Since(start)
	runtime.GC()
	runtime.ReadMemStats(&after)

	footpaths := 0
	for _, list := range tt.Transfers {
		footpaths += len(list)
	}

	t.Logf("build %v | patterns %d | trips %d | platforms %d | services %d | footpaths %d",
		elapsed.Round(time.Millisecond), len(tt.Patterns), tt.TripCount(),
		len(tt.Stops), len(tt.Services), footpaths)
	t.Logf("heap retained +%.1f MB | allocated during build %.0f MB",
		float64(after.HeapAlloc-before.HeapAlloc)/1024/1024,
		float64(after.TotalAlloc-before.TotalAlloc)/1024/1024)

	// Shape assertions, so a feed change that guts the timetable fails loudly.
	// RAPTOR scans patterns per round, so that count is the one that governs
	// whether the algorithm is cheap.
	if len(tt.Patterns) < 150 || len(tt.Patterns) > 400 {
		t.Errorf("pattern count %d is outside the expected range", len(tt.Patterns))
	}
	if tt.TripCount() < 15000 {
		t.Errorf("trip count %d looks truncated", tt.TripCount())
	}
	if len(tt.Stops) < 900 {
		t.Errorf("platform count %d looks truncated", len(tt.Stops))
	}
	if footpaths == 0 {
		t.Error("no footpaths: transfers failed to expand to platforms")
	}
	runtime.KeepAlive(tt)
}
