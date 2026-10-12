import { filterCatalogItems } from "../../../shared/catalog-search.js";

const getToken = () => localStorage.getItem("fr_token") || "";

// Clerk sign-in (FIELD_AUTH=clerk): requests carry the Clerk session token,
// fetched fresh for each request, instead of a stored Field token. URLs that
// a browser opens directly (PDF links, previews) rely on Clerk's session
// cookie, so no session token is ever put in a URL.
type SessionTokenProvider = () => Promise<string | null>;
let sessionTokenProvider: SessionTokenProvider | null = null;
let sessionKey = "";

export function setSessionTokenProvider(provider: SessionTokenProvider | null, key = "") {
  sessionTokenProvider = provider;
  sessionKey = provider ? key : "";
}

// The Field token to put in a URL the browser opens directly (PDF links, wall
// renders). With Clerk sign-in there is none: the session cookie authorizes
// those reads, and a leftover password-era fr_token must never be sent.
function urlToken(): string {
  if (sessionTokenProvider) return "";
  return getToken();
}

async function authorizationToken(): Promise<string> {
  if (sessionTokenProvider) return (await sessionTokenProvider()) || "";
  return getToken();
}

type PriceCatalogItem = import("./types.ts").PriceCatalogItem;
type PriceCatalogHealthReport = import("./types.ts").PriceCatalogHealthReport;

export type QuoteUpdateResponse = {
  ok: boolean;
  meta: import("./types.ts").RecordingMeta;
  quote: import("./types.ts").Quote;
  quoteMarkdown?: string;
  quoteVersions?: import("./types.ts").QuoteVersion[];
  quoteOverrides?: import("./types.ts").QuoteOverrides | null;
  quoteLifecycle?: import("./types.ts").QuoteLifecycle;
};

export type ScheduledEmail = {
  id: string;
  jobId: string;
  status: "draft" | "pending" | "sending" | "sent" | "failed" | "cancelled";
  lifecycleStatus: "draft" | "scheduled" | "sent" | "failed" | "cancelled";
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt?: string | null;
  cancelledAt?: string | null;
  unscheduledAt?: string | null;
  failedAt?: string | null;
  attemptCount: number;
  lastError?: string | null;
  documentType: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string | null;
  attachmentNames: string[];
  quoteVersion?: number | null;
  milestoneIndex?: number | null;
  invoiceNumber?: string | null;
  previewBodyHtml?: string | null;
  previewThemeFontFamily?: string | null;
  draftContent?: {
    customBody: string;
    themeFontFamily?: string | null;
    attachmentFilename?: string | null;
    invoicePaidAmount?: number | null;
  } | null;
  /** Field documents attached by uid (their references, never their bytes). */
  documents?: EmailDocumentRef[];
};

export type EmailDocumentRef = {
  uid: string;
  documentType: string | null;
  number: string | null;
  byteLength?: number | null;
};

export type JobDocumentStatus = "issued" | "accepted" | "paid" | "credited" | "superseded" | "void";

/** An issued document of a job, from GET /api/jobs/:id/documents. */
export type JobDocument = {
  uid: string;
  documentType: "quote" | "invoice" | "receipt" | "credit_note";
  number: string;
  quoteVersion: number | null;
  revision: number | null;
  issuedAt: string;
  pdfSha256: string;
  pdfUrl: string;
  byteLength: number | null;
  status: JobDocumentStatus;
  emailed: Array<{ event: string; at: string; messageId: string | null; to: string[] }>;
  details?: Record<string, unknown>;
};

/** A document the job will have but that is not issued yet (a draft milestone invoice). */
export type NotIssuedDocument = {
  documentType: "invoice";
  milestoneIndex: number;
  label: string;
  total: number | null;
  reason: string;
};

export type JobDocumentsResponse = {
  ok: true;
  jobId: string;
  documents: JobDocument[];
  notIssued?: NotIssuedDocument[];
};

/** The email limits the server holds (server/documents/email-attachments.js). */
export const EMAIL_ATTACHMENT_LIMITS = {
  maxAttachments: 10,
  maxUploadBytes: 10 * 1024 * 1024,
  maxTotalBytes: 18 * 1024 * 1024,
} as const;

export type GoogleContact = {
  name: string;
  email: string;
};

type EmailSendResponse = {
  ok: boolean;
  scheduled?: boolean;
  scheduledEmail?: ScheduledEmail;
};

