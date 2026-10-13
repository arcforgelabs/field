-- Reverses migration 0018_xero_invoice_sync for an emergency rollback to a
-- release from before it. Run it before 0017's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0018_xero_invoice_sync.down.sql
--
-- Field forgets which of its invoices are in Xero (and in which organisation)
-- and how each one went. The
-- invoices in Xero stay there. After 0018 is applied again, nothing is sent
-- by itself for invoices issued before; a retry or a send of one finds it in
-- Xero by its number and does not create it again.

SET LOCAL lock_timeout = '10s';

-- 0013's trigger function, before the columns it would read are dropped.
CREATE OR REPLACE FUNCTION field_refuse_issued_invoice_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'amount_paid', 'due_on', 'kind', 'note', 'version', 'updated_at', 'updated_by',
    'quote_uid', 'quote_version', 'quote_version_inferred', 'milestone_uid', 'issued_document_uid',
    'supersedes_invoice_uid', 'superseded_at'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'invoices cannot be truncated: issued invoices never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.issued_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice % was issued: delete refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR NEW.status = 'draft'
     OR (OLD.quote_uid IS NOT NULL AND NEW.quote_uid IS DISTINCT FROM OLD.quote_uid)
     OR (OLD.quote_version IS NOT NULL AND (NEW.quote_version IS DISTINCT FROM OLD.quote_version OR NEW.quote_version_inferred IS DISTINCT FROM OLD.quote_version_inferred))
     OR (OLD.milestone_uid IS NOT NULL AND NEW.milestone_uid IS DISTINCT FROM OLD.milestone_uid)
     OR (OLD.issued_document_uid IS NOT NULL AND NEW.issued_document_uid IS DISTINCT FROM OLD.issued_document_uid)
     OR (OLD.supersedes_invoice_uid IS NOT NULL AND NEW.supersedes_invoice_uid IS DISTINCT FROM OLD.supersedes_invoice_uid)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'invoice % was issued: change refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TABLE "xero_invoice_syncs";
DROP TABLE "xero_invoice_links";
DROP FUNCTION field_refuse_xero_invoice_link_change();
ALTER TABLE "xero_connections" DROP CONSTRAINT "xero_connections_codes_problem_check";
ALTER TABLE "xero_connections" DROP COLUMN "codes_problem";
ALTER TABLE "xero_connections" DROP COLUMN "codes_checked_at";
DROP INDEX "invoices_org_xero_invoice_key";
ALTER TABLE "invoices" DROP COLUMN "xero_status";
ALTER TABLE "invoices" DROP COLUMN "xero_tenant_id";
ALTER TABLE "invoices" DROP COLUMN "xero_invoice_id";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791868356919;
