package main

import (
	"context"
	"errors"
	"time"
)

var ErrNotFound = errors.New("not found")
var ErrLimitReached = errors.New("limit reached")

type Commute struct {
	ID           string    `json:"id"`
	UserID       string    `json:"-"`
	OriginStopID string    `json:"originStopId"`
	OriginName   string    `json:"originName"`
	DestStopID   string    `json:"destStopId"`
	DestName     string    `json:"destName"`
	Label        string    `json:"label"`
	CreatedAt    time.Time `json:"createdAt"`
}

type CreateCommuteParams struct {
	OriginStopID string
	OriginName   string
	DestStopID   string
	DestName     string
	Label        string
}

type CommuteStore interface {
	ListCommutes(ctx context.Context, userID string) ([]Commute, error)
	CreateCommute(ctx context.Context, userID string, p CreateCommuteParams) (Commute, error)
	UpdateCommuteLabel(ctx context.Context, id, userID, label string) error
	DeleteCommute(ctx context.Context, id, userID string) error
}
