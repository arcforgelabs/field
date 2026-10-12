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
  },
): StoredEmailTemplate;
