// Undo send, saved drafts, Send a test to me and the sent record, over HTTP
// against the real server (offline Gmail, synthetic data):
//
//   - Send holds the email for seconds in the schedule queue; Undo (Cancel
//     send) within the hold leaves no Gmail message, no issued document and
//     no event, and the email is a draft again;
//   - a held send that is not undone goes out by itself, with no further
//     request from the browser (a closed tab still sends);
//   - a test goes only to the signed-in person, "[Test]" in the subject, with
//     the draft invoice as a PREVIEW copy, and issues and records nothing;
//   - a draft is saved on the server with its uploads, which can be removed,
//     and is sent from there;
//   - the sent record keeps Bcc (#51) and the document the email was for.
import test from "node:test";
import assert from "node:assert/strict";
import { attachmentsOf, boot, CUSTOMER, mimeParts, multipart, seedJobs, sha } from "../scripts/quote-invoice-proof/email-test-server.mjs";

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));

test("undo send, test send, server drafts and the sent record", { timeout: 600_000 }, async (t) => {
  const started = Date.now();
  const step = (label) => t.diagnostic(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
  const { api, mail, lastMail, output } = await boot(t);
  const ok = (result, label) => assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}\n${output.join("").slice(-4000)}`);
  const { aid } = await seedJobs(api, ok);
  step("jobs seeded");
  const documentsNow = async () => (await api(`/api/jobs/${aid}/documents`)).body.documents;
  const eventCount = (documents) => documents.reduce((sum, document) => sum + document.events.length, 0);
  const queued = async (id) => (await api(`/api/jobs/${aid}/scheduled-emails`)).body.scheduledEmails.find((entry) => entry.id === id);

  // 1. Undo: the completion invoice (a draft) held for 10 seconds, then undone.
  const beforeMail = (await mail()).length;
  const beforeDocuments = await documentsNow();
  const held = await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 1, subject: "Completion", customBody: "<p>Hi</p>", holdSeconds: 10 } });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  assert.equal(held.body.held, true);
  assert.equal(held.body.scheduledEmail.held, true);
  assert.ok(Date.parse(held.body.scheduledEmail.scheduledAt) - Date.now() <= 10_500, "due in ten seconds, not the 30 second schedule minimum");
  const undone = await api(`/api/jobs/${aid}/scheduled-emails/${held.body.scheduledEmail.id}`, { method: "DELETE" });
  ok(undone, "undo");
  assert.equal(undone.body.scheduledEmail.status, "draft");
  await sleep(14_000);
  assert.equal((await mail()).length, beforeMail, "no Gmail message");
  const afterUndo = await documentsNow();
  assert.equal(afterUndo.length, beforeDocuments.length, "no document issued");
  assert.equal(eventCount(afterUndo), eventCount(beforeDocuments), "no event written");
  const detail = (await api(`/api/jobs/${aid}`)).body;
  assert.equal(detail.meta.milestoneInvoices.find((entry) => entry.milestoneIndex === 1).status, "draft", "the invoice is still a draft");
  assert.equal((await queued(held.body.scheduledEmail.id)).status, "draft");
  step("undo proved");

  // 2. Send a test to me: the draft invoice as a preview copy, to me only.
  const testSend = await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, cc: ["office@example.invalid"], documentType: "invoice", milestoneIndex: 1, subject: "Invoice {{documentNumber}}", customBody: "<p>Hi</p>", test: true } });
  ok(testSend, "test send");
  const testMime = await lastMail();
  assert.match(testMime, /\r\nTo: proof\.sender@example\.invalid\r\n/, "only to the signed-in person");
  assert.doesNotMatch(testMime, /\r\nCc: /);
  assert.doesNotMatch(testMime, /\r\nMessage-ID: /, "no delivery attempt");
  assert.equal(mimeParts(testMime).subject, "[Test] Invoice [number when issued]");
  const previewCopy = attachmentsOf(testMime);
  assert.equal(previewCopy.length, 1);
  assert.match(previewCopy[0].filename, /^PREVIEW-/);
  const afterTest = await documentsNow();
  assert.equal(afterTest.length, beforeDocuments.length, "a test issues nothing");
  assert.equal(eventCount(afterTest), eventCount(beforeDocuments), "a test writes no event");
  assert.equal((await api(`/api/jobs/${aid}`)).body.meta.milestoneInvoices.find((entry) => entry.milestoneIndex === 1).status, "draft");
  const archiveBefore = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails.length;
  step("test send proved");

  // 3. A held send that is not undone goes out by itself.
  const quoteUid = afterTest.find((document) => document.documentType === "quote").uid;
  const goes = await api(`/api/jobs/${aid}/email`, { method: "POST", body: { to: CUSTOMER, bcc: ["accounts@example.invalid"], subject: "Site update", customBody: "<p>Update</p>", holdSeconds: 2, documents: [{ uid: quoteUid }] } });
  assert.equal(goes.status, 202, JSON.stringify(goes.body));
  let record = null;
  for (const until = Date.now() + 60_000; Date.now() < until;) {
    record = await queued(goes.body.scheduledEmail.id);
    if (record?.status === "sent" || record?.status === "failed") break;
    await sleep(500);
  }
  assert.equal(record?.status, "sent", JSON.stringify(record));
  assert.ok(Date.parse(record.sentAt) - Date.parse(goes.body.scheduledEmail.createdAt) < 30_000, "sent when the hold ended, not at the next poll");
  // The sent record keeps Bcc (#51).
  const archive = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails;
  assert.equal(archive.length, archiveBefore + 1);
  assert.deepEqual(archive[0].bcc, ["accounts@example.invalid"]);
  assert.equal(archive[0].attachments[0].uid, quoteUid);
  step("held send went out");

  // 4. A draft saved on the server with an upload; the upload removed; sent.
  const photo = { name: "site-photo.jpg", bytes: Buffer.from("synthetic photo bytes") };
  const saved = await api(`/api/jobs/${aid}/email-drafts`, { method: "POST", form: multipart({ to: [CUSTOMER], subject: "Draft", customBody: "<p>Draft</p>", documentType: "invoice", milestoneIndex: 0 }, [photo]) });
  ok(saved, "save draft");
  assert.equal(saved.body.scheduledEmail.status, "draft");
  assert.deepEqual(saved.body.scheduledEmail.attachments.map((entry) => [entry.filename, entry.size]), [["site-photo.jpg", photo.bytes.length]]);
  const draftId = saved.body.scheduledEmail.id;
  const resaved = await api(`/api/jobs/${aid}/email-drafts`, { method: "POST", body: { draftId, to: [CUSTOMER], subject: "Draft, edited", customBody: "<p>Draft</p>", documentType: "invoice", milestoneIndex: 0 } });
  ok(resaved, "save again");
  assert.equal(resaved.body.scheduledEmail.attachments.length, 1, "uploads are kept until removed");
  assert.equal(resaved.body.scheduledEmail.subject, "Draft, edited");
  const sentDraft = await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { draftId, to: CUSTOMER, documentType: "invoice", milestoneIndex: 0, subject: "Draft, edited", customBody: "<p>Draft</p>", holdSeconds: 0, keepAttachments: ["site-photo.jpg"] } });
  assert.equal(sentDraft.status, 202, JSON.stringify(sentDraft.body));
  for (const until = Date.now() + 60_000; Date.now() < until;) {
    record = await queued(draftId);
    if (record?.status === "sent" || record?.status === "failed") break;
    await sleep(500);
  }
  assert.equal(record?.status, "sent", JSON.stringify(record));
  const draftMail = attachmentsOf(await lastMail());
  assert.equal(sha(draftMail.at(-1).bytes), sha(photo.bytes), "the upload saved with the draft went out");
  const invoiceArchive = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails[0];
  assert.equal(invoiceArchive.mainDocument.documentType, "invoice");
  assert.match(invoiceArchive.mainDocument.number, /^INV-/);
  step("server draft sent");

  // Discard: a draft is cancelled and its uploads deleted.
  const another = await api(`/api/jobs/${aid}/email-drafts`, { method: "POST", form: multipart({ to: [CUSTOMER], subject: "Throwaway" }, [photo]) });
  ok(another, "another draft");
  const discarded = await api(`/api/jobs/${aid}/email-drafts/${another.body.scheduledEmail.id}`, { method: "DELETE" });
  ok(discarded, "discard");
  assert.equal(discarded.body.scheduledEmail.status, "cancelled");
  assert.deepEqual(discarded.body.scheduledEmail.attachments, []);
  // A hold longer than 30 seconds is refused.
  const tooLong = await api(`/api/jobs/${aid}/email`, { method: "POST", body: { to: CUSTOMER, subject: "x", holdSeconds: 31 } });
  assert.equal(tooLong.status, 400);
});
