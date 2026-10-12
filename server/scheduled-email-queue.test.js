import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { withGmailSendCeiling } from "./send-quote-email.js";
import {
  classifyDeliveryFailure,
  createScheduledEmail,
  listScheduledEmails,
  processDueScheduledEmails,
  recoverInterruptedScheduledEmails,
  rescheduleEmailDraft,
  returnScheduledEmailToDraft,
  saveEmailDraft,
  sendEmailDraftNow,
  validateScheduledAt,
} from "./scheduled-email-queue.js";
import { installDurableStore } from "./storage/durable-hooks.js";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "field-scheduled-email-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("validateScheduledAt rejects invalid and near-past values", () => {
  assert.throws(() => validateScheduledAt("not-a-date", { now: 1_000 }), /valid send date/);
  assert.throws(
    () => validateScheduledAt(new Date(20_000).toISOString(), { now: 1_000 }),
    /at least 30 seconds/,
  );
  assert.equal(
    validateScheduledAt(new Date(40_000).toISOString(), { now: 1_000 }),
    new Date(40_000).toISOString(),
  );
});

test("scheduled email persists its pinned payload and attachment across a restart", async () => {
  await withTempDir(async (dataDir) => {
    const now = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({
      dataDir,
      jobId: "job-1",
      scheduledAt: "2026-08-25T11:00:00.000Z",
      payload: {
        to: ["client@example.com"],
        cc: ["office@example.com"],
        bcc: ["archive@example.com"],
        subject: "Pinned",
        customBody: "<p>Scheduled message</p>",
        themeFontFamily: "Geist",
        documentType: "quote",
      },
      snapshot: { quoteVersion: 7 },
      attachments: [{ filename: "plan.pdf", contentType: "application/pdf", buffer: Buffer.from("pdf") }],
      now,
    });

    assert.equal(created.status, "pending");
    assert.equal(created.quoteVersion, 7);
    assert.deepEqual(created.cc, ["office@example.com"]);
    assert.deepEqual(created.bcc, ["archive@example.com"]);
    assert.deepEqual(created.attachmentNames, ["plan.pdf"]);
    assert.equal(created.previewBodyHtml, "<p>Scheduled message</p>");
    assert.equal(created.previewThemeFontFamily, "Geist");
    assert.deepEqual(await listScheduledEmails({ dataDir, jobId: "job-1" }), [created]);

    let received;
    await processDueScheduledEmails({
      dataDir,
      now: Date.parse("2026-08-25T11:00:01.000Z"),
      processEmail: async (record) => {
        received = record;
        return { id: "gmail-1", threadId: "thread-1" };
      },
    });
    assert.equal(received.snapshot.quoteVersion, 7);
    assert.equal(received.loadedAttachments[0].buffer.toString(), "pdf");
    const [sent] = await listScheduledEmails({ dataDir, jobId: "job-1" });
    assert.equal(sent.status, "sent");
    assert.equal(sent.attemptCount, 1);
    assert.equal(sent.previewBodyHtml, null);
    assert.equal(sent.previewThemeFontFamily, null);
  });
});

test("cancelling a schedule returns the complete email to drafts and it is never processed", async () => {
  await withTempDir(async (dataDir) => {
    const now = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({
      dataDir,
      jobId: "job-2",
      scheduledAt: "2026-08-25T11:00:00.000Z",
      payload: { to: ["client@example.com"], subject: "Cancel", customBody: "<p>Keep me</p>" },
      now,
    });
    const draft = await returnScheduledEmailToDraft({
      dataDir,
      jobId: "job-2",
      id: created.id,
      updatedBy: { id: "user-1" },
      now: now + 60_000,
    });
    assert.equal(draft.status, "draft");
    assert.equal(draft.lifecycleStatus, "draft");
    assert.equal(draft.subject, "Cancel");
    assert.equal(draft.draftContent.customBody, "<p>Keep me</p>");

    let calls = 0;
    await processDueScheduledEmails({
      dataDir,
      now: Date.parse("2026-08-25T12:00:00.000Z"),
      processEmail: async () => { calls += 1; },
    });
    assert.equal(calls, 0);
  });
});

