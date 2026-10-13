-- Reverses migration 0019_integration_credentials for an emergency rollback
-- to a release from before it. Run it before 0018's, if that is rolled back
-- too. Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0019_integration_credentials.down.sql
--
-- The credentials entered in Settings and their audit history go with it.
-- The release before reads the Xero client id and secret only from
-- XERO_CLIENT_ID and XERO_CLIENT_SECRET, and cannot read tokens this release
-- encrypted: the owner sets those secrets and connects Xero again.

SET LOCAL lock_timeout = '10s';

-- Every organisation's row: the owner bypasses row-level security for this
-- one statement (FORCE is put back straight after).
ALTER TABLE "xero_connections" NO FORCE ROW LEVEL SECURITY;
UPDATE "xero_connections" SET "status" = 'needs_reconnect', "reconnect_reason" = 'TOKEN_DECRYPT_FAILED', "access_token_enc" = NULL
  WHERE "refresh_token_enc" LIKE 'fs1.%';
ALTER TABLE "xero_connections" FORCE ROW LEVEL SECURITY;
DROP TABLE "integration_audit_events";
DROP FUNCTION field_refuse_integration_audit_change();
DROP TABLE "integration_credentials";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791870921310;
