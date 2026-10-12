-- Reverses migration 0016_business_settings for an emergency rollback to a
-- release from before it. Run it before 0015's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0016_business_settings.down.sql
--
-- The settings go with it: after 0016 is applied again, every organisation
-- is back on the defaults until an owner changes them in Settings.

SET LOCAL lock_timeout = '10s';

DROP TABLE "business_settings";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791810914672;
