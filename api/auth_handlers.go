package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

type registerRequest struct {
	Email       string `json:"email"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

type authResponse struct {
	AccessToken  string   `json:"accessToken"`
	RefreshToken string   `json:"refreshToken"`
	User         userView `json:"user"`
}

type userView struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
	Tier        string `json:"tier"`
	Provider    string `json:"provider"`
}

type googleAuthRequest struct {
	IDToken string `json:"idToken"`
}

func (a *app) handleGoogleAuth(w http.ResponseWriter, r *http.Request) {
	var req googleAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.IDToken == "" {
		http.Error(w, `{"error":"idToken is required"}`, http.StatusBadRequest)
		return
	}

	claims, err := verifyGoogleIDToken(r.Context(), req.IDToken, a.googleClientID)
	if err != nil {
		slog.Error("google token verification failed", "err", err)
		http.Error(w, `{"error":"invalid Google ID token"}`, http.StatusUnauthorized)
		return
	}

	email := strings.ToLower(claims.Email)

	var userID, displayName, avatarURL, tier, provider string
	err = a.dbPool.QueryRow(r.Context(),
		`SELECT id, display_name, avatar_url, tier, provider
		 FROM users WHERE email = $1 AND deleted_at IS NULL`,
		email,
	).Scan(&userID, &displayName, &avatarURL, &tier, &provider)

	if err == nil {
		if provider != "google" {
			http.Error(w, `{"error":"account exists with email/password, please sign in with your password"}`, http.StatusConflict)
			return
		}
		// Existing Google user: update name/avatar from Google profile
		if claims.Name != "" {
			displayName = claims.Name
		}
		if claims.Picture != "" {
			avatarURL = claims.Picture
		}
		a.dbPool.Exec(r.Context(),
			`UPDATE users SET display_name = $1, avatar_url = $2, updated_at = now()
			 WHERE id = $3`,
			displayName, avatarURL, userID,
		)
	} else {
		// New user via Google
		displayName = claims.Name
		if displayName == "" {
			displayName = strings.Split(email, "@")[0]
		}
		avatarURL = claims.Picture

		err = a.dbPool.QueryRow(r.Context(),
			`INSERT INTO users (email, display_name, avatar_url, provider, email_verified)
			 VALUES ($1, $2, $3, 'google', true)
			 RETURNING id, tier`,
			email, displayName, avatarURL,
		).Scan(&userID, &tier)

		if err != nil {
			slog.Error("insert google user failed", "err", err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}
	}

	accessToken, err := signAccessToken(userID, email, tier)
	if err != nil {
		slog.Error("sign access token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	rawRefresh, hashedRefresh, err := generateRefreshToken()
	if err != nil {
		slog.Error("generate refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, $3)`,
		userID, hashedRefresh, time.Now().Add(7*24*time.Hour),
	)
	if err != nil {
		slog.Error("insert refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(authResponse{
		AccessToken:  accessToken,
		RefreshToken: rawRefresh,
		User: userView{
			ID:          userID,
			Email:       email,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Tier:        tier,
			Provider:    "google",
		},
	})
}