test("a draft can be rescheduled in place without duplicating its retained attachments", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({
      dataDir,
      jobId: "job-draft",
      scheduledAt: new Date(start + 60_000).toISOString(),
      payload: { kind: "email", to: ["client@example.com"], subject: "Before", customBody: "<p>Before</p>" },
      attachments: [{ filename: "original.txt", contentType: "text/plain", buffer: Buffer.from("original") }],
      now: start,
    });
    await returnScheduledEmailToDraft({ dataDir, jobId: "job-draft", id: created.id, now: start + 1_000 });
    const scheduled = await rescheduleEmailDraft({
      dataDir,
      jobId: "job-draft",
      id: created.id,
      scheduledAt: new Date(start + 120_000).toISOString(),
      payload: { kind: "email", to: ["client@example.com"], subject: "After", customBody: "<p>After</p>" },
      attachments: [{ filename: "added.txt", contentType: "text/plain", buffer: Buffer.from("added") }],
      now: start + 2_000,
    });

    assert.equal(scheduled.id, created.id);
    assert.equal(scheduled.status, "pending");
    assert.equal(scheduled.lifecycleStatus, "scheduled");
    assert.equal(scheduled.subject, "After");
    assert.deepEqual(scheduled.attachmentNames, ["original.txt", "added.txt"]);
    assert.equal((await listScheduledEmails({ dataDir, jobId: "job-draft" })).length, 1);
  });
});

test("editing cannot race with a draft send that has already been claimed", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({
      dataDir,
      jobId: "job-race",
      scheduledAt: new Date(start + 60_000).toISOString(),
      payload: { kind: "email", to: ["client@example.com"], subject: "Race" },
      now: start,
    });
    await returnScheduledEmailToDraft({ dataDir, jobId: "job-race", id: created.id, now: start + 1_000 });

    let release;
    const processing = new Promise((resolve) => { release = resolve; });
    const sending = sendEmailDraftNow({
      dataDir,
      jobId: "job-race",
      id: created.id,
      payload: { kind: "email", to: ["client@example.com"], subject: "Edited" },
      processEmail: async () => {
        await processing;
        return { id: "gmail-race" };
      },
      now: start + 2_000,
    });

    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      returnScheduledEmailToDraft({ dataDir, jobId: "job-race", id: created.id, now: start + 3_000 }),
      // Refused: it is locked and no longer pending (a draft being sent).
      /already being changed|only pending emails can be cancelled \(currently (draft|sending)\)/,
    );
    release();
    const result = await sending;
    assert.equal(result.scheduledEmail.status, "sent");
    assert.equal(result.scheduledEmail.id, created.id);
  });
});

test("only explicitly safe failures retry and retries are bounded", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    await createScheduledEmail({
      dataDir,
      jobId: "job-3",
      scheduledAt: new Date(start + 31_000).toISOString(),
      payload: { to: ["client@example.com"], subject: "Retry" },
      now: start,
    });
    let calls = 0;
    const processEmail = async () => {
      calls += 1;
      const error = new Error("safe preparation failure");
      error.safeToRetry = true;
      throw error;
    };

    await processDueScheduledEmails({ dataDir, processEmail, logger: {}, now: start + 32_000 });
    let [record] = await listScheduledEmails({ dataDir, jobId: "job-3" });
    assert.equal(record.status, "pending");
    assert.equal(record.attemptCount, 1);

    await processDueScheduledEmails({ dataDir, processEmail, logger: {}, now: start + 93_000 });
    record = (await listScheduledEmails({ dataDir, jobId: "job-3" }))[0];
    assert.equal(record.attemptCount, 2);
    assert.equal(record.status, "pending");

    await processDueScheduledEmails({ dataDir, processEmail, logger: {}, now: start + 214_000 });
    record = (await listScheduledEmails({ dataDir, jobId: "job-3" }))[0];
    assert.equal(calls, 3);
    assert.equal(record.attemptCount, 3);
    assert.equal(record.status, "failed");
  });
});

