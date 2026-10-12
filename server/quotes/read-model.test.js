// Quote reads from rows (#10): the schedule and totals printed from rows
// equal the renderer's, the quote PDF rendered from rows is byte-identical to
// the PDF rendered from the files, the database is read when its rows are
// current, and FIELD_QUOTE_READS=files switches back to the files.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { getCustomerPresentationFinancials, getCustomerScheduleItems } from "../quote-presentation.js";
import { generateQuotePdfBuffer } from "../quote-artifacts.js";
import { mapQuoteArtifact } from "./from-artifact.js";
import { quoteSourceDigest } from "./job-quotes.js";
import { createQuoteRowService } from "./quote-rows.js";
import { loadQuoteRows, quoteReadsMode, quoteReadsStatus, quoteRowsFromArtifact, quoteRowsVersionTag } from "./read-model.js";
import { comparePrintedSchedule, financialsFromRows, scheduleFromRows } from "./schedule.js";
import * as fixtures from "./test-fixtures.js";

const QUOTES = ["sectionedQuote", "engineQuote", "listedExcludedOverrideQuote", "fixedLotQuote", "subCentRateQuote", "perLineGstQuote", "floatRoundedLineQuote", "halfCentGstQuote", "displayQuote"];
const META = { ...fixtures.FIXTURE_META };

function withReads(mode, fn) {
  const previous = process.env.FIELD_QUOTE_READS;
  if (mode) process.env.FIELD_QUOTE_READS = mode;
  else delete process.env.FIELD_QUOTE_READS;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.FIELD_QUOTE_READS;
    else process.env.FIELD_QUOTE_READS = previous;
  });
}

describe("the printed schedule from rows", () => {
  for (const name of QUOTES) {
    test(`${name}: rows print what the files print, totals and cost included`, () => {
      const quote = fixtures[name]();
      const mapped = mapQuoteArtifact({ quote, meta: META });
      assert.equal(mapped.printable, true, JSON.stringify(mapped.printDifferences));
      assert.deepEqual(comparePrintedSchedule(scheduleFromRows(mapped), getCustomerScheduleItems(quote)), []);
      const files = getCustomerPresentationFinancials(quote);
      const rows = financialsFromRows(mapped);
      assert.deepEqual(rows, { charge: files.charge, cost: files.cost, subtotal: files.subtotal, gst: files.gst, total: files.total });
    });
  }

  test("collapsed rows hide what is under them; hidden and blank amounts, styles, excluded rows and notes are kept", () => {
    const mapped = mapQuoteArtifact({ quote: fixtures.displayQuote(), meta: META });
    const printed = scheduleFromRows(mapped).map((item) => `${"-".repeat(item.depth)}${item.label}${item.amountVisible ? "" : " (hidden)"}${item.amountBlank ? " (blank)" : ""}${item.excludedFromPrice ? " (excluded)" : ""}${item.rowStyle ? ` [${item.rowStyle}]` : ""}`);
    assert.deepEqual(printed, [
      "Site preparation [bold]",
      "Delivery (hidden)",
      "Paving (hidden)",
      "-Paver kit",
      "--Pavers",
      "--Bedding sand [normal]",
      "--Sealer (hidden) (excluded)",
      "-Edging (hidden) (blank)",
      "--Concrete edge",
      "Cleanup",
      "-Sweep and remove [branded]",
    ]);
    const byName = Object.fromEntries(mapped.lines.map((line) => [line.name, line]));
    assert.equal(byName["Strip topsoil"].notes, "Check depth on site");
    assert.equal(byName.Sealer.isExcluded, true);
    assert.equal(mapped.sections.find((section) => section.title === "Site preparation").isCollapsed, true);
    assert.equal(byName.Cleanup.rowKind, "group", "a group with a cost override is one line, printed as a group");
    assert.deepEqual([byName.Cleanup.lineCost, byName.Cleanup.lineTotal], ["50.00", "120.00"]);
  });

  test("a changed renderer output is caught as a print difference", () => {
    const quote = fixtures.sectionedQuote();
    const mapped = mapQuoteArtifact({ quote, meta: META });
    const items = scheduleFromRows(mapped);
    items[1] = { ...items[1], label: "Something else" };
    assert.equal(comparePrintedSchedule(items, getCustomerScheduleItems(quote)).length, 1);
  });
});

