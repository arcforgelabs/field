import { applyBusinessProfileOverride, businessDisplayName, businessNameOf, installationBusinessName } from "./business-profile.js";
import { createHash } from "node:crypto";
import { google } from "googleapis";
import {
  googleServiceAccountCacheId,
  hasGoogleServiceAccountKey,
  loadGoogleServiceAccountCredentials,
} from "./google-service-account.js";
import {
  buildInvoiceDocumentNumber,
  buildReceiptDocumentNumber,
  getJobDocumentLabelLower,
  resolveJobDocumentType,
} from "./job-documents.js";
import { emailHtmlToText, sanitizeGenericBodyHtml } from "./email-html.js";
import { renderQuoteEmailHtml } from "./quote-email-template.js";
import { loadQuoteRows } from "./quotes/read-model.js";

const _gmailClients = new Map();
const _gmailProfiles = new Map();
const CLOUD_SDK_CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
// Scopes a person grants when they connect their own Gmail (OAuth consent).
export const GMAIL_SEND_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Service-account (domain-wide delegation) sends ask only for gmail.send, as
// the service-account transport always did before Field moved to Replit.
// Google refuses the
// whole token when any requested scope is not delegated in the Workspace admin
// console, so asking for gmail.readonly or userinfo.email as well stopped every
// send on a workspace that delegates send only. The sender is the delegated
// user, so no profile lookup (userinfo/getProfile) is needed. Reading Sent Mail
// to reconcile an interrupted delivery asks for gmail.readonly on its own;
// without that delegation it fails and the delivery stays blocked (409) rather
// than being re-sent blind.
export const GMAIL_DELEGATED_SEND_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
];
export const GMAIL_DELEGATED_RECONCILE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

// `sendJobQuote` mints and persists issued invoice/receipt revisions before
// this call, then runs it inside the same runExclusiveJobMutation lock as
// every other milestone mutation. That lock is stealable: a
// holder that has not finished after job-mutation-guard.js's stale-lock
// timeout (120s) is evicted while its task keeps running. `gaxios` (which
// the Gmail client is built on) has no request timeout by default, so a
// hung send could hold the lock past 120s, lose it to a competing mutation,
// and then still run its own post-send persist — last-writer-wins over
// milestone-invoices/state.json, silently erasing whatever the winner just
// committed. Bounding the request here — comfortably
// under 120s, with no gaxios-internal retry to extend it unpredictably —
// keeps the steal unreachable while a send is actually in flight: it either
// completes or fails within the bound, never straddles the eviction. On
// timeout the caller sees a clean rejection with none of the invoice's
// already-persisted state touched again.
//
// GMAIL_SEND_REQUEST_OPTIONS only bounds the individual gaxios HTTP call it
// is passed to. Two calls inside this locked region were not receiving it:
// getAuthenticatedSender's own `getProfile` request,
// and — more importantly — the googleapis auth client's OWN token-refresh
// HTTP request, which it issues from an interceptor ahead of whichever call
// triggered it and which the per-call `timeout` option never reaches (it is
// gaxios request-level, not auth-client-level). Passing GMAIL_SEND_REQUEST_OPTIONS
// to getProfile closes the first gap. The second gap is closed below by
// racing the WHOLE exported send call — every await inside it, auth refresh
// included — against GMAIL_SEND_TIMEOUT_MS via withGmailSendCeiling: whatever
// hangs, the exported function still settles within the bound.
export const GMAIL_SEND_TIMEOUT_MS = 45_000;
const GMAIL_SEND_REQUEST_OPTIONS = { timeout: GMAIL_SEND_TIMEOUT_MS, retry: false };

// Exported (not just used internally) so tests can exercise the ceiling
// mechanism itself at unit-test speed via a small `ms` override, without
// standing up a real hung Gmail/OAuth client — `ms` defaults to
// GMAIL_SEND_TIMEOUT_MS for the real call sites below.
// `controller`, when given, is aborted when the ceiling gives up, so work
// that checks its signal (sendJobEmail) stops instead of sending late.
export function withGmailSendCeiling(work, label, ms = GMAIL_SEND_TIMEOUT_MS, controller = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(
        `${label} exceeded the ${ms}ms send ceiling: a Gmail API call `
        + "— profile lookup, OAuth token refresh, or the send itself — did not complete in time",
      ));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function resetGmailClient() {
  _gmailClients.clear();
  _gmailProfiles.clear();
}

export function getGmailClient(config, options = {}) {
  return resolveGmailTransport({ config, ...options })?.gmail || null;
}

/**
 * Reconcile a durable delivery attempt before retrying it. Gmail indexes the
 * RFC 822 Message-ID, so a stable attempt identity survives a process crash
 * and does not require trusting a caller-supplied Gmail id.
 */
export async function findSentMessageByDeliveryAttempt({ config, user = null, messageId }) {
  const normalized = String(messageId || "").trim();
  if (!normalized) return null;
  const transport = resolveGmailTransport({ config, user, purpose: "reconcile" });
  if (!transport?.gmail?.users?.messages?.list) return null;
  const response = await withGmailSendCeiling(
    transport.gmail.users.messages.list({
      userId: "me",
      q: `in:sent rfc822msgid:${normalized}`,
      maxResults: 5,
    },
    GMAIL_SEND_REQUEST_OPTIONS),
    "reconcileQuoteDelivery",
  );
  const match = response?.data?.messages?.[0];
  return match ? { id: match.id || null, threadId: match.threadId || null, messageId: normalized } : null;
}

