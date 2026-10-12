import { resolveQuoteCatalogRule } from "./quote-catalogs.js";
import { DEFAULT_SOIL_DUMP, haversineDistanceKm, estimateDrivingDistanceKm, estimateDriveMinutes } from "../shared/dumping.js";

const HOURLY_LABOUR_CODE = "labourer-hour";
const HOURLY_MACHINE_CODE = "excavator-hour";
const NON_SCOPE_CODES = new Set([
  HOURLY_LABOUR_CODE,
  HOURLY_MACHINE_CODE,
]);

const STAGE_META = {
  setup: { order: 10, label: "Mobilise and set out" },
  earthworks: { order: 20, label: "Excavate and shape" },
  drainage: { order: 30, label: "Install drainage" },
  structure: { order: 40, label: "Build the main structure" },
  haulage: { order: 50, label: "Run spoil haulage" },
  backfill: { order: 60, label: "Backfill and place imported material" },
  general: { order: 70, label: "Handle general site works" },
  cleanup: { order: 80, label: "Trim and clean down" },
  overhead: { order: 90, label: "Travel and daily overhead" },
};

const DEFAULT_EXECUTION_PROFILE = {
  hoursPerDay: 8,
  travelHoursPerDay: 1,
  tipTruckLoadMinutes: 30,
  tipTruckDumpMinutes: 15,
  defaultDumpDriveMinutesOneWay: 20,
  accessProfiles: {
    standard: {
      code: "standard",
      label: "Standard access",
      labourMultiplier: 1,
      machineMultiplier: 1,
      durationMultiplier: 1,
      overheadMultiplier: 1,
    },
    limited: {
      code: "limited",
      label: "Limited access",
      labourMultiplier: 1.2,
      machineMultiplier: 1.1,
      durationMultiplier: 1.15,
      overheadMultiplier: 1.1,
    },
    restricted: {
      code: "restricted",
      label: "Restricted access",
      labourMultiplier: 1.5,
      machineMultiplier: 1.15,
      durationMultiplier: 1.35,
      overheadMultiplier: 1.15,
    },
    steep: {
      code: "steep",
      label: "Steep access",
      labourMultiplier: 1.3,
      machineMultiplier: 1.2,
      durationMultiplier: 1.25,
      overheadMultiplier: 1.1,
    },
  },
};

const ACCESS_MATCHERS = [
  {
    code: "restricted",
    patterns: [
      "restricted access",
      "no machine access",
      "hand carry",
      "hand-carry",
      "wheelbarrow",
      "stairs",
      "through house",
      "carry materials",
      "tight access",
      "no truck entry",
    ],
  },
  {
    code: "steep",
    patterns: [
      "steep",
      "slope",
      "sloping",
      "gradient",
      "drop",
    ],
  },
  {
    code: "limited",
    patterns: [
      "limited access",
      "mini excavator",
      "small machine",
      "truck on road",
      "truck parked on road",
      "park the truck on the road",
      "carry distance",
      "narrow access",
      "no truck access",
    ],
  },
];

