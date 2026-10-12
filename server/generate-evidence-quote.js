import {
  DEFAULT_QUOTE_CATALOG_ID,
  getQuoteCatalog,
  resolveQuoteCatalogRule,
  resolveQuoteCatalogRuleCode,
} from "./quote-catalogs.js";
import { resolveQuoteCatalogIdFromMeta } from "./quote-catalog-ids.js";
import {
  findCommercialAdjustmentForLineItem,
  mergeCommercialAdjustments,
  liftLegacyLineItemRateAdjustments,
  normalizeCommercialAdjustments,
  normalizePresentationOverrides,
} from "./quote-commercial-adjustments.js";
import { applyExecutionEstimateToLineItems, estimateQuoteExecution } from "./quote-execution-estimator.js";
import { applyPresentationToQuote, getCustomerScheduleItems } from "./quote-presentation.js";
import { applyQuoteCommercialBreakdownToQuote } from "./quote-commercial-compiler.js";
import { applyQuoteCatalogQuantityRules } from "./quote-quantity-rules.js";
import { isPriceCatalogAuthorityProvider, normalizeCommercialAuthorityProvider } from "./quote-trace.js";
import { formatInactiveComponentDependencyList } from "./catalog/views.js";
import { formatCatalogUnit, formatCatalogUnitText, normalizeCatalogUnit } from "../shared/catalog-units.js";
import { taxOnSubtotal } from "../shared/money.js";

export function generateEvidenceQuote({
  meta,
  transcript,
  quoteInputs,
  quoteCatalogId = null,
  quoteCatalog: suppliedQuoteCatalog = null,
  overrides = null,
  version = 1,
  moasureSummary = null,
  details = null,
  breakdownSource = null,
  recipePricing = null,
  retainingWallContext = null,
}) {
  const resolvedQuoteCatalogId = quoteCatalogId
    || resolveQuoteCatalogIdFromMeta(meta, DEFAULT_QUOTE_CATALOG_ID);
  const quoteCatalog = suppliedQuoteCatalog || getQuoteCatalog(resolvedQuoteCatalogId);
  const quoteCatalogReferenceUrl = `/api/quote-catalogs/${quoteCatalog.id}/reference`;
  const normalizedOverrides = normalizeOverrides(overrides);
  const lineItemBuild = buildLineItems({
    quoteInputs,
    quoteCatalog: quoteCatalog,
    quoteCatalogReferenceUrl: quoteCatalogReferenceUrl,
    lineItemOverrides: normalizedOverrides.lineItems,
    commercialAdjustments: normalizedOverrides.commercialAdjustments,
    assumptionOverrides: normalizedOverrides.assumptions,
    moasureSummary,
    details,
    breakdownSource,
  });
  const scopedLineItems = lineItemBuild.lineItems;
  const execution = estimateQuoteExecution({
    lineItems: scopedLineItems,
    quoteCatalog: quoteCatalog,
    quoteInputs,
    details,
    assumptionOverrides: normalizedOverrides.assumptions,
    executionOverrides: normalizedOverrides.execution,
  });
  const executionEstimateResult = applyExecutionEstimateToLineItems({
    lineItems: scopedLineItems,
    quoteCatalog: quoteCatalog,
    execution,
  });
  const lineItems = executionEstimateResult.lineItems;
  const supportLineItemsResult = ensureCommercialSupportLineItems({
    lineItems,
    quoteCatalog,
    quoteCatalogReferenceUrl,
    lineItemOverrides: normalizedOverrides.lineItems,
  });
  const pricingLineItems = supportLineItemsResult.lineItems;
  // DEL-46 (P3, round 7): a derived/support line silently omitted for lack
  // of a rate (see both functions above) still needs to surface through the
  // same pricingIssue + review-reason convention buildLineItems's own
  // pricing issues already use, not disappear from the quote with no signal.
  const derivedPricingIssues = [
    ...executionEstimateResult.pricingIssues,
    ...supportLineItemsResult.pricingIssues,
  ].map((issue) => buildPricingIssue(issue));
  const derivedAssumptions = execution?.derivedAssumptions || [];
  const derivedAssumptionKeys = new Set(
    derivedAssumptions.map((item) => normalizeField(item.field)).filter(Boolean)
  );
  const missingInputFields = dedupe([
    ...(quoteInputs.missingInputs || []).map((item) => item.field || item.reason).filter(Boolean),
    ...lineItems.flatMap((item) => item.requiredInputs || []),
  ]).filter((field) => !derivedAssumptionKeys.has(normalizeField(field)));
  const assumptionInputs = buildAssumptionInputs({
    missingInputFields,
    quoteInputs,
    lineItems,
    quoteCatalog: quoteCatalog,
    assumptionOverrides: normalizedOverrides.assumptions,
    derivedAssumptions,
  });
  const missingInputs = assumptionInputs
    .filter((item) => item.source !== "derived")
    .map((item) => item.field);
  const gstRate = quoteCatalog.gstRate ?? 0.1;
  const lineItemTotals = pricingLineItems.map((item) => item?.totalPrice);
  const subtotal = lineItemTotals.some((value) => value == null || !Number.isFinite(Number(value)))
    ? null
    : roundMoney(lineItemTotals.reduce((sum, value) => sum + Number(value), 0));
  const delivery = buildDeliveryState(normalizedOverrides.delivery, version);

  const shallowSoilFlags = buildShallowSoilDepthFlags({ lineItems, moasureSummary, quoteInputs });

  const assumptions = dedupe([
    quoteCatalog.sourceNote,
    ...(quoteInputs.assumptions || []).map((item) => item.statement).filter(Boolean),
    ...lineItems.flatMap((item) => item.assumptions || []),
    ...(execution?.assumptions || []),
    ...assumptionInputs.map((item) => `${describeAssumptionSource(item.source)} for ${item.field}: ${item.value}`),
    ...shallowSoilFlags.map((flag) => flag.message),
  ]);

  const reviewReasons = dedupe([
    quoteInputs.reviewStatus !== "ready" ? "Quote extraction flagged manual review." : null,
    ...lineItemBuild.pricingIssues.map((issue) => issue.message),
    ...derivedPricingIssues.map((issue) => issue.message),
    ...missingInputs.map((item) => `Missing input priced with assumption: ${item}`),
    ...lineItems.filter((item) => item.usedDefaultQuantity).map((item) => `Default quantity used for ${item.label}.`),
    ...lineItems.filter((item) => item.manualOverride).map((item) => `Manual override applied to ${item.label}.`),
    ...lineItems.filter((item) => !item.evidence?.length).map((item) => `No timestamped evidence was attached to ${item.label}.`),
    ...assumptionInputs.filter((item) => item.source === "default" && item.affectsPricing).map((item) => `Default pricing assumption used for ${item.field}.`),
    ...assumptionInputs.filter((item) => item.source === "derived" && item.affectsPricing).map((item) => `Derived pricing assumption used for ${item.field}.`),
    ...(quoteInputs.recordingIntent !== "job-scope" && quoteInputs.recordingIntent !== "mixed"
      ? [`Recording intent is ${quoteInputs.recordingIntent}.`]
      : []),
    ...shallowSoilFlags.map((flag) => flag.reviewReason),
  ]);

  const reviewStatus = reviewReasons.length > 0 ? "manual_review" : "ready";

  const quote = {
    kind: "quote",
    version,
    status: reviewStatus,
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    jobId: meta.id,
    jobNumber: meta.jobNumber || null,
    quoteNumber: meta.quoteNumber || null,
    title: meta.title || meta.label || "Untitled recording",
    recordingIntent: quoteInputs.recordingIntent,
    delivery,
    quoteCatalog: {
      id: quoteCatalog.id,
      name: quoteCatalog.name,
      sourceNote: quoteCatalog.sourceNote,
      currency: quoteCatalog.currency,
      gstRate: quoteCatalog.gstRate,
      businessProfile: quoteCatalog.businessProfile || null,
      commercialAuthority: quoteCatalog.commercialAuthority || null,
      deliveryDefaults: quoteCatalog.deliveryDefaults || {},
      referenceUrl: quoteCatalogReferenceUrl,
    },
    context: quoteInputs.jobScope?.siteContext || null,
    summary: quoteInputs.summary || null,
    jobScope: quoteInputs.jobScope || null,
    processReferences: quoteInputs.processReferences || [],
    siteConstraints: quoteInputs.siteConstraints || [],
    measurements: quoteInputs.measurements || [],
    lineItems: pricingLineItems,
    assumptionInputs,
    execution,
    moasure: summarizeMoasureForQuote(moasureSummary),
    breakdownSource: summarizeQuoteBreakdownSource(breakdownSource),
    review: {
      status: reviewStatus,
      reasons: reviewReasons,
    },
    missingInputs,
    assumptions,
    commercialAuthority: quoteCatalog.commercialAuthority ? {
      ...quoteCatalog.commercialAuthority,
    } : {
      provider: "catalog",
      mode: "disabled",
    },
    pricing: {
      authorityProvider: quoteCatalog.commercialAuthority?.provider || "catalog",
      issues: [...lineItemBuild.pricingIssues, ...derivedPricingIssues],
      ready: lineItemBuild.pricingIssues.length === 0 && derivedPricingIssues.length === 0,
    },
    quoteCatalogEntriesUsed: dedupeBy(
      pricingLineItems.map((item) => item.quoteCatalogEntry).filter(Boolean),
      (item) => item.code,
    ),
    totals: {
      subtotal,
      gst: subtotal == null ? null : taxOnSubtotal(subtotal, gstRate),
      total: subtotal == null ? null : roundMoney(subtotal + taxOnSubtotal(subtotal, gstRate)),
      currency: quoteCatalog.currency,
      _preCompilation: true,
    },
  };
  quote.quoteCatalog = quote.quoteCatalog;
  quote.quoteCatalogEntriesUsed = quote.quoteCatalogEntriesUsed;

  const quoteWithCommercial = applyQuoteCommercialBreakdownToQuote({
    quote,
    quoteCatalog,
    details,
    optionSelections: normalizedOverrides.optionSelections,
    acceptedOptionSelections: normalizedOverrides.acceptedOptionSelections,
    recipePricing,
    retainingWallContext,
  });
  synchronizeQuotePricingFromCommercialBreakdown(quoteWithCommercial);
  const combinedPricingIssues = dedupeBy(
    [
      ...(quote.pricing?.issues || []),
      ...(quoteWithCommercial.internalPricing?.pricingIssues || []),
    ],
    (issue) => `${issue.code || ""}::${issue.reason || ""}`
  );
  const combinedReviewReasons = dedupe([
    ...(quote.review?.reasons || []),
    ...combinedPricingIssues.map((issue) => issue.message),
  ]);
  const combinedReviewStatus = combinedReviewReasons.length > 0 ? "manual_review" : "ready";
  quoteWithCommercial.pricing = {
    ...(quoteWithCommercial.pricing || {}),
    issues: combinedPricingIssues,
    ready: combinedPricingIssues.length === 0,
  };
  quoteWithCommercial.review = {
    ...(quoteWithCommercial.review || {}),
    status: combinedReviewStatus,
    reasons: combinedReviewReasons,
  };
  quoteWithCommercial.status = combinedReviewStatus;

  const scenarioQuote = applyScenarioStateToQuote({
    quote: quoteWithCommercial,
    lineItems: pricingLineItems,
    quoteCatalog: quoteCatalog,
    quoteInputs,
    details,
    assumptionOverrides: normalizedOverrides.assumptions,
    executionOverrides: normalizedOverrides.execution,
  });
  warnOnQuoteChargeDrift(scenarioQuote);

  return applyPresentationToQuote({
    quote: scenarioQuote,
    quoteInputs,
    overrides: normalizedOverrides,
    defaultScopeText: quoteInputs.summary || scenarioQuote.summary || null,
    preferDefaultScopeText: false,
  });
}

