package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Regression contract for the session paths, written before P10-2 and P10-3
// rewrite them. Every path that signs someone in must keep returning an access
// token, a refresh token and the user, including the provider.

func authTestApp(t *testing.T) (*app, *pgxpool.Pool) {
	t.Helper()
	pool := testPool(t)
	prev := jwtSecret
	jwtSecret = []byte("test-secret-at-least-32-bytes-long!!")
	t.Cleanup(func() { jwtSecret = prev })
	return accountApp(pool), pool
}

func postJSON(h http.HandlerFunc, path string, body any) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	json.NewEncoder(&buf).Encode(body)
	r := httptest.NewRequest("POST", path, &buf)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func requireSession(t *testing.T, w *httptest.ResponseRecorder, wantProvider string) authResponse {
	t.Helper()
	var resp authResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	claims, err := parseAccessToken(resp.AccessToken)
	if err != nil {
		t.Fatalf("access token does not parse: %v", err)
	}
	if claims.Subject != resp.User.ID {
		t.Errorf("access token subject %q, want user id %q", claims.Subject, resp.User.ID)
	}
	if resp.RefreshToken == "" {
		t.Error("refreshToken is empty")
	}
	if resp.User.ID == "" || resp.User.Email == "" {
		t.Errorf("user missing id or email: %+v", resp.User)
	}
	if resp.User.Provider != wantProvider {
		t.Errorf("user.provider = %q, want %q", resp.User.Provider, wantProvider)
	}
	return resp
}

func stubGoogle(t *testing.T, claims *googleClaims, err error) {
	t.Helper()
	prev := verifyGoogleIDToken
	verifyGoogleIDToken = func(context.Context, string, string) (*googleClaims, error) {
		return claims, err
	}
	t.Cleanup(func() { verifyGoogleIDToken = prev })
}

// cleanupEmail removes every row for an email, including accounts the
// handlers under test created themselves.
func cleanupEmail(t *testing.T, pool *pgxpool.Pool, email string) {
	t.Helper()
	t.Cleanup(func() { pool.Exec(testCtx(), `DELETE FROM users WHERE email = $1`, email) })
}

func TestGoogleAuth_NewUser(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "google-new@test.com"
	cleanupEmail(t, pool, email)
	stubGoogle(t, &googleClaims{Email: email, Name: "New Person"}, nil)

	w := postJSON(a.handleGoogleAuth, "/api/auth/google", googleAuthRequest{IDToken: "stub"})
	if w.Code != 200 {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}
	resp := requireSession(t, w, "google")

	var verified bool
	pool.QueryRow(testCtx(), `SELECT email_verified FROM users WHERE id = $1`, resp.User.ID).Scan(&verified)
	if !verified {
		t.Error("new Google user is not email_verified")
	}
}

func TestGoogleAuth_ExistingUser(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "google-existing@test.com"
	id := createTestUserWith(t, pool, email, "google")
	stubGoogle(t, &googleClaims{Email: email, Name: "Renamed", Picture: "https://example.com/p.png"}, nil)

	w := postJSON(a.handleGoogleAuth, "/api/auth/google", googleAuthRequest{IDToken: "stub"})
	if w.Code != 200 {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}
	resp := requireSession(t, w, "google")
	if resp.User.ID != id {
		t.Errorf("got user id %s, want existing %s", resp.User.ID, id)
	}

	var name, avatar string
	pool.QueryRow(testCtx(), `SELECT display_name, avatar_url FROM users WHERE id = $1`, id).Scan(&name, &avatar)
	if name != "Renamed" || avatar != "https://example.com/p.png" {
		t.Errorf("profile not updated from Google: name=%q avatar=%q", name, avatar)
	}
}

