export interface RecordingMeta {
  id: string;
  createdAt: string;
  title?: string;
  label?: string;
  slug?: string;
  audioFile?: string | null;
  audioFiles?: string[];
  mimeType?: string | null;
  sizeBytes?: number;
  durationMs?: number | null;
  outputMode: "quote" | "report";
  quoteCatalogId: string;
  status: "processing" | "complete" | "error";
  captureMode?: "manual" | "recorded" | "recording";
  speakerCount?: number;
  taskCount?: number | null;
  qaDropped?: number;
  siteAddress?: string | null;
  customerName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  quoteNumber?: string | null;
  jobNumber?: string | null;
  quotedBy?: string | null;
  archivedAt?: string | null;
  archivedReason?: string | null;
  /** Only an untouched draft can be deleted; anything else is archived. Set on the job list. */
  deletable?: boolean;
  captureCount?: number;
  gps?: { lat: number; lng: number } | null;
  quoteSubtotal?: number | null;
  quoteTotal?: number | null;
  quoteVersion?: number | null;
  quoteSentAt?: string | null;
  invoiceSentAt?: string | null;
  /** Paid amount on the next-open milestone (contextual). Use totalInvoicePaidAmount for job-level totals. */
  invoicePaidAmount?: number | null;
  /** Running sum of amountPaid across every milestone invoice. */
  totalInvoicePaidAmount?: number | null;
  paymentSchedule?: PaymentSchedule | null;
  milestoneInvoices?: MilestoneInvoice[];
  milestoneInvoice?: MilestoneInvoice | null;
  landedAt?: string | null;
  lostAt?: string | null;
  moasureStatus?: string;
  moasureBatchCount?: number;
  moasureLatestBatchId?: string | null;
  error?: string;
  driveFileIds?: Record<string, string>;
  pipelineStage?: PipelineStage;
  /** @deprecated Use pipelineStage. Kept for backward compat during migration. */
  deliveryStatus?: PipelineStage;
  quoteBuild?: QuoteBuildState | null;
}

/** Canonical pipeline lifecycle for a quote: draft → sent → landed / lost */
export type PipelineStage = "draft" | "sent" | "landed" | "lost";
export type JobDocumentType = "quote" | "invoice" | "receipt";
export type MilestoneInvoiceStatus = "draft" | "authorised" | "paid";

export interface QuoteBuildState {
  version: number;
  status: "idle" | "running" | "failed";
  buildType?: string | null;
  buildReason?: string | null;
  requestedBy?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  stageKey?: string | null;
  stageLabel?: string | null;
  stageIndex?: number | null;
  stageCount?: number | null;
  warnings?: string[] | null;
  error?: string | null;
  failedAt?: string | null;
  lastCompletedAt?: string | null;
  lastCompletedQuoteVersion?: number | null;
  lastCompletedQuoteGeneratedAt?: string | null;
}

export interface PaymentScheduleMilestone {
  label: string;
  percentage: number;
  fixedTotal?: number | null;
  dueDays?: number | null;
}

export interface PaymentSchedule {
  milestones: PaymentScheduleMilestone[];
}

export interface MilestonePayment {
  id: string;
  date: string;
  amount: number;
  reference?: string | null;
  method?: string | null;
  recordedAt: string;
  sourceQuoteVersion?: number | null;
  sourceInvoiceNumber?: string | null;
  migrationId?: string | null;
  note?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  voidedBy?: string | null;
}

export interface MilestoneLineItem {
  description: string;
  quantity: number;
  unit?: string | null;
  unitPrice: number;
  totalPrice: number;
  accountCode?: string | null;
  sourceCode?: string | null;
}

export interface InvoiceRevision {
  revisionNumber: number;
  invoiceNumber: string;
  quoteVersion: number | null;
  issuedAt: string | null;
  subtotal: number;
  gst: number;
  total: number;
  currency: string;
  lineItems: MilestoneLineItem[];
  pdfPath: string | null;
  pdfIssuedAt: string | null;
  pdfSha256: string | null;
  revisedAt: string | null;
  revisedBy: string | null;
  revisionReason: string | null;
  supersedesInvoiceNumber: string | null;
  supersedesRevisionNumber: number | null;
  supersededTotal: number | null;
  supersededQuoteVersion: number | null;
  supersededAt: string | null;
  supersededByRevisionNumber: number | null;
  /** The credit note that credited this revision when it was replaced (step 4b). */
  creditNote?: CreditNote | null;
  /** On a replacement: the credit note that made way for it. */
  creditNoteNumber?: string | null;
  current?: boolean;
}

/** What Field creates in Xero for an issued invoice (#93). */
export type XeroCreateMode = "off" | "draft" | "authorised";
export type XeroConnectionStatus = "disconnected" | "choose_organisation" | "connected" | "needs_reconnect";

/** Settings, Integrations, Xero (owner only). Never a token or a secret: only whether each secret is set. */
export interface XeroIntegration {
  ok: boolean;
  redirectUri: string | null;
  publicUrlConfigured: boolean;
  secrets: { clientIdSet: boolean; clientSecretSet: boolean };
  scopes: string[];
  connection: {
    status: XeroConnectionStatus;
    tenantName: string | null;
    connectedAt: string | null;
    connectedBy: string | null;
    reconnectReason: string | null;
    reconnectMessage: string | null;
    organisations: Array<{ tenantId: string; tenantName: string }>;
  };
  settings: XeroSettings;
  choices: { createMode: Array<{ value: XeroCreateMode; label: string; description: string }> };
}

/** One invoice's way to Xero, on the job's Invoices tab. */
export interface XeroInvoiceState {
  invoiceUid: string;
  state: "not-sent" | "pending" | "created" | "mismatch" | "failed" | "skipped";
  label: string;
  xeroStatus: string | null;
  /** Why it failed, waits or differs, in plain words. */
  reason: string | null;
  nextAttemptAt: string | null;
  canRetry: boolean;
  canSend: boolean;
}

export interface JobXeroStatus {
  ok: boolean;
  connected: boolean;
  connection: XeroConnectionStatus;
  createMode: XeroCreateMode;
  /** By invoice number. */
  invoices: Record<string, XeroInvoiceState>;
}

/** What sending invoices issued before the connection would create. */
export interface XeroPushPreview {
  ok: boolean;
  wroteNothing: true;
  connected: boolean;
  mode: "draft" | "authorised";
  invoices: Array<{
    invoiceUid: string;
    jobId: string;
    number: string;
    reference: string | null;
    customer: string | null;
    issuedAt: string | null;
    total: string;
    status: string;
    creates: string;
    previously: string | null;
    problem: string | null;
  }>;
}

