-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Credit notes instead of in-place revisions (#28, pricing engine phase 3
-- step 4b, part two; docs/PRICING_ENGINE.md "Invoices and payments"). An
-- issued invoice is corrected by a credit (adjustment) note that credits it
-- in full and names the invoice issued in its place; payments the credited
-- invoice held move to that invoice as allocations. Additive: credit_notes
-- (0013) gains the replacement invoice, where the note came from and the
-- issue service's idempotency key; payment_allocations is new.
--
-- Hand-ordered from drizzle-kit's output (each table before the keys that
-- point at it), then FORCE ROW LEVEL SECURITY, the append-only trigger and
-- field_app's grants, which drizzle-kit does not emit. 0013's credit-note
-- trigger already keeps every column it does not list as mutable, so the
-- new columns never change once a note is issued.
CREATE TABLE "payment_allocations" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"payment_uid" text NOT NULL,
	"from_invoice_uid" text NOT NULL,
	"to_invoice_uid" text NOT NULL,
	"credit_note_uid" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"allocated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	CONSTRAINT "payment_allocations_uid_check" CHECK ("payment_allocations"."uid" ~ '^pal_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "payment_allocations_amount_check" CHECK ("payment_allocations"."amount" > 0),
	CONSTRAINT "payment_allocations_invoices_check" CHECK ("payment_allocations"."from_invoice_uid" <> "payment_allocations"."to_invoice_uid")
);
--> statement-breakpoint
ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "replacement_invoice_uid" text;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "origin" text DEFAULT 'issued' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "issue_key" text;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk" FOREIGN KEY ("org_uid","payment_uid") REFERENCES "public"."payments"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_from_invoice_fk" FOREIGN KEY ("org_uid","from_invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_to_invoice_fk" FOREIGN KEY ("org_uid","to_invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_credit_note_fk" FOREIGN KEY ("org_uid","credit_note_uid") REFERENCES "public"."credit_notes"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_org_uid_key" ON "payment_allocations" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocations_org_payment_credit_key" ON "payment_allocations" USING btree ("org_uid","payment_uid","credit_note_uid");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("org_uid","payment_uid","allocated_at");--> statement-breakpoint
CREATE INDEX "payment_allocations_job_idx" ON "payment_allocations" USING btree ("org_uid","job_id");--> statement-breakpoint
-- Checking a new foreign key on a table that already exists reads both
-- tables; as their owner (not a superuser) FORCE ROW LEVEL SECURITY would
-- filter that read and refuse it outside an organisation. FORCE is lifted for
-- the check only, in this transaction, and put back at once.
ALTER TABLE "credit_notes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_replacement_invoice_fk" FOREIGN KEY ("org_uid","replacement_invoice_uid") REFERENCES "public"."invoices"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_org_issue_key" ON "credit_notes" USING btree ("org_uid","issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_org_invoice_key" ON "credit_notes" USING btree ("org_uid","invoice_uid") WHERE "credit_notes"."status" = 'issued';--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_origin_check" CHECK ("credit_notes"."origin" in ('issued','revision-migration'));--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issue_check" CHECK ("credit_notes"."issue_key" is null or ("credit_notes"."origin" = 'issued' and "credit_notes"."issued_at" is not null and "credit_notes"."number" ~ '^CN-[0-9]{4}-[0-9]{2}-[1-9][0-9]*$'));--> statement-breakpoint
CREATE POLICY "payment_allocations_tenant_isolation" ON "payment_allocations" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
ALTER TABLE "payment_allocations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- An allocation is a fact about money received: append-only, for the table
-- owner as well as field_app.
CREATE FUNCTION field_refuse_payment_allocation_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment_allocations is append-only: % refused', lower(TG_OP) USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "payment_allocations_immutable" BEFORE UPDATE OR DELETE ON "payment_allocations" FOR EACH ROW EXECUTE FUNCTION field_refuse_payment_allocation_change();
--> statement-breakpoint
CREATE TRIGGER "payment_allocations_no_truncate" BEFORE TRUNCATE ON "payment_allocations" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_payment_allocation_change();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT ON "payment_allocations" TO field_app;
  END IF;
END
$$;