function mailboxUnavailableError(mailbox) {
  const error = new Error(`Field cannot reach ${mailbox}, the Gmail mailbox this email first went from, so it cannot check that mailbox's Sent Mail. Connect Gmail for ${mailbox} (or ask its owner to send it), then send it again.`);
  error.statusCode = 409;
  error.code = "DELIVERY_MAILBOX_UNAVAILABLE";
  return error;
}

/**
 * Search one mailbox's Sent Mail for a delivery attempt's Message-ID: the
 * mailbox the attempt went from (`mailbox`), reached as the person who sent
 * it (`user`). Refuses, rather than answering "not found", when that mailbox
 * cannot be searched, so a resend never follows a search of the wrong one.
 */
export async function findSentMessageInMailbox({ config, user = null, mailbox = null, messageId }) {
  const normalized = String(messageId || "").trim();
  if (!normalized) return null;
  let transport = null;
  try {
    transport = resolveGmailTransport({ config, user, purpose: "reconcile" });
  } catch {
    transport = null;
  }
  const reached = normalizeEmail(transport?.gmailUser || "");
  if (!transport?.gmail?.users?.messages?.list || (mailbox && reached && reached !== normalizeEmail(mailbox))) {
    throw mailboxUnavailableError(mailbox || "the sender's mailbox");
  }
  const response = await withGmailSendCeiling(
    transport.gmail.users.messages.list({ userId: "me", q: `in:sent rfc822msgid:${normalized}`, maxResults: 5 }, GMAIL_SEND_REQUEST_OPTIONS),
    "reconcileJobEmail",
  );
  const match = response?.data?.messages?.[0];
  return match ? { id: match.id || null, threadId: match.threadId || null, messageId: normalized } : null;
}

function resolveGmailTransport({ config, user = null, purpose = "send" } = {}) {
  const expectedUser = resolveExpectedGmailUser(config, { user });

  const delegatedUser = resolveGmailDelegatedUser(config, { user });
  if (hasGoogleServiceAccountKey(config) && delegatedUser) {
    const scopes = purpose === "reconcile" ? GMAIL_DELEGATED_RECONCILE_SCOPES : GMAIL_DELEGATED_SEND_SCOPES;
    const cacheKey = `service:${purpose}:${delegatedUser}:${googleServiceAccountCacheId(config)}`;
    if (_gmailClients.has(cacheKey)) return _gmailClients.get(cacheKey);
    const key = loadGoogleServiceAccountCredentials(config);
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes,
      subject: delegatedUser,
    });
    const transport = {
      gmail: google.gmail({ version: "v1", auth }),
      authMode: "service_account_delegation",
      gmailUser: delegatedUser,
      expectedUser: expectedUser || delegatedUser,
      cacheKey,
    };
    _gmailClients.set(cacheKey, transport);
    return transport;
  }

  const oauth = resolveGmailOAuthConfig(config, { user });
  const clientId = oauth.clientId;
  const clientSecret = oauth.clientSecret;
  const refreshToken = oauth.refreshToken;

  if (clientId === CLOUD_SDK_CLIENT_ID) {
    throw new Error("mail.googleOAuth is using the Google Cloud SDK OAuth client. Gmail send requires an app-owned OAuth client.");
  }

  if (!clientId || !clientSecret || !refreshToken) return null;
  const credentialEmail = normalizeEmail(oauth.consentEmail);
  if (expectedUser && credentialEmail && credentialEmail !== expectedUser) {
    throw new Error(`Gmail is authorized as ${credentialEmail}, but the logged-in Field user is ${expectedUser}. Re-authorize Gmail while logged in as ${expectedUser}.`);
  }
  if (expectedUser && !credentialEmail) {
    throw new Error(`Gmail authorization for ${expectedUser} has no verified account email. Re-authorize Gmail so Field can confirm Sent Mail will be saved to the right mailbox.`);
  }

  const cacheKey = `oauth:${credentialEmail || expectedUser || "global"}:${String(refreshToken).slice(-12)}`;
  if (_gmailClients.has(cacheKey)) return _gmailClients.get(cacheKey);
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const transport = {
    gmail: google.gmail({ version: "v1", auth }),
    authMode: "oauth",
    gmailUser: credentialEmail || expectedUser || "",
    expectedUser,
    cacheKey,
  };
  _gmailClients.set(cacheKey, transport);
  return transport;
}

export function resolveGmailOAuthConfig(config = {}, { user = null } = {}) {
  const oauth = config.googleOAuth || {};
  const userEmail = normalizeEmail(user?.settings?.gmail?.email || user?.email || "");
  const userOAuth = userEmail && oauth.users && typeof oauth.users === "object"
    ? oauth.users[userEmail] || null
    : null;
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || oauth.clientId || userOAuth?.clientId || "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || oauth.clientSecret || userOAuth?.clientSecret || "",
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || userOAuth?.refreshToken || oauth.refreshToken || "",
    consentEmail: userOAuth?.consentEmail || oauth.consentEmail || "",
  };
}