func (a *app) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	req.DisplayName = strings.TrimSpace(req.DisplayName)

	if req.Email == "" || req.Password == "" || req.DisplayName == "" {
		http.Error(w, `{"error":"email, password, and displayName are required"}`, http.StatusBadRequest)
		return
	}
	if len(req.Password) < 8 {
		http.Error(w, `{"error":"password must be at least 8 characters"}`, http.StatusBadRequest)
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		slog.Error("bcrypt hash failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	verified := devAutoVerify

	var userID, email, displayName, avatarURL, tier string
	err = a.dbPool.QueryRow(r.Context(),
		`INSERT INTO users (email, password_hash, display_name, provider, email_verified)
		 VALUES ($1, $2, $3, 'email', $4)
		 RETURNING id, email, display_name, avatar_url, tier`,
		req.Email, string(hash), req.DisplayName, verified,
	).Scan(&userID, &email, &displayName, &avatarURL, &tier)

	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			http.Error(w, `{"error":"email already registered"}`, http.StatusConflict)
			return
		}
		slog.Error("insert user failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	if devAutoVerify {
		accessToken, err := signAccessToken(userID, email, tier)
		if err != nil {
			slog.Error("sign access token failed", "err", err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}
		rawRefresh, hashedRefresh, err := generateRefreshToken()
		if err != nil {
			slog.Error("generate refresh token failed", "err", err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}
		_, err = a.dbPool.Exec(r.Context(),
			`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
			 VALUES ($1, $2, $3)`,
			userID, hashedRefresh, time.Now().Add(7*24*time.Hour),
		)
		if err != nil {
			slog.Error("insert refresh token failed", "err", err)
			http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(authResponse{
			AccessToken:  accessToken,
			RefreshToken: rawRefresh,
			User: userView{
				ID:          userID,
				Email:       email,
				DisplayName: displayName,
				AvatarURL:   avatarURL,
				Tier:        tier,
				Provider:    "email",
			},
		})
		return
	}

	rawToken, hashedToken, err := generateRefreshToken()
	if err != nil {
		slog.Error("generate verification token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`INSERT INTO verification_tokens (user_id, token_hash, kind, expires_at)
		 VALUES ($1, $2, 'email_verification', $3)`,
		userID, hashedToken, time.Now().Add(24*time.Hour),
	)
	if err != nil {
		slog.Error("insert verification token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	if err := sendVerificationEmail(email, rawToken); err != nil {
		slog.Error("send verification email failed", "err", err)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"message": "Check your email to verify your account",
	})
}

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	var userID, email, displayName, avatarURL, tier, passwordHash, provider string
	var emailVerified bool
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT id, email, display_name, avatar_url, tier, password_hash, provider, email_verified
		 FROM users
		 WHERE email = $1 AND deleted_at IS NULL`,
		req.Email,
	).Scan(&userID, &email, &displayName, &avatarURL, &tier, &passwordHash, &provider, &emailVerified)

	if err != nil {
		http.Error(w, `{"error":"invalid email or password"}`, http.StatusUnauthorized)
		return
	}

	if provider == "google" {
		http.Error(w, `{"error":"this account uses Google sign-in"}`, http.StatusConflict)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.Password)); err != nil {
		http.Error(w, `{"error":"invalid email or password"}`, http.StatusUnauthorized)
		return
	}

	if !emailVerified {
		http.Error(w, `{"error":"please verify your email before signing in"}`, http.StatusForbidden)
		return
	}

	accessToken, err := signAccessToken(userID, email, tier)
	if err != nil {
		slog.Error("sign access token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	rawRefresh, hashedRefresh, err := generateRefreshToken()
	if err != nil {
		slog.Error("generate refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, $3)`,
		userID, hashedRefresh, time.Now().Add(7*24*time.Hour),
	)
	if err != nil {
		slog.Error("insert refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(authResponse{
		AccessToken:  accessToken,
		RefreshToken: rawRefresh,
		User: userView{
			ID:          userID,
			Email:       email,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Tier:        tier,
			Provider:    provider,
		},
	})
}

func (a *app) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.RefreshToken == "" {
		http.Error(w, `{"error":"refreshToken is required"}`, http.StatusBadRequest)
		return
	}

	hashed := hashToken(req.RefreshToken)

	var tokenID, userID string
	var expiresAt time.Time
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT rt.id, rt.user_id, rt.expires_at
		 FROM refresh_tokens rt
		 WHERE rt.token_hash = $1`,
		hashed,
	).Scan(&tokenID, &userID, &expiresAt)

	if err != nil {
		http.Error(w, `{"error":"invalid refresh token"}`, http.StatusUnauthorized)
		return
	}

	if time.Now().After(expiresAt) {
		a.dbPool.Exec(r.Context(), `DELETE FROM refresh_tokens WHERE id = $1`, tokenID)
		http.Error(w, `{"error":"refresh token expired"}`, http.StatusUnauthorized)
		return
	}

	// Delete old token (rotation)
	a.dbPool.Exec(r.Context(), `DELETE FROM refresh_tokens WHERE id = $1`, tokenID)

	var email, displayName, avatarURL, tier, provider string
	err = a.dbPool.QueryRow(r.Context(),
		`SELECT email, display_name, avatar_url, tier, provider
		 FROM users WHERE id = $1 AND deleted_at IS NULL`,
		userID,
	).Scan(&email, &displayName, &avatarURL, &tier, &provider)

	if err != nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusUnauthorized)
		return
	}

	accessToken, err := signAccessToken(userID, email, tier)
	if err != nil {
		slog.Error("sign access token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	rawRefresh, hashedRefresh, err := generateRefreshToken()
	if err != nil {
		slog.Error("generate refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, $3)`,
		userID, hashedRefresh, time.Now().Add(7*24*time.Hour),
	)
	if err != nil {
		slog.Error("insert refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(authResponse{
		AccessToken:  accessToken,
		RefreshToken: rawRefresh,
		User: userView{
			ID:          userID,
			Email:       email,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Tier:        tier,
			Provider:    provider,
		},
	})
}

func (a *app) handleLogout(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RefreshToken == "" {
		http.Error(w, `{"error":"refreshToken is required"}`, http.StatusBadRequest)
		return
	}

	hashed := hashToken(req.RefreshToken)
	u := userFromContext(r.Context())

	a.dbPool.Exec(r.Context(),
		`DELETE FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2`,
		hashed, u.ID,
	)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"message": "signed out"})
}

type verifyEmailRequest struct {
	Token string `json:"token"`
}

func (a *app) handleVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req verifyEmailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		http.Error(w, `{"error":"token is required"}`, http.StatusBadRequest)
		return
	}

	hashed := hashToken(req.Token)

	var tokenID, userID string
	var expiresAt time.Time
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT id, user_id, expires_at FROM verification_tokens
		 WHERE token_hash = $1 AND kind = 'email_verification'`,
		hashed,
	).Scan(&tokenID, &userID, &expiresAt)

	if err != nil {
		http.Error(w, `{"error":"invalid or expired verification link"}`, http.StatusBadRequest)
		return
	}

	if time.Now().After(expiresAt) {
		a.dbPool.Exec(r.Context(), `DELETE FROM verification_tokens WHERE id = $1`, tokenID)
		http.Error(w, `{"error":"verification link has expired, please request a new one"}`, http.StatusBadRequest)
		return
	}

	a.dbPool.Exec(r.Context(), `DELETE FROM verification_tokens WHERE id = $1`, tokenID)

	var email, displayName, avatarURL, tier, provider string
	err = a.dbPool.QueryRow(r.Context(),
		`UPDATE users SET email_verified = true, updated_at = now()
		 WHERE id = $1 AND deleted_at IS NULL
		 RETURNING email, display_name, avatar_url, tier, provider`,
		userID,
	).Scan(&email, &displayName, &avatarURL, &tier, &provider)

	if err != nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusBadRequest)
		return
	}

	accessToken, err := signAccessToken(userID, email, tier)
	if err != nil {
		slog.Error("sign access token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	rawRefresh, hashedRefresh, err := generateRefreshToken()
	if err != nil {
		slog.Error("generate refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
		 VALUES ($1, $2, $3)`,
		userID, hashedRefresh, time.Now().Add(7*24*time.Hour),
	)
	if err != nil {
		slog.Error("insert refresh token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(authResponse{
		AccessToken:  accessToken,
		RefreshToken: rawRefresh,
		User: userView{
			ID:          userID,
			Email:       email,
			DisplayName: displayName,
			AvatarURL:   avatarURL,
			Tier:        tier,
			Provider:    provider,
		},
	})
}