function describeCommercialAuthority(provider) {
  if (isPriceCatalogAuthorityProvider(provider)) return "Price catalog";
  const normalized = normalizeCommercialAuthorityProvider(provider);
  if (normalized === "external_authority" || normalized.startsWith("external_")) return "external authority";
  return "catalog";
}

export function generateEvidenceQuoteMarkdown({ meta, quote }) {
  const currency = quote?.totals?.currency || "AUD";
  const quoteCatalog = quote?.quoteCatalog || quote?.profile || {};
  const customerScheduleItems = getCustomerScheduleItems(quote);
  const lines = [];
  const title = quote?.delivery?.status === "final" ? "Quote" : "Quote Draft";

  lines.push(`# ${title} — ${meta.title || meta.label || "Untitled recording"}`);
  lines.push("");
  if (quote.quoteNumber || quote.jobNumber) {
    lines.push(`*Quote number: ${quote.quoteNumber || "pending"} · Job number: ${quote.jobNumber || "pending"}*`);
    lines.push("");
  }
  lines.push(`*Version v${String(quote.version || 1).padStart(3, "0")} · generated ${formatIso(quote.generatedAt)} · intent: ${quote.recordingIntent} · review: ${quote.review?.status || quote.status} · delivery: ${quote.delivery?.status || "draft"}*`);
  lines.push("");

  if (quote.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(quote.summary);
    lines.push("");
  }

  lines.push("## Totals");
  lines.push("");
  lines.push(`- Subtotal: ${formatMoney(quote.totals.subtotal, currency)}`);
  lines.push(`- GST: ${formatMoney(quote.totals.gst, currency)}`);
  lines.push(`- Total: ${formatMoney(quote.totals.total, currency)}`);
  if (quote.totals?._note) {
    lines.push(`- Note: ${quote.totals._note}`);
  }
  lines.push("");

  if (quote.execution?.totals) {
    lines.push("## Execution Summary");
    lines.push("");
    lines.push(`- Billable labour: ${formatExecutionHours(quote.execution.totals.labourHours)}`);
    lines.push(`- Billable machine: ${formatExecutionHours(quote.execution.totals.machineHours)}`);
    lines.push(`- Expected duration: ${formatExecutionHours(quote.execution.totals.durationHours)} (${formatExecutionDays(quote.execution.totals.workingDays)} at ${quote.execution.workingDayHours || 8} hours/day)`);
    lines.push(`- Access profile: ${quote.execution.accessProfile?.label || "Standard access"}`);
    if (quote.execution.parameters?.travelHoursPerDay != null) {
      lines.push(`- Daily overhead: ${formatExecutionHours(quote.execution.parameters.travelHoursPerDay)} per site day`);
    }
    if (quote.execution.parameters?.dumpDriveMinutes != null && quote.execution.stages?.some((stage) => stage.code === "haulage")) {
      lines.push(`- Dump drive: ${quote.execution.parameters.dumpDriveMinutes} minutes one-way`);
    }
    if (quote.execution.overrides?.note) {
      lines.push(`- Operator note: ${quote.execution.overrides.note}`);
    }
    lines.push("");

    if (quote.execution.stages?.length) {
      lines.push("### Execution Stages");
      lines.push("");
      for (const stage of quote.execution.stages) {
        const itemSummary = stage.items?.length ? ` · ${stage.items.join(", ")}` : "";
        lines.push(`- ${stage.label}: ${formatExecutionHours(stage.durationHours)}${itemSummary}`);
      }
      lines.push("");
    }
  }

  if (customerScheduleItems.length) {
    lines.push("## Pricing Schedule");
    lines.push("");
    let currentSection = null;
    for (const item of customerScheduleItems) {
      if (item.section && item.section !== currentSection) {
        currentSection = item.section;
        lines.push(`### ${item.section}`);
        lines.push("");
      }
      lines.push(`- ${item.label}: ${formatMoney(item.totalPrice, currency)}`);
    }
    lines.push("");
  }

  if (quote.lineItems?.length) {
    lines.push("## Internal Pricing Breakdown");
    lines.push("");
    for (const item of quote.lineItems) {
      lines.push(`### ${item.label}`);
      lines.push("");
      lines.push(`- Quantity: ${formatQty(item.quantity)} ${formatCatalogUnit(item.unit)}`);
      lines.push(`- Rate: ${formatMoney(item.unitPrice, currency)}`);
      lines.push(`- Total: ${formatMoney(item.totalPrice, currency)}`);
      if (item.rationale) lines.push(`- Rationale: ${formatCatalogUnitText(item.rationale)}`);
      if (item.manualOverride?.summary) lines.push(`- Override: ${formatCatalogUnitText(item.manualOverride.summary)}`);
      if (item.quoteCatalogEntry?.label || item.pricingReference?.title) lines.push(`- Quote catalog entry: ${item.quoteCatalogEntry?.label || item.pricingReference?.title}`);
      if (quoteCatalog?.referenceUrl || item.pricingReference?.documentUrl) lines.push(`- Quote catalog reference: ${quoteCatalog.referenceUrl || item.pricingReference?.documentUrl}`);
      if (item.evidenceSummary?.length) {
        lines.push("- Evidence:");
        for (const evidence of item.evidenceSummary) {
          lines.push(`  - ${formatCatalogUnitText(evidence)}`);
        }
      }
      lines.push("");
    }
  }

  if (quote.materialOrders?.length) {
    lines.push("## Material Orders");
    lines.push("");
    for (const order of quote.materialOrders) {
      lines.push(`### ${order.label || order.itemCode}`);
      lines.push("");
      lines.push(`- Quantity: ${formatQty(order.quantity)} ${formatCatalogUnit(order.unit)}`);
      if (order.section) lines.push(`- Section: ${order.section}`);
      if (order.sourceLineItemCode) lines.push(`- Source line item: ${order.sourceLineItemCode}`);
      if (order.unitCost != null) lines.push(`- Cost/Unit: ${formatMoney(order.unitCost, currency)}`);
      if (order.unitPrice != null) lines.push(`- Charge/Unit: ${formatMoney(order.unitPrice, currency)}`);
      if (order.description) lines.push(`- Description: ${formatCatalogUnitText(order.description)}`);
      lines.push("");
    }
  }

  if (quote.assumptionInputs?.length) {
    lines.push("## Pricing Assumptions Used");
    lines.push("");
    for (const item of quote.assumptionInputs) {
      lines.push(`- ${item.field}: ${formatCatalogUnitText(item.value)} (${describeAssumptionSourceLabel(item.source)})`);
      if (item.quoteNote) {
        lines.push(`  - ${formatCatalogUnitText(item.quoteNote)}`);
      }
    }
    lines.push("");
  }

  if (quote.moasure?.imports?.length) {
    lines.push("## Moasure Inputs");
    lines.push("");
    for (const item of quote.moasure.imports) {
      lines.push(`### ${item.label}`);
      lines.push("");
      lines.push(`- Batch: ${item.batchId}`);
      lines.push(`- Perimeter: ${formatMeasurement(item.perimeter, "m")}`);
      if (item.area != null) lines.push(`- Area: ${formatMeasurement(item.area, "m2")}`);
      if (item.elevationRange != null) lines.push(`- Elevation range: ${formatMeasurement(item.elevationRange, "m")}`);
      lines.push(`- Boundary points: ${item.boundaryPointCount}`);
      lines.push(`- Total points: ${item.totalPointCount}`);
      lines.push("");
    }
  }

  if (quote.processReferences?.length) {
    lines.push("## Process References");
    lines.push("");
    for (const reference of quote.processReferences) {
      lines.push(`- ${reference.label}: ${formatCatalogUnitText(reference.detail)}`);
      for (const evidence of reference.evidenceSummary || []) {
        lines.push(`  - ${formatCatalogUnitText(evidence)}`);
      }
    }
    lines.push("");
  }

  if (quote.siteConstraints?.length) {
    lines.push("## Site Constraints");
    lines.push("");
    for (const constraint of quote.siteConstraints) {
      lines.push(`- ${constraint.label}: ${formatCatalogUnitText(constraint.detail)}`);
      for (const evidence of constraint.evidenceSummary || []) {
        lines.push(`  - ${formatCatalogUnitText(evidence)}`);
      }
    }
    lines.push("");
  }

  if (quote.missingInputs?.length) {
    lines.push("## Outstanding Inputs");
    lines.push("");
    for (const item of quote.missingInputs) {
      lines.push(`- ${formatCatalogUnitText(item)}`);
    }
    lines.push("");
  }

  if (quote.review?.reasons?.length) {
    lines.push("## Review Flags");
    lines.push("");
    for (const reason of quote.review.reasons) {
      lines.push(`- ${formatCatalogUnitText(reason)}`);
    }
    lines.push("");
  }

  if (quote.assumptions?.length) {
    lines.push("## Internal Assumptions");
    lines.push("");
    for (const assumption of quote.assumptions) {
      lines.push(`- ${formatCatalogUnitText(assumption)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function normalizeOverrides(overrides) {
  const normalized = {
    lineItems: {},
    commercialAdjustments: [],
    assumptions: {},
    presentation: null,
    execution: null,
    optionSelections: {},
    acceptedOptionSelections: {},
    delivery: {
      status: "draft",
      finalizedAt: null,
    },
  };

  if (!overrides || typeof overrides !== "object") return normalized;

  if (overrides.execution && typeof overrides.execution === "object") {
    const ex = overrides.execution;
    normalized.execution = {
      accessProfile: typeof ex.accessProfile === "string" ? ex.accessProfile.trim() : null,
      labourHours: Number.isFinite(Number(ex.labourHours)) ? Number(ex.labourHours) : null,
      machineHours: Number.isFinite(Number(ex.machineHours)) ? Number(ex.machineHours) : null,
      dumpDriveMinutes: Number.isFinite(Number(ex.dumpDriveMinutes)) ? Number(ex.dumpDriveMinutes) : null,
      travelHoursPerDay: Number.isFinite(Number(ex.travelHoursPerDay)) ? Number(ex.travelHoursPerDay) : null,
      note: typeof ex.note === "string" ? ex.note.trim() : null,
    };
  }

  if (overrides.lineItems && typeof overrides.lineItems === "object") {
    for (const [code, value] of Object.entries(overrides.lineItems)) {
      if (!value || typeof value !== "object") continue;
      normalized.lineItems[code] = {
        label: typeof value.label === "string" ? value.label.trim() : null,
        quantity: Number.isFinite(Number(value.quantity)) ? Number(value.quantity) : null,
        notes: typeof value.notes === "string" ? value.notes.trim() : null,
        reviewState: normalizeOverrideReviewState(value.reviewState),
      };
    }
  }

  normalized.commercialAdjustments = mergeCommercialAdjustments(
    liftLegacyLineItemRateAdjustments(overrides.lineItems),
    normalizeCommercialAdjustments(overrides.commercialAdjustments)
  );

  if (overrides.assumptions && typeof overrides.assumptions === "object") {
    for (const [field, value] of Object.entries(overrides.assumptions)) {
      if (!value || typeof value !== "object") continue;
      normalized.assumptions[field] = {
        value: typeof value.value === "string" ? value.value.trim() : "",
        note: typeof value.note === "string" ? value.note.trim() : null,
        reviewState: normalizeOverrideReviewState(value.reviewState),
      };
    }
  }

  normalized.presentation = normalizePresentationOverrides(overrides.presentation);

  if (overrides.optionSelections && typeof overrides.optionSelections === "object") {
    for (const [familyId, value] of Object.entries(overrides.optionSelections)) {
      const nextValue = String(value || "").trim();
      if (!nextValue) continue;
      normalized.optionSelections[String(familyId || "").trim()] = nextValue;
    }
  }

  if (overrides.acceptedOptionSelections && typeof overrides.acceptedOptionSelections === "object") {
    for (const [familyId, value] of Object.entries(overrides.acceptedOptionSelections)) {
      const nextValue = String(value || "").trim();
      if (!nextValue) continue;
      normalized.acceptedOptionSelections[String(familyId || "").trim()] = nextValue;
    }
  }

  const requestedStatus = overrides.lockStatus || overrides.deliveryStatus || overrides.delivery?.status;
  if (requestedStatus === "final") {
    normalized.delivery.status = "final";
    normalized.delivery.finalizedAt = overrides.delivery?.finalizedAt || overrides.finalizedAt || new Date().toISOString();
  }

  return normalized;
}

function applyScenarioStateToQuote({
  quote,
  lineItems,
  quoteCatalog,
  quoteInputs,
  details,
  assumptionOverrides,
  executionOverrides,
}) {
  if (!quote?.selectionState?.hasOptionFamilies) return quote;

  const scenarioMatrix = buildScenarioMatrix({
    quote,
    lineItems,
    quoteCatalog,
    quoteInputs,
    details,
    assumptionOverrides,
    executionOverrides,
  });
  const scenarios = scenarioMatrix.scenarios;
  const activeScenario = scenarios.find((scenario) => scenario.id === quote.selectionState.activeScenarioId) || scenarios[0] || null;
  const defaultScenario = scenarios.find((scenario) => scenario.id === quote.selectionState.defaultScenarioId) || activeScenario;
  const displayScenario = scenarios.find((scenario) => scenario.id === quote.selectionState.displayScenarioId) || defaultScenario;
  const acceptedScenario = quote.selectionState.acceptedScenarioId
    ? (scenarios.find((scenario) => scenario.id === quote.selectionState.acceptedScenarioId) || null)
    : null;

  return {
    ...quote,
    execution: activeScenario?.execution || quote.execution,
    totals: activeScenario
      ? {
          ...quote.totals,
          subtotal: activeScenario.subtotal,
          gst: activeScenario.gst,
          total: activeScenario.total,
          _note: buildScenarioTotalsNote({
            scenario: activeScenario,
            handoffReady: quote.selectionState.handoffReady,
          }),
        }
      : quote.totals,
    selectionState: {
      ...quote.selectionState,
      defaultScenarioId: defaultScenario?.id || quote.selectionState.defaultScenarioId,
      displayScenarioId: displayScenario?.id || quote.selectionState.displayScenarioId,
      acceptedScenarioId: acceptedScenario?.id || quote.selectionState.acceptedScenarioId,
      activeScenarioId: activeScenario?.id || quote.selectionState.activeScenarioId,
      scenarioMatrixMode: scenarioMatrix.mode,
      scenarioSummaries: scenarios.map((scenario) => ({
        id: scenario.id,
        label: scenario.label,
        subtotal: scenario.subtotal,
        gst: scenario.gst,
        total: scenario.total,
        durationHours: scenario.execution?.totals?.durationHours ?? null,
        workingDays: scenario.execution?.totals?.workingDays ?? null,
        labourHours: scenario.execution?.totals?.labourHours ?? null,
        machineHours: scenario.execution?.totals?.machineHours ?? null,
        selections: scenario.selections,
        isDefault: scenario.id === defaultScenario?.id,
        isDisplay: scenario.id === displayScenario?.id,
        isAccepted: scenario.id === acceptedScenario?.id,
        isActive: scenario.id === activeScenario?.id,
      })),
      activeScenarioSummary: activeScenario
        ? {
            id: activeScenario.id,
            label: activeScenario.label,
            subtotal: activeScenario.subtotal,
            gst: activeScenario.gst,
            total: activeScenario.total,
            durationHours: activeScenario.execution?.totals?.durationHours ?? null,
            workingDays: activeScenario.execution?.totals?.workingDays ?? null,
          }
        : null,
    },
  };
}

// Exported for direct unit testing only (DEL-46, round 7): the fail-closed
// omission of an unpriced support rule is currently unreachable through the
// public generateEvidenceQuote() surface (both catalogues price every
// support rule), so its pricing-issue signal is tested against a
// synthetic quoteCatalog here rather than end-to-end.
export function ensureCommercialSupportLineItems({
  lineItems = [],
  quoteCatalog,
  quoteCatalogReferenceUrl,
  lineItemOverrides = {},
}) {
  if (!quoteCatalog || !lineItems.length) return { lineItems, pricingIssues: [] };

  // Only inject support items when there are real scoped line items from the engine,
  // not when the quote is empty or only has manually-overridden items.
  const hasRealScopedItems = lineItems.some((item) =>
    item.confidence > 0.3 || (item.code && !item.code.startsWith("misc-site-works"))
  );
  if (!hasRealScopedItems) return { lineItems, pricingIssues: [] };

  // DEL-46 (P3, round 7): see the matching comment in
  // quote-execution-estimator.js's applyExecutionEstimateToLineItems — an
  // unpriced support rule is fail-closed-omitted (round 6) but must also
  // surface as a pricing issue, not disappear silently.
  const pricingIssues = [];
  let nextLineItems = [...lineItems];
  // The quote catalog names its support rules (site establishment, cleanup);
  // each is priced from its catalogue item like any other rule.
  for (const code of quoteCatalog.supportRuleCodes || []) {
    nextLineItems = upsertFixedSupportLineItem({
      lineItems: nextLineItems,
      quoteCatalog,
      quoteCatalogReferenceUrl,
      code,
      lineItemOverrides,
      pricingIssues,
    });
  }
  return { lineItems: nextLineItems, pricingIssues };
}

function upsertFixedSupportLineItem({
  lineItems,
  quoteCatalog,
  quoteCatalogReferenceUrl,
  code,
  lineItemOverrides = {},
  pricingIssues,
}) {
  const existingIndex = lineItems.findIndex((item) => (
    extractBaseRuleCode(item?.quoteCatalogItemCode || item?.code) === code
  ));
  if (existingIndex >= 0) return lineItems;

  const override = lineItemOverrides?.[code] || null;
  if (override?.reviewState?.excluded) return lineItems;
  if (Number.isFinite(override?.quantity) && override.quantity <= 0) return lineItems;

  const rule = resolveQuoteCatalogRule(quoteCatalog, code);
  if (!rule) return lineItems;
  // The rate is the price catalogue's only (the quote catalog carries none).
  // This support line item is injected after buildLineItems's pricing-issue
  // machinery has already run and goes straight into pricingLineItems/subtotal
  // with no not-quoteable check of its own, so an unpriced rule must not reach
  // here — that would silently add a real $0 line to the quote. Record the
  // omission as a pricing issue (DEL-46, round 7) so a missing rate is
  // reported, not silent.
  const defaultSellRate = rule.priceCatalog?.sellPrice != null
    ? Number(rule.priceCatalog.sellPrice)
    : rule.authorityPricing?.sellingRate != null
      ? Number(rule.authorityPricing.sellingRate)
      : null;
  if (!(Number(defaultSellRate) > 0)) {
    const unitMismatch = rule.authorityPricing?.unitMismatch || rule.priceCatalog?.unitMismatch || null;
    pricingIssues?.push({
      code: rule.code,
      label: rule.label,
      reason: unitMismatch
        ? `${unitMismatch.message} ${rule.label} could not be included as a support line item.`
        : `${rule.label} has no sell price set, so it could not be included as a support line item.`,
    });
    return lineItems;
  }

  const quantity = Number.isFinite(override?.quantity) && override.quantity > 0
    ? normalizeQuantity(override.quantity, rule.unit)
    : normalizeQuantity(rule.defaultQuantity || 1, rule.unit);
  if (!(quantity > 0)) return lineItems;

  const label = override?.label || formatPresentationLabel({ rule, quantity });
  const unitPrice = roundMoney(Number(defaultSellRate));
  const unitCost = rule?.authorityPricing?.buyingRate != null
    ? roundMoney(Number(rule.authorityPricing.buyingRate))
    : null;
  const manualOverride = summarizeManualOverride({
    override,
    defaultQuantity: rule.defaultQuantity || 1,
    defaultRate: defaultSellRate,
    defaultLabel: formatPresentationLabel({ rule, quantity }),
    unit: rule.unit,
    allowRateOverride: false,
    commercialAdjustment: null,
  });

  return [
    ...lineItems,
    {
      code,
      label,
      customerLabel: label,
      quoteCatalogItemCode: rule.code,
      quantity,
      unit: rule.unit,
      authorityUnitPrice: unitPrice,
      unitCost,
      unitPrice,
      totalPrice: roundMoney(quantity * unitPrice),
      totalCost: unitCost != null ? roundMoney(quantity * unitCost) : null,
      rationale: `Included as ${rule.label.toLowerCase()} for the scoped site work.`,
      confidence: 0.9,
      evidence: [],
      evidenceSummary: [],
      requiredInputs: [],
      assumptions: dedupe([
        manualOverride?.summary ? `Manual quote adjustment applied: ${manualOverride.summary}` : null,
      ]),
      usedDefaultQuantity: false,
      manualOverride,
      commercialAdjustment: null,
      provenance: [{
        sourceType: "ai-generated",
        actor: { kind: "system", label: "Field" },
        createdAt: new Date().toISOString(),
        summary: `Inserted ${rule.label.toLowerCase()} as a support line item for commercial pricing.`,
      }],
      section: normalizeSectionLabel(rule.presentation?.defaultSection || null),
      workDomain: rule.workDomain || null,
      customerVisible: resolveCustomerVisibility(rule),
      scopeSummary: buildScopeSummary({
        rule,
        quantity,
        fallbackLabel: label,
      }),
      quoteCatalogEntry: {
        code: rule.code,
        label: rule.label,
        quoteCatalogId: quoteCatalog.id,
        referenceUrl: quoteCatalogReferenceUrl,
        authorityItemCode: rule.priceCatalog?.code || rule.authorityItemCode || rule.authorityPricing?.itemCode || rule.code,
      },
    },
  ];
}

function synchronizeQuotePricingFromCommercialBreakdown(quote) {
  if (!quote || !Array.isArray(quote.lineItems)) return quote;

  const breakdowns = quote.internalPricing?.lineItemBreakdowns || [];
  for (const breakdown of breakdowns) {
    const lineItem = quote.lineItems.find((item) => item.code === breakdown?.sourceLineItemCode);
    if (!lineItem || breakdown?.totals?.charge == null) continue;

    const chargeTotal = roundMoney(breakdown.totals.charge);
    lineItem.totalPrice = chargeTotal;
    lineItem.unitPrice = lineItem.quantity > 0
      ? roundMoney(chargeTotal / lineItem.quantity)
      : chargeTotal;

    if (breakdown?.totals?.cost != null) {
      const costTotal = roundMoney(breakdown.totals.cost);
      lineItem.totalCost = costTotal;
      lineItem.unitCost = lineItem.quantity > 0
        ? roundMoney(costTotal / lineItem.quantity)
        : costTotal;
    }
  }

  const gstRate = quote.quoteCatalog?.gstRate ?? 0.1;
  const lineItemTotals = quote.lineItems.map((item) => item?.totalPrice);
  const subtotal = lineItemTotals.some((value) => value == null || !Number.isFinite(Number(value)))
    ? null
    : roundMoney(lineItemTotals.reduce((total, value) => total + Number(value), 0));
  const gst = subtotal == null ? null : taxOnSubtotal(subtotal, gstRate);
  const nextTotals = {
    ...(quote.totals || {}),
    subtotal,
    gst,
    total: subtotal == null || gst == null ? null : roundMoney(subtotal + gst),
  };
  delete nextTotals._preCompilation;
  quote.totals = nextTotals;
  return quote;
}

function warnOnQuoteChargeDrift(quote) {
  const chargeTotal = roundMoney(quote?.internalPricing?.totals?.charge || 0);
  if (!(chargeTotal > 0)) return;

  const hasOptionFamilies = quote?.selectionState?.hasOptionFamilies === true;
  const lineItemTotal = hasOptionFamilies
    ? roundMoney(quote?.totals?.subtotal || 0)
    : roundMoney(
        (quote?.lineItems || []).reduce((sum, item) => sum + Number(item?.totalPrice || 0), 0)
      );

  if (Math.abs(chargeTotal - lineItemTotal) > 1) {
    console.warn(
      `[generate-evidence-quote] charge/lineItem drift: charge=${chargeTotal} lineItems=${lineItemTotal}`
    );
  }
}

function buildScenarioMatrix({
  quote,
  lineItems,
  quoteCatalog,
  quoteInputs,
  details,
  assumptionOverrides,
  executionOverrides,
}) {
  const families = Array.isArray(quote?.selectionState?.optionFamilies) ? quote.selectionState.optionFamilies : [];
  if (!families.length) {
    return {
      mode: "none",
      scenarios: [],
    };
  }

  const optionCodes = new Set(
    families.flatMap((family) => (family.options || []).map((option) => option.sourceLineItemCode)).filter(Boolean)
  );
  const fixedLineItems = (lineItems || []).filter((item) => !optionCodes.has(item.code));
  const scenarios = [];
  const maxScenarios = 24;
  const combinations = enumerateScenarioSelections(families, maxScenarios);

  for (const selections of combinations.selections) {
    const selectedCodes = new Set(selections.map((selection) => selection.optionCode).filter(Boolean));
    const scenarioLineItems = [
      ...fixedLineItems,
      ...(lineItems || []).filter((item) => selectedCodes.has(item.code)),
    ];
    const execution = estimateQuoteExecution({
      lineItems: scenarioLineItems,
      quoteCatalog,
      quoteInputs,
      details,
      assumptionOverrides,
      executionOverrides,
    });
    const scenarioTotals = scenarioLineItems.map((item) => item?.totalPrice);
    const subtotal = scenarioTotals.some((value) => value == null || !Number.isFinite(Number(value)))
      ? null
      : roundMoney(scenarioTotals.reduce((sum, value) => sum + Number(value), 0));
    const gst = subtotal == null ? null : taxOnSubtotal(subtotal, Number(quote?.quoteCatalog?.gstRate || 0));
    scenarios.push({
      id: buildScenarioId(selections),
      label: selections.map((selection) => selection.optionLabel).filter(Boolean).join(" + "),
      selections,
      subtotal,
      gst,
      total: subtotal == null || gst == null ? null : roundMoney(subtotal + gst),
      execution,
    });
  }

  return {
    mode: combinations.truncated ? "capped" : "complete",
    scenarios,
  };
}

function enumerateScenarioSelections(families, maxScenarios) {
  const orderedFamilies = families.map((family) => ({
    ...family,
    options: orderScenarioFamilyOptions(family),
  }));
  const selections = [];

  function visit(index, current) {
    if (selections.length >= maxScenarios) return;
    if (index >= orderedFamilies.length) {
      selections.push(current);
      return;
    }

    const family = orderedFamilies[index];
    for (const option of family.options || []) {
      if (selections.length >= maxScenarios) return;
      visit(index + 1, [
        ...current,
        {
          familyId: family.id,
          familyLabel: family.label,
          optionCode: option.sourceLineItemCode,
          optionLabel: option.sourceLineItemLabel,
        },
      ]);
    }
  }

  visit(0, []);
  const totalPossible = orderedFamilies.reduce((product, family) => product * Math.max(1, family.options?.length || 0), 1);
  return {
    selections,
    truncated: totalPossible > selections.length,
  };
}

function orderScenarioFamilyOptions(family) {
  const options = Array.isArray(family?.options) ? [...family.options] : [];
  return options.sort((left, right) => {
    if (left.sourceLineItemCode === family.defaultOptionCode) return -1;
    if (right.sourceLineItemCode === family.defaultOptionCode) return 1;
    return 0;
  });
}

function buildScenarioId(selections) {
  const parts = (selections || [])
    .map((selection) => `${selection.familyId}:${selection.optionCode}`)
    .filter((value) => !value.endsWith(":"));
  return parts.length ? parts.join("|") : "base";
}

function buildScenarioTotalsNote({ scenario, handoffReady }) {
  if (!scenario?.selections?.length) return null;
  const prefix = handoffReady
    ? "Total shown for accepted selections"
    : "Total shown for default selections";
  return `${prefix}: ${scenario.selections.map((selection) => `${selection.familyLabel}: ${selection.optionLabel}`).join(" · ")}`;
}

function normalizeOverrideReviewState(reviewState) {
  if (!reviewState || typeof reviewState !== "object") return null;
  return {
    excluded: reviewState.excluded === true,
    reason: typeof reviewState.reason === "string" ? reviewState.reason.trim() : null,
    at: typeof reviewState.at === "string" ? reviewState.at : null,
    by: reviewState.by && typeof reviewState.by === "object" && typeof reviewState.by.label === "string"
      ? {
          kind: typeof reviewState.by.kind === "string" ? reviewState.by.kind : "user",
          label: reviewState.by.label.trim() || "User",
        }
      : null,
    originCategory:
      reviewState.originCategory === "confirmed"
      || reviewState.originCategory === "assumed"
      || reviewState.originCategory === "gaps"
        ? reviewState.originCategory
        : null,
    detail: typeof reviewState.detail === "string" ? reviewState.detail.trim() : null,
    relatedLineItems: Array.isArray(reviewState.relatedLineItems)
      ? dedupe(reviewState.relatedLineItems.map((item) => String(item || "").trim()).filter(Boolean))
      : [],
  };
}

function buildDeliveryState(deliveryOverride, version) {
  return {
    status: deliveryOverride?.status === "final" ? "final" : "draft",
    finalizedAt: deliveryOverride?.status === "final" ? (deliveryOverride.finalizedAt || new Date().toISOString()) : null,
    label: deliveryOverride?.status === "final" ? "Quote" : "Quote Draft",
    versionLabel: `v${String(version).padStart(3, "0")}`,
  };
}

function buildLineItems({
  quoteInputs,
  quoteCatalog,
  quoteCatalogReferenceUrl,
  lineItemOverrides,
  commercialAdjustments,
  assumptionOverrides,
  moasureSummary,
  details,
  breakdownSource,
}) {
  const groups = new Map();
  const pricingIssues = [];
  const authorityProvider = normalizeCommercialAuthorityProvider(
    quoteCatalog?.commercialAuthority?.provider || "catalog"
  );
  const erpAuthorityActive = authorityProvider !== "catalog";
  const excludedAssumptionKeys = new Set(
    Object.entries(assumptionOverrides || {})
      .filter(([, value]) => value?.reviewState?.excluded)
      .map(([field]) => normalizeField(field))
      .filter(Boolean)
  );

  for (const candidate of quoteInputs.lineItemCandidates || []) {
    const ruleCode = candidate.quoteCatalogItemCode || candidate.pricingReferenceId || candidate.priceListItemCode;
    const rule = resolveQuoteCatalogRule(quoteCatalog, ruleCode);
    if (!rule) {
      pricingIssues.push(buildPricingIssue({
        code: ruleCode,
        label: candidate.label || candidate.description || ruleCode,
        reason: "No matching quote-catalog rule exists for the extracted item.",
      }));
      continue;
    }

    const section = normalizeSectionLabel(candidate.section || rule.presentation?.defaultSection || null);
    // Option candidates (in "select one" sections) with their own code get
    // individual group keys so they produce separate line items instead of
    // merging with siblings that share the same quote-catalog rule.
    const useOptionKey = candidate.code && /select one/i.test(section || "");
    const groupKey = useOptionKey
      ? candidate.code
      : buildLineItemGroupKey({
          ruleCode: rule.code,
          section,
        });

    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({
      candidate: {
        ...candidate,
        section,
      },
      rule,
    });
  }

  applyDefaultRuleBundles({ groups, quoteInputs, quoteCatalog });
  applyQuoteCatalogQuantityRules({
    groups,
    quoteCatalog,
    moasureSummary,
    measurements: quoteInputs.measurements || [],
    details,
    breakdownSource,
    groupUtils: {
      buildLineItemGroupKey,
      findGroupKeysByRuleCode,
      normalizeSectionLabel,
      extractSectionLabelFromGroupKey,
      resolveDerivedSectionLabel,
    },
  });

  // Inject overrides for items not already in groups (newly added items)
  for (const [code, override] of Object.entries(lineItemOverrides)) {
    const baseRuleCode = resolveQuoteCatalogRuleCode(quoteCatalog, extractBaseRuleCode(code));
    if (groups.has(code)) continue;
    if (code === baseRuleCode && findGroupKeysByRuleCode(groups, baseRuleCode).length > 0) continue;
    if (!Number.isFinite(override?.quantity) || override.quantity <= 0) continue;
    const rule = resolveQuoteCatalogRule(quoteCatalog, baseRuleCode);
    if (!rule) continue;
    const section = normalizeSectionLabel(
      extractSectionLabelFromGroupKey(code) || rule.presentation?.defaultSection || null
    );
    groups.set(code, [{
      rule,
      candidate: {
        label: override.label || rule.label,
        description: "Manually added via quote editor.",
        quoteCatalogItemCode: rule.code,
        quantity: override.quantity,
        unit: rule.unit,
        confidence: 1.0,
        rationale: "Manually added via quote editor.",
        evidence: [],
        section,
      },
    }]);
  }

  const lineItems = [...groups.entries()].map(([groupKey, entries]) => {
    const rule = entries[0].rule;
    const inactiveCatalogComponents = getInactiveRuleCatalogComponents(rule);
    if (inactiveCatalogComponents.length > 0) {
      throw buildInactiveCatalogDependencyError(rule, inactiveCatalogComponents);
    }
    // A candidate stated in another unit counts when the catalogue converts
    // it to the rule's unit (rule.unitConversions); otherwise it is set
    // aside, never relabelled.
    const explicitQuantities = entries
      .filter(({ candidate }) => Number.isFinite(candidate.quantity) && candidate.quantity > 0)
      .map(({ candidate }) => candidateQuantityInRuleUnit(candidate, rule))
      .filter((value) => value != null);
    const baseQuantity = explicitQuantities.length
      ? normalizeQuantity(explicitQuantities.reduce((sum, value) => sum + value, 0), rule.unit)
      : normalizeQuantity(rule.defaultQuantity || 1, rule.unit);
    const override = lineItemOverrides[groupKey]
      || (groupKey === rule.code ? lineItemOverrides[rule.code] : null)
      || null;
    if (override?.reviewState?.excluded) return null;
    const quantity = Number.isFinite(override?.quantity) && override.quantity >= 0
      ? normalizeQuantity(override.quantity, rule.unit)
      : baseQuantity;
    const candidatePricing = !Number.isFinite(override?.quantity)
      ? summarizeCandidatePricing(entries, quantity)
      : null;
    const section = resolveLineItemSection({ groupKey, entries, rule });
    const commercialAdjustment = findCommercialAdjustmentForLineItem(commercialAdjustments, {
      lineItemCode: groupKey,
      quoteCatalogItemCode: rule.code,
      section,
    });
    const authoritySellRate = rule.priceCatalog?.sellPrice != null
      ? Number(rule.priceCatalog.sellPrice)
      : rule.authorityPricing?.sellingRate != null
        ? Number(rule.authorityPricing.sellingRate)
        : null;
    // DEL-46 (P0, round 4; sentinel updated round 6; erp branch fixed round
    // 7): quote-catalogs.js's normalizeRule() now keeps a missing json5
    // unitPrice as null (round 6), and both branches here must apply the
    // same `> 0` threshold quote-catalogs.js's isRuleQuoteable() already
    // uses — not just an `!= null` check — so an authored-but-zero rate is
    // also rejected, not only an absent one. Round 6 only fixed the
    // non-erp (catalog-mode) branch below; the erp branch used `!= null`
    // alone, so an explicit catalog sell_price: 0 (which the API permits —
    // "zero or greater") passed straight through as a real $0 line with no
    // pricing issue, while the recipe path (buildBulkDisposalLine) and the
    // non-erp branch both already reject an authored zero. No mechanism
    // anywhere else in the codebase treats an authored 0 as a legitimate
    // free line either — quote-commercial-adjustments.js's manual override
    // path applies the identical `> 0` threshold — so there is no rule type
    // this should be relaxed for.
    // Only the price catalogue prices a rule; without it (provider
    // "catalog") there is no rate and the line is a pricing issue.
    const authorityUnitPrice = erpAuthorityActive
      ? (authoritySellRate != null && authoritySellRate > 0 ? roundMoney(authoritySellRate) : null)
      : null;
    const overrideUnitPrice = Number.isFinite(commercialAdjustment?.unitPrice) && commercialAdjustment.unitPrice > 0
      ? roundMoney(commercialAdjustment.unitPrice)
      : null;
    const overrideUnitCost = Number.isFinite(commercialAdjustment?.unitCost) && commercialAdjustment.unitCost >= 0
      ? roundMoney(commercialAdjustment.unitCost)
      : null;
    const requiresDerivedPricing = entries.some(({ candidate }) => candidate._requiresDerivedPricing === true);
    const derivedPricingIssueReason = dedupe(
      entries.map(({ candidate }) => String(candidate._pricingIssueReason || "").trim()).filter(Boolean)
    )[0] || null;
    const derivedPricingIssueCode = dedupe(
      entries.map(({ candidate }) => String(candidate._pricingIssueCode || "").trim()).filter(Boolean)
    )[0] || rule.code;
    // DEL-46 (P0, round 4): this must not be gated behind erpAuthorityActive.
    // Disposal rules carry no json5 unitPrice by design (criterion 4) — a
    // disposal rule quoted directly (not through the bulk_loading_disposal
    // recipe) in catalog-only mode used to reach the roundMoney(quantity *
    // Number(unitPrice || 0)) coercion below with unitPrice === undefined,
    // producing a real, undetected $0 line. Any rule with neither an
    // authority rate nor a json5 rate is a pricing issue in every mode.
    if (authorityUnitPrice == null && candidatePricing?.unitPrice == null && overrideUnitPrice == null) {
      const authorityLabel = describeCommercialAuthority(authorityProvider);
      pricingIssues.push(buildPricingIssue({
        code: rule.code,
        label: override?.label || rule.label,
        reason: rule.authorityPricing?.unitMismatch
          ? `${rule.authorityPricing.unitMismatch.message} Fix the item's unit or add a conversion in the price catalogue.`
          : rule.authorityPricing?.missingItem
            ? `${authorityLabel} item ${rule.priceCatalog?.code || rule.authorityItemCode || rule.authorityPricing?.itemCode || rule.code} is missing or disabled.`
            : `${authorityLabel} selling rate is missing for ${rule.priceCatalog?.code || rule.authorityItemCode || rule.authorityPricing?.itemCode || rule.code}.`,
      }));
      return null;
    }
    if (requiresDerivedPricing && candidatePricing?.unitPrice == null && overrideUnitPrice == null) {
      pricingIssues.push(buildPricingIssue({
        code: derivedPricingIssueCode,
        label: override?.label || rule.label,
        reason: derivedPricingIssueReason || "Derived pricing inputs are incomplete for this line item.",
      }));
      return null;
    }
    const unitPrice = overrideUnitPrice != null
      ? overrideUnitPrice
      : (candidatePricing?.unitPrice ?? (requiresDerivedPricing ? null : authorityUnitPrice));
    const usedDefaultQuantity = explicitQuantities.length === 0 && !(Number.isFinite(override?.quantity) && override.quantity >= 0);
    const evidence = dedupeEvidence(entries.flatMap(({ candidate }) => candidate.evidence || []));
    const evidenceSummary = evidence.map((entry) => `[${formatTime(entry.start)}] ${entry.speaker}: ${entry.snippet}`);
    const rationale = dedupe(entries.map(({ candidate }) => candidate.rationale).filter(Boolean)).join(" ");
    const requiredInputs = usedDefaultQuantity ? (rule.requiredInputs || []) : [];
    if (requiredInputs.some((field) => excludedAssumptionKeys.has(normalizeField(field)))) {
      return null;
    }
    const defaultLabel = formatPresentationLabel({ rule, quantity });
    const manualOverride = summarizeManualOverride({
      override,
      defaultQuantity: baseQuantity,
      defaultRate: authorityUnitPrice,
      defaultLabel,
      unit: rule.unit,
      allowRateOverride: authorityUnitPrice != null,
      commercialAdjustment,
    });
    const label = override?.label || defaultLabel;
    const earthworkInputs = summarizeEarthworkInputs(entries);
    const bulkRemovalInputs = summarizeBulkRemovalInputs(entries);
    const breakdownSourcePlan = summarizeBreakdownSourcePlan(entries);

    const provenance = buildLineItemProvenance({ entries, evidence, manualOverride, usedDefaultQuantity });

    return {
      code: groupKey,
      label,
      customerLabel: label,
      quoteCatalogItemCode: rule.code,
      quantity,
      unit: rule.unit,
      authorityUnitPrice,
      unitCost: overrideUnitCost != null
        ? overrideUnitCost
        : (candidatePricing?.unitCost ?? (rule.authorityPricing?.buyingRate != null ? roundMoney(Number(rule.authorityPricing.buyingRate)) : null)),
      unitPrice,
      totalPrice: candidatePricing?.totalPrice ?? (unitPrice == null ? null : roundMoney(quantity * unitPrice)),
      totalCost: overrideUnitCost != null
        ? roundMoney(quantity * overrideUnitCost)
        : (candidatePricing?.totalCost ?? (rule.authorityPricing?.buyingRate != null ? roundMoney(quantity * Number(rule.authorityPricing.buyingRate)) : null)),
      rationale: rationale || null,
      confidence: average(entries.map(({ candidate }) => candidate.confidence).filter((value) => Number.isFinite(value))),
      evidence,
      evidenceSummary,
      requiredInputs,
      assumptions: dedupe([
        usedDefaultQuantity ? `No explicit ${formatCatalogUnit(rule.unit)} quantity was extracted, so the default quantity of ${formatQty(rule.defaultQuantity)} ${formatCatalogUnit(rule.unit)} was used.` : null,
        manualOverride?.summary ? `Manual quote adjustment applied: ${manualOverride.summary}` : null,
      ]),
      usedDefaultQuantity,
      manualOverride,
      commercialAdjustment: commercialAdjustment ? { ...commercialAdjustment } : null,
      earthworkInputs,
      bulkRemovalInputs,
      breakdownSourcePlan,
      provenance,
      section,
      workDomain: rule.workDomain || null,
      customerVisible: resolveCustomerVisibility(rule),
      scopeSummary: buildScopeSummary({
        rule,
        quantity,
        fallbackLabel: label,
      }),
      quoteCatalogEntry: {
        code: rule.code,
        label: rule.label,
        quoteCatalogId: quoteCatalog.id,
        referenceUrl: quoteCatalogReferenceUrl,
        authorityItemCode: rule.priceCatalog?.code || rule.authorityItemCode || rule.authorityPricing?.itemCode || rule.code,
      },
    };
  }).filter((item) => item && item.quantity > 0);

  return {
    lineItems,
    pricingIssues: dedupeBy(pricingIssues, (issue) => `${issue.code || ""}::${issue.reason}`),
  };
}

