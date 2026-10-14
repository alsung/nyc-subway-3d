package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maxCommutesPerUser = 20

type pgStore struct {
	pool *pgxpool.Pool
}

func newPGStore(pool *pgxpool.Pool) *pgStore {
	return &pgStore{pool: pool}
}

func (s *pgStore) ListCommutes(ctx context.Context, userID string) ([]Commute, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, origin_stop_id, origin_name, dest_stop_id, dest_name, label, created_at
		 FROM commutes WHERE user_id = $1
		 ORDER BY created_at DESC`,
		userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var commutes []Commute
	for rows.Next() {
		var c Commute
		if err := rows.Scan(&c.ID, &c.OriginStopID, &c.OriginName, &c.DestStopID, &c.DestName, &c.Label, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.UserID = userID
		commutes = append(commutes, c)
	}
	if commutes == nil {
		commutes = []Commute{}
	}
	return commutes, rows.Err()
}

func (s *pgStore) CreateCommute(ctx context.Context, userID string, p CreateCommuteParams) (Commute, error) {
	var count int
	if err := s.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM commutes WHERE user_id = $1`, userID,
	).Scan(&count); err != nil {
		return Commute{}, err
	}
	if count >= maxCommutesPerUser {
		return Commute{}, ErrLimitReached
	}

	var c Commute
	err := s.pool.QueryRow(ctx,
		`INSERT INTO commutes (user_id, origin_stop_id, origin_name, dest_stop_id, dest_name, label)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, created_at`,
		userID, p.OriginStopID, p.OriginName, p.DestStopID, p.DestName, p.Label,
	).Scan(&c.ID, &c.CreatedAt)
	if err != nil {
		return Commute{}, err
	}

	c.UserID = userID
	c.OriginStopID = p.OriginStopID
	c.OriginName = p.OriginName
	c.DestStopID = p.DestStopID
	c.DestName = p.DestName
	c.Label = p.Label
	return c, nil
}

func (s *pgStore) UpdateCommuteLabel(ctx context.Context, id, userID, label string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE commutes SET label = $1 WHERE id = $2 AND user_id = $3`,
		label, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Check if it exists at all to distinguish "not yours" from "doesn't exist"
		var exists bool
		_ = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM commutes WHERE id = $1)`, id).Scan(&exists)
		if exists {
			return ErrNotFound
		}
		return ErrNotFound
	}
	return nil
}

func (s *pgStore) DeleteCommute(ctx context.Context, id, userID string) error {
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM commutes WHERE id = $1 AND user_id = $2`,
		id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Could be the wrong user or doesn't exist; either way the caller
		// shouldn't know which, so both return the same 404.
		return ErrNotFound
	}
	return nil
}

// verifyNotFound returns ErrNotFound if the underlying error is pgx.ErrNoRows.
func verifyNotFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
