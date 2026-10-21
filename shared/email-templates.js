export const EMAIL_TEMPLATE_DOCUMENT_TYPES = ["email", "quote", "invoice", "receipt", "adjustment_note"];

// Merge fields: one definition, here. The server fills every value
// (server/email-merge-fields.js) for the composer, the preview and the send,
// so the composer keeps no defaults of its own. In the composer a field is
// `<span data-merge="key">value</span>`, underlined while composing; the
// server fills it again with its own value when the email is built, and the
// sent email is plain text.
export const EMAIL_MERGE_FIELDS = [
  { key: "clientName", label: "Customer name" },
  { key: "jobTitle", label: "Job" },
  { key: "siteAddress", label: "Site address" },
  { key: "documentNumber", label: "Document number" },
  { key: "amountDue", label: "Amount due" },
  { key: "dueDate", label: "Due date" },
  { key: "replacesNumber", label: "Invoice it replaces" },
  { key: "creditNoteNumber", label: "Adjustment note number" },
  { key: "attachmentList", label: "Attachments" },
  { key: "senderName", label: "Your name" },
  { key: "businessName", label: "Business name" },
];
export const EMAIL_MERGE_FIELD_KEYS = EMAIL_MERGE_FIELDS.map((field) => field.key);

export const EMAIL_TEMPLATE_PLACEHOLDERS = [
  "greeting",
  "clientName",
  "jobTitle",
  "businessName",
  "jobTitleFor",
  "jobTitleOn",
  "milestone",
  "defaultSubject",
  "siteAddress",
  "documentNumber",
  "amountDue",
  "dueDate",
  "replacesNumber",
  "creditNoteNumber",
  "attachmentList",
  "senderName",
];

// The sign-off each operator's own signature replaces (Settings > Email
// signature). Templates end before it.
export const DEFAULT_EMAIL_SIGNATURE_HTML = "<p>Regards,<br/>{{senderName}}<br/>{{businessName}}</p>";

