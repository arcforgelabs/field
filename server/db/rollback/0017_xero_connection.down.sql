-- Reverses migration 0017_xero_connection for an emergency rollback to a
-- release from before it. Run it before 0016's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0017_xero_connection.down.sql
--
-- The Xero connection goes with it: its encrypted tokens and settings are
-- dropped, and the owner connects Xero again after 0017 is applied again.
-- Field's invoices are not touched. The connection stays listed in the Xero
-- organisation's Connected apps until the owner removes it there.

SET LOCAL lock_timeout = '10s';

DROP TABLE "xero_connections";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791862500086;
