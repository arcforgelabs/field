export type StoredEmailTemplate = {
  id: string;
  name: string;
  description: string;
  subject: string;
  html: string;
  updatedAt?: string;
  updatedBy?: { id?: string | null; name?: string | null } | null;
};

export type EmailTemplateInput = Omit<StoredEmailTemplate, "subject"> & { subject?: string };

export const EMAIL_TEMPLATE_DOCUMENT_TYPES: readonly ["email", "quote", "invoice", "receipt"];
export const EMAIL_TEMPLATE_PLACEHOLDERS: readonly string[];
export const DEFAULT_EMAIL_TEMPLATES: Record<string, StoredEmailTemplate[]>;

export function renderEmailTemplate(
  template: EmailTemplateInput,
  context?: {
    clientName?: string;
    jobTitle?: string;
    milestoneLabel?: string;
    defaultSubject?: string;
    businessName?: string;
  },
): StoredEmailTemplate;

export type EmailMergeField = { key: string; label: string };
export const EMAIL_MERGE_FIELDS: readonly EmailMergeField[];
export const EMAIL_MERGE_FIELD_KEYS: readonly string[];
export const DEFAULT_EMAIL_SIGNATURE_HTML: string;
export type EmailMergeValues = Record<string, string | null | undefined>;

export function renderComposerTemplate<T extends { html?: string; subject?: string }>(
  template: T,
  values?: EmailMergeValues,
): T & { subject: string; html: string };
export function renderSignature(signatureHtml: string | null | undefined, values?: EmailMergeValues): string;
export function applyMergeFields(html: string, values?: EmailMergeValues, options?: { final?: boolean }): string;
export function applyMergeFieldsToText(text: string, values?: EmailMergeValues, options?: { final?: boolean }): string;