type resendVerificationRequest struct {
	Email string `json:"email"`
}

func (a *app) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	var req resendVerificationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
		http.Error(w, `{"error":"email is required"}`, http.StatusBadRequest)
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	w.Header().Set("Content-Type", "application/json")

	var userID string
	var emailVerified bool
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT id, email_verified FROM users
		 WHERE email = $1 AND provider = 'email' AND deleted_at IS NULL`,
		req.Email,
	).Scan(&userID, &emailVerified)

	if err != nil || emailVerified {
		json.NewEncoder(w).Encode(map[string]string{
			"message": "If that email is registered, a verification link has been sent",
		})
		return
	}

	var recentCount int
	a.dbPool.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM verification_tokens
		 WHERE user_id = $1 AND kind = 'email_verification'
		 AND created_at > $2`,
		userID, time.Now().Add(-1*time.Hour),
	).Scan(&recentCount)

	if recentCount >= 3 {
		json.NewEncoder(w).Encode(map[string]string{
			"message": "If that email is registered, a verification link has been sent",
		})
		return
	}

	a.dbPool.Exec(r.Context(),
		`DELETE FROM verification_tokens WHERE user_id = $1 AND kind = 'email_verification'`,
		userID,
	)

	rawToken, hashedToken, err := generateRefreshToken()
	if err != nil {
		slog.Error("generate verification token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`INSERT INTO verification_tokens (user_id, token_hash, kind, expires_at)
		 VALUES ($1, $2, 'email_verification', $3)`,
		userID, hashedToken, time.Now().Add(24*time.Hour),
	)
	if err != nil {
		slog.Error("insert verification token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	if err := sendVerificationEmail(req.Email, rawToken); err != nil {
		slog.Error("send verification email failed", "err", err)
	}

	json.NewEncoder(w).Encode(map[string]string{
		"message": "If that email is registered, a verification link has been sent",
	})
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

func (a *app) handleForgotPassword(w http.ResponseWriter, r *http.Request) {
	var req forgotPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" {
		http.Error(w, `{"error":"email is required"}`, http.StatusBadRequest)
		return
	}

	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	w.Header().Set("Content-Type", "application/json")

	var userID string
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT id FROM users
		 WHERE email = $1 AND provider = 'email' AND deleted_at IS NULL`,
		req.Email,
	).Scan(&userID)

	if err != nil {
		json.NewEncoder(w).Encode(map[string]string{
			"message": "If that email is registered, a password reset link has been sent",
		})
		return
	}

	a.dbPool.Exec(r.Context(),
		`DELETE FROM verification_tokens WHERE user_id = $1 AND kind = 'password_reset'`,
		userID,
	)

	rawToken, hashedToken, err := generateRefreshToken()
	if err != nil {
		slog.Error("generate reset token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`INSERT INTO verification_tokens (user_id, token_hash, kind, expires_at)
		 VALUES ($1, $2, 'password_reset', $3)`,
		userID, hashedToken, time.Now().Add(1*time.Hour),
	)
	if err != nil {
		slog.Error("insert reset token failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	if err := sendPasswordResetEmail(req.Email, rawToken); err != nil {
		slog.Error("send password reset email failed", "err", err)
	}

	json.NewEncoder(w).Encode(map[string]string{
		"message": "If that email is registered, a password reset link has been sent",
	})
}

type resetPasswordRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"newPassword"`
}

func (a *app) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var req resetPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Token == "" || req.NewPassword == "" {
		http.Error(w, `{"error":"token and newPassword are required"}`, http.StatusBadRequest)
		return
	}
	if len(req.NewPassword) < 8 {
		http.Error(w, `{"error":"password must be at least 8 characters"}`, http.StatusBadRequest)
		return
	}

	hashed := hashToken(req.Token)

	var tokenID, userID string
	var expiresAt time.Time
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT id, user_id, expires_at FROM verification_tokens
		 WHERE token_hash = $1 AND kind = 'password_reset'`,
		hashed,
	).Scan(&tokenID, &userID, &expiresAt)

	if err != nil {
		http.Error(w, `{"error":"invalid or expired reset link"}`, http.StatusBadRequest)
		return
	}

	if time.Now().After(expiresAt) {
		a.dbPool.Exec(r.Context(), `DELETE FROM verification_tokens WHERE id = $1`, tokenID)
		http.Error(w, `{"error":"reset link has expired, please request a new one"}`, http.StatusBadRequest)
		return
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		slog.Error("bcrypt hash failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	a.dbPool.Exec(r.Context(),
		`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
		string(newHash), userID,
	)

	a.dbPool.Exec(r.Context(), `DELETE FROM verification_tokens WHERE id = $1`, tokenID)
	a.dbPool.Exec(r.Context(), `DELETE FROM refresh_tokens WHERE user_id = $1`, userID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message": "Password updated. Please sign in.",
	})
}