export const DEFAULT_EMAIL_TEMPLATES = {
  email: [
    {
      id: "standard",
      name: "Standard email",
      description: "General job email.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>I wanted to send through an update{{jobTitleFor}}.</p>",
    },
    {
      id: "follow-up",
      name: "Follow-up",
      description: "Quick follow-up message.",
      subject: "Following up - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Just following up{{jobTitleOn}}.</p><p>Let me know if you have any questions.</p>",
    },
    {
      id: "site-note",
      name: "Site note",
      description: "Site or scheduling note.",
      subject: "Site note - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>I have a quick site note{{jobTitleFor}}:</p><p></p>",
    },
  ],
  quote: [
    {
      id: "standard",
      name: "Standard quote",
      description: "Default quote delivery.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>Your quote{{jobTitleFor}} is ready. The full quote is attached as a PDF.</p><p>Reply to this email if you'd like any adjustments or have questions.</p>",
    },
    {
      id: "approval",
      name: "Ready for approval",
      description: "Asks the client to approve or request changes.",
      subject: "Quote for approval - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>I have attached the quote{{jobTitleFor}} for review.</p><p>If everything looks right, reply with approval and we can line up the next step. If anything needs changing, send through the adjustment and I will update it.</p>",
    },
    {
      id: "warm",
      name: "Warm follow-up",
      description: "More conversational tone.",
      subject: "Your quote - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Thanks again for the details. The quote{{jobTitleFor}} is attached.</p><p>I have kept the main scope and pricing in the PDF so it is easy to review. Let me know what you would like changed or confirmed.</p>",
    },
  ],
  invoice: [
    {
      id: "standard",
      name: "Standard invoice",
      description: "Short invoice delivery note.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>Your {{milestone}}invoice{{jobTitleFor}} is ready. The invoice PDF is attached.</p><p>Reply to this email if you have any questions about this invoice.</p>",
    },
    {
      id: "payment",
      name: "Payment prompt",
      description: "Adds a clear payment request.",
      subject: "Invoice - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Please find your {{milestone}}invoice{{jobTitleFor}} attached.</p><p>When payment is made, reply with the reference and I will mark it off against the job.</p>",
    },
    {
      id: "friendly",
      name: "Friendly check-in",
      description: "Softer wording for known clients.",
      subject: "Invoice - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>I have attached the {{milestone}}invoice{{jobTitleFor}}.</p><p>Let me know if you need anything clarified.</p>",
    },
    {
      id: "replacement",
      name: "Replacement invoice",
      description: "An invoice issued in place of a credited one, with its adjustment note.",
      subject: "Replacement invoice {{documentNumber}} · {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Your {{milestone}}invoice{{jobTitleFor}} has changed. Attached are:</p><ul><li>{{documentNumber}}, the replacement invoice, with {{amountDue}} to pay</li><li>{{creditNoteNumber}}, the adjustment note that cancels {{replacesNumber}}</li></ul><p>Please pay {{documentNumber}} and disregard {{replacesNumber}}. Our bank details are on the invoice.</p>",
    },
  ],
  adjustment_note: [
    {
      id: "standard",
      name: "Adjustment note",
      description: "Sends an adjustment note on its own.",
      subject: "Adjustment note {{creditNoteNumber}} · {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Attached is adjustment note {{creditNoteNumber}}, which cancels invoice {{replacesNumber}}{{jobTitleFor}}.</p><p>Please keep it with your records: it corrects the GST claimed on {{replacesNumber}}.</p>",
    },
    {
      id: "with-replacement",
      name: "Adjustment note and replacement",
      description: "Explains the adjustment note and the invoice that replaces the credited one.",
      subject: "Adjustment note {{creditNoteNumber}} · {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Invoice {{replacesNumber}}{{jobTitleFor}} is cancelled by adjustment note {{creditNoteNumber}}, attached. It is replaced by {{documentNumber}}.</p><p>Reply to this email if you have any questions.</p>",
    },
  ],
  receipt: [
    {
      id: "standard",
      name: "Standard receipt",
      description: "Short receipt delivery note.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>Your {{milestone}}receipt{{jobTitleFor}} is ready. The receipt PDF is attached.</p><p>Reply to this email if you need another copy.</p>",
    },
    {
      id: "thanks",
      name: "Thank you",
      description: "Receipt with a thank-you note.",
      subject: "Payment receipt - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Thanks for the payment. I have attached the {{milestone}}receipt{{jobTitleFor}}.</p>",
    },
    {
      id: "records",
      name: "For records",
      description: "Simple records copy.",
      subject: "Receipt for your records - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Please find the {{milestone}}receipt attached for your records.</p>",
    },
  ],
};

/**
 * A template for the composer: placeholders filled from `values` (strings,
 * from the server). Merge fields become `<span data-merge="key">` in the
 * body; the template helpers (greeting, jobTitleFor, …) are filled as they
 * always were. The subject is plain text.
 */
export function renderComposerTemplate(template, values = {}) {
  const helpers = templateHelpers(values);
  const body = String(template?.html || "").replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key) => {
    if (EMAIL_MERGE_FIELD_KEYS.includes(key)) return mergeSpan(key, values[key]);
    return helpers[key] ?? "";
  });
  return {
    ...template,
    subject: applyMergeFieldsToText(String(template?.subject || "").replace(/\{\{defaultSubject\}\}/g, String(values.defaultSubject || "")), values),
    html: body,
  };
}

/** The signature for the composer: the operator's own, or the default sign-off. */
export function renderSignature(signatureHtml, values = {}) {
  return renderComposerTemplate({ html: signatureHtml || DEFAULT_EMAIL_SIGNATURE_HTML }, values).html;
}

/**
 * Fill every merge field in an email body with the server's values: each
 * `<span data-merge="key">…</span>` gets the value now (the composer's text
 * may be stale: an invoice number is only known when it is issued), and any
 * `{{key}}` left in the text is filled too. Unknown keys are left alone.
 * With `final` (the send and its preview), a field with no value is left
 * empty, so a customer never reads a placeholder.
 */
