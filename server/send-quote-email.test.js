import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedQuoteRecipient,
  assertAllowedQuoteRecipients,
  buildMimeMessage,
  GMAIL_DELEGATED_RECONCILE_SCOPES,
  GMAIL_DELEGATED_SEND_SCOPES,
  GMAIL_SEND_SCOPES,
  getGmailClient,
  hasServiceAccountGmail,
  resetGmailClient,
  resolveGmailDelegatedUser,
  resolveGmailLoginHint,
  resolveMailSender,
  resolveMailDeliveryPolicy,
  withGmailSendCeiling,
  formatDeliveryMessageId,
  GMAIL_RAW_JSON_MAX_CHARS,
  NEUTRAL_MESSAGE_ID_HOST,
  resolveMessageIdHost,
  sendGmailMessage,
  findSentMessageInMailbox,
} from "./send-quote-email.js";
import { renderQuoteEmailHtml } from "./quote-email-template.js";

test("mail delivery policy defaults to live when not configured", () => {
  assert.deepEqual(resolveMailDeliveryPolicy({}), {
    mode: "live",
    allowedRecipients: [],
  });
});

test("allowlist policy normalizes and deduplicates recipient emails", () => {
  assert.deepEqual(resolveMailDeliveryPolicy({
    mail: {
      deliveryPolicy: {
        mode: "allowlist",
        allowedRecipients: [" Admin@Example.com ", "admin@example.com", "TEST@EXAMPLE.COM"],
      },
    },
  }), {
    mode: "allowlist",
    allowedRecipients: ["admin@example.com", "test@example.com"],
  });
});

test("allowlist policy blocks recipients that are not explicitly allowed", () => {
  assert.throws(() => assertAllowedQuoteRecipient({
    config: {
      mail: {
        deliveryPolicy: {
          mode: "allowlist",
          allowedRecipients: ["admin@example.com"],
        },
      },
    },
    to: "client@example.com",
  }), (err) => {
    assert.equal(err.statusCode, 403);
    assert.match(err.message, /restricted/i);
    assert.match(err.message, /admin@example\.com/i);
    return true;
  });
});

test("allowlist policy accepts configured test recipients", () => {
  assert.equal(assertAllowedQuoteRecipient({
    config: {
      mail: {
        deliveryPolicy: {
          mode: "allowlist",
          allowedRecipients: ["admin@example.com"],
        },
      },
    },
    to: " Admin@Example.com ",
  }), "admin@example.com");
});

test("allowlist policy accepts multiple configured recipients", () => {
  assert.deepEqual(assertAllowedQuoteRecipients({
    config: {
      mail: {
        deliveryPolicy: {
          mode: "allowlist",
          allowedRecipients: ["admin@example.com", "owner@example.com"],
        },
      },
    },
    emails: [" Admin@Example.com ", "owner@example.com"],
  }), ["admin@example.com", "owner@example.com"]);
});

test("MIME messages include normalized Cc and Bcc recipient headers", () => {
  const raw = buildMimeMessage({
    fromName: "Your Business",
    fromEmail: "sender@example.com",
    replyTo: "sender@example.com",
    to: ["client@example.com"],
    cc: ["office@example.com"],
    bcc: ["archive@example.com"],
    subject: "Job update",
    body: "Hello",
  });
  const message = Buffer.from(raw, "base64url").toString("utf8");

  assert.match(message, /\r\nCc: office@example\.com\r\n/);
  assert.match(message, /\r\nBcc: archive@example\.com\r\n/);
});

test("disabled policy blocks all outbound quote delivery", () => {
  assert.throws(() => assertAllowedQuoteRecipient({
    config: {
      mail: {
        deliveryPolicy: {
          mode: "disabled",
        },
      },
    },
    to: "admin@example.com",
  }), (err) => {
    assert.equal(err.statusCode, 403);
    assert.match(err.message, /disabled/i);
    return true;
  });
});

test("gmail service account delegation requires explicit delegated user", () => {
  const config = {
    googleServiceAccountKey: "/tmp/service-account.json",
    mail: {
      fromEmail: " Owner@Example.com ",
    },
  };

  assert.equal(resolveGmailDelegatedUser(config), "");
  assert.equal(hasServiceAccountGmail(config), false);
  assert.equal(resolveGmailLoginHint(config), "owner@example.com");
});

