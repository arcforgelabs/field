-- Reverses migration 0025_field_schema. Run it before 0024's, if that is
-- rolled back too. Run as the database owner, in ONE transaction, after
-- stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0025_field_schema.down.sql
--
-- Moves every Field object back to public and drops schema field. Rows stay.

SET LOCAL lock_timeout = '10s';

-- 0025 pins search_path on this role and, when it owns the database, on the
-- database. Put those back. A missing privilege must not stop the rollback.
DO $$
BEGIN
  BEGIN
    EXECUTE format('ALTER ROLE %I RESET search_path', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'field: could not reset this role''s search_path';
  END;
  BEGIN
    EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET search_path', current_user, current_database());
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'field: could not reset this role''s search_path for this database';
  END;
  IF EXISTS (
    SELECT 1 FROM pg_database d
    JOIN pg_roles r ON r.oid = d.datdba
    WHERE d.datname = current_database() AND r.rolname = current_user
  ) THEN
    BEGIN
      EXECUTE format('ALTER DATABASE %I RESET search_path', current_database());
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'field: could not reset the database search_path';
    END;
  END IF;
END
$$;
ALTER FUNCTION field.field_org_uid() RESET search_path;
ALTER FUNCTION field.field_org_uid() SET SCHEMA public;
ALTER FUNCTION field.field_item_code_alias() RESET search_path;
ALTER FUNCTION field.field_item_code_alias() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_document_change() RESET search_path;
ALTER FUNCTION field.field_refuse_document_change() SET SCHEMA public;
ALTER FUNCTION field.field_quote_is_frozen(text, timestamp with time zone) RESET search_path;
ALTER FUNCTION field.field_quote_is_frozen(text, timestamp with time zone) SET SCHEMA public;
ALTER FUNCTION field.field_refuse_sent_quote_change() RESET search_path;
ALTER FUNCTION field.field_refuse_sent_quote_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_sent_quote_content_change() RESET search_path;
ALTER FUNCTION field.field_refuse_sent_quote_content_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_replica_change() RESET search_path;
ALTER FUNCTION field.field_refuse_replica_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_issued_invoice_change() RESET search_path;
ALTER FUNCTION field.field_refuse_issued_invoice_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_issued_credit_note_change() RESET search_path;
ALTER FUNCTION field.field_refuse_issued_credit_note_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_issued_invoice_line_change() RESET search_path;
ALTER FUNCTION field.field_refuse_issued_invoice_line_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_issued_credit_note_line_change() RESET search_path;
ALTER FUNCTION field.field_refuse_issued_credit_note_line_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_payment_change() RESET search_path;
ALTER FUNCTION field.field_refuse_payment_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_receipt_change() RESET search_path;
ALTER FUNCTION field.field_refuse_receipt_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_payment_allocation_change() RESET search_path;
ALTER FUNCTION field.field_refuse_payment_allocation_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_xero_invoice_link_change() RESET search_path;
ALTER FUNCTION field.field_refuse_xero_invoice_link_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_integration_audit_change() RESET search_path;
ALTER FUNCTION field.field_refuse_integration_audit_change() SET SCHEMA public;
ALTER FUNCTION field.field_refuse_access_audit_change() RESET search_path;
ALTER FUNCTION field.field_refuse_access_audit_change() SET SCHEMA public;
ALTER TABLE "field"."access_audit_events" SET SCHEMA "public";
ALTER TABLE "field"."business_settings" SET SCHEMA "public";
ALTER TABLE "field"."catalog_evidence" SET SCHEMA "public";
ALTER TABLE "field"."catalog_history" SET SCHEMA "public";
ALTER TABLE "field"."catalog_meta" SET SCHEMA "public";
ALTER TABLE "field"."categories" SET SCHEMA "public";
ALTER TABLE "field"."credit_note_lines" SET SCHEMA "public";
ALTER TABLE "field"."credit_notes" SET SCHEMA "public";
ALTER TABLE "field"."data_migrations" SET SCHEMA "public";
ALTER TABLE "field"."document_blob_replicas" SET SCHEMA "public";
ALTER TABLE "field"."document_blobs" SET SCHEMA "public";
ALTER TABLE "field"."document_events" SET SCHEMA "public";
ALTER TABLE "field"."document_number_counters" SET SCHEMA "public";
ALTER TABLE "field"."drizzle_toolchain_probe" SET SCHEMA "public";
ALTER TABLE "field"."field_blobs" SET SCHEMA "public";
ALTER TABLE "field"."field_files" SET SCHEMA "public";
ALTER TABLE "field"."field_sqlite_images" SET SCHEMA "public";
ALTER TABLE "field"."integration_audit_events" SET SCHEMA "public";
ALTER TABLE "field"."integration_credentials" SET SCHEMA "public";
ALTER TABLE "field"."integration_setup" SET SCHEMA "public";
ALTER TABLE "field"."invoice_lines" SET SCHEMA "public";
ALTER TABLE "field"."invoices" SET SCHEMA "public";
ALTER TABLE "field"."issued_documents" SET SCHEMA "public";
ALTER TABLE "field"."item_code_aliases" SET SCHEMA "public";
ALTER TABLE "field"."item_prices" SET SCHEMA "public";
ALTER TABLE "field"."item_suppliers" SET SCHEMA "public";
ALTER TABLE "field"."item_unit_conversions" SET SCHEMA "public";
ALTER TABLE "field"."items" SET SCHEMA "public";
ALTER TABLE "field"."kit_components" SET SCHEMA "public";
ALTER TABLE "field"."milestone_rule_caps" SET SCHEMA "public";
ALTER TABLE "field"."milestone_rule_milestones" SET SCHEMA "public";
ALTER TABLE "field"."milestone_rules" SET SCHEMA "public";
ALTER TABLE "field"."org_memberships" SET SCHEMA "public";
ALTER TABLE "field"."organizations" SET SCHEMA "public";
ALTER TABLE "field"."payment_allocations" SET SCHEMA "public";
ALTER TABLE "field"."payment_milestones" SET SCHEMA "public";
ALTER TABLE "field"."payments" SET SCHEMA "public";
ALTER TABLE "field"."price_import_rows" SET SCHEMA "public";
ALTER TABLE "field"."price_imports" SET SCHEMA "public";
ALTER TABLE "field"."quote_lines" SET SCHEMA "public";
ALTER TABLE "field"."quote_sections" SET SCHEMA "public";
ALTER TABLE "field"."quote_snapshots" SET SCHEMA "public";
ALTER TABLE "field"."quotes" SET SCHEMA "public";
ALTER TABLE "field"."receipts" SET SCHEMA "public";
ALTER TABLE "field"."suppliers" SET SCHEMA "public";
ALTER TABLE "field"."tax_codes" SET SCHEMA "public";
ALTER TABLE "field"."unit_aliases" SET SCHEMA "public";
ALTER TABLE "field"."units" SET SCHEMA "public";
ALTER TABLE "field"."users" SET SCHEMA "public";
ALTER TABLE "field"."xero_connections" SET SCHEMA "public";
ALTER TABLE "field"."xero_invoice_links" SET SCHEMA "public";
ALTER TABLE "field"."xero_invoice_syncs" SET SCHEMA "public";

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'field' AND c.relkind = 'S'
  LOOP
    EXECUTE format('ALTER SEQUENCE field.%I SET SCHEMA public', r.relname);
  END LOOP;
  FOR r IN
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'field' AND t.typtype IN ('e', 'c', 'd')
  LOOP
    EXECUTE format('ALTER TYPE field.%I SET SCHEMA public', r.typname);
  END LOOP;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT USAGE ON SCHEMA public TO field_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO field_app;
    REVOKE ALL ON SCHEMA field FROM field_app;
  END IF;
END
$$;

DROP SCHEMA field;

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792668186243;
