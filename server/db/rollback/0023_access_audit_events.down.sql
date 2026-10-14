-- Reverses migration 0023_access_audit_events for an emergency rollback to a
-- release from before it. Run it before 0022's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0023_access_audit_events.down.sql
--
-- The access audit trail goes with it: who revoked which command-line token
-- or disconnected which agent. Export it first if it must be kept.

SET LOCAL lock_timeout = '10s';

DROP TABLE "access_audit_events";
DROP FUNCTION field_refuse_access_audit_change();

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791961956744;