function resolveExpectedGmailUser(config = {}, { user = null } = {}) {
  const mailConfig = config.mail || {};
  return normalizeEmail(
    process.env.FIELD_MAIL_GMAIL_USER
      || user?.settings?.gmail?.email
      || (user?.kind === "human" ? user?.email : "")
      || mailConfig.gmailUser
      || "",
  );
}

export function resolveGmailDelegatedUser(config = {}, options = {}) {
  return resolveExpectedGmailUser(config, options);
}

export function hasServiceAccountGmail(config = {}, options = {}) {
  return Boolean(hasGoogleServiceAccountKey(config) && resolveGmailDelegatedUser(config, options));
}

export function resolveGmailLoginHint(config = {}, { user = null } = {}) {
  const mailConfig = config.mail || {};
  return normalizeEmail(
    process.env.FIELD_MAIL_GMAIL_USER
      || user?.settings?.gmail?.email
      || user?.email
      || mailConfig.gmailUser
      || process.env.FIELD_MAIL_FROM
      || mailConfig.fromEmail
      || mailConfig.replyTo
      || "",
  );
}

// The host part of the stable Message-ID a delivery attempt carries (#50).
// It is the installation's own: `mail.messageIdHost` (or
// FIELD_MAIL_MESSAGE_ID_HOST) when set, else the domain of the address Field
// sends from, else a neutral reserved host. The Message-ID is stored with the
// delivery attempt when it is prepared and never rebuilt, so a send prepared
// before this change keeps its old host and Sent Mail is still searched for it.
export const NEUTRAL_MESSAGE_ID_HOST = "field.invalid";
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function resolveMessageIdHost({ config = {}, user = null, fromEmail = "" } = {}) {
  const configured = normalizeEmail(process.env.FIELD_MAIL_MESSAGE_ID_HOST || config?.mail?.messageIdHost || "");
  if (configured && HOST_PATTERN.test(configured)) return configured;
  let sender = normalizeEmail(fromEmail);
  if (!sender) {
    try {
      sender = resolveMailSender({ config, user }).fromEmail;
    } catch {
      sender = "";
    }
  }
  const domain = sender.includes("@") ? sender.slice(sender.lastIndexOf("@") + 1) : "";
  return HOST_PATTERN.test(domain) ? domain : NEUTRAL_MESSAGE_ID_HOST;
}

export function formatDeliveryMessageId(attemptId, host = NEUTRAL_MESSAGE_ID_HOST) {
  return `<field-${cleanHeaderText(attemptId)}@${cleanHeaderText(host) || NEUTRAL_MESSAGE_ID_HOST}>`;
}

// messages.send takes the whole message in the JSON `raw` field only up to
// about 5 MB (Google's simple-request limit); anything larger must use the
// media upload form (/upload/gmail/v1/users/me/messages/send, up to 35 MB).
// Small messages keep the JSON form they always used.
export const GMAIL_RAW_JSON_MAX_CHARS = 4 * 1024 * 1024;

/** The earlier conversation's Gmail thread id, only when it is this mailbox's. */
export function threadIdForMailbox(thread, mailbox) {
  const earlier = normalizeEmail(thread?.gmailUser || "");
  const sending = normalizeEmail(mailbox || "");
  return thread?.threadId && earlier && sending && earlier === sending ? thread.threadId : null;
}

export async function sendGmailMessage(gmail, raw, { threadId = null, signal = null } = {}) {
  const thread = threadId ? { threadId } : {};
  const options = signal ? { ...GMAIL_SEND_REQUEST_OPTIONS, signal } : GMAIL_SEND_REQUEST_OPTIONS;
  if (raw.length <= GMAIL_RAW_JSON_MAX_CHARS) {
    return gmail.users.messages.send({ userId: "me", requestBody: { raw, ...thread } }, options);
  }
  return gmail.users.messages.send({
    userId: "me",
    requestBody: { ...thread },
    media: { mimeType: "message/rfc822", body: Buffer.from(raw, "base64url") },
  }, options);
}

/** A send the ceiling gave up on stops before Gmail rather than going late. */
function assertNotAbandoned(signal) {
  if (!signal?.aborted) return;
  const error = new Error("email not sent: the Gmail send ceiling passed before it reached Gmail");
  error.code = "DELIVERY_ATTEMPT_STALE";
  error.deliveryOutcome = "rejected_before_dispatch";
  throw error;
}

// What the result (and the sent-email archive) says about each extra
// attachment: a Field document by uid and hash, an upload by size and hash.
function describeExtraAttachment(attachment, index) {
  const described = {
    filename: attachment.filename || `attachment-${index + 1}`,
    contentType: attachment.contentType || "application/octet-stream",
  };
  if (attachment.uid) {
    Object.assign(described, {
      source: "document",
      uid: attachment.uid,
      documentType: attachment.documentType || null,
      number: attachment.number || null,
    });
  } else {
    described.source = "upload";
  }
  if (attachment.buffer) {
    described.byteLength = attachment.buffer.length;
    described.sha256 = createHash("sha256").update(attachment.buffer).digest("hex");
  }
  return described;
}

