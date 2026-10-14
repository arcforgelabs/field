-- Reverses migration 0024_update_check for an emergency rollback to a release
-- from before it. Run it before 0023's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0024_update_check.down.sql
--
-- Only the owner's choice goes with it: after 0024 is applied again, the
-- update check is on until an owner turns it off in Settings.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "business_settings" DROP COLUMN "update_check";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791971764020;
