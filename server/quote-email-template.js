import { DEFAULT_BUSINESS_NAME } from "./business-profile.js";
import mjml2html from "mjml";
import { sanitizeEmailBodyHtml } from "./email-html.js";

const COLORS = {
  brand: "#c8912a",
  brandLight: "#f4e6cc",
  brandBorder: "#dfc48a",
  bodyBg: "#f5f5f5",
  white: "#ffffff",
  dark: "#1a1a1a",
  text: "#2d2d2d",
  muted: "#6b6b6b",
  light: "#999999",
  rowAlt: "#faf8f4",
  surfaceCool: "#f5f5f5",
  border: "#e0e0e0",
  borderLight: "#eeeeee",
  footerBg: "#faf8f4",
};

export async function renderQuoteEmailHtml({
  clientName,
  jobTitle,
  quoteNumber,
  quoteDate,
  validDays,
  lineItems = [],
  subtotal,
  gst,
  total,
  documentType = "quote",
  companyName = DEFAULT_BUSINESS_NAME,
  companyAbn = "",
  companyAddress = "Your business address",
  companyPhone = "",
  companyEmail = "quotes@example.com",
  mode = "summary",
  customBody = null,
  milestoneLabel = null,
  dueDate = null,
  contextNote = null,
  themeFontFamily = null,
}) {
  const greeting = clientName ? `Hi ${clientName},` : "Hi,";
  const isReceipt = documentType === "receipt";
  const isInvoice = documentType === "invoice";
  const isPaymentDocument = isInvoice || isReceipt;
  const documentLabel = isReceipt ? "receipt" : isInvoice ? "invoice" : "quote";
  const documentTitle = isReceipt ? "Receipt" : isInvoice ? "Invoice" : "Quote";
  const dateStr = quoteDate || new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const emailFontFamily = normalizeFontFamily(themeFontFamily);
  const summaryTable = "";

  const introText = mode === "summary"
    ? `Your ${documentLabel}${jobTitle ? ` for <strong>${escapeHtml(jobTitle)}</strong>` : ""} is ready.`
    : `Your ${documentLabel} is ready and attached as a PDF.`;

  const quoteRefLine = quoteNumber ? `<span style="font-size:12px;color:${COLORS.muted};font-weight:400;">${escapeHtml(quoteNumber)}</span>` : "";

  const validityNote = !isPaymentDocument && validDays
    ? `<mj-text font-size="13px" color="${COLORS.muted}" padding="0 24px 8px" line-height="1.5">This quote is valid for ${validDays} days from ${dateStr}.</mj-text>`
    : "";
  const milestoneSection = isPaymentDocument && (milestoneLabel || dueDate || contextNote) ? `
    <mj-section background-color="${COLORS.white}" padding="0 24px 8px">
      <mj-column>
        ${milestoneLabel ? `<mj-text font-size="14px" color="${COLORS.text}" padding="0 0 6px" line-height="1.5"><strong>Milestone:</strong> ${escapeHtml(milestoneLabel)}</mj-text>` : ""}
        ${isInvoice && dueDate ? `<mj-text font-size="14px" color="${COLORS.text}" padding="0 0 6px" line-height="1.5"><strong>Due date:</strong> ${escapeHtml(new Date(dueDate).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" }))}</mj-text>` : ""}
        ${contextNote ? `<mj-text font-size="13px" color="${COLORS.muted}" padding="0 0 4px" line-height="1.5">${escapeHtml(contextNote)}</mj-text>` : ""}
      </mj-column>
    </mj-section>
  ` : "";

  const bodySection = customBody
    ? `
    <mj-section background-color="${COLORS.white}" padding="26px 28px 14px">
      <mj-column>
        <mj-table padding="0">
          <tr>
            <td class="editor-body" style="font-family:${escapeHtml(emailFontFamily)};font-size:14px;line-height:1.65;color:${COLORS.text};padding:0 0 16px;">
              ${sanitizeEmailBodyHtml(customBody)}
            </td>
          </tr>
        </mj-table>
      </mj-column>
    </mj-section>`
    : `
    <mj-section background-color="${COLORS.white}" padding="26px 28px 14px">
      <mj-column>
        <mj-text font-size="16px" color="${COLORS.text}" padding="0 0 14px">
          ${greeting}
        </mj-text>
        <mj-text font-size="14px" color="${COLORS.text}" padding="0 0 14px">
          ${introText}
        </mj-text>
      </mj-column>
    </mj-section>`;

  const closingSection = customBody
    ? `
    <mj-section background-color="${COLORS.white}" padding="8px 24px 24px">
      <mj-column>
        ${validityNote}
      </mj-column>
    </mj-section>`
    : `
    <mj-section background-color="${COLORS.white}" padding="8px 28px 26px">
      <mj-column>
        ${validityNote}
        <mj-text font-size="14px" color="${COLORS.text}" padding="0 0 8px" line-height="1.5">
          The full ${documentLabel} is attached as a PDF.
        </mj-text>
        <mj-text font-size="14px" color="${COLORS.text}" padding="0 0 16px" line-height="1.5">
          ${isInvoice
            ? "Reply to this email if you have any questions about this invoice."
            : isReceipt
              ? "Reply to this email if you need another copy of this receipt."
              : "Reply to this email if you'd like any adjustments."}
        </mj-text>
        <mj-text font-size="14px" color="${COLORS.muted}" padding="0">
          Regards,<br/>${escapeHtml(companyName)}
        </mj-text>
      </mj-column>
    </mj-section>`;

  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-attributes>
        <mj-all font-family="${emailFontFamily}" />
      <mj-text line-height="1.6" />
    </mj-attributes>
    <mj-style>
      .quote-table td, .quote-table th { mso-line-height-rule: exactly; }
      .editor-body p { margin: 0 0 12px; }
      .editor-body p:last-child { margin-bottom: 0; }
    </mj-style>
  </mj-head>
  <mj-body background-color="${COLORS.bodyBg}" width="600px">

    <mj-section background-color="${COLORS.brand}" padding="0">
      <mj-column>
        <mj-spacer height="6px" />
      </mj-column>
    </mj-section>

    <mj-section background-color="${COLORS.white}" padding="24px 28px 18px">
      <mj-column>
        <mj-text color="${COLORS.dark}" font-size="20px" font-weight="700" padding="0 0 6px">
          ${escapeHtml(companyName)}
        </mj-text>
        <mj-text color="${COLORS.muted}" font-size="12px" padding="0" line-height="1.5">
          ${companyAbn ? `ABN ${escapeHtml(companyAbn)}<br/>` : ""}${[companyAddress, companyPhone, companyEmail].filter(Boolean).map(escapeHtml).join(" · ")}
        </mj-text>
      </mj-column>
      <mj-column width="190px">
        <mj-text color="${COLORS.dark}" font-size="24px" font-weight="700" align="right" padding="0 0 4px">
          ${documentTitle}
        </mj-text>
        <mj-text color="${COLORS.muted}" font-size="12px" align="right" padding="0" line-height="1.5">
          ${quoteRefLine || escapeHtml(dateStr)}
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="${COLORS.white}" padding="0 28px">
      <mj-column>
        <mj-divider border-width="1px" border-color="${COLORS.border}" padding="0" />
      </mj-column>
    </mj-section>

    ${bodySection}

    ${milestoneSection}

    ${summaryTable}

    ${closingSection}

    <mj-section background-color="${COLORS.footerBg}" padding="16px 24px">
      <mj-column>
        <mj-text font-size="11px" color="${COLORS.muted}" align="center" line-height="1.6">
          ${escapeHtml(companyName)}${companyAbn ? ` · ABN ${escapeHtml(companyAbn)}` : ""}<br/>
          ${[companyAddress, companyPhone, companyEmail].filter(Boolean).map(escapeHtml).join(" · ")}
        </mj-text>
      </mj-column>
    </mj-section>

  </mj-body>
</mjml>`;

  const { html, errors } = await mjml2html(mjmlTemplate);
  if (errors?.length) {
    // Where, not what: the template holds the customer's details, and a
    // warning can quote an attribute value.
    console.warn(`[quote-email-template] ${errors.length} MJML warning(s): ${errors.map((e) => `line ${e.line} ${e.tagName}`).join(", ")}`);
  }
  return html;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeFontFamily(fontFamily) {
  const value = String(fontFamily || "").trim();
  if (!value || /[<>\r\n;]/.test(value)) return "Helvetica, Arial, sans-serif";
  return value;
}
