-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Issued documents (#223, #178 step 2; docs/PRICING_ENGINE.md
-- "document_events and issued_documents"). Every PDF a customer was issued,
-- stored once by SHA-256 per organisation, addressable by its own uid, with an
-- append-only history. Additive: nothing existing is changed, and the job
-- files stay the source of truth until the PDF routes read from here.
-- Hand-ordered from drizzle-kit's output (unique keys before the foreign keys
-- that need them), then FORCE ROW LEVEL SECURITY, the immutability triggers
-- and field_app's grants, which drizzle-kit does not emit.
--
-- Numbered 0009 because the open catalogue stack (#215 to #221) adds 0006 to
-- 0008; it does not depend on them and must merge after them, so its journal
-- timestamp sorts after 0008's.
CREATE TABLE "document_blobs" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"sha256" text NOT NULL,
	"byte_length" bigint NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_blobs_org_uid_sha256_pk" PRIMARY KEY("org_uid","sha256"),
	CONSTRAINT "document_blobs_sha256_check" CHECK ("document_blobs"."sha256" ~ '^[0-9a-f]{64}$' and "document_blobs"."sha256" = encode(sha256("document_blobs"."bytes"), 'hex')),
	CONSTRAINT "document_blobs_byte_length_check" CHECK ("document_blobs"."byte_length" = octet_length("document_blobs"."bytes"))
);
--> statement-breakpoint
CREATE TABLE "issued_documents" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"document_type" text NOT NULL,
	"number" text NOT NULL,
	"quote_version" integer,
	"revision" integer,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_by" text,
	"pdf_sha256" text NOT NULL,
	"source" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	CONSTRAINT "issued_documents_uid_check" CHECK ("issued_documents"."uid" ~ '^doc_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "issued_documents_document_type_check" CHECK ("issued_documents"."document_type" in ('quote','invoice','receipt','credit_note')),
	CONSTRAINT "issued_documents_source_check" CHECK ("issued_documents"."source" in ('live','ledger-backfill','invoice-revision-backfill','legacy-sent-attachment','legacy-stored-version')),
	CONSTRAINT "issued_documents_number_check" CHECK (btrim("issued_documents"."number") <> ''),
	CONSTRAINT "issued_documents_quote_version_check" CHECK ("issued_documents"."quote_version" is null or "issued_documents"."quote_version" > 0),
	CONSTRAINT "issued_documents_revision_check" CHECK ("issued_documents"."revision" is null or "issued_documents"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "document_events" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"issued_document_uid" text,
	"job_id" text NOT NULL,
	"document_type" text NOT NULL,
	"event" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"by" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_events_uid_check" CHECK ("document_events"."uid" ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "document_events_document_type_check" CHECK ("document_events"."document_type" in ('quote','invoice','receipt','credit_note')),
	CONSTRAINT "document_events_event_check" CHECK ("document_events"."event" in ('created','issued','emailed','email_failed','paid','voided','credited'))
);
--> statement-breakpoint
CREATE TABLE "document_number_counters" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"document_type" text NOT NULL,
	"period" text NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_number_counters_org_uid_document_type_period_pk" PRIMARY KEY("org_uid","document_type","period"),
	CONSTRAINT "document_number_counters_document_type_check" CHECK ("document_number_counters"."document_type" in ('quote','invoice','receipt','credit_note')),
	CONSTRAINT "document_number_counters_last_value_check" CHECK ("document_number_counters"."last_value" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issued_documents_org_uid_key" ON "issued_documents" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "issued_documents_org_type_number_key" ON "issued_documents" USING btree ("org_uid","document_type","number");--> statement-breakpoint
CREATE INDEX "issued_documents_job_idx" ON "issued_documents" USING btree ("org_uid","job_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_events_org_idempotency_key" ON "document_events" USING btree ("org_uid","idempotency_key");--> statement-breakpoint
CREATE INDEX "document_events_document_idx" ON "document_events" USING btree ("org_uid","issued_document_uid","at");--> statement-breakpoint
CREATE INDEX "document_events_job_idx" ON "document_events" USING btree ("org_uid","job_id","at");--> statement-breakpoint
ALTER TABLE "document_blobs" ADD CONSTRAINT "document_blobs_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_blob_fk" FOREIGN KEY ("org_uid","pdf_sha256") REFERENCES "public"."document_blobs"("org_uid","sha256") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_issued_document_fk" FOREIGN KEY ("org_uid","issued_document_uid") REFERENCES "public"."issued_documents"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_number_counters" ADD CONSTRAINT "document_number_counters_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Immutability. What a customer was sent never changes: blobs and events
-- refuse every UPDATE, DELETE and TRUNCATE; an issued document refuses them
-- too, except an UPDATE that changes only `details` (more of the frozen
-- context found later). These hold for the table owner as well as field_app.
CREATE FUNCTION field_refuse_document_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'issued_documents'
     AND (to_jsonb(NEW) - 'details') = (to_jsonb(OLD) - 'details') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "document_blobs_immutable" BEFORE UPDATE OR DELETE ON "document_blobs" FOR EACH ROW EXECUTE FUNCTION field_refuse_document_change();
--> statement-breakpoint
CREATE TRIGGER "document_blobs_no_truncate" BEFORE TRUNCATE ON "document_blobs" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_document_change();
--> statement-breakpoint
CREATE TRIGGER "issued_documents_immutable" BEFORE UPDATE OR DELETE ON "issued_documents" FOR EACH ROW EXECUTE FUNCTION field_refuse_document_change();
--> statement-breakpoint
CREATE TRIGGER "issued_documents_no_truncate" BEFORE TRUNCATE ON "issued_documents" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_document_change();
--> statement-breakpoint
CREATE TRIGGER "document_events_immutable" BEFORE UPDATE OR DELETE ON "document_events" FOR EACH ROW EXECUTE FUNCTION field_refuse_document_change();
--> statement-breakpoint
CREATE TRIGGER "document_events_no_truncate" BEFORE TRUNCATE ON "document_events" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_document_change();
--> statement-breakpoint
ALTER TABLE "document_blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_blobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issued_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issued_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_number_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_number_counters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "document_blobs_tenant_isolation" ON "document_blobs" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "issued_documents_tenant_isolation" ON "issued_documents" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "document_events_tenant_isolation" ON "document_events" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "document_number_counters_tenant_isolation" ON "document_number_counters" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
-- Requests may read documents and add them; never edit or remove them. The
-- one column an issued document may change is `details`. Counters are read,
-- created and advanced.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT ON "document_blobs", "issued_documents", "document_events" TO field_app;
    GRANT UPDATE ("details") ON "issued_documents" TO field_app;
    GRANT SELECT, INSERT, UPDATE ON "document_number_counters" TO field_app;
  END IF;
END
$$;