export function estimateQuoteExecution({
  lineItems = [],
  quoteCatalog,
  quoteInputs = null,
  details = null,
  assumptionOverrides = {},
  executionOverrides = null,
}) {
  if (!quoteCatalog) return null;

  const executionProfile = resolveExecutionProfile(quoteCatalog);
  if (executionOverrides?.travelHoursPerDay != null) {
    executionProfile.travelHoursPerDay = Number(executionOverrides.travelHoursPerDay);
  }
  if (executionOverrides?.dumpDriveMinutes != null) {
    executionProfile.defaultDumpDriveMinutesOneWay = Number(executionOverrides.dumpDriveMinutes);
  }
  const resolvedDumpDriveMinutes = resolveDumpDriveMinutes({
    details,
    executionProfile,
    overrideMinutes: executionOverrides?.dumpDriveMinutes,
  });
  const accessProfile = executionOverrides?.accessProfile
    ? resolveAccessProfileByCode(executionOverrides.accessProfile, executionProfile)
    : resolveAccessProfile({ quoteInputs, assumptionOverrides, executionProfile });
  const stageMap = new Map();

  for (const item of lineItems) {
    const ruleCode = resolveRuleCode(item);
    if (!ruleCode || NON_SCOPE_CODES.has(ruleCode)) continue;
    const rule = resolveQuoteCatalogRule(quoteCatalog, ruleCode);
    const execution = normalizeRuleExecution(rule?.execution);
    const quantity = Number(item.quantity || 0);
    if (!execution || !(quantity > 0)) continue;

    const stageCode = execution.stage || "general";
    const stage = getOrCreateStage(stageMap, stageCode);
    const labourHours = quantity * execution.labourHoursPerUnit * accessProfile.labourMultiplier;
    const machineHours = quantity * execution.machineHoursPerUnit * accessProfile.machineMultiplier;
    const supportHours = resolveSupportHours({
      item,
      execution,
      quantity,
      details,
      executionProfile,
      accessProfile,
      dumpDriveMinutesOverride: executionOverrides?.dumpDriveMinutes,
    });
    const billableLabourHours = quantity * execution.billableLabourHoursPerUnit * accessProfile.labourMultiplier;
    const billableMachineHours = quantity * execution.billableMachineHoursPerUnit * accessProfile.machineMultiplier;

    stage.labourHours += labourHours;
    stage.machineHours += machineHours;
    stage.supportHours += supportHours;
    stage.billableLabourHours += billableLabourHours;
    stage.billableMachineHours += billableMachineHours;
    stage.items.add(item.label);
    stage.codes.add(item.code || ruleCode);
  }

  let stages = [...stageMap.values()]
    .map(finalizeStage)
    .filter((stage) => stage.durationHours > 0);

  if (!stages.length) return null;

  const directDurationHours = sum(stages.map((stage) => stage.durationHours));
  const overriddenFields = [];
  let labourHours = roundHoursUp(sum(stages.map((stage) => stage.billableLabourHours)), 0.5);
  let machineHours = roundHoursUp(sum(stages.map((stage) => stage.billableMachineHours)), 0.5);

  if (executionOverrides?.labourHours != null) {
    labourHours = roundHoursUp(Number(executionOverrides.labourHours), 0.5);
    overriddenFields.push("labourHours");
  }
  if (executionOverrides?.machineHours != null) {
    machineHours = roundHoursUp(Number(executionOverrides.machineHours), 0.5);
    overriddenFields.push("machineHours");
  }
  if (executionOverrides?.accessProfile) overriddenFields.push("accessProfile");
  if (executionOverrides?.travelHoursPerDay != null) overriddenFields.push("travelHoursPerDay");
  if (executionOverrides?.dumpDriveMinutes != null) overriddenFields.push("dumpDriveMinutes");

  const effectiveDirectDurationHours = resolveDirectDurationHours({
    directDurationHours,
    labourHours,
    machineHours,
    overriddenFields,
  });
  const siteDays = effectiveDirectDurationHours > 0
    ? Math.max(1, Math.ceil(effectiveDirectDurationHours / executionProfile.hoursPerDay))
    : 0;
  const overheadDurationHours = siteDays > 0 && executionProfile.travelHoursPerDay > 0
    ? roundHoursUp(
        executionProfile.travelHoursPerDay * siteDays * accessProfile.overheadMultiplier,
        0.25,
      )
    : 0;

  if (overheadDurationHours > 0) {
    stages = [
      ...stages,
      {
        code: "overhead",
        label: STAGE_META.overhead.label,
        order: STAGE_META.overhead.order,
        durationHours: overheadDurationHours,
        labourHours: overheadDurationHours,
        machineHours: 0,
        supportHours: 0,
        billableLabourHours: 0,
        billableMachineHours: 0,
        items: [],
        codes: [],
      },
    ];
  }

  stages = stages
    .sort((a, b) => a.order - b.order)
    .map((stage) => ({
      ...stage,
      items: [...stage.items],
      codes: [...stage.codes],
    }));

  const totals = {
    labourHours,
    machineHours,
    durationHours: roundHoursUp(effectiveDirectDurationHours + overheadDurationHours, 0.25),
    siteDays,
  };
  totals.workingDays = roundToOneDecimal(totals.durationHours / executionProfile.hoursPerDay);

  const assumptions = buildExecutionAssumptions({
    executionProfile,
    accessProfile,
    details,
    executionOverrides,
    resolvedDumpDriveMinutes,
    totals,
    stages,
  });
  const derivedAssumptions = buildDerivedAssumptions({
    totals,
    stages,
    executionProfile,
    executionOverrides,
  });

  return {
    workingDayHours: executionProfile.hoursPerDay,
    accessProfile: {
      code: accessProfile.code,
      label: accessProfile.label,
      matchedText: accessProfile.matchedText || null,
    },
    parameters: {
      travelHoursPerDay: executionProfile.travelHoursPerDay,
      dumpDriveMinutes: resolvedDumpDriveMinutes,
    },
    totals,
    stages,
    assumptions,
    derivedAssumptions,
    overrides: executionOverrides || null,
    overriddenFields,
  };
}