export async function sendQuoteEmail(args) {
  return withGmailSendCeiling(performSendQuoteEmail(args), "sendQuoteEmail");
}

async function performSendQuoteEmail({
  config,
  user = null,
  meta,
  quote,
  quotePdfBuffer,
  quotePdfFilename,
  to,
  cc = [],
  bcc = [],
  emailMode = "summary",
  customBody = null,
  documentType = null,
  invoicePaidAmount = null,
  themeFontFamily = null,
  subjectOverride = null,
  additionalAttachments = [],
  deliveryAttemptId = null,
  deliveryMessageId = null,
  // Into the earlier Gmail conversation: { threadId, inReplyTo, references }.
  thread = null,
}) {
  const recipients = assertAllowedQuoteRecipients({ config, emails: to, label: "recipient" });
  const ccRecipients = assertAllowedQuoteRecipients({ config, emails: cc, label: "cc", required: false });
  const bccRecipients = assertAllowedQuoteRecipients({ config, emails: bcc, label: "bcc", required: false });
  const transport = resolveGmailTransport({ config, user });
  if (!transport?.gmail) {
    throw new Error("Gmail OAuth is not configured for quote sending.");
  }
  const gmail = transport.gmail;

  const senderProfile = await getAuthenticatedSender(transport);
  const sender = resolveMailSender({
    config,
    user,
    gmailUser: transport.gmailUser || senderProfile,
  });

  if (!sender.fromEmail) {
    throw new Error("mail.fromEmail or FIELD_MAIL_FROM is required for quote sending.");
  }

  const { subject, body, htmlBody, documentLabelLower } = await composeDocumentEmail({
    meta,
    quote,
    documentType,
    customBody,
    subjectOverride,
    emailMode,
    themeFontFamily,
    fromName: sender.fromName,
  });

  const raw = buildMimeMessage({
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    replyTo: sender.replyTo,
    to: recipients,
    cc: ccRecipients,
    bcc: bccRecipients,
    subject,
    body,
    htmlBody,
    attachmentName: quotePdfFilename || `${documentLabelLower}-v${String(quote.version || 1).padStart(3, "0")}.pdf`,
    attachmentBody: quotePdfBuffer,
    attachmentContentType: "application/pdf",
    additionalAttachments,
    deliveryAttemptId,
    messageId: deliveryAttemptId
      ? deliveryMessageId || formatDeliveryMessageId(deliveryAttemptId, resolveMessageIdHost({ config, user, fromEmail: sender.fromEmail }))
      : null,
    inReplyTo: thread?.inReplyTo || null,
    references: thread?.references || null,
  });

  // Gmail's thread id belongs to one mailbox: another mailbox's would be
  // refused or misfiled, so it threads by its headers and "Re:" alone.
  const result = await sendGmailMessage(gmail, raw, { threadId: threadIdForMailbox(thread, transport.gmailUser || sender.fromEmail) });

  return {
    id: result.data.id,
    threadId: result.data.threadId,
    subject,
    from: sender.fromEmail,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
    gmailUser: transport.gmailUser || sender.fromEmail,
    authMode: transport.authMode,
    to: recipients,
    cc: ccRecipients,
    bcc: bccRecipients,
    bodyText: body,
    htmlBody,
    attachments: [
      {
        filename: quotePdfFilename || `${documentLabelLower}-v${String(quote.version || 1).padStart(3, "0")}.pdf`,
        contentType: "application/pdf",
      },
      ...additionalAttachments.map(describeExtraAttachment),
    ],
  };
}

/**
 * The subject, plain text and HTML of a quote, invoice or receipt email:
 * what the send builds and what the composer's preview shows
 * (POST /api/jobs/:id/email-preview), from one function.
 */
export async function composeDocumentEmail({
  meta,
  quote,
  documentType = null,
  customBody = null,
  subjectOverride = null,
  emailMode = "summary",
  themeFontFamily = null,
  fromName = null,
}) {
  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  const documentLabelLower = getJobDocumentLabelLower(resolvedDocumentType);
  const subject = cleanHeaderText(subjectOverride) || defaultDocumentSubject({ meta, quote, documentType: resolvedDocumentType });
  const body = customBody ? emailHtmlToText(customBody) : buildEmailBody({ meta, quote, documentType: resolvedDocumentType });

  const quoteCatalog = quote.quoteCatalog || quote.profile || {};
  const deliveryDefaults = quoteCatalog.deliveryDefaults || {};
  const biz = applyBusinessProfileOverride(quoteCatalog.businessProfile || {});
  // A quote email's totals come from the quote's rows (#10).
  const rowsView = resolvedDocumentType === "quote" ? await loadQuoteRows({ quote, meta }) : null;
  const htmlBody = await buildEmailHtml({
    meta,
    quote,
    totals: rowsView?.financials || null,
    biz,
    deliveryDefaults,
    fromName,
    mode: emailMode,
    customBody,
    documentType: resolvedDocumentType,
    themeFontFamily,
  });
  return { subject, body, htmlBody, resolvedDocumentType, documentLabelLower };
}

