// The quote-row backfill and its verification (#241) on a fixture data
// directory: a job with three versions (one sent, with its PDF in the
// issuance ledger), a job whose sent PDF disagrees with its quote, versions
// with a four-decimal rate and an amount kept as printed, a quote sent before
// the ledger, a sent PDF whose totals cannot be read (checked against its
// markdown), and a sent quote whose GST fell on half a cent.
// Plus reading totals back from a real quote PDF and its markdown.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { sha256Hex } from "../documents/blob-store.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { generateQuotePdfBuffer } from "../quote-artifacts.js";
import { backfillQuoteRows } from "./backfill.js";
import { extractQuoteMarkdownTotals, extractQuotePdfTotals, parseMoneyText } from "./issued-totals.js";
import { createQuoteRowService } from "./quote-rows.js";
import { engineQuote, floatRoundedLineQuote, halfCentGstQuote, sectionedQuote, subCentRateQuote } from "./test-fixtures.js";

const run = promisify(execFile);
const SCRIPT = new URL("../../scripts/backfill-quote-rows.js", import.meta.url).pathname;

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
}

const markdown = ({ subtotal, gst, total }) => `# Quote\n\n## Totals\n\n- Subtotal: $${subtotal}\n- GST: $${gst}\n- Total: $${total}\n\n## Pricing Schedule\n`;

function ledger(records) {
  return { version: 1, issuedVersions: [...new Set(records.map((record) => record.quoteVersion))], records };
}

function ledgerRecord({ id, version, pdf, md, issuedAt }) {
  const root = `issued-documents/v${String(version).padStart(3, "0")}/${id}`;
  return {
    issuanceId: id,
    quoteVersion: version,
    documentType: "quote",
    issuedAt,
    delivery: { messageId: `msg-${id}`, documentType: "quote", to: "customer@example.invalid", subject: "Quote" },
    artifacts: {
      quotePdf: { path: `${root}/quote.pdf`, sha256: sha256Hex(pdf), byteLength: pdf.length, mimeType: "application/pdf" },
      ...(md ? { quoteMarkdown: { path: `${root}/quote.md`, sha256: sha256Hex(Buffer.from(md)), byteLength: Buffer.byteLength(md), mimeType: "text/markdown" } } : {}),
    },
  };
}