test("gmail service account delegation accepts configured gmail user", () => {
  const config = {
    googleServiceAccountKey: "/tmp/service-account.json",
    mail: {
      gmailUser: " Owner@Example.com ",
      fromEmail: "sender@example.com",
    },
  };

  assert.equal(resolveGmailDelegatedUser(config), "owner@example.com");
  assert.equal(hasServiceAccountGmail(config), true);
  assert.equal(resolveGmailLoginHint(config), "owner@example.com");
});

test("gmail service account delegation accepts an inline key", () => {
  const config = {
    googleServiceAccountKey: JSON.stringify({ client_email: "field@example.iam.gserviceaccount.com", private_key: "not-a-real-key" }),
    mail: { gmailUser: "operator@example.com" },
  };

  assert.equal(hasServiceAccountGmail(config), true);
});

test("delegated sends ask Google only for the scopes sending needs", () => {
  // The business's Workspace delegates gmail.send to this service account. Asking for
  // gmail.readonly or userinfo.email as well made Google refuse every send
  // (unauthorized_client).
  const config = {
    googleServiceAccountKey: JSON.stringify({ client_email: "field@example.iam.gserviceaccount.com", private_key: "not-a-real-key" }),
    mail: { gmailUser: "operator@example.com" },
  };
  resetGmailClient();
  const send = getGmailClient(config);
  const reconcile = getGmailClient(config, { purpose: "reconcile" });
  assert.deepEqual(send.context._options.auth.scopes, ["https://www.googleapis.com/auth/gmail.send"]);
  assert.deepEqual(GMAIL_DELEGATED_SEND_SCOPES, ["https://www.googleapis.com/auth/gmail.send"]);
  assert.equal(send.context._options.auth.scopes.includes("https://www.googleapis.com/auth/gmail.readonly"), false);
  assert.equal(send.context._options.auth.subject, "operator@example.com");
  assert.deepEqual(reconcile.context._options.auth.scopes, GMAIL_DELEGATED_RECONCILE_SCOPES);
  assert.notEqual(send, reconcile);
  // A person's own Gmail consent still includes read access for reconciliation.
  assert.ok(GMAIL_SEND_SCOPES.includes("https://www.googleapis.com/auth/gmail.readonly"));
  resetGmailClient();
});

test("gmail service account delegation can map to the logged-in human user", () => {
  const config = {
    googleServiceAccountKey: "/tmp/service-account.json",
    mail: {
      fromEmail: "fallback@example.com",
    },
  };
  const user = {
    kind: "human",
    email: " Owner@Example.com ",
    name: "Alex",
    settings: {},
  };

  assert.equal(resolveGmailDelegatedUser(config, { user }), "owner@example.com");
  assert.equal(hasServiceAccountGmail(config, { user }), true);
  assert.equal(resolveGmailLoginHint(config, { user }), "owner@example.com");
});

test("human Field users send from their own Gmail identity", () => {
  const sender = resolveMailSender({
    config: {
      mail: {
        fromEmail: "operator@example.com",
        fromName: "Field Local",
      },
    },
    user: {
      kind: "human",
      email: "Owner@Example.com",
      name: "Alex",
      settings: {},
    },
    gmailUser: "owner@example.com",
  });

  assert.equal(sender.fromEmail, "owner@example.com");
  assert.equal(sender.fromName, "Field Local");
  assert.equal(sender.replyTo, "owner@example.com");
});

test("sender mismatch is blocked before Gmail accepts a misleading From header", () => {
  assert.throws(() => resolveMailSender({
    config: {},
    user: {
      kind: "human",
      email: "owner@example.com",
      name: "Alex",
      settings: {},
    },
    gmailUser: "other@example.com",
  }), /sender mismatch/i);
});

// ── Quote email HTML template tests ──