/** The subject a document email gets when the operator leaves it as it is. */
export function defaultDocumentSubject({ meta, quote, documentType }) {
  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  const milestoneInvoice = meta?.milestoneInvoice || null;
  const isReceipt = resolvedDocumentType === "receipt";
  const isInvoice = resolvedDocumentType === "invoice";
  const documentRef = isInvoice
    ? buildInvoiceDocumentNumber({ meta, quote, milestoneInvoice })
    : isReceipt
      ? buildReceiptDocumentNumber({ meta, quote, milestoneInvoice })
      : (quote?.quoteNumber || meta?.quoteNumber || meta?.id || null);
  if (isInvoice || isReceipt) {
    return [
      isReceipt ? "Receipt" : "Invoice",
      documentRef,
      milestoneInvoice?.milestoneLabel || meta?.title || meta?.label || documentBusinessName(quote),
    ].filter(Boolean).join(" — ");
  }
  return `${quote?.delivery?.status === "final" ? "Quote" : "Quote Draft"} — ${meta?.title || meta?.label || documentBusinessName(quote)}`;
}

/** The subject, plain text and HTML of a job email with no document of its own. */
export function composeJobEmail({ meta, subject = null, customBody = null, themeFontFamily = null, fromName = null }) {
  return {
    subject: cleanHeaderText(subject) || defaultJobEmailSubject(meta),
    htmlBody: wrapGenericEmailHtml({ customBody, fromName, themeFontFamily }),
    body: emailHtmlToText(customBody || ""),
  };
}

export function defaultJobEmailSubject(meta) {
  return `Job update — ${meta?.title || meta?.label || meta?.siteAddress || meta?.id || installationBusinessName()}`;
}

export async function sendJobEmail(args) {
  const controller = new AbortController();
  return withGmailSendCeiling(performSendJobEmail({ ...args, signal: controller.signal }), "sendJobEmail", GMAIL_SEND_TIMEOUT_MS, controller);
}

async function performSendJobEmail({
  config,
  user = null,
  meta,
  to,
  cc = [],
  bcc = [],
  subject,
  customBody = null,
  themeFontFamily = null,
  additionalAttachments = [],
  // A queued job email's stable delivery attempt (scheduled-email-queue.js),
  // so Sent Mail can be searched for it after a send of unknown outcome.
  deliveryAttemptId = null,
  messageId = null,
  // While an earlier attempt is unknown, the mailbox it went from: this one
  // goes only from there.
  mailbox = null,
  // Called with { mailbox, messageId, sent } just before Gmail, so the queue
  // stores them durably first (scheduled-email-queue.js).
  onBeforeDispatch = null,
  // Aborted when the send ceiling gives up (sendJobEmail).
  signal = null,
  thread = null,
}) {
  const recipients = assertAllowedQuoteRecipients({ config, emails: to, label: "recipient" });
  const ccRecipients = assertAllowedQuoteRecipients({ config, emails: cc, label: "cc", required: false });
  const bccRecipients = assertAllowedQuoteRecipients({ config, emails: bcc, label: "bcc", required: false });
  let transport;
  try {
    transport = resolveGmailTransport({ config, user });
  } catch (error) {
    error.deliveryOutcome = "rejected_before_dispatch";
    throw error;
  }
  if (!transport?.gmail) {
    const error = mailbox
      ? mailboxUnavailableError(mailbox)
      : new Error("Gmail OAuth is not configured for job email sending.");
    error.deliveryOutcome = "rejected_before_dispatch";
    throw error;
  }
  const gmail = transport.gmail;

  const senderProfile = await getAuthenticatedSender(transport);
  const sender = resolveMailSender({
    config,
    user,
    gmailUser: transport.gmailUser || senderProfile,
  });
  if (!sender.fromEmail) {
    const error = new Error("mail.fromEmail or FIELD_MAIL_FROM is required for email sending.");
    error.deliveryOutcome = "rejected_before_dispatch";
    throw error;
  }

  const sendingMailbox = normalizeEmail(transport.gmailUser || sender.fromEmail);
  if (mailbox && normalizeEmail(mailbox) !== sendingMailbox) {
    const error = mailboxUnavailableError(mailbox);
    error.deliveryOutcome = "rejected_before_dispatch";
    throw error;
  }
  const deliveryMessageId = deliveryAttemptId
    ? messageId || formatDeliveryMessageId(deliveryAttemptId, resolveMessageIdHost({ config, user, fromEmail: sender.fromEmail }))
    : null;

  const { subject: resolvedSubject, htmlBody, body } = composeJobEmail({
    meta,
    subject,
    customBody,
    themeFontFamily,
    fromName: sender.fromName,
  });

  const raw = buildMimeMessage({
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    replyTo: sender.replyTo,
    to: recipients,
    cc: ccRecipients,
    bcc: bccRecipients,
    subject: resolvedSubject,
    body,
    htmlBody,
    additionalAttachments,
    deliveryAttemptId,
    messageId: deliveryMessageId,
    inReplyTo: thread?.inReplyTo || null,
    references: thread?.references || null,
  });

  assertNotAbandoned(signal);
  if (onBeforeDispatch) {
    await onBeforeDispatch({
      mailbox: sendingMailbox,
      messageId: deliveryMessageId,
      sent: {
        from: sender.fromEmail,
        fromName: sender.fromName,
        replyTo: sender.replyTo,
        gmailUser: sendingMailbox,
        authMode: transport.authMode,
        to: recipients,
        cc: ccRecipients,
        bcc: bccRecipients,
        subject: resolvedSubject,
        bodyText: body,
        htmlBody,
        attachments: additionalAttachments.map(describeExtraAttachment),
        rfcMessageId: deliveryMessageId,
        references: thread?.references || null,
      },
    });
  }

  assertNotAbandoned(signal);
  // Gmail's thread id belongs to one mailbox: another mailbox's would be
  // refused or misfiled, so it threads by its headers and "Re:" alone.
  const result = await sendGmailMessage(gmail, raw, { threadId: threadIdForMailbox(thread, sendingMailbox), signal });

  return {
    id: result.data.id,
    threadId: result.data.threadId,
    subject: resolvedSubject,
    from: sender.fromEmail,
    fromName: sender.fromName,
    replyTo: sender.replyTo,
    gmailUser: transport.gmailUser || sender.fromEmail,
    authMode: transport.authMode,
    to: recipients,
    cc: ccRecipients,
    bcc: bccRecipients,
    bodyText: body,
    htmlBody,
    attachments: additionalAttachments.map(describeExtraAttachment),
  };
}

