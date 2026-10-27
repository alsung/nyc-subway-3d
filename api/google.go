package main

import (
	"context"
	"fmt"

	"google.golang.org/api/idtoken"
)

type googleClaims struct {
	Email   string
	Name    string
	Picture string
}

// A variable rather than a function so handler tests can stand in for Google,
// which only signs tokens for real accounts.
var verifyGoogleIDToken = func(ctx context.Context, token, clientID string) (*googleClaims, error) {
	payload, err := idtoken.Validate(ctx, token, clientID)
	if err != nil {
		return nil, fmt.Errorf("invalid id token: %w", err)
	}

	email, _ := payload.Claims["email"].(string)
	if email == "" {
		return nil, fmt.Errorf("id token missing email claim")
	}

	emailVerified, _ := payload.Claims["email_verified"].(bool)
	if !emailVerified {
		return nil, fmt.Errorf("google email not verified")
	}

	name, _ := payload.Claims["name"].(string)
	picture, _ := payload.Claims["picture"].(string)

	return &googleClaims{
		Email:   email,
		Name:    name,
		Picture: picture,
	}, nil
}