function buildLineItemGroupKey({ ruleCode, section }) {
  const normalizedSection = normalizeSectionLabel(section);
  if (!normalizedSection) return ruleCode;
  return `${ruleCode}__section-${slugifyFragment(normalizedSection)}`;
}

function buildPricingIssue({ code, label, reason }) {
  return {
    code: code || null,
    label: label || code || "Unmapped scope",
    reason,
    message: `Commercial pricing unresolved for ${label || code || "quoted scope"}: ${reason}`,
  };
}

function getInactiveRuleCatalogComponents(rule) {
  const components = rule?.priceCatalog?.inactiveComponents;
  return Array.isArray(components) ? components : [];
}

function buildInactiveCatalogDependencyError(rule, inactiveComponents) {
  const itemCode = rule?.priceCatalog?.code || rule?.authorityItemCode || rule?.authorityPricing?.itemCode || rule?.code || "unknown item";
  const itemLabel = rule?.label || rule?.priceCatalog?.name || itemCode;
  const inactiveList = formatInactiveComponentDependencyList(inactiveComponents);
  const error = new Error(
    `Cannot build quote: ${itemLabel} (${itemCode}) contains inactive catalog item${inactiveComponents.length === 1 ? "" : "s"}: ${inactiveList}. Reactivate or replace the inactive item before rebuilding the quote.`
  );
  error.code = "inactive_catalog_component";
  error.inactiveComponents = inactiveComponents;
  error.itemCode = itemCode;
  return error;
}

