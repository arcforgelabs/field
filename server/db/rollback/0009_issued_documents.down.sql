-- Reverses migration 0009_issued_documents for an emergency rollback to a
-- release from before it. Run as the database owner, in ONE transaction,
-- after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0009_issued_documents.down.sql
--
-- This drops every stored issued document and its history. In this step the
-- job files are still the source of truth, so nothing is lost that the files
-- do not hold, and the backfill (scripts/backfill-issued-documents.js)
-- rebuilds the rows after 0009 is applied again. Roll back 0009 before 0008.

SET LOCAL lock_timeout = '10s';

DROP TABLE "document_events";
DROP TABLE "issued_documents";
DROP TABLE "document_blobs";
DROP TABLE "document_number_counters";
DROP FUNCTION field_refuse_document_change();

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791773257512;
