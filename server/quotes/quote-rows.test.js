// The quote row tables and service (#6): writing a version in one
// transaction, replacing a draft, marking it sent, the database refusing any
// change to a sent quote, row-level security between organisations, and the
// 0010 rollback.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite, types } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createTestDb, MIGRATIONS_FOLDER, queryRows, schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { mapQuoteArtifact } from "./from-artifact.js";
import { createQuoteRowService, isFrozenQuote } from "./quote-rows.js";
import { FIXTURE_META, HALF_CENT_PRINTED, displayQuote, engineQuote, floatRoundedLineQuote, halfCentGstQuote, sectionedQuote } from "./test-fixtures.js";
import { isQuoteUid } from "./uid.js";

const ORG_A = DEFAULT_ORG_UID;
const ORG_B = "org_01TESTSECONDORGANISATION0";
const ROLLBACK_0010 = fileURLToPath(new URL("../db/rollback/0010_quote_rows.down.sql", import.meta.url));
const ROLLBACK_0011 = fileURLToPath(new URL("../db/rollback/0011_quote_row_display.down.sql", import.meta.url));

function rejects(promise, pattern) {
  return assert.rejects(promise, (error) => {
    let message = "";
    for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
    assert.match(message, pattern);
    return true;
  });
}

const asOrg = (db, orgUid, query) => withOrg(db, orgUid, (tx) => queryRows(query, tx));

