-- Fail fast rather than queue behind a running instance's locks.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
-- Quotes as rows, part two (#245): what the customer documents print, so a
-- quote renders from its rows exactly as it did from its files. Per line and
-- per section: excluded from the price, amount hidden or blank, collapsed,
-- row style and internal notes; per line also how documents style it
-- (row_kind), the rate printed beside a fixed price (display_unit_sell) and
-- the cost behind the amount (line_cost, internal). Additive: every column
-- has a default or is nullable, and the sent-quote triggers from 0010 cover
-- them like every other column.
ALTER TABLE "quote_lines" ADD COLUMN "is_excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "show_amount" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "amount_blank" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "is_collapsed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "row_style" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "row_kind" text DEFAULT 'row' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "display_unit_sell" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "line_cost" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "quote_sections" ADD COLUMN "is_excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_sections" ADD COLUMN "amount_blank" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_sections" ADD COLUMN "is_collapsed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_sections" ADD COLUMN "row_style" text;--> statement-breakpoint
ALTER TABLE "quote_sections" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_row_style_check" CHECK ("quote_lines"."row_style" is null or "quote_lines"."row_style" in ('branded','bold','normal'));--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_row_kind_check" CHECK ("quote_lines"."row_kind" in ('row','group','generated'));--> statement-breakpoint
ALTER TABLE "quote_sections" ADD CONSTRAINT "quote_sections_row_style_check" CHECK ("quote_sections"."row_style" is null or "quote_sections"."row_style" in ('branded','bold','normal'));