/**
 * Send a test copy of an email (Send a test to me): to the signed-in
 * person's own address only, "[Test]" in front of the subject. No delivery
 * attempt, no Message-ID of Field's, nothing recorded.
 */
export async function sendTestEmail(args) {
  return withGmailSendCeiling(performSendTestEmail(args), "sendTestEmail");
}

async function performSendTestEmail({ config, user, subject, body, htmlBody, attachments = [] }) {
  const own = normalizeEmail(user?.email || "");
  if (!own) {
    const error = new Error("a test email goes to your own address, and this sign-in has none");
    error.statusCode = 400;
    throw error;
  }
  const recipients = assertAllowedQuoteRecipients({ config, emails: [own], label: "recipient" });
  const transport = resolveGmailTransport({ config, user });
  if (!transport?.gmail) throw new Error("Gmail OAuth is not configured for job email sending.");
  const senderProfile = await getAuthenticatedSender(transport);
  const sender = resolveMailSender({ config, user, gmailUser: transport.gmailUser || senderProfile });
  const testSubject = `[Test] ${cleanHeaderText(subject)}`.trim();
  const raw = buildMimeMessage({
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    replyTo: sender.replyTo,
    to: recipients,
    subject: testSubject,
    body,
    htmlBody,
    additionalAttachments: attachments,
  });
  const result = await sendGmailMessage(transport.gmail, raw);
  return {
    id: result.data.id,
    threadId: result.data.threadId,
    subject: testSubject,
    to: recipients,
    attachments: attachments.map(describeExtraAttachment),
  };
}

export function resolveMailSender({ config = {}, user = null, gmailUser = "" } = {}) {
  const mailConfig = config.mail || {};
  const humanUserEmail = user?.kind === "human" ? normalizeEmail(user.email) : "";
  const fromEmail = normalizeEmail(
    process.env.FIELD_MAIL_FROM
      || user?.settings?.gmail?.fromEmail
      || humanUserEmail
      || mailConfig.fromEmail
      || mailConfig.gmailUser
      || gmailUser
      || "",
  );
  const normalizedGmailUser = normalizeEmail(gmailUser);
  if (fromEmail && normalizedGmailUser && fromEmail !== normalizedGmailUser) {
    throw new Error(`Gmail sender mismatch: Field would send From ${fromEmail}, but Gmail is authenticated as ${normalizedGmailUser}. Re-authorize or configure Gmail for ${fromEmail}.`);
  }
  return {
    fromEmail,
    fromName: process.env.FIELD_MAIL_FROM_NAME || mailConfig.fromName || user?.name || installationBusinessName(),
    replyTo: normalizeEmail(process.env.FIELD_MAIL_REPLY_TO || user?.settings?.gmail?.replyTo || mailConfig.replyTo || fromEmail),
  };
}

export function assertAllowedQuoteRecipient({ config, to }) {
  return assertAllowedQuoteRecipients({ config, emails: to, label: "recipient" })[0];
}

export function assertAllowedQuoteRecipients({ config, emails, label = "recipient", required = true }) {
  const recipients = normalizeEmailList(emails);
  if (!recipients.length) {
    if (!required) return [];
    const err = new Error("recipient email required");
    err.statusCode = 400;
    throw err;
  }

  const policy = resolveMailDeliveryPolicy(config);
  if (policy.mode === "live") return recipients;

  if (policy.mode === "disabled") {
    const err = new Error("Quote email delivery is disabled in this environment.");
    err.statusCode = 403;
    throw err;
  }

  if (!policy.allowedRecipients.length) {
    const err = new Error("Quote email delivery allowlist is enabled but no allowed recipients are configured.");
    err.statusCode = 500;
    throw err;
  }

  const blocked = recipients.filter((recipient) => !policy.allowedRecipients.includes(recipient));
  if (blocked.length) {
    const err = new Error(`Quote email delivery is restricted in this environment. Allowed recipients: ${policy.allowedRecipients.join(", ")}`);
    err.statusCode = 403;
    throw err;
  }

  return recipients;
}