async function buildDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), "field-quote-backfill-"));
  const pdfs = {};

  // job-a: v1 sent (ledger), v2 an older draft, v3 the current draft.
  {
    const dir = join(dataDir, "2026-10-01", "job-a");
    const meta = { id: "job-a", title: "Smith — 1 Example Road", quoteNumber: "EQ-2501-01", pipelineStage: "sent", contactName: "Pat Smith" };
    const v1 = sectionedQuote({ version: 1, extra: { quoteSentAt: "2026-10-02T00:00:00.000Z" } });
    const v2 = engineQuote({ version: 2, quoteNumber: "EQ-2501-01" });
    const v3 = sectionedQuote({ version: 3 });
    v3.presentation.organizer.nodes["manual:fee"].manualPrice = 175;
    pdfs.a1 = await generateQuotePdfBuffer({ meta, quote: v1, documentType: "quote" });
    const md = markdown({ subtotal: "1,851.00", gst: "185.10", total: "2,036.10" });
    write(join(dir, "meta.json"), meta);
    write(join(dir, "quote-versions/v001/quote.json"), v1);
    write(join(dir, "quote-versions/v002/quote.json"), v2);
    write(join(dir, "quote.json"), v3);
    write(join(dir, "issued-documents/v001/iss-a1/quote.pdf"), pdfs.a1);
    write(join(dir, "issued-documents/v001/iss-a1/quote.md"), md);
    write(join(dir, "quote-issuance.json"), ledger([ledgerRecord({ id: "iss-a1", version: 1, pdf: pdfs.a1, md, issuedAt: "2026-10-02T00:00:00.000Z" })]));
  }

  // job-b: the PDF in its ledger was rendered from a different quote.
  {
    const dir = join(dataDir, "2026-10-01", "job-b");
    const meta = { id: "job-b", title: "Jones", quoteNumber: "EQ-2501-02", pipelineStage: "sent" };
    const quote = sectionedQuote({ version: 1, quoteNumber: "EQ-2501-02" });
    pdfs.b1 = await generateQuotePdfBuffer({ meta, quote: engineQuote({ quoteNumber: "EQ-2501-02" }), documentType: "quote" });
    write(join(dir, "meta.json"), meta);
    write(join(dir, "quote.json"), quote);
    write(join(dir, "issued-documents/v001/iss-b1/quote.pdf"), pdfs.b1);
    write(join(dir, "quote-issuance.json"), ledger([ledgerRecord({ id: "iss-b1", version: 1, pdf: pdfs.b1, issuedAt: "2026-10-03T00:00:00.000Z" })]));
  }

  // job-c: v1 with a rate of more than two decimals, v2 a draft whose amount
  // the old renderer rounded in floating point (kept as printed).
  {
    const dir = join(dataDir, "2026-10-02", "job-c");
    write(join(dir, "meta.json"), { id: "job-c", title: "Odd", quoteNumber: "EQ-2501-05", pipelineStage: "draft" });
    write(join(dir, "quote-versions/v001/quote.json"), subCentRateQuote());
    write(join(dir, "quote.json"), { ...floatRoundedLineQuote(), version: 2, quoteNumber: "EQ-2501-05" });
  }

  // job-f: sent with GST on exactly half a cent before GST was rounded exactly
  // (#2): $21.15, and the sent copy printed $2.11. Today's renderer prints
  // $2.12, so the sent copy is the delivery's markdown beside a PDF with no
  // readable totals box.
  {
    const dir = join(dataDir, "2026-10-04", "job-f");
    const meta = { id: "job-f", title: "Half cent", quoteNumber: "EQ-2501-08", pipelineStage: "sent" };
    const quote = halfCentGstQuote();
    pdfs.f1 = Buffer.from("%PDF-1.4\nsent before #2\n%%EOF\n");
    const md = markdown({ subtotal: "21.15", gst: "2.11", total: "23.26" });
    write(join(dir, "meta.json"), meta);
    write(join(dir, "quote.json"), quote);
    write(join(dir, "issued-documents/v001/iss-f1/quote.pdf"), pdfs.f1);
    write(join(dir, "issued-documents/v001/iss-f1/quote.md"), md);
    write(join(dir, "quote-issuance.json"), ledger([ledgerRecord({ id: "iss-f1", version: 1, pdf: pdfs.f1, md, issuedAt: "2026-10-05T00:00:00.000Z" })]));
  }

  // job-d: sent and landed before the issuance ledger; only the stored PDF is left.
  {
    const dir = join(dataDir, "2025-12-01", "job-d");
    const meta = { id: "job-d", title: "Legacy", quoteNumber: "EQ-2512-04", pipelineStage: "landed", lastSentQuoteVersion: 1, landedAt: "2025-12-10T00:00:00.000Z" };
    const quote = engineQuote({ quoteNumber: "EQ-2512-04", quoteSentAt: "2025-12-02T00:00:00.000Z" });
    pdfs.d1 = await generateQuotePdfBuffer({ meta, quote, documentType: "quote" });
    write(join(dir, "meta.json"), meta);
    write(join(dir, "quote.json"), quote);
    write(join(dir, "quote.pdf"), pdfs.d1);
  }

  // job-e: sent, but its PDF came from another generator (no readable totals
  // box): checked against the quote markdown stored with the delivery.
  {
    const dir = join(dataDir, "2026-10-03", "job-e");
    const meta = { id: "job-e", title: "Other PDF", quoteNumber: "EQ-2501-07", pipelineStage: "sent" };
    const quote = engineQuote({ quoteNumber: "EQ-2501-07" });
    const pdf = Buffer.from("%PDF-1.4\nnot from PDFKit\n%%EOF\n");
    const md = markdown({ subtotal: "1,533.30", gst: "153.33", total: "1,686.63" });
    write(join(dir, "meta.json"), meta);
    write(join(dir, "quote.json"), quote);
    write(join(dir, "issued-documents/v001/iss-e1/quote.pdf"), pdf);
    write(join(dir, "issued-documents/v001/iss-e1/quote.md"), md);
    write(join(dir, "quote-issuance.json"), ledger([ledgerRecord({ id: "iss-e1", version: 1, pdf, md, issuedAt: "2026-10-04T00:00:00.000Z" })]));
  }
  return { dataDir, pdfs };
}