function extractBaseRuleCode(code) {
  return String(code || "").split("__")[0] || String(code || "");
}

function extractSectionLabelFromGroupKey(code) {
  const match = String(code || "").match(/__section-([^_].*)$/);
  if (!match?.[1]) return null;
  return humanizeSlug(match[1]);
}

function findGroupKeysByRuleCode(groups, ruleCode) {
  return [...groups.keys()].filter((groupKey) => extractBaseRuleCode(groupKey) === ruleCode);
}

function resolveLineItemSection({ groupKey, entries, rule }) {
  return normalizeSectionLabel(
    entries.find(({ candidate }) => candidate.section)?.candidate?.section
    || extractSectionLabelFromGroupKey(groupKey)
    || rule.presentation?.defaultSection
    || null
  );
}

function summarizeCandidatePricing(entries, quantity) {
  const pricedEntries = (entries || []).filter(({ candidate }) => (
    Number.isFinite(Number(candidate?.totalPrice))
    || Number.isFinite(Number(candidate?.unitPrice))
    || Number.isFinite(Number(candidate?.totalCost))
    || Number.isFinite(Number(candidate?.unitCost))
  ));
  if (!pricedEntries.length || !(quantity > 0)) return null;

  const totalPrice = roundMoney(pricedEntries.reduce((sum, { candidate }) => {
    if (Number.isFinite(Number(candidate?.totalPrice))) return sum + Number(candidate.totalPrice);
    if (Number.isFinite(Number(candidate?.unitPrice)) && Number.isFinite(Number(candidate?.quantity))) {
      return sum + (Number(candidate.unitPrice) * Number(candidate.quantity));
    }
    return sum;
  }, 0));
  const totalCost = roundMoney(pricedEntries.reduce((sum, { candidate }) => {
    if (Number.isFinite(Number(candidate?.totalCost))) return sum + Number(candidate.totalCost);
    if (Number.isFinite(Number(candidate?.unitCost)) && Number.isFinite(Number(candidate?.quantity))) {
      return sum + (Number(candidate.unitCost) * Number(candidate.quantity));
    }
    return sum;
  }, 0));

  return {
    unitPrice: totalPrice > 0 ? roundMoney(totalPrice / quantity) : null,
    totalPrice: totalPrice > 0 ? totalPrice : null,
    unitCost: totalCost > 0 ? roundMoney(totalCost / quantity) : null,
    totalCost: totalCost > 0 ? totalCost : null,
  };
}