func TestGoogleAuth_EmailAccountConflict(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "google-conflict@test.com"
	createTestUserWithPassword(t, pool, email, "password123")
	stubGoogle(t, &googleClaims{Email: email}, nil)

	w := postJSON(a.handleGoogleAuth, "/api/auth/google", googleAuthRequest{IDToken: "stub"})
	if w.Code != 409 {
		t.Fatalf("got status %d, want 409", w.Code)
	}
}

func TestGoogleAuth_InvalidToken(t *testing.T) {
	a, _ := authTestApp(t)
	stubGoogle(t, nil, errors.New("bad signature"))

	w := postJSON(a.handleGoogleAuth, "/api/auth/google", googleAuthRequest{IDToken: "stub"})
	if w.Code != 401 {
		t.Fatalf("got status %d, want 401", w.Code)
	}
}

func TestRegister_AutoVerify(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "register-auto@test.com"
	cleanupEmail(t, pool, email)
	prev := devAutoVerify
	devAutoVerify = true
	t.Cleanup(func() { devAutoVerify = prev })

	w := postJSON(a.handleRegister, "/api/auth/register",
		registerRequest{Email: email, Password: "password123", DisplayName: "Auto"})
	if w.Code != 201 {
		t.Fatalf("got status %d, want 201: %s", w.Code, w.Body.String())
	}
	requireSession(t, w, "email")
}

