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
import { renderQuoteEmailHtml } from "./quote-email-template.js";

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
// the service-account transport always did before #139. Google refuses the
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
// every other milestone mutation (DEL-30 P2-4). That lock is stealable: a
// holder that has not finished after job-mutation-guard.js's stale-lock
// timeout (120s) is evicted while its task keeps running. `gaxios` (which
// the Gmail client is built on) has no request timeout by default, so a
// hung send could hold the lock past 120s, lose it to a competing mutation,
// and then still run its own post-send persist — last-writer-wins over
// milestone-invoices/state.json, silently erasing whatever the winner just
// committed (DEL-30 P2-2, round 5). Bounding the request here — comfortably
// under 120s, with no gaxios-internal retry to extend it unpredictably —
// keeps the steal unreachable while a send is actually in flight: it either
// completes or fails within the bound, never straddles the eviction. On
// timeout the caller sees a clean rejection with none of the invoice's
// already-persisted state touched again.
//
// GMAIL_SEND_REQUEST_OPTIONS only bounds the individual gaxios HTTP call it
// is passed to. Two calls inside this locked region were not receiving it
// (DEL-30 P3-1, round 6): getAuthenticatedSender's own `getProfile` request,
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
export function withGmailSendCeiling(work, label, ms = GMAIL_SEND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `${label} exceeded the ${ms}ms send ceiling (DEL-30 P3-1): a Gmail API call `
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

  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  const documentLabelLower = getJobDocumentLabelLower(resolvedDocumentType);
  const milestoneInvoice = meta?.milestoneInvoice || null;
  const isReceipt = resolvedDocumentType === "receipt";
  const isInvoice = resolvedDocumentType === "invoice";
  const isPaymentDocument = isInvoice || isReceipt;
  const documentRef = isInvoice
    ? buildInvoiceDocumentNumber({ meta, quote, milestoneInvoice })
    : isReceipt
      ? buildReceiptDocumentNumber({ meta, quote, milestoneInvoice })
      : (quote.quoteNumber || meta.quoteNumber || meta.id || null);
  const defaultSubject = isPaymentDocument
    ? [
        isReceipt ? "Receipt" : "Invoice",
        documentRef,
        milestoneInvoice?.milestoneLabel || meta.title || meta.label || "Your Business",
      ].filter(Boolean).join(" — ")
    : `${quote.delivery?.status === "final" ? "Quote" : "Quote Draft"} — ${meta.title || meta.label || "Your Business"}`;
  const subject = cleanHeaderText(subjectOverride) || defaultSubject;
  const body = customBody ? stripHtml(customBody) : buildEmailBody({ meta, quote, documentType: resolvedDocumentType });

  const quoteCatalog = quote.quoteCatalog || quote.profile || {};
  const deliveryDefaults = quoteCatalog.deliveryDefaults || {};
  const biz = quoteCatalog.businessProfile || {};
  const htmlBody = buildEmailHtml({
    meta,
    quote,
    biz,
    deliveryDefaults,
    fromName: sender.fromName,
    mode: emailMode,
    customBody,
    documentType: resolvedDocumentType,
    themeFontFamily,
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
  });

  const result = await gmail.users.messages.send(
    {
      userId: "me",
      requestBody: { raw },
    },
    GMAIL_SEND_REQUEST_OPTIONS,
  );

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
      ...additionalAttachments.map((attachment, index) => ({
        filename: attachment.filename || `attachment-${index + 1}`,
        contentType: attachment.contentType || "application/octet-stream",
      })),
    ],
  };
}