function summarizeEarthworkInputs(entries) {
  const toFinite = (value) => (
    value == null || value === ""
      ? null
      : (Number.isFinite(Number(value)) ? Number(value) : null)
  );
  const pickFirstFinite = (field) => {
    for (const { candidate } of entries || []) {
      const directValue = candidate?.[field];
      if (Number.isFinite(toFinite(directValue))) return toFinite(directValue);
      const nestedValue = candidate?.earthworkInputs?.[field];
      if (Number.isFinite(toFinite(nestedValue))) return toFinite(nestedValue);
    }
    return null;
  };

  const earthworkInputs = {
    sectionAreaM2: pickFirstFinite("sectionAreaM2"),
    cutAreaM2: pickFirstFinite("cutAreaM2"),
    fillAreaM2: pickFirstFinite("fillAreaM2"),
    cutDepthMm: pickFirstFinite("cutDepthMm"),
    fillDepthMm: pickFirstFinite("fillDepthMm"),
    cutVolumeM3: pickFirstFinite("cutVolumeM3"),
    fillVolumeM3: pickFirstFinite("fillVolumeM3"),
    levelMm: pickFirstFinite("levelMm"),
  };

  return Object.values(earthworkInputs).some((value) => Number.isFinite(value))
    ? earthworkInputs
    : null;
}