export interface XeroSettings {
  createMode: XeroCreateMode;
  salesAccountCode: string;
  taxType: string;
  invoiceNumbering: "field";
  autoFrom: string | null;
}

/** Whether an invoice returned to draft and reissued with different content is credited first (#28). */
export type CreditNoteOnReissue = "when-emailed" | "always" | "never";

export interface InvoicingSettings {
  ok: boolean;
  creditNoteOnReissue: CreditNoteOnReissue;
  updatedAt: string | null;
  updatedBy: string | null;
  choices: Array<{ value: CreditNoteOnReissue; label: string; description: string }>;
}

/**
 * Legacy invoices whose milestone record and PDFs disagree (#60), from
 * GET /api/admin/invoices/amount-disagreements (server/invoices/amount-evidence.js).
 * Amounts are decimal strings with two places ("3960.00").
 */
export type InvoiceAmountSource = "milestone-record" | "stored-pdf" | "sent-copy";

export type InvoiceAmountState =
  | "needs-owner-decision"
  | "recorded-matches-sent"
  | "sent-differs-from-recorded"
  | "sent-copies-differ"
  | "settled";

export interface InvoiceAmountSet {
  subtotal: string;
  taxTotal: string;
  total: string;
}

export interface InvoiceAmountOption extends InvoiceAmountSet {
  choose: InvoiceAmountSource;
}

export interface InvoiceAmountEntry {
  jobId: string;
  invoiceNumber: string;
  milestone: number;
  revision: number;
  /** The milestone's status, or "superseded" for an earlier revision. */
  status: string;
  state: InvoiceAmountState;
  issuedAt: string | null;
  recorded: InvoiceAmountSet & { quoteVersion: number | null; quoteVersionInferred: boolean; frozen: boolean };
  storedPdf: (Partial<InvoiceAmountSet> & { contractValue?: string | null; drawnFromVersions?: number[]; unreadable?: string }) | null;
  sentCopy: (InvoiceAmountSet & { source?: string; sentAt?: string | null; contractValue?: string | null; drawnFromVersions?: number[] }) | null;
  emails: Array<{ sentAt: string | null; quoteVersion: number | null; hashed: boolean }>;
  /** Each quote version's customer total, by version number. */
  quoteVersionTotals: Record<string, string>;
  paid: string;
  settlement: { source: InvoiceAmountSource; total: string; recordedTotal: string | null; decidedAt: string | null } | null;
  /** The sets the owner may choose; empty once settled. */
  options: InvoiceAmountOption[];
  note: string | null;
}

export interface InvoiceAmountReport {
  ok: boolean;
  wroteNothing: true;
  durationMs: number;
  summary: { jobs: number; issuedInvoices: number; disagreeing: number; byState: Partial<Record<InvoiceAmountState, number>>; errors: number };
  invoices: InvoiceAmountEntry[];
}

export interface InvoiceAmountSettleInput {
  jobId: string;
  invoiceNumber: string;
  choose: InvoiceAmountSource;
  /** The chosen set's total, exactly as the report gave it. */
  total: string;
  reason: string;
}

/** A credit (adjustment) note against an issued invoice, as the job records it. */
export interface CreditNote {
  number: string;
  reason: string | null;
  issuedAt: string | null;
  issuedBy: string | null;
  subtotal: number;
  gst: number;
  total: number;
  currency: string;
  replacementInvoiceNumber: string | null;
  pdfPath: string | null;
  pdfSha256: string | null;
}

export interface MilestoneInvoice {
  id: string;
  jobId: string | null;
  quoteId: string | null;
  milestoneIndex: number;
  milestoneLabel: string;
  milestoneCount?: number;
  invoiceNumber: string;
  revisionNumber?: number;
  issuedRevision?: InvoiceRevision | null;
  revisionHistory?: InvoiceRevision[];
  receiptNumber: string;
  reference: string | null;
  percentage: number;
  fixedTotal?: number | null;
  subtotal: number;
  gst: number;
  total: number;
  currency: string;
  amountPaid: number;
  amountDue: number;
  lineItems: MilestoneLineItem[];
  dueDate: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  status: MilestoneInvoiceStatus;
  payments: MilestonePayment[];
  pdfPath: string | null;
  receiptPdfPath: string | null;
  /** The receipt issued when the milestone was paid (RCT-YYYY-M-N), naming the invoice it pays. */
  issuedReceipt?: { number: string; issuedAt: string | null; invoiceNumber: string | null } | null;
  contextNote?: string | null;
}

export type ProvenanceSourceType = "audio" | "note" | "chat" | "ai-generated" | "manual" | "measurement";

export interface ProvenanceSourceRef {
  kind: "activity";
  activityId: string;
  label?: string;
}

export interface ItemProvenance {
  sourceType: ProvenanceSourceType;
  actor?: { kind: string; label: string };
  createdAt?: string;
  summary?: string;
  segmentIds?: string[];
  sourceRef?: ProvenanceSourceRef | null;
}

export interface QuoteLineItem {
  code: string;
  label: string;
  description?: string;
  quoteCatalogItemCode?: string;
  customerLabel?: string;
  quantity: number;
  unit: string;
  authorityUnitPrice?: number | null;
  unitPrice: number;
  totalPrice: number;
  section?: string | null;
  workDomain?: string | null;
  customerVisible?: boolean;
  scopeSummary?: string | null;
  commercialAdjustment?: QuoteCommercialAdjustment | null;
  confidence?: number;
  rationale?: string;
  evidence?: Array<{
    segmentId?: string;
    start?: number | null;
    end?: number | null;
    speaker?: string;
    snippet?: string;
    text?: string;
  }>;
  evidenceSummary?: string[];
  requiredInputs?: string[];
  usedDefaultQuantity?: boolean;
  manualOverride?: unknown;
  provenance?: ItemProvenance[];
}

export interface QuoteOverrideReviewState {
  excluded?: boolean;
  reason?: string | null;
  at?: string | null;
  by?: { kind: string; label: string } | null;
  originCategory?: "confirmed" | "assumed" | "gaps" | null;
  detail?: string | null;
  relatedLineItems?: string[];
}

