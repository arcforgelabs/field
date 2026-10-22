// Historical migrations (0000-0024) create Field's tables in public. Today's
// Drizzle schema qualifies every table as field.<table>. A test that calls
// today's code against one of those prefixes parks the tables in field for
// the call, then puts them back so a down.sql and a public-schema comparison
// see them where that migration left them.

const MOVE_TO_FIELD = `
CREATE SCHEMA IF NOT EXISTS field;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA field', r.relname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_app') THEN
    GRANT USAGE ON SCHEMA field TO field_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA field TO field_app;
  END IF;
END $$;
`;

const MOVE_TO_PUBLIC = `
DO $$
DECLARE r record;
BEGIN
  IF to_regnamespace('field') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'field' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE field.%I SET SCHEMA public', r.relname);
  END LOOP;
END $$;
DROP SCHEMA IF EXISTS field;
`;

export async function moveTablesToField(client) {
  await client.exec(MOVE_TO_FIELD);
}

export async function moveTablesToPublic(client) {
  await client.exec(MOVE_TO_PUBLIC);
}

// Runs fn while the tables are in field, then puts them back even if fn throws.
export async function withTablesInField(client, fn) {
  await moveTablesToField(client);
  try {
    return await fn();
  } finally {
    await moveTablesToPublic(client);
  }
}
