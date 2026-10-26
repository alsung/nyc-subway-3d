-- Only active accounts reserve an email. A soft-deleted row keeps its email for
-- the 30-day purge window, and must not block signing up again or Google
-- sign-in creating a fresh account. Every email lookup already filters on
-- deleted_at IS NULL, so this index also serves those queries.
BEGIN;
ALTER TABLE users DROP CONSTRAINT users_email_key;
CREATE UNIQUE INDEX users_email_active_key ON users (email) WHERE deleted_at IS NULL;
COMMIT;