export interface QuoteLineItemOverride {
  label?: string | null;
  quantity?: number | null;
  /** @deprecated Rate changes now live in QuoteOverrides.commercialAdjustments */
  unitPrice?: number | null;
  notes?: string | null;
  reviewState?: QuoteOverrideReviewState | null;
}

export interface QuoteCommercialAdjustmentTarget {
  lineItemCode?: string | null;
  quoteCatalogItemCode?: string | null;
  section?: string | null;
}

export interface QuoteCommercialAdjustment {
  id?: string | null;
  kind?: "set_unit_price" | string | null;
  target: QuoteCommercialAdjustmentTarget;
  unitPrice?: number | null;
  notes?: string | null;
  source?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  remove?: boolean;
}

export interface QuoteAssumptionOverride {
  value?: string | null;
  note?: string | null;
  reviewState?: QuoteOverrideReviewState | null;
}

export interface ExecutionOverrides {
  accessProfile?: string | null;
  labourHours?: number | null;
  machineHours?: number | null;
  dumpDriveMinutes?: number | null;
  travelHoursPerDay?: number | null;
  note?: string | null;
}

export interface QuotePresentationOverrides {
  scopeText?: string | null;
  organizer?: QuotePresentationOrganizer | null;
  validityDays?: number | null;
}

export interface QuoteOverrides {
  lineItems?: Record<string, QuoteLineItemOverride>;
  commercialAdjustments?: QuoteCommercialAdjustment[];
  assumptions?: Record<string, QuoteAssumptionOverride>;
  presentation?: QuotePresentationOverrides | null;
  execution?: ExecutionOverrides | null;
  lockStatus?: "draft" | "final" | null;
  /** @deprecated Use lockStatus */
  deliveryStatus?: string | null;
  finalizedAt?: string | null;
}

export interface QuoteAssumptionInput {
  field: string;
  reason?: string;
  defaultValue?: string | null;
  value?: string | null;
  source?: "user" | "default" | "derived" | string | null;
  note?: string | null;
  quoteNote?: string | null;
  inputType?: string | null;
  affectsPricing?: boolean;
  alternatives?: AssumptionAlternative[];
  evidence?: Array<{
    segmentId?: string;
    start?: number | null;
    end?: number | null;
    speaker?: string;
    text?: string;
    snippet?: string;
  }>;
  evidenceSummary?: string[];
  relatedLineItems?: string[];
}

export interface QuoteExecutionStage {
  code: string;
  label: string;
  durationHours: number;
  labourHours: number;
  machineHours: number;
  supportHours: number;
  billableLabourHours: number;
  billableMachineHours: number;
  items?: string[];
}

export interface QuoteExecution {
  workingDayHours: number;
  accessProfile?: {
    code?: string | null;
    label?: string | null;
    matchedText?: string | null;
  };
  parameters?: {
    travelHoursPerDay?: number;
    dumpDriveMinutes?: number;
  };
  totals: {
    labourHours: number;
    machineHours: number;
    durationHours: number;
    siteDays: number;
    workingDays: number;
  };
  stages?: QuoteExecutionStage[];
  assumptions?: string[];
  overrides?: ExecutionOverrides | null;
  overriddenFields?: string[];
}

export interface QuotePresentationSupportEntry {
  id: string;
  ref: string;
  kind: "audio" | "commercial" | "measurement" | "activity";
  label: string;
  title: string;
  summary?: string | null;
  sourceType?: string | null;
  actor?: { kind: string; label: string } | null;
  createdAt?: string | null;
  audio?: {
    text?: string | null;
    snippet?: string | null;
    start?: number | null;
    end?: number | null;
    speaker?: string | null;
  } | null;
  reference?: {
    code?: string | null;
    label?: string | null;
    url?: string | null;
    quoteCatalogId?: string | null;
    appPath?: string | null;
  } | null;
  meta?: Array<{
    label: string;
    value: string;
  }>;
}

export interface QuotePresentationComponent {
  code: string;
  label: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  unitCost?: number | null;
  totalCost?: number | null;
  kind: "direct" | "allocated_support";
  customerFacing?: boolean;
  explanation?: string | null;
  workDomain?: string | null;
  scopeSummary?: string | null;
  supportEntries?: QuotePresentationSupportEntry[];
}

export interface QuotePresentationScheduleItem {
  code: string;
  label: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  totalPrice: number;
  unitCost?: number | null;
  totalCost?: number | null;
  kind?: "group" | "source" | "component";
  nodeId?: string;
  sourceCode?: string | null;
  sourceKind?: string | null;
  /** Canonical origin, emitted by the renderer alongside sourceKind. */
  origin?: QuotePresentationOrigin;
  /** Canonical pricing mode, emitted by the renderer alongside sourceKind. */
  pricingMode?: QuotePresentationPricingMode;
  componentSourceCode?: string | null;
  componentCode?: string | null;
  priceOverride?: number;
  costOverride?: number;
  pricingContribution?: QuotePresentationPricingContribution;
  pricingMuted?: boolean;
  contributionPrice?: number;
  contributionCost?: number;
  depth?: number;
  amountVisible?: boolean;
  amountBlank?: boolean;
  rowStyle?: "branded" | "bold" | "normal";
  collapsed?: boolean;
  excludedFromPrice?: boolean;
  section?: string | null;
  workDomain?: string | null;
  scopeSummary?: string | null;
  sourceLineItemCodes?: string[];
  componentLineItemCodes?: string[];
  allocatedLineItemCodes?: string[];
  components?: QuotePresentationComponent[];
}

export interface QuotePresentationOrganizerGroupNode {
  kind: "group";
  label: string;
  collapsed?: boolean;
  amountVisible?: boolean;
  amountBlank?: boolean;
  rowStyle?: "branded" | "bold" | "normal";
  priceSourceNodeIds?: string[];
  pricingContribution?: QuotePresentationPricingContribution;
  priceOverride?: number;
  costOverride?: number;
  excludedFromPrice?: boolean;
  children: string[];
}

export interface QuotePresentationComponentOverride {
  labelOverride?: string | null;
  amountVisible?: boolean;
  amountBlank?: boolean;
  rowStyle?: "branded" | "bold" | "normal";
  collapsed?: boolean;
}

/** Canonical provenance of a source node. `origin` and `pricingMode` are the
 *  unified contract; `sourceKind` is the legacy field kept for backward
 *  compatibility with persisted organizer trees and remains in lock-step. */
export type QuotePresentationOrigin = "engine" | "manual" | "generated";
export type QuotePresentationPricingMode = "engine" | "manual" | "allocated";
export type QuotePresentationPricingContribution = "included" | "listed_only";