const SAMPLE_TEMPLATE_ARGS = {
  clientName: "Jane Smith",
  jobTitle: "Retaining wall — 14 Banksia Dr",
  quoteNumber: "Q-2026-042",
  quoteDate: "1 April 2026",
  validDays: 30,
  lineItems: [
    { label: "Concrete sleeper wall — 12m", totalPrice: 8400, depth: 0, kind: "source" },
    { label: "Drainage & backing", totalPrice: 1200, depth: 0, kind: "source" },
    { label: "Site establishment", totalPrice: 600, depth: 0, kind: "source" },
  ],
  subtotal: 10200,
  gst: 1020,
  total: 11220,
  companyName: "Your Business",
  companyAbn: "00 000 000 000",
  companyAddress: "Your business address",
  companyPhone: "",
  companyEmail: "quotes@example.com",
  replyToEmail: "quotes@example.com",
};

test("renderQuoteEmailHtml summary mode returns body without pricing table", () => {
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, mode: "summary" });
  assert.ok(html.includes("<!doctype html>") || html.includes("<html"), "should be HTML document");
  assert.ok(html.includes("Jane Smith"), "should include client name");
  assert.ok(html.includes("Retaining wall"), "should include job title");
  assert.ok(!html.includes("Concrete sleeper wall"), "should not include line item label");
  assert.ok(!html.includes("$10,200.00") && !html.includes("10,200"), "should not include subtotal");
  assert.ok(!html.includes("$11,220.00") && !html.includes("11,220"), "should not include total");
  assert.ok(html.includes("ABN"), "should include ABN in footer");
  assert.ok(html.includes("Your Business"), "should include company name");
});

test("renderQuoteEmailHtml simple mode omits pricing", () => {
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, mode: "simple" });
  assert.ok(!html.includes("$11,220.00") && !html.includes("11,220"), "should not include total");
  assert.ok(!html.includes("Concrete sleeper wall"), "should NOT include individual line items");
  assert.ok(html.includes("attached as a PDF"), "should mention PDF attachment");
});

test("renderQuoteEmailHtml handles missing client name gracefully", () => {
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, clientName: null, mode: "summary" });
  assert.ok(html.includes("Hi,"), "should fall back to generic greeting");
  assert.ok(!html.includes("Hi null"), "should not show 'null'");
});

test("renderQuoteEmailHtml handles empty line items in summary mode", () => {
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, lineItems: [], mode: "summary" });
  assert.ok(!html.includes("$11,220.00") && !html.includes("11,220"), "should not show total");
});

test("renderQuoteEmailHtml escapes HTML in job title", () => {
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, jobTitle: '<script>alert("xss")</script>', mode: "summary" });
  assert.ok(!html.includes("<script>"), "should escape script tags");
  assert.ok(html.includes("&lt;script&gt;"), "should have escaped HTML entities");
});

// ── Custom body tests ──

test("renderQuoteEmailHtml with null customBody uses stock greeting and body", () => {
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, mode: "summary", customBody: null });
  assert.ok(html.includes("Hi Jane Smith"), "should include personalized greeting");
  assert.ok(html.includes("Retaining wall"), "should include job title in intro");
  assert.ok(html.includes("Reply to this email"), "should include reply prompt");
  assert.ok(html.includes("Regards"), "should include regards closing");
  assert.ok(!html.includes("Concrete sleeper wall"), "should not include line items");
  assert.ok(html.includes("ABN"), "should include footer");
});

test("renderQuoteEmailHtml with customBody replaces greeting/body section", () => {
  const custom = "<p>Hi Jordan,</p><p>As discussed on site, I've included the alternative dump location pricing.</p>";
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, mode: "summary", customBody: custom });
  assert.ok(html.includes("As discussed on site"), "should include custom body text");
  assert.ok(html.includes("alternative dump location"), "should include full custom message");
  // Stock body text should NOT be present
  assert.ok(!html.includes("Reply to this email"), "should not include stock reply prompt");
  assert.ok(!html.includes("Regards"), "should not include stock regards");
  assert.ok(!html.includes("Concrete sleeper wall"), "pricing table must not be included");
  assert.ok(html.includes("ABN"), "footer must remain");
  assert.ok(html.includes("Your Business"), "header must remain");
  assert.ok(!html.includes("Pricing schedule"), "pricing summary heading must not be included");
  assert.ok(!html.includes("background:#0b0d11"), "email should not use the old black summary header");
});

