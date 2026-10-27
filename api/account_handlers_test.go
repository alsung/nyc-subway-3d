package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/testutil"
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

func TestDeleteAccount_DeletesCommutesAndTokens(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	userID := createTestUserWithPassword(t, pool, "del-tokens@test.com", "password123")

	_, hashed, _ := generateRefreshToken()
	mustExec(t, pool,
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, now() + interval '7 days')`,
		userID, hashed)
	mustExec(t, pool,
		`INSERT INTO verification_tokens (user_id, token_hash, kind, expires_at)
		 VALUES ($1, $2, 'password_reset', now() + interval '1 hour')`,
		userID, "del-tokens-vt-"+userID)
	mustExec(t, pool,
		`INSERT INTO commutes (user_id, origin_stop_id, origin_name, dest_stop_id, dest_name)
		 VALUES ($1, '127', 'Times Sq-42 St', '631', 'Grand Central-42 St')`,
		userID)

	w := httptest.NewRecorder()
	a.handleDeleteAccount(w, authedRequest("DELETE", "/api/auth/account", nil, userID))
	if w.Code != 200 {
		t.Fatalf("got status %d, want 200", w.Code)
	}

	for _, table := range []string{"commutes", "refresh_tokens", "verification_tokens"} {
		if n := countRows(t, pool, `SELECT count(*) FROM `+table+` WHERE user_id = $1`, userID); n != 0 {
			t.Errorf("got %d rows in %s after delete, want 0", n, table)
		}
	}
}

func TestDeleteAccount_ReleasesEmail(t *testing.T) {
	pool := testPool(t)
	a := accountApp(pool)
	const email = "resignup@test.com"
	oldID := createTestUserWithPassword(t, pool, email, "password123")
	t.Cleanup(func() { pool.Exec(testCtx(), `DELETE FROM users WHERE email = $1`, email) })

	w := httptest.NewRecorder()
	a.handleDeleteAccount(w, authedRequest("DELETE", "/api/auth/account", nil, oldID))
	if w.Code != 200 {
		t.Fatalf("delete: got status %d, want 200", w.Code)
	}

	w = httptest.NewRecorder()
	a.handleRegister(w, authedRequest("POST", "/api/auth/register",
		registerRequest{Email: email, Password: "password456", DisplayName: "Again"}, ""))
	if w.Code != 201 {
		t.Fatalf("register after delete: got status %d, want 201: %s", w.Code, w.Body.String())
	}

	var newID string
	if err := pool.QueryRow(testCtx(),
		`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, email).Scan(&newID); err != nil {
		t.Fatalf("find new account: %v", err)
	}
	if newID == oldID {
		t.Fatal("re-signup reused the deleted account's id, want a new account")
	}
}

func TestDeleteAccount_GoogleReinsert(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "google-resignup@test.com"
	oldID := createTestUserWith(t, pool, email, "google")
	cleanupEmail(t, pool, email)

	w := httptest.NewRecorder()
	a.handleDeleteAccount(w, authedRequest("DELETE", "/api/auth/account", nil, oldID))
	if w.Code != 200 {
		t.Fatalf("delete: got status %d, want 200", w.Code)
	}

	stubGoogle(t, &googleClaims{Email: email, Name: "Again"}, nil)
	w = postJSON(a.handleGoogleAuth, "/api/auth/google", googleAuthRequest{IDToken: "stub"})
	if w.Code != 200 {
		t.Fatalf("google sign-in after delete: got status %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp := requireSession(t, w, "google"); resp.User.ID == oldID {
		t.Fatal("google sign-in reused the deleted account's id")
	}
}

func TestPurgeExpired(t *testing.T) {
	pool := testPool(t)
	expiredUser := createTestUserWith(t, pool, "purge-expired@test.com", "email")
	recentUser := createTestUserWith(t, pool, "purge-recent@test.com", "email")
	activeUser := createTestUserWith(t, pool, "purge-active@test.com", "email")
	mustExec(t, pool, `UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = $1`, expiredUser)
	mustExec(t, pool, `UPDATE users SET deleted_at = now() - interval '1 day' WHERE id = $1`, recentUser)

	for _, tok := range []struct{ name, expires string }{
		{"old", "now() - interval '1 minute'"},
		{"new", "now() + interval '1 hour'"},
	} {
		mustExec(t, pool,
			`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
			 VALUES ($1, $2, `+tok.expires+`)`,
			activeUser, "purge-rt-"+tok.name+"-"+activeUser)
		mustExec(t, pool,
			`INSERT INTO verification_tokens (user_id, token_hash, kind, expires_at)
			 VALUES ($1, $2, 'email_verification', `+tok.expires+`)`,
			activeUser, "purge-vt-"+tok.name+"-"+activeUser)
	}

	if err := purgeExpired(testCtx(), pool); err != nil {
		t.Fatalf("purgeExpired: %v", err)
	}

	userCount := func(id string) int {
		return countRows(t, pool, `SELECT count(*) FROM users WHERE id = $1`, id)
	}
	if n := userCount(expiredUser); n != 0 {
		t.Error("user deleted 31 days ago was not purged")
	}
	if n := userCount(recentUser); n != 1 {
		t.Error("user deleted 1 day ago was purged, want kept")
	}
	if n := userCount(activeUser); n != 1 {
		t.Error("active user was purged, want kept")
	}

	for _, tt := range []struct{ table, prefix string }{
		{"refresh_tokens", "purge-rt-"},
		{"verification_tokens", "purge-vt-"},
	} {
		q := `SELECT count(*) FROM ` + tt.table + ` WHERE token_hash = $1`
		if n := countRows(t, pool, q, tt.prefix+"old-"+activeUser); n != 0 {
			t.Errorf("expired row in %s was not purged", tt.table)
		}
		if n := countRows(t, pool, q, tt.prefix+"new-"+activeUser); n != 1 {
			t.Errorf("unexpired row in %s was purged, want kept", tt.table)
		}
	}
}

func TestPurgeExpired_SetsHeartbeat(t *testing.T) {
	pool := testPool(t)

	metricPurgeLastSuccess.Set(0)
	if err := purgeExpired(testCtx(), pool); err != nil {
		t.Fatalf("purgeExpired: %v", err)
	}
	if testutil.ToFloat64(metricPurgeLastSuccess) == 0 {
		t.Fatal("heartbeat not set after a successful purge")
	}

	metricPurgeLastSuccess.Set(0)
	ctx, cancel := context.WithCancel(testCtx())
	cancel()
	if err := purgeExpired(ctx, pool); err == nil {
		t.Fatal("purgeExpired with a cancelled context returned nil, want an error")
	}
	if got := testutil.ToFloat64(metricPurgeLastSuccess); got != 0 {
		t.Fatalf("heartbeat moved to %v after a failed purge, want 0", got)
	}
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(testCtx(), sql, args...); err != nil {
		t.Fatalf("exec: %v", err)
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(testCtx(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
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
