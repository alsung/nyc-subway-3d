package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

type createCommuteRequest struct {
	OriginStopID string `json:"originStopId"`
	OriginName   string `json:"originName"`
	DestStopID   string `json:"destStopId"`
	DestName     string `json:"destName"`
	Label        string `json:"label"`
}

type updateCommuteRequest struct {
	Label string `json:"label"`
}

func (a *app) handleListCommutes(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	commutes, err := a.commutes.ListCommutes(r.Context(), user.ID)
	if err != nil {
		slog.Error("list commutes failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"commutes": commutes})
}

func (a *app) handleCreateCommute(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())

	var req createCommuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.OriginStopID == "" || req.OriginName == "" || req.DestStopID == "" || req.DestName == "" {
		http.Error(w, `{"error":"originStopId, originName, destStopId, and destName are required"}`, http.StatusBadRequest)
		return
	}

	label := req.Label
	if label == "" {
		label = req.OriginName + " to " + req.DestName
	}

	c, err := a.commutes.CreateCommute(r.Context(), user.ID, CreateCommuteParams{
		OriginStopID: req.OriginStopID,
		OriginName:   req.OriginName,
		DestStopID:   req.DestStopID,
		DestName:     req.DestName,
		Label:        label,
	})
	if errors.Is(err, ErrLimitReached) {
		http.Error(w, `{"error":"maximum of 20 saved commutes"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		slog.Error("create commute failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(c)
}

func (a *app) handleUpdateCommute(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	commuteID := r.PathValue("id")

	var req updateCommuteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	err := a.commutes.UpdateCommuteLabel(r.Context(), commuteID, user.ID, req.Label)
	if errors.Is(err, ErrNotFound) {
		http.Error(w, `{"error":"commute not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("update commute failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (a *app) handleDeleteCommute(w http.ResponseWriter, r *http.Request) {
	user := userFromContext(r.Context())
	commuteID := r.PathValue("id")

	err := a.commutes.DeleteCommute(r.Context(), commuteID, user.ID)
	if errors.Is(err, ErrNotFound) {
		http.Error(w, `{"error":"commute not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Error("delete commute failed", "err", err)
		http.Error(w, `{"error":"internal server error"}`, http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