test("renderQuoteEmailHtml sanitizes dangerous tags from customBody", () => {
  const malicious = '<p>Hello</p><script>alert("xss")</script><iframe src="evil.com"></iframe><p onclick="steal()">Click</p>';
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, mode: "summary", customBody: malicious });
  assert.ok(!html.includes("<script"), "should strip script tags");
  assert.ok(!html.includes("<iframe"), "should strip iframe tags");
  assert.ok(!html.includes("onclick"), "should strip event handlers");
  assert.ok(html.includes("Hello"), "should keep safe content");
});

test("renderQuoteEmailHtml customBody preserves allowed formatting tags", () => {
  const styled = '<p>Hi <strong>Jordan</strong>, this is <em>important</em>.</p>';
  const html = renderQuoteEmailHtml({ ...SAMPLE_TEMPLATE_ARGS, mode: "summary", customBody: styled });
  assert.ok(html.includes("<strong>Jordan</strong>"), "should preserve strong tags");
  assert.ok(html.includes("<em>important</em>"), "should preserve em tags");
});

test("resetGmailClient clears cached client so a new token takes effect", () => {
  // Build a client with OAuth creds to populate the cache
  const config = {
    googleOAuth: {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "old-refresh-token",
    },
  };
  const client1 = getGmailClient(config);
  assert.ok(client1, "should create a gmail client");

  // Same config returns cached instance
  const client2 = getGmailClient(config);
  assert.equal(client1, client2, "should return cached client");

  // Reset clears the cache
  resetGmailClient();

  // After reset, a new client is created (not the same reference)
  const client3 = getGmailClient(config);
  assert.ok(client3, "should create a new gmail client after reset");
  assert.notEqual(client1, client3, "new client should be a different instance");
});

// sendQuoteEmail/sendJobEmail run inside the same
// runExclusiveJobMutation lock as every other milestone mutation, which is
// stealable after its 120s stale-lock timeout. GMAIL_SEND_REQUEST_OPTIONS
// bounds individual gaxios HTTP calls, but two calls inside that locked
// region were not bounded by anything: getAuthenticatedSender's own
// `getProfile` request, and — the one no per-call option can reach — the
// googleapis auth client's own OAuth token-refresh request, issued from an
// interceptor ahead of whichever call triggered it. withGmailSendCeiling
// races the WHOLE exported call against a ceiling so a hang anywhere inside
// it (auth refresh included) still resolves the outer promise within the
// bound, rather than holding the mutation lock indefinitely. This exercises
// the ceiling mechanism itself, at unit-test speed via a small `ms`
// override — see the JSDoc on withGmailSendCeiling for why a real hung
// Gmail/OAuth client is not exercised directly here.
test("withGmailSendCeiling rejects cleanly within the bound when the wrapped work hangs", async () => {
  const start = Date.now();
  const neverSettles = new Promise(() => {});
  await assert.rejects(
    () => withGmailSendCeiling(neverSettles, "sendQuoteEmail", 25),
    (err) => {
      assert.match(err.message, /exceeded the 25ms send ceiling/i);
      assert.match(err.message, /profile lookup, OAuth token refresh, or the send itself/i);
      return true;
    },
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `expected the ceiling to fire promptly, took ${elapsed}ms`);
});

test("withGmailSendCeiling resolves with the wrapped work's value when it finishes before the ceiling", async () => {
  const result = await withGmailSendCeiling(Promise.resolve("sent"), "sendQuoteEmail", 1000);
  assert.equal(result, "sent");
});

test("withGmailSendCeiling propagates the wrapped work's own rejection when it fails before the ceiling", async () => {
  const err = new Error("recipient email required");
  err.statusCode = 400;
  await assert.rejects(
    () => withGmailSendCeiling(Promise.reject(err), "sendQuoteEmail", 1000),
    (caught) => {
      assert.equal(caught, err);
      assert.equal(caught.statusCode, 400);
      return true;
    },
  );
});