describe("quote rows", () => {
  let t;
  let a;
  let b;
  let documents;

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    a = createQuoteRowService({ db: t.db, orgUid: ORG_A, now: () => new Date("2026-10-12T01:00:00.000Z") });
    b = createQuoteRowService({ db: t.db, orgUid: ORG_B });
    documents = createIssuedDocumentService({ db: t.db, orgUid: ORG_A });
  });
  after(() => t.close());

  test("a version is written in one go: header, sections, lines, links and totals from quoteTotals", async () => {
    const mapped = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META });
    const { action, quote } = await a.writeVersion({ jobId: "job-1", version: 1, mapped, sourceDigest: "d1", actor: "test" });
    assert.equal(action, "created");
    assert.ok(isQuoteUid(quote.uid), quote.uid);
    assert.deepEqual([quote.number, quote.version, quote.status, quote.subtotal, quote.taxTotal, quote.total], ["EQ-2501-01", 1, "draft", "1851.00", "185.10", "2036.10"]);
    assert.equal(quote.customer.name, "Pat Smith");
    const read = await a.getQuoteVersion("job-1", 1);
    assert.equal(read.sections.length, 1);
    assert.equal(read.lines.length, mapped.lines.length);
    assert.ok(read.lines.every((line) => /^qln_[0-9A-HJKMNP-TV-Z]{26}$/.test(line.uid)));
    assert.match(read.sections[0].uid, /^qsc_/);
    const kit = read.lines.find((line) => line.name === "Wall bay kit");
    const post = read.lines.find((line) => line.name === "Steel post");
    assert.equal(post.parentLineUid, kit.uid);
    assert.equal(post.lineType, "component");
    assert.equal(kit.sectionUid, read.sections[0].uid);
    assert.deepEqual([kit.quantity, kit.unitSell, kit.lineTotal, kit.lineTotalSource, kit.taxRate], ["2.0000", "50.0000", "100.00", "computed", "10.000"]);
    assert.equal(read.lines.find((line) => line.name === "Sleepers, 200 mm").priceUid, "41");
  });

  test("the same source is left alone; a changed draft is replaced in place", async () => {
    const mapped = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META });
    const again = await a.writeVersion({ jobId: "job-1", version: 1, mapped, sourceDigest: "d1" });
    assert.equal(again.action, "unchanged");
    const edited = sectionedQuote();
    edited.presentation.organizer.nodes["manual:fee"].manualPrice = 200;
    const before = await a.getQuoteVersion("job-1", 1);
    const replaced = await a.writeVersion({ jobId: "job-1", version: 1, mapped: mapQuoteArtifact({ quote: edited, meta: FIXTURE_META }), sourceDigest: "d2" });
    assert.equal(replaced.action, "replaced");
    assert.equal(replaced.quote.uid, before.quote.uid, "a version keeps its uid");
    assert.equal(replaced.quote.versionLock, before.quote.versionLock + 1);
    assert.equal(replaced.quote.subtotal, "1901.00");
    const after = await a.getQuoteVersion("job-1", 1);
    assert.equal(after.lines.find((line) => line.name === "Council fee").unitSell, "200.0000");
    assert.ok(after.lines.every((line) => !before.lines.some((old) => old.uid === line.uid)), "lines are rewritten, not merged");
  });

  test("marking sent links the issued document; then the database refuses any change to the sent quote", async () => {
    const { document } = await documents.recordIssuedDocument({
      jobId: "job-1", documentType: "quote", number: "EQ-2501-01 v1", quoteVersion: 1,
      pdfBytes: Buffer.from("%PDF-1.4\nsent\n%%EOF\n"), issuedAt: "2026-10-12T02:00:00.000Z", source: "live",
    });
    const sent = await a.markSent({ jobId: "job-1", version: 1, sentAt: "2026-10-12T02:00:00.000Z", issuedDocumentUid: document.uid });
    assert.deepEqual([sent.status, sent.sentAt, sent.issuedDocumentUid], ["sent", "2026-10-12T02:00:00.000Z", document.uid]);
    assert.ok(isFrozenQuote({ status: sent.status, sentAt: sent.sentAt }));
    const { quote, lines, sections } = await a.getQuoteVersion("job-1", 1);
    const line = lines[0];

    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quote_lines set unit_sell = 1 where uid = ${line.uid}`)), /was sent: update of its quote_lines refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`delete from quote_lines where uid = ${line.uid}`)), /was sent: delete of its quote_lines refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quote_sections set title = 'x' where uid = ${sections[0].uid}`)), /was sent: update of its quote_sections refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quote_lines (uid, quote_uid, sort_order, line_type, name, quantity, unit_code, tax_code, tax_rate, line_total, created_at)
      values ('qln_01JZZZZZZZZZZZZZZZZZZZZZZZ', ${quote.uid}, 99, 'custom', 'Sneaked in', 1, 'lot', 'GST', 10, 0, now())`)), /was sent: insert of its quote_lines refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quotes set subtotal = 1, total = subtotal + tax_total - 1850 where uid = ${quote.uid}`)), /was sent: change refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quotes set customer = '{}' where uid = ${quote.uid}`)), /was sent: change refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quotes set status = 'draft' where uid = ${quote.uid}`)), /was sent: change refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quotes set sent_at = now() where uid = ${quote.uid}`)), /was sent: change refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quotes set issued_document_uid = null where uid = ${quote.uid}`)), /was sent: change refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`delete from quotes where uid = ${quote.uid}`)), /was sent: delete refused/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`truncate quote_lines`)), /permission denied/);
    // The table owner is refused too, by the trigger.
    await rejects(t.db.execute(sql`truncate quote_lines`), /cannot be truncated/);
    await rejects(t.db.execute(sql`truncate quotes cascade`), /cannot be truncated/);
    // Its status may move on.
    await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quotes set status = 'accepted', accepted_at = now() where uid = ${quote.uid}`));
    const [row] = await asOrg(t.db, ORG_A, sql`select status, subtotal from quotes where uid = ${quote.uid}`);
    assert.deepEqual(row, { status: "accepted", subtotal: "1901.00" });

    // The service never rewrites it: a different source is kept and reported.
    const edited = sectionedQuote();
    edited.presentation.organizer.nodes["manual:fee"].manualPrice = 999;
    const kept = await a.writeVersion({ jobId: "job-1", version: 1, mapped: mapQuoteArtifact({ quote: edited, meta: FIXTURE_META }), status: "accepted", sourceDigest: "d3" });
    assert.equal(kept.action, "frozen-kept");
    assert.equal(kept.differs, true);
    assert.equal((await a.getQuoteVersion("job-1", 1)).lines.find((entry) => entry.name === "Council fee").unitSell, "200.0000");
    assert.deepEqual(await a.deleteDraftVersion("job-1", 1), { deleted: false, frozen: true });
    // Files that changed around it (a send writes its time into quote.json)
    // but still map to the same rows: nothing to report, the digest follows.
    const same = sectionedQuote({ extra: { quoteSentAt: "2026-10-12T02:00:00.000Z" } });
    same.presentation.organizer.nodes["manual:fee"].manualPrice = 200;
    const followed = await a.writeVersion({ jobId: "job-1", version: 1, mapped: mapQuoteArtifact({ quote: same, meta: FIXTURE_META }), status: "accepted", sourceDigest: "d4" });
    assert.deepEqual([followed.action, followed.quote.sourceDigest, followed.quote.status], ["unchanged", "d4", "accepted"]);
  });

  test("a version first seen as sent is written as a draft, then frozen, in one transaction", async () => {
    const mapped = mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META });
    const { action, quote } = await a.writeVersion({ jobId: "job-2", version: 1, mapped, status: "sent", sentAt: "2026-10-01T00:00:00.000Z", sourceDigest: "e1" });
    assert.equal(action, "created");
    assert.deepEqual([quote.status, quote.sentAt, quote.total], ["sent", "2026-10-01T00:00:00.000Z", "1686.63"]);
    // A newer version supersedes it; its rows stay.
    const superseded = await a.writeVersion({ jobId: "job-2", version: 1, mapped, status: "superseded", sentAt: "2026-10-01T00:00:00.000Z", sourceDigest: "e1" });
    assert.deepEqual([superseded.action, superseded.quote.status], ["status-updated", "superseded"]);
    assert.ok(isFrozenQuote({ status: "superseded", sentAt: superseded.quote.sentAt }), "a sent quote stays frozen when superseded");
  });

  test("a draft version that no longer exists is removed with its lines", async () => {
    const mapped = mapQuoteArtifact({ quote: engineQuote({ version: 2 }), meta: FIXTURE_META });
    await a.writeVersion({ jobId: "job-2", version: 2, mapped, sourceDigest: "e2" });
    assert.deepEqual(await a.deleteDraftVersion("job-2", 2), { deleted: true });
    assert.equal(await a.getQuoteVersion("job-2", 2), null);
    const [orphans] = await asOrg(t.db, ORG_A, sql`select count(*)::int as n from quote_lines l where not exists (select 1 from quotes q where q.uid = l.quote_uid)`);
    assert.equal(orphans.n, 0);
  });

  test("the service refuses bad input before writing", async () => {
    const mapped = mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META });
    await rejects(a.writeVersion({ jobId: "", version: 1, mapped }), /job id/);
    await rejects(a.writeVersion({ jobId: "job-3", version: 0, mapped }), /positive version/);
    await rejects(a.writeVersion({ jobId: "job-3", version: 1, mapped, status: "lost" }), /unknown quote status/);
    await rejects(a.markSent({ jobId: "job-3", version: 1, sentAt: "2026-10-01T00:00:00.000Z" }), /no quote rows/);
  });

  test("row-level security: another organisation sees nothing and cannot attach rows to these quotes", async () => {
    assert.deepEqual(await b.listJobQuotes("job-1"), []);
    assert.equal(await b.getQuoteVersion("job-1", 1), null);
    const [visible] = await asOrg(t.db, ORG_B, sql`select (select count(*) from quotes)::int as quotes, (select count(*) from quote_lines)::int as lines, (select count(*) from quote_sections)::int as sections`);
    assert.deepEqual(visible, { quotes: 0, lines: 0, sections: 0 });
    const [{ uid }] = await asOrg(t.db, ORG_A, sql`select uid from quotes where job_id = 'job-1'`);
    // A line in org B pointing at org A's quote: the composite key has no such quote in B.
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`insert into quote_lines (uid, quote_uid, sort_order, line_type, name, quantity, unit_code, tax_code, tax_rate, line_total, created_at)
      values ('qln_01JYYYYYYYYYYYYYYYYYYYYYYY', ${uid}, 0, 'custom', 'Cross', 1, 'lot', 'GST', 10, 0, now())`)), /quote_lines_quote_fk|foreign key/);
    // Writing a row as organisation A from B's transaction is refused by the policy.
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`insert into quotes (uid, org_uid, job_id, number, version, subtotal, tax_total, total, created_at, updated_at)
      values ('qte_01JXXXXXXXXXXXXXXXXXXXXXXX', ${ORG_A}, 'job-x', 'EQ-X', 1, 0, 0, 0, now(), now())`)), /row-level security/);
    await rejects(withOrg(t.db, ORG_B, (tx) => tx.execute(sql`update quotes set title = 'x'`)).then(async () => {
      const [row] = await asOrg(t.db, ORG_A, sql`select title from quotes where job_id = 'job-1'`);
      if (row.title === "x") throw new Error("updated across organisations");
      throw new Error("no rows touched");
    }), /no rows touched/);
    // The same job and version may exist in another organisation.
    const mapped = mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META });
    assert.equal((await b.writeVersion({ jobId: "job-1", version: 1, mapped, sourceDigest: "b1" })).action, "created");
    assert.equal((await a.listJobQuotes("job-1")).length, 1);
  });

  test("printed line totals and GST as printed are stored with their reasons; anything else is refused", async () => {
    const float = mapQuoteArtifact({ quote: floatRoundedLineQuote(), meta: FIXTURE_META });
    const { quote } = await a.writeVersion({ jobId: "job-p", version: 1, mapped: float, sourceDigest: "p1" });
    assert.deepEqual([quote.subtotal, quote.taxTotal, quote.total, quote.taxTotalSource], ["3.01", "0.30", "3.31", "computed"]);
    const [line] = (await a.getQuoteVersion("job-p", 1)).lines;
    assert.deepEqual([line.unitSell, line.lineTotal, line.lineTotalSource], ["1.0050", "3.01", "printed"]);
    assert.match(line.lineTotalReason, /printed 3\.01/);

    const half = mapQuoteArtifact({ quote: halfCentGstQuote(), meta: FIXTURE_META, printed: HALF_CENT_PRINTED });
    const written = await a.writeVersion({ jobId: "job-p", version: 2, mapped: half, sourceDigest: "p2" });
    assert.deepEqual([written.quote.subtotal, written.quote.taxTotal, written.quote.total, written.quote.taxTotalSource], ["21.15", "2.11", "23.26", "printed"]);
    assert.match(written.quote.taxTotalReason, /exactly half a cent/);

    // GST as printed only in the half-cent case, a cent apart.
    const forged = mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META });
    forged.header.taxTotalSource = "printed";
    forged.header.taxTotalReason = "because";
    forged.totals.taxTotal = "150.00";
    await rejects(a.writeVersion({ jobId: "job-p", version: 3, mapped: forged }), /must be the half-cent case/);
    // A computed line whose total is not qty x rate.
    const wrong = mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META });
    wrong.lines[0].lineTotal = "1199.00";
    await rejects(a.writeVersion({ jobId: "job-p", version: 3, mapped: wrong }), /mark it printed/);
    assert.equal(await a.getQuoteVersion("job-p", 3), null, "nothing was written");
    // The database checks it too.
    const [{ uid }] = await asOrg(t.db, ORG_A, sql`select uid from quotes where job_id = 'job-p' and version = 1`);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quote_lines (uid, quote_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
      values ('qln_01JVVVVVVVVVVVVVVVVVVVVVVV', ${uid}, 5, 'custom', 'Wrong', 3, 'm', 1.005, 'GST', 10, 3.01, now())`)), /quote_lines_line_total_check/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quote_lines (uid, quote_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, line_total_source, created_at)
      values ('qln_01JVVVVVVVVVVVVVVVVVVVVVVV', ${uid}, 5, 'custom', 'No reason', 3, 'm', 1.005, 'GST', 10, 3.01, 'printed', now())`)), /quote_lines_line_total_check/);
    await withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quote_lines (uid, quote_uid, sort_order, line_type, name, quantity, unit_code, unit_sell, tax_code, tax_rate, line_total, created_at)
      values ('qln_01JVVVVVVVVVVVVVVVVVVVVVVV', ${uid}, 5, 'custom', 'Right', 3, 'm', 1.005, 'GST', 10, 3.02, now())`));
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`update quotes set tax_total_source = 'printed' where uid = ${uid}`)), /quotes_tax_total_source_check/);
  });

  test("a version sent before the display columns keeps its rows and is not marked current for printing", async () => {
    const full = mapQuoteArtifact({ quote: displayQuote(), meta: FIXTURE_META });
    // As part one stored it: the money, none of the display.
    const bare = {
      ...full,
      sections: full.sections.map(({ isExcluded, amountBlank, isCollapsed, rowStyle, notes, ...rest }) => rest),
      lines: full.lines.map(({ isExcluded, showAmount, amountBlank, isCollapsed, rowStyle, notes, rowKind, displayUnitSell, lineCost, ...rest }) => rest),
    };
    await a.writeVersion({ jobId: "job-v1", version: 1, mapped: bare, status: "sent", sentAt: "2026-10-01T00:00:00.000Z", sourceDigest: "v1" });
    const again = await a.writeVersion({ jobId: "job-v1", version: 1, mapped: full, status: "sent", sentAt: "2026-10-01T00:00:00.000Z", sourceDigest: "v2" });
    assert.equal(again.action, "unchanged");
    assert.equal(again.displayStale, true);
    assert.equal(again.quote.sourceDigest, "v1", "the digest is not moved, so nothing prints from these rows");
  });

  test("the table checks hold: totals add up, enums, uids", async () => {
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quotes (uid, job_id, number, version, subtotal, tax_total, total, created_at, updated_at)
      values ('qte_01JWWWWWWWWWWWWWWWWWWWWWWW', 'job-c', 'EQ-C', 1, 10, 1, 12, now(), now())`)), /quotes_total_check/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quotes (uid, job_id, number, version, status, subtotal, tax_total, total, created_at, updated_at)
      values ('qte_01JWWWWWWWWWWWWWWWWWWWWWWW', 'job-c', 'EQ-C', 1, 'lost', 10, 1, 11, now(), now())`)), /quotes_status_check/);
    await rejects(withOrg(t.db, ORG_A, (tx) => tx.execute(sql`insert into quotes (uid, job_id, number, version, subtotal, tax_total, total, created_at, updated_at)
      values ('quote-1', 'job-c', 'EQ-C', 1, 10, 1, 11, now(), now())`)), /quotes_uid_check/);
  });
});

