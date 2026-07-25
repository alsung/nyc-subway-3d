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

// wantedGTFSFiles are the only entries extracted from the GTFS static ZIP.
// Everything else in the archive is ignored to keep memory footprint small.
var wantedGTFSFiles = map[string]bool{
	"stops.txt":  true,
	"routes.txt": true,
	"shapes.txt": true,
	"trips.txt":  true,
}

var (
	gtfsMu    sync.RWMutex
	gtfsFiles = map[string][]byte{}
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
		if !wantedGTFSFiles[f.Name] {
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

	for name := range wantedGTFSFiles {
		if _, ok := out[name]; !ok {
			return nil, fmt.Errorf("gtfs zip missing required file %q", name)
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

	files, err := parseGTFSZip(raw)
	if err != nil {
		return err
	}

	gtfsMu.Lock()
	gtfsFiles = files
	gtfsMu.Unlock()

	slog.Info("gtfs static loaded", "url", url, "files", len(files), "bytes", len(raw))
	return nil
}