describe("reading totals back from what was sent", () => {
  test("a real quote PDF's totals box, and its markdown", async () => {
    const pdf = await generateQuotePdfBuffer({ meta: { id: "job-x", title: "X" }, quote: sectionedQuote(), documentType: "quote" });
    assert.deepEqual(extractQuotePdfTotals(pdf), { subtotal: "1851.00", taxTotal: "185.10", total: "2036.10" });
    assert.deepEqual(extractQuoteMarkdownTotals(markdown({ subtotal: "1,851.00", gst: "185.10", total: "2,036.10" })), { subtotal: "1851.00", taxTotal: "185.10", total: "2036.10" });
    assert.equal(extractQuotePdfTotals(Buffer.from("%PDF-1.4\nno streams\n%%EOF\n")), null);
    assert.equal(extractQuoteMarkdownTotals("# Quote\n\nno totals"), null);
  });

  test("money as printed", () => {
    assert.equal(parseMoneyText("$1,234.50"), "1234.50");
    assert.equal(parseMoneyText("-$12.00"), "-12.00");
    assert.equal(parseMoneyText("A$5"), "5.00");
    assert.equal(parseMoneyText("Included"), null);
  });
});

describe("backfillQuoteRows", () => {
  let fixture;
  let t;
  let rows;
  let documents;

  before(async () => {
    fixture = await buildDataDir();
    t = await createTestDb();
    rows = createQuoteRowService({ db: t.db, orgUid: DEFAULT_ORG_UID });
    documents = createIssuedDocumentService({ db: t.db, orgUid: DEFAULT_ORG_UID });
  });
  after(async () => {
    await t.close();
    rmSync(fixture.dataDir, { recursive: true, force: true });
  });

  test("checking the files alone: every version verified, mismatches reported with both numbers", async () => {
    const report = await backfillQuoteRows({ dataDir: fixture.dataDir });
    assert.equal(report.jobs, 6);
    assert.equal(report.versions, 9);
    assert.equal(report.jobsRefused, 1);
    assert.deepEqual(report.byStatus, { accepted: 1, draft: 2, sent: 4, superseded: 2 });
    const byJob = (jobId) => report.entries.filter((entry) => entry.jobId === jobId).map((entry) => [entry.version, entry.status, entry.ok]);
    assert.deepEqual(byJob("job-a"), [[1, "sent", true], [2, "superseded", true], [3, "draft", true]]);
    assert.deepEqual(byJob("job-b"), [[1, "sent", false]]);
    assert.deepEqual(byJob("job-c"), [[1, "superseded", true], [2, "draft", true]]);
    assert.deepEqual(byJob("job-f"), [[1, "sent", true]]);
    assert.deepEqual(byJob("job-d"), [[1, "accepted", true]]);

    const a1 = report.entries.find((entry) => entry.jobId === "job-a" && entry.version === 1);
    assert.deepEqual(a1.rows, { subtotal: "1851.00", taxTotal: "185.10", total: "2036.10" });
    assert.deepEqual(a1.issued.map((copy) => [copy.source, copy.totals?.total]), [["ledger-pdf", "2036.10"]]);
    const d1 = report.entries.find((entry) => entry.jobId === "job-d");
    assert.deepEqual(d1.issued.map((copy) => [copy.source, copy.totals?.total]), [["legacy-stored-version", "1686.63"]]);
    const e1 = report.entries.find((entry) => entry.jobId === "job-e");
    assert.equal(e1.ok, true);
    assert.deepEqual(e1.issued.map((copy) => [copy.source, copy.totals?.total ?? null]), [["ledger-pdf", null], ["ledger-markdown", "1686.63"]]);

    const b = report.mismatches.filter((entry) => entry.jobId === "job-b");
    assert.deepEqual(b.map((entry) => [entry.against, entry.field, entry.rows, entry.shown]), [
      ["ledger-pdf", "subtotal", "1851.00", "1533.30"],
      ["ledger-pdf", "taxTotal", "185.10", "153.33"],
      ["ledger-pdf", "total", "2036.10", "1686.63"],
    ]);
    assert.deepEqual(report.mismatches.filter((entry) => entry.jobId !== "job-b"), [], "only the job whose PDF disagrees");
    const printed = report.warnings.filter((entry) => entry.kind === "line-total-printed");
    assert.deepEqual(printed.map((entry) => [entry.jobId, entry.version, entry.count]), [["job-c", 2, 1]]);
    const f1 = report.entries.find((entry) => entry.jobId === "job-f");
    assert.deepEqual([f1.rows, f1.shown, f1.issued.map((copy) => copy.totals)], [
      { subtotal: "21.15", taxTotal: "2.11", total: "23.26" },
      { subtotal: "21.15", taxTotal: "2.12", total: "23.27" },
      [null, { subtotal: "21.15", taxTotal: "2.11", total: "23.26" }],
    ]);
    assert.deepEqual(report.warnings.filter((entry) => entry.kind === "tax-total-printed").map((entry) => entry.jobId), ["job-f"]);
    assert.deepEqual(report.numberCollisions, []);
  });

  test("a run writes the jobs that verify, links issued documents, and writes nothing for the rest", async () => {
    const { document } = await documents.recordIssuedDocument({
      jobId: "job-a", documentType: "quote", number: "EQ-2501-01 v1", quoteVersion: 1,
      pdfBytes: fixture.pdfs.a1, issuedAt: "2026-10-02T00:00:00.000Z", source: "ledger-backfill",
    });
    const report = await backfillQuoteRows({ dataDir: fixture.dataDir, service: rows, issuedDocuments: documents });
    assert.deepEqual(report.actions, { created: 8, refused: 1 });
    assert.deepEqual((await rows.listJobQuotes("job-a")).map((quote) => [quote.version, quote.status, quote.total]), [
      [1, "sent", "2036.10"],
      [2, "superseded", "1686.63"],
      [3, "draft", "2063.60"],
    ]);
    const a1 = await rows.getQuoteVersion("job-a", 1);
    assert.equal(a1.quote.issuedDocumentUid, document.uid);
    assert.equal(a1.quote.sentAt, "2026-10-02T00:00:00.000Z");
    assert.deepEqual(report.entries.find((entry) => entry.jobId === "job-a" && entry.version === 1).issued.map((copy) => copy.source), ["issued-document"], "the same bytes are checked once");
    assert.deepEqual(await rows.listJobQuotes("job-b"), []);
    assert.deepEqual((await rows.listJobQuotes("job-c")).map((quote) => [quote.version, quote.status, quote.total]), [[1, "superseded", "110.01"], [2, "draft", "3.31"]]);
    assert.deepEqual((await rows.listJobQuotes("job-f")).map((quote) => [quote.taxTotal, quote.taxTotalSource]), [["2.11", "printed"]]);
    const [d1] = await rows.listJobQuotes("job-d");
    assert.deepEqual([d1.status, d1.sentAt, d1.acceptedAt], ["accepted", "2025-12-02T00:00:00.000Z", "2025-12-10T00:00:00.000Z"]);

    const again = await backfillQuoteRows({ dataDir: fixture.dataDir, service: rows, issuedDocuments: documents });
    assert.deepEqual(again.actions, { unchanged: 8, refused: 1 }, "a second run writes nothing new");
    const dry = await backfillQuoteRows({ dataDir: fixture.dataDir, service: rows, issuedDocuments: documents, dryRun: true });
    assert.deepEqual(dry.actions, { unchanged: 8, refused: 1 });
  });

  test("the script: --dry-run without a database checks the files and exits 2 on mismatches", async () => {
    const env = { PATH: process.env.PATH, HOME: fixture.dataDir, FIELD_CONFIG: join(fixture.dataDir, "no-config.json") };
    const result = await run(process.execPath, [SCRIPT, "--dry-run", "--json", "--data-dir", fixture.dataDir], { env }).catch((error) => error);
    assert.equal(result.code, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.jobsRefused, 1);
    assert.equal(report.mismatches.length > 0, true);
    const plain = await run(process.execPath, [SCRIPT, "--data-dir", fixture.dataDir], { env }).catch((error) => error);
    assert.equal(plain.code, 1, "a real run needs a database");
    assert.match(plain.stderr, /no database configured/);
  });
});
