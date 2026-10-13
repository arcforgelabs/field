-- Reverses migration 0021_integration_setup for an emergency rollback to a
-- release from before it. Run it before 0020's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0021_integration_setup.down.sql
--
-- The Connect wizard's state goes with it, with any pending credentials (the
-- owner enters them again), and the audit events of the wizard's steps: the
-- release before cannot hold those actions. The append-only trigger is
-- turned off for that one statement and on again straight after.

SET LOCAL lock_timeout = '10s';

DROP TABLE "integration_setup";

ALTER TABLE "integration_audit_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_audit_events" DISABLE TRIGGER "integration_audit_events_append_only";
DELETE FROM "integration_audit_events"
  WHERE "action" in ('setup_step','secrets_key_generated','pending_credentials_stored','pending_credentials_promoted','pending_credentials_discarded');
ALTER TABLE "integration_audit_events" ENABLE TRIGGER "integration_audit_events_append_only";
ALTER TABLE "integration_audit_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_audit_events" DROP CONSTRAINT "integration_audit_events_action_check";
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_action_check" CHECK ("integration_audit_events"."action" in ('credentials_set','credentials_replaced','credentials_removed','connected','disconnected','tokens_rewrapped','tokens_unreadable'));

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791897743588;