test("restart leaves an interrupted Gmail call failed for manual review", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({
      dataDir,
      jobId: "job-4",
      scheduledAt: new Date(start + 31_000).toISOString(),
      payload: { to: ["client@example.com"], subject: "No duplicate" },
      now: start,
    });
    const path = join(dataDir, ".scheduled-emails", `${created.id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, status: "sending", claimedAt: new Date(start + 31_000).toISOString() }));

    assert.equal(await recoverInterruptedScheduledEmails({ dataDir, now: start + 60_000 }), 1);
    const [recovered] = await listScheduledEmails({ dataDir, jobId: "job-4" });
    assert.equal(recovered.status, "failed");
    assert.match(recovered.lastError, /avoid sending a duplicate/);
  });
});

// Durable storage: a claim must be stored before Gmail is called, or a
// restart could resend. A stand-in store records flushes or refuses them.
function fakeDurableStore(t, { fail = false } = {}) {
  const store = {
    flushes: [],
    async flushCurrent({ reason }) {
      store.flushes.push(reason);
      if (fail) throw new Error("PostgreSQL unavailable");
      return {};
    },
    registerSqliteImage() {},
  };
  installDurableStore(store);
  t.after(() => installDurableStore(null));
  return store;
}

test("a scheduled send stores its claim durably before calling Gmail", async (t) => {
  await withTempDir(async (dataDir) => {
    const now = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({
      dataDir, jobId: "job-d", scheduledAt: "2026-08-25T11:00:00.000Z",
      payload: { to: ["client@example.com"], subject: "Durable" }, now,
    });
    const store = fakeDurableStore(t);
    let flushesBeforeSend = null;
    await processDueScheduledEmails({
      dataDir,
      now: Date.parse("2026-08-25T11:00:01.000Z"),
      processEmail: async () => { flushesBeforeSend = [...store.flushes]; return { id: "gmail-d" }; },
    });
    assert.deepEqual(flushesBeforeSend, [`email ${created.id} claim`]);
  });
});

test("if the claim cannot be stored durably, nothing is sent and the email stays as it was", async (t) => {
  await withTempDir(async (dataDir) => {
    const now = Date.parse("2026-08-25T10:00:00.000Z");
    const scheduled = await createScheduledEmail({
      dataDir, jobId: "job-e", scheduledAt: "2026-08-25T11:00:00.000Z",
      payload: { to: ["client@example.com"], subject: "Scheduled" }, now,
    });
    const draft = await createScheduledEmail({
      dataDir, jobId: "job-e", scheduledAt: "2026-08-25T11:00:00.000Z",
      payload: { to: ["client@example.com"], subject: "Draft" }, now,
    });
    await returnScheduledEmailToDraft({ dataDir, jobId: "job-e", id: draft.id, now: now + 1_000 });
    fakeDurableStore(t, { fail: true });
    let sends = 0;
    const errors = [];
    await processDueScheduledEmails({
      dataDir,
      now: Date.parse("2026-08-25T11:00:01.000Z"),
      logger: { error: (message) => errors.push(message) },
      processEmail: async () => { sends += 1; },
    });
    await assert.rejects(
      sendEmailDraftNow({
        dataDir, jobId: "job-e", id: draft.id,
        payload: { kind: "email", to: ["client@example.com"], subject: "Draft" },
        processEmail: async () => { sends += 1; },
        now: now + 2_000,
      }),
      (error) => error.statusCode === 503 && /could not be recorded durably/.test(error.message),
    );
    assert.equal(sends, 0);
    assert.match(errors.join("\n"), /could not be recorded durably/);
    const byId = Object.fromEntries((await listScheduledEmails({ dataDir, jobId: "job-e" })).map((record) => [record.id, record]));
    assert.equal(byId[scheduled.id].status, "pending");
    assert.equal(byId[scheduled.id].attemptCount, 0);
    assert.equal(byId[draft.id].status, "draft");
  });
});

test("a failure is a rejection only when Gmail or Field refused it before it went; everything else is unknown", async () => {
  const ceiling = await withGmailSendCeiling(new Promise(() => {}), "sendJobEmail", 5).catch((error) => error);
  assert.match(ceiling.message, /sendJobEmail exceeded the 5ms send ceiling/);
  assert.equal(classifyDeliveryFailure(ceiling), "unknown", "the send ceiling: Gmail may still have sent it");
  assert.equal(classifyDeliveryFailure(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), "unknown");
  assert.equal(classifyDeliveryFailure(Object.assign(new Error("network timeout"), { code: "ETIMEDOUT" })), "unknown");
  assert.equal(classifyDeliveryFailure(Object.assign(new Error("backend error"), { response: { status: 503 } })), "unknown");
  assert.equal(classifyDeliveryFailure(Object.assign(new Error("unknown outcome"), { statusCode: 409, code: "DELIVERY_OUTCOME_UNKNOWN" })), "unknown");
  assert.equal(classifyDeliveryFailure(new Error("plain")), "unknown");
  assert.equal(classifyDeliveryFailure(Object.assign(new Error("Invalid To header"), { status: 400, response: { status: 400 } })), "rejected");
  assert.equal(classifyDeliveryFailure(Object.assign(new Error("invalid_grant"), { response: { status: 401 } })), "rejected");
  assert.equal(classifyDeliveryFailure(Object.assign(new Error("too large"), { deliveryOutcome: "rejected_before_dispatch", statusCode: 503 })), "rejected");
});

test("a send that timed out goes again only after five minutes, as its first sender, from its first mailbox, with its first Message-ID", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    const alice = { id: "u-alice", email: "alice@example.invalid", kind: "human" };
    const bob = { id: "u-bob", email: "bob@example.invalid", kind: "human" };
    const created = await createScheduledEmail({ dataDir, jobId: "job-t", payload: { to: ["client@example.invalid"], subject: "Gate code" }, holdSeconds: 0, sender: alice, now: start });
    const attempts = [];
    const timeOut = async (record) => {
      attempts.push({ attemptId: record.deliveryAttemptId, sender: record.deliverySender?.email });
      // The send stores its identity just before Gmail, then Gmail times out.
      await record.stampDelivery({ mailbox: "alice@example.invalid", messageId: "<field-first@example.invalid>", sent: { to: ["client@example.invalid"], subject: "Gate code" } });
      throw new Error("sendJobEmail exceeded the 45000ms send ceiling: a Gmail API call did not complete in time");
    };
    await processDueScheduledEmails({ dataDir, processEmail: timeOut, logger: {}, now: start + 1_000 });
    let [record] = await listScheduledEmails({ dataDir, jobId: "job-t" });
    assert.equal(record.status, "failed");
    assert.equal(record.deliveryOutcome, "unknown");
    assert.equal(record.resend, "checks-sent-mail");
    assert.equal(record.checksSentMail, true);
    assert.equal(record.deliveryMailbox, "alice@example.invalid");
    assert.equal(record.resendAfter, "2026-08-25T10:05:01.000Z", "five minutes after the failed attempt");
    // Bob edits it and sends it at once: refused while Gmail may still be delivering it.
    const saved = await saveEmailDraft({ dataDir, jobId: "job-t", id: created.id, payload: { to: ["client@example.invalid"], subject: "Gate code, again" }, sender: bob, now: start + 2_000 });
    assert.equal(saved.checksSentMail, true);
    await assert.rejects(
      rescheduleEmailDraft({ dataDir, jobId: "job-t", id: created.id, payload: { to: ["client@example.invalid"], subject: "Gate code, again" }, holdSeconds: 0, sender: bob, now: start + 3_000 }),
      (error) => error.statusCode === 409 && error.code === "DELIVERY_STILL_SETTLING" && /Gmail may still be delivering this email/.test(error.message),
    );
    // Six minutes on, it goes: as Alice, searching and sending from Alice's mailbox, with the first Message-ID.
    await rescheduleEmailDraft({ dataDir, jobId: "job-t", id: created.id, payload: { to: ["client@example.invalid"], subject: "Gate code, again" }, holdSeconds: 0, sender: bob, now: start + 6 * 60_000 });
    const sends = [];
    await processDueScheduledEmails({ dataDir, processEmail: async (next) => {
      sends.push({ attemptId: next.deliveryAttemptId, reconcile: next.reconcileBeforeSend === true, sender: next.deliverySender?.email, mailbox: next.deliveryMailbox, messageId: next.deliveryMessageId, first: next.firstSent?.subject });
      return { id: "m1", reconciled: true };
    }, logger: {}, now: start + 6 * 60_000 + 1_000 });
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0], { attemptId: attempts[0].attemptId, reconcile: true, sender: "alice@example.invalid", mailbox: "alice@example.invalid", messageId: "<field-first@example.invalid>", first: "Gate code" });
    [record] = await listScheduledEmails({ dataDir, jobId: "job-t" });
    assert.equal(record.status, "sent");
    assert.equal(record.reconciled, true, "found in Sent Mail: the operator is told the edit was not sent");
  });
});

test("a send the ceiling gave up on cannot stamp later: the edit stays, the stale send never reaches Gmail, nothing is stuck sending", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({ dataDir, jobId: "job-late", payload: { to: ["client@example.invalid"], subject: "Gate code" }, holdSeconds: 0, now: start });
    let staleReachedGmail = false;
    let lateStamp = null;
    const ceiling = async (record) => {
      // The ceiling gives up now; the send carries on and stamps 300 ms later.
      lateStamp = new Promise((resolve) => {
        setTimeout(() => {
          record.stampDelivery({ mailbox: "proof.sender@example.invalid", messageId: "<field-late@example.invalid>", sent: { subject: "Gate code" } })
            .then(() => { staleReachedGmail = true; resolve(null); }, resolve);
        }, 300);
      });
      throw new Error("sendJobEmail exceeded the 45000ms send ceiling: a Gmail API call did not complete in time");
    };
    await processDueScheduledEmails({ dataDir, processEmail: ceiling, logger: {}, now: start + 1_000 });
    let [record] = await listScheduledEmails({ dataDir, jobId: "job-late" });
    assert.equal(record.status, "failed");
    // Edited and saved as a draft before the late stamp.
    await saveEmailDraft({ dataDir, jobId: "job-late", id: created.id, payload: { to: ["client@example.invalid"], subject: "Gate code, edited" }, now: start + 2_000 });
    const refused = await lateStamp;
    assert.equal(staleReachedGmail, false, "the stale send stops before Gmail");
    assert.equal(refused?.code, "DELIVERY_ATTEMPT_STALE");
    assert.equal(refused?.deliveryOutcome, "rejected_before_dispatch");
    [record] = await listScheduledEmails({ dataDir, jobId: "job-late" });
    assert.equal(record.status, "draft", "not stuck in sending");
    assert.equal(record.subject, "Gate code, edited", "the edit is kept");
    const stored = JSON.parse(await readFile(join(dataDir, ".scheduled-emails", `${created.id}.json`), "utf8"));
    assert.equal(stored.deliveryMessageId ?? null, null, "the late identity was not written");
  });
});

test("a failure while an earlier attempt is unknown stays unknown, even a 4xx from the Sent Mail search", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    const created = await createScheduledEmail({ dataDir, jobId: "job-s", payload: { to: ["client@example.invalid"], subject: "Search" }, holdSeconds: 0, now: start });
    await processDueScheduledEmails({ dataDir, processEmail: async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); }, logger: {}, now: start + 1_000 });
    await rescheduleEmailDraft({ dataDir, jobId: "job-s", id: created.id, payload: { to: ["client@example.invalid"], subject: "Search" }, holdSeconds: 0, now: start + 6 * 60_000 });
    await processDueScheduledEmails({ dataDir, processEmail: async () => { throw Object.assign(new Error("Invalid query"), { response: { status: 400 } }); }, logger: {}, now: start + 6 * 60_000 + 1_000 });
    const [record] = await listScheduledEmails({ dataDir, jobId: "job-s" });
    assert.equal(record.status, "failed");
    assert.equal(record.deliveryOutcome, "unknown");
    assert.equal(record.checksSentMail, true);
    assert.equal(record.resendAfter, "2026-08-25T10:05:01.000Z", "a 4xx before dispatch does not restart the five minutes");
  });
});

test("a 4xx rejection can be sent again; an unknown failure without a stored Message-ID cannot", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.parse("2026-08-25T10:00:00.000Z");
    const rejected = await createScheduledEmail({ dataDir, jobId: "job-r", payload: { to: ["client@example.invalid"], subject: "Rejected" }, holdSeconds: 0, now: start });
    await processDueScheduledEmails({ dataDir, processEmail: async () => { throw Object.assign(new Error("Invalid To header"), { response: { status: 400 } }); }, logger: {}, now: start + 1_000 });
    let [record] = await listScheduledEmails({ dataDir, jobId: "job-r" });
    assert.equal(record.deliveryOutcome, "rejected");
    assert.equal(record.resend, "allowed");
    const again = await rescheduleEmailDraft({ dataDir, jobId: "job-r", id: rejected.id, payload: { to: ["client@example.invalid"], subject: "Rejected" }, holdSeconds: 0, now: start + 2_000 });
    assert.equal(again.status, "pending");
    assert.equal(again.checksSentMail, false);

    // A record that failed before Field kept outcomes or Message-IDs.
    const legacy = await createScheduledEmail({ dataDir, jobId: "job-l", payload: { to: ["client@example.invalid"], subject: "Old" }, holdSeconds: 0, now: start });
    const path = join(dataDir, ".scheduled-emails", `${legacy.id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...stored, status: "failed", lastError: "socket hang up" }));
    [record] = await listScheduledEmails({ dataDir, jobId: "job-l" });
    assert.equal(record.deliveryOutcome, "unknown");
    assert.equal(record.resend, "blocked");
    for (const attempt of [
      () => rescheduleEmailDraft({ dataDir, jobId: "job-l", id: legacy.id, payload: stored.payload, holdSeconds: 0, now: start + 2_000 }),
      () => saveEmailDraft({ dataDir, jobId: "job-l", id: legacy.id, payload: stored.payload, now: start + 2_000 }),
    ]) {
      await assert.rejects(attempt(), (error) => error.statusCode === 409 && error.code === "DELIVERY_OUTCOME_UNKNOWN");
    }
  });
});

