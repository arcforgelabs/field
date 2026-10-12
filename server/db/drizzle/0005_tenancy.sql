-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Tenancy foundation (#178 phase 0b, docs/PRICING_ENGINE.md "Tenancy").
-- Hand-ordered from drizzle-kit's output so it applies to a populated
-- database: existing rows are backfilled into Embark Earthworks before any
-- constraint that needs org_uid, and RLS is switched on last.

-- The transaction's organisation (SET LOCAL field.org_uid, server/db-runtime/
-- tenancy.js). Raises instead of returning nothing, so a query on a tenant
-- table that forgot its organisation fails loudly. Also the org_uid default.
CREATE FUNCTION field_org_uid() RETURNS text
LANGUAGE plpgsql STABLE PARALLEL SAFE
AS $$
DECLARE
  org text := current_setting('field.org_uid', true);
BEGIN
  IF org IS NULL OR org = '' THEN
    RAISE EXCEPTION 'field.org_uid is not set: tenant tables are only reachable inside an organisation''s transaction'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN org;
END
$$;
--> statement-breakpoint
CREATE TABLE "organizations" (
	"uid" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"clerk_org_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_clerk_org_id_unique" UNIQUE("clerk_org_id"),
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'archived')),
	CONSTRAINT "organizations_slug_check" CHECK ("organizations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");
