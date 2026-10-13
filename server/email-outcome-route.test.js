// A job email whose send failed is sent again only when that cannot make a
// duplicate, over HTTP against the real server (offline Gmail with one Sent
// Mail per mailbox, synthetic data, two operators):
//
//   - a time-out after Gmail took the message is "unknown", not "Not sent";
//   - a resend within five minutes is refused (Gmail's search can lag);
//   - when another operator edits and sends it, Field searches the mailbox it
//     first went from, finds it, records what went the first time (not the
//     edit) and sends nothing;
//   - a network reset before Gmail took it: the resend finds nothing and sends
//     it once, from the first mailbox, with the first Message-ID;
//   - a mailbox Field cannot search refuses the resend and stays unknown;
//   - a Gmail 4xx is a rejection, which can be sent again without a check.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot, CUSTOMER, seedJobs } from "../scripts/quote-invoice-proof/email-test-server.mjs";

const sleep = (ms) => new Promise((wake) => setTimeout(wake, ms));
const BOB = { email: "bob.office@example.invalid", password: "email-outcome-test-password-bob", role: "admin", name: "Bob Office" };

test("a failed job email is sent again only after Sent Mail is checked in its first mailbox, unless Gmail rejected it", { timeout: 600_000 }, async (t) => {
  const { api, signIn, mail, lastMail, output, failNextSend, dataDir } = await boot(t, { extraUsers: [BOB] });
  const ok = (result, label) => assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}\n${output.join("").slice(-4000)}`);
  const bob = await signIn(BOB.email, BOB.password);
  const { aid } = await seedJobs(api, ok);
  const queued = async (id) => (await api(`/api/jobs/${aid}/scheduled-emails`)).body.scheduledEmails.find((entry) => entry.id === id);
  const settled = async (id) => {
    let record = null;
    for (const until = Date.now() + 60_000; Date.now() < until;) {
      record = await queued(id);
      if (record?.status === "sent" || record?.status === "failed") return record;
      await sleep(300);
    }
    return record;
  };
  const recordFile = (id) => join(dataDir, ".scheduled-emails", `${id}.json`);
  const stored = async (id) => JSON.parse(await readFile(recordFile(id), "utf8"));
  // Five minutes pass (the server's clock is real): move the failure back.
  const age = async (id, change = {}) => {
    const record = await stored(id);
    await writeFile(recordFile(id), JSON.stringify({ ...record, unknownFailureAt: new Date(Date.now() - 6 * 60_000).toISOString(), ...change }));
  };
  const messageIdOf = (mime) => mime.match(/\r\nMessage-ID: (<[^>\r\n]+>)\r\n/)?.[1] || null;
  const send = (as, body) => as(`/api/jobs/${aid}/email`, { method: "POST", body: { to: CUSTOMER, customBody: "<p>Gate code 4471</p>", holdSeconds: 0, ...body } });

  // 1. A time-out after Gmail took it, sent by the first operator.
  const beforeTimeout = (await mail()).length;
  await failNextSend({ mode: "timeout", deliver: true });
  const first = await send(api, { subject: "Gate code" });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  let record = await settled(first.body.scheduledEmail.id);
  assert.equal(record.status, "failed", JSON.stringify(record));
  assert.equal(record.deliveryOutcome, "unknown", "a time-out is not a rejection");
  assert.equal(record.resend, "checks-sent-mail");
  assert.equal(record.deliveryMailbox, "proof.sender@example.invalid");
  assert.equal((await mail()).length, beforeTimeout + 1, "Gmail had it");
  const timedOutId = messageIdOf(await lastMail());
  assert.match(timedOutId, /^<field-[0-9a-f-]+@example\.invalid>$/, "a job email carries Field's Message-ID");
  assert.equal((await stored(record.id)).deliveryMessageId, timedOutId, "stored before Gmail was called");

  // Bob edits it and sends it at once: refused, Gmail may still be delivering it.
  ok(await bob(`/api/jobs/${aid}/email-drafts`, { method: "POST", body: { draftId: record.id, to: [CUSTOMER], subject: "Gate code, edited by Bob", customBody: "<p>Gate code 9999</p>" } }), "Bob edits");
  const tooSoon = await send(bob, { subject: "Gate code, edited by Bob", customBody: "<p>Gate code 9999</p>", draftId: record.id });
  assert.equal(tooSoon.status, 409, JSON.stringify(tooSoon.body));
  assert.equal(tooSoon.body.code, "DELIVERY_STILL_SETTLING");
  assert.equal(tooSoon.body.error, "Gmail may still be delivering this email. Try again in a few minutes.");

  // Five minutes on, Bob sends it: the first mailbox is searched, not Bob's.
  await age(record.id);
  const archiveBefore = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails.length;
  const again = await send(bob, { subject: "Gate code, edited by Bob", customBody: "<p>Gate code 9999</p>", draftId: record.id });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  record = await settled(record.id);
  assert.equal(record.status, "sent", JSON.stringify(record));
  assert.equal(record.reconciled, true, "the operator is told it had already gone");
  assert.equal((await mail()).length, beforeTimeout + 1, "found in the first mailbox's Sent Mail: not sent twice");
  const archive = (await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails;
  assert.equal(archive.length, archiveBefore + 1);
  assert.equal(archive[0].reconciled, true);
  assert.equal(archive[0].subject, "Gate code", "the archive keeps what went, not Bob's edit");
  assert.match(archive[0].htmlBody, /Gate code 4471/);
  assert.equal(archive[0].gmailUser, "proof.sender@example.invalid");

  // 2. A network reset before Gmail took it; Bob sends it again later.
  const beforeReset = (await mail()).length;
  await failNextSend({ mode: "reset" });
  const reset = await send(api, { subject: "Site access" });
  record = await settled(reset.body.scheduledEmail.id);
  assert.equal(record.status, "failed");
  assert.equal(record.deliveryOutcome, "unknown", "a reset is not a rejection");
  assert.equal((await mail()).length, beforeReset);
  const resetIdentity = await stored(record.id);
  await age(record.id);
  const resent = await send(bob, { subject: "Site access", draftId: record.id });
  assert.equal(resent.status, 202, JSON.stringify(resent.body));
  record = await settled(record.id);
  assert.equal(record.status, "sent", JSON.stringify(record));
  assert.equal(record.reconciled, false);
  assert.equal((await mail()).length, beforeReset + 1, "not in Sent Mail: sent once");
  const resetMime = await lastMail();
  assert.equal(messageIdOf(resetMime), resetIdentity.deliveryMessageId, "the first Message-ID, so a later search finds it");
  assert.equal((await api(`/api/jobs/${aid}/sent-emails`)).body.sentEmails[0].gmailUser, "proof.sender@example.invalid", "sent from the first mailbox, not Bob's");

  // 3. A mailbox Field cannot search: the resend is refused, and it stays unknown.
  await failNextSend({ mode: "reset" });
  const lost = await send(api, { subject: "Plant hire" });
  record = await settled(lost.body.scheduledEmail.id);
  await age(record.id, { deliveryMailbox: "former.staff@example.invalid" });
  const beforeLost = (await mail()).length;
  ok(await send(bob, { subject: "Plant hire", draftId: record.id }), "resend");
  record = await settled(record.id);
  assert.equal(record.status, "failed");
  assert.equal(record.deliveryOutcome, "unknown");
  assert.equal(record.checksSentMail, true);
  assert.match(record.lastError, /cannot reach former\.staff@example\.invalid/);
  assert.equal((await mail()).length, beforeLost, "nothing sent");

  // 4. Gmail rejected it (4xx): it can be sent again with no check.
  await failNextSend({ mode: "status", status: 400 });
  const rejected = await send(api, { subject: "Rejected" });
  record = await settled(rejected.body.scheduledEmail.id);
  assert.equal(record.status, "failed");
  assert.equal(record.deliveryOutcome, "rejected");
  assert.equal(record.resend, "allowed");
  assert.equal(record.checksSentMail, false);

  // A draft id that is not one is refused before it becomes a path.
  const traversal = await api(`/api/jobs/${aid}/email-drafts`, { method: "POST", body: { draftId: "../../config", to: [CUSTOMER], subject: "x" } });
  assert.equal(traversal.status, 404, JSON.stringify(traversal.body));
});