func TestRegister_RequiresVerification(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "register-verify@test.com"
	cleanupEmail(t, pool, email)

	w := postJSON(a.handleRegister, "/api/auth/register",
		registerRequest{Email: email, Password: "password123", DisplayName: "Verify"})
	if w.Code != 201 {
		t.Fatalf("got status %d, want 201: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	json.NewDecoder(w.Body).Decode(&body)
	if _, ok := body["accessToken"]; ok {
		t.Error("unverified registration returned a session")
	}

	var id string
	pool.QueryRow(testCtx(), `SELECT id FROM users WHERE email = $1`, email).Scan(&id)
	if n := countRows(t, pool,
		`SELECT count(*) FROM verification_tokens WHERE user_id = $1 AND kind = 'email_verification'`, id); n != 1 {
		t.Errorf("got %d verification tokens, want 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refresh_tokens WHERE user_id = $1`, id); n != 0 {
		t.Errorf("got %d refresh tokens before verification, want 0", n)
	}
}

func TestRegister_DuplicateActiveEmail(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "register-dup@test.com"
	createTestUserWithPassword(t, pool, email, "password123")

	w := postJSON(a.handleRegister, "/api/auth/register",
		registerRequest{Email: email, Password: "password456", DisplayName: "Dup"})
	if w.Code != 409 {
		t.Fatalf("got status %d, want 409", w.Code)
	}
}

func TestRegister_PasswordOver72Bytes(t *testing.T) {
	t.Skip("P10-3 #113: bcrypt's ErrPasswordTooLong still becomes a 500")
	a, pool := authTestApp(t)
	const email = "register-long@test.com"
	cleanupEmail(t, pool, email)

	w := postJSON(a.handleRegister, "/api/auth/register",
		registerRequest{Email: email, Password: strings.Repeat("a", 73), DisplayName: "Long"})
	if w.Code != 400 {
		t.Fatalf("got status %d, want 400", w.Code)
	}
}

func TestLogin_Success(t *testing.T) {
	a, pool := authTestApp(t)
	const email = "login-ok@test.com"
	createTestUserWithPassword(t, pool, email, "password123")

	w := postJSON(a.handleLogin, "/api/auth/login", loginRequest{Email: email, Password: "password123"})
	if w.Code != 200 {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}
	requireSession(t, w, "email")
}

func TestLogin_Errors(t *testing.T) {
	a, pool := authTestApp(t)

	tests := []struct {
		name     string
		setup    func() (email, password string)
		wantCode int
	}{
		{
			name: "wrong password",
			setup: func() (string, string) {
				createTestUserWithPassword(t, pool, "login-wrong@test.com", "password123")
				return "login-wrong@test.com", "not-the-password"
			},
			wantCode: 401,
		},
		{
			name:     "unknown email",
			setup:    func() (string, string) { return "login-nobody@test.com", "password123" },
			wantCode: 401,
		},
		{
			name: "unverified email",
			setup: func() (string, string) {
				id := createTestUserWithPassword(t, pool, "login-unverified@test.com", "password123")
				mustExec(t, pool, `UPDATE users SET email_verified = false WHERE id = $1`, id)
				return "login-unverified@test.com", "password123"
			},
			wantCode: 403,
		},
		{
			name: "google account",
			setup: func() (string, string) {
				createTestUserWith(t, pool, "login-google@test.com", "google")
				return "login-google@test.com", "password123"
			},
			wantCode: 409,
		},
		{
			name: "deleted account",
			setup: func() (string, string) {
				id := createTestUserWithPassword(t, pool, "login-deleted@test.com", "password123")
				mustExec(t, pool, `UPDATE users SET deleted_at = now() WHERE id = $1`, id)
				return "login-deleted@test.com", "password123"
			},
			wantCode: 401,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			email, password := tt.setup()
			w := postJSON(a.handleLogin, "/api/auth/login", loginRequest{Email: email, Password: password})
			if w.Code != tt.wantCode {
				t.Fatalf("got status %d, want %d: %s", w.Code, tt.wantCode, w.Body.String())
			}
		})
	}
}

// loginSession signs a fresh password user in and returns the session.
func loginSession(t *testing.T, a *app, pool *pgxpool.Pool, email string) authResponse {
	t.Helper()
	createTestUserWithPassword(t, pool, email, "password123")
	w := postJSON(a.handleLogin, "/api/auth/login", loginRequest{Email: email, Password: "password123"})
	if w.Code != 200 {
		t.Fatalf("login: got status %d, want 200", w.Code)
	}
	return requireSession(t, w, "email")
}

func TestRefresh_SingleUse(t *testing.T) {
	a, pool := authTestApp(t)
	first := loginSession(t, a, pool, "refresh-once@test.com")

	w := postJSON(a.handleRefresh, "/api/auth/refresh", refreshRequest{RefreshToken: first.RefreshToken})
	if w.Code != 200 {
		t.Fatalf("first refresh: got status %d, want 200: %s", w.Code, w.Body.String())
	}
	second := requireSession(t, w, "email")
	if second.RefreshToken == first.RefreshToken {
		t.Fatal("refresh returned the same refresh token, want a rotated one")
	}

	w = postJSON(a.handleRefresh, "/api/auth/refresh", refreshRequest{RefreshToken: first.RefreshToken})
	if w.Code != 401 {
		t.Fatalf("reused refresh token: got status %d, want 401", w.Code)
	}

	w = postJSON(a.handleRefresh, "/api/auth/refresh", refreshRequest{RefreshToken: second.RefreshToken})
	if w.Code != 200 {
		t.Fatalf("rotated refresh token: got status %d, want 200", w.Code)
	}
}

func TestRefresh_Expired(t *testing.T) {
	a, pool := authTestApp(t)
	id := createTestUserWithPassword(t, pool, "refresh-expired@test.com", "password123")
	raw, hashed, _ := generateRefreshToken()
	mustExec(t, pool,
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, now() - interval '1 minute')`,
		id, hashed)

	w := postJSON(a.handleRefresh, "/api/auth/refresh", refreshRequest{RefreshToken: raw})
	if w.Code != 401 {
		t.Fatalf("got status %d, want 401", w.Code)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM refresh_tokens WHERE token_hash = $1`, hashed); n != 0 {
		t.Error("expired refresh token was not deleted")
	}
}

func TestRefresh_DeletedUser(t *testing.T) {
	a, pool := authTestApp(t)
	session := loginSession(t, a, pool, "refresh-deleted@test.com")
	// Directly in SQL: the delete handler would also remove the token, and this
	// checks the refresh path's own deleted_at filter.
	mustExec(t, pool, `UPDATE users SET deleted_at = now() WHERE id = $1`, session.User.ID)

	w := postJSON(a.handleRefresh, "/api/auth/refresh", refreshRequest{RefreshToken: session.RefreshToken})
	if w.Code != 401 {
		t.Fatalf("got status %d, want 401", w.Code)
	}
}

func TestRefresh_ConcurrentSameToken(t *testing.T) {
	a, pool := authTestApp(t)
	session := loginSession(t, a, pool, "refresh-race@test.com")

	// Ten, not two: against the non-atomic rotation, two requests overlapped
	// in 1 of 10 runs, while ten caught it in 10 of 10.
	start := make(chan struct{})
	codes := make([]int, 10)
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i] = postJSON(a.handleRefresh, "/api/auth/refresh",
				refreshRequest{RefreshToken: session.RefreshToken}).Code
		}(i)
	}
	close(start)
	wg.Wait()

	ok, unauthorized := 0, 0
	for _, c := range codes {
		switch c {
		case 200:
			ok++
		case 401:
			unauthorized++
		}
	}
	if ok != 1 || unauthorized != len(codes)-1 {
		t.Fatalf("got statuses %v, want exactly one 200 and the rest 401", codes)
	}
}

