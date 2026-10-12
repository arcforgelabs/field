-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- The R2 replica of issued document bytes (#240; docs/REPLIT.md "Issued
-- documents in R2"). PostgreSQL stays the store of record; after an issue
-- transaction commits, server/documents/replicator.js copies the blob to a
-- locked R2 bucket and records it here. A blob with no row, or a row with no
-- r2_replicated_at, is pending. Additive: nothing existing is changed, and
-- with FIELD_DOCUMENT_REPLICA unset nothing writes this table.
--
-- It does not depend on 0010 or 0011 (quote rows); it follows them because
-- Drizzle only applies a migration whose journal timestamp is later than the
-- last one applied.
-- Then FORCE ROW LEVEL SECURITY, the trigger that keeps a replicated row as it
-- is, and field_app's grants, which drizzle-kit does not emit.
CREATE TABLE "document_blob_replicas" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"sha256" text NOT NULL,
	"r2_replicated_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_blob_replicas_org_uid_sha256_pk" PRIMARY KEY("org_uid","sha256"),
	CONSTRAINT "document_blob_replicas_attempts_check" CHECK ("document_blob_replicas"."attempts" >= 0),
	CONSTRAINT "document_blob_replicas_last_error_check" CHECK ("document_blob_replicas"."last_error" is null or "document_blob_replicas"."last_error" ~ '^[A-Z0-9_]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "document_blob_replicas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_blob_replicas" ADD CONSTRAINT "document_blob_replicas_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_blob_replicas" ADD CONSTRAINT "document_blob_replicas_blob_fk" FOREIGN KEY ("org_uid","sha256") REFERENCES "public"."document_blobs"("org_uid","sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_blob_replicas_pending_idx" ON "document_blob_replicas" USING btree ("org_uid","next_attempt_at") WHERE "document_blob_replicas"."r2_replicated_at" is null;--> statement-breakpoint
CREATE POLICY "document_blob_replicas_tenant_isolation" ON "document_blob_replicas" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "document_blob_replicas" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Once a blob is recorded as replicated, that record stands: a replicated row
-- refuses UPDATE, and no row is ever deleted or truncated. A pending row may
-- be updated (attempts, backoff, the last error, and finally r2_replicated_at).
CREATE FUNCTION field_refuse_replica_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.r2_replicated_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'document_blob_replicas: % refused%', lower(TG_OP),
    CASE WHEN TG_OP = 'UPDATE' THEN ' (already replicated)' ELSE '' END
    USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "document_blob_replicas_settled" BEFORE UPDATE OR DELETE ON "document_blob_replicas" FOR EACH ROW EXECUTE FUNCTION field_refuse_replica_change();
--> statement-breakpoint
CREATE TRIGGER "document_blob_replicas_no_truncate" BEFORE TRUNCATE ON "document_blob_replicas" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_replica_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "document_blob_replicas" TO field_app;
  END IF;
END
$$;