type CacheSlot<T> = {
  value?: T;
  promise?: Promise<T>;
  generation?: number;
};

const priceCatalogItemsCache: CacheSlot<PriceCatalogItem[]> = {};
let cacheTokenSnapshot: string | null = null;
// The catalogue ETag the cached catalogue reads were taken under (see
// revalidatePriceCatalogCache).
let priceCatalogCacheEtag: string | null = null;

function cached<T>(slot: CacheSlot<T>, load: () => Promise<T>): Promise<T> {
  ensureCacheToken();
  if (slot.value !== undefined) return Promise.resolve(slot.value);
  if (slot.promise) return slot.promise;
  const generation = (slot.generation || 0) + 1;
  slot.generation = generation;
  const promise = load()
    .then((value) => {
      if (slot.generation === generation) {
        slot.value = value;
        slot.promise = undefined;
      }
      return value;
    })
    .catch((err) => {
      if (slot.generation === generation) slot.promise = undefined;
      throw err;
    });
  slot.promise = promise;
  return promise;
}

function clearCacheSlot<T>(slot: CacheSlot<T>) {
  slot.generation = (slot.generation || 0) + 1;
  slot.value = undefined;
  slot.promise = undefined;
}

function resetReadCaches() {
  clearCacheSlot(priceCatalogItemsCache);
}

function ensureCacheToken() {
  const token = sessionTokenProvider ? `session:${sessionKey}` : getToken();
  if (cacheTokenSnapshot === null) {
    cacheTokenSnapshot = token;
    return;
  }
  if (token === cacheTokenSnapshot) return;
  resetReadCaches();
  cacheTokenSnapshot = token;
}

function invalidatePriceCatalogCache() {
  clearCacheSlot(priceCatalogItemsCache);
}

function getActorName(): string {
  try {
    const raw = localStorage.getItem("fr_user");
    if (raw) {
      const user = JSON.parse(raw);
      return user.name || user.email || "User";
    }
  } catch { /* fallback */ }
  return "User";
}

// The quote rows' version the server last reported for each job
// (X-Field-Quote-Rows-Version on the job detail and on a save). A quote save
// sends it back as If-Match, so a save over changes made elsewhere since the
// quote was opened is refused (412) instead of overwriting them (#10).
const quoteRowsVersions = new Map<string, string>();

function rememberQuoteRowsVersion(path: string, res: Response) {
  const tag = res.headers?.get?.("X-Field-Quote-Rows-Version");
  const match = /^\/api\/jobs\/([^/?]+)(\/[^?]*)?(?:\?|$)/.exec(path);
  if (!match) return;
  const jobId = decodeURIComponent(match[1]);
  if (tag) quoteRowsVersions.set(jobId, tag);
  else if (!match[2] && !/[?&]version=/.test(path)) quoteRowsVersions.delete(jobId);
}

export function quoteRowsVersionFor(jobId: string): string | null {
  return quoteRowsVersions.get(jobId) || null;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await authorizationToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  headers["X-Actor-Name"] = getActorName();
  if (
    options.body &&
    typeof options.body === "string" &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(path, { ...options, headers });
  rememberQuoteRowsVersion(path, res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // Gmail auth expired returns 401 with a specific code — don't treat as session expiry
    if (res.status === 401 && body.code !== "gmail_auth_expired") {
      localStorage.removeItem("fr_token");
      window.location.hash = "#/";
      throw new Error("unauthorized");
    }
    const err = new Error(body.error || res.statusText);
    const errWithCode = err as Error & { code?: unknown; conflict?: unknown; status?: number; reasons?: string[] };
    errWithCode.code = body.code;
    errWithCode.conflict = body.conflict;
    errWithCode.status = res.status;
    if (Array.isArray(body.reasons)) errWithCode.reasons = body.reasons;
    throw err;
  }
  return res.json();
}

async function requestForm<T>(path: string, options: RequestInit & { body: FormData }): Promise<T> {
  const token = await authorizationToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Actor-Name": getActorName(),
      "X-Uploaded-By": getActorName(),
      ...(options.headers as Record<string, string>),
    },
    body: options.body,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 401 && body.code !== "gmail_auth_expired") {
      localStorage.removeItem("fr_token");
      window.location.hash = "#/";
      throw new Error("unauthorized");
    }
    const err = new Error(body.error || res.statusText);
    const errWithCode = err as Error & { code?: unknown; status?: number };
    errWithCode.code = body.code;
    errWithCode.status = res.status;
    throw err;
  }

  return res.json();
}

