package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const userContextKey contextKey = "user"

type jwtClaims struct {
	jwt.RegisteredClaims
	Email string `json:"email"`
	Tier  string `json:"tier"`
}

var jwtSecret []byte

// minJWTSecretBytes matches HS256's key size; a shorter secret is guessable
// offline from any one token.
const minJWTSecretBytes = 32

// initJWT sets the signing secret. With a database, sign-in routes exist and
// the secret must be real, so a missing or short one stops startup rather than
// signing tokens anyone could forge. Without a database no route issues or
// checks tokens; a random secret keeps that true even by accident.
func initJWT(secret string, hasDatabase bool) error {
	if hasDatabase && len(secret) < minJWTSecretBytes {
		return fmt.Errorf("JWT_SECRET must be at least %d bytes when DATABASE_URL is set (got %d)", minJWTSecretBytes, len(secret))
	}
	if secret == "" {
		random := make([]byte, minJWTSecretBytes)
		if _, err := rand.Read(random); err != nil {
			return fmt.Errorf("generate JWT secret: %w", err)
		}
		jwtSecret = random
		return nil
	}
	jwtSecret = []byte(secret)
	return nil
}

func signAccessToken(userID, email, tier string) (string, error) {
	claims := jwtClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
		},
		Email: email,
		Tier:  tier,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(jwtSecret)
}

func parseAccessToken(tokenStr string) (*jwtClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &jwtClaims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*jwtClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

func generateRefreshToken() (raw string, hashed string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	raw = hex.EncodeToString(b)
	h := sha256.Sum256([]byte(raw))
	hashed = hex.EncodeToString(h[:])
	return raw, hashed, nil
}

func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(h[:])
}

type authedUser struct {
	ID    string
	Email string
	Tier  string
}

func userFromContext(ctx context.Context) *authedUser {
	u, _ := ctx.Value(userContextKey).(*authedUser)
	return u
}

func requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := extractUser(r)
		if u == nil {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func optionalAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u := extractUser(r); u != nil {
			ctx := context.WithValue(r.Context(), userContextKey, u)
			r = r.WithContext(ctx)
		}
		next.ServeHTTP(w, r)
	})
}

func extractUser(r *http.Request) *authedUser {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return nil
	}
	tokenStr := strings.TrimPrefix(auth, "Bearer ")
	claims, err := parseAccessToken(tokenStr)
	if err != nil {
		return nil
	}
	return &authedUser{
		ID:    claims.Subject,
		Email: claims.Email,
		Tier:  claims.Tier,
	}
}