export interface QuotePresentationOrganizerSourceNode {
  kind: "source";
  sourceKind?: "customer_schedule_item" | "manual" | "generated_component" | string;
  /** Canonical origin. Derived from sourceKind on legacy reads; authoritative on new writes. */
  origin?: QuotePresentationOrigin;
  /** How this node's price/cost are computed. */
  pricingMode?: QuotePresentationPricingMode;
  sourceCode: string;
  componentSourceCode?: string | null;
  componentCode?: string | null;
  componentParentCode?: string | null;
  labelOverride?: string | null;
  manualPrice?: number;
  manualCost?: number;
  /** Per-row quantity. When combined with sellRate/buyRate this drives totals for
   *  manual and catalog-linked rows. Legacy rows with only manualPrice set keep
   *  rendering via the scalar totals. */
  quantity?: number;
  unit?: string;
  sellRate?: number;
  buyRate?: number;
  /** Whether rates were last pulled from a price-catalog item or typed in directly. */
  rateMode?: "manual" | "catalog-linked";
  /** How this child row applies when its parent source quantity changes. */
  applicationMode?: "proportional" | "fixed";
  /** Optional link back to the price catalog for refresh / disambiguation. */
  catalogItemCode?: string;
  /** The catalogue item's identity (codes are editable; uids are not). */
  catalogItemUid?: string;
  /** The item_prices row the row was priced from (null for a rolled-up kit). */
  catalogPriceId?: number | null;
  /** Moves whenever anything behind the item's price moves, kit contents included. */
  catalogPriceKey?: string;
  catalogAssemblyVersion?: number;
  /** What the catalogue said when the row was linked, in the row's unit. */
  catalogSellRate?: number;
  catalogBuyRate?: number;
  catalogName?: string;
  catalogUnit?: string;
  /** A kit component's quantity per kit, in the row's unit. */
  catalogQuantity?: number;
  /** The kit item's uid, on rows added as one of its components. */
  catalogComponentOf?: string;
  /**
   * On a kit row added as component rows: the components it was added (or
   * last refreshed) with. A component listed here whose row is gone was
   * deleted by the operator, not added by the catalogue.
   */
  catalogKitComponents?: QuoteCatalogFrozenKitComponent[];
  /** "unknown" for rows linked before price ids existed. */
  catalogPriceSource?: "unknown";
  pricingContribution?: QuotePresentationPricingContribution;
  priceOverride?: number;
  costOverride?: number;
  amountVisible?: boolean;
  amountBlank?: boolean;
  rowStyle?: "branded" | "bold" | "normal";
  collapsed?: boolean;
  excludedFromPrice?: boolean;
  /** Legacy component organizer state. New writes use child source nodes instead. */
  componentOrder?: string[];
  /** Legacy component organizer state. New writes use child source nodes instead. */
  componentOverrides?: Record<string, QuotePresentationComponentOverride>;
  /** Legacy component organizer state. New writes use child source nodes instead. */
  componentChildren?: Record<string, string[]>;
  /** Component codes deliberately removed from generated breakdown materialization. */
  removedComponentCodes?: string[];
  children?: string[];
  /** True for auto-created ghost nodes that preserve a parent source node's
   *  base price when other items are nested inside it. */
  isGhostBase?: boolean;
}

export type QuotePresentationOrganizerNode =
  | QuotePresentationOrganizerGroupNode
  | QuotePresentationOrganizerSourceNode;

export interface QuotePresentationOrganizer {
  root: string[];
  nodes: Record<string, QuotePresentationOrganizerNode>;
  /** Engine source codes deliberately removed from the customer-facing organizer. */
  removedSourceCodes?: string[];
}

export interface QuoteInternalPricingTotals {
  cost: number;
  charge: number;
}

export interface QuotePricingIssue {
  code?: string | null;
  reason?: string | null;
  message?: string | null;
}

export interface QuotePricingAttestation {
  version?: number;
  requestNonce?: string | null;
  verifiedNonce?: string | null;
  status?: "verified" | "unverified" | string | null;
  provider?: string | null;
  mode?: string | null;
  baseUrl?: string | null;
  buyingPriceList?: string | null;
  sellingPriceList?: string | null;
  authorityRefreshedAt?: string | null;
  attestedAt?: string | null;
  blockingReason?: string | null;
}

export interface QuotePricing {
  authorityProvider?: string | null;
  issues?: QuotePricingIssue[];
  ready?: boolean;
  displayable?: boolean;
  sendable?: boolean;
  blockingReason?: string | null;
  requestNonce?: string | null;
  attestation?: QuotePricingAttestation | null;
}

export interface ClarificationNoteSignals {
  reviewRequested?: boolean;
  duplicationConcern?: boolean;
  rebuildDirective?: boolean;
  questionRaised?: boolean;
}

export interface ClarificationNoteSummary {
  total?: number;
  operatorCount?: number;
  systemCount?: number;
  actionableCount?: number;
  reviewRequestedCount?: number;
  duplicationConcernCount?: number;
  rebuildDirectiveCount?: number;
  questionRaisedCount?: number;
  referencedItemCodes?: string[];
  latestCreatedAt?: string | null;
}

export interface ClarificationNote {
  title?: string | null;
  text?: string | null;
  author?: string | null;
  surface?: string | null;
  layer?: string | null;
  itemCode?: string | null;
  itemLabel?: string | null;
  createdAt?: string | null;
  version?: string | null;
  source?: "operator" | "system" | string | null;
  actionable?: boolean;
  signals?: ClarificationNoteSignals | null;
}

export interface QuoteBreakdownSourceSummary {
  kind?: string;
  version?: number;
  generatedAt?: string | null;
  sectionCount?: number;
  bulkRemovalPlanCount?: number;
  clarificationNoteCount?: number;
  operatorClarificationNoteCount?: number;
  actionableClarificationNoteCount?: number;
  reviewRequestedNoteCount?: number;
  duplicationConcernNoteCount?: number;
}

export interface QuoteCommercialLine {
  code?: string | null;
  itemCode?: string | null;
  label?: string | null;
  description?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  totalPrice?: number | null;
  unitCost?: number | null;
  totalCost?: number | null;
  sourceLineItemCode?: string | null;
  section?: string | null;
  pricingSource?: string | null;
  customerVisible?: boolean;
  syncToCommercialAuthority?: boolean;
}