test("a draft id that is not a record id never becomes a path", async () => {
  await withTempDir(async (dataDir) => {
    await assert.rejects(
      saveEmailDraft({ dataDir, jobId: "job-x", id: "../../config", payload: { to: [], subject: "x" } }),
      (error) => error.statusCode === 404,
    );
    await assert.rejects(returnScheduledEmailToDraft({ dataDir, jobId: "job-x", id: "a/b" }), (error) => error.statusCode === 404);
  });
});

test("Undo waits out the scheduler's scan lock while the email is pending, and is refused at once when it is sending", async () => {
  await withTempDir(async (dataDir) => {
    const start = Date.now();
    const created = await createScheduledEmail({ dataDir, jobId: "job-u", payload: { to: ["client@example.invalid"], subject: "Undo me" }, holdSeconds: 10, now: start });
    const path = join(dataDir, ".scheduled-emails", `${created.id}.json`);
    await mkdir(join(dataDir, ".scheduled-emails"), { recursive: true });
    await writeFile(`${path}.lock`, "");
    setTimeout(() => { void rm(`${path}.lock`, { force: true }); }, 200);
    const undone = await returnScheduledEmailToDraft({ dataDir, jobId: "job-u", id: created.id });
    assert.equal(undone.status, "draft");

    const sending = await createScheduledEmail({ dataDir, jobId: "job-u", payload: { to: ["client@example.invalid"], subject: "Too late" }, holdSeconds: 0, now: start });
    const sendingPath = join(dataDir, ".scheduled-emails", `${sending.id}.json`);
    const stored = JSON.parse(await readFile(sendingPath, "utf8"));
    await writeFile(sendingPath, JSON.stringify({ ...stored, status: "sending" }));
    await writeFile(`${sendingPath}.lock`, "");
    const began = Date.now();
    await assert.rejects(returnScheduledEmailToDraft({ dataDir, jobId: "job-u", id: sending.id }), (error) => error.statusCode === 409 && /currently sending/.test(error.message));
    assert.ok(Date.now() - began < 1_000, "no wait once it is sending");
  });
});