function migrationsUpTo(idx) {
  const dir = mkdtempSync(join(tmpdir(), "field-quote-rows-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  for (const entry of journal.entries.filter((e) => e.idx > idx)) rmSync(join(dir, `${entry.tag}.sql`));
  journal.entries = journal.entries.filter((entry) => entry.idx <= idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function schemaShape(db) {
  const rows = await Promise.all([
    queryRows(sql`select table_name || '.' || column_name || ' ' || data_type as x from information_schema.columns where table_schema = 'public'`, db),
    queryRows(sql`select 'index ' || indexname as x from pg_indexes where schemaname = 'public'`, db),
    queryRows(sql`select 'trigger ' || tgname as x from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal`, db),
    queryRows(sql`select 'function ' || p.proname as x from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`, db),
    queryRows(sql`select 'policy ' || policyname as x from pg_policies where schemaname = 'public'`, db),
  ]);
  return rows.flat().map((row) => row.x).sort();
}

describe("migrations 0011 and 0010 roll back", () => {
  test("0011's rollback returns the 0010 shape with the rows; 0010's the 0009 shape; both apply again", async () => {
    const dir0009 = migrationsUpTo(9);
    const dir0010 = migrationsUpTo(10);
    // Up to 0011: later migrations (0012 onwards) roll back before it.
    const dir0011 = migrationsUpTo(11);
    const client = new PGlite({ parsers: { [types.NUMERIC]: (v) => v, [types.INT8]: (v) => v } });
    const reference9 = new PGlite();
    const reference10 = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: dir0011 });
      const service = createQuoteRowService({ db, orgUid: ORG_A });
      await service.writeVersion({ jobId: "job-r", version: 1, mapped: mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META }), status: "sent", sentAt: "2026-10-01T00:00:00.000Z" });
      // 0011 first: the display columns go, the rows and their money stay.
      await client.exec(readFileSync(ROLLBACK_0011, "utf8"));
      await migrate(drizzle(reference10, { schema }), { migrationsFolder: dir0010 });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference10, { schema })));
      const [kept] = await asOrg(db, ORG_A, sql`select total from quotes where job_id = 'job-r'`);
      assert.equal(kept.total, "1686.63");
      // Then 0010.
      await client.exec(readFileSync(ROLLBACK_0010, "utf8"));
      await migrate(drizzle(reference9, { schema }), { migrationsFolder: dir0009 });
      assert.deepEqual(await schemaShape(db), await schemaShape(drizzle(reference9, { schema })));
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const [count] = await asOrg(db, ORG_A, sql`select count(*)::int as n from quotes`);
      assert.equal(count.n, 0, "0010 re-applies empty; the backfill fills it again");
    } finally {
      await client.close();
      await reference9.close();
      await reference10.close();
      rmSync(dir0009, { recursive: true, force: true });
      rmSync(dir0010, { recursive: true, force: true });
      rmSync(dir0011, { recursive: true, force: true });
    }
  });
});
