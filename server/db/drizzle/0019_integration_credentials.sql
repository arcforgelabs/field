-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Integration credentials entered in Settings (#112). Additive:
--   - `integration_credentials`: an integration's credentials (an app's
--     client id and client secret), per organisation, encrypted by
--     server/secrets under FIELD_SECRETS_KEY, with the key's id;
--   - `integration_audit_events`: who changed an integration and when,
--     append-only, never a value.
-- The Xero OAuth tokens stay in xero_connections, now in the same encrypted
-- format; boot re-encrypts tokens stored by 0017's release (server/xero/
-- connection.js upgradeStoredTokens). Then FORCE ROW LEVEL SECURITY, the
-- audit table's append-only trigger and field_app's grants, which drizzle-kit
-- does not emit.
CREATE TABLE "integration_audit_events" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"integration" text NOT NULL,
	"action" text NOT NULL,
	"actor" text,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "integration_audit_events_action_check" CHECK ("integration_audit_events"."action" in ('credentials_set','credentials_replaced','credentials_removed','connected','disconnected','tokens_rewrapped','tokens_unreadable'))
);
--> statement-breakpoint
ALTER TABLE "integration_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"integration" text NOT NULL,
	"field" text NOT NULL,
	"value_enc" text NOT NULL,
	"key_id" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"set_by" text,
	CONSTRAINT "integration_credentials_org_uid_integration_field_pk" PRIMARY KEY("org_uid","integration","field"),
	CONSTRAINT "integration_credentials_integration_check" CHECK ("integration_credentials"."integration" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "integration_credentials_field_check" CHECK ("integration_credentials"."field" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "integration_credentials_value_check" CHECK ("integration_credentials"."value_enc" like 'fs1.%')
);
--> statement-breakpoint
ALTER TABLE "integration_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_audit_events" ADD CONSTRAINT "integration_audit_events_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_audit_events_org_integration_idx" ON "integration_audit_events" USING btree ("org_uid","integration","at");--> statement-breakpoint
CREATE POLICY "integration_audit_events_tenant_isolation" ON "integration_audit_events" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "integration_credentials_tenant_isolation" ON "integration_credentials" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "integration_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION field_refuse_integration_audit_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'integration_audit_events is append-only' USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "integration_audit_events_append_only" BEFORE UPDATE OR DELETE ON "integration_audit_events" FOR EACH ROW EXECUTE FUNCTION field_refuse_integration_audit_change();
--> statement-breakpoint
CREATE TRIGGER "integration_audit_events_no_truncate" BEFORE TRUNCATE ON "integration_audit_events" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_integration_audit_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "integration_credentials" TO field_app;
    GRANT SELECT, INSERT ON "integration_audit_events" TO field_app;
  END IF;
END
$$;
