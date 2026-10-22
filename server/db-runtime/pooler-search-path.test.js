// Migration 0025 leaves new sessions searching schema field, including a
// session whose startup packet did not carry search_path. A transaction-mode
// pooler drops that parameter; it does not set search_path=public. An explicit
// startup search_path=public would override the role default, so this test
// omits the parameter and checks the session landed on field, public.
//
// A pooler also keeps server sessions it opened before the move. 0025 closes
// those idle backends. PgBouncer in transaction mode, when the binary is
// installed, is the same check the sibling app ran: sessions from before the
// move still search public; after the move a new one finds the tables by name.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { writeLegacyCatalog } from "../catalog/fixtures/legacy-catalog.js";
import { importLegacyCatalog } from "../catalog/legacy-import.js";
import { ensureCatalogReferenceData, lockCatalogForWrite } from "../catalog/reference-data.js";
import { readDataMigrationLedger } from "../data-migrations/index.js";
import { createDocumentReplicator } from "../documents/replicator.js";
import { claimLineName, claimMoney } from "../invoices/from-milestones.js";
import { createInvoiceIssueService } from "../invoices/issue.js";
import { loadLatestImages } from "../storage/durable-store.js";
import { migratePostgresDatabase, queryRows, retryClosedConnections, schema } from "./index.js";
import { startTestPostgres, testPostgresMode } from "./test-postgres.js";
import { DEFAULT_ORG_UID, withOrg } from "./tenancy.js";

const enabled = testPostgresMode().kind !== "none";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function pgbouncerBin() {
  const bin = process.env.PGBOUNCER || "pgbouncer";
  const probe = spawnSync(bin, ["-V"], { encoding: "utf8" });
  if (probe.error) return null;
  return bin;
}