export interface QuoteMaterialOrder {
  code?: string | null;
  itemCode?: string | null;
  label?: string | null;
  quantity?: number | null;
  unit?: string | null;
  unitCost?: number | null;
  unitPrice?: number | null;
  section?: string | null;
  sourceLineItemCode?: string | null;
}

export interface QuoteLineItemBreakdown {
  sourceLineItemCode?: string | null;
  sourceLineItemLabel?: string | null;
  section?: string | null;
  sourceTotalPrice?: number | null;
  sourceQuantity?: number | null;
  sourceUnit?: string | null;
  recipe?: string | null;
  note?: string | null;
  pricingIssues?: QuotePricingIssue[];
  commercialLines?: QuoteCommercialLine[];
  budgetLines?: QuoteCommercialLine[];
  materialOrders?: QuoteMaterialOrder[];
  totals?: QuoteInternalPricingTotals | null;
}

export interface QuoteOptionFamilyOption {
  sourceLineItemCode?: string | null;
  sourceLineItemLabel?: string | null;
  sourceSection?: string | null;
  totalPrice?: number | null;
  isDefault?: boolean;
  isDisplay?: boolean;
  isAccepted?: boolean;
  isActive?: boolean;
}

export interface QuoteOptionFamily {
  id?: string | null;
  key?: string | null;
  label?: string | null;
  originalSection?: string | null;
  defaultOptionCode?: string | null;
  displayOptionCode?: string | null;
  acceptedOptionCode?: string | null;
  activeOptionCode?: string | null;
  options?: QuoteOptionFamilyOption[];
}

export interface QuoteSelectionState {
  hasOptionFamilies?: boolean;
  optionFamilyCount?: number;
  handoffReady?: boolean;
  invoiceReady?: boolean;
  note?: string | null;
  optionFamilies?: QuoteOptionFamily[];
}

export interface QuoteInternalPricing {
  mode?: string | null;
  unresolvedOptions?: boolean;
  ready?: boolean;
  coverage?: Record<string, number | string | null | undefined> | null;
  totals?: QuoteInternalPricingTotals | null;
  note?: string | null;
  pricingIssues?: QuotePricingIssue[];
  lineItemBreakdowns?: QuoteLineItemBreakdown[];
  lineItemBreakdownsCount?: number;
  optionFamilies?: QuoteOptionFamily[];
  selectionState?: QuoteSelectionState | null;
  materialOrders?: QuoteMaterialOrder[];
  materialOrderCount?: number;
  commercialLines?: QuoteCommercialLine[];
  commercialLineCount?: number;
  budgetLines?: QuoteCommercialLine[];
  budgetLineCount?: number;
}

export interface Quote {
  kind?: string;
  version?: number;
  status?: string;
  generatedAt?: string;
  updatedAt?: string;
  quoteNumber?: string | null;
  jobNumber?: string | null;
  lineItems: QuoteLineItem[];
  totals: {
    subtotal: number;
    gst: number;
    total: number;
    currency: string;
  };
  quoteCatalog?: { gstRate?: number | null } | null;
  assumptions?: string[];
  assumptionInputs?: QuoteAssumptionInput[];
  missingInputs?: string[];
  summary?: string;
  presentation?: {
    template?: string;
    recommendationReason?: string;
    scopeText?: string | null;
    scopeOfWorks?: string[];
    organizer?: QuotePresentationOrganizer | null;
    sourceItems?: QuotePresentationScheduleItem[];
    scheduleItems?: QuotePresentationScheduleItem[];
    sections?: Array<{
      label?: string | null;
      items: QuotePresentationScheduleItem[];
    }>;
    classification?: {
      executionSize?: "small" | "medium" | "large";
      executionComplexity?: "low" | "medium" | "high";
      siteDays?: number;
      personDays?: number;
      workDomainCount?: number;
      sectionCount?: number;
    } | null;
  } | null;
  jobScope?: Record<string, unknown>;
  execution?: QuoteExecution | null;
  delivery?: {
    status?: "draft" | "final";
    finalizedAt?: string | null;
    label?: string;
    versionLabel?: string;
  };
  review?: {
    status?: string;
    reasons?: string[];
  };
  pricing?: QuotePricing | null;
  customerPricing?: {
    charge: number;
    cost: number;
    subtotal: number;
    gst: number;
    total: number;
  } | null;
  commercialLines?: QuoteCommercialLine[];
  budgetLines?: QuoteCommercialLine[];
  materialOrders?: QuoteMaterialOrder[];
  commercialLinesCount?: number;
  budgetLinesCount?: number;
  materialOrdersCount?: number;
  hasInternalBreakdown?: boolean;
  breakdownSource?: QuoteBreakdownSourceSummary | null;
  optionFamilies?: QuoteOptionFamily[];
  selectionState?: QuoteSelectionState | null;
  internalPricing?: QuoteInternalPricing | null;
  moasure?: MoasureSummary | null;
}

export interface QuoteEvidencePack {
  kind: string;
  version: number;
  generatedAt: string;
  recording?: Record<string, unknown>;
  evidence?: {
    cleanedTranscript?: string;
    cleanedTurns?: Array<{ speaker?: string; text?: string }>;
    segments?: Array<{ id?: string; speaker?: string; start?: number | null; end?: number | null; text?: string }>;
    hasTimestampedSegments?: boolean;
    segmentCount?: number;
    clarificationNotes?: ClarificationNote[];
    clarificationNoteSummary?: ClarificationNoteSummary | null;
  };
  extraction?: Record<string, unknown>;
  quoteCatalog?: Record<string, unknown>;
}

export interface QuoteLifecycle {
  version: number;
  createdAt?: string | null;
  updatedAt?: string | null;
  firstBuiltAt?: string | null;
  lastBuiltAt?: string | null;
  buildCount?: number;
  buildReasons?: Record<string, number>;
  lastBuildReason?: string | null;
  currentQuoteVersion?: number | null;
  currentPipelineStage?: PipelineStage | null;
  currentLockStatus?: "draft" | "final" | null;
  correctionCount?: number;
  lineItemCorrectionCount?: number;
  assumptionCorrectionCount?: number;
  lastCorrectedAt?: string | null;
  lastCorrectionActor?: { kind: string; label: string } | null;
  lockStatusChangeCount?: number;
  lastLockStatusChangeAt?: string | null;
  sendCount?: number;
  lastSentAt?: string | null;
  lastSentQuoteVersion?: number | null;
  lastSentTo?: string | null;
  /** Moved to Sent by hand: locks the version, but is not a delivery. */
  markedSentQuoteVersion?: number | null;
  markedSentAt?: string | null;
  markedSentBy?: string | null;
  landedAt?: string | null;
  lostAt?: string | null;
  archivedAt?: string | null;
  archivedReason?: string | null;
  archivedBeforeSend?: boolean;
  abandonedAt?: string | null;
}

