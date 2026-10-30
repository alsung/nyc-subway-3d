package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type mockCommuteStore struct {
	commutes []Commute
}

func (m *mockCommuteStore) ListCommutes(_ context.Context, userID string) ([]Commute, error) {
	var result []Commute
	for _, c := range m.commutes {
		if c.UserID == userID {
			result = append(result, c)
		}
	}
	if result == nil {
		result = []Commute{}
	}
	return result, nil
}

func (m *mockCommuteStore) CreateCommute(_ context.Context, userID string, p CreateCommuteParams) (Commute, error) {
	var count int
	for _, c := range m.commutes {
		if c.UserID == userID {
			count++
		}
	}
	if count >= maxCommutesPerUser {
		return Commute{}, ErrLimitReached
	}

	c := Commute{
		ID:           "test-uuid",
		UserID:       userID,
		OriginStopID: p.OriginStopID,
		OriginName:   p.OriginName,
		DestStopID:   p.DestStopID,
		DestName:     p.DestName,
		Label:        p.Label,
		CreatedAt:    time.Now(),
	}
	m.commutes = append(m.commutes, c)
	return c, nil
}

func (m *mockCommuteStore) UpdateCommuteLabel(_ context.Context, id, userID, label string) error {
	for i, c := range m.commutes {
		if c.ID == id && c.UserID == userID {
			m.commutes[i].Label = label
			return nil
		}
	}
	return ErrNotFound
}

func (m *mockCommuteStore) DeleteCommute(_ context.Context, id, userID string) error {
	for i, c := range m.commutes {
		if c.ID == id && c.UserID == userID {
			m.commutes = append(m.commutes[:i], m.commutes[i+1:]...)
			return nil
		}
	}
	return ErrNotFound
}

func authedRequest(method, path string, body any, userID string) *http.Request {
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	r := httptest.NewRequest(method, path, &buf)
	r.Header.Set("Content-Type", "application/json")
	ctx := context.WithValue(r.Context(), userContextKey, &authedUser{ID: userID, Email: "test@test.com", Tier: "free"})
	return r.WithContext(ctx)
}

func TestListCommutes_Empty(t *testing.T) {
	a := &app{commutes: &mockCommuteStore{}}
	w := httptest.NewRecorder()
	a.handleListCommutes(w, authedRequest("GET", "/api/commutes", nil, "user-1"))

	if w.Code != 200 {
		t.Fatalf("got status %d, want 200", w.Code)
	}
	var resp map[string][]Commute
	json.NewDecoder(w.Body).Decode(&resp)
	if len(resp["commutes"]) != 0 {
		t.Fatalf("got %d commutes, want 0", len(resp["commutes"]))
	}
}

func TestCreateAndList(t *testing.T) {
	store := &mockCommuteStore{}
	a := &app{commutes: store}

	w := httptest.NewRecorder()
	a.handleCreateCommute(w, authedRequest("POST", "/api/commutes", createCommuteRequest{
		OriginStopID: "127",
		OriginName:   "Times Sq-42 St",
		DestStopID:   "631",
		DestName:     "72 St",
	}, "user-1"))

	if w.Code != 201 {
		t.Fatalf("create: got status %d, want 201", w.Code)
	}

	var created Commute
	json.NewDecoder(w.Body).Decode(&created)
	if created.Label != "Times Sq-42 St to 72 St" {
		t.Fatalf("default label = %q, want 'Times Sq-42 St to 72 St'", created.Label)
	}

	w = httptest.NewRecorder()
	a.handleListCommutes(w, authedRequest("GET", "/api/commutes", nil, "user-1"))

	var resp map[string][]Commute
	json.NewDecoder(w.Body).Decode(&resp)
	if len(resp["commutes"]) != 1 {
		t.Fatalf("list: got %d commutes, want 1", len(resp["commutes"]))
	}
}

func TestCreate_CustomLabel(t *testing.T) {
	a := &app{commutes: &mockCommuteStore{}}
	w := httptest.NewRecorder()
	a.handleCreateCommute(w, authedRequest("POST", "/api/commutes", createCommuteRequest{
		OriginStopID: "127",
		OriginName:   "Times Sq-42 St",
		DestStopID:   "631",
		DestName:     "72 St",
		Label:        "Morning commute",
	}, "user-1"))

	var created Commute
	json.NewDecoder(w.Body).Decode(&created)
	if created.Label != "Morning commute" {
		t.Fatalf("label = %q, want 'Morning commute'", created.Label)
	}
}

func TestCreate_MissingFields(t *testing.T) {
	a := &app{commutes: &mockCommuteStore{}}

	for _, tc := range []struct {
		name string
		req  createCommuteRequest
	}{
		{"missing origin stop", createCommuteRequest{OriginName: "A", DestStopID: "B", DestName: "C"}},
		{"missing origin name", createCommuteRequest{OriginStopID: "A", DestStopID: "B", DestName: "C"}},
		{"missing dest stop", createCommuteRequest{OriginStopID: "A", OriginName: "B", DestName: "C"}},
		{"missing dest name", createCommuteRequest{OriginStopID: "A", OriginName: "B", DestStopID: "C"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			a.handleCreateCommute(w, authedRequest("POST", "/api/commutes", tc.req, "user-1"))
			if w.Code != 400 {
				t.Fatalf("got status %d, want 400", w.Code)
			}
		})
	}
}

