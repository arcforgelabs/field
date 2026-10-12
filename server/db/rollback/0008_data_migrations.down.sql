-- Reverses migration 0008_data_migrations for an emergency rollback to a
-- release from before it. Run as the database owner, in ONE transaction,
-- after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0008_data_migrations.down.sql
--
-- The ledger goes; the data migrations it records stay applied (their
-- changes are additive: uids next to codes, renamed items). Releases before
-- 0008 neither read nor need it. Roll back 0008 before 0007.

SET LOCAL lock_timeout = '10s';

DROP TABLE "data_migrations";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791767471381;
