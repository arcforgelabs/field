#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildBackfillBundle,
  renderImportSql,
  resolveFieldDataRoot,
  summarizeBundle,
} from "../server/db/job-backfill.js";

const DB_ROOT = resolve(import.meta.dirname, "../server/db");
const DEFAULT_SCHEMA_PATH = join(DB_ROOT, "migrations", "0001_initial.sql");

await main();

function parseArgs(args) {
  const result = {
    apply: false,
    emitSql: null,
    includeSchema: false,
    limit: null,
    sourceRoot: null,
    schemaPath: null,
    databaseUrl: null,
    psql: null,
    seedBackupJobs: false,
    recording: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--source-root":
        result.sourceRoot = args[++index];
        break;
      case "--recording":
        result.recording = args[++index];
        break;
      case "--limit":
        result.limit = Number(args[++index]);
        break;
      case "--emit-sql":
        result.emitSql = args[++index] || "-";
        break;
      case "--apply":
        result.apply = true;
        break;
      case "--include-schema":
        result.includeSchema = true;
        break;
      case "--schema-path":
        result.schemaPath = args[++index];
        break;
      case "--database-url":
        result.databaseUrl = args[++index];
        break;
      case "--psql":
        result.psql = args[++index];
        break;
      case "--seed-backup-jobs":
        result.seedBackupJobs = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return result;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/backfill-db.js [options]

Options:
  --source-root <path>       Recording data root. Defaults to config.json dataDir, FIELD_DATA, or data/.
  --recording <id>           Limit import to one recording directory or legacy recording ID.
  --limit <n>                Limit the number of recording directories scanned.
  --emit-sql <path|->        Write SQL to a file or stdout.
  --apply                    Apply generated SQL through psql to the database named by --database-url.
  --include-schema           Prepend the initial schema migration to the emitted SQL.
  --schema-path <path>       Override schema path used with --include-schema.
  --database-url <url>       Target database for --apply. Required: DATABASE_URL and FIELD_DATABASE_URL
                             are never read, because on Replit they name Field's own database.
  --psql <cmd>               Override the psql executable path.
  --seed-backup-jobs         Seed pending google_drive rows into backup_jobs for eligible storage objects.
  --help                     Show this message.

Examples:
  node scripts/backfill-db.js --source-root docs/reference-recordings/processed
  node scripts/backfill-db.js --source-root /path/to/field/data --emit-sql /tmp/field-backfill.sql
  node scripts/backfill-db.js --source-root /path/to/field/data --include-schema --apply --database-url postgres://localhost/field_legacy --seed-backup-jobs
`.trim());
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }

    // Fail closed: only a target named on the command line. DATABASE_URL and
    // FIELD_DATABASE_URL are Field's own database on Replit, and the SQL
    // itself refuses a database with Drizzle migrations (renderImportSql).
    if (options.apply && !options.databaseUrl) {
      throw new Error(
        "--apply needs --database-url <url> naming a dedicated, empty database. "
          + "DATABASE_URL and FIELD_DATABASE_URL are never used: on Replit they are Field's own database.",
      );
    }

    const sourceRoot = resolve(options.sourceRoot || resolveFieldDataRoot());
    const bundle = await buildBackfillBundle({
      sourceRoot,
      recordingFilter: options.recording || null,
      limit: options.limit,
      seedBackupJobs: options.seedBackupJobs,
    });

    const summary = summarizeBundle(bundle);
    console.log(summary);

    const shouldEmitSql = Boolean(options.emitSql || options.apply);
    if (!shouldEmitSql) {
      return;
    }

    const includeSchemaSql = options.includeSchema
      ? await import("node:fs/promises").then(({ readFile }) => readFile(resolve(options.schemaPath || DEFAULT_SCHEMA_PATH), "utf8"))
      : null;
    const sql = renderImportSql(bundle, { includeSchemaSql });

    if (options.emitSql) {
      if (options.emitSql === "-") {
        process.stdout.write(`\n${sql}`);
      } else {
        const outputPath = resolve(options.emitSql);
        await writeFile(outputPath, sql);
        console.log(`SQL written to ${outputPath}`);
      }
    }

    if (options.apply) {
      const psql = options.psql || process.env.PSQL || "psql";
      // Synchronous so `input` reaches psql's stdin; the async execFile ignores it.
      try {
        execFileSync(psql, [options.databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", "-"], {
          input: sql,
          stdio: ["pipe", "inherit", "inherit"],
        });
      } catch (error) {
        // error.message repeats the command line, and the URL can hold a password.
        throw new Error(`psql failed (exit ${error.status ?? error.code}); see its error above`);
      }
      console.log("SQL applied via psql");
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
