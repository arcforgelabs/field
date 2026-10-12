-- Reverses migration 0005_tenancy (#178 phase 0b) for an emergency rollback to
-- a release from before it. Run as the database owner, in ONE transaction,
-- after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0005_tenancy.down.sql
--
-- It refuses when a second organisation exists (their rows would be merged
-- into Embark's). Removed people have no membership and are deleted, as the
-- pre-0005 schema did. server/db-runtime/tenancy.test.js proves the result
-- matches a database that never had 0005.

SET LOCAL lock_timeout = '10s';

DO $$
BEGIN
  IF (SELECT count(*) FROM organizations) > 1 THEN
    RAISE EXCEPTION 'more than one organisation exists; 0005 cannot be rolled back without losing which rows are whose';
  END IF;
END
$$;

-- RLS off first: the owner is filtered by FORCE and nothing sets field.org_uid here.
ALTER TABLE "org_memberships" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "org_memberships" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "tax_codes" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "tax_codes" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "categories" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "categories" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "suppliers" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "suppliers" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "items" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "items" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "item_unit_conversions" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "item_unit_conversions" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "item_suppliers" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "item_suppliers" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "item_prices" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "item_prices" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "price_imports" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "price_imports" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "price_import_rows" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "price_import_rows" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "item_components" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "item_components" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "assembly_params" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "assembly_params" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "assembly_vars" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "assembly_vars" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "assembly_components" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "assembly_components" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "assembly_tests" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "assembly_tests" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "assembly_versions" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "assembly_versions" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "catalog_history" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "catalog_history" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "catalog_evidence" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "catalog_evidence" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "catalog_meta" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "catalog_meta" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "quote_snapshots" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "quote_snapshots" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'staff' NOT NULL;

ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;

DELETE FROM "users" u WHERE NOT EXISTS (SELECT 1 FROM "org_memberships" m WHERE m."user_uid" = u."id");

UPDATE "users" u SET "role" = m."role", "status" = m."status" FROM "org_memberships" m WHERE m."user_uid" = u."id";

ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('owner', 'staff'));

ALTER TABLE "users" ADD CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'pending', 'disabled'));

DROP TABLE "org_memberships";

-- Dropping org_uid also drops its policies, composite keys, per-organisation
-- uniques and foreign keys.;

ALTER TABLE "tax_codes" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "categories" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "suppliers" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "items" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "item_unit_conversions" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "item_suppliers" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "item_prices" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "price_imports" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "price_import_rows" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "item_components" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "assembly_params" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "assembly_vars" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "assembly_components" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "assembly_tests" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "assembly_versions" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "catalog_history" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "catalog_evidence" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "catalog_meta" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "quote_snapshots" DROP COLUMN "org_uid" CASCADE;

ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_pkey" PRIMARY KEY ("code");

ALTER TABLE "catalog_meta" ADD CONSTRAINT "catalog_meta_pkey" PRIMARY KEY ("id");

ALTER TABLE "quote_snapshots" ADD CONSTRAINT "quote_snapshots_attempt_id_unique" UNIQUE ("attempt_id");

ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_assembly_uid_items_uid_fk" FOREIGN KEY ("assembly_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_component_uid_items_uid_fk" FOREIGN KEY ("component_uid") REFERENCES "public"."items"("uid") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "assembly_params" ADD CONSTRAINT "assembly_params_assembly_uid_items_uid_fk" FOREIGN KEY ("assembly_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "assembly_tests" ADD CONSTRAINT "assembly_tests_assembly_uid_items_uid_fk" FOREIGN KEY ("assembly_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "assembly_vars" ADD CONSTRAINT "assembly_vars_assembly_uid_items_uid_fk" FOREIGN KEY ("assembly_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "assembly_versions" ADD CONSTRAINT "assembly_versions_assembly_uid_items_uid_fk" FOREIGN KEY ("assembly_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "catalog_evidence" ADD CONSTRAINT "catalog_evidence_item_uid_items_uid_fk" FOREIGN KEY ("item_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "categories_name_lower_key" ON "categories" USING btree (lower("name"));

ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "item_components" ADD CONSTRAINT "item_components_child_uid_items_uid_fk" FOREIGN KEY ("child_uid") REFERENCES "public"."items"("uid") ON DELETE restrict ON UPDATE no action;

ALTER TABLE "item_components" ADD CONSTRAINT "item_components_parent_uid_items_uid_fk" FOREIGN KEY ("parent_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_item_uid_items_uid_fk" FOREIGN KEY ("item_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "items_code_lower_key" ON "items" USING btree (lower("code"));

ALTER TABLE "items" ADD CONSTRAINT "items_tax_code_tax_codes_code_fk" FOREIGN KEY ("tax_code") REFERENCES "public"."tax_codes"("code") ON DELETE no action ON UPDATE no action;

ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_item_uid_items_uid_fk" FOREIGN KEY ("item_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "items" ADD CONSTRAINT "items_variant_of_uid_items_uid_fk" FOREIGN KEY ("variant_of_uid") REFERENCES "public"."items"("uid") ON DELETE set null ON UPDATE no action;

ALTER TABLE "item_unit_conversions" ADD CONSTRAINT "item_unit_conversions_item_uid_items_uid_fk" FOREIGN KEY ("item_uid") REFERENCES "public"."items"("uid") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "price_import_rows" ADD CONSTRAINT "price_import_rows_import_id_price_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."price_imports"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "price_import_rows" ADD CONSTRAINT "price_import_rows_item_uid_items_uid_fk" FOREIGN KEY ("item_uid") REFERENCES "public"."items"("uid") ON DELETE set null ON UPDATE no action;

ALTER TABLE "price_imports" ADD CONSTRAINT "price_imports_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;

DROP TABLE "organizations";

DROP FUNCTION field_org_uid();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM field_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM field_app;
    REVOKE ALL ON SCHEMA public FROM field_app;
    BEGIN
      DROP ROLE field_app;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'field_app kept (%): it has no privileges here', SQLERRM;
    END;
  END IF;
END
$$;

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791723567613;
