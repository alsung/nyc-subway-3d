-- Fails if an email exists on both an active and a soft-deleted row. That is
-- deliberate: resolving it means deleting user rows, which a rollback should
-- not do silently.
BEGIN;
DROP INDEX users_email_active_key;
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
COMMIT;
