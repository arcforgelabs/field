-- Move every Field table, sequence, type and function out of public into
-- schema field. ALTER ... SET SCHEMA keeps rows, indexes, constraints,
-- foreign keys, RLS policies, FORCE ROW LEVEL SECURITY and grants. Owned
-- sequences move with their tables. Function bodies resolve names through
-- the caller's search_path, so each function is pinned to field, pg_catalog.
-- 0000-0024 stay as they are: on a fresh database they still create objects
-- in public, and this migration moves them.
--
-- A transaction-mode pooler drops search_path from the startup packet and
-- does not keep a session SET, so the role and the database carry the
-- default. Sessions the pooler opened before the move still search public;
-- their idle backends are closed so the pooler opens new ones.
--
-- drizzle-kit sees the schema change as new tables. This file is hand-written
-- so an existing install is moved, not emptied and recreated.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "field";
--> statement-breakpoint
ALTER TABLE "public"."access_audit_events" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."business_settings" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."catalog_evidence" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."catalog_history" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."catalog_meta" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."categories" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."credit_note_lines" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."credit_notes" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."data_migrations" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."document_blob_replicas" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."document_blobs" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."document_events" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."document_number_counters" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."drizzle_toolchain_probe" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."field_blobs" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."field_files" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."field_sqlite_images" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."integration_audit_events" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."integration_credentials" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."integration_setup" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."invoice_lines" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."invoices" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."issued_documents" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."item_code_aliases" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."item_prices" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."item_suppliers" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."item_unit_conversions" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."items" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."kit_components" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."milestone_rule_caps" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."milestone_rule_milestones" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."milestone_rules" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."org_memberships" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."organizations" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."payment_allocations" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."payment_milestones" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."payments" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."price_import_rows" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."price_imports" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."quote_lines" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."quote_sections" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."quote_snapshots" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."quotes" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."receipts" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."suppliers" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."tax_codes" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."unit_aliases" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."units" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."users" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."xero_connections" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."xero_invoice_links" SET SCHEMA "field";
--> statement-breakpoint
ALTER TABLE "public"."xero_invoice_syncs" SET SCHEMA "field";
--> statement-breakpoint
-- Owned sequences move with their table. These catch a sequence or type that
-- a field table still depends on and that stayed in public (extensions stay).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.relname
    FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    JOIN pg_namespace ns ON ns.oid = s.relnamespace AND ns.nspname = 'public'
    JOIN pg_class t ON t.oid = d.refobjid AND t.relkind = 'r'
    JOIN pg_namespace nt ON nt.oid = t.relnamespace AND nt.nspname = 'field'
    WHERE d.deptype IN ('a', 'i')
      AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = s.oid AND e.deptype = 'e')
  LOOP
    EXECUTE format('ALTER SEQUENCE public.%I SET SCHEMA field', r.relname);
  END LOOP;
  FOR r IN
    SELECT DISTINCT ty.typname
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
    JOIN pg_namespace cn ON cn.oid = c.relnamespace AND cn.nspname = 'field'
    JOIN pg_type ty ON ty.oid = a.atttypid AND ty.typtype IN ('e', 'c', 'd')
    JOIN pg_namespace tn ON tn.oid = ty.typnamespace AND tn.nspname = 'public'
    WHERE NOT a.attisdropped
      AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.objid = ty.oid AND e.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE public.%I SET SCHEMA field', r.typname);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER FUNCTION public.field_org_uid() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_item_code_alias() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_document_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_quote_is_frozen(text, timestamp with time zone) SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_sent_quote_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_sent_quote_content_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_replica_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_issued_invoice_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_issued_credit_note_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_issued_invoice_line_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_issued_credit_note_line_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_payment_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_receipt_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_payment_allocation_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_xero_invoice_link_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_integration_audit_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION public.field_refuse_access_audit_change() SET SCHEMA field;
--> statement-breakpoint
ALTER FUNCTION field.field_org_uid() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_item_code_alias() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_document_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_quote_is_frozen(text, timestamp with time zone) SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_sent_quote_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_sent_quote_content_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_replica_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_issued_invoice_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_issued_credit_note_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_issued_invoice_line_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_issued_credit_note_line_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_payment_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_receipt_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_payment_allocation_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_xero_invoice_link_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_integration_audit_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
ALTER FUNCTION field.field_refuse_access_audit_change() SET search_path = field, pg_catalog;
--> statement-breakpoint
-- field_app can see the schema and take sequence values. The role is
-- absent when the migrating role has no CREATEROLE (see 0005_tenancy).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT USAGE ON SCHEMA field TO field_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA field TO field_app;
    REVOKE USAGE ON SCHEMA public FROM field_app;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'field\_%' ESCAPE '\'
  ) OR EXISTS (
    SELECT 1
    FROM pg_depend d
    JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    JOIN pg_namespace ns ON ns.oid = s.relnamespace AND ns.nspname <> 'field'
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace nt ON nt.oid = t.relnamespace AND nt.nspname = 'field'
    WHERE d.deptype IN ('a', 'i')
  ) THEN
    RAISE EXCEPTION '0025 left a Field function or owned sequence outside schema field';
  END IF;
END
$$;
--> statement-breakpoint
-- New sessions search field first, including ones a pooler opens. Each
-- change is skipped when this role cannot make it, so the move still commits.
DO $$
BEGIN
  BEGIN
    EXECUTE format('ALTER ROLE %I SET search_path = field, public', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'field: this role cannot set its own search_path; Field sets its own on each connection';
  END;
  BEGIN
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path = field, public', current_user, current_database());
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'field: this role cannot set its search_path for this database; Field sets its own on each connection';
  END;
  IF EXISTS (
    SELECT 1 FROM pg_database d
    JOIN pg_roles r ON r.oid = d.datdba
    WHERE d.datname = current_database() AND r.rolname = current_user
  ) THEN
    BEGIN
      EXECUTE format('ALTER DATABASE %I SET search_path = field, public', current_database());
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'field: not the database owner, so its default search_path stays; Field sets its own on each connection';
    END;
  END IF;
  -- Idle client backends of this role, not this migration and not a
  -- background worker. A pooler keeps those and would hand them out still
  -- searching public. A missing privilege must not fail the move.
  BEGIN
    PERFORM pg_terminate_backend(a.pid)
    FROM pg_stat_activity a
    WHERE a.usename = current_user
      AND a.datname = current_database()
      AND a.pid <> pg_backend_pid()
      AND a.state = 'idle'
      AND a.backend_type = 'client backend';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'field: could not close idle sessions; a pooler''s open sessions keep the old search_path until they close';
  END;
END
$$;
