package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

func testCtx() context.Context { return context.Background() }

func createTestUserWith(t *testing.T, pool *pgxpool.Pool, email, provider string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(testCtx(),
		`INSERT INTO users (email, display_name, provider, email_verified)
		 VALUES ($1, 'Test User', $2, true) RETURNING id`,
		email, provider,
	).Scan(&id)
	if err != nil {
		t.Fatalf("create test user: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(testCtx(), `DELETE FROM refresh_tokens WHERE user_id = $1`, id)
		pool.Exec(testCtx(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

func createTestUserWithPassword(t *testing.T, pool *pgxpool.Pool, email, password string) string {
	t.Helper()
	hash, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	var id string
	err := pool.QueryRow(testCtx(),
		`INSERT INTO users (email, display_name, password_hash, provider, email_verified)
		 VALUES ($1, 'Test User', $2, 'email', true) RETURNING id`,
		email, string(hash),
	).Scan(&id)
	if err != nil {
		t.Fatalf("create test user: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(testCtx(), `DELETE FROM refresh_tokens WHERE user_id = $1`, id)
		pool.Exec(testCtx(), `DELETE FROM users WHERE id = $1`, id)
	})
	return id
}

func accountApp(pool *pgxpool.Pool) *app {
	return &app{dbPool: pool, commutes: newPGStore(pool)}
}

func TestUpdateAccount(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWith(t, pool, "update-acct@test.com", "email")

	w := httptest.NewRecorder()
	a.handleUpdateAccount(w, authedRequest("PATCH", "/api/auth/account",
		updateAccountRequest{DisplayName: "New Name"}, userID))

	if w.Code != 200 {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}

	var u userView
	json.NewDecoder(w.Body).Decode(&u)
	if u.DisplayName != "New Name" {
		t.Fatalf("displayName = %q, want 'New Name'", u.DisplayName)
	}
	if u.Provider != "email" {
		t.Fatalf("provider = %q, want 'email'", u.Provider)
	}
}

func TestUpdateAccount_EmptyName(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWith(t, pool, "empty-acct@test.com", "email")

	w := httptest.NewRecorder()
	a.handleUpdateAccount(w, authedRequest("PATCH", "/api/auth/account",
		updateAccountRequest{DisplayName: "  "}, userID))

	if w.Code != 400 {
		t.Fatalf("got status %d, want 400", w.Code)
	}
}

func TestUpdateAccount_TooLong(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWith(t, pool, "long-acct@test.com", "email")

	long := make([]byte, 101)
	for i := range long {
		long[i] = 'a'
	}

	w := httptest.NewRecorder()
	a.handleUpdateAccount(w, authedRequest("PATCH", "/api/auth/account",
		updateAccountRequest{DisplayName: string(long)}, userID))

	if w.Code != 400 {
		t.Fatalf("got status %d, want 400", w.Code)
	}
}

func TestDeleteAccount(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWith(t, pool, "delete-acct@test.com", "email")

	w := httptest.NewRecorder()
	a.handleDeleteAccount(w, authedRequest("DELETE", "/api/auth/account", nil, userID))

	if w.Code != 200 {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	a.handleMe(w, authedRequest("GET", "/api/auth/me", nil, userID))
	if w.Code != 404 {
		t.Fatalf("after delete, handleMe got status %d, want 404", w.Code)
	}
}

func TestDeleteAccount_AlreadyDeleted(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWith(t, pool, "double-del@test.com", "email")

	w := httptest.NewRecorder()
	a.handleDeleteAccount(w, authedRequest("DELETE", "/api/auth/account", nil, userID))
	if w.Code != 200 {
		t.Fatalf("first delete: got status %d, want 200", w.Code)
	}

	w = httptest.NewRecorder()
	a.handleDeleteAccount(w, authedRequest("DELETE", "/api/auth/account", nil, userID))
	if w.Code != 404 {
		t.Fatalf("second delete: got status %d, want 404", w.Code)
	}
}

func TestDeleteAccount_ClearsRefreshTokens(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWithPassword(t, pool, "del-tokens@test.com", "password123")

	_, hashed, _ := generateRefreshToken()
	pool.Exec(testCtx(),
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, now() + interval '7 days')`,
		userID, hashed)

	w := httptest.NewRecorder()
	a.handleDeleteAccount(w, authedRequest("DELETE", "/api/auth/account", nil, userID))
	if w.Code != 200 {
		t.Fatalf("got status %d, want 200", w.Code)
	}

	var count int
	pool.QueryRow(testCtx(), `SELECT count(*) FROM refresh_tokens WHERE user_id = $1`, userID).Scan(&count)
	if count != 0 {
		t.Fatalf("got %d refresh tokens after delete, want 0", count)
	}
}

func TestChangePassword(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWithPassword(t, pool, "changepw@test.com", "oldpassword123")

	_, hashed, _ := generateRefreshToken()
	pool.Exec(testCtx(),
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, now() + interval '7 days')`,
		userID, hashed)

	w := httptest.NewRecorder()
	a.handleChangePassword(w, authedRequest("POST", "/api/auth/change-password",
		changePasswordRequest{CurrentPassword: "oldpassword123", NewPassword: "newpassword456"}, userID))

	if w.Code != 200 {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}

	var count int
	pool.QueryRow(testCtx(), `SELECT count(*) FROM refresh_tokens WHERE user_id = $1`, userID).Scan(&count)
	if count != 0 {
		t.Fatalf("got %d refresh tokens, want 0", count)
	}
}

func TestChangePassword_WrongCurrent(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWithPassword(t, pool, "wrongpw@test.com", "correctpassword")

	w := httptest.NewRecorder()
	a.handleChangePassword(w, authedRequest("POST", "/api/auth/change-password",
		changePasswordRequest{CurrentPassword: "wrongpassword", NewPassword: "newpassword456"}, userID))

	if w.Code != 401 {
		t.Fatalf("got status %d, want 401", w.Code)
	}
}

func TestChangePassword_TooShort(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWithPassword(t, pool, "short-pw@test.com", "oldpassword123")

	w := httptest.NewRecorder()
	a.handleChangePassword(w, authedRequest("POST", "/api/auth/change-password",
		changePasswordRequest{CurrentPassword: "oldpassword123", NewPassword: "short"}, userID))

	if w.Code != 400 {
		t.Fatalf("got status %d, want 400", w.Code)
	}
}

func TestChangePassword_GoogleUser(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWith(t, pool, "google-pw@test.com", "google")

	w := httptest.NewRecorder()
	a.handleChangePassword(w, authedRequest("POST", "/api/auth/change-password",
		changePasswordRequest{CurrentPassword: "whatever", NewPassword: "newpassword456"}, userID))

	if w.Code != 400 {
		t.Fatalf("got status %d, want 400", w.Code)
	}
}
