// The composer's server side, over HTTP against the real server (offline
// Gmail, synthetic data):
//
//   - GET /email-context gives the templates, merge-field values, default
//     subject, the operator's signature and the job's people;
//   - POST /email-preview builds exactly the HTML and subject the send then
//     sends, for a job email and for an invoice email;
//   - merge fields are filled by the server when the email is built: a draft
//     invoice's number, unknown in the composer, is the number the send issues;
//   - each operator's signature is their own.
import test from "node:test";
import assert from "node:assert/strict";
import { boot, CUSTOMER, mimeParts, seedJobs } from "../scripts/quote-invoice-proof/email-test-server.mjs";

test("the composer's context and preview, and merge fields filled at send", { timeout: 600_000 }, async (t) => {
  const { api, lastMail, output } = await boot(t);
  const ok = (result, label) => assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}\n${output.join("").slice(-4000)}`);
  const { aid } = await seedJobs(api, ok);
  ok(await api(`/api/jobs/${aid}/details`, { method: "PATCH", body: { key: "contact.email", value: "dana@whitfield.example.invalid" } }), "contact email");
  ok(await api(`/api/jobs/${aid}/details`, { method: "PATCH", body: { key: "contact.name", value: "Dana Whitfield" } }), "contact name");

  // Context for the completion invoice, still a draft.
  const context = await api(`/api/jobs/${aid}/email-context?documentType=invoice&milestoneIndex=1`);
  ok(context, "context");
  assert.equal(context.body.documentType, "invoice");
  assert.equal(context.body.milestoneIndex, 1);
  assert.match(context.body.defaultSubject, /^Invoice — \{\{documentNumber\}\} — Completion$/, "a draft invoice's number is a merge field until it is issued");
  assert.deepEqual(context.body.templates.map((template) => template.id), ["standard", "payment", "friendly"]);
  assert.ok(context.body.templates.every((template) => !/Regards/.test(template.html)), "templates leave the sign-off to the signature");
  assert.equal(context.body.mergeValues.clientName, "Dana Whitfield");
  assert.equal(context.body.mergeValues.documentNumber, null);
  assert.match(context.body.mergeValues.amountDue, /^\$[\d,]+\.\d\d$/);
  assert.ok(context.body.mergeFields.some((field) => field.key === "dueDate"));
  assert.equal(context.body.signature.isDefault, true);
  assert.deepEqual(context.body.jobContacts.map((entry) => [entry.email, entry.source]), [["dana@whitfield.example.invalid", "job"], [CUSTOMER, "sent"]]);
  assert.deepEqual(context.body.deliveryPolicy, { mode: "live" });
  assert.equal(context.body.from.email, "proof.sender@example.invalid");

  // The preview of a job email is the HTML the send sends.
  const jobEmail = {
    subject: "Site update for {{clientName}}",
    customBody: '<p>Hi <span data-merge="clientName">someone</span>,</p><p>The cut is finished at <span data-merge="siteAddress">x</span>.</p><ul><li><b>Bold</b> and <a href="https://example.invalid/plan">the plan</a></li></ul>',
  };
  const jobPreview = await api(`/api/jobs/${aid}/email-preview`, { method: "POST", body: { ...jobEmail, to: [CUSTOMER] } });
  ok(jobPreview, "job email preview");
  assert.equal(jobPreview.body.subject, "Site update for Dana Whitfield");
  assert.equal((await api(`/api/jobs/${aid}/email-context`)).body.mergeValues.businessName, "Field Verification", "a job email signs for the business on the job's quote");
  assert.match(jobPreview.body.html, /Hi <span>Dana Whitfield<\/span>,/);
  ok(await api(`/api/jobs/${aid}/email`, { method: "POST", body: { ...jobEmail, to: CUSTOMER } }), "job email");
  let sent = mimeParts(await lastMail());
  assert.equal(sent.subject, jobPreview.body.subject);
  assert.equal(sent.html, jobPreview.body.html, "the preview's HTML is the sent HTML");

  // The preview of the deposit invoice (issued) is the HTML its resend sends.
  // The deposit has no due date: a field with no value is left out, never sent as a placeholder.
  const invoiceEmail = { documentType: "invoice", milestoneIndex: 0, subject: "Invoice {{documentNumber}} {{dueDate}}", customBody: '<p>Amount due: <span data-merge="amountDue">?</span>. Due <span data-merge="dueDate">[Due date]</span></p>' };
  const invoicePreview = await api(`/api/jobs/${aid}/email-preview`, { method: "POST", body: invoiceEmail });
  ok(invoicePreview, "invoice preview");
  assert.match(invoicePreview.body.subject, /^Invoice INV-\d{4}-\d{1,2}-\d+$/);
  assert.match(invoicePreview.body.html, /Amount due: <span>\$[\d,]+\.\d\d<\/span>\. Due <span><\/span>/);
  assert.equal(invoicePreview.body.attachments[0].source, "main");
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { ...invoiceEmail, to: CUSTOMER } }), "invoice resend");
  sent = mimeParts(await lastMail());
  assert.equal(sent.subject, invoicePreview.body.subject);
  assert.equal(sent.html, invoicePreview.body.html, "the preview's HTML is the sent HTML");

  // A draft invoice: the composer cannot know its number; the send fills it
  // with the number it issues.
  const draftPreview = await api(`/api/jobs/${aid}/email-preview`, { method: "POST", body: { documentType: "invoice", milestoneIndex: 1, subject: context.body.defaultSubject, customBody: '<p>Invoice <span data-merge="documentNumber">[Document number]</span></p>' } });
  ok(draftPreview, "draft invoice preview");
  assert.equal(draftPreview.body.subject, "Invoice — [number when issued] — Completion");
  assert.equal(draftPreview.body.attachments[0].filename, "Invoice PDF, named when it is issued");
  assert.equal(draftPreview.body.pending.length, 1);
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 1, subject: context.body.defaultSubject, customBody: '<p>Invoice <span data-merge="documentNumber">[Document number]</span></p>' } }), "draft invoice send");
  sent = mimeParts(await lastMail());
  const issued = sent.subject.match(/^Invoice — (INV-\d{4}-\d{1,2}-\d+) — Completion$/);
  assert.ok(issued, `the subject names the issued number: ${sent.subject}`);
  assert.match(sent.html, new RegExp(`Invoice <span>${issued[1]}</span>`));
  const documents = (await api(`/api/jobs/${aid}/documents`)).body.documents;
  assert.ok(documents.some((document) => document.documentType === "invoice" && document.number === issued[1]), "that is the invoice the send issued");

  // Signatures are each person's own.
  const before = await api("/api/settings/email-signature");
  assert.equal(before.body.signature.isDefault, true);
  const saved = await api("/api/settings/email-signature", { method: "PUT", body: { html: "<p>Cheers,<br/>{{senderName}}</p><script>alert(1)</script>" } });
  ok(saved, "save signature");
  assert.match(saved.body.signature.html, /^<p[^>]*>Cheers,<br\/>\{\{senderName\}\}<\/p>$/, "kept, sanitised: no script");
  assert.equal((await api(`/api/jobs/${aid}/email-context`)).body.signature.html, saved.body.signature.html);
  const reset = await api("/api/settings/email-signature", { method: "PUT", body: { html: "" } });
  assert.equal(reset.body.signature.isDefault, true);
});
