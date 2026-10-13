// Sending into the earlier Gmail conversation, over HTTP against the real
// server (offline Gmail that joins a named thread, synthetic data):
//
//   - a follow-up for the same document line is offered with the earlier
//     email's conversation and a "Re:" subject;
//   - sending with inReplyTo carries In-Reply-To and References for the
//     earlier message's own Message-ID, names its Gmail thread, and the sent
//     record keeps the chain for the next reply;
//   - a reply to an email of another job, or to none, is refused.
import test from "node:test";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { boot, CUSTOMER, mimeParts, seedJobs } from "../scripts/quote-invoice-proof/email-test-server.mjs";

test("a follow-up joins the earlier Gmail conversation for the same document line", { timeout: 600_000 }, async (t) => {
  const { api, lastMail, output, dataDir } = await boot(t);
  const ok = (result, label) => assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}\n${output.join("").slice(-4000)}`);
  const { aid } = await seedJobs(api, ok);
  const [quoteEmail, invoiceEmail] = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails.reverse();
  assert.equal(invoiceEmail.documentType, "invoice");
  assert.match(invoiceEmail.rfcMessageId, /^<field-[0-9a-f-]+@example\.invalid>$/, "the sent record keeps the Message-ID it went with");

  // The deposit invoice's line: the earlier invoice email is offered.
  const context = await api(`/api/jobs/${aid}/email-context?documentType=invoice&milestoneIndex=0`);
  ok(context, "context");
  assert.equal(context.body.sendType, "invoice");
  assert.equal(context.body.thread.id, invoiceEmail.id);
  assert.equal(context.body.thread.headers, true);
  assert.equal(context.body.thread.replySubject, `Re: ${invoiceEmail.subject}`);
  assert.deepEqual(context.body.suggestions.map((entry) => [entry.documentType, entry.ticked]), [["quote", false]], "the accepted quote is offered, unticked");
  // The completion invoice is another line: nothing to continue yet.
  assert.equal((await api(`/api/jobs/${aid}/email-context?documentType=invoice&milestoneIndex=1`)).body.thread, null);
  // A quote line is the job's quote email.
  assert.equal((await api(`/api/jobs/${aid}/email-context?documentType=quote`)).body.thread.id, quoteEmail.id);

  // Send the reminder into that conversation.
  const reply = await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0, subject: context.body.thread.replySubject, customBody: "<p>A reminder.</p>", inReplyTo: invoiceEmail.id } });
  ok(reply, "reply");
  const mime = await lastMail();
  assert.match(mime, new RegExp(`\\r\\nIn-Reply-To: ${invoiceEmail.rfcMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r\\n`));
  assert.match(mime, new RegExp(`\\r\\nReferences: ${invoiceEmail.rfcMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r\\n`));
  assert.equal(mimeParts(mime).subject, `Re: ${invoiceEmail.subject}`);
  const [sent] = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails;
  assert.equal(sent.threadId, invoiceEmail.threadId, "Gmail put it in the earlier conversation");
  assert.equal(sent.references, invoiceEmail.rfcMessageId);

  // A second reply references the whole chain.
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0, subject: context.body.thread.replySubject, customBody: "<p>Again.</p>", inReplyTo: sent.id } }), "second reply");
  assert.match(await lastMail(), new RegExp(`\\r\\nReferences: ${invoiceEmail.rfcMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${sent.rfcMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r\\n`));

  // An earlier email from another mailbox: its Gmail thread id is that
  // mailbox's, so the reply threads by its headers and "Re:" alone.
  const archivePath = await findArchive(dataDir, invoiceEmail.id);
  await appendFile(archivePath, `${JSON.stringify({ id: "sent_other", ts: new Date().toISOString(), kind: "email.sent", documentType: "invoice", milestoneIndex: 0, threadId: "other-mailbox-thread", gmailUser: "accounts@example.invalid", rfcMessageId: "<field-other@example.invalid>", references: null, subject: invoiceEmail.subject, to: [CUSTOMER] })}\n`);
  ok(await api(`/api/jobs/${aid}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0, subject: context.body.thread.replySubject, customBody: "<p>From the office.</p>", inReplyTo: "sent_other" } }), "reply to another mailbox's email");
  assert.match(await lastMail(), /\r\nIn-Reply-To: <field-other@example\.invalid>\r\n/);
  const [crossMailbox] = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails;
  assert.notEqual(crossMailbox.threadId, "other-mailbox-thread", "another mailbox's thread id is not sent");

  // A reply to an email that is not this job's is refused.
  const unknown = await api(`/api/jobs/${aid}/email`, { method: "POST", body: { to: CUSTOMER, subject: "x", customBody: "<p>x</p>", inReplyTo: "sent_0" } });
  assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
  assert.equal(unknown.body.code, "REPLY_NOT_FOUND");
});

/** The sent-email archive that holds `id`, under the data directory. */
async function findArchive(dir, id) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findArchive(path, id);
      if (found) return found;
    } else if (entry.name === "sent-emails.jsonl" && (await readFile(path, "utf8")).includes(`"id":"${id}"`)) {
      return path;
    }
  }
  return null;
}
