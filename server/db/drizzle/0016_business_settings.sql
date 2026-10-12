-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Business settings (#28, pricing engine phase 3 step 4b): one row per
-- organisation, none meaning every default. Its first setting is whether an
-- invoice returned to draft and issued again with different content is
-- credited with a credit note first: `when-emailed` (default: only when Field
-- has evidence it was sent to the customer), `always` or `never`. Additive.
-- Then FORCE ROW LEVEL SECURITY and field_app's grants, which drizzle-kit
-- does not emit.
CREATE TABLE "business_settings" (
	"org_uid" text PRIMARY KEY DEFAULT field_org_uid() NOT NULL,
	"credit_note_on_reissue" text DEFAULT 'when-emailed' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "business_settings_credit_note_on_reissue_check" CHECK ("business_settings"."credit_note_on_reissue" in ('when-emailed','always','never'))
);
--> statement-breakpoint
ALTER TABLE "business_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "business_settings_tenant_isolation" ON "business_settings" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "business_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "business_settings" TO field_app;
  END IF;
END
$$;
