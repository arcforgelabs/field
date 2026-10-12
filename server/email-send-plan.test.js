// What each send type attaches by default and which conversation it joins
// (the proposal's table; decisions 2 and 5), and the replacement invoice's
// merge fields.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSendPlan } from "./email-send-plan.js";
import { buildEmailMergeValues } from "./email-merge-fields.js";
import { replySubject, threadFromRecord } from "./email-threads.js";
import { threadIdForMailbox } from "./send-quote-email.js";

const doc = (uid, documentType, number, extra = {}) => ({ uid: `doc_01JB8Z00000000000000000${uid}`, documentType, number, events: [], details: {}, ...extra });
const QUOTE = doc("0Q1", "quote", "EQ-2609-14 v2", { quoteVersion: 2 });
const OLD_INVOICE = doc("0I1", "invoice", "INV-2026-10-1", { details: { total: 8250 } });
const NEW_INVOICE = doc("0I2", "invoice", "INV-2026-10-2", { details: { total: 7920 } });
const NOTE = doc("0C1", "credit_note", "CN-2026-10-1", { details: { creditedInvoiceNumber: "INV-2026-10-1", replacementInvoiceNumber: "INV-2026-10-2" } });
const RECEIPT = doc("0R1", "receipt", "RCT-2026-10-1");
const META = { id: "job-1", title: "14 Copperleaf Rise", contactName: "Dana Whitfield", pipelineStage: "landed", quoteVersion: 2 };
const REPLACEMENT = {
  milestoneIndex: 0,
  milestoneLabel: "Progress claim",
  status: "authorised",
  total: 7920,
  amountPaid: 0,
  dueDate: "2026-10-27",
  issuedRevision: { invoiceNumber: "INV-2026-10-2", creditNoteNumber: "CN-2026-10-1", total: 7920 },
  revisionHistory: [{ invoiceNumber: "INV-2026-10-1", creditNote: { number: "CN-2026-10-1" } }],
};