export interface QuoteEditPolicy {
  businessStage: PipelineStage;
  latestVersion: number | null;
  selectedVersion: number | null;
  lastSentQuoteVersion: number | null;
  existingDraftVersion: number | null;
  selectedIsLatest: boolean;
  selectedVersionStage: PipelineStage;
  latestVersionStage: PipelineStage;
  selectedVersionLocked: boolean;
  latestVersionLocked: boolean;
  canEditSelectedVersion: boolean;
  requiresDraftRevision: boolean;
  lockReason: string | null;
}

export interface TranscriptSegment {
  speaker?: string;
  text: string;
  start?: number;
  end?: number;
}

export interface Transcript {
  model?: string;
  speakers?: Array<{ label: string }>;
  segments?: TranscriptSegment[];
  fullText?: string;
  cleaned?: {
    title?: string;
    cleanedText?: string;
    turns?: Array<{ speaker?: string; text: string }>;
  };
}

export interface GapItem {
  id: string;
  field: string;
  description?: string;
  reason?: string;
  status: "open" | "in_progress" | "accepted" | "confirmed" | "rejected" | "cleared";
  assumption?: {
    available: boolean;
    defaultValue?: string;
    value?: string;
  };
  evidence?: Array<{ text: string }>;
  resolution?: {
    mode?: string | null;
    reason?: string | null;
    reasonCode?: string | null;
    note?: string | null;
    at?: string | null;
    by?: { kind: string; label: string } | null;
  } | null;
  presentInCurrentContext?: boolean;
  severity?: string;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
}

export type ReviewActionMode = "accept" | "confirm" | "reject" | "reopen" | "edit";

export interface ConfirmedReviewEvidence {
  id: string;
  kind: "audio" | "text";
  text: string;
  segmentId?: string;
  speaker?: string;
  start?: number;
  end?: number;
}

export interface ConfirmedReviewItem {
  id: string;
  code?: string | null;
  label: string;
  detail: string;
  kind: "line_item" | "resolved_gap";
  price?: number | null;
  evidenceCount?: number;
  evidence?: ConfirmedReviewEvidence[];
  evidenceSummary?: string[];
  provenance?: ItemProvenance[];
  allowedActions?: ReviewActionMode[];
}

export interface AssumptionAlternative {
  value: string;
  label: string;
}

export interface AssumedReviewItem {
  id: string;
  field: string;
  value: string;
  summary: string;
  detail: string;
  gapId: string | null;
  originLabel: string;
  originTone: "operator" | "system";
  canConfirm: boolean;
  allowedActions?: ReviewActionMode[];
  alternatives?: AssumptionAlternative[];
  evidenceSummary?: string[];
  relatedLineItems?: string[];
  provenance?: ItemProvenance[];
}

export interface RejectedReviewItem {
  id: string;
  label: string;
  detail: string;
  kind: "line_item" | "assumption" | "gap";
  originCategory: "confirmed" | "assumed" | "gaps";
  gapId?: string | null;
  reason?: string | null;
  impactSummary?: string | null;
  relatedLineItems?: string[];
  provenance?: ItemProvenance[];
  allowedActions?: ReviewActionMode[];
}

export interface QuoteReviewState {
  counts: {
    confirmed: number;
    assumed: number;
    gap: number;
  };
  openGaps: GapItem[];
  acceptedGaps: GapItem[];
  triagedGaps: GapItem[];
  assumedItems: AssumedReviewItem[];
  confirmedItems: ConfirmedReviewItem[];
  rejectedItems: RejectedReviewItem[];
  canSend: boolean;
  blockingReason: string | null;
}

export interface NoteEntry {
  id: string;
  text: string;
  createdAt: string;
  actor?: { kind: string; label: string };
}

export interface ActivityEntry {
  id: string;
  type?: string;
  text?: string;
  createdAt?: string;
  actor?: { kind: string; label: string };
  kind?: string;
  title?: string;
  body?: string;
  ts?: string;
  field?: string | null;
  before?: unknown;
  after?: unknown;
  gapId?: string | null;
  gapStatus?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  reviewItemId?: string | null;
  reviewItemKind?: string | null;
  reviewAction?: string | null;
  originCategory?: string | null;
  evidence?: {
    start?: number | null;
    end?: number | null;
    text?: string;
    speaker?: string | null;
  } | null;
}

export interface JobState {
  details?: {
    siteAddress?: string;
    customer?: { name?: string };
    contact?: { name?: string; phone?: string; email?: string };
    quotedBy?: { name?: string };
    gps?: { lat: number; lng: number };
    archivedAt?: string;
    archivedReason?: string;
    captureCount?: number;
    soilDump?: SoilDump;
  };
  notes?: NoteEntry[];
  activity?: ActivityEntry[];
  gaps?: GapItem[];
}

export interface QuoteVersion {
  version: number;
  label: string;
  createdAt: string;
  total?: number;
  /** "final" once sent (locked); otherwise the draft's status. */
  status?: string | null;
  isLatest?: boolean;
  isSelected?: boolean;
}

export interface MoasureFileSummary {
  name: string;
  kind: "csv" | "pdf" | "mfile" | "other";
}

export interface MoasureBatchSummary {
  batchId: string;
  fileCount: number;
  files?: MoasureFileSummary[];
  csvFiles?: string[];
  pdfFiles?: string[];
  mfiles?: string[];
  otherFiles?: string[];
}

export interface MoasureSummary {
  status: string;
  batchCount: number;
  latestBatchId?: string | null;
  locationHints?: {
    rawDir?: string;
    parsedJson?: string;
    parsedMarkdown?: string;
  };
  imports?: Array<{
    label: string;
    csvFile?: string;
    batchId?: string;
    area?: number | null;
    perimeter?: number | null;
    elevationRange?: number | null;
    relatedPdfFiles?: string[];
    relatedMfiles?: string[];
  }>;
  batches?: MoasureBatchSummary[];
}