export function applyExecutionEstimateToLineItems({
  lineItems = [],
  quoteCatalog,
  execution = null,
}) {
  if (!quoteCatalog || !execution) return { lineItems, pricingIssues: [] };

  // DEL-46 (P3, round 7): upsertHourlyLineItem fails closed (round 6) when
  // its rule has no positive rate, but a silently-omitted line is still an
  // undetected under-billing risk if a support rule's rate is ever removed
  // — currently latent (both catalogues price every hourly/support rule),
  // but the surfacing convention used everywhere else a pricing gap is
  // detected (buildLineItems's pricingIssues) applies here too, not just
  // when a line is silently absent from the quote it should have been on.
  const pricingIssues = [];
  let nextLineItems = [...lineItems];
  nextLineItems = upsertHourlyLineItem({
    lineItems: nextLineItems,
    quoteCatalog,
    code: HOURLY_LABOUR_CODE,
    quantity: execution.totals.labourHours,
    field: "estimated labour hours",
    summary: buildDerivedLineItemSummary({
      hours: execution.totals.labourHours,
      workingDayHours: execution.workingDayHours,
      focus: "scoped site work",
    }),
    pricingIssues,
  });
  nextLineItems = upsertHourlyLineItem({
    lineItems: nextLineItems,
    quoteCatalog,
    code: HOURLY_MACHINE_CODE,
    quantity: execution.totals.machineHours,
    field: "estimated machine hours",
    summary: buildDerivedLineItemSummary({
      hours: execution.totals.machineHours,
      workingDayHours: execution.workingDayHours,
      focus: "machine-backed stages",
    }),
    pricingIssues,
  });

  return { lineItems: nextLineItems, pricingIssues };
}

function resolveCatalogueSellRate(rule) {
  const value = rule?.priceCatalog?.sellPrice ?? rule?.authorityPricing?.sellingRate ?? null;
  return value == null ? null : Number(value);
}

function upsertHourlyLineItem({ lineItems, quoteCatalog, code, quantity, field, summary, pricingIssues }) {
  const existingIndex = lineItems.findIndex((item) => item.code === code);
  const existing = existingIndex >= 0 ? lineItems[existingIndex] : null;

  if (existing && existing.manualOverride) return lineItems;
  if (existing && existing.usedDefaultQuantity === false) return lineItems;
  if (!(quantity > 0)) {
    if (existingIndex >= 0 && existing?.usedDefaultQuantity) {
      const next = [...lineItems];
      next.splice(existingIndex, 1);
      return next;
    }
    return lineItems;
  }

  const rule = resolveQuoteCatalogRule(quoteCatalog, code);
  if (!rule) return lineItems;
  // The rate is the price catalogue item's sell price only (the quote
  // catalog carries none). This derived line item is injected directly into
  // quote.lineItems with no pricing-issue plumbing of its own, so an unpriced
  // rule must not reach here at all — that would silently add a real $0
  // line, worse than simply not adding the derived line (the pre-existing
  // behaviour when quantity <= 0, just below). Record the omission as a
  // pricing issue (DEL-46, round 7) so a missing rate is reported, not
  // silent.
  const unitPrice = resolveCatalogueSellRate(rule);
  if (!(unitPrice > 0)) {
    pricingIssues?.push({
      code: rule.code,
      label: rule.label,
      reason: `${rule.label} has no sell price set, so ${field} could not be priced and was omitted from the quote.`,
    });
    return lineItems;
  }

  const derivedItem = {
    code,
    quoteCatalogItemCode: rule.code,
    label: rule.label,
    quantity,
    unit: rule.unit,
    unitPrice,
    totalPrice: roundMoney(quantity * unitPrice),
    rationale: summary,
    confidence: 0.65,
    evidence: existing?.evidence || [],
    evidenceSummary: existing?.evidenceSummary || [],
    requiredInputs: [field],
    assumptions: [
      `Quantity derived from the scoped execution model: ${summary}`,
    ],
    usedDefaultQuantity: false,
    manualOverride: existing?.manualOverride || null,
    provenance: [{
      sourceType: "ai-generated",
      actor: { kind: "system", label: "Field" },
      createdAt: new Date().toISOString(),
      summary: `Derived from execution model for ${field}`,
    }],
    customerVisible: rule.presentation?.customerVisible === true,
    quoteCatalogEntry: {
      code: rule.code,
      label: rule.label,
      referenceUrl: `/api/quote-catalogs/${quoteCatalog.id}/reference`,
    },
  };

  if (existingIndex >= 0) {
    const next = [...lineItems];
    next[existingIndex] = {
      ...existing,
      ...derivedItem,
      evidence: existing?.evidence || derivedItem.evidence,
      evidenceSummary: existing?.evidenceSummary || derivedItem.evidenceSummary,
      provenance: existing?.provenance?.length ? [...existing.provenance, ...derivedItem.provenance] : derivedItem.provenance,
    };
    return next;
  }

  return [...lineItems, derivedItem];
}

