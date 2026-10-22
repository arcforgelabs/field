// A throwaway copy of a deployment's catalogue to rehearse migrations on
// (`npm run data:migrate -- --dry-run`). The source database is only
// read: through a session opened with default_transaction_read_only, inside
// read-only organisation transactions. Its catalogue tables are copied, as
// they are at whatever schema version the source is on, into an in-memory
// PGlite migrated to that same version; then the copy is migrated to this
// release's schema, which rehearses the schema migrations on real data too.
// Data migrations then run against the copy and against a temporary copy of
// the job files, so they can be applied end to end without touching anything
// real.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../storage/fs.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite, types } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { MIGRATIONS_FOLDER, schema } from "../db-runtime/index.js";
import { withOrg } from "../db-runtime/tenancy.js";

// Copy order respects foreign keys; self references are filled in afterwards.
const ORG_TABLES = [
  "tax_codes", "categories", "suppliers", "items", "item_code_aliases", "item_unit_conversions",
  "item_suppliers", "item_prices", "item_components", "kit_components", "price_imports",
  "price_import_rows", "assembly_params", "assembly_vars", "assembly_components", "assembly_tests",
  "assembly_versions", "catalog_evidence", "catalog_meta", "data_migrations",
];
// catalog_history (the audit trail, ~10k rows in production) is not copied:
// nothing a migration plans or verifies reads it.
const SHARED_TABLES = ["units", "unit_aliases"];
const SELF_REFERENCES = { categories: ["parent_id"], items: ["variant_of_uid"] };

function rowsOf(result) {
  return Array.isArray(result) ? result : result?.rows || [];
}

/** A session on the source database that cannot write (default_transaction_read_only). */
export function openReadOnlySource(config) {
  if (config.driver !== "postgres") throw new Error("the source must be PostgreSQL (DATABASE_URL / FIELD_DB_URL)");
  const client = postgres(config.url, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: !config.pooled,
    onnotice: () => {},
    connection: { application_name: "field-data-migrations-dry-run", TimeZone: "UTC", default_transaction_read_only: "on", search_path: "field, public" },
  });
  return { db: drizzlePostgres(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

function journal() {
  return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")).entries;
}

/** The index of the last schema migration the source has applied (by drizzle's recorded timestamps). */
export async function sourceMigrationLevel(db) {
  const applied = rowsOf(await db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at`))
    .map((row) => Number(row.created_at));
  const entries = journal();
  let level = -1;
  for (const entry of entries) {
    if (applied.includes(Number(entry.when))) level = entry.idx;
  }
  if (level < 0) throw new Error("the source database has none of this release's schema migrations");
  return level;
}

function migrationsUpTo(idx) {
  const dir = mkdtempSync(join(tmpdir(), "field-rehearsal-migrations-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const parsed = JSON.parse(readFileSync(journalPath, "utf8"));
  for (const entry of parsed.entries.filter((e) => e.idx > idx)) rmSync(join(dir, `${entry.tag}.sql`));
  parsed.entries = parsed.entries.filter((entry) => entry.idx <= idx);
  writeFileSync(journalPath, JSON.stringify(parsed));
  return dir;
}

async function existingTables(db) {
  // A source that has not applied 0025 still has its tables in public.
  // After that migration they are in field. A name in both is read from field.
  const rows = rowsOf(await db.execute(sql`
    select table_schema, table_name from information_schema.tables
    where table_schema in ('field', 'public') and table_type = 'BASE TABLE'`));
  const inField = new Set(rows.filter((row) => row.table_schema === "field").map((row) => row.table_name));
  return new Set(rows.filter((row) => row.table_schema === "field" || !inField.has(row.table_name)).map((row) => row.table_name));
}

function plainValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value;
}

async function insertRows(tx, table, rows, { onConflictNothing = false } = {}) {
  for (const row of rows) {
    const entries = Object.entries(row);
    const columns = sql.join(entries.map(([key]) => sql.identifier(key)), sql`, `);
    const values = sql.join(entries.map(([, value]) => sql`${plainValue(value)}`), sql`, `);
    await tx.execute(onConflictNothing
      ? sql`insert into ${sql.identifier(table)} (${columns}) values (${values}) on conflict do nothing`
      : sql`insert into ${sql.identifier(table)} (${columns}) values (${values})`);
  }
}

/**
 * Copies `orgUid`'s catalogue (and the shared units) from `source` into a new
 * in-memory PGlite at the source's schema version, then migrates the copy to
 * this release. Returns { db, client, sourceLevel, latestLevel, copied, close }.
 */
export async function copyCatalogueForRehearsal(source, orgUid) {
  const sourceLevel = await sourceMigrationLevel(source);
  const latestLevel = Math.max(...journal().map((entry) => entry.idx));
  const sourceTables = await existingTables(source);
  const dump = {};
  for (const table of SHARED_TABLES) {
    if (sourceTables.has(table)) dump[table] = rowsOf(await source.execute(sql`select * from ${sql.identifier(table)}`));
  }
  const [organization] = rowsOf(await source.execute(sql`select * from organizations where uid = ${orgUid}`));
  if (!organization) throw new Error(`organisation ${orgUid} is not in the source database`);
  await withOrg(source, orgUid, async (tx) => {
    for (const table of ORG_TABLES) {
      if (sourceTables.has(table)) dump[table] = rowsOf(await tx.execute(sql`select * from ${sql.identifier(table)} order by 1`));
    }
  }, { accessMode: "read only" });

  const client = new PGlite({ parsers: { [types.INT8]: (v) => v, [types.NUMERIC]: (v) => v }, postgresqlconf: ["timezone = 'UTC'", "shared_buffers = '16MB'"] });
  const db = drizzlePglite(client, { schema });
  const folder = migrationsUpTo(sourceLevel);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  await insertRows(db, "organizations", [organization], { onConflictNothing: true });
  for (const table of SHARED_TABLES) {
    if (!dump[table]) continue;
    await db.execute(sql`delete from ${sql.identifier(table)}`);
    await insertRows(db, table, dump[table]);
  }
  const copied = {};
  await withOrg(db, orgUid, async (tx) => {
    await tx.execute(sql`delete from catalog_meta`);
    await tx.execute(sql`delete from tax_codes`);
    for (const table of ORG_TABLES) {
      const rows = dump[table];
      if (!rows) continue;
      const selfColumns = SELF_REFERENCES[table] || [];
      const firstPass = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, selfColumns.includes(key) ? null : value])));
      // item_code_aliases rows are also created by the items trigger (0006+).
      await insertRows(tx, table, firstPass, { onConflictNothing: table === "item_code_aliases" });
      for (const column of selfColumns) {
        const key = table === "categories" ? "id" : "uid";
        for (const row of rows.filter((r) => r[column] != null)) {
          await tx.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = ${row[column]} where ${sql.identifier(key)} = ${row[key]}`);
        }
      }
      copied[table] = rows.length;
    }
  });
  // Identity columns continue after the copied ids (as the owner: requests
  // may not setval).
  for (const table of ["categories", "suppliers", "item_prices", "item_components", "kit_components", "item_suppliers", "price_imports", "catalog_evidence"]) {
    if (!copied[table]) continue;
    await db.execute(sql.raw(`select setval(pg_get_serial_sequence('"${table}"', 'id'), (select max(id) from "${table}"))`));
  }
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, client, sourceLevel, latestLevel, copied, close: () => client.close() };
}
