package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
)

const defaultGTFSStaticURL = "http://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"

// servedGTFSFiles are handed to clients verbatim and stay resident.
var servedGTFSFiles = map[string]bool{
	"stops.txt":  true,
	"routes.txt": true,
	"shapes.txt": true,
	"trips.txt":  true,
}

// routingGTFSFiles are parsed into the timetable at startup and then dropped.
//
// They must never reach gtfsFiles: that map is what /gtfs/* serves, and
// stop_times.txt alone is 36 MB. Keeping it resident would roughly triple this
// machine's memory for bytes no client asks for.
var routingGTFSFiles = map[string]bool{
	"stop_times.txt":     true,
	"transfers.txt":      true,
	"calendar.txt":       true,
	"calendar_dates.txt": true,
}

func wantedGTFSFile(name string) bool {
	return servedGTFSFiles[name] || routingGTFSFiles[name]
}

var (
	gtfsMu    sync.RWMutex
	gtfsFiles = map[string][]byte{}
	timetable *Timetable
)

// parseGTFSZip extracts the wanted GTFS files from a raw ZIP archive.
// It is pure (no network, no globals) so it can be unit-tested directly.
// Returns an error if any wanted file is absent from the archive.
func parseGTFSZip(raw []byte) (map[string][]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, fmt.Errorf("open zip: %w", err)
	}

	out := map[string][]byte{}
	for _, f := range zr.File {
		if !wantedGTFSFile(f.Name) {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, fmt.Errorf("open %s in zip: %w", f.Name, err)
		}
		contents, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("read %s in zip: %w", f.Name, err)
		}
		out[f.Name] = contents
	}

	for _, set := range []map[string]bool{servedGTFSFiles, routingGTFSFiles} {
		for name := range set {
			if _, ok := out[name]; !ok {
				return nil, fmt.Errorf("gtfs zip missing required file %q", name)
			}
		}
	}
	return out, nil
}

// loadGTFSStatic downloads the MTA GTFS static ZIP and populates the in-memory
// gtfsFiles cache. Called once at startup; fatal on error (Cloud Run restarts
// the container).
func loadGTFSStatic() error {
	url := os.Getenv("GTFS_STATIC_URL")
	if url == "" {
		url = defaultGTFSStaticURL
	}

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("fetch gtfs static: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch gtfs static: unexpected status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read gtfs static body: %w", err)
	}
	rawBytes := len(raw)

	files, err := parseGTFSZip(raw)
	if err != nil {
		return err
	}

	// The 43 MB of ZIP bytes are dead once the members are extracted, and the
	// timetable build below peaks near 90 MB on its own. Dropping the reference
	// first lets the collector reclaim them during that peak rather than after
	// it, which is the difference that matters on a 512 MB machine.
	raw = nil

	// Build the timetable, then drop the routing files. Splitting the map is
	// the whole point: everything left in `served` is what /gtfs/* hands out.
	start := time.Now()
	tt, err := BuildTimetable(
		files["stop_times.txt"], files["trips.txt"],
		files["transfers.txt"], files["calendar.txt"], files["calendar_dates.txt"],
	)
	if err != nil {
		return fmt.Errorf("build timetable: %w", err)
	}
	buildMS := time.Since(start).Milliseconds()

	served := make(map[string][]byte, len(servedGTFSFiles))
	for name := range servedGTFSFiles {
		served[name] = files[name]
	}

	gtfsMu.Lock()
	gtfsFiles = served
	timetable = tt
	gtfsMu.Unlock()

	slog.Info("gtfs static loaded", "url", url, "files", len(served), "bytes", rawBytes)
	slog.Info("timetable built",
		"ms", buildMS,
		"patterns", len(tt.Patterns),
		"trips", tt.TripCount(),
		"stops", len(tt.Stops),
		"services", len(tt.Services))
	return nil
}

// currentTimetable returns the loaded timetable, or nil before startup finishes.
func currentTimetable() *Timetable {
	gtfsMu.RLock()
	defer gtfsMu.RUnlock()
	return timetable
}
