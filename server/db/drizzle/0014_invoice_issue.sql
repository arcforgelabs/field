-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Invoices issued from rows (#28, pricing engine phase 3 step 4b, part one;
-- docs/PRICING_ENGINE.md "Invoices and payments"). The invoice issue service
-- (server/invoices/issue.js) allocates INV-YYYY-MM-N from
-- document_number_counters, renders the PDF once, stores it, and writes the
-- issued invoice row in ONE transaction. `issue_key` is its idempotency key:
-- a retried issue finds the row and returns it. Additive: invoices issued
-- before this keep their numbers (EI-…, -R<k>) and a null key.
--
-- An invoice with a key is issued, numbered from the sequence, and carries
-- the job reference; a sequence number is unique in the organisation. The
-- issued-invoice trigger (0013) already keeps every column it does not list
-- as mutable, so `issue_key` never changes once the invoice is issued.
ALTER TABLE "invoices" ADD COLUMN "issue_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_issue_key" ON "invoices" USING btree ("org_uid","issue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_sequence_number_key" ON "invoices" USING btree ("org_uid","number") WHERE "invoices"."issue_key" is not null;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issue_check" CHECK ("invoices"."issue_key" is null or ("invoices"."issued_at" is not null and "invoices"."number" ~ '^INV-[0-9]{4}-[0-9]{2}-[1-9][0-9]*$' and "invoices"."reference" is not null and btrim("invoices"."reference") <> ''));