export interface RecordingDetail {
  meta: RecordingMeta;
  transcript?: Transcript;
  tasks?: unknown;
  report?: string;
  quoteEvidencePack?: QuoteEvidencePack;
  quoteInputs?: unknown;
  quote?: Quote;
  quoteMarkdown?: string;
  quoteBreakdownSource?: QuoteBreakdownSourceSummary | null;
  quoteOverrides?: QuoteOverrides | null;
  quoteLifecycle?: QuoteLifecycle;
  quoteEditPolicy?: QuoteEditPolicy | null;
  moasure?: MoasureSummary;
  quoteVersions?: QuoteVersion[];
  versionView?: {
    latestVersion: number;
    latestLabel: string;
    selectedVersion: number;
    selectedLabel: string;
    isLatest: boolean;
  };
  review?: QuoteReviewState;
  proof?: QuoteProofSummary;
  ui?: UiConfig;
  jobState?: JobState;
  deletion?: JobDeletion;
}

/** Whether a job may be permanently deleted, and if not, why it is kept. */
export interface JobDeletion {
  deletable: boolean;
  reasons: string[];
}

export interface QuoteProofSummary {
  version: number;
  runType: "seeded_fixture" | "manual_entry" | "audio_capture" | "unknown";
  buildReason?: string | null;
  verdict: "incomplete" | "structural_only" | "manual_review" | "built_not_validated" | "review_ready" | "sent";
  claim: string;
  whatIsProven: string[];
  whatIsNotProven: string[];
  recommendedFirstFiles: string[];
  artifacts: {
    transcript: boolean;
    evidencePack: boolean;
    quoteInputs: boolean;
    quote: boolean;
    quotePdf: boolean;
    quoteLifecycle: boolean;
  };
  reviewStatus?: string | null;
  canSend?: boolean;
  sendCount?: number;
}

export interface UiConfig {
  deploymentTheme: string;
  workerDisplayName: string;
  assistantDisplayName: string;
  /** The business stock email signatures sign with: trading name, else legal name (config businessProfile over the quote catalogue's). */
  businessName?: string;
}

export interface SoilDump {
  id: string;
  name: string;
  suburb: string;
  addr: string;
  dist: number;
  drive: number;
  lat: number;
  lng: number;
  accepts: string[];
  hours: string;
  open: boolean;
  defaultForUnspecified?: boolean;
}

/**
 * A disposal rate resolved from the price catalogue, in the item's own
 * costing basis. Rates are never hardcoded on the client — see
 * client/src/lib/disposal-rates.ts.
 */
export interface DisposalRate {
  code: string;
  label: string;
  sellPrice: number | null;
  pricingBasis: "per_tonne" | "per_load" | "per_m3" | null;
  pricingBasisFactor: number | null;
  unit: string;
}

export interface QuoteCatalog {
  id: string;
  label: string;
  description?: string;
}

export interface QuoteCatalogLineItem {
  code: string;
  label: string;
  unit: string;
  unitPrice: number | null;
  sellRate?: number | null;
  buyingRate?: number | null;
  defaultQuantity: number;
  authorityItemCode?: string | null;
  pricingStatus?: string;
  pricingIssues?: string[];
  quoteable?: boolean;
  quantitySource?: string | null;
  requiredInputs?: string[];
  keywords?: string[];
  workDomain?: string | null;
  execution?: {
    stage?: string | null;
    labourHoursPerUnit?: number;
    machineHoursPerUnit?: number;
    supportHoursPerUnit?: number;
    billableLabourHoursPerUnit?: number;
    billableMachineHoursPerUnit?: number;
    supportHoursMode?: string | null;
  } | null;
  presentation?: {
    customerVisible?: boolean;
    scheduleLabel?: string | null;
    summaryLabel?: string | null;
    defaultSection?: string | null;
  } | null;
  fallback?: boolean;
}

export interface QuoteCatalogDetail {
  id: string;
  name: string;
  label?: string;
  currency: string;
  gstRate: number;
  hoursPerDay: number;
  commercialAuthority?: {
    provider?: string | null;
    mode?: string | null;
    syncedAt?: string | null;
    refreshedAt?: string | null;
    overlaidRuleCount?: number | null;
    error?: string | null;
  } | null;
  lineItems: QuoteCatalogLineItem[];
}

export interface PriceCatalogChild {
  uid?: string | null;
  code: string;
  name: string;
  quantity: number;
  entry_quantity?: number | null;
  entry_unit?: string | null;
  application_mode?: "proportional" | "fixed" | null;
  pricing_contribution?: "included" | "listed_only" | null;
  sort_order?: number | null;
  buy_price?: number | null;
  sell_price?: number | null;
  effective_buy_price?: number | null;
  effective_sell_price?: number | null;
  unit?: string | null;
  catalog_type?: "goods_service" | "product" | "service" | "component" | "item" | null;
  status?: string | null;
  source?: "db" | "recipe";
  recipe_code?: string | null;
  missing?: boolean;
  synthetic?: boolean;
  balance?: boolean;
}

export interface PriceCatalogInactiveComponent {
  code: string;
  name?: string | null;
  status?: string | null;
}

export interface PriceCatalogItem {
  uid?: string | null;
  code: string;
  name: string;
  unit: string;
  buy_price: number | null;
  sell_price: number | null;
  buy_price_mode: "manual" | "computed";
  sell_price_mode: "manual" | "computed";
  price_reference?: string | null;
  catalog_type?: "goods_service" | "product" | "service" | "component" | "item" | null;
  category?: string | null;
  status: "active" | "archived";
  pricing_basis?: "per_tonne" | "per_load" | "per_m3" | null;
  pricing_basis_factor?: number | null;
  updated_at?: string | null;
  created_at?: string | null;
  effective_buy_price?: number | null;
  effective_sell_price?: number | null;
  child_count?: number;
  inactive_component_count?: number;
  inactive_components?: PriceCatalogInactiveComponent[];
  children?: PriceCatalogChild[];
}

export type PriceCatalogHealthSeverity = "critical" | "warning" | "info";

export interface PriceCatalogHealthCheck {
  key: string;
  label: string;
  severity: PriceCatalogHealthSeverity;
  count: number;
  ok: boolean;
}

export interface PriceCatalogHealthIssue {
  key: string;
  severity: PriceCatalogHealthSeverity;
  label: string;
  code?: string | null;
  uid?: string | null;
  name?: string | null;
  status?: string | null;
  message: string;
  count?: number;
  relatedCodes?: string[];
  childCode?: string | null;
  childName?: string | null;
  childStatus?: string | null;
  catalogType?: string | null;
  buyPrice?: number | null;
  sellPrice?: number | null;
  buyPriceMode?: string | null;
  sellPriceMode?: string | null;
  /** Where a missing or archived item is still used (quote rules, rate card, kits). */
  usedBy?: string[];
  /** Price-book checks: the current or scheduled price's date, a staged import's uid. */
  priceEffectiveFrom?: string | null;
  importUid?: string | null;
}

