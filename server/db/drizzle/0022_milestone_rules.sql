-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Milestone rules (#29, pricing engine phase 3 step 4c; docs/PRICING_ENGINE.md
-- "Invoices and payments"): the organisation's default milestones and caps,
-- by contract value band and region, as rows. A rule set applies to a job's
-- schedule when its milestones are first created, and its caps to every
-- invoice the job issues from then on (a hard cap refuses the issue, a soft
-- cap alerts). business_settings gains the business's country and region,
-- for jobs whose site address does not say where they are. Additive: no
-- rules means Field's default schedule and no caps, as before.
--
-- Hand-ordered from drizzle-kit's output (each table and its unique key
-- before the keys that point at it), then FORCE ROW LEVEL SECURITY and
-- field_app's grants, which drizzle-kit does not emit. Rules are settings,
-- not issued documents: an owner replaces them, so field_app may delete.
CREATE TABLE "milestone_rules" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"region" text,
	"min_value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"max_value" numeric(12, 2),
	"value_basis" text DEFAULT 'inc-gst' NOT NULL,
	"note" text,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "milestone_rules_uid_check" CHECK ("milestone_rules"."uid" ~ '^mrl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "milestone_rules_name_check" CHECK (length(btrim("milestone_rules"."name")) > 0),
	CONSTRAINT "milestone_rules_country_check" CHECK ("milestone_rules"."country" is null or "milestone_rules"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "milestone_rules_region_check" CHECK ("milestone_rules"."region" is null or ("milestone_rules"."country" is not null and "milestone_rules"."region" ~ '^[A-Z0-9]{1,3}$')),
	CONSTRAINT "milestone_rules_band_check" CHECK ("milestone_rules"."min_value" >= 0 and ("milestone_rules"."max_value" is null or "milestone_rules"."max_value" > "milestone_rules"."min_value")),
	CONSTRAINT "milestone_rules_value_basis_check" CHECK ("milestone_rules"."value_basis" in ('inc-gst','ex-gst')),
	CONSTRAINT "milestone_rules_sort_order_check" CHECK ("milestone_rules"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "milestone_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "milestone_rules" ADD CONSTRAINT "milestone_rules_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_rules_org_uid_key" ON "milestone_rules" USING btree ("org_uid","uid");
--> statement-breakpoint
CREATE POLICY "milestone_rules_tenant_isolation" ON "milestone_rules" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE TABLE "milestone_rule_milestones" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"rule_uid" text NOT NULL,
	"sort_order" integer NOT NULL,
	"label" text NOT NULL,
	"percent" numeric(7, 3),
	"amount" numeric(12, 2),
	"due_days" integer,
	CONSTRAINT "milestone_rule_milestones_uid_check" CHECK ("milestone_rule_milestones"."uid" ~ '^mrm_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "milestone_rule_milestones_label_check" CHECK (length(btrim("milestone_rule_milestones"."label")) > 0),
	CONSTRAINT "milestone_rule_milestones_share_check" CHECK (("milestone_rule_milestones"."percent" is not null and "milestone_rule_milestones"."percent" > 0 and "milestone_rule_milestones"."percent" <= 100) or ("milestone_rule_milestones"."amount" is not null and "milestone_rule_milestones"."amount" > 0)),
	CONSTRAINT "milestone_rule_milestones_sort_order_check" CHECK ("milestone_rule_milestones"."sort_order" >= 0),
	CONSTRAINT "milestone_rule_milestones_due_days_check" CHECK ("milestone_rule_milestones"."due_days" is null or "milestone_rule_milestones"."due_days" > 0)
);
--> statement-breakpoint
ALTER TABLE "milestone_rule_milestones" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "milestone_rule_milestones" ADD CONSTRAINT "milestone_rule_milestones_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "milestone_rule_milestones" ADD CONSTRAINT "milestone_rule_milestones_rule_fk" FOREIGN KEY ("org_uid","rule_uid") REFERENCES "public"."milestone_rules"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_rule_milestones_rule_sort_key" ON "milestone_rule_milestones" USING btree ("org_uid","rule_uid","sort_order");
--> statement-breakpoint
CREATE POLICY "milestone_rule_milestones_tenant_isolation" ON "milestone_rule_milestones" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
CREATE TABLE "milestone_rule_caps" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"rule_uid" text NOT NULL,
	"kind" text NOT NULL,
	"max_percent" numeric(7, 3),
	"max_amount" numeric(12, 2),
	"mode" text NOT NULL,
	CONSTRAINT "milestone_rule_caps_uid_check" CHECK ("milestone_rule_caps"."uid" ~ '^mrc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "milestone_rule_caps_kind_check" CHECK ("milestone_rule_caps"."kind" in ('deposit','progress','final','variation')),
	CONSTRAINT "milestone_rule_caps_mode_check" CHECK ("milestone_rule_caps"."mode" in ('hard','soft')),
	CONSTRAINT "milestone_rule_caps_limit_check" CHECK (("milestone_rule_caps"."max_percent" is not null and "milestone_rule_caps"."max_percent" > 0 and "milestone_rule_caps"."max_percent" <= 100) or ("milestone_rule_caps"."max_amount" is not null and "milestone_rule_caps"."max_amount" > 0))
);
--> statement-breakpoint
ALTER TABLE "milestone_rule_caps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "milestone_rule_caps" ADD CONSTRAINT "milestone_rule_caps_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "milestone_rule_caps" ADD CONSTRAINT "milestone_rule_caps_rule_fk" FOREIGN KEY ("org_uid","rule_uid") REFERENCES "public"."milestone_rules"("org_uid","uid") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "milestone_rule_caps_rule_kind_key" ON "milestone_rule_caps" USING btree ("org_uid","rule_uid","kind");
--> statement-breakpoint
CREATE POLICY "milestone_rule_caps_tenant_isolation" ON "milestone_rule_caps" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "business_settings" ADD COLUMN "country" text;
--> statement-breakpoint
ALTER TABLE "business_settings" ADD COLUMN "region" text;
--> statement-breakpoint
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_country_check" CHECK ("business_settings"."country" is null or "business_settings"."country" ~ '^[A-Z]{2}$');
--> statement-breakpoint
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_region_check" CHECK ("business_settings"."region" is null or ("business_settings"."country" is not null and "business_settings"."region" ~ '^[A-Z0-9]{1,3}$'));
--> statement-breakpoint
ALTER TABLE "milestone_rules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "milestone_rule_milestones" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "milestone_rule_caps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "milestone_rules", "milestone_rule_milestones", "milestone_rule_caps" TO field_app;
  END IF;
END
$$;