export type AuthConfig =
  | { ok: boolean; mode: "password" }
  | { ok: boolean; mode: "clerk"; clerk: { publishableKey: string; proxyUrl: string | null } };

export const api = {
  // Public: tells the client how people sign in. An older server without the
  // endpoint means password sign-in.
  async authConfig(): Promise<AuthConfig> {
    try {
      const res = await fetch("/api/auth/config", { headers: { Accept: "application/json" } });
      if (!res.ok) return { ok: false, mode: "password" };
      const body = await res.json();
      if (body?.mode === "clerk" && typeof body.clerk?.publishableKey === "string" && body.clerk.publishableKey) {
        return { ok: true, mode: "clerk", clerk: { publishableKey: body.clerk.publishableKey, proxyUrl: body.clerk.proxyUrl ?? null } };
      }
      return { ok: true, mode: "password" };
    } catch {
      return { ok: false, mode: "password" };
    }
  },
  me() {
    return request<{ ok: boolean; user: import("./types.ts").UserProfile }>("/api/auth/me");
  },
  listFieldUsers() {
    return request<{ ok: boolean; users: import("./types.ts").FieldUser[] }>("/api/users");
  },
  approveFieldUser(id: string, role: import("./types.ts").FieldUserRole) {
    return request<{ ok: boolean; user: import("./types.ts").FieldUser }>(
      `/api/users/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify({ role }) }
    );
  },
  updateFieldUser(id: string, patch: { role?: import("./types.ts").FieldUserRole; status?: import("./types.ts").FieldUserStatus }) {
    return request<{ ok: boolean; user: import("./types.ts").FieldUser }>(
      `/api/users/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) }
    );
  },
  login(email: string, password: string) {
    return request<{ ok: boolean; token: string; user: import("./types.ts").UserProfile }>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    );
  },
  logout() {
    return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
  },
  uiConfig() {
    return request<{ ok: boolean; ui: import("./types.ts").UiConfig }>(
      "/api/ui-config"
    );
  },
  recordings() {
    return request<import("./types.ts").RecordingMeta[]>("/api/jobs");
  },
  recording(id: string, version?: string) {
    const qs = version ? `?version=${version}` : "";
    return request<import("./types.ts").RecordingDetail>(
      `/api/jobs/${id}${qs}`
    );
  },
  createVersion(id: string) {
    return request<{ ok: boolean; previousVersion: number; currentVersion: number }>(
      `/api/jobs/${id}/versions`,
      { method: "POST" }
    );
  },
  deleteVersion(id: string, version: number) {
    return request<{ ok: boolean }>(
      `/api/jobs/${id}/versions/${version}`,
      { method: "DELETE" }
    );
  },
  promoteVersion(id: string, version: number) {
    return request<{ ok: boolean; currentVersion: number; previousVersion: number }>(
      `/api/jobs/${id}/versions/${version}/promote`,
      { method: "POST" }
    );
  },
  updateDetail(id: string, key: string, value: unknown) {
    return request<{ ok: boolean; detail: import("./types.ts").RecordingDetail }>(
      `/api/jobs/${id}/details`,
      { method: "PATCH", body: JSON.stringify({ key, value }) }
    );
  },
  addNote(id: string, text: string, userName?: string, anchor?: { surface: string; layer?: string; itemCode?: string; itemLabel?: string; itemSnapshot?: Record<string, unknown>; version?: string | number }, title?: string) {
    return request<{ ok: boolean; detail: import("./types.ts").RecordingDetail }>(
      `/api/jobs/${id}/notes`,
      { method: "POST", body: JSON.stringify({ text, userName, anchor, title: title || null }) }
    );
  },
  getNotes(id: string) {
    return request<{ notes: Array<{ id: string; text: string; title: string | null; author: string; surface: string; layer: string; itemCode: string; itemLabel: string; itemSnapshot: Record<string, unknown> | null; createdAt: string; version?: string | null }> }>(
      `/api/jobs/${id}/notes`
    );
  },
  gapAction(
    id: string,
    gapId: string,
    body: {
      mode: string;
      reason?: string;
      reasonCode?: string;
      status?: string;
      note?: string;
    }
  ) {
    return request<{
      ok: boolean;
      detail?: import("./types.ts").RecordingDetail;
    }>(
      `/api/jobs/${id}/gaps/${gapId}/actions`,
      { method: "POST", body: JSON.stringify(body) }
    );
  },
  reviewItemAction(
    id: string,
    itemId: string,
    body: {
      mode: import("./types.ts").ReviewActionMode;
      reason?: string;
      note?: string;
      value?: string;
    }
  ) {
    return request<{
      ok: boolean;
      detail?: import("./types.ts").RecordingDetail;
    }>(
      `/api/jobs/${id}/review/items/${encodeURIComponent(itemId)}/actions`,
      { method: "POST", body: JSON.stringify(body) }
    );
  },
  archive(id: string, reason?: string) {
    return request<{ ok: boolean; detail: import("./types.ts").RecordingDetail }>(
      `/api/jobs/${id}/archive`,
      { method: "POST", body: JSON.stringify({ reason }) }
    );
  },
  bulkArchive(ids: string[], reason?: string) {
    return request<{ ok: boolean; results: Array<{ id: string; ok: boolean }> }>(
      "/api/jobs/bulk-archive",
      { method: "POST", body: JSON.stringify({ ids, reason }) }
    );
  },
  createManual(quoteCatalogId?: string, gps?: { lat: number; lng: number }, siteAddress?: string, quotedBy?: string) {
    return request<{ ok: boolean; id: string; meta: import("./types.ts").RecordingMeta }>(
      "/api/jobs/manual",
      { method: "POST", body: JSON.stringify({ quoteCatalogId, gps, siteAddress, quotedBy }) }
    );
  },
  /** Refused with 409 and `reasons` on the error unless the job is untouched. */
  deleteRecording(id: string) {
    return request<{ ok: boolean }>(`/api/jobs/${id}`, {
      method: "DELETE",
    });
  },
  /** Deletes the untouched jobs; the rest are kept and returned with their reasons. */
  bulkDeleteJobs(ids: string[]) {
    return request<{ results: Array<{ id: string; ok: boolean; error?: string; reasons?: string[] }> }>(
      "/api/jobs/bulk-delete",
      { method: "POST", body: JSON.stringify({ ids }) }
    );
  },
  quoteUpdate(
    id: string,
    patch: {
      lineItems?: unknown;
      commercialAdjustments?: unknown;
      assumptions?: unknown;
      presentation?: unknown;
      execution?: unknown;
      paymentSchedule?: import("./types.ts").PaymentSchedule | null;
      lockStatus?: string;
    }
  ) {
    const ifMatch = quoteRowsVersionFor(id);
    return request<QuoteUpdateResponse>(
      `/api/jobs/${id}/quote-update`,
      { method: "POST", body: JSON.stringify(patch), ...(ifMatch ? { headers: { "If-Match": ifMatch } } : {}) }
    );
  },
  regenerateQuote(id: string) {
    return request<{
      ok: boolean;
      meta?: import("./types.ts").RecordingMeta;
      quote: import("./types.ts").Quote;
      quoteMarkdown?: string;
      quoteVersions?: import("./types.ts").QuoteVersion[];
      quoteOverrides?: import("./types.ts").QuoteOverrides | null;
      quoteLifecycle?: import("./types.ts").QuoteLifecycle | null;
    }>(
      `/api/jobs/${id}/quote-regenerate`,
      { method: "POST", body: JSON.stringify({}) }
    );
  },
  updatePipelineStage(id: string, pipelineStage: import("./types.ts").PipelineStage) {
    return request<{ ok: boolean; detail: import("./types.ts").RecordingDetail }>(
      `/api/jobs/${id}/pipeline-stage`,
      { method: "POST", body: JSON.stringify({ pipelineStage }) }
    );
  },
  emailQuote(
    id: string,
    to: string | string[],
    customBody?: string | null,
    options?: {
      subject?: string | null;
      cc?: string[];
      bcc?: string[];
      documentType?: import("./types.ts").JobDocumentType;
      invoicePaidAmount?: number | null;
      milestoneIndex?: number | null;
      version?: string | null;
      themeFontFamily?: string | null;
      attachmentFilename?: string | null;
      attachments?: File[];
      scheduledAt?: string | null;
      draftId?: string | null;
      /** Also attach the adjustment note the invoice was issued with (#28). */
      attachCreditNote?: boolean;
      /** Other issued documents of the job, attached by uid. */
      documents?: Array<{ uid: string }>;
    }
  ) {
    const documents = options?.documents?.length ? { documents: options.documents.map(({ uid }) => ({ uid })) } : {};
    if (options?.attachments?.length) {
      const payload = {
        to,
        subject: options?.subject || null,
        cc: options?.cc || [],
        bcc: options?.bcc || [],
        customBody: customBody || null,
        ...(options?.documentType ? { documentType: options.documentType } : {}),
        ...(options?.invoicePaidAmount != null ? { invoicePaidAmount: options.invoicePaidAmount } : {}),
        ...(options?.milestoneIndex != null ? { milestoneIndex: options.milestoneIndex } : {}),
        ...(options?.version ? { version: options.version } : {}),
        ...(options?.themeFontFamily ? { themeFontFamily: options.themeFontFamily } : {}),
        ...(options?.attachmentFilename ? { attachmentFilename: options.attachmentFilename } : {}),
        ...(options?.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
        ...(options?.draftId ? { draftId: options.draftId } : {}),
        ...(options?.attachCreditNote ? { attachCreditNote: true } : {}),
        ...documents,
      };
      const formData = new FormData();
      formData.append("payload", JSON.stringify(payload));
      options.attachments.forEach((file) => {
        formData.append("attachments", file, file.name || "attachment");
      });
      return requestForm<EmailSendResponse>(`/api/jobs/${id}/email-quote`, {
        method: "POST",
        body: formData,
      });
    }
    return request<EmailSendResponse>(`/api/jobs/${id}/email-quote`, {
      method: "POST",
      body: JSON.stringify({
        to,
        subject: options?.subject || null,
        cc: options?.cc || [],
        bcc: options?.bcc || [],
        customBody: customBody || null,
        ...(options?.documentType ? { documentType: options.documentType } : {}),
        ...(options?.invoicePaidAmount != null ? { invoicePaidAmount: options.invoicePaidAmount } : {}),
        ...(options?.milestoneIndex != null ? { milestoneIndex: options.milestoneIndex } : {}),
        ...(options?.version ? { version: options.version } : {}),
        ...(options?.themeFontFamily ? { themeFontFamily: options.themeFontFamily } : {}),
        ...(options?.attachmentFilename ? { attachmentFilename: options.attachmentFilename } : {}),
        ...(options?.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
        ...(options?.draftId ? { draftId: options.draftId } : {}),
        ...(options?.attachCreditNote ? { attachCreditNote: true } : {}),
        ...documents,
      }),
    });
  },
  /** The job's issued documents (503 without a database: no picker then). */
  jobDocuments(id: string) {
    return request<JobDocumentsResponse>(`/api/jobs/${id}/documents`);
  },
  emailTemplates() {
    return request<{
      ok: true;
      documentTypes: string[];
      allowedPlaceholders: string[];
      templates: Record<string, Array<{
        id: string;
        name: string;
        description: string;
        subject: string;
        html: string;
      }>>;
    }>("/api/email-templates");
  },
  emailJob(
    id: string,
    to: string | string[],
    subject: string,
    customBody?: string | null,
    options?: {
      cc?: string[];
      bcc?: string[];
      themeFontFamily?: string | null;
      attachments?: File[];
      scheduledAt?: string | null;
      draftId?: string | null;
      documents?: Array<{ uid: string }>;
    },
  ) {
    const payload = {
      ...(options?.documents?.length ? { documents: options.documents.map(({ uid }) => ({ uid })) } : {}),
      to,
      subject,
      cc: options?.cc || [],
      bcc: options?.bcc || [],
      customBody: customBody || null,
      ...(options?.themeFontFamily ? { themeFontFamily: options.themeFontFamily } : {}),
      ...(options?.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
      ...(options?.draftId ? { draftId: options.draftId } : {}),
    };
    const files = options?.attachments || [];
    if (files.length) {
      const formData = new FormData();
      formData.append("payload", JSON.stringify(payload));
      files.forEach((file) => formData.append("attachments", file, file.name || "attachment"));
      return requestForm<EmailSendResponse>(`/api/jobs/${id}/email`, {
        method: "POST",
        body: formData,
      });
    }
    return request<EmailSendResponse>(`/api/jobs/${id}/email`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  scheduledEmails(id: string) {
    return request<{ ok: true; scheduledEmails: ScheduledEmail[] }>(`/api/jobs/${id}/scheduled-emails`);
  },
  unscheduleEmail(id: string, scheduledEmailId: string) {
    return request<{ ok: true; scheduledEmail: ScheduledEmail }>(
      `/api/jobs/${id}/scheduled-emails/${scheduledEmailId}`,
      { method: "DELETE" },
    );
  },
  generateMilestones(
    id: string,
    paymentSchedule: import("./types.ts").PaymentSchedule,
  ) {
    return request<{
      ok: boolean;
      paymentSchedule: import("./types.ts").PaymentSchedule | null;
      milestones: import("./types.ts").MilestoneInvoice[];
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/generate`, {
      method: "POST",
      body: JSON.stringify({ paymentSchedule }),
    });
  },
  updateMilestone(
    id: string,
    milestoneIndex: number,
    patch: {
      status?: import("./types.ts").MilestoneInvoiceStatus;
      dueDate?: string | null;
    },
  ) {
    return request<{
      ok: boolean;
      milestone: import("./types.ts").MilestoneInvoice;
      milestones: import("./types.ts").MilestoneInvoice[];
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/${milestoneIndex}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
  listInvoiceRevisions(id: string, milestoneIndex: number) {
    return request<{
      ok: boolean;
      milestoneIndex: number;
      invoiceNumber: string;
      revisionNumber: number;
      revisions: import("./types.ts").InvoiceRevision[];
    }>(`/api/jobs/${id}/milestones/${milestoneIndex}/revisions`);
  },
  // Step 4b (#28): an issued invoice is credited in full with a credit
  // (adjustment) note and a new invoice is issued in its place.
  creditAndReissueInvoice(
    id: string,
    milestoneIndex: number,
    body: {
      reason: string;
      quoteVersion?: number | string | null;
      expectedRevisionNumber?: number | null;
    },
  ) {
    return request<{
      ok: boolean;
      creditNote: import("./types.ts").CreditNote | null;
      invoice: {
        invoiceNumber: string;
        revisionNumber: number;
        supersedesInvoiceNumber: string | null;
        total: number;
        supersededTotal: number | null;
        totalDelta: number;
        revisionReason: string | null;
      };
      paymentSchedule: import("./types.ts").PaymentSchedule | null;
      milestones: import("./types.ts").MilestoneInvoice[];
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/${milestoneIndex}/credit-and-reissue`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  recordMilestonePayment(
    id: string,
    milestoneIndex: number,
    payment: {
      amount: number;
      date?: string | null;
      reference?: string | null;
      method?: string | null;
    },
  ) {
    return request<{
      ok: boolean;
      payment: import("./types.ts").MilestonePayment;
      milestone: import("./types.ts").MilestoneInvoice;
      milestones: import("./types.ts").MilestoneInvoice[];
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/${milestoneIndex}/payment`, {
      method: "POST",
      body: JSON.stringify(payment),
    });
  },
  voidMilestonePayment(
    id: string,
    milestoneIndex: number,
    paymentId: string,
    reason?: string | null,
  ) {
    return request<{
      ok: boolean;
      payment: import("./types.ts").MilestonePayment;
      milestone: import("./types.ts").MilestoneInvoice;
      milestones: import("./types.ts").MilestoneInvoice[];
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/${milestoneIndex}/payments/${encodeURIComponent(paymentId)}/void`, {
      method: "POST",
      body: JSON.stringify({ reason: reason || null }),
    });
  },
  migrateMilestoneInvoices(
    id: string,
    payload: {
      sourceQuoteVersion?: number | null;
      targetQuoteVersion?: number | null;
      carriedForwardAmount: number;
      carryMilestoneIndex?: number;
      adjustmentMilestoneIndex?: number;
      voidPayments?: Array<{ milestoneIndex: number; paymentId: string; reason?: string | null }>;
      resetChangedUnpaidInvoices?: boolean;
      dryRun?: boolean;
    },
  ) {
    return request<{
      ok: boolean;
      paymentSchedule: import("./types.ts").PaymentSchedule | null;
      milestones: import("./types.ts").MilestoneInvoice[];
      migrationPlan: {
        migrationId: string;
        sourceQuoteVersion: number | null;
        targetQuoteVersion: number | null;
        carriedForwardAmount: number;
        voidedPaymentCount: number;
        milestones: Array<{
          milestoneIndex: number;
          milestoneLabel: string;
          invoiceNumber: string;
          percentage: number;
          fixedTotal: number | null;
          total: number;
          amountPaid: number;
          amountDue: number;
          status: import("./types.ts").MilestoneInvoiceStatus;
          issuedAt: string | null;
        }>;
      } | null;
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/migrate`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },
  markMilestoneUnpaid(
    id: string,
    milestoneIndex: number,
  ) {
    return request<{
      ok: boolean;
      milestone: import("./types.ts").MilestoneInvoice;
      milestones: import("./types.ts").MilestoneInvoice[];
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/${milestoneIndex}/unpaid`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  markMilestoneUnsent(
    id: string,
    milestoneIndex: number,
  ) {
    return request<{
      ok: boolean;
      milestone: import("./types.ts").MilestoneInvoice;
      milestones: import("./types.ts").MilestoneInvoice[];
      detail: import("./types.ts").RecordingDetail;
    }>(`/api/jobs/${id}/milestones/${milestoneIndex}/unsent`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  gmailAuthUrl(returnTo: string) {
    return request<{ url: string }>(`/api/auth/gmail?returnTo=${encodeURIComponent(returnTo)}`);
  },
  googleContacts() {
    return request<{ ok: boolean; contacts: GoogleContact[] }>("/api/google/contacts");
  },
  sentEmails(id: string) {
    return request<{ ok: boolean; sentEmails: unknown[] }>(`/api/jobs/${id}/sent-emails`);
  },
  markLanded(id: string) {
    return request<{ ok: boolean; detail: import("./types.ts").RecordingDetail }>(`/api/jobs/${id}/landed`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  moasureUpload(id: string, formData: FormData) {
    return requestForm<{
      ok: boolean;
      meta: import("./types.ts").RecordingMeta;
      moasure: import("./types.ts").MoasureSummary;
      quote?: import("./types.ts").Quote | null;
      quoteVersions?: import("./types.ts").QuoteVersion[] | null;
    }>(`/api/jobs/${id}/moasure-upload`, {
      method: "POST",
      body: formData,
    });
  },
  moasureDeleteFile(id: string, batchId: string, fileName: string) {
    return request<{
      ok: boolean;
      removed: { batchId: string; fileName: string };
      meta: import("./types.ts").RecordingMeta;
      moasure: import("./types.ts").MoasureSummary;
      quote?: import("./types.ts").Quote | null;
      quoteVersions?: import("./types.ts").QuoteVersion[] | null;
    }>(
      `/api/jobs/${id}/moasure-files/${encodeURIComponent(batchId)}/${encodeURIComponent(fileName)}`,
      { method: "DELETE" }
    );
  },
  priceCatalogItems(filters?: {
    status?: string;
    category?: string;
    search?: string;
  }) {
    return cached(priceCatalogItemsCache, () => request<PriceCatalogItem[]>("/api/price-catalog/items"))
      .then((items) => filterCatalogItems(items, filters));
  },
  /**
   * The row a quote adds for a catalogue item, priced now. Never served from
   * the browser cache: quote prices come from the server at the moment a row
   * is added, re-linked or reset.
   */
  priceCatalogQuoteLine(codeOrUid: string) {
    return request<import("./types.ts").QuoteCatalogLine>(
      `/api/price-catalog/items/${encodeURIComponent(codeOrUid)}/quote-line`,
      { cache: "no-store" },
    );
  },
  /** The catalogue's version; drops the cached catalogue when it moved. */
  async revalidatePriceCatalogCache() {
    const version = await request<{ version: number; etag: string }>("/api/price-catalog/version", { cache: "no-store" });
    if (priceCatalogCacheEtag !== version.etag) invalidatePriceCatalogCache();
    priceCatalogCacheEtag = version.etag;
    return version;
  },
  /** Rows of the quote whose catalogue item changed (the editor's draft, or the saved quote). */
  quoteCatalogChanges(id: string, organizer?: import("./types.ts").QuotePresentationOrganizer | null) {
    return request<import("./types.ts").QuoteCatalogChanges>(
      `/api/jobs/${id}/quote/catalog-changes`,
      { method: "POST", body: JSON.stringify(organizer ? { organizer } : {}), cache: "no-store" },
    );
  },
  applyQuoteCatalogChanges(id: string, body: {
    organizer: import("./types.ts").QuotePresentationOrganizer;
    nodeIds?: string[] | null;
    /** Row id → the reviewKey the operator's check listed it with. */
    reviewed?: Record<string, string> | null;
    expectedCatalogVersion?: number | null;
  }) {
    return request<import("./types.ts").QuoteCatalogApplyResult>(
      `/api/jobs/${id}/quote/catalog-changes/apply`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
  priceCatalogHealth() {
    return request<PriceCatalogHealthReport>("/api/price-catalog/health");
  },
  getTerms() {
    return request<{ ok: boolean; terms: Array<{ id: string; title: string; body: string }> }>("/api/terms");
  },
  invoicingSettings() {
    return request<import("./types.ts").InvoicingSettings>("/api/settings/invoicing");
  },
  updateInvoicingSettings(settings: { creditNoteOnReissue: import("./types.ts").CreditNoteOnReissue }) {
    return request<import("./types.ts").InvoicingSettings>("/api/settings/invoicing", {
      method: "PUT",
      body: JSON.stringify(settings),
    });
  },
  updateTerms(terms: Array<{ id: string; title: string; body: string }>) {
    return request<{ ok: boolean }>("/api/terms", {
      method: "PUT",
      body: JSON.stringify({ terms }),
    });
  },
  quotePdfUrl(
    id: string,
    version?: string,
    milestoneIndex?: number | null,
    documentType?: import("./types.ts").JobDocumentType | null,
  ) {
    const params = new URLSearchParams();
    const token = urlToken();
    if (token) params.set("token", token);
    if (version) params.set("version", version);
    if (milestoneIndex != null) params.set("milestoneIndex", String(milestoneIndex));
    if (documentType) params.set("documentType", documentType);
    return `/api/jobs/${id}/quote-pdf?${params.toString()}`;
  },
  /** A document PDF from its quotePdfUrl, or the server's reason it can't be made. */
  async documentPdf(url: string): Promise<Blob> {
    const token = await authorizationToken();
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: null }));
      throw new Error(body?.error || "The PDF couldn't be made. Try again.");
    }
    return res.blob();
  },
  async quotePdfPreview(
    id: string,
    organizer: unknown,
    validityDays?: number,
    scopeText?: string,
    signal?: AbortSignal,
    options?: {
      documentType?: import("./types.ts").JobDocumentType;
      invoicePaidAmount?: number | null;
      milestoneIndex?: number | null;
      paymentSchedule?: import("./types.ts").PaymentSchedule | null;
      version?: string | null;
    },
  ): Promise<{ ok: boolean; previewId: string; fileName: string; url: string }> {
    const token = await authorizationToken();
    const res = await fetch(`/api/jobs/${id}/quote-pdf-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Actor-Name": getActorName(),
      },
      body: JSON.stringify({
        organizer,
        ...(validityDays ? { validityDays } : {}),
        ...(scopeText ? { scopeText } : {}),
        ...(options?.documentType ? { documentType: options.documentType } : {}),
        ...(options?.invoicePaidAmount != null ? { invoicePaidAmount: options.invoicePaidAmount } : {}),
        ...(options?.milestoneIndex != null ? { milestoneIndex: options.milestoneIndex } : {}),
        ...(options?.paymentSchedule ? { paymentSchedule: options.paymentSchedule } : {}),
        ...(options?.version ? { version: options.version } : {}),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`PDF preview failed: ${res.status}`);
    return res.json();
  },
  wallRenderUrl(id: string, zoneId: string, version?: string | null, theme?: string | null) {
    const params = new URLSearchParams();
    const token = urlToken();
    if (token) params.set("token", token);
    params.set("format", "html");
    if (version) params.set("version", version);
    if (theme) params.set("theme", theme);
    return `/api/jobs/${id}/wall-zones/${encodeURIComponent(zoneId)}/render?${params.toString()}`;
  },
  wallZones(id: string) {
    return request<{ data: Record<string, unknown> | null }>(`/api/jobs/${id}/wall-zones`);
  },
};

// The price book (features/pricing/price-book-api.ts) calls the catalogue
// through the same authorised request helpers, and drops the cached
// catalogue items after its writes so quote screens never read stale prices.
export { request as apiRequest, requestForm as apiRequestForm, invalidatePriceCatalogCache };
