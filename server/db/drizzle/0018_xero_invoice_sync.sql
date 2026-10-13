-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Issued invoices to the owner's Xero (#93, phase 1). Additive:
--   - `xero_invoice_syncs`, one row per invoice on its way to Xero: its
--     state, attempts, the next try, the last error (a code, and the plain
--     reason the owner reads), and the Xero invoice it became;
--   - `invoices.xero_invoice_id` and `xero_status`: the matching Xero invoice
--     on the Field invoice row. The id is unique in the organisation;
--   - the issued-invoice trigger (0013) lets those two change on an issued
--     invoice, the id only once. Everything else stays as issued.
-- Then FORCE ROW LEVEL SECURITY and field_app's grants, which drizzle-kit
-- does not emit.
CREATE TABLE "xero_invoice_syncs" (
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"invoice_uid" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"mode" text NOT NULL,
	"queued_by" text NOT NULL,
	"requested_by" text,
	"queued_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_reason" text,
	"xero_invoice_id" text,
	"xero_status" text,
	"xero_contact_id" text,
	"xero_total" numeric(12, 2),
	"field_total" numeric(12, 2),
	"created_in_xero_at" timestamp with time zone,
	"attached_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "xero_invoice_syncs_org_uid_invoice_uid_pk" PRIMARY KEY("org_uid","invoice_uid"),
	CONSTRAINT "xero_invoice_syncs_state_check" CHECK ("xero_invoice_syncs"."state" in ('pending','created','mismatch','failed','skipped')),
	CONSTRAINT "xero_invoice_syncs_mode_check" CHECK ("xero_invoice_syncs"."mode" in ('draft','authorised')),
	CONSTRAINT "xero_invoice_syncs_queued_by_check" CHECK ("xero_invoice_syncs"."queued_by" in ('auto','owner')),
	CONSTRAINT "xero_invoice_syncs_attempts_check" CHECK ("xero_invoice_syncs"."attempts" >= 0),
	CONSTRAINT "xero_invoice_syncs_last_error_code_check" CHECK ("xero_invoice_syncs"."last_error_code" is null or "xero_invoice_syncs"."last_error_code" ~ '^[A-Z0-9_]{1,64}$'),
	CONSTRAINT "xero_invoice_syncs_created_check" CHECK ("xero_invoice_syncs"."state" not in ('created','mismatch') or "xero_invoice_syncs"."xero_invoice_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "xero_invoice_syncs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "xero_invoice_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "xero_status" text;--> statement-breakpoint
ALTER TABLE "xero_invoice_syncs" ADD CONSTRAINT "xero_invoice_syncs_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xero_invoice_syncs" ADD CONSTRAINT "xero_invoice_syncs_invoice_fk" FOREIGN KEY ("org_uid","invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "xero_invoice_syncs_due_idx" ON "xero_invoice_syncs" USING btree ("org_uid","next_attempt_at") WHERE "xero_invoice_syncs"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_xero_invoice_key" ON "invoices" USING btree ("org_uid","xero_invoice_id");--> statement-breakpoint
CREATE POLICY "xero_invoice_syncs_tenant_isolation" ON "xero_invoice_syncs" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "xero_invoice_syncs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- As 0013's, with xero_invoice_id (filled once) and xero_status mutable.
CREATE OR REPLACE FUNCTION field_refuse_issued_invoice_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'amount_paid', 'due_on', 'kind', 'note', 'version', 'updated_at', 'updated_by',
    'quote_uid', 'quote_version', 'quote_version_inferred', 'milestone_uid', 'issued_document_uid',
    'supersedes_invoice_uid', 'superseded_at', 'xero_invoice_id', 'xero_status'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'invoices cannot be truncated: issued invoices never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.issued_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice % was issued: delete refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR NEW.status = 'draft'
     OR (OLD.quote_uid IS NOT NULL AND NEW.quote_uid IS DISTINCT FROM OLD.quote_uid)
     OR (OLD.quote_version IS NOT NULL AND (NEW.quote_version IS DISTINCT FROM OLD.quote_version OR NEW.quote_version_inferred IS DISTINCT FROM OLD.quote_version_inferred))
     OR (OLD.milestone_uid IS NOT NULL AND NEW.milestone_uid IS DISTINCT FROM OLD.milestone_uid)
     OR (OLD.issued_document_uid IS NOT NULL AND NEW.issued_document_uid IS DISTINCT FROM OLD.issued_document_uid)
     OR (OLD.supersedes_invoice_uid IS NOT NULL AND NEW.supersedes_invoice_uid IS DISTINCT FROM OLD.supersedes_invoice_uid)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.xero_invoice_id IS NOT NULL AND NEW.xero_invoice_id IS DISTINCT FROM OLD.xero_invoice_id) THEN
    RAISE EXCEPTION 'invoice % was issued: change refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "xero_invoice_syncs" TO field_app;
  END IF;
END
$$;
