-- Reverses migration 0014_invoice_issue for an emergency rollback to a
-- release from before it. Run it before 0013's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0014_invoice_issue.down.sql
--
-- It refuses once any invoice was issued with an INV number: that invoice is
-- an issued document, and a release from before 0014 would issue the same
-- milestone again under its old EI-… number. Roll back only before the first
-- INV invoice is issued.

SET LOCAL lock_timeout = '10s';

-- The check reads every organisation's invoices: as their owner, with FORCE
-- lifted for this transaction only (it is put back before the end).
ALTER TABLE "invoices" NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "invoices" WHERE "issue_key" IS NOT NULL) THEN
    RAISE EXCEPTION 'invoices were issued with INV numbers; 0014 cannot be rolled back';
  END IF;
END
$$;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;

ALTER TABLE "invoices" DROP CONSTRAINT "invoices_issue_check";
DROP INDEX "invoices_org_sequence_number_key";
DROP INDEX "invoices_org_issue_key";
ALTER TABLE "invoices" DROP COLUMN "issue_key";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791806284406;
