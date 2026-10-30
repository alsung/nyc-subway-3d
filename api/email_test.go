package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

// stubResend points sendEmail at a fake Resend for one test.
func stubResend(t *testing.T, handler http.HandlerFunc, timeout time.Duration) {
	t.Helper()
	srv := httptest.NewServer(handler)
	prevKey, prevURL, prevClient := resendAPIKey, resendURL, emailClient
	resendAPIKey, resendURL, emailClient = "test-key", srv.URL, &http.Client{Timeout: timeout}
	t.Cleanup(func() {
		resendAPIKey, resendURL, emailClient = prevKey, prevURL, prevClient
		srv.Close()
	})
}

func emailCount(kind, result string) float64 {
	return testutil.ToFloat64(metricEmailSend.WithLabelValues(kind, result))
}

func TestSendEmail_CountsOutcomes(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		result  string
	}{
		{"accepted", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }, "success"},
		{"server error", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }, "failure"},
		// Hangs past the client timeout: the request gives up instead of
		// holding the sign-up request open.
		{"timeout", func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-r.Context().Done():
			case <-time.After(300 * time.Millisecond):
			}
		}, "failure"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stubResend(t, c.handler, 100*time.Millisecond)
			before := emailCount(emailPasswordReset, c.result)

			start := time.Now()
			err := sendPasswordResetEmail("someone@test.com", "token")
			if (err != nil) != (c.result == "failure") {
				t.Errorf("err = %v, want failure=%v", err, c.result == "failure")
			}
			if took := time.Since(start); took > time.Second {
				t.Errorf("took %v; the client timeout should have stopped it", took)
			}
			if got := emailCount(emailPasswordReset, c.result) - before; got != 1 {
				t.Errorf("email_send_total{kind=password_reset,result=%s} rose by %v, want 1", c.result, got)
			}
		})
	}
}

// Local dev has no API key: nothing is sent and nothing is counted.
func TestSendEmail_NoKeyCountsNothing(t *testing.T) {
	prev := resendAPIKey
	resendAPIKey = ""
	t.Cleanup(func() { resendAPIKey = prev })

	before := emailCount(emailVerification, "success") + emailCount(emailVerification, "failure")
	if err := sendVerificationEmail("someone@test.com", "token"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if after := emailCount(emailVerification, "success") + emailCount(emailVerification, "failure"); after != before {
		t.Error("a skipped email was counted")
	}
}
