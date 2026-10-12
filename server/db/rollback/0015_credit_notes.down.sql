-- Reverses migration 0015_credit_notes for an emergency rollback to a
-- release from before it. Run it before 0014's and 0013's, if those are
-- rolled back too. Run as the database owner, in ONE transaction, after
-- stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0015_credit_notes.down.sql
--
-- It refuses once a credit note was issued: that is an issued document, and
-- a release from before 0015 would revise the invoice in place again.

SET LOCAL lock_timeout = '10s';

-- The check reads every organisation's credit notes: as their owner, with
-- FORCE lifted for this transaction only (it is put back before the end).
ALTER TABLE "credit_notes" NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "credit_notes" WHERE "issued_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'credit notes were issued; 0015 cannot be rolled back';
  END IF;
END
$$;

DROP TABLE "payment_allocations";
DROP FUNCTION field_refuse_payment_allocation_change();
ALTER TABLE "credit_notes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_issue_check";
ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_replacement_invoice_fk";
DROP INDEX "credit_notes_org_invoice_key";
DROP INDEX "credit_notes_org_issue_key";
ALTER TABLE "credit_notes" DROP COLUMN "issue_key";
ALTER TABLE "credit_notes" DROP COLUMN "replacement_invoice_uid";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791807944126;
