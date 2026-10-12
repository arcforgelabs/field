-- Reverses migration 0013_invoice_rows for an emergency rollback to a release
-- from before it. Run it before 0012's, if that is rolled back too. Run as
-- the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0013_invoice_rows.down.sql
--
-- This drops every invoice, payment and receipt row. In this step the job
-- files (milestone-invoices/state.json) are still the source of truth, so
-- nothing is lost that the files do not hold, and the backfill
-- (scripts/backfill-invoice-rows.js) rebuilds the rows after 0013 is applied
-- again. Payments the dual-write voided because a "mark unpaid" removed them
-- from the files are not rebuilt: the files no longer hold them.

SET LOCAL lock_timeout = '10s';

DROP TABLE "receipts";
DROP TABLE "payments";
DROP TABLE "credit_note_lines";
DROP TABLE "credit_notes";
DROP TABLE "invoice_lines";
DROP TABLE "invoices";
DROP TABLE "payment_milestones";
DROP FUNCTION field_refuse_receipt_change();
DROP FUNCTION field_refuse_payment_change();
DROP FUNCTION field_refuse_issued_credit_note_line_change();
DROP FUNCTION field_refuse_issued_invoice_line_change();
DROP FUNCTION field_refuse_issued_credit_note_change();
DROP FUNCTION field_refuse_issued_invoice_change();

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791803297301;