describe("quote PDFs from rows", () => {
  const creationDate = new Date("2026-10-12T00:00:00.000Z");
  for (const name of QUOTES) {
    test(`${name}: the PDF printed from rows is byte-identical to the one printed from the files`, async () => {
      const quote = fixtures[name]();
      const meta = { ...META, quoteNumber: quote.quoteNumber };
      const fromRows = await withReads(null, () => generateQuotePdfBuffer({ meta, quote, documentType: "quote", creationDate }));
      const fromFiles = await withReads("files", () => generateQuotePdfBuffer({ meta, quote, documentType: "quote", creationDate }));
      assert.ok(fromRows.equals(fromFiles));
    });
  }
});

describe("loadQuoteRows", () => {
  let t;
  let service;

  before(async () => {
    t = await createTestDb();
    service = createQuoteRowService({ db: t.db, orgUid: DEFAULT_ORG_UID });
  });
  after(() => t.close());

  test("reads the database when its rows are current, the mapping when they are not, and the files when told to", async () => {
    const quote = fixtures.displayQuote();
    const meta = { ...META, id: "job-read" };
    const mapped = mapQuoteArtifact({ quote, meta });
    const before = quoteReadsStatus();

    const unwritten = await loadQuoteRows({ quote, meta, service });
    assert.equal(unwritten.source, "mapped");
    assert.equal(unwritten.versionTag, null);

    const written = await service.writeVersion({ jobId: "job-read", version: 1, mapped, sourceDigest: quoteSourceDigest({ quote, meta }) });
    const fromDb = await loadQuoteRows({ quote, meta, service });
    assert.equal(fromDb.source, "database");
    assert.equal(fromDb.versionTag, quoteRowsVersionTag(written.quote));
    assert.equal(fromDb.versionTag, '"q1-1"');
    assert.deepEqual(comparePrintedSchedule(fromDb.items, getCustomerScheduleItems(quote)), [], "the stored rows print what the files print");
    const files = getCustomerPresentationFinancials(quote);
    assert.deepEqual(fromDb.financials, { charge: files.charge, cost: files.cost, subtotal: files.subtotal, gst: files.gst, total: files.total });

    // The files moved on: the stored rows are not current; the mapping is read.
    const edited = fixtures.displayQuote();
    edited.presentation.organizer.nodes["manual:between"].sellRate = 100;
    const stale = await loadQuoteRows({ quote: edited, meta, service });
    assert.equal(stale.source, "mapped");
    assert.equal(stale.financials.subtotal, files.subtotal + 10);

    const files2 = await withReads("files", () => loadQuoteRows({ quote, meta, service }));
    assert.equal(files2.source, "files");
    assert.equal(quoteReadsMode({ FIELD_QUOTE_READS: "files" }), "files");
    assert.equal(quoteReadsMode({}), "rows");

    const after = quoteReadsStatus();
    assert.equal(after.database, before.database + 1);
    assert.equal(after.mapped, before.mapped + 2);
    assert.equal(after.files, before.files + 1);
  });

  test("a database that fails is read around, and the fallback is recorded", async () => {
    const quote = fixtures.engineQuote();
    const broken = { getQuoteVersion: async () => { throw new Error("database is down"); } };
    const view = await loadQuoteRows({ quote, meta: { ...META, id: "job-broken" }, service: broken });
    assert.equal(view.source, "mapped");
    assert.match(quoteReadsStatus().lastFallback.reason, /database is down/);
  });

  test("without a database, quoteRowsFromArtifact maps the files", () => {
    const view = quoteRowsFromArtifact({ quote: fixtures.sectionedQuote(), meta: META });
    assert.equal(view.source, "mapped");
    assert.equal(view.financials.total, 2036.1);
  });
});