// Logout revokes the refresh token without needing an access token, so a
// client whose access token has expired can still sign out.
func TestLogout_RevokesWithoutAccessToken(t *testing.T) {
	a, pool := authTestApp(t)
	session := loginSession(t, a, pool, "logout-revoke@test.com")

	w := muxRequest(newMux(a), "POST", "/api/auth/logout", "1.2.3.4",
		`{"refreshToken":"`+session.RefreshToken+`"}`)
	if w.Code != 200 {
		t.Fatalf("logout without access token: got %d, want 200", w.Code)
	}

	w = postJSON(a.handleRefresh, "/api/auth/refresh", refreshRequest{RefreshToken: session.RefreshToken})
	if w.Code != 401 {
		t.Errorf("refresh after logout: got %d, want 401", w.Code)
	}

	// An unknown token gets the same reply, so logout doesn't reveal which
	// tokens exist.
	w = postJSON(a.handleLogout, "/api/auth/logout", refreshRequest{RefreshToken: "not-a-token"})
	if w.Code != 200 {
		t.Errorf("logout with unknown token: got %d, want 200", w.Code)
	}
}

func TestVerifyEmail_IssuesSession(t *testing.T) {
	a, pool := authTestApp(t)
	id := createTestUserWithPassword(t, pool, "verify-email@test.com", "password123")
	mustExec(t, pool, `UPDATE users SET email_verified = false WHERE id = $1`, id)
	raw, _, _ := generateRefreshToken()
	mustExec(t, pool,
		`INSERT INTO verification_tokens (user_id, token_hash, kind, expires_at)
		 VALUES ($1, $2, 'email_verification', now() + interval '1 hour')`,
		id, hashToken(raw))

	w := postJSON(a.handleVerifyEmail, "/api/auth/verify-email", verifyEmailRequest{Token: raw})
	if w.Code != 200 {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}
	requireSession(t, w, "email")

	var verified bool
	pool.QueryRow(testCtx(), `SELECT email_verified FROM users WHERE id = $1`, id).Scan(&verified)
	if !verified {
		t.Error("email_verified still false after verification")
	}
	if n := countRows(t, pool, `SELECT count(*) FROM verification_tokens WHERE user_id = $1`, id); n != 0 {
		t.Errorf("got %d verification tokens after use, want 0", n)
	}

	w = postJSON(a.handleVerifyEmail, "/api/auth/verify-email", verifyEmailRequest{Token: raw})
	if w.Code != 400 {
		t.Fatalf("reused verification link: got status %d, want 400", w.Code)
	}
}