export interface PriceCatalogDuplicateNameCensusItem {
  code: string;
  uid?: string | null;
}

export interface PriceCatalogDuplicateNameCensusGroup {
  nameKey: string;
  name: string;
  count: number;
  items: PriceCatalogDuplicateNameCensusItem[];
}

export interface PriceCatalogDuplicateNameCensus {
  groupCount: number;
  itemCount: number;
  safeToEnforce: boolean;
  groups: PriceCatalogDuplicateNameCensusGroup[];
}

export interface PriceCatalogHealthReport {
  generatedAt: string;
  summary: {
    totalItems: number;
    activeItems: number;
    archivedItems: number;
    missingUidCount: number;
    duplicateActiveNameCount: number;
    inactiveComponentDependencyCount: number;
    costAboveSellCount: number;
    missingCategoryCount: number;
    missingPriceCount: number;
    computedWithoutChildrenCount: number;
  };
  duplicateCensus: PriceCatalogDuplicateNameCensus;
  checks: PriceCatalogHealthCheck[];
  issues: PriceCatalogHealthIssue[];
}


export interface UserProfile {
  id: string;
  email: string;
  name: string;
  /** Password sign-in: "admin" | "user". With Clerk sign-in: "admin" for owners. */
  role?: string;
  /** Clerk sign-in only. */
  fieldRole?: FieldUserRole;
  status?: FieldUserStatus;
  /** Clerk sign-in, owners: whether owner-only actions are open to this sign-in. */
  mfaVerified?: boolean;
  ownerVerifiedBy?: "second_factor" | "google_workspace" | "break_glass" | null;
  /** Clerk sign-in, owners without a verified owner sign-in: how to get one. */
  ownerVerificationHelp?: string;
}

export type FieldUserRole = "owner" | "staff";
export type FieldUserStatus = "active" | "pending" | "disabled";

/** A person in Field's users table (Clerk sign-in, owner screens). */
export interface FieldUser {
  id: string;
  email: string;
  name: string;
  role: FieldUserRole;
  status: FieldUserStatus;
  linked: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A server-rendered theme: `<family>` (light) or `<family>-dark` (shared/themes.js). */
export type ThemeId = string;

/** A catalogue item as a quote row freezes it (GET /api/price-catalog/items/:code/quote-line). */
export interface QuoteCatalogLineComponent {
  index: number;
  itemUid: string | null;
  code: string | null;
  name: string | null;
  unit: string;
  quantity: number;
  sellRate: number | null;
  buyRate: number | null;
  priceId: number | null;
  priceKey: string | null;
  status: string;
  priced: boolean;
  applicationMode: "proportional" | "fixed";
  pricingContribution: "included" | "listed_only";
}

export interface QuoteCatalogLine {
  itemUid: string;
  code: string;
  name: string;
  unit: string;
  status: string;
  priced: boolean;
  problems: Array<{ kind: string; childCode?: string; status?: string; side?: string }>;
  sellRate: number | null;
  buyRate: number | null;
  priceId: number | null;
  priceKey: string;
  assemblyVersion: number | null;
  catalogVersion: number;
  etag: string;
  components: QuoteCatalogLineComponent[];
  /** Why a kit's components were not expanded into rows (it goes on as one row). */
  componentsWithheld?: "recipe" | "does_not_sum" | "unpriced" | null;
}

export interface QuoteCatalogFrozenKitComponent {
  itemUid: string;
  code: string | null;
  quantity?: number;
  unit?: string;
}

export interface QuoteCatalogChangeField {
  field: "sellRate" | "buyRate" | "name" | "unit" | "code";
  from: number | string;
  to: number | string;
  rowValue?: number | null;
  unit?: string;
}

export interface QuoteCatalogChangeLine {
  nodeId: string;
  parentNodeId: string | null;
  label: string;
  code: string;
  itemUid: string | null;
  kitComponentOf: string | null;
  overridden: boolean;
  priceSourceUnknown: boolean;
  isKit: boolean;
  /** Kit rows recognised from how the base-era editor built them (no catalogComponentOf). */
  legacyKitRows: boolean;
  /** A row at rate 0 priced from rows under it that are not its kit's rows: listed, never applied. */
  pricedFromChildren?: boolean;
  /** Whether the banner ticks this row before the operator does (server-decided). */
  selectedByDefault: boolean;
  /**
   * The row (and the rows directly under it) as this check saw it
   * (shared/quote-catalog-review.js). The editor re-checks instead of
   * applying when its draft's key differs, and sends it with the apply so
   * the server skips a row edited since.
   */
  reviewKey?: string | null;
  status: "changed" | "missing" | "archived" | "unpriced" | "unit_mismatch";
  applicable: boolean;
  message: string | null;
  fields: QuoteCatalogChangeField[];
  kit: {
    /** `unconfirmed`: the kit row froze no components, so the row may be one the operator deleted. */
    added: Array<{ itemUid: string; code: string; name: string; quantity: number; unit: string; unconfirmed?: boolean }>;
    removed: Array<{ nodeId: string; itemUid: string | null; code: string | null; name: string | null }>;
    /** `fromUnknown`: a legacy row froze no per-kit quantity, so `from` is its quantity now. */
    quantities: Array<{ nodeId: string; itemUid: string; code: string; name: string; from: number; to: number; unit: string; overridden: boolean; fromUnknown?: boolean }>;
    /** The kit is now one row at its catalogue price: applying removes its component rows. */
    collapsed?: boolean;
  } | null;
}

export interface QuoteCatalogChanges {
  ok?: boolean;
  catalogVersion: number;
  etag: string;
  changedCount: number;
  applicableCount: number;
  lines: QuoteCatalogChangeLine[];
  source?: "draft" | "saved";
  quoteVersion?: number | null;
  locked?: boolean;
  lockReason?: string | null;
}

export interface QuoteCatalogApplyResult {
  ok?: boolean;
  organizer: QuotePresentationOrganizer;
  applied: string[];
  skipped: Array<{ nodeId: string; status: string; reason: string | null }>;
  catalogVersion: number;
  etag: string;
  changes: QuoteCatalogChanges;
  saved: boolean;
}