export function applyMergeFields(html, values = {}, { final = false } = {}) {
  const valueOf = (key) => (values[key] == null ? (final ? "" : null) : values[key]);
  return String(html || "")
    .replace(/<span\b([^>]*?)\bdata-merge\s*=\s*"([a-zA-Z][a-zA-Z0-9]*)"([^>]*)>[\s\S]*?<\/span>/g, (match, before, key, after) => {
      if (!EMAIL_MERGE_FIELD_KEYS.includes(key) || valueOf(key) == null) return match;
      return `<span${before}data-merge="${key}"${after}>${escapeHtml(valueOf(key))}</span>`;
    })
    .replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (match, key) => (EMAIL_MERGE_FIELD_KEYS.includes(key) && valueOf(key) != null ? escapeHtml(valueOf(key)) : match));
}

/** The same for a subject line (plain text). */
export function applyMergeFieldsToText(text, values = {}, { final = false } = {}) {
  return String(text || "").replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (match, key) => {
    if (!EMAIL_MERGE_FIELD_KEYS.includes(key)) return match;
    if (values[key] != null) return String(values[key]);
    return final ? "" : match;
  }).replace(final ? /\s{2,}/g : /$^/, " ").trim();
}

function mergeSpan(key, value) {
  const label = EMAIL_MERGE_FIELDS.find((field) => field.key === key)?.label || key;
  return `<span data-merge="${key}">${escapeHtml(value == null || value === "" ? `[${label}]` : value)}</span>`;
}

function templateHelpers(values) {
  const clientName = String(values.clientName || "").trim();
  const jobTitle = String(values.jobTitle || "").trim();
  const milestoneLabel = String(values.milestoneLabel || "").trim().toLowerCase();
  const escapedJobTitle = escapeHtml(jobTitle);
  return {
    greeting: clientName ? `Hi ${mergeSpan("clientName", clientName)},` : "Hi,",
    jobTitleFor: escapedJobTitle ? ` for <strong>${mergeSpan("jobTitle", jobTitle)}</strong>` : "",
    jobTitleOn: escapedJobTitle ? ` on <strong>${mergeSpan("jobTitle", jobTitle)}</strong>` : "",
    milestone: milestoneLabel ? `${escapeHtml(milestoneLabel)} ` : "",
    defaultSubject: escapeHtml(String(values.defaultSubject || "")),
  };
}

export function renderEmailTemplate(template, context = {}) {
  const clientName = String(context.clientName || "").trim();
  const jobTitle = String(context.jobTitle || "").trim();
  const milestoneLabel = String(context.milestoneLabel || "").trim().toLowerCase();
  // The server supplies it (ui.businessName: trading name, else legal name).
  const businessName = String(context.businessName || "").trim();
  // The subject is plain text, filled from the plain values; the body from
  // the same values escaped, with the job title in bold.
  const text = {
    greeting: clientName ? `Hi ${clientName},` : "Hi,",
    clientName,
    jobTitle: jobTitle || businessName,
    businessName,
    jobTitleFor: jobTitle ? ` for ${jobTitle}` : "",
    jobTitleOn: jobTitle ? ` on ${jobTitle}` : "",
    milestone: milestoneLabel ? `${milestoneLabel} ` : "",
    defaultSubject: String(context.defaultSubject || ""),
  };
  const html = Object.fromEntries(Object.entries(text).map(([key, value]) => [key, escapeHtml(value)]));
  if (jobTitle) {
    html.jobTitleFor = ` for <strong>${escapeHtml(jobTitle)}</strong>`;
    html.jobTitleOn = ` on <strong>${escapeHtml(jobTitle)}</strong>`;
  }
  return {
    ...template,
    subject: replacePlaceholders(template.subject || "", text),
    html: replacePlaceholders(template.html || "", html),
  };
}

function replacePlaceholders(value, values) {
  return String(value || "").replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ""));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