export async function sendJobEmail(args) {
  return withGmailSendCeiling(performSendJobEmail(args), "sendJobEmail");
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
}) {
  const recipients = assertAllowedQuoteRecipients({ config, emails: to, label: "recipient" });
  const ccRecipients = assertAllowedQuoteRecipients({ config, emails: cc, label: "cc", required: false });
  const bccRecipients = assertAllowedQuoteRecipients({ config, emails: bcc, label: "bcc", required: false });
  const transport = resolveGmailTransport({ config, user });
  if (!transport?.gmail) {
    throw new Error("Gmail OAuth is not configured for job email sending.");
  }
  const gmail = transport.gmail;

  const senderProfile = await getAuthenticatedSender(transport);
  const sender = resolveMailSender({
    config,
    user,
    gmailUser: transport.gmailUser || senderProfile,
  });
  if (!sender.fromEmail) {
    throw new Error("mail.fromEmail or FIELD_MAIL_FROM is required for email sending.");
  }

  const resolvedSubject = cleanHeaderText(subject) || `Job update — ${meta?.title || meta?.label || meta?.siteAddress || meta?.id || "Your Business"}`;
  const htmlBody = wrapGenericEmailHtml({
    customBody,
    fromName: sender.fromName,
    themeFontFamily,
  });
  const body = stripHtml(customBody || "");

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
  });

  const result = await gmail.users.messages.send(
    {
      userId: "me",
      requestBody: { raw },
    },
    GMAIL_SEND_REQUEST_OPTIONS,
  );

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
    attachments: additionalAttachments.map((attachment, index) => ({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.contentType || "application/octet-stream",
    })),
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
    fromName: process.env.FIELD_MAIL_FROM_NAME || mailConfig.fromName || user?.name || "Your Business",
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
    "Your Business",
    meta.title || meta.label ? `Reference: ${meta.title || meta.label}` : null,
  ].filter(Boolean).join("\n");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>\s*<li[^>]*>/gi, "\n- ")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
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
    subtotal: quote.totals?.subtotal,
    gst: quote.totals?.gst,
    total: quote.totals?.total,
    companyName: biz.tradingName || fromName || "Your Business",
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

function resolvedDocumentIntro({ quote, documentType, meta = null }) {
  if (documentType === "invoice") {
    if (meta?.milestoneInvoice?.milestoneLabel) {
      return `Please find the ${meta.milestoneInvoice.milestoneLabel.toLowerCase()} invoice from Your Business attached as a PDF.`;
    }
    return "Please find the invoice from Your Business attached as a PDF.";
  }
  if (documentType === "receipt") {
    if (meta?.milestoneInvoice?.milestoneLabel) {
      return `Please find the receipt for the ${meta.milestoneInvoice.milestoneLabel.toLowerCase()} milestone from Your Business attached as a PDF.`;
    }
    return "Please find the receipt from Your Business attached as a PDF.";
  }
  return `Please find the ${quote.delivery?.status === "final" ? "quote" : "draft quote"} from Your Business attached as a PDF.`;
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
          `Message-ID: <field-${cleanHeaderText(deliveryAttemptId)}@arcforge.local>`,
          `X-Field-Delivery-Attempt: ${cleanHeaderText(deliveryAttemptId)}`,
        ]
      : []),
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
  const safeBody = sanitizeGenericBody(customBody || "");
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:${escapeHtml(fontFamily)};">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;padding:28px 30px;color:#2d2d2d;font-size:14px;line-height:1.6;">
      ${safeBody || "<p>Hi,</p><p></p>"}
      <div style="margin-top:28px;padding-top:14px;border-top:1px solid #e0e0e0;color:#6b6b6b;font-size:12px;">
        ${escapeHtml(fromName || "Your Business")}
      </div>
    </div>
  </body>
</html>`;
}

function sanitizeGenericBody(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    .replace(/<\/?(?!p\b|br\b|strong\b|em\b|b\b|i\b|u\b|a\b|span\b|ul\b|ol\b|li\b)[a-z][a-z0-9]*(?:\s[^>]*)?\/?>/gi, "")
    .replace(/<(p|span|li)\s+([^>]*)>/gi, (_match, tag, attrs) => {
      const style = String(attrs || "").match(/style\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const safeStyle = sanitizeEmailInlineStyle(style?.[1] || style?.[2] || "");
      return safeStyle ? `<${tag} style="${escapeHtml(safeStyle)}">` : `<${tag}>`;
    })
    .replace(/<(strong|em|b|i|u|ul|ol)\s[^>]*>/gi, "<$1>")
    .replace(/<a\s+([^>]*)>/gi, (_match, attrs) => {
      const href = String(attrs || "").match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const value = String(href?.[1] || href?.[2] || href?.[3] || "").trim();
      if (!/^(https?:|mailto:|tel:)/i.test(value)) return "<a>";
      return `<a href="${escapeHtml(value)}">`;
    });
}

function sanitizeEmailInlineStyle(style) {
  const allowed = [];
  for (const declaration of String(style || "").split(";")) {
    const [rawProp, ...rawValueParts] = declaration.split(":");
    const prop = String(rawProp || "").trim().toLowerCase();
    const value = rawValueParts.join(":").trim();
    if (!prop || !value) continue;
    if (prop === "font-size" && /^\d{1,2}(?:\.\d)?px$/.test(value)) allowed.push(`${prop}:${value}`);
    if (prop === "font-family" && /^[\w\s'",.-]+$/.test(value)) allowed.push(`${prop}:${value}`);
  }
  return allowed.join(";");
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
