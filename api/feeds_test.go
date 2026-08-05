package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

// sampleFeedBytes marshals a minimal valid FeedMessage for decode tests.
func sampleFeedBytes(t *testing.T) []byte {
	t.Helper()
	msg := &gtfs.FeedMessage{
		Header: &gtfs.FeedHeader{
			GtfsRealtimeVersion: proto.String("2.0"),
		},
		Entity: []*gtfs.FeedEntity{
			{Id: proto.String("entity-1")},
		},
	}
	raw, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return raw
}

func TestDecodeFeedValid(t *testing.T) {
	msg, err := decodeFeed(sampleFeedBytes(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(msg.Entity) != 1 {
		t.Fatalf("expected 1 entity, got %d", len(msg.Entity))
	}
	if got := msg.Entity[0].GetId(); got != "entity-1" {
		t.Errorf("expected entity id 'entity-1', got %q", got)
	}
}

func TestDecodeFeedInvalid(t *testing.T) {
	// Field 1, wire type 2 (length-delimited), declared length 5, but no bytes
	// follow — a truncated message that reliably fails to parse.
	if _, err := decodeFeed([]byte{0x0A, 0x05}); err == nil {
		t.Fatal("expected error for truncated protobuf, got nil")
	}
}

func TestHealthReportsFeedCount(t *testing.T) {
	feedsMu.Lock()
	feedCache = map[string]feedEntry{
		"ACE":  {msg: &gtfs.FeedMessage{}, fetchedAt: time.Now()},
		"BDFM": {msg: &gtfs.FeedMessage{}, fetchedAt: time.Now()},
	}
	lastRefresh = time.Now()
	feedsMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	handleHealth(w, req)

	var resp healthResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.FeedsLoaded != 2 {
		t.Errorf("expected 2 feeds loaded, got %d", resp.FeedsLoaded)
	}
	if resp.LastRefresh == "" {
		t.Error("expected non-empty lastRefresh")
	}
}