async function withArchive(records, run) {
  const jobDir = await mkdtemp(join(tmpdir(), "field-send-plan-"));
  try {
    await writeFile(join(jobDir, "sent-emails.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
    return await run(jobDir);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}

const EARLIER_INVOICE_EMAIL = {
  id: "sent_1", ts: "2026-10-02T05:42:00.000Z", documentType: "invoice", milestoneIndex: 0, subject: "Invoice INV-2026-10-1 · 14 Copperleaf Rise",
  threadId: "thread-1", rfcMessageId: "<field-a@harlow.example.invalid>", references: null, to: ["dana@whitfieldbuild.example.invalid"],
  mainDocument: { documentType: "invoice", number: "INV-2026-10-1" },
};

test("a replacement invoice ticks its adjustment note, offers the accepted quote and joins the replaced invoice's conversation", async () => {
  await withArchive([EARLIER_INVOICE_EMAIL], async (jobDir) => {
    const plan = await buildSendPlan({
      jobDir,
      view: { documentType: "invoice", meta: META, quote: { version: 2 }, milestoneInvoice: REPLACEMENT },
      meta: META,
      documents: [QUOTE, OLD_INVOICE, NOTE, NEW_INVOICE],
    });
    assert.equal(plan.sendType, "replacement-invoice");
    assert.deepEqual(plan.suggestions.map((entry) => [entry.number, entry.ticked]), [["CN-2026-10-1", true], ["EQ-2609-14 v2", false]]);
    assert.deepEqual(plan.replacement, { creditNoteNumber: "CN-2026-10-1", creditNoteUid: NOTE.uid, replacesNumber: "INV-2026-10-1", replacesTotal: 8250, total: 7920 });
    assert.equal(plan.thread.id, "sent_1");
    assert.equal(plan.thread.headers, true);
  });
});

test("the other send types: invoice, receipt, quote, revised quote, adjustment note alone, job email", async () => {
  await withArchive([EARLIER_INVOICE_EMAIL, { ...EARLIER_INVOICE_EMAIL, id: "sent_0", documentType: "quote", milestoneIndex: null, threadId: "thread-0" }], async (jobDir) => {
    const plan = (view, extra = {}) => buildSendPlan({ jobDir, view: { meta: META, quote: { version: 2 }, milestoneInvoice: null, ...view }, meta: META, documents: [QUOTE, OLD_INVOICE, NOTE, NEW_INVOICE, RECEIPT], ...extra });
    const invoice = await plan({ documentType: "invoice", milestoneInvoice: { milestoneIndex: 1, status: "draft", issuedRevision: null } });
    assert.equal(invoice.sendType, "invoice");
    assert.deepEqual(invoice.suggestions.map((entry) => [entry.number, entry.ticked]), [["EQ-2609-14 v2", false]]);
    assert.equal(invoice.thread, null, "another milestone is another line");
    const receipt = await plan({ documentType: "receipt", milestoneInvoice: { milestoneIndex: 0, issuedRevision: { invoiceNumber: "INV-2026-10-2" } } });
    assert.deepEqual(receipt.suggestions.map((entry) => [entry.number, entry.ticked]), [["INV-2026-10-2", false]]);
    assert.equal(receipt.thread.id, "sent_1", "a receipt follows its invoice's conversation");
    const quote = await plan({ documentType: "quote", quote: { version: 1 } });
    assert.equal(quote.sendType, "quote");
    assert.deepEqual(quote.suggestions, []);
    assert.equal(quote.thread.id, "sent_0");
    assert.equal((await plan({ documentType: "quote", quote: { version: 3 } })).sendType, "revised-quote");
    const note = await plan({ documentType: null }, { purpose: "adjustment-note", creditNoteNumber: "CN-2026-10-1" });
    assert.equal(note.sendType, "adjustment-note");
    assert.deepEqual(note.suggestions.map((entry) => [entry.number, entry.ticked]), [["CN-2026-10-1", true], ["INV-2026-10-1", false]]);
    assert.equal(note.thread.id, "sent_1", "it joins the credited invoice's conversation");
    const email = await plan({ documentType: null });
    assert.equal(email.sendType, "email");
    assert.deepEqual(email.suggestions, []);
    assert.equal(email.thread, null);
  });
});

test("the replacement invoice's merge fields name the invoice it replaces and its adjustment note", () => {
  const values = buildEmailMergeValues({ meta: META, quote: { quoteNumber: "EQ-2609-14" }, documentType: "invoice", milestoneInvoice: REPLACEMENT, config: {} });
  assert.equal(values.documentNumber, "INV-2026-10-2");
  assert.equal(values.replacesNumber, "INV-2026-10-1");
  assert.equal(values.creditNoteNumber, "CN-2026-10-1");
  assert.equal(values.amountDue, "$7,920.00");
  assert.equal(values.dueDate, "27 October 2026");
  const note = buildEmailMergeValues({ meta: META, config: {}, adjustmentNote: { creditNoteNumber: "CN-2026-10-1", replacesNumber: "INV-2026-10-1", replacementNumber: "INV-2026-10-2" } });
  assert.deepEqual([note.creditNoteNumber, note.replacesNumber, note.documentNumber], ["CN-2026-10-1", "INV-2026-10-1", "INV-2026-10-2"]);
});

test("thread fields: In-Reply-To the earlier Message-ID, References the whole chain, a Re: subject", () => {
  assert.deepEqual(threadFromRecord({ id: "sent_2", threadId: "t", rfcMessageId: "<b@field.invalid>", references: "<a@field.invalid>" }), { threadId: "t", inReplyTo: "<b@field.invalid>", references: "<a@field.invalid> <b@field.invalid>", archiveId: "sent_2", gmailUser: null });
  assert.deepEqual(threadFromRecord({ id: "sent_1", threadId: "t", rfcMessageId: null }), { threadId: "t", inReplyTo: null, references: null, archiveId: "sent_1", gmailUser: null }, "an email from before Field kept its Message-ID threads by thread id alone");
  assert.equal(threadFromRecord({ id: "x", threadId: null }), null);
  // Gmail's thread id is used only from the mailbox that owns it.
  const thread = threadFromRecord({ id: "sent_3", threadId: "t3", gmailUser: "Office@Example.invalid", rfcMessageId: "<c@field.invalid>" });
  assert.equal(threadIdForMailbox(thread, "office@example.invalid"), "t3");
  assert.equal(threadIdForMailbox(thread, "accounts@example.invalid"), null);
  assert.equal(threadIdForMailbox({ threadId: "t4", gmailUser: null }, "office@example.invalid"), null, "an earlier email with no recorded mailbox threads by headers alone");
  assert.equal(replySubject("Re: RE: Invoice INV-1"), "Re: Invoice INV-1");
});