function summarizeBulkRemovalInputs(entries) {
  const toFinite = (value) => (
    value == null || value === ""
      ? null
      : (Number.isFinite(Number(value)) ? Number(value) : null)
  );
  const pickFirstFinite = (field) => {
    for (const { candidate } of entries || []) {
      const directValue = candidate?.[field];
      if (Number.isFinite(toFinite(directValue))) return toFinite(directValue);
      const nestedValue = candidate?.bulkRemovalInputs?.[field];
      if (Number.isFinite(toFinite(nestedValue))) return toFinite(nestedValue);
    }
    return null;
  };

  const bulkRemovalInputs = {
    grossCutVolumeM3: pickFirstFinite("grossCutVolumeM3"),
    fillVolumeM3: pickFirstFinite("fillVolumeM3"),
    netVolumeM3: pickFirstFinite("netVolumeM3"),
    disposalVolumeM3: pickFirstFinite("disposalVolumeM3"),
  };
  const noteFillImportRequired = (entries || []).some(({ candidate }) => (
    candidate?.noteFillImportRequired === true
    || candidate?.bulkRemovalInputs?.noteFillImportRequired === true
  ));

  return Object.values(bulkRemovalInputs).some((value) => Number.isFinite(value)) || noteFillImportRequired
    ? {
        ...bulkRemovalInputs,
        ...(noteFillImportRequired ? { noteFillImportRequired: true } : {}),
      }
    : null;
}