function buildDerivedLineItemSummary({ hours, workingDayHours, focus }) {
  return `${formatHours(hours)} derived from ${focus} using an ${workingDayHours}-hour working day.`;
}

function resolveRuleCode(item) {
  if (item?.quoteCatalogItemCode) return item.quoteCatalogItemCode;
  return String(item?.code || "").split("__")[0] || null;
}

function buildExecutionAssumptions({
  executionProfile,
  accessProfile,
  details,
  executionOverrides,
  resolvedDumpDriveMinutes,
  totals,
  stages,
}) {
  if (!stages.length) return [];

  const assumptions = [
    `Duration uses an ${executionProfile.hoursPerDay}-hour working day.`,
    `Daily working-duration overhead includes ${formatHours(executionProfile.travelHoursPerDay)} for travel, loading, and breaks.`,
    `Access is priced as ${accessProfile.label.toLowerCase()}.`,
    "Hourly labour and machine line items are driven from direct construction stages rather than injected placeholder allowances.",
  ];

  const haulageStage = stages.find((stage) => stage.code === "haulage");
  if (haulageStage) {
    const dumpName = details?.soilDump?.name ? ` to ${details.soilDump.name}` : "";
    assumptions.push(
      `Haulage duration assumes ${resolvedDumpDriveMinutes} minutes one-way drive${dumpName}, plus loading and tipping time per load.`
    );
  }

  if (totals.siteDays > 1) {
    assumptions.push(`Expected construction duration spans about ${totals.siteDays} site days at the current scope.`);
  }

  if (executionOverrides?.labourHours != null) {
    assumptions.push(`Billable labour was manually set to ${formatHours(totals.labourHours)} for this quote.`);
  }
  if (executionOverrides?.machineHours != null) {
    assumptions.push(`Billable machine time was manually set to ${formatHours(totals.machineHours)} for this quote.`);
  }
  if (executionOverrides?.accessProfile) {
    assumptions.push(`Access profile was manually set to ${accessProfile.label.toLowerCase()}.`);
  }
  if (executionOverrides?.travelHoursPerDay != null) {
    assumptions.push(`Daily travel and overhead was manually set to ${formatHours(executionProfile.travelHoursPerDay)}.`);
  }
  if (executionOverrides?.dumpDriveMinutes != null && haulageStage) {
    assumptions.push(`Dump drive time was manually set to ${resolvedDumpDriveMinutes} minutes one-way.`);
  }
  if (executionOverrides?.note) {
    assumptions.push(`Execution note: ${executionOverrides.note}`);
  }

  return assumptions;
}

