-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Quotes as rows, part one (#241, #178 phase 3; docs/PRICING_ENGINE.md
-- "Quotes and invoices"). One `quotes` row per quote version, with its
-- sections and lines. Additive: nothing existing is changed, and the job files
-- stay the source of truth until the quote editor and PDFs read these rows.
-- Hand-ordered from drizzle-kit's output (each table before the keys that
-- point at it, unique keys before the foreign keys that need them), then the
-- sent-quote triggers, FORCE ROW LEVEL SECURITY and field_app's grants, which
-- drizzle-kit does not emit.
--
-- Money (decided 2026-10-12, #178): a line's total is its official amount.
-- `computed` totals are round(quantity x unit_sell, 2), which the database
-- checks; `printed` totals are what a document already issued printed, with
-- the reason. unit_sell keeps four decimals so historical rates reproduce.
-- GST is worked out once on the subtotal; a quote keeps the GST it printed
-- (`tax_total_source` = 'printed', with the reason) only where the tax fell
-- exactly on half a cent and the old renderer rounded it the other way.
CREATE TABLE "quotes" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"job_id" text NOT NULL,
	"number" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text,
	"scope_text" text,
	"terms_text" text,
	"customer" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"valid_until_on" date,
	"subtotal" numeric(12, 2) NOT NULL,
	"tax_total" numeric(12, 2) NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"tax_total_source" text DEFAULT 'computed' NOT NULL,
	"tax_total_reason" text,
	"catalog_version" bigint,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"issued_document_uid" text,
	"source_digest" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"version_lock" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "quotes_uid_check" CHECK ("quotes"."uid" ~ '^qte_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "quotes_status_check" CHECK ("quotes"."status" in ('draft','sent','accepted','declined','superseded','void')),
	CONSTRAINT "quotes_version_check" CHECK ("quotes"."version" > 0),
	CONSTRAINT "quotes_number_check" CHECK (btrim("quotes"."number") <> ''),
	CONSTRAINT "quotes_currency_check" CHECK ("quotes"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "quotes_total_check" CHECK ("quotes"."total" = "quotes"."subtotal" + "quotes"."tax_total"),
	CONSTRAINT "quotes_tax_total_source_check" CHECK ("quotes"."tax_total_source" in ('computed','printed') and ("quotes"."tax_total_source" = 'computed' or "quotes"."tax_total_reason" is not null)),
	CONSTRAINT "quotes_version_lock_check" CHECK ("quotes"."version_lock" > 0)
);
--> statement-breakpoint
CREATE TABLE "quote_sections" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"quote_uid" text NOT NULL,
	"title" text NOT NULL,
	"sort_order" integer NOT NULL,
	"show_subtotal" boolean DEFAULT true NOT NULL,
	"source_node_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	CONSTRAINT "quote_sections_uid_check" CHECK ("quote_sections"."uid" ~ '^qsc_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"uid" text PRIMARY KEY NOT NULL,
	"org_uid" text DEFAULT field_org_uid() NOT NULL,
	"quote_uid" text NOT NULL,
	"section_uid" text,
	"parent_line_uid" text,
	"sort_order" integer NOT NULL,
	"line_type" text NOT NULL,
	"item_uid" text,
	"price_uid" text,
	"price_key" text,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_code" text NOT NULL,
	"unit_cost" numeric(12, 4),
	"unit_sell" numeric(12, 4),
	"is_price_override" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"tax_code" text NOT NULL,
	"tax_rate" numeric(7, 3) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"line_total_source" text DEFAULT 'computed' NOT NULL,
	"line_total_reason" text,
	"is_optional" boolean DEFAULT false NOT NULL,
	"is_selected" boolean DEFAULT true NOT NULL,
	"source_node_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text,
	CONSTRAINT "quote_lines_uid_check" CHECK ("quote_lines"."uid" ~ '^qln_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "quote_lines_line_type_check" CHECK ("quote_lines"."line_type" in ('item','custom','component','note')),
	CONSTRAINT "quote_lines_item_check" CHECK ("quote_lines"."line_type" <> 'item' or "quote_lines"."item_uid" is not null),
	CONSTRAINT "quote_lines_note_check" CHECK ("quote_lines"."line_type" <> 'note' or ("quote_lines"."unit_sell" is null and "quote_lines"."line_total" = 0)),
	CONSTRAINT "quote_lines_line_total_check" CHECK (case "quote_lines"."line_total_source"
      when 'computed' then ("quote_lines"."unit_sell" is null and "quote_lines"."line_total" = 0) or "quote_lines"."line_total" = round("quote_lines"."quantity" * "quote_lines"."unit_sell", 2)
      when 'printed' then "quote_lines"."line_total_reason" is not null
      else false end),
	CONSTRAINT "quote_lines_quantity_check" CHECK ("quote_lines"."quantity" >= 0),
	CONSTRAINT "quote_lines_selected_check" CHECK ("quote_lines"."is_optional" or "quote_lines"."is_selected"),
	CONSTRAINT "quote_lines_parent_check" CHECK ("quote_lines"."parent_line_uid" is null or "quote_lines"."parent_line_uid" <> "quote_lines"."uid")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_org_uid_key" ON "quotes" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_org_job_version_key" ON "quotes" USING btree ("org_uid","job_id","version");--> statement-breakpoint
CREATE INDEX "quotes_org_number_idx" ON "quotes" USING btree ("org_uid","number","version");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_sections_org_uid_key" ON "quote_sections" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE INDEX "quote_sections_quote_idx" ON "quote_sections" USING btree ("org_uid","quote_uid","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_lines_org_uid_key" ON "quote_lines" USING btree ("org_uid","uid");--> statement-breakpoint
CREATE INDEX "quote_lines_quote_idx" ON "quote_lines" USING btree ("org_uid","quote_uid","sort_order");--> statement-breakpoint
CREATE INDEX "quote_lines_item_idx" ON "quote_lines" USING btree ("org_uid","item_uid");--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_issued_document_fk" FOREIGN KEY ("org_uid","issued_document_uid") REFERENCES "public"."issued_documents"("org_uid","uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_sections" ADD CONSTRAINT "quote_sections_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_sections" ADD CONSTRAINT "quote_sections_quote_fk" FOREIGN KEY ("org_uid","quote_uid") REFERENCES "public"."quotes"("org_uid","uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_org_uid_organizations_uid_fk" FOREIGN KEY ("org_uid") REFERENCES "public"."organizations"("uid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_fk" FOREIGN KEY ("org_uid","quote_uid") REFERENCES "public"."quotes"("org_uid","uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_section_fk" FOREIGN KEY ("org_uid","section_uid") REFERENCES "public"."quote_sections"("org_uid","uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_parent_fk" FOREIGN KEY ("org_uid","parent_line_uid") REFERENCES "public"."quote_lines"("org_uid","uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A sent quote never changes. A quote is frozen once it is sent, accepted or
-- declined, or has a send time (a superseded or void quote that was sent keeps
-- its send time, so it stays frozen). These hold for the table owner as well
-- as field_app.
CREATE FUNCTION field_quote_is_frozen(status text, sent_at timestamp with time zone) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$ SELECT status IN ('sent', 'accepted', 'declined') OR sent_at IS NOT NULL $$;
--> statement-breakpoint
-- On `quotes`: a frozen quote cannot be deleted, cannot go back to draft, and
-- keeps its number, money, customer, wording and send time. What may change:
-- its status, acceptance time, the issued document it was sent as (once set,
-- never replaced), its send time while it has none, and the bookkeeping
-- columns (source digest, version lock, updated at and by).
CREATE FUNCTION field_refuse_sent_quote_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  mutable text[] := ARRAY['status', 'accepted_at', 'issued_document_uid', 'sent_at', 'source_digest', 'version_lock', 'updated_at', 'updated_by'];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'quotes cannot be truncated: sent quotes never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT field_quote_is_frozen(OLD.status, OLD.sent_at) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quote % v% was sent: delete refused', OLD.number, OLD.version USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR NEW.status = 'draft'
     OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
     OR (OLD.issued_document_uid IS NOT NULL AND NEW.issued_document_uid IS DISTINCT FROM OLD.issued_document_uid) THEN
    RAISE EXCEPTION 'quote % v% was sent: change refused', OLD.number, OLD.version USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- On `quote_sections` and `quote_lines`: no insert, update or delete under a
-- frozen quote (checked for the old and the new parent). A cascade from
-- deleting a draft quote finds no parent and passes.
CREATE FUNCTION field_refuse_sent_quote_content_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent record;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% cannot be truncated: sent quotes never change', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT q.number, q.version, q.status, q.sent_at INTO parent FROM quotes q
      WHERE q.org_uid = OLD.org_uid AND q.uid = OLD.quote_uid;
    IF FOUND AND field_quote_is_frozen(parent.status, parent.sent_at) THEN
      RAISE EXCEPTION 'quote % v% was sent: % of its % refused', parent.number, parent.version, lower(TG_OP), TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT q.number, q.version, q.status, q.sent_at INTO parent FROM quotes q
      WHERE q.org_uid = NEW.org_uid AND q.uid = NEW.quote_uid;
    IF FOUND AND field_quote_is_frozen(parent.status, parent.sent_at) THEN
      RAISE EXCEPTION 'quote % v% was sent: % of its % refused', parent.number, parent.version, lower(TG_OP), TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "quotes_sent_immutable" BEFORE UPDATE OR DELETE ON "quotes" FOR EACH ROW EXECUTE FUNCTION field_refuse_sent_quote_change();
--> statement-breakpoint
CREATE TRIGGER "quotes_no_truncate" BEFORE TRUNCATE ON "quotes" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_sent_quote_change();
--> statement-breakpoint
CREATE TRIGGER "quote_sections_sent_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "quote_sections" FOR EACH ROW EXECUTE FUNCTION field_refuse_sent_quote_content_change();
--> statement-breakpoint
CREATE TRIGGER "quote_sections_no_truncate" BEFORE TRUNCATE ON "quote_sections" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_sent_quote_content_change();
--> statement-breakpoint
CREATE TRIGGER "quote_lines_sent_immutable" BEFORE INSERT OR UPDATE OR DELETE ON "quote_lines" FOR EACH ROW EXECUTE FUNCTION field_refuse_sent_quote_content_change();
--> statement-breakpoint
CREATE TRIGGER "quote_lines_no_truncate" BEFORE TRUNCATE ON "quote_lines" FOR EACH STATEMENT EXECUTE FUNCTION field_refuse_sent_quote_content_change();
--> statement-breakpoint
ALTER TABLE "quotes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quotes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quote_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quote_sections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quote_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quote_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "quotes_tenant_isolation" ON "quotes" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "quote_sections_tenant_isolation" ON "quote_sections" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));--> statement-breakpoint
CREATE POLICY "quote_lines_tenant_isolation" ON "quote_lines" AS PERMISSIVE FOR ALL TO public USING (org_uid = (select field_org_uid())) WITH CHECK (org_uid = (select field_org_uid()));
--> statement-breakpoint
-- Requests read and write quote rows; the triggers above keep sent quotes as
-- they were sent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "quotes", "quote_sections", "quote_lines" TO field_app;
  END IF;
END
$$;