export function resolveMailDeliveryPolicy(config) {
  const mailConfig = config?.mail || {};
  const rawMode = process.env.FIELD_MAIL_DELIVERY_POLICY
    ?? mailConfig.deliveryPolicy?.mode
    ?? mailConfig.deliveryMode
    ?? "live";
  const mode = String(rawMode || "").trim().toLowerCase();
  if (!["live", "allowlist", "disabled"].includes(mode)) {
    throw new Error(`Invalid mail delivery policy mode: ${rawMode}`);
  }

  const envRecipients = process.env.FIELD_MAIL_ALLOWED_RECIPIENTS
    ? process.env.FIELD_MAIL_ALLOWED_RECIPIENTS.split(",")
    : null;
  const configuredRecipients = envRecipients ?? mailConfig.deliveryPolicy?.allowedRecipients ?? mailConfig.allowedRecipients ?? [];

  return {
    mode,
    allowedRecipients: dedupe(
      configuredRecipients
        .map(normalizeEmail)
        .filter(Boolean)
    ),
  };
}

async function getAuthenticatedSender(transport) {
  if (!transport?.gmail) return null;
  if (transport.gmailUser) return transport.gmailUser;
  const cacheKey = transport.cacheKey || "default";
  if (_gmailProfiles.has(cacheKey)) return _gmailProfiles.get(cacheKey);
  try {
    const profile = await transport.gmail.users.getProfile({ userId: "me" }, GMAIL_SEND_REQUEST_OPTIONS);
    const email = normalizeEmail(profile.data.emailAddress || "");
    _gmailProfiles.set(cacheKey, email);
    return email;
  } catch {
    return null;
  }
}

function buildEmailBody({
  meta,
  quote,
  documentType = "quote",
}) {
  return [
    "Hi,",
    "",
    resolvedDocumentIntro({ quote, documentType, meta }),
    "",
    documentType !== "quote" && meta?.milestoneInvoice?.milestoneLabel
      ? `Milestone: ${meta.milestoneInvoice.milestoneLabel}`
      : null,
    documentType === "invoice" && meta?.milestoneInvoice?.dueDate
      ? `Due date: ${formatDate(meta.milestoneInvoice.dueDate)}`
      : null,
    documentType !== "quote" ? meta?.milestoneInvoice?.contextNote || null : null,
    "",
    documentType === "invoice"
      ? "Reply to this email if you have any questions about this invoice."
      : documentType === "receipt"
        ? "Reply to this email if you need another copy of this receipt."
        : "Reply to this email if you want any adjustments or clarifications.",
    "",
    "Regards,",
    documentBusinessName(quote),
    meta.title || meta.label ? `Reference: ${meta.title || meta.label}` : null,
  ].filter(Boolean).join("\n");
}

function buildEmailHtml({
  meta,
  quote,
  biz,
  deliveryDefaults,
  fromName,
  mode,
  customBody = null,
  documentType = "quote",
  themeFontFamily = null,
  totals = null,
}) {
  const clientName = meta.clientName || meta.client?.name || null;
  const jobTitle = meta.title || meta.label || null;
  const quoteNumber = documentType === "invoice"
    ? buildInvoiceDocumentNumber({
        meta,
        quote,
        milestoneInvoice: meta?.milestoneInvoice || null,
      })
    : documentType === "receipt"
      ? buildReceiptDocumentNumber({
          meta,
          quote,
          milestoneInvoice: meta?.milestoneInvoice || null,
        })
      : (quote.quoteNumber || meta.quoteNumber || meta.id || null);
  const validDays = quote.presentation?.validityDays
    || deliveryDefaults?.validityDays
    || 30;
  const quoteDateSource = documentType === "receipt"
    ? (meta?.receiptIssuedAt || meta?.milestoneInvoice?.paidAt || meta?.milestoneInvoice?.payments?.[meta?.milestoneInvoice?.payments?.length - 1]?.recordedAt || null)
    : quote.quoteDate;
  const quoteDate = quoteDateSource
    ? new Date(quoteDateSource).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })
    : new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

  return renderQuoteEmailHtml({
    clientName,
    jobTitle,
    quoteNumber,
    quoteDate,
    validDays,
    lineItems: [],
    subtotal: totals ? totals.subtotal : quote.totals?.subtotal,
    gst: totals ? totals.gst : quote.totals?.gst,
    total: totals ? totals.total : quote.totals?.total,
    companyName: businessNameOf(biz) || fromName || installationBusinessName(),
    companyAbn: biz.abn || null,
    companyAddress: biz.address || null,
    companyPhone: biz.phone || null,
    companyEmail: biz.email || null,
    mode,
    customBody,
    documentType,
    milestoneLabel: meta?.milestoneInvoice?.milestoneLabel || null,
    dueDate: meta?.milestoneInvoice?.dueDate || null,
    contextNote: meta?.milestoneInvoice?.contextNote || null,
    themeFontFamily,
  });
}

// The business name an email speaks for: the configured profile's merged over
// the quote catalogue's, trading name else legal name (business-profile.js).
function documentBusinessName(quote = null) {
  const profile = quote?.quoteCatalog?.businessProfile || quote?.profile?.businessProfile || null;
  return businessDisplayName(applyBusinessProfileOverride(profile || {}));
}

