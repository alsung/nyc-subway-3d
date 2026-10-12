package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
)

var (
	resendAPIKey    string
	devAutoVerify   bool
	appBaseURL      = "https://localexpress.nyc"
	emailFromAddr   = "Local Express <noreply@localexpress.nyc>"
)

func initEmail(apiKey, baseURL string, autoVerify bool) {
	resendAPIKey = apiKey
	devAutoVerify = autoVerify
	if baseURL != "" {
		appBaseURL = baseURL
	}
}

type resendPayload struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html"`
}

func sendEmail(to, subject, html string) error {
	if resendAPIKey == "" {
		slog.Warn("email skipped (no RESEND_API_KEY)", "to", to, "subject", subject)
		return nil
	}

	payload := resendPayload{
		From:    emailFromAddr,
		To:      []string{to},
		Subject: subject,
		HTML:    html,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal email payload: %w", err)
	}

	req, err := http.NewRequest("POST", "https://api.resend.com/emails", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+resendAPIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("send email: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		var errBody map[string]any
		json.NewDecoder(resp.Body).Decode(&errBody)
		return fmt.Errorf("resend API error %d: %v", resp.StatusCode, errBody)
	}

	slog.Info("email sent", "to", to, "subject", subject)
	return nil
}

func sendVerificationEmail(to, token string) error {
	link := appBaseURL + "/verify?token=" + token
	html := fmt.Sprintf(`<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a;">
  <h2 style="margin: 0 0 8px;">Welcome to Local Express</h2>
  <p style="margin: 0 0 24px; color: #555;">Verify your email to activate your account.</p>
  <a href="%s" style="display: inline-block; background: #0066ff; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Verify Email</a>
  <p style="margin: 24px 0 0; font-size: 13px; color: #888;">If you didn't create an account, ignore this email. This link expires in 24 hours.</p>
</body>
</html>`, link)

	return sendEmail(to, "Verify your Local Express account", html)
}

func sendPasswordResetEmail(to, token string) error {
	link := appBaseURL + "/reset-password?token=" + token
	html := fmt.Sprintf(`<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a;">
  <h2 style="margin: 0 0 8px;">Reset your password</h2>
  <p style="margin: 0 0 24px; color: #555;">Click below to choose a new password for your Local Express account.</p>
  <a href="%s" style="display: inline-block; background: #0066ff; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">Reset Password</a>
  <p style="margin: 24px 0 0; font-size: 13px; color: #888;">If you didn't request this, ignore this email. This link expires in 1 hour.</p>
</body>
</html>`, link)

	return sendEmail(to, "Reset your Local Express password", html)
}
