package main

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		// CI sets REQUIRE_TEST_DB so a lost database service fails loudly
		// instead of skipping every database test behind a green run.
		if os.Getenv("REQUIRE_TEST_DB") == "1" {
			t.Fatal("TEST_DATABASE_URL is required when REQUIRE_TEST_DB=1")
		}
		t.Skip("TEST_DATABASE_URL not set; skipping integration test")
	}

	if err := runMigrations(dbURL); err != nil {
		t.Fatalf("migrations: %v", err)
	}

	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	return pool
}

func createTestUser(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO users (email, display_name, provider, email_verified)
		 VALUES ('test-' || gen_random_uuid() || '@test.com', 'Test User', 'email', true)
		 RETURNING id`,
	).Scan(&id)
	if err != nil {
		t.Fatalf("create test user: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

func TestPGStore_ListEmpty(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userID := createTestUser(t, pool)

	commutes, err := store.ListCommutes(context.Background(), userID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(commutes) != 0 {
		t.Fatalf("got %d commutes, want 0", len(commutes))
	}
}

func TestPGStore_CreateAndList(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userID := createTestUser(t, pool)

	c, err := store.CreateCommute(context.Background(), userID, CreateCommuteParams{
		OriginStopID: "127",
		OriginName:   "Times Sq-42 St",
		DestStopID:   "631",
		DestName:     "72 St",
		Label:        "Morning commute",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if c.ID == "" {
		t.Fatal("created commute has no ID")
	}
	if c.CreatedAt.IsZero() {
		t.Fatal("created commute has zero timestamp")
	}

	commutes, err := store.ListCommutes(context.Background(), userID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(commutes) != 1 {
		t.Fatalf("got %d commutes, want 1", len(commutes))
	}
	if commutes[0].Label != "Morning commute" {
		t.Fatalf("label = %q, want 'Morning commute'", commutes[0].Label)
	}
}

func TestPGStore_CreateLimit(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userID := createTestUser(t, pool)

	for i := 0; i < 20; i++ {
		_, err := store.CreateCommute(context.Background(), userID, CreateCommuteParams{
			OriginStopID: "A", OriginName: "A", DestStopID: "B", DestName: "B", Label: "x",
		})
		if err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}

	_, err := store.CreateCommute(context.Background(), userID, CreateCommuteParams{
		OriginStopID: "A", OriginName: "A", DestStopID: "B", DestName: "B", Label: "overflow",
	})
	if err != ErrLimitReached {
		t.Fatalf("got err = %v, want ErrLimitReached", err)
	}
}

func TestPGStore_UpdateLabel(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userID := createTestUser(t, pool)

	c, _ := store.CreateCommute(context.Background(), userID, CreateCommuteParams{
		OriginStopID: "A", OriginName: "A", DestStopID: "B", DestName: "B", Label: "Old",
	})

	err := store.UpdateCommuteLabel(context.Background(), c.ID, userID, "New")
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	commutes, _ := store.ListCommutes(context.Background(), userID)
	if commutes[0].Label != "New" {
		t.Fatalf("label = %q, want 'New'", commutes[0].Label)
	}
}

func TestPGStore_UpdateWrongUser(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userA := createTestUser(t, pool)
	userB := createTestUser(t, pool)

	c, _ := store.CreateCommute(context.Background(), userA, CreateCommuteParams{
		OriginStopID: "A", OriginName: "A", DestStopID: "B", DestName: "B", Label: "Mine",
	})

	err := store.UpdateCommuteLabel(context.Background(), c.ID, userB, "Hacked")
	if err != ErrNotFound {
		t.Fatalf("got err = %v, want ErrNotFound", err)
	}

	commutes, _ := store.ListCommutes(context.Background(), userA)
	if commutes[0].Label != "Mine" {
		t.Fatalf("label was changed to %q", commutes[0].Label)
	}
}

func TestPGStore_Delete(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userID := createTestUser(t, pool)

	c, _ := store.CreateCommute(context.Background(), userID, CreateCommuteParams{
		OriginStopID: "A", OriginName: "A", DestStopID: "B", DestName: "B", Label: "x",
	})

	err := store.DeleteCommute(context.Background(), c.ID, userID)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}

	commutes, _ := store.ListCommutes(context.Background(), userID)
	if len(commutes) != 0 {
		t.Fatalf("got %d commutes after delete", len(commutes))
	}
}

func TestPGStore_DeleteWrongUser(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userA := createTestUser(t, pool)
	userB := createTestUser(t, pool)

	c, _ := store.CreateCommute(context.Background(), userA, CreateCommuteParams{
		OriginStopID: "A", OriginName: "A", DestStopID: "B", DestName: "B", Label: "x",
	})

	err := store.DeleteCommute(context.Background(), c.ID, userB)
	if err != ErrNotFound {
		t.Fatalf("got err = %v, want ErrNotFound", err)
	}

	commutes, _ := store.ListCommutes(context.Background(), userA)
	if len(commutes) != 1 {
		t.Fatal("commute was deleted by wrong user")
	}
}

func TestPGStore_CascadeDelete(t *testing.T) {
	pool := testPool(t)
	store := newPGStore(pool)
	userID := createTestUser(t, pool)

	store.CreateCommute(context.Background(), userID, CreateCommuteParams{
		OriginStopID: "A", OriginName: "A", DestStopID: "B", DestName: "B", Label: "x",
	})

	// Delete the user directly; CASCADE should remove commutes
	pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)

	var count int
	pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM commutes WHERE user_id = $1`, userID).Scan(&count)
	if count != 0 {
		t.Fatalf("got %d commutes after user delete, want 0", count)
	}
}
