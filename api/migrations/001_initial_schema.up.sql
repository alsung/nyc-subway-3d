CREATE TABLE users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT UNIQUE NOT NULL,
    display_name   TEXT NOT NULL DEFAULT '',
    avatar_url     TEXT NOT NULL DEFAULT '',
    password_hash  TEXT NOT NULL DEFAULT '',
    provider       TEXT NOT NULL DEFAULT 'email',
    email_verified BOOLEAN NOT NULL DEFAULT false,
    tier           TEXT NOT NULL DEFAULT 'free',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ
);

CREATE TABLE features (
    name          TEXT PRIMARY KEY,
    required_tier TEXT NOT NULL DEFAULT 'everyone',
    description   TEXT NOT NULL DEFAULT ''
);

INSERT INTO features (name, required_tier, description) VALUES
    ('trip_planner',             'everyone', 'A-to-B trip planning'),
    ('car_positioning',          'everyone', 'Basic car positioning (front/middle/back)'),
    ('detailed_car_positioning', 'everyone', 'Exact door and exit positioning'),
    ('saved_commutes',           'everyone', 'Save and manage commute routes'),
    ('smart_notifications',      'everyone', 'Push alerts for departures and delays'),
    ('ai_assistant',             'everyone', 'Natural language trip queries via Claude'),
    ('commute_analytics',        'everyone', 'Historical reliability and delay patterns'),
    ('elevator_alerts',          'everyone', 'Proactive elevator outage notifications');
