// The wording invoices and credit notes print for a claim (owner, 2026-10-13):
// plain words, the quote on its own line, a revision only when the customer
// was sent more than one version, and never "v1".
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimDescription, customerQuoteReference, quoteReferenceFromMeta, quoteReferenceLine } from "./customer-wording.js";

test("the claim in plain words, with no space before %", () => {
  assert.equal(claimDescription({ milestoneLabel: "Deposit", percentage: 50 }), "Deposit: 50% of the quoted price");
  assert.equal(claimDescription({ milestoneLabel: "Progress", percentage: 12.5 }), "Progress: 12.5% of the quoted price");
  assert.equal(claimDescription({ milestoneLabel: "Deposit", percentage: 0, fixedTotal: 1000 }), "Deposit: fixed amount");
});

test("the quote line: accepted or sent, with a revision only when one is given", () => {
  assert.equal(quoteReferenceLine({ number: "EQ-2601-01", status: "accepted", at: "2026-09-14T02:00:00.000Z" }), "Quote EQ-2601-01, accepted 14 September 2026");
  assert.equal(quoteReferenceLine({ number: "EQ-2601-01", revision: 2, status: "sent", at: "2026-09-14T02:00:00.000Z" }), "Quote EQ-2601-01, revision 2, sent 14 September 2026");
  assert.equal(quoteReferenceLine({ number: "EQ-2601-01", revision: 1, status: null }), "Quote EQ-2601-01");
  const landed = quoteReferenceFromMeta({ meta: { pipelineStage: "landed", landedAt: "2026-09-14T02:00:00.000Z", quoteSentAt: "2026-09-01T02:00:00.000Z" }, milestone: { reference: "EQ-2601-01" } });
  assert.deepEqual(landed, { number: "EQ-2601-01", revision: null, status: "accepted", at: "2026-09-14T02:00:00.000Z" });
  assert.equal(quoteReferenceFromMeta({ meta: { pipelineStage: "sent", quoteSentAt: "2026-09-01T02:00:00.000Z" }, milestone: { reference: "EQ-2601-01" } }).status, "sent");
});

test("a revision is named only when the customer was sent more than one version of the quote", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-customer-wording-"));
  try {
    const meta = { pipelineStage: "landed", landedAt: "2026-09-14T02:00:00.000Z" };
    const ledger = (versions) => writeFile(join(jobDir, "quote-issuance.json"), JSON.stringify({ version: 1, records: versions.map((quoteVersion, index) => ({ id: `r${index}`, quoteVersion, documentType: "quote", issuedAt: "2026-09-01T02:00:00.000Z" })) }));
    await ledger([1]);
    assert.equal((await customerQuoteReference({ jobDir, meta, milestone: { reference: "EQ-2601-01" }, quoteVersion: 1 })).revision, null);
    await ledger([1, 2]);
    const reference = await customerQuoteReference({ jobDir, meta, milestone: { reference: "EQ-2601-01" }, quoteVersion: 2 });
    assert.equal(quoteReferenceLine(reference), "Quote EQ-2601-01, revision 2, accepted 14 September 2026");
    assert.equal((await customerQuoteReference({ jobDir: join(jobDir, "missing"), meta, milestone: { reference: "EQ-2601-01" }, quoteVersion: 2 })).revision, null, "no history: no revision");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
