export const EMAIL_TEMPLATE_DOCUMENT_TYPES = ["email", "quote", "invoice", "receipt"];

export const EMAIL_TEMPLATE_PLACEHOLDERS = [
  "greeting",
  "clientName",
  "jobTitle",
  "jobTitleFor",
  "jobTitleOn",
  "milestone",
  "defaultSubject",
];

export const DEFAULT_EMAIL_TEMPLATES = {
  email: [
    {
      id: "standard",
      name: "Standard email",
      description: "General job email.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>I wanted to send through an update{{jobTitleFor}}.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "follow-up",
      name: "Follow-up",
      description: "Quick follow-up message.",
      subject: "Following up - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Just following up{{jobTitleOn}}.</p><p>Let me know if you have any questions.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "site-note",
      name: "Site note",
      description: "Site or scheduling note.",
      subject: "Site note - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>I have a quick site note{{jobTitleFor}}:</p><p></p><p>Regards,<br/>Your Business</p>",
    },
  ],
  quote: [
    {
      id: "standard",
      name: "Standard quote",
      description: "Default quote delivery.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>Your quote{{jobTitleFor}} is ready. The full quote is attached as a PDF.</p><p>Reply to this email if you'd like any adjustments or have questions.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "approval",
      name: "Ready for approval",
      description: "Asks the client to approve or request changes.",
      subject: "Quote for approval - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>I have attached the quote{{jobTitleFor}} for review.</p><p>If everything looks right, reply with approval and we can line up the next step. If anything needs changing, send through the adjustment and I will update it.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "warm",
      name: "Warm follow-up",
      description: "More conversational tone.",
      subject: "Your quote - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Thanks again for the details. The quote{{jobTitleFor}} is attached.</p><p>I have kept the main scope and pricing in the PDF so it is easy to review. Let me know what you would like changed or confirmed.</p><p>Regards,<br/>Your Business</p>",
    },
  ],
  invoice: [
    {
      id: "standard",
      name: "Standard invoice",
      description: "Short invoice delivery note.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>Your {{milestone}}invoice{{jobTitleFor}} is ready. The invoice PDF is attached.</p><p>Reply to this email if you have any questions about this invoice.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "payment",
      name: "Payment prompt",
      description: "Adds a clear payment request.",
      subject: "Invoice - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Please find your {{milestone}}invoice{{jobTitleFor}} attached.</p><p>When payment is made, reply with the reference and I will mark it off against the job.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "friendly",
      name: "Friendly check-in",
      description: "Softer wording for known clients.",
      subject: "Invoice - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>I have attached the {{milestone}}invoice{{jobTitleFor}}.</p><p>Let me know if you need anything clarified.</p><p>Regards,<br/>Your Business</p>",
    },
  ],
  receipt: [
    {
      id: "standard",
      name: "Standard receipt",
      description: "Short receipt delivery note.",
      subject: "{{defaultSubject}}",
      html: "<p>{{greeting}}</p><p>Your {{milestone}}receipt{{jobTitleFor}} is ready. The receipt PDF is attached.</p><p>Reply to this email if you need another copy.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "thanks",
      name: "Thank you",
      description: "Receipt with a thank-you note.",
      subject: "Payment receipt - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Thanks for the payment. I have attached the {{milestone}}receipt{{jobTitleFor}}.</p><p>Regards,<br/>Your Business</p>",
    },
    {
      id: "records",
      name: "For records",
      description: "Simple records copy.",
      subject: "Receipt for your records - {{jobTitle}}",
      html: "<p>{{greeting}}</p><p>Please find the {{milestone}}receipt attached for your records.</p><p>Regards,<br/>Your Business</p>",
    },
  ],
};

export function renderEmailTemplate(template, context = {}) {
  const clientName = String(context.clientName || "").trim();
  const jobTitle = String(context.jobTitle || "").trim();
  const milestoneLabel = String(context.milestoneLabel || "").trim().toLowerCase();
  const escapedJobTitle = escapeHtml(jobTitle);
  const values = {
    greeting: clientName ? `Hi ${escapeHtml(clientName)},` : "Hi,",
    clientName: escapeHtml(clientName),
    jobTitle: escapeHtml(jobTitle || "Your Business"),
    jobTitleFor: escapedJobTitle ? ` for <strong>${escapedJobTitle}</strong>` : "",
    jobTitleOn: escapedJobTitle ? ` on <strong>${escapedJobTitle}</strong>` : "",
    milestone: milestoneLabel ? `${escapeHtml(milestoneLabel)} ` : "",
    defaultSubject: escapeHtml(String(context.defaultSubject || "")),
  };
  return {
    ...template,
    subject: replacePlaceholders(template.subject || "", values, { stripTags: true }),
    html: replacePlaceholders(template.html || "", values),
  };
}

function replacePlaceholders(value, values, { stripTags = false } = {}) {
  const rendered = String(value || "").replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_match, key) => values[key] ?? "");
  return stripTags ? rendered.replace(/<[^>]*>/g, "") : rendered;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
