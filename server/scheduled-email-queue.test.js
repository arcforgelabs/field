import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createScheduledEmail,
  listScheduledEmails,
  processDueScheduledEmails,
  recoverInterruptedScheduledEmails,
  rescheduleEmailDraft,
  returnScheduledEmailToDraft,
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
      /already being changed/,
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

// Durable storage (#139): a claim must be stored before Gmail is called, or a
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
