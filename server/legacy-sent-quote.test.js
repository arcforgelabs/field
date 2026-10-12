import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLegacySentQuotePdf } from "./legacy-sent-quote.js";

const SENT_NAME = "EQ-2609-05 — Sam Sample — Retaining Wall — Quote.pdf";

async function jobWith(files, sends) {
  const dir = await mkdtemp(join(tmpdir(), "legacy-sent-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  await writeFile(join(dir, "sent-emails.jsonl"), sends.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return dir;
}

test("serves the PDF named in the sent email for that quote version", async () => {
  const dir = await jobWith(
    { [SENT_NAME]: "%PDF-1.4 sent", "quote.pdf": "%PDF-1.4 draft" },
    [{ ts: "2026-09-23T05:39:00Z", documentType: "quote", quoteVersion: 1, attachments: [{ filename: SENT_NAME }] }],
  );
  try {
    const result = await readLegacySentQuotePdf(dir, 1);
    assert.equal(result.available, true);
    assert.equal(result.bytes.toString(), "%PDF-1.4 sent");
    assert.equal(result.fileName, SENT_NAME);
    assert.equal(result.source, "sent-attachment");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses when the send was for another version, another document, or the file is missing or not a PDF", async () => {
  const dir = await jobWith(
    { [SENT_NAME]: "%PDF-1.4 sent", "fake.pdf": "<html>" },
    [
      { documentType: "quote", quoteVersion: 2, attachments: [{ filename: SENT_NAME }] },
      { documentType: "invoice", quoteVersion: 1, attachments: [{ filename: SENT_NAME }] },
      { documentType: "quote", quoteVersion: 1, attachments: [{ filename: "gone.pdf" }, { filename: "fake.pdf" }, { filename: "../quote.pdf" }] },
    ],
  );
  try {
    assert.equal((await readLegacySentQuotePdf(dir, 1)).available, false);
    assert.equal((await readLegacySentQuotePdf(dir, 2)).available, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no sent-email archive means nothing to serve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legacy-sent-"));
  try {
    assert.deepEqual(await readLegacySentQuotePdf(dir, 1), { available: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to the PDF stored for the version, never a non-PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legacy-sent-"));
  try {
    await writeFile(join(dir, "quote.pdf"), "%PDF-1.4 stored v1");
    await writeFile(join(dir, "broken.pdf"), "not a pdf");
    const stored = await readLegacySentQuotePdf(dir, 1, join(dir, "quote.pdf"));
    assert.equal(stored.source, "stored-version");
    assert.equal(stored.bytes.toString(), "%PDF-1.4 stored v1");
    assert.equal((await readLegacySentQuotePdf(dir, 1, join(dir, "broken.pdf"))).available, false);
    assert.equal((await readLegacySentQuotePdf(dir, 1, join(dir, "missing.pdf"))).available, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
