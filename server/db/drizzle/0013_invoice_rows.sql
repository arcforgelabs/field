-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Invoices, payments and receipts as rows (#27; pricing engine phase 3 step
-- 4a; docs/PRICING_ENGINE.md "Invoices and payments"). Additive: nothing
-- existing is changed, and the job files (milestone-invoices/state.json) stay
-- the source of truth until invoices are issued from these rows (step 4b).
-- Hand-ordered from drizzle-kit's output (each table before the keys that
-- point at it, unique keys before the foreign keys that need them), then the
-- issued-document triggers, FORCE ROW LEVEL SECURITY and field_app's grants,
-- which drizzle-kit does not emit.
--
-- Money follows quote rows (0010): totals are numeric(12,2), a line's total
-- is round(quantity x unit_sell, 2) when `computed` (checked) and the amount
-- a document printed, with the reason, when `printed`. An invoice keeps the
-- GST it was issued with (`tax_total_source` = 'printed', with the reason)
-- where that differs from GST worked out on its own subtotal.
CREATE TABLE "payment_milestones" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"quote_uid" text,
	"label" text NOT NULL,
	"percent" numeric(7, 3),
	"amount" numeric(12, 2),
	"due_days" integer,
	"sort_order" integer NOT NULL,
	"is_default_schedule" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_milestones_uid_check" CHECK ("payment_milestones"."uid" ~ '^pms_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "payment_milestones_share_check" CHECK (("payment_milestones"."percent" is not null and "payment_milestones"."percent" > 0 and "payment_milestones"."percent" <= 100) or ("payment_milestones"."amount" is not null and "payment_milestones"."amount" > 0)),
	CONSTRAINT "payment_milestones_sort_order_check" CHECK ("payment_milestones"."sort_order" >= 0),
	CONSTRAINT "payment_milestones_due_days_check" CHECK ("payment_milestones"."due_days" is null or "payment_milestones"."due_days" > 0),
	CONSTRAINT "payment_milestones_version_check" CHECK ("payment_milestones"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"quote_uid" text,
	"quote_version" integer,
	"quote_version_inferred" boolean DEFAULT false NOT NULL,
	"milestone_uid" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"supersedes_invoice_uid" text,
	"issued_at" timestamp with time zone,
	"issued_on" date,
	"due_on" date,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"tax_total" numeric(12, 2) NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"tax_total_source" text DEFAULT 'computed' NOT NULL,
	"tax_total_reason" text,
	"amount_paid" numeric(12, 2) DEFAULT '0' NOT NULL,
	"issued_document_uid" text,
	"reference" text,
	"superseded_at" timestamp with time zone,
	"revision_reason" text,
	"revised_by" text,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "invoices_uid_check" CHECK ("invoices"."uid" ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "invoices_number_check" CHECK (btrim("invoices"."number") <> ''),
	CONSTRAINT "invoices_kind_check" CHECK ("invoices"."kind" in ('deposit','progress','final','variation')),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('draft','issued','paid','void','credited')),
	CONSTRAINT "invoices_issued_check" CHECK (("invoices"."status" = 'draft') = ("invoices"."issued_at" is null)),
	CONSTRAINT "invoices_currency_check" CHECK ("invoices"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "invoices_total_check" CHECK ("invoices"."total" = "invoices"."subtotal" + "invoices"."tax_total"),
	CONSTRAINT "invoices_tax_total_source_check" CHECK ("invoices"."tax_total_source" in ('computed','printed') and ("invoices"."tax_total_source" = 'computed' or "invoices"."tax_total_reason" is not null)),
	CONSTRAINT "invoices_amount_paid_check" CHECK ("invoices"."amount_paid" >= 0),
	CONSTRAINT "invoices_revision_check" CHECK ("invoices"."revision" > 0),
	CONSTRAINT "invoices_quote_version_check" CHECK ("invoices"."quote_version" is null or "invoices"."quote_version" > 0),
	CONSTRAINT "invoices_version_check" CHECK ("invoices"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"invoice_uid" text NOT NULL,
	"sort_order" integer NOT NULL,
	"line_type" text NOT NULL,
	"quote_uid" text,
	"milestone_uid" text,
	"item_uid" text,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_code" text NOT NULL,
	"unit_sell" numeric(12, 4),
	"tax_code" text NOT NULL,
	"tax_rate" numeric(7, 3) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"line_total_source" text DEFAULT 'computed' NOT NULL,
	"line_total_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	CONSTRAINT "invoice_lines_uid_check" CHECK ("invoice_lines"."uid" ~ '^iln_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "invoice_lines_line_type_check" CHECK ("invoice_lines"."line_type" in ('claim','item','custom','note')),
	CONSTRAINT "invoice_lines_item_check" CHECK ("invoice_lines"."line_type" <> 'item' or "invoice_lines"."item_uid" is not null),
	CONSTRAINT "invoice_lines_note_check" CHECK ("invoice_lines"."line_type" <> 'note' or ("invoice_lines"."unit_sell" is null and "invoice_lines"."line_total" = 0)),
	CONSTRAINT "invoice_lines_line_total_check" CHECK (case "invoice_lines"."line_total_source"
      when 'computed' then ("invoice_lines"."unit_sell" is null and "invoice_lines"."line_total" = 0) or "invoice_lines"."line_total" = round("invoice_lines"."quantity" * "invoice_lines"."unit_sell", 2)
      when 'printed' then "invoice_lines"."line_total_reason" is not null
      else false end),
	CONSTRAINT "invoice_lines_quantity_check" CHECK ("invoice_lines"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"number" text NOT NULL,
	"invoice_uid" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reason" text NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_on" date,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"subtotal" numeric(12, 2) NOT NULL,
	"tax_total" numeric(12, 2) NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"tax_total_source" text DEFAULT 'computed' NOT NULL,
	"tax_total_reason" text,
	"issued_document_uid" text,
	"reference" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "credit_notes_uid_check" CHECK ("credit_notes"."uid" ~ '^crn_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "credit_notes_number_check" CHECK (btrim("credit_notes"."number") <> ''),
	CONSTRAINT "credit_notes_status_check" CHECK ("credit_notes"."status" in ('draft','issued','void')),
	CONSTRAINT "credit_notes_issued_check" CHECK (("credit_notes"."status" = 'draft') = ("credit_notes"."issued_at" is null)),
	CONSTRAINT "credit_notes_currency_check" CHECK ("credit_notes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "credit_notes_total_check" CHECK ("credit_notes"."total" = "credit_notes"."subtotal" + "credit_notes"."tax_total" and "credit_notes"."total" >= 0),
	CONSTRAINT "credit_notes_tax_total_source_check" CHECK ("credit_notes"."tax_total_source" in ('computed','printed') and ("credit_notes"."tax_total_source" = 'computed' or "credit_notes"."tax_total_reason" is not null)),
	CONSTRAINT "credit_notes_version_check" CHECK ("credit_notes"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"credit_note_uid" text NOT NULL,
	"invoice_line_uid" text,
	"sort_order" integer NOT NULL,
	"line_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_code" text NOT NULL,
	"unit_sell" numeric(12, 4),
	"tax_code" text NOT NULL,
	"tax_rate" numeric(7, 3) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"line_total_source" text DEFAULT 'computed' NOT NULL,
	"line_total_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	CONSTRAINT "credit_note_lines_uid_check" CHECK ("credit_note_lines"."uid" ~ '^cnl_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "credit_note_lines_line_type_check" CHECK ("credit_note_lines"."line_type" in ('claim','item','custom','note')),
	CONSTRAINT "credit_note_lines_note_check" CHECK ("credit_note_lines"."line_type" <> 'note' or ("credit_note_lines"."unit_sell" is null and "credit_note_lines"."line_total" = 0)),
	CONSTRAINT "credit_note_lines_line_total_check" CHECK (case "credit_note_lines"."line_total_source"
      when 'computed' then ("credit_note_lines"."unit_sell" is null and "credit_note_lines"."line_total" = 0) or "credit_note_lines"."line_total" = round("credit_note_lines"."quantity" * "credit_note_lines"."unit_sell", 2)
      when 'printed' then "credit_note_lines"."line_total_reason" is not null
      else false end),
	CONSTRAINT "credit_note_lines_quantity_check" CHECK ("credit_note_lines"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"invoice_uid" text NOT NULL,
	"milestone_uid" text,
	"amount" numeric(12, 2) NOT NULL,
	"paid_on" date NOT NULL,
	"method" text,
	"reference" text,
	"recorded_at" timestamp with time zone NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" text,
	"source_payment_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payments_uid_check" CHECK ("payments"."uid" ~ '^pay_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_void_check" CHECK ("payments"."voided_at" is not null or ("payments"."void_reason" is null and "payments"."voided_by" is null)),
	CONSTRAINT "payments_version_check" CHECK ("payments"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"number" text NOT NULL,
	"payment_uid" text NOT NULL,
	"invoice_uid" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_on" date NOT NULL,
	"issued_document_uid" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "receipts_uid_check" CHECK ("receipts"."uid" ~ '^rct_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "receipts_number_check" CHECK (btrim("receipts"."number") <> ''),
	CONSTRAINT "receipts_status_check" CHECK ("receipts"."status" in ('issued','void')),
	CONSTRAINT "receipts_amount_check" CHECK ("receipts"."amount" > 0),
	CONSTRAINT "receipts_currency_check" CHECK ("receipts"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "receipts_version_check" CHECK ("receipts"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_milestones_org_uid_key" ON "payment_milestones" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_milestones_org_job_sort_key" ON "payment_milestones" USING btree ("org_uid","job_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_uid_key" ON "invoices" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_job_number_key" ON "invoices" USING btree ("org_uid","job_id","number");--> statement-breakpoint
CREATE INDEX "invoices_org_number_idx" ON "invoices" USING btree ("org_uid","number");--> statement-breakpoint
CREATE INDEX "invoices_milestone_idx" ON "invoices" USING btree ("org_uid","milestone_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_org_uid_key" ON "invoice_lines" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("org_uid","invoice_uid","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_org_uid_key" ON "credit_notes" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_org_number_key" ON "credit_notes" USING btree ("org_uid","number");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("org_uid","invoice_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_note_lines_org_uid_key" ON "credit_note_lines" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE INDEX "credit_note_lines_credit_note_idx" ON "credit_note_lines" USING btree ("org_uid","credit_note_uid","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_org_uid_key" ON "payments" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_org_job_source_key" ON "payments" USING btree ("org_uid","job_id","source_payment_id");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("org_uid","invoice_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_org_uid_key" ON "receipts" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_org_payment_key" ON "receipts" USING btree ("org_uid","payment_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_org_job_number_issued_key" ON "receipts" USING btree ("org_uid","job_id","number") WHERE "receipts"."status" = 'issued';--> statement-breakpoint
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_quote_fk" FOREIGN KEY ("org_uid","quote_uid") REFERENCES "public"."quotes"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_fk" FOREIGN KEY ("org_uid","quote_uid") REFERENCES "public"."quotes"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_milestone_fk" FOREIGN KEY ("org_uid","milestone_uid") REFERENCES "public"."payment_milestones"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supersedes_fk" FOREIGN KEY ("org_uid","supersedes_invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_document_fk" FOREIGN KEY ("org_uid","issued_document_uid") REFERENCES "public"."issued_documents"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("org_uid","invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_quote_fk" FOREIGN KEY ("org_uid","quote_uid") REFERENCES "public"."quotes"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_milestone_fk" FOREIGN KEY ("org_uid","milestone_uid") REFERENCES "public"."payment_milestones"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_fk" FOREIGN KEY ("org_uid","invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issued_document_fk" FOREIGN KEY ("org_uid","issued_document_uid") REFERENCES "public"."issued_documents"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_fk" FOREIGN KEY ("org_uid","credit_note_uid") REFERENCES "public"."credit_notes"("org_uid","uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_fk" FOREIGN KEY ("org_uid","invoice_line_uid") REFERENCES "public"."invoice_lines"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("org_uid","invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_milestone_fk" FOREIGN KEY ("org_uid","milestone_uid") REFERENCES "public"."payment_milestones"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_fk" FOREIGN KEY ("org_uid","payment_uid") REFERENCES "public"."payments"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_invoice_fk" FOREIGN KEY ("org_uid","invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_issued_document_fk" FOREIGN KEY ("org_uid","issued_document_uid") REFERENCES "public"."issued_documents"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- An issued invoice or credit note never changes. It is frozen once it has
-- an issue time. What may still change: its status (never back to draft), its
-- amount paid, due date, kind and note, the bookkeeping columns, and links
-- that were missing when it was first written (its quote, quote version,
-- milestone, issued document, the invoice it superseded and when it was
-- superseded), each filled once. These hold for the table owner as well as
-- field_app. TRUNCATE is always refused.
CREATE FUNCTION field_refuse_issued_invoice_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'amount_paid', 'due_on', 'kind', 'note', 'version', 'updated_at', 'updated_by',
    'quote_uid', 'quote_version', 'quote_version_inferred', 'milestone_uid', 'issued_document_uid',
    'supersedes_invoice_uid', 'superseded_at'];
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
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at) THEN
    RAISE EXCEPTION 'invoice % was issued: change refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION field_refuse_issued_credit_note_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'version', 'updated_at', 'updated_by', 'issued_document_uid'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'credit_notes cannot be truncated: issued credit notes never change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.issued_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit note % was issued: delete refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR NEW.status = 'draft'
     OR (OLD.issued_document_uid IS NOT NULL AND NEW.issued_document_uid IS DISTINCT FROM OLD.issued_document_uid) THEN
    RAISE EXCEPTION 'credit note % was issued: change refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- On `invoice_lines` and `credit_note_lines`: no insert, update or delete
-- under an issued parent (checked for the old and the new parent). A cascade
-- from deleting a draft finds no parent and passes.
CREATE FUNCTION field_refuse_issued_invoice_line_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent record;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% cannot be truncated: issued invoices never change', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT i.number, i.issued_at INTO parent FROM invoices i WHERE i.org_uid = OLD.org_uid AND i.uid = OLD.invoice_uid;
    IF FOUND AND parent.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'invoice % was issued: % of its lines refused', parent.number, lower(TG_OP) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT i.number, i.issued_at INTO parent FROM invoices i WHERE i.org_uid = NEW.org_uid AND i.uid = NEW.invoice_uid;
    IF FOUND AND parent.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'invoice % was issued: % of its lines refused', parent.number, lower(TG_OP) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE FUNCTION field_refuse_issued_credit_note_line_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent record;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% cannot be truncated: issued credit notes never change', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT c.number, c.issued_at INTO parent FROM credit_notes c WHERE c.org_uid = OLD.org_uid AND c.uid = OLD.credit_note_uid;
    IF FOUND AND parent.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'credit note % was issued: % of its lines refused', parent.number, lower(TG_OP) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT c.number, c.issued_at INTO parent FROM credit_notes c WHERE c.org_uid = NEW.org_uid AND c.uid = NEW.credit_note_uid;
    IF FOUND AND parent.issued_at IS NOT NULL THEN
      RAISE EXCEPTION 'credit note % was issued: % of its lines refused', parent.number, lower(TG_OP) USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A payment is money received: never deleted, and only voided, once. Its
-- milestone may be filled once.
CREATE FUNCTION field_refuse_payment_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY['voided_at', 'void_reason', 'voided_by', 'milestone_uid', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'payments cannot be truncated: a payment is voided, never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment % cannot be deleted: void it instead', OLD.uid USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR (OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason OR NEW.voided_by IS DISTINCT FROM OLD.voided_by))
     OR (OLD.milestone_uid IS NOT NULL AND NEW.milestone_uid IS DISTINCT FROM OLD.milestone_uid) THEN
    RAISE EXCEPTION 'payment %: change refused (only voiding, once, is allowed)', OLD.uid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- A receipt is issued when it is written: never deleted, and only voided.
-- Its issued document may be filled once.
CREATE FUNCTION field_refuse_receipt_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'issued_document_uid', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'receipts cannot be truncated: issued receipts never change' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipt % was issued: delete refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR (OLD.status = 'void' AND NEW.status <> 'void')
     OR (OLD.issued_document_uid IS NOT NULL AND NEW.issued_document_uid IS DISTINCT FROM OLD.issued_document_uid) THEN
    RAISE EXCEPTION 'receipt % was issued: change refused', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "invoices_issued_immutable" BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION field_refuse_issued_invoice_change();
--> statement-breakpoint
CREATE TRIGGER "invoices_no_truncate" BEFORE TRUNCATE ON "invoices" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_issued_invoice_change();
--> statement-breakpoint
CREATE TRIGGER "invoice_lines_issued_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION field_refuse_issued_invoice_line_change();
--> statement-breakpoint
CREATE TRIGGER "invoice_lines_no_truncate" BEFORE TRUNCATE ON "invoice_lines" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_issued_invoice_line_change();
--> statement-breakpoint
CREATE TRIGGER "credit_notes_issued_immutable" BEFORE UPDATE OR DELETE ON "credit_notes" FOR EACH ROW EXECUTE FUNCTION field_refuse_issued_credit_note_change();
--> statement-breakpoint
CREATE TRIGGER "credit_notes_no_truncate" BEFORE TRUNCATE ON "credit_notes" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_issued_credit_note_change();
--> statement-breakpoint
CREATE TRIGGER "credit_note_lines_issued_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "credit_note_lines" FOR EACH ROW EXECUTE FUNCTION field_refuse_issued_credit_note_line_change();
--> statement-breakpoint
CREATE TRIGGER "credit_note_lines_no_truncate" BEFORE TRUNCATE ON "credit_note_lines" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_issued_credit_note_line_change();
--> statement-breakpoint
CREATE TRIGGER "payments_immutable" BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION field_refuse_payment_change();
--> statement-breakpoint
CREATE TRIGGER "payments_no_truncate" BEFORE TRUNCATE ON "payments" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_payment_change();
--> statement-breakpoint
CREATE TRIGGER "receipts_immutable" BEFORE UPDATE OR DELETE ON "receipts" FOR EACH ROW EXECUTE FUNCTION field_refuse_receipt_change();
--> statement-breakpoint
CREATE TRIGGER "receipts_no_truncate" BEFORE TRUNCATE ON "receipts" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_receipt_change();
--> statement-breakpoint
ALTER TABLE "payment_milestones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_milestones" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_note_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "payment_milestones_tenant_isolation" ON "payment_milestones" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "invoices_tenant_isolation" ON "invoices" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "invoice_lines_tenant_isolation" ON "invoice_lines" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "credit_notes_tenant_isolation" ON "credit_notes" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "credit_note_lines_tenant_isolation" ON "credit_note_lines" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "payments_tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "receipts_tenant_isolation" ON "receipts" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
-- Requests read and write the rows; the triggers above keep issued
-- invoices, credit notes, payments and receipts as they were issued.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_milestones", "invoices", "invoice_lines", "credit_notes", "credit_note_lines", "payments", "receipts" TO field_app;
  END IF;
END
$$;
