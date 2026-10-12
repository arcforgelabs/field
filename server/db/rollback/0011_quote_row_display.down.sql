-- Reverses migration 0011_quote_row_display for an emergency rollback to a
-- release from before it. Run as the database owner, in ONE transaction,
-- after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0011_quote_row_display.down.sql
--
-- Drops the display columns. Rows written since keep their money; the
-- dual-write maps the display again after 0011 is applied again (a draft is
-- rewritten; a sent quote keeps its rows and is printed from its files). Roll
-- back 0011 before 0010.

SET LOCAL lock_timeout = '10s';

ALTER TABLE "quote_lines" DROP CONSTRAINT "quote_lines_row_style_check";
ALTER TABLE "quote_lines" DROP CONSTRAINT "quote_lines_row_kind_check";
ALTER TABLE "quote_sections" DROP CONSTRAINT "quote_sections_row_style_check";
ALTER TABLE "quote_lines"
  DROP COLUMN "is_excluded",
  DROP COLUMN "show_amount",
  DROP COLUMN "amount_blank",
  DROP COLUMN "is_collapsed",
  DROP COLUMN "row_style",
  DROP COLUMN "notes",
  DROP COLUMN "row_kind",
  DROP COLUMN "display_unit_sell",
  DROP COLUMN "line_cost";
ALTER TABLE "quote_sections"
  DROP COLUMN "is_excluded",
  DROP COLUMN "amount_blank",
  DROP COLUMN "is_collapsed",
  DROP COLUMN "row_style",
  DROP COLUMN "notes";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791784747969;