function summarizeBreakdownSourcePlan(entries) {
  for (const { candidate } of entries || []) {
    if (candidate?.breakdownSourcePlan && typeof candidate.breakdownSourcePlan === "object") {
      return {
        id: candidate.breakdownSourcePlan.id || null,
        soilSection: candidate.breakdownSourcePlan.soilSection || null,
        haulageSection: candidate.breakdownSourcePlan.haulageSection || null,
        measurements: candidate.breakdownSourcePlan.measurements || null,
        explicit: candidate.breakdownSourcePlan.explicit || null,
        chosen: candidate.breakdownSourcePlan.chosen || null,
      };
    }
  }
  return null;
}

function summarizeQuoteBreakdownSource(breakdownSource) {
  if (!breakdownSource || typeof breakdownSource !== "object") return null;
  return {
    kind: breakdownSource.kind || "quote-breakdown-source",
    version: breakdownSource.version || 1,
    generatedAt: breakdownSource.generatedAt || null,
    sectionCount: Array.isArray(breakdownSource.sections) ? breakdownSource.sections.length : 0,
    bulkRemovalPlanCount: Array.isArray(breakdownSource.quantityPlans?.bulkRemoval)
      ? breakdownSource.quantityPlans.bulkRemoval.length
      : 0,
  };
}

function normalizeSectionLabel(value) {
  const text = String(value || "").trim();
  return text || null;
}