// Transaction-mode PgBouncer that drops search_path from the startup packet,
// which is what Neon's pooler does. Null when the binary is not installed.
async function startPgbouncer(databaseUrl) {
  const bin = pgbouncerBin();
  if (!bin) return null;
  const target = new URL(databaseUrl);
  const serverHost = target.hostname || "127.0.0.1";
  const serverPort = target.port || "5432";
  const user = decodeURIComponent(target.username || "postgres").replaceAll("\"", "\"\"");
  const dir = mkdtempSync(join(tmpdir(), "field-pgbouncer-"));
  const port = await freePort();
  writeFileSync(join(dir, "userlist.txt"), `"${user}" ""\n`);
  writeFileSync(join(dir, "pgbouncer.ini"), `
[databases]
* = host=${serverHost} port=${serverPort}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = ${port}
unix_socket_dir = ${dir}
auth_type = trust
auth_file = ${dir}/userlist.txt
pool_mode = transaction
max_client_conn = 20
default_pool_size = 1
min_pool_size = 0
ignore_startup_parameters = extra_float_digits,search_path
admin_users = ${user}
pidfile = ${dir}/pgbouncer.pid
logfile = ${dir}/pgbouncer.log
log_connections = 1
log_disconnections = 1
`);
  const child = spawn(bin, [join(dir, "pgbouncer.ini")], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const ready = new Promise((resolve, reject) => {
    const fail = (message) => {
      clearTimeout(timer);
      clearInterval(poll);
      let file = "";
      try { file = readFileSync(join(dir, "pgbouncer.log"), "utf8"); } catch { /* not written yet */ }
      reject(new Error(`${message}: ${log}\n${file}`));
    };
    const timer = setTimeout(() => fail("PgBouncer did not listen"), 8000);
    const poll = setInterval(() => {
      const probe = createConnection({ port, host: "127.0.0.1" });
      probe.once("connect", () => {
        clearTimeout(timer);
        clearInterval(poll);
        probe.end();
        resolve();
      });
      probe.once("error", () => probe.destroy());
    }, 50);
    child.once("exit", (code) => fail(`PgBouncer exited ${code}`));
  });
  try {
    await ready;
  } catch (error) {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    port,
    log: () => log,
    stop() {
      child.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function claimInvoice() {
  const money = claimMoney({
    subtotal: "400.00",
    gst: "40.00",
    total: "440.00",
    taxRate: "10.000",
    milestoneKey: "0",
    name: claimLineName({ label: "Deposit", percent: "50.000", quoteReference: "EQ-2610-03 v2" }),
    description: "Milestone 1 of 2",
  });
  return {
    milestoneKey: "0",
    kind: "deposit",
    revision: 1,
    currency: "AUD",
    quoteVersion: 2,
    quoteVersionInferred: false,
    ...money.totals,
    taxTotalSource: money.taxTotalSource,
    taxTotalReason: money.taxTotalReason,
    lines: money.lines,
    dueOn: null,
    note: null,
  };
}

test("pooled sessions search schema field, and a closed connection is retried", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const server = await startTestPostgres();
  const crashes = [];
  const onCrash = (error) => crashes.push(error);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  const clients = [];
  let bouncer = null;
  const open = (url, options) => {
    const client = postgres(url, { max: 1, onnotice: () => {}, ...options });
    clients.push(client);
    return client;
  };
  try {
    bouncer = await startPgbouncer(server.url);
    const url = server.url;
    let throughPooler = null;
    if (bouncer) {
      const pooledUrl = new URL(url);
      pooledUrl.port = String(bouncer.port);
      throughPooler = retryClosedConnections(postgres(pooledUrl.toString(), {
        max: 1,
        prepare: false,
        onnotice: () => {},
        connection: { application_name: "field-pooler", TimeZone: "UTC", search_path: "field, public" },
      }));
      clients.push(throughPooler);
      // Open the server session the pooler will keep, before the move.
      const [before] = await throughPooler`show search_path`;
      assert.match(String(before.search_path), /public/);
      assert.doesNotMatch(String(before.search_path), /^field, public$/);
    } else {
      t.diagnostic("pgbouncer is not installed; the transaction-pooler check was skipped");
    }

    let staleClosed = false;
    const stale = open(url, {
      onclose: () => { staleClosed = true; },
      connection: { application_name: "field-stale", TimeZone: "UTC" },
    });
    await stale`set search_path to public`;
    const [{ pid: stalePid }] = await stale`select pg_backend_pid() as pid`;

    const migrator = open(url, {
      connection: { application_name: "field-migrate", TimeZone: "UTC", search_path: "field, public" },
    });
    await migratePostgresDatabase(drizzle(migrator, { schema }));

    const closed = await new Promise((resolve) => {
      if (staleClosed) {
        resolve(true);
        return;
      }
      const poll = setInterval(() => {
        if (!staleClosed) return;
        clearInterval(poll);
        clearTimeout(timer);
        resolve(true);
      }, 50);
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolve(staleClosed);
      }, 2000);
    });
    assert.equal(closed, true, "the idle session opened before the move was closed");
    const [{ alive }] = await migrator`select count(*)::int as alive from pg_stat_activity where pid = ${stalePid}`;
    assert.equal(Number(alive), 0);

    if (throughPooler) {
      const [after] = await throughPooler`show search_path`;
      assert.match(String(after.search_path), /^field, public$/, `pooler session search_path: ${after.search_path}; ${bouncer.log()}`);
      const [units] = await throughPooler`select count(*)::int as n from units`;
      assert.equal(Number(units.n), 0);
    }

    // No startup search_path. The role and database defaults from 0025 apply.
    const bare = open(url, { connection: { application_name: "field-bare", TimeZone: "UTC" } });
    const [path] = await bare`show search_path`;
    assert.match(String(path.search_path), /^field, public$/);
    const [roleDefault] = await bare`
      select rolconfig from pg_roles where rolname = current_user`;
    assert.ok(roleDefault.rolconfig?.includes("search_path=field, public"), JSON.stringify(roleDefault.rolconfig));
    const [inDatabase] = await bare`
      select s.setconfig
      from pg_db_role_setting s
      join pg_database d on d.oid = s.setdatabase
      where d.datname = current_database() and s.setrole = (select oid from pg_roles where rolname = current_user)`;
    assert.deepEqual(inDatabase.setconfig, ["search_path=field, public"]);
    // Database defaults live in pg_db_role_setting with setrole 0 (pg_database
    // has no datconfig column).
    const [databaseDefault] = await bare`
      select setconfig from pg_db_role_setting
      where setdatabase = (select oid from pg_database where datname = current_database()) and setrole = 0`;
    assert.deepEqual(databaseDefault.setconfig, ["search_path=field, public"]);

    const db = drizzle(bare, { schema });
    await ensureCatalogReferenceData(db);
    const version = await withOrg(db, DEFAULT_ORG_UID, (tx) => lockCatalogForWrite(tx));
    assert.equal(version, 0);

    const legacyDir = mkdtempSync(join(tmpdir(), "field-pooler-legacy-"));
    t.after(() => rmSync(legacyDir, { recursive: true, force: true }));
    const legacyPath = writeLegacyCatalog(join(legacyDir, "catalog.db"));
    const imported = await importLegacyCatalog(db, legacyPath, { dryRun: true, now: new Date("2026-10-11T00:00:00.000Z") });
    assert.equal(imported.verification.ok, true, JSON.stringify(imported.verification.failures));

    assert.deepEqual(await loadLatestImages(db), []);
    assert.equal((await readDataMigrationLedger(db, DEFAULT_ORG_UID)).size, 0);

    const replica = createDocumentReplicator({
      db,
      orgUid: DEFAULT_ORG_UID,
      store: { bucket: "field-test" },
    });
    await replica.refreshStatus();
    const replicaStatus = replica.status();
    assert.equal(replicaStatus.state, "ok", JSON.stringify(replicaStatus));
    assert.equal(replicaStatus.pending, 0);

    const issued = await createInvoiceIssueService({ db, orgUid: DEFAULT_ORG_UID }).issueInvoice({
      jobId: "job-pooler",
      idempotencyKey: "pooler-search-path",
      reference: "2610-03",
      issuedAt: "2026-10-12T02:00:00.000Z",
      issuedBy: "user-1",
      invoice: claimInvoice(),
      details: { milestoneIndex: 0 },
      render: async (number) => Buffer.from(`%PDF-1.4\nTax invoice ${number}\n%%EOF\n`),
    });
    assert.equal(issued.replayed, false);
    assert.match(issued.number, /^INV-/);
    const counters = await withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(sql`select last_value from document_number_counters where document_type = 'invoice'`));
    const counterRows = Array.isArray(counters) ? Array.from(counters) : counters.rows;
    assert.equal(Number(counterRows[0].last_value), 1);

    // The app pool: terminate its idle connection, then the next query runs.
    const pool = retryClosedConnections(postgres(url, {
      max: 2,
      onnotice: () => {},
      connection: { application_name: "field-retry", TimeZone: "UTC", search_path: "field, public" },
    }));
    clients.push(pool);
    await pool`select 1`;
    await bare`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'field-retry' and datname = current_database() and pid <> pg_backend_pid()`;
    const [retried] = await pool`select 1 as n`;
    assert.equal(Number(retried.n), 1);
    // Drizzle uses unsafe() and begin() on this same wrapped pool.
    const [counted] = await queryRows(sql`select count(*)::int as n from units`, drizzle(pool, { schema }));
    assert.equal(Number(counted.n) > 0, true);
    await drizzle(pool, { schema }).transaction(async (tx) => {
      const [one] = await queryRows(sql`select 1 as n`, tx);
      assert.equal(Number(one.n), 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(crashes.map((error) => error?.message || String(error)), []);
  } finally {
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
    bouncer?.stop();
    for (const client of clients) await client.end({ timeout: 5 }).catch(() => {});
    if (server) {
      const reset = postgres(server.url, { max: 1, onnotice: () => {} });
      try {
        await reset.unsafe("alter role current_user reset search_path");
      } finally {
        await reset.end({ timeout: 5 }).catch(() => {});
        await server.stop();
      }
    }
  }
});