--> statement-breakpoint
INSERT INTO "organizations" ("uid", "name", "slug") VALUES ('org_01M4NF6NV3HW3CCZB7NVB9B157', 'Embark Earthworks', 'embark');
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"user_uid" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memberships_org_uid_user_uid_pk" PRIMARY KEY("org_uid","user_uid"),
	CONSTRAINT "org_memberships_role_check" CHECK ("org_memberships"."role" in ('owner', 'staff')),
	CONSTRAINT "org_memberships_status_check" CHECK ("org_memberships"."status" in ('active', 'pending', 'disabled'))
);
--> statement-breakpoint
INSERT INTO "org_memberships" ("org_uid", "user_uid", "role", "status", "created_at", "updated_at")
SELECT 'org_01M4NF6NV3HW3CCZB7NVB9B157', "id", "role", "status", "created_at", "updated_at" FROM "users";
--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_uid_users_id_fk" FOREIGN KEY ("user_uid") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "org_memberships_user_idx" ON "org_memberships" USING btree ("user_uid");
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_status_check";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "status";
--> statement-breakpoint
ALTER TABLE "quote_snapshots" DROP CONSTRAINT "quote_snapshots_attempt_id_unique";
--> statement-breakpoint
ALTER TABLE "assembly_components" DROP CONSTRAINT "assembly_components_assembly_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "assembly_components" DROP CONSTRAINT "assembly_components_component_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "assembly_params" DROP CONSTRAINT "assembly_params_assembly_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "assembly_tests" DROP CONSTRAINT "assembly_tests_assembly_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "assembly_vars" DROP CONSTRAINT "assembly_vars_assembly_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "assembly_versions" DROP CONSTRAINT "assembly_versions_assembly_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "catalog_evidence" DROP CONSTRAINT "catalog_evidence_item_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "categories" DROP CONSTRAINT "categories_parent_id_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "item_components" DROP CONSTRAINT "item_components_parent_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "item_components" DROP CONSTRAINT "item_components_child_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "item_prices" DROP CONSTRAINT "item_prices_item_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "item_prices" DROP CONSTRAINT "item_prices_supplier_id_suppliers_id_fk";
--> statement-breakpoint
ALTER TABLE "item_suppliers" DROP CONSTRAINT "item_suppliers_item_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "item_suppliers" DROP CONSTRAINT "item_suppliers_supplier_id_suppliers_id_fk";
--> statement-breakpoint
ALTER TABLE "item_unit_conversions" DROP CONSTRAINT "item_unit_conversions_item_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_tax_code_tax_codes_code_fk";
--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_variant_of_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "price_import_rows" DROP CONSTRAINT "price_import_rows_import_id_price_imports_id_fk";
--> statement-breakpoint
ALTER TABLE "price_import_rows" DROP CONSTRAINT "price_import_rows_item_uid_items_uid_fk";
--> statement-breakpoint
ALTER TABLE "price_imports" DROP CONSTRAINT "price_imports_supplier_id_suppliers_id_fk";
--> statement-breakpoint
DROP INDEX "categories_name_lower_key";
--> statement-breakpoint
DROP INDEX "items_code_lower_key";
--> statement-breakpoint
ALTER TABLE "catalog_meta" DROP CONSTRAINT "catalog_meta_pkey";
--> statement-breakpoint
ALTER TABLE "tax_codes" DROP CONSTRAINT "tax_codes_pkey";
--> statement-breakpoint
ALTER TABLE "tax_codes" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tax_codes" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "items" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "item_unit_conversions" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_unit_conversions" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "item_prices" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_prices" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "price_imports" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_imports" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "price_import_rows" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "price_import_rows" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "item_components" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "item_components" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "assembly_params" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "assembly_params" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "assembly_vars" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "assembly_vars" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "assembly_components" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "assembly_components" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "assembly_tests" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "assembly_tests" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "assembly_versions" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "assembly_versions" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "catalog_history" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_history" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "catalog_evidence" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_evidence" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "catalog_meta" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_meta" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "quote_snapshots" ADD COLUMN "org_uid" text DEFAULT 'org_01M4NF6NV3HW3CCZB7NVB9B157' NOT NULL;
--> statement-breakpoint
ALTER TABLE "quote_snapshots" ALTER COLUMN "org_uid" SET DEFAULT field_org_uid();
--> statement-breakpoint
ALTER TABLE "catalog_meta" ADD CONSTRAINT "catalog_meta_org_uid_id_pk" PRIMARY KEY("org_uid","id");
--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_org_uid_code_pk" PRIMARY KEY("org_uid","code");
--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_name_lower_key" ON "categories" USING btree ("org_uid",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "categories_org_id_key" ON "categories" USING btree ("org_uid","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_code_lower_key" ON "items" USING btree ("org_uid",lower("code"));
--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_uid_key" ON "items" USING btree ("org_uid","uid");
--> statement-breakpoint
CREATE UNIQUE INDEX "price_imports_org_id_key" ON "price_imports" USING btree ("org_uid","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quote_snapshots_org_attempt_key" ON "quote_snapshots" USING btree ("org_uid","attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_id_key" ON "suppliers" USING btree ("org_uid","id");
--> statement-breakpoint
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_assembly_fk" FOREIGN KEY ("org_uid","assembly_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_components" ADD CONSTRAINT "assembly_components_component_fk" FOREIGN KEY ("org_uid","component_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_params" ADD CONSTRAINT "assembly_params_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_params" ADD CONSTRAINT "assembly_params_assembly_fk" FOREIGN KEY ("org_uid","assembly_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_tests" ADD CONSTRAINT "assembly_tests_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_tests" ADD CONSTRAINT "assembly_tests_assembly_fk" FOREIGN KEY ("org_uid","assembly_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_vars" ADD CONSTRAINT "assembly_vars_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_vars" ADD CONSTRAINT "assembly_vars_assembly_fk" FOREIGN KEY ("org_uid","assembly_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_versions" ADD CONSTRAINT "assembly_versions_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assembly_versions" ADD CONSTRAINT "assembly_versions_assembly_fk" FOREIGN KEY ("org_uid","assembly_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_evidence" ADD CONSTRAINT "catalog_evidence_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_evidence" ADD CONSTRAINT "catalog_evidence_item_fk" FOREIGN KEY ("org_uid","item_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_history" ADD CONSTRAINT "catalog_history_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "catalog_meta" ADD CONSTRAINT "catalog_meta_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("org_uid","parent_id") REFERENCES "public"."categories"("org_uid","id") ON DELETE SET NULL ("parent_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_components" ADD CONSTRAINT "item_components_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_components" ADD CONSTRAINT "item_components_parent_fk" FOREIGN KEY ("org_uid","parent_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_components" ADD CONSTRAINT "item_components_child_fk" FOREIGN KEY ("org_uid","child_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_item_fk" FOREIGN KEY ("org_uid","item_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_prices" ADD CONSTRAINT "item_prices_supplier_fk" FOREIGN KEY ("org_uid","supplier_id") REFERENCES "public"."suppliers"("org_uid","id") ON DELETE SET NULL ("supplier_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_item_fk" FOREIGN KEY ("org_uid","item_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ADD CONSTRAINT "item_suppliers_supplier_fk" FOREIGN KEY ("org_uid","supplier_id") REFERENCES "public"."suppliers"("org_uid","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_unit_conversions" ADD CONSTRAINT "item_unit_conversions_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item_unit_conversions" ADD CONSTRAINT "item_unit_conversions_item_fk" FOREIGN KEY ("org_uid","item_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_tax_code_fk" FOREIGN KEY ("org_uid","tax_code") REFERENCES "public"."tax_codes"("org_uid","code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_variant_of_fk" FOREIGN KEY ("org_uid","variant_of_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE SET NULL ("variant_of_uid") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_import_rows" ADD CONSTRAINT "price_import_rows_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_import_rows" ADD CONSTRAINT "price_import_rows_import_fk" FOREIGN KEY ("org_uid","import_id") REFERENCES "public"."price_imports"("org_uid","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_import_rows" ADD CONSTRAINT "price_import_rows_item_fk" FOREIGN KEY ("org_uid","item_uid") REFERENCES "public"."items"("org_uid","uid") ON DELETE SET NULL ("item_uid") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_imports" ADD CONSTRAINT "price_imports_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_imports" ADD CONSTRAINT "price_imports_supplier_fk" FOREIGN KEY ("org_uid","supplier_id") REFERENCES "public"."suppliers"("org_uid","id") ON DELETE SET NULL ("supplier_id") ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_snapshots" ADD CONSTRAINT "quote_snapshots_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Row-level security on every tenant table. FORCE applies it to the table
-- owner too: on Replit the app connects as the role that owns the tables.;
--> statement-breakpoint
ALTER TABLE "tax_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tax_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_unit_conversions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_unit_conversions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_suppliers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_suppliers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_prices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_prices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_imports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_import_rows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_import_rows" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_components" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "item_components" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_params" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_params" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_vars" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_vars" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_components" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_components" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_tests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_tests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_versions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "assembly_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_history" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_meta" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "catalog_meta" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quote_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "quote_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "org_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "assembly_components_tenant_isolation" ON "assembly_components" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "assembly_params_tenant_isolation" ON "assembly_params" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "assembly_tests_tenant_isolation" ON "assembly_tests" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "assembly_vars_tenant_isolation" ON "assembly_vars" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "assembly_versions_tenant_isolation" ON "assembly_versions" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "catalog_evidence_tenant_isolation" ON "catalog_evidence" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "catalog_history_tenant_isolation" ON "catalog_history" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "catalog_meta_tenant_isolation" ON "catalog_meta" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "categories_tenant_isolation" ON "categories" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "item_components_tenant_isolation" ON "item_components" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "item_prices_tenant_isolation" ON "item_prices" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "item_suppliers_tenant_isolation" ON "item_suppliers" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "item_unit_conversions_tenant_isolation" ON "item_unit_conversions" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "items_tenant_isolation" ON "items" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "price_import_rows_tenant_isolation" ON "price_import_rows" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "price_imports_tenant_isolation" ON "price_imports" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "quote_snapshots_tenant_isolation" ON "quote_snapshots" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "suppliers_tenant_isolation" ON "suppliers" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "tax_codes_tenant_isolation" ON "tax_codes" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE POLICY "org_memberships_tenant_isolation" ON "org_memberships" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
-- field_app: the role every organisation transaction runs as (SET LOCAL ROLE),
-- so RLS holds even when the login role is a superuser or has BYPASSRLS. It
-- can read and write rows, never change the schema. Created only when the
-- migrating role may create roles; otherwise the runtime relies on FORCE ROW
-- LEVEL SECURITY and refuses to start if its login role bypasses RLS.
-- Privileges are explicit: a later migration that adds a table grants
-- field_app what it needs there (no default privileges).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    BEGIN
      CREATE ROLE field_app NOLOGIN NOINHERIT NOBYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'field_app not created (no CREATEROLE); relying on FORCE ROW LEVEL SECURITY';
      RETURN;
    END;
  ELSE
    -- Roles are cluster-wide: an existing field_app must not bypass RLS.
    BEGIN
      ALTER ROLE field_app NOSUPERUSER NOBYPASSRLS NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'could not alter the existing field_app; the runtime checks its attributes';
    END;
  END IF;
  BEGIN
    EXECUTE format('GRANT field_app TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'could not grant field_app to %; relying on FORCE ROW LEVEL SECURITY', current_user;
  END;
  GRANT USAGE ON SCHEMA public TO field_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    "organizations", "org_memberships", "tax_codes", "categories", "suppliers", "items",
    "item_unit_conversions", "item_suppliers", "item_prices", "price_imports", "price_import_rows",
    "item_components", "assembly_params", "assembly_vars", "assembly_components", "assembly_tests",
    "assembly_versions", "catalog_history", "catalog_evidence", "catalog_meta", "quote_snapshots"
    TO field_app;
  -- The organisation directory and shared reference data are read-only to it.
  REVOKE INSERT, UPDATE, DELETE ON "organizations" FROM field_app;
  GRANT SELECT ON "units", "unit_aliases" TO field_app;
  -- People: read, add, link to Clerk, rename and remove; email and id never change.
  GRANT SELECT, INSERT, DELETE ON "users" TO field_app;
  GRANT UPDATE ("name", "clerk_user_id", "updated_at") ON "users" TO field_app;
  -- nextval only: the sequences are shared by every organisation.
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO field_app;
END
$$;
