-- Reverses migration 0020_neutral_default_org for an emergency rollback to a
-- release from before it. Run it before 0019's, if that is rolled back too.
-- Run as the database owner, in ONE transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0020_neutral_default_org.down.sql
--
-- Releases before 0020 find the default organisation by its 0005 slug, so a
-- default organisation 0020 renamed gets 0005's name and slug back. A
-- database 0020 left alone is not changed.

SET LOCAL lock_timeout = '10s';

UPDATE "organizations"
SET "name" = 'Embark Earthworks', "slug" = 'embark', "updated_at" = now()
WHERE "uid" = 'org_01M4NF6NV3HW3CCZB7NVB9B157'
  AND "slug" = 'default'
  AND "name" = 'Default organisation'
  AND NOT EXISTS (SELECT 1 FROM "organizations" WHERE "slug" = 'embark');

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791877964332;