function resolvedDocumentIntro({ quote, documentType, meta = null }) {
  const business = documentBusinessName(quote);
  if (documentType === "invoice") {
    if (meta?.milestoneInvoice?.milestoneLabel) {
      return `Please find the ${meta.milestoneInvoice.milestoneLabel.toLowerCase()} invoice from ${business} attached as a PDF.`;
    }
    return `Please find the invoice from ${business} attached as a PDF.`;
  }
  if (documentType === "receipt") {
    if (meta?.milestoneInvoice?.milestoneLabel) {
      return `Please find the receipt for the ${meta.milestoneInvoice.milestoneLabel.toLowerCase()} milestone from ${business} attached as a PDF.`;
    }
    return `Please find the receipt from ${business} attached as a PDF.`;
  }
  return `Please find the ${quote.delivery?.status === "final" ? "quote" : "draft quote"} from ${business} attached as a PDF.`;
}

export function buildMimeMessage({
  fromName,
  fromEmail,
  replyTo,
  to,
  cc = [],
  bcc = [],
  subject,
  body,
  htmlBody,
  attachmentName,
  attachmentBody,
  attachmentContentType,
  additionalAttachments = [],
  deliveryAttemptId = null,
  messageId = null,
  // RFC 5322 threading: the Message-ID this replies to, and the chain.
  inReplyTo = null,
  references = null,
}) {
  const mixedBoundary = `field-mixed-${Date.now()}`;
  const altBoundary = `field-alt-${Date.now()}`;
  const attachments = [
    attachmentBody ? {
      filename: attachmentName,
      contentType: attachmentContentType,
      buffer: attachmentBody,
    } : null,
    ...normalizeExtraAttachments(additionalAttachments),
  ].filter(Boolean);
  const toHeader = formatAddressListHeader(to);
  const ccHeader = formatAddressListHeader(cc);
  const bccHeader = formatAddressListHeader(bcc);
  const headers = [
    `From: ${encodeHeader(fromName)} <${fromEmail}>`,
    `To: ${toHeader}`,
    ccHeader ? `Cc: ${ccHeader}` : null,
    bccHeader ? `Bcc: ${bccHeader}` : null,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodeHeader(subject)}`,
    ...(deliveryAttemptId
      ? [
          `Message-ID: ${cleanHeaderText(messageId) || formatDeliveryMessageId(deliveryAttemptId)}`,
          `X-Field-Delivery-Attempt: ${cleanHeaderText(deliveryAttemptId)}`,
        ]
      : []),
    ...(cleanHeaderText(inReplyTo) ? [`In-Reply-To: ${cleanHeaderText(inReplyTo)}`] : []),
    ...(cleanHeaderText(references) ? [`References: ${cleanHeaderText(references)}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ].filter(Boolean);

  const altPart = htmlBody
    ? [
        `--${mixedBoundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        "",
        `--${altBoundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        body,
        "",
        `--${altBoundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        htmlBody,
        "",
        `--${altBoundary}--`,
      ]
    : [
        `--${mixedBoundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        body,
      ];

  const attachmentParts = attachments.flatMap((attachment) => {
    const filename = sanitizeMimeToken(attachment.filename || "attachment");
    const contentType = sanitizeMimeToken(attachment.contentType || "application/octet-stream");
    return [
      "",
      `--${mixedBoundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      Buffer.from(attachment.buffer).toString("base64"),
    ];
  });

  const parts = [
    ...altPart,
    ...attachmentParts,
    "",
    `--${mixedBoundary}--`,
    "",
  ];

  return Buffer.from([...headers, "", ...parts].join("\r\n"))
    .toString("base64url");
}

function normalizeExtraAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((attachment) => attachment?.buffer)
    .map((attachment, index) => ({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.contentType || "application/octet-stream",
      buffer: attachment.buffer,
    }));
}

function sanitizeMimeToken(value) {
  return String(value || "")
    .replace(/[\r\n"]/g, "")
    .trim()
    || "attachment";
}

function cleanHeaderText(value) {
  return String(value || "").replace(/[\r\n]/g, " ").trim();
}

function formatAddressListHeader(value) {
  return normalizeEmailList(value)
    .map(cleanHeaderText)
    .join(", ");
}

function wrapGenericEmailHtml({ customBody, fromName, themeFontFamily }) {
  const fontFamily = cleanHeaderText(themeFontFamily) || "Helvetica, Arial, sans-serif";
  const safeBody = sanitizeGenericBodyHtml(customBody || "");
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:${escapeHtml(fontFamily)};">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;padding:28px 30px;color:#2d2d2d;font-size:14px;line-height:1.6;">
      ${safeBody || "<p>Hi,</p><p></p>"}
      <div style="margin-top:28px;padding-top:14px;border-top:1px solid #e0e0e0;color:#6b6b6b;font-size:12px;">
        ${escapeHtml(fromName || installationBusinessName())}
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmailList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,;]+/);
  return dedupe(
    raw
      .map(normalizeEmail)
      .filter(Boolean)
  );
}

function dedupe(values) {
  return [...new Set(values || [])];
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-AU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** The plain-text body of a quote, invoice or receipt email (exported for tests). */
export { buildEmailBody as buildDocumentEmailText };
