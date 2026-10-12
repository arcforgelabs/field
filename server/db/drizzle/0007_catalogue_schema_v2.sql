-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Catalogue schema v2, part one (#178 phase 1, docs/PRICING_ENGINE.md
-- "Catalogue"). Hand-written: drizzle-kit would drop and re-create a renamed
-- table, losing its rows.
--
-- 1. item_components becomes kit_components (kit_uid, component_uid). Rows,
--    ids, grants and row-level security carry over with the rename.
-- 2. The five measured-assembly tables, never written, are dropped.
-- 3. items.type: what an item is (material, labour, equipment, subcontract,
--    fee, kit). Every item with components is a kit; the rest stay unset
--    until the price book clean-up types them.
-- 4. items.notes: internal notes for estimators, never printed (description
--    is the customer-facing wording).
-- No price, quantity, name or category changes.
ALTER TABLE "item_components" RENAME TO "kit_components";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME COLUMN "parent_uid" TO "kit_uid";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME COLUMN "child_uid" TO "component_uid";
--> statement-breakpoint
ALTER INDEX "item_components_pkey" RENAME TO "kit_components_pkey";
--> statement-breakpoint
ALTER INDEX "item_components_parent_child_key" RENAME TO "kit_components_kit_component_key";
--> statement-breakpoint
ALTER INDEX "item_components_child_idx" RENAME TO "kit_components_component_idx";
--> statement-breakpoint
ALTER SEQUENCE "item_components_id_seq" RENAME TO "kit_components_id_seq";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME CONSTRAINT "item_components_parent_fk" TO "kit_components_kit_fk";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME CONSTRAINT "item_components_child_fk" TO "kit_components_component_fk";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME CONSTRAINT "item_components_org_uid_organizations_uid_fk" TO "kit_components_org_uid_organizations_uid_fk";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME CONSTRAINT "item_components_entry_unit_units_code_fk" TO "kit_components_entry_unit_units_code_fk";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME CONSTRAINT "item_components_application_mode_check" TO "kit_components_application_mode_check";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME CONSTRAINT "item_components_pricing_contribution_check" TO "kit_components_pricing_contribution_check";
--> statement-breakpoint
ALTER TABLE "kit_components" RENAME CONSTRAINT "item_components_not_self" TO "kit_components_not_self";
--> statement-breakpoint
ALTER POLICY "item_components_tenant_isolation" ON "kit_components" RENAME TO "kit_components_tenant_isolation";
--> statement-breakpoint
-- PostgreSQL 18 also names NOT NULL constraints (item_components_*_not_null);
-- older servers have none, so rename whatever is left by pattern.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"kit_components"'::regclass AND conname LIKE 'item\_components\_%'
  LOOP
    EXECUTE format('ALTER TABLE "kit_components" RENAME CONSTRAINT %I TO %I', c.conname,
      replace(replace(replace(c.conname, 'item_components_', 'kit_components_'), 'parent_uid', 'kit_uid'), 'child_uid', 'component_uid'));
  END LOOP;
END
$$;
--> statement-breakpoint
-- The assembly tables were schema only (server/catalog/README.md); refuse to
-- drop one that somehow holds rows rather than lose them.
DO $$
DECLARE
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['assembly_params', 'assembly_vars', 'assembly_components', 'assembly_tests', 'assembly_versions'] LOOP
    -- FORCE ROW LEVEL SECURITY would hide rows from the owner: count without it.
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
    EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION '% holds % row(s); it was expected to be empty', t, n;
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
DROP TABLE "assembly_components";
--> statement-breakpoint
DROP TABLE "assembly_params";
--> statement-breakpoint
DROP TABLE "assembly_tests";
--> statement-breakpoint
DROP TABLE "assembly_vars";
--> statement-breakpoint
DROP TABLE "assembly_versions";
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "type" text;
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "notes" text;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_type_check" CHECK ("items"."type" is null or "items"."type" in ('material','labour','equipment','subcontract','fee','kit'));
--> statement-breakpoint
-- Every item with components is a kit. One organisation at a time: items has
-- FORCE ROW LEVEL SECURITY, so the owner sees an organisation's rows only
-- with field.org_uid set. Writing a column other than code leaves the code
-- trigger alone.
DO $$
DECLARE
  org record;
BEGIN
  FOR org IN SELECT uid FROM organizations ORDER BY uid LOOP
    PERFORM set_config('field.org_uid', org.uid, true);
    UPDATE "items" SET "type" = 'kit'
      WHERE "org_uid" = org.uid
        AND "uid" IN (SELECT "kit_uid" FROM "kit_components" WHERE "org_uid" = org.uid);
  END LOOP;
  PERFORM set_config('field.org_uid', '', true);
END
$$;
