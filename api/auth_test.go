package main

import (
	"strings"
	"testing"
)

func TestInitJWT_FailsClosedWithADatabase(t *testing.T) {
	prev := jwtSecret
	t.Cleanup(func() { jwtSecret = prev })

	for _, secret := range []string{"", strings.Repeat("s", minJWTSecretBytes-1)} {
		if err := initJWT(secret, true); err == nil {
			t.Errorf("a %d-byte secret with a database: want an error, got none", len(secret))
		}
	}

	long := strings.Repeat("s", minJWTSecretBytes)
	if err := initJWT(long, true); err != nil {
		t.Fatalf("a %d-byte secret: %v", len(long), err)
	}
	if string(jwtSecret) != long {
		t.Error("the configured secret was not used")
	}
}

// Without a database no route issues tokens, so startup goes ahead with a
// random secret rather than a hardcoded one anyone could read in the repo.
func TestInitJWT_NoDatabase(t *testing.T) {
	prev := jwtSecret
	t.Cleanup(func() { jwtSecret = prev })

	if err := initJWT("", false); err != nil {
		t.Fatalf("no database, no secret: %v", err)
	}
	first := string(jwtSecret)
	initJWT("", false)
	if len(first) != minJWTSecretBytes || first == string(jwtSecret) {
		t.Errorf("want a fresh random %d-byte secret each start", minJWTSecretBytes)
	}
}