function buildDerivedAssumptions({ totals, stages, executionProfile, executionOverrides }) {
  const stageItems = stages
    .filter((stage) => stage.code !== "overhead")
    .flatMap((stage) => stage.items)
    .slice(0, 6);
  const relatedLineItems = dedupe(
    stages
      .filter((stage) => stage.code !== "overhead")
      .flatMap((stage) => stage.codes || [])
  );

  const assumptions = [];
  if (totals.labourHours > 0) {
    const manual = executionOverrides?.labourHours != null;
    assumptions.push({
      field: "estimated labour hours",
      value: `${formatHours(totals.labourHours)} across direct construction stages`,
      source: manual ? "user" : "derived",
      reason: manual
        ? "Operator overrode the derived labour-hours estimate for this quote."
        : "Derived from the staged execution model built from the scoped work.",
      quoteNote: manual
        ? `Labour hours were manually set for this quote and priced against an ${executionProfile.hoursPerDay}-hour working day.`
        : `Labour hours were derived from the scoped workflow and priced against an ${executionProfile.hoursPerDay}-hour working day.`,
      affectsPricing: true,
      relatedLineItems,
      evidenceSummary: dedupe([
        manual ? `Manual execution override applied: ${formatHours(totals.labourHours)}.` : null,
        stageItems.length ? `Execution stages considered: ${stageItems.join(", ")}` : null,
      ]),
    });
  }

  if (totals.machineHours > 0) {
    const manual = executionOverrides?.machineHours != null;
    assumptions.push({
      field: "estimated machine hours",
      value: `${formatHours(totals.machineHours)} across machine-backed stages`,
      source: manual ? "user" : "derived",
      reason: manual
        ? "Operator overrode the derived machine-hours estimate for this quote."
        : "Derived from the staged execution model built from the scoped work.",
      quoteNote: manual
        ? `Machine hours were manually set for this quote and priced against an ${executionProfile.hoursPerDay}-hour working day.`
        : `Machine hours were derived from the scoped workflow and priced against an ${executionProfile.hoursPerDay}-hour working day.`,
      affectsPricing: true,
      relatedLineItems,
      evidenceSummary: dedupe([
        manual ? `Manual execution override applied: ${formatHours(totals.machineHours)}.` : null,
        stageItems.length ? `Execution stages considered: ${stageItems.join(", ")}` : null,
      ]),
    });
  }

  return assumptions;
}

function getOrCreateStage(stageMap, code) {
  if (stageMap.has(code)) return stageMap.get(code);
  const meta = STAGE_META[code] || { order: 999, label: humanize(code) };
  const stage = {
    code,
    label: meta.label,
    order: meta.order,
    labourHours: 0,
    machineHours: 0,
    supportHours: 0,
    billableLabourHours: 0,
    billableMachineHours: 0,
    items: new Set(),
    codes: new Set(),
  };
  stageMap.set(code, stage);
  return stage;
}

function finalizeStage(stage) {
  return {
    ...stage,
    labourHours: roundHoursUp(stage.labourHours, 0.25),
    machineHours: roundHoursUp(stage.machineHours, 0.25),
    supportHours: roundHoursUp(stage.supportHours, 0.25),
    billableLabourHours: roundHoursUp(stage.billableLabourHours, 0.5),
    billableMachineHours: roundHoursUp(stage.billableMachineHours, 0.5),
    durationHours: roundHoursUp(
      Math.max(stage.labourHours, stage.machineHours, stage.supportHours),
      0.25,
    ),
  };
}

function resolveExecutionProfile(quoteCatalog) {
  const raw = quoteCatalog.executionProfile || {};
  const defaults = DEFAULT_EXECUTION_PROFILE;
  return {
    hoursPerDay: Number(raw.hoursPerDay || quoteCatalog.hoursPerDay || defaults.hoursPerDay),
    travelHoursPerDay: Number(raw.travelHoursPerDay ?? defaults.travelHoursPerDay),
    tipTruckLoadMinutes: Number(raw.tipTruckLoadMinutes ?? defaults.tipTruckLoadMinutes),
    tipTruckDumpMinutes: Number(raw.tipTruckDumpMinutes ?? defaults.tipTruckDumpMinutes),
    defaultDumpDriveMinutesOneWay: Number(
      raw.defaultDumpDriveMinutesOneWay ?? defaults.defaultDumpDriveMinutesOneWay
    ),
    accessProfiles: {
      standard: normalizeAccessProfile(raw.accessProfiles?.standard, defaults.accessProfiles.standard),
      limited: normalizeAccessProfile(raw.accessProfiles?.limited, defaults.accessProfiles.limited),
      restricted: normalizeAccessProfile(raw.accessProfiles?.restricted, defaults.accessProfiles.restricted),
      steep: normalizeAccessProfile(raw.accessProfiles?.steep, defaults.accessProfiles.steep),
    },
  };
}

function normalizeAccessProfile(raw, fallback) {
  return {
    code: raw?.code || fallback.code,
    label: raw?.label || fallback.label,
    labourMultiplier: Number(raw?.labourMultiplier ?? fallback.labourMultiplier),
    machineMultiplier: Number(raw?.machineMultiplier ?? fallback.machineMultiplier),
    durationMultiplier: Number(raw?.durationMultiplier ?? fallback.durationMultiplier),
    overheadMultiplier: Number(raw?.overheadMultiplier ?? fallback.overheadMultiplier),
  };
}

