import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deleteQuoteVersion,
  promoteQuoteVersion,
  resolveQuotePaymentTerms,
  writeMilestoneInvoiceArtifact,
} from "./quote-artifacts.js";
import { ARTIFACT_STATE } from "./invoice-artifact-state.js";
import { recordIssuedQuoteDocuments } from "./quote-issuance.js";
import { QUOTE_BREAKDOWN_SOURCE_FILE } from "./quote-breakdown-source.js";
import {
  QUOTE_VERSION_CONTEXT_FILE,
  VERSIONED_CONTEXT_LOGICAL_FILES,
  formatQuoteVersionLabel,
} from "./quote-version-context.js";

const PROMOTED_TEST_FILES = [...new Set([
  "quote.json",
  "quote.md",
  "quote.pdf",
  "quote-overrides.json",
  QUOTE_BREAKDOWN_SOURCE_FILE,
  QUOTE_VERSION_CONTEXT_FILE,
  "quote-inputs.json",
])];

const ROOT_OPERATIONAL_CONTEXT_FILES = VERSIONED_CONTEXT_LOGICAL_FILES.filter((name) => ![
  "quote-inputs.json",
  "evidence-pack.json",
  "quote-breakdown-source.json",
].includes(name));

test("custom quote payment terms are generated from the saved milestone schedule (DEL-29)", () => {
  const paymentTerms = resolveQuotePaymentTerms({
    deliveryDefaults: {
      paymentTerms: "10% deposit due on acceptance. 30% progress payment due on commencement.",
    },
    paymentSchedule: {
      milestones: [
        { label: "Deposit", percentage: 30 },
        { label: "Final payment", percentage: 70 },
      ],
    },
  });

  assert.equal(
    paymentTerms,
    "Payments are due according to the saved milestone schedule: Deposit - 30%; Final payment - 70%.",
  );
  assert.equal(paymentTerms.includes("10%"), false);
});

test("the untouched default schedule keeps the catalogue's richer payment timing", () => {
  const defaultTerms = "10% deposit due on acceptance. 30% progress payment due on commencement. Remaining balance due on completion.";
  const paymentTerms = resolveQuotePaymentTerms({
    deliveryDefaults: { paymentTerms: defaultTerms },
    paymentSchedule: {
      milestones: [
        { label: "Deposit", percentage: 10 },
        { label: "Progress payment", percentage: 30 },
        { label: "Final payment", percentage: 60 },
      ],
    },
  });

  assert.equal(paymentTerms, defaultTerms);
});

async function seedVersionState(baseDir, { label, version }) {
  await mkdir(baseDir, { recursive: true });

  const quote = {
    version,
    quoteNumber: `Q-${version}`,
    summary: `${label} summary`,
    delivery: {
      status: "sent",
      finalizedAt: `2026-01-0${version}T00:00:00.000Z`,
    },
  };

  const payloads = new Map();
  payloads.set("quote.json", JSON.stringify(quote, null, 2));
  payloads.set("quote.md", `${label} markdown`);
  payloads.set("quote.pdf", `${label} pdf`);
  payloads.set("quote-overrides.json", JSON.stringify({ label, version }, null, 2));
  payloads.set(QUOTE_BREAKDOWN_SOURCE_FILE, JSON.stringify({ label, source: "breakdown" }, null, 2));
  payloads.set(QUOTE_VERSION_CONTEXT_FILE, JSON.stringify({
    mode: label === "root" ? "current" : "snapshot",
    quoteVersion: version,
    hiddenFileIds: [`${label}-hidden`],
  }, null, 2));

  for (const name of VERSIONED_CONTEXT_LOGICAL_FILES) {
    if (payloads.has(name)) continue;
    payloads.set(name, JSON.stringify({ label, file: name, version }, null, 2));
  }

  for (const [name, contents] of payloads.entries()) {
    await writeFile(join(baseDir, name), contents);
  }

  return {
    quote,
    payloads,
  };
}