test("the stable Message-ID uses the installation's own host, never a third party's (#50)", () => {
  const saved = process.env.FIELD_MAIL_MESSAGE_ID_HOST;
  delete process.env.FIELD_MAIL_MESSAGE_ID_HOST;
  try {
    // The sender's domain by default.
    assert.equal(resolveMessageIdHost({ config: { mail: { fromEmail: "office@harlow.example.invalid" } } }), "harlow.example.invalid");
    assert.equal(resolveMessageIdHost({ config: {}, fromEmail: "jess@site.example.invalid" }), "site.example.invalid");
    // A configured host wins; a malformed one is ignored.
    assert.equal(resolveMessageIdHost({ config: { mail: { messageIdHost: "mail.example.invalid", fromEmail: "a@b.example.invalid" } } }), "mail.example.invalid");
    assert.equal(resolveMessageIdHost({ config: { mail: { messageIdHost: "not a host", fromEmail: "a@b.example.invalid" } } }), "b.example.invalid");
    // Nothing to go on: a neutral reserved host.
    assert.equal(resolveMessageIdHost({ config: {} }), NEUTRAL_MESSAGE_ID_HOST);
    process.env.FIELD_MAIL_MESSAGE_ID_HOST = "env.example.invalid";
    assert.equal(resolveMessageIdHost({ config: { mail: { fromEmail: "a@b.example.invalid" } } }), "env.example.invalid");
  } finally {
    if (saved === undefined) delete process.env.FIELD_MAIL_MESSAGE_ID_HOST;
    else process.env.FIELD_MAIL_MESSAGE_ID_HOST = saved;
  }
  assert.equal(formatDeliveryMessageId("abc-123", "harlow.example.invalid"), "<field-abc-123@harlow.example.invalid>");
});

test("a delivery attempt's stored Message-ID goes out unchanged, including one with the old host", () => {
  const mime = (messageId) => Buffer.from(buildMimeMessage({
    fromName: "Proof", fromEmail: "proof@example.invalid", replyTo: "proof@example.invalid", to: ["customer@example.invalid"],
    subject: "Quote", body: "Hi", htmlBody: "<p>Hi</p>", deliveryAttemptId: "attempt-1", messageId,
  }), "base64url").toString("utf8");
  assert.match(mime("<field-attempt-1@example.invalid>"), /\r\nMessage-ID: <field-attempt-1@example\.invalid>\r\n/);
  // An attempt prepared before the change keeps the host it was stored with,
  // so Sent Mail is searched for the id that actually went out.
  assert.match(mime("<field-attempt-1@arcforge.local>"), /\r\nMessage-ID: <field-attempt-1@arcforge\.local>\r\n/);
  assert.match(mime(null), /\r\nMessage-ID: <field-attempt-1@field\.invalid>\r\n/);
});

test("messages over Gmail's JSON size go through the media upload form", async () => {
  const calls = [];
  const gmail = { users: { messages: { send: async (params, options) => { calls.push({ params, options }); return { data: { id: "m", threadId: "t" } }; } } } };
  const small = Buffer.from("small message").toString("base64url");
  await sendGmailMessage(gmail, small);
  assert.deepEqual(calls[0].params, { userId: "me", requestBody: { raw: small } });
  const bytes = Buffer.alloc(GMAIL_RAW_JSON_MAX_CHARS, 1);
  const large = bytes.toString("base64url");
  await sendGmailMessage(gmail, large, { threadId: "thread-1" });
  assert.equal(calls[1].params.requestBody.raw, undefined);
  assert.equal(calls[1].params.requestBody.threadId, "thread-1");
  assert.equal(calls[1].params.media.mimeType, "message/rfc822");
  assert.ok(Buffer.from(calls[1].params.media.body).equals(bytes), "the media body is the message itself");
  assert.equal(calls[1].options.timeout, calls[0].options.timeout, "both forms keep the send timeout");
});

test("the send ceiling aborts the work it gives up on, so it cannot send late", async () => {
  const controller = new AbortController();
  await assert.rejects(withGmailSendCeiling(new Promise(() => {}), "sendJobEmail", 5, controller), /send ceiling/);
  assert.equal(controller.signal.aborted, true);
});

test("a Sent Mail check refuses, rather than answering not found, when the first mailbox cannot be searched", async () => {
  resetGmailClient();
  await assert.rejects(
    findSentMessageInMailbox({ config: {}, user: { email: "alice@example.invalid", kind: "human" }, mailbox: "alice@example.invalid", messageId: "<field-1@example.invalid>" }),
    (error) => error.code === "DELIVERY_MAILBOX_UNAVAILABLE" && error.statusCode === 409 && /cannot reach alice@example\.invalid/.test(error.message),
  );
});