function resolveAccessProfile({ quoteInputs, assumptionOverrides, executionProfile }) {
  const normalizedOverrides = new Map(
    Object.entries(assumptionOverrides || {}).map(([key, value]) => [normalizeKey(key), value])
  );
  const textPool = [
    normalizedOverrides.get("site access constraints")?.value,
    ...(quoteInputs?.siteConstraints || []).map((entry) => `${entry.label || ""} ${entry.detail || ""}`.trim()),
    ...(quoteInputs?.processReferences || []).map((entry) => `${entry.label || ""} ${entry.detail || ""}`.trim()),
  ].filter(Boolean);
  const haystack = textPool.join(" | ").toLowerCase();

  for (const matcher of ACCESS_MATCHERS) {
    const match = matcher.patterns.find((pattern) => haystack.includes(pattern));
    if (!match) continue;
    return {
      ...executionProfile.accessProfiles[matcher.code],
      matchedText: match,
    };
  }

  return {
    ...executionProfile.accessProfiles.standard,
    matchedText: null,
  };
}

function resolveAccessProfileByCode(code, executionProfile) {
  const profile = executionProfile.accessProfiles[code];
  if (profile) return { ...profile, matchedText: null };
  return { ...executionProfile.accessProfiles.standard, matchedText: null };
}

function normalizeRuleExecution(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    stage: raw.stage || "general",
    labourHoursPerUnit: Number(raw.labourHoursPerUnit || 0),
    machineHoursPerUnit: Number(raw.machineHoursPerUnit || 0),
    supportHoursPerUnit: Number(raw.supportHoursPerUnit || 0),
    billableLabourHoursPerUnit: Number(
      raw.billableLabourHoursPerUnit ?? raw.labourHoursPerUnit ?? 0
    ),
    billableMachineHoursPerUnit: Number(
      raw.billableMachineHoursPerUnit ?? raw.machineHoursPerUnit ?? 0
    ),
    supportHoursMode: raw.supportHoursMode || null,
  };
}

function resolveSupportHours({
  item,
  execution,
  quantity,
  details,
  executionProfile,
  accessProfile,
  dumpDriveMinutesOverride,
}) {
  if (execution.supportHoursMode === "tip-truck-cycle") {
    const driveMinutes = resolveDumpDriveMinutes({
      details,
      executionProfile,
      overrideMinutes: dumpDriveMinutesOverride,
    });
    const cycleMinutes =
      executionProfile.tipTruckLoadMinutes
      + executionProfile.tipTruckDumpMinutes
      + (driveMinutes * 2);
    return (cycleMinutes / 60) * quantity * accessProfile.durationMultiplier;
  }

  const baseSupportHours = quantity * execution.supportHoursPerUnit;
  if (!(baseSupportHours > 0)) return 0;
  if (item.code === "tip-truck") {
    return baseSupportHours * accessProfile.durationMultiplier;
  }
  return baseSupportHours;
}

function resolveDirectDurationHours({ directDurationHours, labourHours, machineHours, overriddenFields }) {
  if (!overriddenFields.includes("labourHours") && !overriddenFields.includes("machineHours")) {
    return directDurationHours;
  }

  return Math.max(
    directDurationHours,
    Number(labourHours || 0),
    Number(machineHours || 0),
  );
}

function resolveDumpDriveMinutes({ details, executionProfile, overrideMinutes = null }) {
  if (overrideMinutes != null) return Number(overrideMinutes);
  const dump = details?.soilDump || DEFAULT_SOIL_DUMP;
  const gps = details?.gps;
  if (gps?.lat && gps?.lng && dump?.lat && dump?.lng) {
    const straight = haversineDistanceKm(gps.lat, gps.lng, dump.lat, dump.lng);
    const dist = estimateDrivingDistanceKm(straight);
    return estimateDriveMinutes(dist);
  }
  return Number(dump?.drive ?? executionProfile.defaultDumpDriveMinutesOneWay);
}

function roundHoursUp(value, increment) {
  const numeric = Number(value || 0);
  if (!(numeric > 0)) return 0;
  return Math.ceil((numeric + Number.EPSILON) / increment) * increment;
}

function roundToOneDecimal(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10) / 10;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function formatHours(value) {
  const numeric = Number(value || 0);
  if (Number.isInteger(numeric)) return `${numeric} hours`;
  return `${numeric.toFixed(1).replace(/\.0$/, "")} hours`;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}