func TestCreate_MaxLimit(t *testing.T) {
	store := &mockCommuteStore{}
	for i := 0; i < 20; i++ {
		store.commutes = append(store.commutes, Commute{
			ID:     "existing-" + string(rune('a'+i)),
			UserID: "user-1",
		})
	}
	a := &app{commutes: store}

	w := httptest.NewRecorder()
	a.handleCreateCommute(w, authedRequest("POST", "/api/commutes", createCommuteRequest{
		OriginStopID: "127",
		OriginName:   "Times Sq",
		DestStopID:   "631",
		DestName:     "72 St",
	}, "user-1"))

	if w.Code != 400 {
		t.Fatalf("got status %d, want 400", w.Code)
	}
}

func TestUpdateLabel(t *testing.T) {
	store := &mockCommuteStore{
		commutes: []Commute{{ID: "c-1", UserID: "user-1", Label: "Old"}},
	}
	a := &app{commutes: store}

	r := authedRequest("PATCH", "/api/commutes/c-1", updateCommuteRequest{Label: "New label"}, "user-1")
	r.SetPathValue("id", "c-1")
	w := httptest.NewRecorder()
	a.handleUpdateCommute(w, r)

	if w.Code != 200 {
		t.Fatalf("got status %d, want 200", w.Code)
	}
	if store.commutes[0].Label != "New label" {
		t.Fatalf("label = %q, want 'New label'", store.commutes[0].Label)
	}
}

func TestUpdate_WrongUser(t *testing.T) {
	store := &mockCommuteStore{
		commutes: []Commute{{ID: "c-1", UserID: "user-1", Label: "Mine"}},
	}
	a := &app{commutes: store}

	r := authedRequest("PATCH", "/api/commutes/c-1", updateCommuteRequest{Label: "Hacked"}, "user-2")
	r.SetPathValue("id", "c-1")
	w := httptest.NewRecorder()
	a.handleUpdateCommute(w, r)

	if w.Code != 404 {
		t.Fatalf("got status %d, want 404", w.Code)
	}
	if store.commutes[0].Label != "Mine" {
		t.Fatalf("label was changed to %q", store.commutes[0].Label)
	}
}

func TestDelete(t *testing.T) {
	store := &mockCommuteStore{
		commutes: []Commute{{ID: "c-1", UserID: "user-1"}},
	}
	a := &app{commutes: store}

	r := authedRequest("DELETE", "/api/commutes/c-1", nil, "user-1")
	r.SetPathValue("id", "c-1")
	w := httptest.NewRecorder()
	a.handleDeleteCommute(w, r)

	if w.Code != 204 {
		t.Fatalf("got status %d, want 204", w.Code)
	}
	if len(store.commutes) != 0 {
		t.Fatal("commute was not deleted")
	}
}

func TestDelete_WrongUser(t *testing.T) {
	store := &mockCommuteStore{
		commutes: []Commute{{ID: "c-1", UserID: "user-1"}},
	}
	a := &app{commutes: store}

	r := authedRequest("DELETE", "/api/commutes/c-1", nil, "user-2")
	r.SetPathValue("id", "c-1")
	w := httptest.NewRecorder()
	a.handleDeleteCommute(w, r)

	if w.Code != 404 {
		t.Fatalf("got status %d, want 404", w.Code)
	}
	if len(store.commutes) != 1 {
		t.Fatal("commute was deleted by wrong user")
	}
}

func TestCreate_FieldLimits(t *testing.T) {
	long := strings.Repeat("n", 101)
	cases := map[string]createCommuteRequest{
		"origin stop id": {OriginStopID: strings.Repeat("1", 17), OriginName: "A", DestStopID: "635", DestName: "B"},
		"dest name":      {OriginStopID: "127", OriginName: "A", DestStopID: "635", DestName: long},
		"label":          {OriginStopID: "127", OriginName: "A", DestStopID: "635", DestName: "B", Label: long},
	}
	for name, req := range cases {
		a := &app{commutes: &mockCommuteStore{}}
		w := httptest.NewRecorder()
		a.handleCreateCommute(w, authedRequest("POST", "/api/commutes", req, "user-1"))
		if w.Code != 400 {
			t.Errorf("%s too long: got %d, want 400", name, w.Code)
		}
	}
}

func TestUpdateLabel_TooLong(t *testing.T) {
	a := &app{commutes: &mockCommuteStore{}}
	w := httptest.NewRecorder()
	r := authedRequest("PATCH", "/api/commutes/c1", updateCommuteRequest{Label: strings.Repeat("n", 101)}, "user-1")
	r.SetPathValue("id", "c1")
	a.handleUpdateCommute(w, r)
	if w.Code != 400 {
		t.Errorf("got %d, want 400", w.Code)
	}
}

// With saved_commutes off, editing a commute is refused but deleting one is
// not: riders can always remove their own data.
func TestCommuteRoutes_FeatureFlag(t *testing.T) {
	a, pool := authTestApp(t)
	session := loginSession(t, a, pool, "commute-flag@test.com")

	fc.mu.Lock()
	prev := fc.byName
	fc.byName = map[string]feature{"saved_commutes": {Name: "saved_commutes", RequiredTier: "disabled"}}
	fc.mu.Unlock()
	t.Cleanup(func() {
		fc.mu.Lock()
		fc.byName = prev
		fc.mu.Unlock()
	})

	h := newMux(a)
	send := func(method string) int {
		req := httptest.NewRequest(method, "/api/commutes/00000000-0000-0000-0000-000000000000", strings.NewReader(`{"label":"x"}`))
		req.Header.Set("Authorization", "Bearer "+session.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if code := send("PATCH"); code != 403 {
		t.Errorf("PATCH with the flag off: got %d, want 403", code)
	}
	if code := send("DELETE"); code != 404 {
		t.Errorf("DELETE with the flag off: got %d, want 404 (reached the handler; no such commute)", code)
	}
}