func (a *app) handleMe(w http.ResponseWriter, r *http.Request) {
	u := userFromContext(r.Context())

	var displayName, avatarURL, tier, provider string
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT display_name, avatar_url, tier, provider
		 FROM users WHERE id = $1 AND deleted_at IS NULL`,
		u.ID,
	).Scan(&displayName, &avatarURL, &tier, &provider)

	if err != nil {
		if err == pgx.ErrNoRows {
			http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
			return
		}
		slog.Error("query user failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(userView{
		ID:          u.ID,
		Email:       u.Email,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
		Tier:        tier,
		Provider:    provider,
	})
}

type updateAccountRequest struct {
	DisplayName string `json:"displayName"`
}

func (a *app) handleUpdateAccount(w http.ResponseWriter, r *http.Request) {
	u := userFromContext(r.Context())

	var req updateAccountRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.DisplayName == "" {
		http.Error(w, `{"error":"displayName is required"}`, http.StatusBadRequest)
		return
	}
	if len(req.DisplayName) > 100 {
		http.Error(w, `{"error":"displayName must be 100 characters or fewer"}`, http.StatusBadRequest)
		return
	}

	var email, avatarURL, tier, provider string
	err := a.dbPool.QueryRow(r.Context(),
		`UPDATE users SET display_name = $1, updated_at = now()
		 WHERE id = $2 AND deleted_at IS NULL
		 RETURNING email, avatar_url, tier, provider`,
		req.DisplayName, u.ID,
	).Scan(&email, &avatarURL, &tier, &provider)

	if err != nil {
		if err == pgx.ErrNoRows {
			http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
			return
		}
		slog.Error("update account failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(userView{
		ID:          u.ID,
		Email:       email,
		DisplayName: req.DisplayName,
		AvatarURL:   avatarURL,
		Tier:        tier,
		Provider:    provider,
	})
}

func (a *app) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	u := userFromContext(r.Context())

	tag, err := a.dbPool.Exec(r.Context(),
		`UPDATE users SET deleted_at = now(), updated_at = now()
		 WHERE id = $1 AND deleted_at IS NULL`,
		u.ID,
	)
	if err != nil {
		slog.Error("soft-delete account failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	a.dbPool.Exec(r.Context(),
		`DELETE FROM refresh_tokens WHERE user_id = $1`, u.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message": "Account scheduled for deletion",
	})
}

type changePasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func (a *app) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u := userFromContext(r.Context())

	var req changePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		http.Error(w, `{"error":"currentPassword and newPassword are required"}`, http.StatusBadRequest)
		return
	}
	if len(req.NewPassword) < 8 {
		http.Error(w, `{"error":"new password must be at least 8 characters"}`, http.StatusBadRequest)
		return
	}

	var passwordHash, provider string
	err := a.dbPool.QueryRow(r.Context(),
		`SELECT password_hash, provider FROM users
		 WHERE id = $1 AND deleted_at IS NULL`,
		u.ID,
	).Scan(&passwordHash, &provider)

	if err != nil {
		if err == pgx.ErrNoRows {
			http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
			return
		}
		slog.Error("query user for password change failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	if provider == "google" {
		http.Error(w, `{"error":"password change is not available for Google accounts"}`, http.StatusBadRequest)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(req.CurrentPassword)); err != nil {
		http.Error(w, `{"error":"incorrect current password"}`, http.StatusUnauthorized)
		return
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		slog.Error("bcrypt hash failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	_, err = a.dbPool.Exec(r.Context(),
		`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
		string(newHash), u.ID,
	)
	if err != nil {
		slog.Error("update password failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	a.dbPool.Exec(r.Context(),
		`DELETE FROM refresh_tokens WHERE user_id = $1`, u.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"message": "Password changed. Please sign in again.",
	})
}
