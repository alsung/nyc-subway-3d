CREATE TABLE commutes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin_stop_id TEXT NOT NULL,
    origin_name    TEXT NOT NULL,
    dest_stop_id   TEXT NOT NULL,
    dest_name      TEXT NOT NULL,
    label          TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_commutes_user_id ON commutes(user_id);
