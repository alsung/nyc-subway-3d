package main

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

// buildTestZip creates an in-memory ZIP archive from name→contents pairs.
func buildTestZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, contents := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create %s in zip: %v", name, err)
		}
		if _, err := w.Write([]byte(contents)); err != nil {
			t.Fatalf("write %s in zip: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buf.Bytes()
}

func fullGTFSZip(t *testing.T) []byte {
	return buildTestZip(t, map[string]string{
		"stops.txt":  "stop_id,stop_name\n127,Times Sq-42 St\n",
		"routes.txt": "route_id,route_color\n1,EE352E\n",
		"shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n",
		"trips.txt":  "route_id,trip_id,shape_id\n",
	})
}

func TestParseGTFSZipSuccess(t *testing.T) {
	files, err := parseGTFSZip(fullGTFSZip(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(files) != len(wantedGTFSFiles) {
		t.Errorf("expected %d files, got %d", len(wantedGTFSFiles), len(files))
	}
	if !bytes.Contains(files["stops.txt"], []byte("Times Sq-42 St")) {
		t.Errorf("stops.txt missing expected content")
	}
}

func TestParseGTFSZipMissingFile(t *testing.T) {
	zip := buildTestZip(t, map[string]string{
		"stops.txt":  "stop_id\n127\n",
		"routes.txt": "route_id\n1\n",
		"shapes.txt": "shape_id\n",
		// trips.txt intentionally omitted
	})
	_, err := parseGTFSZip(zip)
	if err == nil {
		t.Fatal("expected error for missing trips.txt, got nil")
	}
}

func TestParseGTFSZipIgnoresExtraFiles(t *testing.T) {
	files := map[string]string{
		"stops.txt":      "stop_id\n127\n",
		"routes.txt":     "route_id\n1\n",
		"shapes.txt":     "shape_id\n",
		"trips.txt":      "route_id\n1\n",
		"calendar.txt":   "service_id\nWKD\n",
		"stop_times.txt": "trip_id\nA\n",
		"agency.txt":     "agency_id\nMTA\n",
		"transfers.txt":  "from_stop_id\n127\n",
	}
	out, err := parseGTFSZip(buildTestZip(t, files))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := out["calendar.txt"]; ok {
		t.Error("calendar.txt should not be extracted")
	}
	if len(out) != len(wantedGTFSFiles) {
		t.Errorf("expected only %d wanted files, got %d", len(wantedGTFSFiles), len(out))
	}
}

func TestParseGTFSZipInvalidArchive(t *testing.T) {
	_, err := parseGTFSZip([]byte("not a zip file"))
	if err == nil {
		t.Fatal("expected error for invalid zip, got nil")
	}
}

func TestHandleGTFSFileServed(t *testing.T) {
	files, err := parseGTFSZip(fullGTFSZip(t))
	if err != nil {
		t.Fatalf("setup parse failed: %v", err)
	}
	gtfsMu.Lock()
	gtfsFiles = files
	gtfsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/gtfs/stops.txt", nil)
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Errorf("expected text/plain content type, got %q", ct)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("Times Sq-42 St")) {
		t.Errorf("response body missing expected stops content")
	}
}

func TestHandleGTFSFileNotFound(t *testing.T) {
	files, err := parseGTFSZip(fullGTFSZip(t))
	if err != nil {
		t.Fatalf("setup parse failed: %v", err)
	}
	gtfsMu.Lock()
	gtfsFiles = files
	gtfsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/gtfs/nonexistent.txt", nil)
	w := httptest.NewRecorder()
	newMux().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}
