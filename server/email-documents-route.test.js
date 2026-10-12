// Boots the real server (PGlite, the synthetic verification catalogue and the
// proof harness's offline Gmail, which writes each sent message to disk) and
// sends several Field documents in one email over HTTP:
//
//   - one Gmail message carries two stored documents whose attached bytes
//     hash to their recorded SHA-256, and each gets an `emailed` event with
//     the same Gmail message id;
//   - an invoice email carries the quote as well;
//   - another job's document, an unknown uid, a uid named twice, the email's
//     own document again and emails over the limits are refused before Gmail
//     is called (no message is written);
//   - a scheduled send dispatches the same stored bytes;
//   - a message over Gmail's JSON size goes through the media upload form.
//
// No customer data: the verification fixtures and @example.invalid only.
import test from "node:test";
import assert from "node:assert/strict";
import { VERIFICATION_FIXTURES } from "../scripts/verification/fixtures.js";
import { attachmentsOf, boot, CUSTOMER, MB, multipart, sha } from "../scripts/quote-invoice-proof/email-test-server.mjs";

// CI runs 8 test files at once on a small runner: this one boots a server,
// renders PDFs and waits for the schedule queue, so it gets room.
test("several Field documents go in one email, by uid, with their stored bytes", { timeout: 600_000 }, async (t) => {
  const started = Date.now();
  // Progress in the test output, so a slow CI run shows where the time went.
  const step = (label) => t.diagnostic(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
  const { api, mail, lastMail, output } = await boot(t);
  step("server up");
  const ok = (result, label) => assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}\n${output.join("").slice(-4000)}`);

  // Job A: a quote sent, the job landed and its deposit invoice sent.
  const a = await api("/api/jobs/manual", { method: "POST", body: { quoteCatalogId: "field-verification", siteAddress: VERIFICATION_FIXTURES[0].siteAddress } });
  ok(a, "create A");
  const aid = a.body.id;
  ok(await api(`/api/jobs/${aid}/quote-inputs`, { method: "PUT", body: VERIFICATION_FIXTURES[0].quoteInputs }), "inputs A");
  ok(await api(`/api/jobs/${aid}/quote-update`, { method: "POST", body: { lockStatus: "final" } }), "lock A");
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER } }), "send quote A");
  ok(await api(`/api/jobs/${aid}/landed`, { method: "POST" }), "land A");
  ok(await api(`/api/jobs/${aid}/milestones/generate`, { method: "POST", body: { paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Completion", percentage: 50 }] } } }), "milestones A");
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0 } }), "send invoice A");
  step("job A sent");
  // Job B: another job's quote.
  const b = await api("/api/jobs/manual", { method: "POST", body: { quoteCatalogId: "field-verification", siteAddress: VERIFICATION_FIXTURES[3].siteAddress } });
  ok(b, "create B");
  ok(await api(`/api/jobs/${b.body.id}/quote-inputs`, { method: "PUT", body: VERIFICATION_FIXTURES[3].quoteInputs }), "inputs B");
  ok(await api(`/api/jobs/${b.body.id}/email-quote`, { method: "POST", body: { to: CUSTOMER } }), "send quote B");

  step("job B sent");
  // The listing: size, status and what is not issued yet.
  const listed = await api(`/api/jobs/${aid}/documents`);
  ok(listed, "documents A");
  const quote = listed.body.documents.find((document) => document.documentType === "quote");
  const invoice = listed.body.documents.find((document) => document.documentType === "invoice");
  assert.ok(quote && invoice, JSON.stringify(listed.body.documents.map((document) => document.number)));
  assert.equal(quote.status, "accepted", "the landed job's quote version is accepted");
  assert.equal(invoice.status, "issued");
  assert.ok(quote.byteLength > 1000 && invoice.byteLength > 1000, "sizes are listed");
  assert.deepEqual(listed.body.notIssued.map((entry) => entry.milestoneIndex), [1], "the completion invoice is still a draft");
  const otherQuote = (await api(`/api/jobs/${b.body.id}/documents`)).body.documents.find((document) => document.documentType === "quote");
  assert.ok(otherQuote);

  step("listed");
  // 1. A job email with the quote and the invoice: one message, two PDFs.
  const sent = await api(`/api/jobs/${aid}/email`, { method: "POST", body: { to: CUSTOMER, subject: "Your documents", customBody: "<p>Hi,</p>", documents: [{ uid: quote.uid }, { uid: invoice.uid }] } });
  ok(sent, "job email with two documents");
  let attached = attachmentsOf(await lastMail());
  assert.deepEqual(attached.map((entry) => entry.filename), [`${quote.number}.pdf`, `${invoice.number}.pdf`]);
  assert.deepEqual(attached.map((entry) => sha(entry.bytes)), [quote.pdfSha256, invoice.pdfSha256], "the attached bytes are the stored bytes");
  assert.deepEqual(sent.body.result.attachments.map((entry) => [entry.source, entry.uid, entry.sha256]), [["document", quote.uid, quote.pdfSha256], ["document", invoice.uid, invoice.pdfSha256]]);
  let documents = (await api(`/api/jobs/${aid}/documents`)).body.documents;
  for (const uid of [quote.uid, invoice.uid]) {
    const emailed = documents.find((document) => document.uid === uid).events
      .filter((event) => event.event === "emailed" && event.data.messageId === sent.body.result.id);
    assert.equal(emailed.length, 1, `${uid} has one emailed event for the message`);
    assert.equal(emailed[0].data.role, "attachment");
    assert.equal(emailed[0].data.pdfSha256, uid === quote.uid ? quote.pdfSha256 : invoice.pdfSha256);
  }

  step("job email sent");
  // 2. The invoice email carries the quote as well, after the invoice.
  const invoiceEmail = await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0, documents: [{ uid: quote.uid }] } });
  ok(invoiceEmail, "invoice with the quote");
  attached = attachmentsOf(await lastMail());
  assert.equal(attached.length, 2);
  assert.equal(sha(attached[1].bytes), quote.pdfSha256);
  documents = (await api(`/api/jobs/${aid}/documents`)).body.documents;
  const quoteEmails = documents.find((document) => document.uid === quote.uid).events.filter((event) => event.event === "emailed" && event.data.role === "attachment");
  assert.equal(quoteEmails.length, 2);
  assert.equal(quoteEmails[1].data.withDocument?.number, invoice.number, "the event names the document it went with");

  step("invoice email sent");
  // 3. Refused before Gmail: nothing new is written.
  const before = (await mail()).length;
  const refusals = [
    [{ documents: [{ uid: otherQuote.uid }] }, 409, "DOCUMENT_OF_ANOTHER_JOB"],
    [{ documents: [{ uid: "doc_01ARZ3NDEKTSV4RRFFQ69G5FAV" }] }, 404, "DOCUMENT_NOT_FOUND"],
    [{ documents: [{ uid: quote.uid }, { uid: quote.uid }] }, 400, "EMAIL_DOCUMENT_TWICE"],
    [{ documents: ["not-a-uid"] }, 400, "EMAIL_DOCUMENTS_INVALID"],
  ];
  for (const [extra, status, code] of refusals) {
    const refused = await api(`/api/jobs/${aid}/email`, { method: "POST", body: { to: CUSTOMER, subject: "Refused", customBody: "<p>x</p>", ...extra } });
    assert.equal(refused.status, status, JSON.stringify(refused.body));
    assert.equal(refused.body.code, code);
  }
  const twice = await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0, documents: [{ uid: invoice.uid }] } });
  assert.equal(twice.status, 409, JSON.stringify(twice.body));
  assert.equal(twice.body.code, "EMAIL_DOCUMENT_TWICE");
  const big = (name, size) => ({ name, bytes: Buffer.alloc(size, 7) });
  const overTotal = await api(`/api/jobs/${aid}/email`, { method: "POST", form: multipart({ to: CUSTOMER, subject: "Too big", customBody: "<p>x</p>", documents: [{ uid: quote.uid }] }, [big("a.bin", 9 * MB), big("b.bin", 9 * MB)]) });
  assert.equal(overTotal.status, 413, JSON.stringify(overTotal.body));
  assert.equal(overTotal.body.code, "EMAIL_TOO_LARGE");
  assert.equal(overTotal.body.limitBytes, 18 * MB);
  const overOne = await api(`/api/jobs/${aid}/email`, { method: "POST", form: multipart({ to: CUSTOMER, subject: "Too big", customBody: "<p>x</p>" }, [big("c.bin", 10 * MB + 1)]) });
  assert.equal(overOne.status, 413, JSON.stringify(overOne.body));
  assert.equal(overOne.body.code, "EMAIL_UPLOAD_TOO_LARGE");
  const tooMany = await api(`/api/jobs/${aid}/email`, { method: "POST", form: multipart({ to: CUSTOMER, subject: "Too many", customBody: "<p>x</p>", documents: [{ uid: quote.uid }] }, Array.from({ length: 10 }, (_, index) => big(`n${index}.txt`, 10))) });
  assert.equal(tooMany.status, 413, JSON.stringify(tooMany.body));
  assert.equal(tooMany.body.code, "EMAIL_TOO_MANY_ATTACHMENTS");
  assert.equal((await mail()).length, before, "no refused email reached Gmail");

  step("refusals checked");
  // A refusal leaves sending working.
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0 } }), "send after refusals");

  step("sent after refusals");
  // 4. Over Gmail's JSON size: the media upload form, bytes intact.
  const photo = big("site-photo.jpg", 6 * MB);
  const large = await api(`/api/jobs/${aid}/email`, { method: "POST", form: multipart({ to: CUSTOMER, subject: "Photo", customBody: "<p>x</p>", documents: [{ uid: invoice.uid }] }, [photo]) });
  ok(large, "large email");
  attached = attachmentsOf(await lastMail());
  assert.deepEqual(attached.map((entry) => sha(entry.bytes)), [invoice.pdfSha256, sha(photo.bytes)]);
  assert.equal(large.body.result.attachments[1].source, "upload");
  assert.equal(large.body.result.attachments[1].byteLength, 6 * MB);

  step("large email sent");
  // 5. A scheduled send stores the reference and dispatches the same bytes.
  // Well past the 30 second minimum: a loaded CI runner can take seconds to answer.
  const scheduledAt = new Date(Date.now() + 45_000).toISOString();
  const scheduled = await api(`/api/jobs/${aid}/email`, { method: "POST", body: { to: CUSTOMER, subject: "Scheduled documents", customBody: "<p>Later</p>", scheduledAt, documents: [{ uid: quote.uid }] } });
  assert.equal(scheduled.status, 202, JSON.stringify(scheduled.body));
  assert.deepEqual(scheduled.body.scheduledEmail.documents.map((entry) => entry.uid), [quote.uid]);
  const waitUntil = Date.now() + 180_000;
  let record = null;
  while (Date.now() < waitUntil) {
    record = (await api(`/api/jobs/${aid}/scheduled-emails`)).body.scheduledEmails.find((entry) => entry.id === scheduled.body.scheduledEmail.id);
    if (record?.status === "sent" || record?.status === "failed") break;
    await new Promise((wake) => setTimeout(wake, 1000));
  }
  assert.equal(record?.status, "sent", JSON.stringify(record));
  attached = attachmentsOf(await lastMail());
  assert.deepEqual(attached.map((entry) => sha(entry.bytes)), [quote.pdfSha256], "the scheduled email carried the stored bytes");
});
