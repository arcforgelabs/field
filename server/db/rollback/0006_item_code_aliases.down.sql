-- Reverses migration 0006_item_code_aliases (#178 step 2) for an emergency
-- rollback to a release from before it. Run as the database owner, in ONE
-- transaction, after stopping the app:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f server/db/rollback/0006_item_code_aliases.down.sql
--
-- Nothing else depends on the aliases table: every item keeps its code in
-- items.code, which is what releases before 0006 look items up by. Codes
-- recorded only as aliases (none until a later migration retires a code)
-- would be lost, so the script refuses when one exists.
-- server/catalog/code-aliases.test.js proves the result matches a database
-- that never had 0006.

SET LOCAL lock_timeout = '10s';

-- The owner is filtered by FORCE ROW LEVEL SECURITY and nothing sets
-- field.org_uid here.
ALTER TABLE "item_code_aliases" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "item_code_aliases" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "items" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  extra integer;
BEGIN
  SELECT count(*) INTO extra FROM "item_code_aliases" a
    WHERE NOT EXISTS (
      SELECT 1 FROM "items" i
      WHERE i."org_uid" = a."org_uid" AND i."uid" = a."item_uid" AND lower(i."code") = lower(a."code")
    );
  IF extra > 0 THEN
    RAISE EXCEPTION '% alias(es) are not an item''s current code; rolling 0006 back would lose them', extra;
  END IF;
END
$$;

ALTER TABLE "items" FORCE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS "items_code_alias_insert" ON "items";
DROP TRIGGER IF EXISTS "items_code_immutable" ON "items";
DROP FUNCTION IF EXISTS field_item_code_alias();
DROP TABLE "item_code_aliases";

DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791765923050;