function slugifyFragment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanizeSlug(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPresentationLabel({ rule, quantity }) {
  const presentation = rule.presentation || {};
  const baseLabel = presentation.scheduleLabel || rule.label;
  const quantitySuffix = formatPresentationQuantity({
    presentation,
    quantity,
  });
  return quantitySuffix ? `${baseLabel} (${quantitySuffix})` : baseLabel;
}

function buildScopeSummary({ rule, quantity, fallbackLabel }) {
  const template = rule.presentation?.summaryLabel;
  if (!template) return fallbackLabel;

  return template
    .replaceAll("{quantity}", formatQty(quantity))
    .replaceAll(
      "{unitSingular}",
      rule.presentation?.quantityLabelUnitSingular || formatPresentationUnitLabel(rule.unit)
    )
    .replaceAll(
      "{unitPlural}",
      rule.presentation?.quantityLabelUnitPlural || formatPresentationUnitLabel(rule.unit, { plural: true })
    );
}

function formatPresentationUnitLabel(unit, { plural = false } = {}) {
  const formatted = formatCatalogUnit(unit);
  if (!formatted) return "";
  if (!plural) return formatted;
  if (["m", "mm", "km", "m²", "m³"].includes(formatted)) return formatted;
  return `${formatted}s`;
}

function formatPresentationQuantity({ presentation, quantity }) {
  if (!presentation?.quantityLabelMode) return null;
  if (presentation.quantityLabelMode === "count_x") {
    return `${formatQty(quantity)}x`;
  }
  if (presentation.quantityLabelMode === "count_with_unit") {
    const numericQuantity = Number(quantity || 0);
    const isSingular = numericQuantity === 1;
    const unitLabel = isSingular
      ? (presentation.quantityLabelUnitSingular || "item")
      : (presentation.quantityLabelUnitPlural || `${presentation.quantityLabelUnitSingular || "item"}s`);
    return `${formatQty(quantity)} ${unitLabel}`;
  }
  return null;
}

function resolveCustomerVisibility(rule) {
  if (typeof rule.presentation?.customerVisible === "boolean") {
    return rule.presentation.customerVisible;
  }
  return !["site-establishment", "cleanup", "misc-site-works", "labourer-hour", "excavator-hour"].includes(rule.code);
}

function applyDefaultRuleBundles({ groups, quoteInputs, quoteCatalog }) {
  // Legacy auto-bundled commercial allowances caused authority drift.
  // Scope must now be explicit or live-authority-backed; do not inject placeholder lines.
}

function summarizeManualOverride({
  override,
  commercialAdjustment = null,
  defaultQuantity,
  defaultRate,
  defaultLabel,
  unit,
  allowRateOverride = true,
}) {
  if (!override && !commercialAdjustment) return null;
  const safeOverride = override || {};
  const parts = [];
  if (safeOverride.label && safeOverride.label !== defaultLabel) {
    parts.push(`label changed to ${safeOverride.label}`);
  }
  if (
    Number.isFinite(safeOverride.quantity)
    && safeOverride.quantity > 0
    && roundMoney(safeOverride.quantity) !== roundMoney(defaultQuantity)
  ) {
    parts.push(`quantity changed to ${formatQty(safeOverride.quantity)} ${unit}`);
  }
  if (
    allowRateOverride
    && Number.isFinite(commercialAdjustment?.unitPrice)
    && commercialAdjustment.unitPrice > 0
    && roundMoney(commercialAdjustment.unitPrice) !== roundMoney(defaultRate)
  ) {
    parts.push(`rate changed to ${formatMoney(commercialAdjustment.unitPrice, "AUD")}`);
  }
  if (
    Number.isFinite(commercialAdjustment?.unitCost)
    && commercialAdjustment.unitCost >= 0
  ) {
    parts.push(`cost overridden to ${formatMoney(commercialAdjustment.unitCost, "AUD")}`);
  }
  if (safeOverride.notes) {
    parts.push(safeOverride.notes);
  }
  if (commercialAdjustment?.notes && commercialAdjustment.notes !== safeOverride.notes) {
    parts.push(commercialAdjustment.notes);
  }
  if (!parts.length) return null;
  return { summary: parts.join(" · ") };
}

function buildAssumptionInputs({
  missingInputFields,
  quoteInputs,
  lineItems,
  quoteCatalog,
  assumptionOverrides,
  derivedAssumptions = [],
}) {
  const derivedByField = new Map(
    derivedAssumptions
      .map((item) => [normalizeField(item.field), item])
      .filter(([field]) => Boolean(field))
  );
  const fields = dedupe([
    ...missingInputFields,
    ...derivedAssumptions.map((item) => item.field),
  ]);

  return fields.map((field) => {
    const fieldKey = normalizeField(field);
    const sourceEntry = (quoteInputs.missingInputs || []).find((item) => normalizeField(item.field) === normalizeField(field));
    const spec = getMissingInputSpec(field, quoteCatalog);
    const override = Object.entries(assumptionOverrides).find(([key]) => normalizeField(key) === fieldKey)?.[1] || null;
    const derived = derivedByField.get(fieldKey) || null;
    if (override?.reviewState?.excluded) return null;
    const value = override?.value || derived?.value || spec.defaultValue;
    const relatedLineItems = dedupe([
      ...(derived?.relatedLineItems || []),
      ...lineItems
        .filter((item) => item.requiredInputs?.some((required) => normalizeField(required) === fieldKey))
        .map((item) => item.code),
    ]);

    return {
      field,
      reason: derived?.reason || sourceEntry?.reason || `Required to tighten pricing for ${field}.`,
      defaultValue: spec.defaultValue,
      value,
      source: override?.value ? "user" : (derived?.source || (derived ? "derived" : "default")),
      note: override?.note || null,
      quoteNote: override?.note || derived?.quoteNote || spec.quoteNote,
      inputType: spec.inputType || "text",
      affectsPricing: Boolean(derived?.affectsPricing ?? spec.affectsPricing),
      alternatives: Array.isArray(spec.alternatives) ? spec.alternatives : [],
      evidence: sourceEntry?.evidence || [],
      evidenceSummary: dedupe([
        ...(sourceEntry?.evidenceSummary || []),
        ...(derived?.evidenceSummary || []),
      ]),
      relatedLineItems,
    };
  }).filter(Boolean);
}

function getMissingInputSpec(field, quoteCatalog) {
  const entries = Object.entries(quoteCatalog.missingInputDefaults || {});
  const exact = entries.find(([candidate]) => normalizeField(candidate) === normalizeField(field));
  if (exact) return exact[1];
  return {
    inputType: "text",
    defaultValue: "Assume standard quote-catalog conditions until confirmed on site.",
    quoteNote: `This field has been priced using a standard placeholder assumption for ${field}.`,
    affectsPricing: true,
  };
}

function normalizeField(value) {
  return String(value || "").trim().toLowerCase();
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeBy(values, toKey) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = toKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function resolveDerivedSectionLabel({ groups, groupKeys }) {
  for (const groupKey of groupKeys || []) {
    const entries = groups.get(groupKey) || [];
    const section = normalizeSectionLabel(
      entries.find(({ candidate }) => candidate.section)?.candidate?.section
      || extractSectionLabelFromGroupKey(groupKey)
      || null
    );
    if (section) return section;
  }
  return null;
}

function buildLineItemProvenance({ entries, evidence, manualOverride, usedDefaultQuantity }) {
  const provenance = [];
  const now = new Date().toISOString();
  const isMeasurementDerived = entries.some(({ candidate }) => candidate._measurementDerived);

  if (isMeasurementDerived) {
    provenance.push({
      sourceType: "measurement",
      actor: { kind: "system", label: "Field" },
      createdAt: now,
      summary: "Derived from Moasure measurement data",
    });
  }

  if (evidence.length > 0) {
    const speakers = dedupe(evidence.map((e) => e.speaker).filter(Boolean));
    const segmentIds = dedupe(evidence.map((e) => e.segmentId).filter(Boolean)).slice(0, 6);
    provenance.push({
      sourceType: "audio",
      actor: { kind: "system", label: "Field" },
      createdAt: now,
      segmentIds,
      summary: `Extracted from ${evidence.length} audio snippet${evidence.length === 1 ? "" : "s"}${speakers.length ? ` (${speakers.join(", ")})` : ""}`,
    });
  }

  if (manualOverride) {
    provenance.push({
      sourceType: "manual",
      actor: { kind: "user", label: "User" },
      createdAt: now,
      summary: `Manual override: ${manualOverride.summary}`,
    });
  }

  if (!evidence.length && !manualOverride && !isMeasurementDerived) {
    provenance.push({
      sourceType: "ai-generated",
      actor: { kind: "system", label: "Field" },
      createdAt: now,
      summary: usedDefaultQuantity
        ? "Generated from quote-catalog defaults"
        : "AI-extracted from transcript context",
    });
  }

  return provenance;
}

function dedupeEvidence(values) {
  return dedupeBy(values, (value) => `${value.segmentId}:${value.start}:${value.end}`);
}

function average(values) {
  if (!values.length) return null;
  return Math.round(((values.reduce((sum, value) => sum + value, 0) / values.length) + Number.EPSILON) * 100) / 100;
}

function normalizeQuantity(quantity, unit) {
  if (!Number.isFinite(quantity) || quantity <= 0) return 1;
  return ["job", "load"].includes(unit) ? Math.max(1, Math.round(quantity)) : roundMoney(quantity);
}

/**
 * The candidate's quantity in the rule's unit, or null when its unit cannot
 * be converted (the line then falls back to its default quantity, as before).
 * A candidate without a unit is taken to be in the rule's unit.
 */
function candidateQuantityInRuleUnit(candidate, rule) {
  const quantity = Number(candidate.quantity);
  if (!candidate.unit) return quantity;
  const unit = normalizeCatalogUnit(candidate.unit, rule.unit);
  if (unit === rule.unit) return quantity;
  const conversions = rule.unitConversions || {};
  const factor = Object.hasOwn(conversions, unit) ? Number(conversions[unit]) : null;
  return Number.isFinite(factor) && factor > 0 ? quantity * factor : null;
}

function roundMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function formatMoney(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return "unavailable";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number(value));
}

function formatQty(value) {
  if (Number.isInteger(value)) return String(value);
  return Number(value || 0).toFixed(2).replace(/\.00$/, "");
}

function describeAssumptionSource(source) {
  if (source === "user") return "Updated input";
  if (source === "derived") return "Derived assumption";
  return "Default assumption";
}

function describeAssumptionSourceLabel(source) {
  if (source === "user") return "updated input";
  if (source === "derived") return "derived from scoped work";
  return "default assumption";
}

function formatExecutionHours(value) {
  const numeric = Number(value || 0);
  if (Number.isInteger(numeric)) return `${numeric}h`;
  return `${numeric.toFixed(1).replace(/\.0$/, "")}h`;
}

function formatExecutionDays(value) {
  const numeric = Number(value || 0);
  if (Number.isInteger(numeric)) return `${numeric} days`;
  return `${numeric.toFixed(1).replace(/\.0$/, "")} days`;
}

function formatIso(isoString) {
  if (!isoString) return "unknown time";
  return new Date(isoString).toLocaleString("en-AU", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "00:00";
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function summarizeMoasureForQuote(moasureSummary) {
  if (!moasureSummary?.imports?.length) return null;
  return {
    status: moasureSummary.status,
    batchCount: moasureSummary.batchCount,
    latestBatchId: moasureSummary.latestBatchId,
    imports: moasureSummary.imports.map((item) => ({
      label: item.label,
      batchId: item.batchId,
      perimeter: item.perimeter,
      area: item.area,
      elevationRange: item.elevationRange,
      boundaryPointCount: item.boundaryPointCount,
      totalPointCount: item.totalPointCount,
      csvFile: item.csvFile,
    })),
  };
}

function formatMeasurement(value, unit) {
  return value == null ? "unknown" : `${value} ${formatCatalogUnit(unit)}`;
}

const SHALLOW_DEPTH_MIN_AREA_M2 = 15;
const SHALLOW_DEPTH_THRESHOLD_M = 0.15;
const EXCAVATION_SECTION_PATTERN = /cut-back|retaining.wall|soil.out|cut.fill|level|excavat/i;

function buildShallowSoilDepthFlags({ lineItems, moasureSummary, quoteInputs }) {
  const flags = [];
  const soilItems = (lineItems || []).filter(
    (item) => item.quoteCatalogItemCode === "soil-removal" || item.code === "soil-removal"
  );
  if (!soilItems.length) return flags;

  for (const item of soilItems) {
    const volumeM3 = Number(item.quantity || 0);
    if (!(volumeM3 > 0)) continue;

    const areaM2 = resolveAreaForSoilSection({
      section: item.section || item.label,
      moasureSummary,
      measurements: quoteInputs?.measurements,
    });
    if (!(areaM2 >= SHALLOW_DEPTH_MIN_AREA_M2)) continue;

    const avgDepthM = volumeM3 / areaM2;
    if (avgDepthM >= SHALLOW_DEPTH_THRESHOLD_M) continue;

    const avgDepthCm = Math.round(avgDepthM * 100);
    const sectionLabel = item.section || item.label || "Soil removal";
    const impliesExcavation = EXCAVATION_SECTION_PATTERN.test(sectionLabel);
    const message = `Soil removal section '${sectionLabel}' has ${formatQty(areaM2)} m\u00B2 area but only ${formatQty(volumeM3)} m\u00B3 volume (avg depth ${avgDepthCm}cm). `
      + "This may be surface contour only \u2014 check if Cut/Fill depth from Moasure applies. "
      + "If excavation to a target level is intended, override the volume via the line item quantity.";
    const reviewReason = impliesExcavation
      ? `Shallow soil depth flag (${avgDepthCm}cm avg) on '${sectionLabel}' \u2014 section name implies excavation.`
      : `Shallow soil depth flag (${avgDepthCm}cm avg) on '${sectionLabel}'.`;

    flags.push({ message, reviewReason, section: sectionLabel, avgDepthCm, impliesExcavation });
  }
  return flags;
}

function resolveAreaForSoilSection({ section, moasureSummary, measurements }) {
  const sectionSlug = slugifySection(section);
  if (moasureSummary?.imports?.length) {
    for (const imp of moasureSummary.imports) {
      if (sectionSlug && slugifySection(imp.label) === sectionSlug && Number.isFinite(imp.area)) {
        return imp.area;
      }
    }
    for (const imp of moasureSummary.imports) {
      if (sectionSlug && slugifySection(imp.label)?.includes(sectionSlug) && Number.isFinite(imp.area)) {
        return imp.area;
      }
    }
  }
  if (Array.isArray(measurements)) {
    const normalizedSection = slugifySection(section);
    for (const entry of measurements) {
      const label = slugifySection(entry?.label || entry?.name || "");
      if (!label.includes("area")) continue;
      if (normalizedSection && !label.includes(normalizedSection)) continue;
      const unit = String(entry?.unit || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (unit !== "m2") continue;
      const val = Number(entry?.value);
      if (Number.isFinite(val)) return val;
    }
  }
  return null;
}

function slugifySection(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
