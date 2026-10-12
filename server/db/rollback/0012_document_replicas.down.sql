-- Reverses migration 0012_document_replicas for an emergency rollback to a
-- release from before it. Run it before 0011's and 0010's, if those are
-- rolled back too. Run as the database owner, in ONE transaction,
-- after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0012_document_replicas.down.sql
--
-- This drops the replication record only. The bytes stay in document_blobs
-- (the store of record) and the objects stay in R2 (the bucket is locked).
-- After 0012 is applied again, the replicator finds every object already in
-- R2 with the right hash and records it without writing anything.

SET LOCAL lock_timeout = '10s';

DROP TABLE "document_blob_replicas";
DROP FUNCTION field_refuse_replica_change();

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791790631441;