test("promoteQuoteVersion swaps quote artifacts and rebuild context together", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-promote-quote-version-"));

  try {
    const rootState = await seedVersionState(jobDir, { label: "root", version: 2 });
    const targetDir = join(jobDir, "quote-versions", formatQuoteVersionLabel(1));
    const targetState = await seedVersionState(targetDir, { label: "target", version: 1 });
    await writeFile(join(jobDir, "report.md"), "stale report");

    const result = await promoteQuoteVersion(jobDir, 1);

    assert.equal(result.previousVersion, 2);
    assert.equal(result.currentVersion, 1);
    assert.equal(result.quote.version, 1);
    assert.equal(result.quote.delivery?.status, "draft");
    assert.equal(result.quote.delivery?.finalizedAt, null);

    for (const name of PROMOTED_TEST_FILES) {
      const rootValue = await readFile(join(jobDir, name), "utf8");
      if (name === "quote.json") {
        const promotedQuote = JSON.parse(rootValue);
        const targetQuote = JSON.parse(targetState.payloads.get(name));
        assert.equal(promotedQuote.version, targetQuote.version);
        assert.equal(promotedQuote.summary, targetQuote.summary);
        assert.equal(promotedQuote.delivery?.status, "draft");
        assert.equal(promotedQuote.delivery?.finalizedAt, null);
        continue;
      }
      const expected = targetState.payloads.get(name);
      assert.equal(rootValue, expected, `${name} should match promoted target state`);
    }

    for (const name of ROOT_OPERATIONAL_CONTEXT_FILES) {
      assert.equal(
        await readFile(join(jobDir, name), "utf8"),
        rootState.payloads.get(name),
        `${name} remains root-authoritative during promotion`,
      );
    }

    for (const name of PROMOTED_TEST_FILES) {
      const archivedValue = await readFile(
        join(jobDir, "quote-versions", formatQuoteVersionLabel(2), name),
        "utf8",
      );
      const expected = rootState.payloads.get(name);
      assert.equal(archivedValue, expected, `${name} should be archived with former root state`);
    }

    assert.equal(await readFile(join(jobDir, "report.md"), "utf8"), targetState.payloads.get("quote.md"));
    assert.equal(existsSync(targetDir), false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

function createInvoiceQuoteFixture({ version = 1, summary = "Quote content" } = {}) {
  return {
    kind: "quote",
    version,
    quoteNumber: "EQ-P2B-01",
    title: "P2-B reconstruction test",
    generatedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    summary,
    quoteCatalog: {
      id: "embark-default",
      currency: "AUD",
      gstRate: 0.1,
      businessProfile: {
        paymentMethods: {
          bankTransfer: {
            accountName: "Your Business Pty Ltd",
            bsb: "000-000",
            accountNumber: "0000 0000 0",
            bank: "Your bank",
          },
        },
      },
    },
    lineItems: [
      { code: "wall", label: "Retaining wall", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, customerVisible: true },
    ],
    presentation: {
      scopeText: summary,
      scheduleItems: [
        { code: "wall", label: "Retaining wall", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, sourceLineItemCodes: ["wall"] },
      ],
    },
    totals: { subtotal: 100, gst: 10, total: 110, currency: "AUD" },
    delivery: { status: "final" },
  };
}

function createIssuedMilestoneInvoiceFixture(invoiceNumber, pdfPath) {
  const lineItems = [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 110, totalPrice: 110 }];
  return {
    milestoneIndex: 0,
    milestoneLabel: "Deposit",
    invoiceNumber,
    revisionNumber: 1,
    status: "authorised",
    issuedAt: "2026-01-05T00:00:00.000Z",
    subtotal: 100,
    gst: 10,
    total: 110,
    currency: "AUD",
    lineItems,
    pdfPath,
    issuedRevision: {
      revisionNumber: 1,
      invoiceNumber,
      issuedAt: "2026-01-05T00:00:00.000Z",
      quoteVersion: 1,
      subtotal: 100,
      gst: 10,
      total: 110,
      currency: "AUD",
      lineItems,
      pdfPath,
      pdfIssuedAt: "2026-01-05T00:05:00.000Z",
      pdfSha256: "stale-sha-from-a-file-that-no-longer-exists",
    },
    revisionHistory: [],
  };
}

test("writeMilestoneInvoiceArtifact reconstructs a missing PDF for an already-issued revision from its pinned quote version, never the current one (DEL-30 P2-B)", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-artifact-reconstruct-"));
  try {
    const pinnedQuote = createInvoiceQuoteFixture({ version: 1, summary: "Pinned quote content" });
    const pinnedDir = join(jobDir, "quote-versions", formatQuoteVersionLabel(1));
    await mkdir(pinnedDir, { recursive: true });
    await writeFile(join(pinnedDir, "quote.json"), JSON.stringify(pinnedQuote, null, 2));

    const meta = { id: "job-reconstruct-1", title: "Reconstruction test" };
    const relativePdfPath = "milestone-invoices/EI-P2B-01-M1.pdf";
    const milestoneInvoice = createIssuedMilestoneInvoiceFixture("EI-P2B-01-M1", relativePdfPath);

    // The PDF file itself is missing (deleted, lost, never migrated) even
    // though the revision is stamped as issued. Passing `quote: null` as the
    // "current" quote proves reconstruction never touches it: the buggy
    // fallthrough path would render from `quote` here and throw reading
    // `quote.delivery` off `null` (see `renderQuotePdf`); a correct
    // reconstruction ignores it entirely and reads the pinned version off
    // disk instead.
    const result = await writeMilestoneInvoiceArtifact({
      jobDir,
      meta,
      quote: null,
      milestoneInvoice,
    });

    assert.equal(result.reconstructed, true);
    assert.equal(result.alreadyIssued, true);
    assert.equal(result.pdfIssuedAt, "2026-01-05T00:00:00.000Z");
    assert.ok(result.pdfSha256 && result.pdfSha256 !== "stale-sha-from-a-file-that-no-longer-exists");
    assert.ok(result.pdfBuffer && result.pdfBuffer.length > 0);
    assert.ok(existsSync(join(jobDir, relativePdfPath)));
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Root quote artifacts represent the CURRENT version and only get archived
// into `quote-versions/vNNN/` once the quote is forked away from it
// (forkCurrentQuoteVersion). A job that was quoted, landed and invoiced but
// never revised has no archive directory at all — before this fix, that
// meant the pinned version could never be found even though it IS the
// current, locked root quote, and the headline P2-B reconstruction feature
// could not fire for the common case (DEL-30 P2-1).
test("writeMilestoneInvoiceArtifact reconstructs from root quote artifacts when the pinned version is the current, never-forked version (DEL-30 P2-1)", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-artifact-root-fallback-"));
  try {
    // No quote-versions/ directory at all — this job has never been forked.
    const rootQuote = createInvoiceQuoteFixture({ version: 1, summary: "Root quote content" });
    await writeFile(join(jobDir, "quote.json"), JSON.stringify(rootQuote, null, 2));
    assert.equal(existsSync(join(jobDir, "quote-versions")), false);

    const meta = { id: "job-root-fallback-1", title: "Root fallback test" };
    const relativePdfPath = "milestone-invoices/EI-P2-1-01-M1.pdf";
    const milestoneInvoice = createIssuedMilestoneInvoiceFixture("EI-P2-1-01-M1", relativePdfPath);
    // Pinned to version 1 — the same as root, never archived anywhere.
    assert.equal(milestoneInvoice.issuedRevision.quoteVersion, 1);

    const result = await writeMilestoneInvoiceArtifact({
      jobDir,
      meta,
      quote: null,
      milestoneInvoice,
    });

    assert.equal(result.reconstructed, true);
    assert.equal(result.alreadyIssued, true);
    assert.ok(result.pdfSha256 && result.pdfSha256 !== "stale-sha-from-a-file-that-no-longer-exists");
    assert.ok(existsSync(join(jobDir, relativePdfPath)));
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("writeMilestoneInvoiceArtifact fails loudly instead of rendering from the current quote when an issued revision's pinned quote version is unavailable (DEL-30 P2-B)", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-artifact-reconstruct-gone-"));
  try {
    const meta = { id: "job-reconstruct-gone-1", title: "Reconstruction gone test" };
    const currentQuote = createInvoiceQuoteFixture({ version: 2, summary: "Current quote content" });
    const relativePdfPath = "milestone-invoices/EI-P2B-02-M1.pdf";
    // The pinned version (v1) was never written to disk here — simulating an
    // archived quote version that has since been deleted or never existed.
    const milestoneInvoice = createIssuedMilestoneInvoiceFixture("EI-P2B-02-M1", relativePdfPath);

    await assert.rejects(
      () => writeMilestoneInvoiceArtifact({
        jobDir,
        meta,
        quote: currentQuote,
        milestoneInvoice,
      }),
      (err) => {
        assert.equal(err.statusCode, 410);
        return true;
      },
    );
    assert.equal(existsSync(join(jobDir, relativePdfPath)), false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// `legacyOrigin` is transient and does not survive `normalizeInvoiceRevision`
// (called by `normalizeStoredMilestoneInvoices`, which runs on every touch of
// a milestone invoice) — so a revision that failed reconstruction once and
// was caught (DEL-30 P1-C) loses that marker on its very next touch.
// `pdfUnrecoverable` is persisted and must independently gate the same
// "reconstruct or fail loudly, never silently render" behaviour, or a retry
// would fall straight through to the fabrication P2-B closed.
test("writeMilestoneInvoiceArtifact still fails loudly (never silently renders) for a pdfUnrecoverable revision with no legacyOrigin marker (DEL-30 P1-C)", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-artifact-unrecoverable-retry-"));
  try {
    const meta = { id: "job-unrecoverable-retry-1", title: "Unrecoverable retry test" };
    const currentQuote = createInvoiceQuoteFixture({ version: 2, summary: "Current quote content — must not be used" });
    const relativePdfPath = "milestone-invoices/EI-P1C-01-M1.pdf";
    const milestoneInvoice = createIssuedMilestoneInvoiceFixture("EI-P1C-01-M1", relativePdfPath);
    // Simulate the state after a prior failed implicit write: no
    // `pdfIssuedAt`, no `legacyOrigin` (stripped by normalization since),
    // just the persisted `pdfUnrecoverable` marker.
    milestoneInvoice.issuedRevision.pdfIssuedAt = null;
    delete milestoneInvoice.issuedRevision.legacyOrigin;
    milestoneInvoice.issuedRevision.pdfUnrecoverable = true;

    await assert.rejects(
      () => writeMilestoneInvoiceArtifact({
        jobDir,
        meta,
        quote: currentQuote,
        milestoneInvoice,
      }),
      (err) => {
        assert.equal(err.statusCode, 410);
        return true;
      },
    );
    assert.equal(existsSync(join(jobDir, relativePdfPath)), false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("writeMilestoneInvoiceArtifact recovers a pdfUnrecoverable revision once its pinned quote version becomes available again (DEL-30 P1-C)", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-artifact-unrecoverable-recover-"));
  try {
    const pinnedQuote = createInvoiceQuoteFixture({ version: 1, summary: "Pinned quote content" });
    const pinnedDir = join(jobDir, "quote-versions", formatQuoteVersionLabel(1));
    await mkdir(pinnedDir, { recursive: true });
    await writeFile(join(pinnedDir, "quote.json"), JSON.stringify(pinnedQuote, null, 2));

    const meta = { id: "job-unrecoverable-recover-1", title: "Unrecoverable recovery test" };
    const relativePdfPath = "milestone-invoices/EI-P1C-02-M1.pdf";
    const milestoneInvoice = createIssuedMilestoneInvoiceFixture("EI-P1C-02-M1", relativePdfPath);
    milestoneInvoice.issuedRevision.pdfIssuedAt = null;
    delete milestoneInvoice.issuedRevision.legacyOrigin;
    milestoneInvoice.issuedRevision.pdfUnrecoverable = true;

    const result = await writeMilestoneInvoiceArtifact({
      jobDir,
      meta,
      quote: null,
      milestoneInvoice,
    });

    assert.equal(result.reconstructed, true);
    assert.ok(existsSync(join(jobDir, relativePdfPath)));
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// DEL-30 P2-1 (round 5): a legacy revision retired into history must carry
// ARTIFACT_STATE.ADOPT_PENDING (set at synthesis, not stamped post-hoc) so
// `historicalMatch` — which requires any state other than UNWRITTEN — still
// recognises it as a money document. Before the fix, retired legacy copies
// derived UNWRITTEN (the synthesis never set a state, only a post-hoc stamp
// did, and that stamp landed on the mint instead), so a missing file at the
// SAME path as a retired legacy revision would have silently rendered fresh
// instead of reconstructing-or-failing.
test("writeMilestoneInvoiceArtifact treats an ADOPT_PENDING historical revision as a money document requiring reconstruct-or-fail", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-invoice-artifact-historical-adopt-pending-"));
  try {
    const meta = { id: "job-historical-adopt-pending-1", title: "Historical ADOPT_PENDING test" };
    const relativePdfPath = "milestone-invoices/EI-HIST-01-M1.pdf";
    const lineItems = [{ description: "Deposit", quantity: 1, unit: "lot", unitPrice: 110, totalPrice: 110 }];
    const milestoneInvoice = {
      milestoneIndex: 0,
      milestoneLabel: "Deposit",
      invoiceNumber: "EI-HIST-01-M1-R2",
      revisionNumber: 2,
      status: "authorised",
      // The CURRENT active revision is an ordinary fresh mint at a
      // DIFFERENT path — nothing wrong with it. The retired legacy copy at
      // the ORIGINAL base path is what this test is about.
      pdfPath: "milestone-invoices/EI-HIST-01-M1-R2.pdf",
      issuedRevision: {
        revisionNumber: 2,
        invoiceNumber: "EI-HIST-01-M1-R2",
        issuedAt: "2026-01-06T00:00:00.000Z",
        quoteVersion: 2,
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
        lineItems,
        pdfPath: "milestone-invoices/EI-HIST-01-M1-R2.pdf",
        artifactState: ARTIFACT_STATE.UNWRITTEN,
      },
      revisionHistory: [{
        revisionNumber: 1,
        invoiceNumber: "EI-HIST-01-M1",
        issuedAt: "2026-01-01T00:00:00.000Z",
        quoteVersion: 1,
        subtotal: 100,
        gst: 10,
        total: 110,
        currency: "AUD",
        lineItems,
        pdfPath: relativePdfPath,
        artifactState: ARTIFACT_STATE.ADOPT_PENDING,
        supersededAt: "2026-01-06T00:00:00.000Z",
        supersededByRevisionNumber: 2,
      }],
    };

    // Simulate a request for the retired revision's own path with no file
    // present — passing `quote: null` also proves the current quote is
    // never touched to render over it.
    const targetedMilestoneInvoice = { ...milestoneInvoice, pdfPath: relativePdfPath };
    await assert.rejects(
      () => writeMilestoneInvoiceArtifact({
        jobDir,
        meta,
        quote: null,
        milestoneInvoice: targetedMilestoneInvoice,
      }),
      (err) => {
        assert.equal(err.statusCode, 410);
        return true;
      },
    );
    assert.equal(existsSync(join(jobDir, relativePdfPath)), false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// DEL-30 P3-2: version snapshots are the reconstruction basis for money
// documents (DEL-30 P2-B) — deleting one an issued revision is pinned to
// would silently convert every future lost PDF pinned to it into a
// permanent 410 with no way back.
test("deleteQuoteVersion refuses with 409 when an issued revision is pinned to that version", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-version-delete-refused-"));
  try {
    await mkdir(join(jobDir, "quote-versions", formatQuoteVersionLabel(1)), { recursive: true });
    await writeFile(
      join(jobDir, "quote-versions", formatQuoteVersionLabel(1), "quote.json"),
      JSON.stringify({ version: 1, quoteNumber: "EQ-DEL-01" }, null, 2),
    );

    const meta = {
      id: "job-version-delete-refused-1",
      title: "Version delete refusal test",
      milestoneInvoices: [{
        milestoneIndex: 0,
        invoiceNumber: "EI-DEL-01-M1",
        status: "authorised",
        issuedAt: "2026-01-01T00:00:00.000Z",
        pdfPath: "milestone-invoices/EI-DEL-01-M1.pdf",
        issuedRevision: {
          revisionNumber: 1,
          invoiceNumber: "EI-DEL-01-M1",
          issuedAt: "2026-01-01T00:00:00.000Z",
          quoteVersion: 1,
          subtotal: 100,
          gst: 10,
          total: 110,
          currency: "AUD",
          lineItems: [],
          pdfPath: "milestone-invoices/EI-DEL-01-M1.pdf",
        },
      }],
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));

    await assert.rejects(
      () => deleteQuoteVersion(jobDir, 1),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /EI-DEL-01-M1/);
        return true;
      },
    );
    assert.ok(existsSync(join(jobDir, "quote-versions", formatQuoteVersionLabel(1))), "the version directory was not deleted");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("deleteQuoteVersion refuses with 409 when a HISTORICAL (retired) revision is pinned to that version", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-version-delete-refused-history-"));
  try {
    await mkdir(join(jobDir, "quote-versions", formatQuoteVersionLabel(1)), { recursive: true });
    await writeFile(
      join(jobDir, "quote-versions", formatQuoteVersionLabel(1), "quote.json"),
      JSON.stringify({ version: 1, quoteNumber: "EQ-DEL-02" }, null, 2),
    );

    const meta = {
      id: "job-version-delete-refused-history-1",
      title: "Version delete refusal (history) test",
      milestoneInvoices: [{
        milestoneIndex: 0,
        invoiceNumber: "EI-DEL-02-M1-R2",
        status: "authorised",
        issuedAt: "2026-01-02T00:00:00.000Z",
        pdfPath: "milestone-invoices/EI-DEL-02-M1-R2.pdf",
        issuedRevision: {
          revisionNumber: 2,
          invoiceNumber: "EI-DEL-02-M1-R2",
          issuedAt: "2026-01-02T00:00:00.000Z",
          quoteVersion: 2,
          subtotal: 100,
          gst: 10,
          total: 110,
          currency: "AUD",
          lineItems: [],
          pdfPath: "milestone-invoices/EI-DEL-02-M1-R2.pdf",
        },
        revisionHistory: [{
          revisionNumber: 1,
          invoiceNumber: "EI-DEL-02-M1",
          issuedAt: "2026-01-01T00:00:00.000Z",
          quoteVersion: 1,
          subtotal: 100,
          gst: 10,
          total: 110,
          currency: "AUD",
          lineItems: [],
          pdfPath: "milestone-invoices/EI-DEL-02-M1.pdf",
          supersededAt: "2026-01-02T00:00:00.000Z",
          supersededByRevisionNumber: 2,
        }],
      }],
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));

    await assert.rejects(
      () => deleteQuoteVersion(jobDir, 1),
      (err) => {
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("deleteQuoteVersion still succeeds for a version no issued revision is pinned to", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-version-delete-allowed-"));
  try {
    await mkdir(join(jobDir, "quote-versions", formatQuoteVersionLabel(1)), { recursive: true });
    await writeFile(
      join(jobDir, "quote-versions", formatQuoteVersionLabel(1), "quote.json"),
      JSON.stringify({ version: 1, quoteNumber: "EQ-DEL-03" }, null, 2),
    );

    const meta = {
      id: "job-version-delete-allowed-1",
      title: "Version delete allowed test",
      milestoneInvoices: [{
        milestoneIndex: 0,
        invoiceNumber: "EI-DEL-03-M1",
        status: "authorised",
        issuedAt: "2026-01-01T00:00:00.000Z",
        pdfPath: "milestone-invoices/EI-DEL-03-M1.pdf",
        issuedRevision: {
          revisionNumber: 1,
          invoiceNumber: "EI-DEL-03-M1",
          issuedAt: "2026-01-01T00:00:00.000Z",
          // Pinned to version 2, not the version being deleted.
          quoteVersion: 2,
          subtotal: 100,
          gst: 10,
          total: 110,
          currency: "AUD",
          lineItems: [],
          pdfPath: "milestone-invoices/EI-DEL-03-M1.pdf",
        },
      }],
    };
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));

    await deleteQuoteVersion(jobDir, 1);
    assert.equal(existsSync(join(jobDir, "quote-versions", formatQuoteVersionLabel(1))), false);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// Deleting or replacing a version's files is guarded by ANY document delivered
// from it: an invoice or receipt was priced from that version even when the
// quote itself was never delivered.
test("deleteQuoteVersion refuses a version an invoice was delivered from, even with no quote delivery", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-version-delete-invoice-issued-"));
  try {
    await mkdir(join(jobDir, "quote-versions", formatQuoteVersionLabel(1)), { recursive: true });
    await writeFile(
      join(jobDir, "quote-versions", formatQuoteVersionLabel(1), "quote.json"),
      JSON.stringify({ version: 1, quoteNumber: "EQ-DEL-04" }, null, 2),
    );
    await writeFile(join(jobDir, "meta.json"), JSON.stringify({ id: "job-version-delete-invoice-1" }, null, 2));
    await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 1,
      documentType: "invoice",
      quotePdf: Buffer.from("issued invoice pdf"),
    });

    await assert.rejects(
      () => deleteQuoteVersion(jobDir, 1),
      (error) => error.statusCode === 409 && /issued document is immutable/.test(error.message),
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("promoteQuoteVersion keeps the source version a receipt was delivered from", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-promote-receipt-issued-"));
  try {
    await seedVersionState(jobDir, { label: "root", version: 2 });
    const targetDir = join(jobDir, "quote-versions", formatQuoteVersionLabel(1));
    await seedVersionState(targetDir, { label: "target", version: 1 });
    await recordIssuedQuoteDocuments({
      jobDir,
      quoteVersion: 1,
      documentType: "receipt",
      quotePdf: Buffer.from("issued receipt pdf"),
    });

    await promoteQuoteVersion(jobDir, 1);

    assert.equal(existsSync(targetDir), true);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
