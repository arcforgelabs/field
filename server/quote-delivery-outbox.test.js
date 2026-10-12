import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { installDurableStore } from "./storage/durable-hooks.js";
import {
  buildQuoteDeliveryAttempt,
  claimPendingQuoteDelivery,
  decodeQuoteDeliveryArtifacts,
  persistPendingQuoteDelivery,
  readPendingQuoteDelivery,
} from "./quote-delivery-outbox.js";

const execFileAsync = promisify(execFile);

test("quote delivery outbox persists exact prepared bytes and stable identity", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-delivery-outbox-"));
  try {
    const attempt = buildQuoteDeliveryAttempt({
      quoteVersion: 4,
      documentType: "quote",
      to: "customer@example.test",
      quoteMarkdown: "# Quote\n\n$123",
      reportMarkdown: "# Report\n\n$123",
      quotePdf: Buffer.from("pdf-bytes"),
      preparedQuote: { version: 4 },
      preparedMeta: { id: "job-outbox" },
    });
    await persistPendingQuoteDelivery(jobDir, attempt);
    const pending = await readPendingQuoteDelivery(jobDir);
    assert.equal(pending.attemptId, attempt.attemptId);
    assert.equal(pending.messageId, attempt.messageId);
    assert.deepEqual(decodeQuoteDeliveryArtifacts(pending), {
      quoteMarkdown: "# Quote\n\n$123",
      reportMarkdown: "# Report\n\n$123",
      quotePdf: Buffer.from("pdf-bytes"),
    });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
// The claim must be in PostgreSQL before Gmail is called, or a restart
// could rebuild the attempt as "pending" and the customer would be emailed twice.
test("quote delivery claim is stored durably before sending, and undone if it cannot be", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-delivery-claim-"));
  const reasons = [];
  let failStrict = true;
  const fakeStore = {
    registerSqliteImage() {},
    async flushCurrent({ reason }) {
      reasons.push(reason);
      if (failStrict && reason.includes("claim")) {
        const error = new Error("could not store changes in PostgreSQL: disk full");
        error.code = "FIELD_STORAGE_UNAVAILABLE";
        error.statusCode = 503;
        throw error;
      }
      return {};
    },
  };
  const quietError = console.error;
  console.error = () => {};
  installDurableStore(fakeStore);
  try {
    const attempt = buildQuoteDeliveryAttempt({
      quoteVersion: 2,
      documentType: "quote",
      to: "customer@example.test",
      quoteMarkdown: "# Quote",
      reportMarkdown: "# Report",
      quotePdf: Buffer.from("pdf"),
      preparedQuote: { version: 2 },
      preparedMeta: { id: "job-claim" },
    });
    await persistPendingQuoteDelivery(jobDir, attempt);
    const before = await readPendingQuoteDelivery(jobDir);
    await assert.rejects(
      claimPendingQuoteDelivery(jobDir, { attemptId: attempt.attemptId, expectedRevision: before.revision || 0 }),
      (error) => error.statusCode === 503 && /recorded durably/.test(error.message),
    );
    assert.ok(reasons.some((reason) => reason.includes(`quote delivery ${attempt.attemptId} claim`)));
    const undone = await readPendingQuoteDelivery(jobDir);
    assert.equal(undone.status, "pending");
    assert.equal(undone.revision, before.revision);
    assert.equal(undone.claim, before.claim);

    failStrict = false;
    const claim = await claimPendingQuoteDelivery(jobDir, { attemptId: attempt.attemptId, expectedRevision: before.revision || 0 });
    assert.equal(claim.claimed, true);
    assert.equal((await readPendingQuoteDelivery(jobDir)).status, "claimed");
  } finally {
    installDurableStore(null);
    console.error = quietError;
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("manual PDF refuses a legacy issued version with no hash-valid issuance record", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-manual-pdf-data-"));
  try {
    const jobId = "job-legacy-issued-pdf";
    const jobDir = join(dataDir, "2026-08-13", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify({
      id: jobId,
      title: "Legacy issued PDF",
      pipelineStage: "sent",
      quoteSentAt: "2026-08-12T00:00:00.000Z",
      quoteVersion: 1,
    }));
    await writeFile(join(jobDir, "quote.json"), JSON.stringify({
      version: 1,
      totals: { total: 100, currency: "AUD" },
      pricing: { displayable: true, sendable: true },
    }));
    await writeFile(join(jobDir, "quote-lifecycle.json"), JSON.stringify({ lastSentQuoteVersion: 1 }));

    await assert.rejects(
      () => execFileAsync(process.execPath, ["scripts/generate-manual-pdf.js", jobId], {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, FIELD_DATA: dataDir },
      }),
      (error) => {
        assert.notEqual(error.code, 0);
        assert.match(`${error.stdout || ""}\n${error.stderr || ""}`, /no hash-valid issuance record|refusing to rerender/i);
        return true;
      },
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
