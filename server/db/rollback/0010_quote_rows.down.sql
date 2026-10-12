-- Reverses migration 0010_quote_rows for an emergency rollback to a release
-- from before it. Run as the database owner, in ONE transaction, after
-- stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0010_quote_rows.down.sql
--
-- This drops every quote row. In this step the job files are still the source
-- of truth, so nothing is lost that the files do not hold, and the backfill
-- (scripts/backfill-quote-rows.js) rebuilds the rows after 0010 is applied
-- again. Roll back 0010 before 0009.

SET LOCAL lock_timeout = '10s';

DROP TABLE "quote_lines";
DROP TABLE "quote_sections";
DROP TABLE "quotes";
DROP FUNCTION field_refuse_sent_quote_content_change();
DROP FUNCTION field_refuse_sent_quote_change();
DROP FUNCTION field_quote_is_frozen(text, timestamp with time zone);

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791783947685;
