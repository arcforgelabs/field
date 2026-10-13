-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- The Connect wizard (Settings, Integrations, Xero). Additive:
--   - `integration_setup`: the step an owner reached, per organisation and
--     integration, and pending credentials: `fs1` values the browser
--     encrypted with a FIELD_SECRETS_KEY it generated and the server does not
--     have yet, with that key's id. Never the key, never a plain value.
--     server/secrets/setup.js moves them into integration_credentials once
--     the deployment has the key.
--   - integration_audit_events may record the wizard's steps: setup_step,
--     secrets_key_generated, pending_credentials_stored, _promoted and
--     _discarded. Still never a value.
-- Then FORCE ROW LEVEL SECURITY and field_app's grants, which drizzle-kit
-- does not emit.
CREATE TABLE "integration_setup" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"integration" text NOT NULL,
	"step" text NOT NULL,
	"pending_values" jsonb,
	"pending_key_id" text,
	"pending_at" timestamp with time zone,
	"pending_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "integration_setup_org_uid_integration_pk" PRIMARY KEY("org_uid","integration"),
	CONSTRAINT "integration_setup_integration_check" CHECK ("integration_setup"."integration" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "integration_setup_step_check" CHECK ("integration_setup"."step" in ('app','credentials','key','connect')),
	CONSTRAINT "integration_setup_key_id_check" CHECK ("integration_setup"."pending_key_id" is null or "integration_setup"."pending_key_id" ~ '^[0-9a-f]{12}$'),
	CONSTRAINT "integration_setup_pending_check" CHECK (("integration_setup"."pending_values" is null) = ("integration_setup"."pending_key_id" is null))
);
--> statement-breakpoint
ALTER TABLE "integration_setup" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_audit_events" DROP CONSTRAINT "integration_audit_events_action_check";--> statement-breakpoint
ALTER TABLE "integration_setup" ADD CONSTRAINT "integration_setup_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_action_check" CHECK ("integration_audit_events"."action" in ('credentials_set','credentials_replaced','credentials_removed','connected','disconnected','tokens_rewrapped','tokens_unreadable','setup_step','secrets_key_generated','pending_credentials_stored','pending_credentials_promoted','pending_credentials_discarded'));--> statement-breakpoint
CREATE POLICY "integration_setup_tenant_isolation" ON "integration_setup" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "integration_setup" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_setup" TO field_app;
  END IF;
END
$$;
