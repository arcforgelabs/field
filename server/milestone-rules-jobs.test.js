// Milestone rules on jobs (#29, step 4c): a job's first schedule comes from
// the account rule for its region and contract value, an operator's own
// schedule is marked as an override, caps are checked when an invoice is
// issued (hard refuses, soft alerts and is recorded), and nothing already
// issued changes when rules arrive or change.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import { generateJobMilestones, markJobLanded, readJobMilestoneRules, recordJobMilestonePayment, updateJobMilestone } from "./job-actions.js";
import { readJobMeta } from "./job-meta-store.js";
import { installTestInvoiceIssuer } from "./invoices/test-issuer.js";
import { createMilestoneRuleService, installMilestoneRules } from "./invoices/milestone-rules.js";
import { mapMilestoneState } from "./invoices/from-milestones.js";
import { queryRows } from "./db-runtime/index.js";
import { withOrg } from "./db-runtime/tenancy.js";
import { SA_RULES } from "./invoices/milestone-rules-fixtures.js";

const ISSUER = await installTestInvoiceIssuer();
const RULES = createMilestoneRuleService({ db: ISSUER.db, orgUid: ISSUER.orgUid });
test.after(async () => {
  installMilestoneRules(null);
  await ISSUER.close();
});

const SA_SITE = "7 Example Street, Sampleton SA 5000";

// A sent quote with a subtotal of `subtotal` ex GST (GST 10 %).
function quoteFixture(meta, subtotal) {
  const row = { code: "scope", label: "Scope item", quantity: 1, unit: "lot", unitPrice: subtotal, totalPrice: subtotal };
  return {
    kind: "quote",
    version: 1,
    status: "ready",
    generatedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    jobId: meta.id,
    quoteNumber: meta.quoteNumber,
    jobNumber: meta.jobNumber,
    title: meta.title,
    recordingIntent: "job-scope",
    summary: "Synthetic scope",
    quoteCatalog: { id: "embark-default", name: "Sample Catalogue", currency: "AUD", gstRate: 0.1, businessProfile: { address: "1 Placeholder Rd, Exampleton SA 5000" } },
    lineItems: [{ ...row, unitCost: subtotal * 0.7, totalCost: subtotal * 0.7, section: "Works", customerVisible: true }],
    presentation: { scopeText: "Synthetic scope", scheduleItems: [{ ...row, sourceLineItemCodes: ["scope"] }] },
    totals: { subtotal, gst: subtotal / 10, total: subtotal * 1.1, currency: "AUD" },
    pricing: {
      authorityProvider: "price_catalog", ready: true, displayable: true, sendable: true, blockingReason: null,
      attestation: { status: "verified", requestNonce: "req-verified", verifiedNonce: "req-verified" },
    },
    review: { status: "ready", reasons: [] },
    delivery: { status: "final" },
    assumptions: [],
    assumptionInputs: [],
    missingInputs: [],
  };
}

async function seedSentJob(root, id, { subtotal = 15000, siteAddress = SA_SITE, paymentSchedule = null } = {}) {
  const jobDir = join(root, id);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(jobDir, { recursive: true }));
  const meta = {
    id,
    title: `Rules test ${id}`,
    label: `Rules test ${id}`,
    outputMode: "quote",
    pipelineStage: "sent",
    deliveryStatus: "sent",
    quoteNumber: `EQ-${id}`,
    jobNumber: `JOB-${id}`,
    quoteVersion: 1,
    quoteSentAt: "2026-10-02T00:00:00.000Z",
    siteAddress,
    ...(paymentSchedule ? { paymentSchedule } : {}),
  };
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeFile(join(jobDir, "quote.json"), JSON.stringify(quoteFixture(meta, subtotal), null, 2));
  return { jobDir, meta };
}

async function withRules(rules, body) {
  await RULES.replace(rules);
  installMilestoneRules(RULES);
  try {
    return await body();
  } finally {
    installMilestoneRules(null);
    await RULES.replace([]);
  }
}

const issue = (jobDir, milestoneIndex) => readJobMeta(jobDir).then((meta) => updateJobMilestone({
  jobDir, meta, config: {}, milestoneIndex, patch: { status: "authorised" }, actor: { kind: "user", label: "Alex" },
}));

async function invoiceCount() {
  const [row] = await withOrg(ISSUER.db, ISSUER.orgUid, (tx) => queryRows(sql`select count(*) as n from invoices where issued_at is not null`, tx));
  return Number(row.n);
}

