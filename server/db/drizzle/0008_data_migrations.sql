-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- The ledger of data migrations (server/data-migrations/, #178 code
-- retirement): one row per migration that ran in an organisation, with what
-- it changed. A recorded migration never runs again.
CREATE TABLE "data_migrations" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"id" text NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "data_migrations_org_uid_id_pk" PRIMARY KEY("org_uid","id")
);
--> statement-breakpoint
ALTER TABLE "data_migrations" ADD CONSTRAINT "data_migrations_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_migrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_migrations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "data_migrations_tenant_isolation" ON "data_migrations" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
-- Requests may read the ledger and a boot step may add to it; a recorded
-- migration is never edited or removed by the app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT ON "data_migrations" TO field_app;
  END IF;
END
$$;
