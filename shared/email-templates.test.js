import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_MERGE_FIELD_KEYS,
  applyMergeFields,
  applyMergeFieldsToText,
  renderComposerTemplate,
  renderSignature,
} from "./email-templates.js";

const values = {
  clientName: "Dana Whitfield",
  jobTitle: "14 Copperleaf Rise",
  documentNumber: "INV-2026-10-2",
  amountDue: "$7,920.00",
  dueDate: null,
  senderName: "Jess Harlow",
  businessName: "Harlow Earthworks",
  milestoneLabel: "Progress claim",
  defaultSubject: "Invoice — INV-2026-10-2 — Progress claim",
};

test("merge fields are defined once, for every placeholder the composer offers", () => {
  assert.deepEqual(EMAIL_MERGE_FIELD_KEYS, ["clientName", "jobTitle", "siteAddress", "documentNumber", "amountDue", "dueDate", "replacesNumber", "creditNoteNumber", "attachmentList", "senderName", "businessName"]);
  for (const templates of Object.values(DEFAULT_EMAIL_TEMPLATES)) {
    for (const template of templates) assert.doesNotMatch(template.html, /Regards/, `${template.id}: the signature signs off`);
  }
});

test("a template for the composer marks its merge fields and fills the subject", () => {
  const rendered = renderComposerTemplate(DEFAULT_EMAIL_TEMPLATES.invoice[0], values);
  assert.equal(rendered.subject, "Invoice — INV-2026-10-2 — Progress claim");
  assert.match(rendered.html, /^<p>Hi <span data-merge="clientName">Dana Whitfield<\/span>,<\/p><p>Your progress claim invoice for <strong><span data-merge="jobTitle">14 Copperleaf Rise<\/span><\/strong> is ready\./);
  assert.equal(
    renderComposerTemplate({ html: "<p>Due {{dueDate}}</p>", subject: "Pay {{amountDue}} by {{dueDate}}" }, values).html,
    '<p>Due <span data-merge="dueDate">[Due date]</span></p>',
    "a field with no value yet shows its name while composing",
  );
  assert.equal(renderComposerTemplate({ subject: "Pay {{amountDue}} by {{dueDate}}" }, values).subject, "Pay $7,920.00 by {{dueDate}}");
});

test("the server fills merge fields again when it builds the email, escaped, and leaves none for the customer", () => {
  const body = '<p>Hi <span data-merge="clientName">old name</span>, pay <span data-merge="amountDue">?</span> by <span data-merge="dueDate">[Due date]</span>. {{documentNumber}} {{unknown}}</p>';
  assert.equal(
    applyMergeFields(body, { ...values, clientName: "Dana <b>&</b>" }),
    '<p>Hi <span data-merge="clientName">Dana &lt;b&gt;&amp;&lt;/b&gt;</span>, pay <span data-merge="amountDue">$7,920.00</span> by <span data-merge="dueDate">[Due date]</span>. INV-2026-10-2 {{unknown}}</p>',
  );
  assert.equal(
    applyMergeFields(body, values, { final: true }),
    '<p>Hi <span data-merge="clientName">Dana Whitfield</span>, pay <span data-merge="amountDue">$7,920.00</span> by <span data-merge="dueDate"></span>. INV-2026-10-2 {{unknown}}</p>',
  );
  assert.equal(applyMergeFieldsToText("Invoice {{documentNumber}} {{dueDate}}", values, { final: true }), "Invoice INV-2026-10-2");
  assert.equal(applyMergeFieldsToText("Invoice {{documentNumber}} {{dueDate}}", values), "Invoice INV-2026-10-2 {{dueDate}}");
});

test("the signature is the operator's own, or the default sign-off", () => {
  assert.equal(renderSignature(null, values), '<p>Regards,<br/><span data-merge="senderName">Jess Harlow</span><br/><span data-merge="businessName">Harlow Earthworks</span></p>');
  assert.equal(renderSignature("<p>Cheers, {{senderName}}</p>", values), '<p>Cheers, <span data-merge="senderName">Jess Harlow</span></p>');
});