test("with no rules, a job's schedule and invoices are as before: Field's default, unmarked", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-rules-none-"));
  try {
    const { jobDir, meta } = await seedSentJob(root, "none-1");
    const landed = await markJobLanded({ jobDir, meta, dataDir: root, config: {} });
    assert.deepEqual(landed.meta.paymentSchedule, { milestones: [{ label: "Deposit", percentage: 10 }, { label: "Progress payment", percentage: 30 }, { label: "Final payment", percentage: 60 }] });
    const issued = await issue(jobDir, 0);
    assert.equal(issued.meta.milestoneInvoices[0].issuedRevision.milestoneRule, undefined, "no rule record on the invoice");
    assert.equal(mapMilestoneState({ meta: issued.meta }).milestones[0].isDefaultSchedule, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a job's first milestones come from the account rule for its region and contract value, marked as the rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-rules-first-"));
  try {
    await withRules(SA_RULES, async () => {
      const { jobDir, meta } = await seedSentJob(root, "first-1", { subtotal: 15000 });
      const landed = await markJobLanded({ jobDir, meta, dataDir: root, config: {}, actor: { kind: "user", label: "Alex" } });
      const schedule = landed.meta.paymentSchedule;
      assert.deepEqual(schedule.milestones.map((milestone) => [milestone.label, milestone.percentage]), [["Deposit", 5], ["Progress payment", 35], ["Final payment", 60]]);
      assert.equal(schedule.source.kind, "rule");
      assert.equal(schedule.source.ruleName, "SA domestic, under $20,000");
      assert.equal(schedule.source.band, "under $20,000.00");
      assert.equal(schedule.source.by, "Alex");
      assert.equal(mapMilestoneState({ meta: landed.meta }).milestones[0].isDefaultSchedule, true, "payment_milestones.is_default_schedule");

      // The deposit, 5 % of $16,500, is $825: under the $1,000 cap.
      const issued = await issue(jobDir, 0);
      const revision = issued.meta.milestoneInvoices[0].issuedRevision;
      assert.equal(revision.total, 825);
      assert.deepEqual(revision.milestoneRule, { ruleUid: schedule.source.ruleUid, ruleName: "SA domestic, under $20,000", band: "under $20,000.00", scheduleSource: "rule", capAlerts: [] });

      // Stored as read back from the files.
      assert.deepEqual((await readJobMeta(jobDir)).paymentSchedule.source.kind, "rule");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an operator's own schedule is an override; a hard cap refuses the deposit, names the rule and issues nothing; the rule can be restored", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-rules-override-"));
  try {
    await withRules(SA_RULES, async () => {
      const { jobDir, meta } = await seedSentJob(root, "override-1", { subtotal: 15000 });
      await markJobLanded({ jobDir, meta, dataDir: root, config: {} });
      const overridden = await generateJobMilestones({
        jobDir,
        meta: await readJobMeta(jobDir),
        config: {},
        // A client may not claim its own schedule is the rule's.
        paymentSchedule: { milestones: [{ label: "Deposit", percentage: 10 }, { label: "Final", percentage: 90 }], source: { kind: "rule" } },
        actor: { kind: "user", label: "Sam" },
      });
      assert.equal(overridden.meta.paymentSchedule.source.kind, "override");
      assert.equal(overridden.meta.paymentSchedule.source.ruleName, "SA domestic, under $20,000", "it names the rule it departs from");
      assert.equal(overridden.meta.paymentSchedule.source.by, "Sam");
      assert.equal(mapMilestoneState({ meta: overridden.meta }).milestones[0].isDefaultSchedule, false);

      const check = await readJobMilestoneRules({ jobDir, meta: await readJobMeta(jobDir), config: {} });
      assert.equal(check.rule.name, "SA domestic, under $20,000");
      assert.deepEqual(check.region, { country: "AU", region: "SA", from: "site-address" });
      assert.equal(check.scheduleSource.kind, "override");
      assert.equal(check.milestones[0].blocked, true, "shown before issue");
      assert.equal(check.milestones[0].findings[0].limit, 1000);
      assert.equal(check.milestones[1].blocked, false);

      const before = await invoiceCount();
      const beforeMeta = await readJobMeta(jobDir);
      await assert.rejects(issue(jobDir, 0), (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "MILESTONE_CAP_EXCEEDED");
        assert.match(error.message, /Deposit is \$1,650\.00 with GST\. The rule "SA domestic, under \$20,000"/);
        assert.equal(error.findings[0].ruleName, "SA domestic, under $20,000");
        return true;
      });
      assert.equal(await invoiceCount(), before, "no invoice issued");
      assert.deepEqual((await readJobMeta(jobDir)).milestoneInvoices, beforeMeta.milestoneInvoices, "the job is as it was");

      // The rule's schedule comes back on request; the deposit then issues.
      const restored = await generateJobMilestones({ jobDir, meta: await readJobMeta(jobDir), config: {}, applyAccountRule: true });
      assert.equal(restored.meta.paymentSchedule.source.kind, "rule");
      assert.equal((await issue(jobDir, 0)).meta.milestoneInvoices[0].status, "authorised");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a soft cap issues the invoice and records the alert with it, in the files and the issued document", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-rules-soft-"));
  const soft = [{ name: "Deposit guidance", caps: [{ kind: "deposit", maxPercent: 5, mode: "soft" }] }];
  try {
    await withRules(soft, async () => {
      const { jobDir, meta } = await seedSentJob(root, "soft-1", { subtotal: 15000, siteAddress: "Somewhere unreadable" });
      const landed = await markJobLanded({ jobDir, meta, dataDir: root, config: {} });
      assert.equal(landed.meta.paymentSchedule.source.milestonesFrom, "default", "the rule gives no milestones: Field's default schedule");
      const issued = await issue(jobDir, 0);
      const record = issued.meta.milestoneInvoices[0].issuedRevision.milestoneRule;
      assert.equal(record.capAlerts.length, 1);
      assert.equal(record.capAlerts[0].mode, "soft");
      assert.equal(record.capAlerts[0].limit, 825);
      const [row] = await withOrg(ISSUER.db, ISSUER.orgUid, (tx) => queryRows(sql`select details from issued_documents where number = ${issued.meta.milestoneInvoices[0].invoiceNumber}`, tx));
      assert.equal(row.details.milestoneRule.capAlerts[0].message, record.capAlerts[0].message);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rules that arrive after an invoice was issued never change it, nor the job's schedule", async () => {
  const root = await mkdtemp(join(tmpdir(), "field-rules-issued-"));
  try {
    // Issued under no rules: a 10 % deposit of $1,650.
    const { jobDir, meta } = await seedSentJob(root, "issued-1", { subtotal: 15000 });
    await markJobLanded({ jobDir, meta, dataDir: root, config: {} });
    const issued = (await issue(jobDir, 0)).meta;
    const deposit = issued.milestoneInvoices[0];
    const pdfBytes = await readFile(join(jobDir, deposit.pdfPath));
    const [rowBefore] = await withOrg(ISSUER.db, ISSUER.orgUid, (tx) => queryRows(sql`select number, subtotal, tax_total, total, issued_at from invoices where number = ${deposit.invoiceNumber}`, tx));

    await withRules(SA_RULES, async () => {
      // The deposit is over the new hard cap; the job keeps working.
      await updateJobMilestone({ jobDir, meta: await readJobMeta(jobDir), config: {}, milestoneIndex: 1, patch: { dueDate: "2026-12-01" } });
      await recordJobMilestonePayment({ jobDir, meta: await readJobMeta(jobDir), config: {}, milestoneIndex: 0, payment: { amount: deposit.total, date: "2026-10-10", reference: "SYN-1", method: "bank_transfer" } });
      const after = await readJobMeta(jobDir);
      assert.equal(after.paymentSchedule.source, undefined, "the schedule from before rules stays unmarked");
      assert.deepEqual(after.paymentSchedule.milestones, issued.paymentSchedule.milestones);
      const kept = after.milestoneInvoices[0];
      assert.equal(kept.invoiceNumber, deposit.invoiceNumber);
      assert.equal(kept.total, deposit.total);
      assert.deepEqual(kept.issuedRevision.lineItems, deposit.issuedRevision.lineItems);
      assert.equal(kept.issuedRevision.milestoneRule, undefined, "no rule record added to an issued invoice");
      assert.deepEqual(await readFile(join(jobDir, kept.pdfPath)), pdfBytes, "the PDF is byte for byte the same");
      const [rowAfter] = await withOrg(ISSUER.db, ISSUER.orgUid, (tx) => queryRows(sql`select number, subtotal, tax_total, total, issued_at from invoices where number = ${deposit.invoiceNumber}`, tx));
      assert.deepEqual(rowAfter, rowBefore, "the invoice row is as issued");
      const check = await readJobMilestoneRules({ jobDir, meta: after, config: {} });
      assert.deepEqual(check.milestones[0].findings, [], "an issued invoice shows only what was recorded with it");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
