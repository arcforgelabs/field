-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Settings, Team, Access (#133): who revoked a command-line token or
-- disconnected a connected agent (MCP installation), and when. Additive and
-- append-only. It names the token or installation by id and name, and whose
-- it was; never a token value or hash. Then FORCE ROW LEVEL SECURITY, the
-- append-only trigger and field_app's grants, which drizzle-kit does not emit.
CREATE TABLE "access_audit_events" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"action" text NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"target_id" text NOT NULL,
	"target_name" text,
	"holder_id" text,
	"holder_name" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_audit_events_action_check" CHECK ("access_audit_events"."action" in ('token_revoked','mcp_installation_disconnected'))
);
--> statement-breakpoint
ALTER TABLE "access_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "access_audit_events" ADD CONSTRAINT "access_audit_events_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_audit_events_org_at_idx" ON "access_audit_events" USING btree ("org_uid","at");--> statement-breakpoint
CREATE POLICY "access_audit_events_tenant_isolation" ON "access_audit_events" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));

--> statement-breakpoint
ALTER TABLE "access_audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION field_refuse_access_audit_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'access_audit_events is append-only' USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "access_audit_events_append_only" BEFORE UPDATE OR DELETE ON "access_audit_events" FOR EACH ROW EXECUTE FUNCTION field_refuse_access_audit_change();
--> statement-breakpoint
CREATE TRIGGER "access_audit_events_no_truncate" BEFORE TRUNCATE ON "access_audit_events" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_access_audit_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT ON "access_audit_events" TO field_app;
  END IF;
END
$$;
