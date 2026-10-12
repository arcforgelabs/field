import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findAnyIssuedDocument,
  findIssuedQuoteVersion,
  hasIssuedQuoteVersion,
  readIssuedQuoteArtifact,
  readQuoteIssuanceLedger,
  recordIssuedQuoteDocuments,
} from "./quote-issuance.js";

test("issuance records retain exact bytes and keep document types separate", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-issuance-"));
  try {
    const quoteRecord = await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 1,
      documentType: "quote",
      quoteMarkdown: "issued quote bytes",
      reportMarkdown: "issued report bytes",
      quotePdf: Buffer.from("issued quote pdf"),
      deliveryResult: { documentType: "quote", messageId: "msg-quote" },
    });
    await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 1,
      documentType: "invoice",
      quoteMarkdown: "invoice body bytes",
      quotePdf: Buffer.from("issued invoice pdf"),
      deliveryResult: { documentType: "invoice", messageId: "msg-invoice" },
    });

    const ledger = await readQuoteIssuanceLedger(jobDir);
    const selectedQuote = findIssuedQuoteVersion(ledger, 1, "quote");
    const selectedInvoice = findIssuedQuoteVersion(ledger, 1, "invoice");
    assert.equal(selectedQuote.issuanceId, quoteRecord.issuanceId);
    assert.equal(selectedInvoice.delivery.documentType, "invoice");
    const issued = await readIssuedQuoteArtifact(jobDir, selectedQuote, "quoteMarkdown");
    assert.equal(issued.available, true);
    assert.equal(issued.bytes.toString("utf8"), "issued quote bytes");
    assert.equal(JSON.parse(await readFile(join(jobDir, "quote-issuance.json"), "utf8")).issuedVersions[0], 1);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("tampered issued bytes are unavailable instead of being served", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-issuance-tamper-"));
  try {
    const record = await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 2,
      documentType: "quote",
      quoteMarkdown: "original bytes",
    });
    const path = join(jobDir, record.artifacts.quoteMarkdown.path);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "tampered bytes");
    const issued = await readIssuedQuoteArtifact(jobDir, record, "quoteMarkdown");
    assert.equal(issued.available, false);
    assert.match(issued.reason, /hash does not match/i);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("an invoice or receipt delivered from a version is not that version's quote issuance", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-issuance-doc-type-"));
  try {
    await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 1,
      documentType: "invoice",
      quotePdf: Buffer.from("issued invoice pdf"),
    });
    await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 1,
      documentType: "receipt",
      quotePdf: Buffer.from("issued receipt pdf"),
    });

    const ledger = await readQuoteIssuanceLedger(jobDir);
    assert.equal(hasIssuedQuoteVersion(ledger, 1), false);
    assert.equal(findIssuedQuoteVersion(ledger, 1, "quote"), null);
    assert.equal(findAnyIssuedDocument(ledger, 1)?.documentType, "receipt");

    await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 1,
      documentType: "quote",
      quotePdf: Buffer.from("issued quote pdf"),
    });
    assert.equal(hasIssuedQuoteVersion(await readQuoteIssuanceLedger(jobDir), 1), true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("a ledger record written before document types existed is a quote", () => {
  const ledger = { records: [{ quoteVersion: 2, issuedAt: "2026-01-01T00:00:00.000Z" }] };
  assert.equal(hasIssuedQuoteVersion(ledger, 2), true);
});
