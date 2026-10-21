// The PDF header (customer report, 2026-10-14): a long business name printed
// over the document title at the top right. The name now shrinks to fit left
// of the title, and only a name too long even then wraps.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import PDFDocument from "pdfkit";
import { generateQuotePdfBuffer } from "./quote-artifacts.js";
import { invoiceQuote, landedMeta } from "./invoices/test-fixtures.js";

/** Each text run on the first page with where it starts and its font size. */
function firstPageRuns(bytes) {
  const source = bytes.toString("latin1");
  const start = source.indexOf("stream\n") + "stream\n".length;
  const content = inflateSync(bytes.subarray(start, source.indexOf("endstream", start))).toString("latin1");
  return [...content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm\s+\/F\d+ ([\d.]+) Tf\s+\[((?:[^\]\\]|\\.)*)\]\s*TJ/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    size: Number(match[3]),
    text: [...match[4].matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => Buffer.from(hex[1], "hex").toString("latin1")).join(""),
  }));
}

async function renderQuote(legalName) {
  const meta = { ...landedMeta({ id: "job-header", number: "2610-05" }), status: "draft", landedAt: null };
  const quote = {
    ...invoiceQuote(meta, { version: 2, rows: [["Retaining wall", 3000]] }),
    quoteCatalog: { id: "sample-default", currency: "AUD", gstRate: 0.1, businessProfile: { legalName, abn: "11 111 111 111", address: "1 Example Road, Exampleton SA 5000", phone: "08 0000 0000", email: "accounts@example.invalid" } },
  };
  return firstPageRuns(await generateQuotePdfBuffer({ meta, quote, documentType: "quote" }));
}

const measure = new PDFDocument({ autoFirstPage: false }).font("Helvetica-Bold");
const right = (run) => run.x + measure.fontSize(run.size).widthOfString(run.text);

test("a business name of usual length keeps its size and clears the title", async () => {
  const runs = await renderQuote("Sample Earthworks Pty Ltd");
  const name = runs.find((run) => run.text === "Sample Earthworks Pty Ltd");
  const title = runs.find((run) => run.text === "Quote");
  assert.ok(name && title, runs.map((run) => run.text).join(" | "));
  assert.equal(name.size, 22);
  assert.ok(right(name) < title.x);
});

test("a long business name is set smaller so it never runs under the title", async () => {
  const runs = await renderQuote("Sample Earthworks and Landscaping Services Pty Ltd");
  const name = runs.find((run) => run.text === "Sample Earthworks and Landscaping Services Pty Ltd");
  const title = runs.find((run) => run.text === "Quote");
  assert.ok(name && title, runs.map((run) => run.text).join(" | "));
  assert.ok(name.size < 22 && name.size >= 14);
  assert.ok(right(name) + 16 <= title.x + 0.5, `name ends at ${right(name)}, title starts at ${title.x}`);
});

test("a name too long for one line wraps inside the left column, above the ABN", async () => {
  const runs = await renderQuote("Sample Earthworks Landscaping Civil and Excavation Services of South Australia Pty Ltd");
  const abn = runs.find((run) => run.text.startsWith("ABN"));
  const nameLines = runs.filter((run) => run.x === 50 && run.size === 14);
  assert.ok(nameLines.length >= 2, runs.map((run) => run.text).join(" | "));
  for (const line of nameLines) {
    assert.ok(right(line) < 300, `"${line.text}" ends at ${right(line)}`);
    assert.ok(line.y > abn.y, `"${line.text}" is above the ABN`);
  }
});
