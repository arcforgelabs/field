import { FALLBACK_ADJUSTMENT_ITEM_CODE } from "./retaining-wall-commercial.js";
import { resolveQuoteCatalogRule } from "./quote-catalogs.js";
import { resolveQuoteQuantityDemand } from "./quote-quantity-rules.js";
import { findRetainingWallZoneForLineItem } from "./wall-zones.js";
import {
  buildCommercialItemReference,
  buildCommercialPriceReferences,
  buildTraceEntry,
  buildTraceInput,
  isExternalAuthorityProvider,
  isPriceCatalogAuthorityProvider,
  normalizeAuthorityBaseUrl,
  normalizeCommercialAuthorityProvider,
  normalizeStructuredTrace,
  normalizeTraceReferences,
  normalizeTraceNotes,
} from "./quote-trace.js";
import { formatCatalogUnit, formatCatalogUnitText } from "../shared/catalog-units.js";

function validMoney(value) {
  return value != null && Number.isFinite(Number(value));
}

/**
 * The recipe inputs for one compile: the quote catalog's assemblies priced
 * from the price catalogue (server/price-catalog/recipe-pricing.js). There
 * are no built-in rates: without catalogue pricing every recipe line is
 * unpriced and the line fails closed, naming the items.
 */
function resolveRecipe(recipePricing) {
  return {
    strictCatalog: true,
    assemblies: recipePricing?.assemblies || {},
  };
}

function describeCommercialAuthority(provider) {
  if (isPriceCatalogAuthorityProvider(provider)) return "Price catalog";
  if (isExternalAuthorityProvider(provider)) return "External authority";
  return "catalog";
}

function directBuyingRatePricingSource(provider) {
  if (isPriceCatalogAuthorityProvider(provider)) return "price_catalog_buying_rate";
  if (isExternalAuthorityProvider(provider)) return "authority_buying_rate";
  return "catalog_buying_rate";
}

function directItemInputLabel(provider) {
  if (isPriceCatalogAuthorityProvider(provider)) return "Price catalog item";
  if (isExternalAuthorityProvider(provider)) return "Authority item";
  return "Catalog item";
}

function directBuyingRateLabel(provider) {
  if (isPriceCatalogAuthorityProvider(provider)) return "Price catalog buying rate";
  if (isExternalAuthorityProvider(provider)) return "Authority buying rate";
  return "Catalog buying rate";
}

export function applyQuoteCommercialBreakdownToQuote({
  quote,
  quoteCatalog = null,
  details = null,
  optionSelections = null,
  acceptedOptionSelections = null,
  recipePricing = null,
  retainingWallContext = null,
}) {
  if (!quote || (Array.isArray(quote.commercialLines) && quote.commercialLines.length)) {
    return quote;
  }

  const breakdown = compileQuoteCommercialBreakdown({
    quote,
    quoteCatalog,
    details,
    optionSelections,
    acceptedOptionSelections,
    recipePricing,
    retainingWallContext,
  });

  return {
    ...quote,
    ...(breakdown.commercialLines.length
      ? {
          commercialLines: breakdown.commercialLines,
          budgetLines: breakdown.budgetLines,
        }
      : {}),
    ...(breakdown.materialOrders.length
      ? {
          materialOrders: breakdown.materialOrders,
        }
      : {}),
    ...(breakdown.quoteTotals
      ? {
          totals: breakdown.quoteTotals,
        }
      : {}),
    optionFamilies: breakdown.optionFamilies,
    selectionState: breakdown.selectionState,
    ...(breakdown.commercialLines.length
      ? {}
      : {}),
    internalPricing: {
      mode: breakdown.mode,
      unresolvedOptions: breakdown.unresolvedOptions,
      coverage: breakdown.coverage,
      totals: breakdown.totals,
      note: breakdown.note,
      ready: breakdown.ready,
      pricingIssues: breakdown.pricingIssues,
      lineItemBreakdowns: breakdown.lineItemBreakdowns,
      optionFamilies: breakdown.optionFamilies,
      selectionState: breakdown.selectionState,
      materialOrders: breakdown.materialOrders,
      ...(breakdown.commercialLines.length
        ? {
            commercialLines: breakdown.commercialLines,
            budgetLines: breakdown.budgetLines,
          }
        : {}),
    },
  };
}

export function compileQuoteCommercialBreakdown({
  quote,
  quoteCatalog = null,
  details = null,
  optionSelections = null,
  acceptedOptionSelections = null,
  recipePricing = null,
  retainingWallContext = null,
}) {
  if (recipePricing?.unavailable === true) {
    const sourceItems = Array.isArray(quote?.lineItems) ? quote.lineItems : [];
    const reason = String(
      recipePricing.reason
      || "Price catalog pricing is unavailable; commercial lines remain blocked."
    ).trim();
    const pricingIssues = sourceItems.map((lineItem) => buildCommercialPricingIssue({
      code: lineItem?.quoteCatalogItemCode || lineItem?.code || null,
      label: lineItem?.label || lineItem?.code || "Quoted scope",
      reason,
    }));
    const lineItemBreakdowns = sourceItems.map((lineItem) => ({
      sourceLineItemCode: lineItem?.code || null,
      sourceLineItemLabel: lineItem?.label || null,
      section: lineItem?.section || null,
      sourceTotalPrice: nullableMoney(lineItem?.totalPrice),
      sourceQuantity: roundQuantity(Number(lineItem?.quantity || 0)),
      sourceUnit: lineItem?.unit || null,
      recipe: "pricing_unavailable",
      note: reason,
      pricingIssues: pricingIssues.filter((issue) => issue.code === (lineItem?.quoteCatalogItemCode || lineItem?.code || null)),
      commercialLines: [],
      budgetLines: [],
      materialOrders: [],
      totals: { charge: null, cost: null },
    }));
    const optionSelection = resolveOptionSelectionState({
      sourceItems,
      lineItemBreakdowns,
      optionSelections,
      acceptedOptionSelections,
    });

    return {
      mode: "pricing_unavailable",
      unresolvedOptions: false,
      ready: false,
      note: reason,
      coverage: {
        sourceLineItemCount: sourceItems.length,
        exactRecipeCount: 0,
        directPassThroughCount: 0,
      },
      totals: { cost: null, charge: null },
      lineItemBreakdowns,
      commercialLines: [],
      budgetLines: [],
      materialOrders: [],
      pricingIssues,
      optionFamilies: optionSelection.optionFamilies,
      selectionState: optionSelection.selectionState,
      quoteTotals: null,
    };
  }

  const resolved = resolveRecipe(recipePricing);
  const sourceItems = Array.isArray(quote?.lineItems) ? quote.lineItems : [];
  const authorityProvider = resolveCommercialAuthorityProvider({ quoteCatalog, quote });
  const lineItemBreakdowns = sourceItems.map((lineItem) => compileLineItemBreakdown({
    lineItem,
    quote,
    quoteCatalog: quoteCatalog,
    details,
    resolved,
    authorityProvider,
    retainingWallContext,
  }));
  const pricingIssues = dedupeBy(
    lineItemBreakdowns.flatMap((item) => item.pricingIssues || []),
    (issue) => `${issue.code || ""}::${issue.reason || ""}`
  );
  const optionSelection = resolveOptionSelectionState({
    sourceItems,
    lineItemBreakdowns,
    optionSelections,
    acceptedOptionSelections,
  });
  const selectedBreakdowns = optionSelection.selectedBreakdowns;
  const commercialLines = selectedBreakdowns.flatMap((item) => item.commercialLines);
  const budgetLines = selectedBreakdowns.flatMap((item) => item.budgetLines);
  const materialOrders = selectedBreakdowns.flatMap((item) => item.materialOrders || []);
  const unresolvedOptions = optionSelection.selectionState.hasOptionFamilies && !optionSelection.selectionState.handoffReady;
  const notes = [
    unresolvedOptions
      ? "Quote contains mutually exclusive option sections. The quote carries a default scenario for totals and internal pricing, but handoff and invoice paths stay blocked until one option is accepted for every family."
      : null,
    pricingIssues.length
      ? "Commercial pricing is unresolved for one or more internal lines. Field keeps the customer-facing quote visible and syncs authority quotations from the customer schedule until buying rates are complete."
      : null,
  ].filter(Boolean);

  return {
    mode: optionSelection.selectionState.hasOptionFamilies
      ? (optionSelection.selectionState.handoffReady ? "selected_scenario" : "option_matrix")
      : "flat_quote",
    unresolvedOptions,
    ready: pricingIssues.length === 0,
    note: notes.join(" ") || null,
    coverage: {
      sourceLineItemCount: sourceItems.length,
      exactRecipeCount: lineItemBreakdowns.filter((item) => item.recipe !== "direct_pass_through").length,
      directPassThroughCount: lineItemBreakdowns.filter((item) => item.recipe === "direct_pass_through").length,
    },
    totals: unresolvedOptions
      ? {
          cost: roundMoney(sum(budgetLines.map((line) => line.totalPrice))),
          charge: roundMoney(sum(commercialLines.map((line) => line.totalPrice))),
        }
      : {
          cost: roundMoney(sum(budgetLines.map((line) => line.totalPrice))),
          charge: roundMoney(sum(commercialLines.map((line) => line.totalPrice))),
        },
    lineItemBreakdowns,
    commercialLines,
    budgetLines,
    materialOrders,
    pricingIssues,
    optionFamilies: optionSelection.optionFamilies,
    selectionState: optionSelection.selectionState,
    quoteTotals: buildScenarioQuoteTotals({
      quote,
      activeCustomerSubtotal: optionSelection.activeCustomerSubtotal,
      note: buildScenarioTotalsNote(optionSelection.selectionState),
    }),
  };
}

export function quoteHasMutuallyExclusiveSections(quote) {
  const sections = new Set(
    (quote?.lineItems || [])
      .map((lineItem) => String(lineItem?.section || "").trim())
      .filter(Boolean)
  );
  return [...sections].some((section) => isMutuallyExclusiveSection(section));
}

function compileLineItemBreakdown({
  lineItem,
  quote,
  quoteCatalog,
  details,
  resolved,
  authorityProvider,
  retainingWallContext,
}) {
  const exactRetainingWall = resolveExactRetainingWallBreakdown({
    lineItem,
    retainingWallContext,
  });
  const quantityDemand = resolveQuoteQuantityDemand({
    lineItem,
    quote,
    quoteCatalog,
    resolved,
    details,
  });
  const exact = exactRetainingWall || (quantityDemand?.recipe
    ? {
        recipe: quantityDemand.recipe.code,
        lines: quantityDemand.recipe.lines,
        materialOrders: quantityDemand.materialOrders,
        pricingProblems: quantityDemand.recipe.pricingProblems || [],
      }
    : null);

  const base = exact || compileDirectLineItem({ lineItem, quote, quoteCatalog, authorityProvider });
  const supplementalMaterialOrders = exact
    ? []
    : (quantityDemand?.materialOrders || []);
  const baseLines = Array.isArray(base?.lines) ? base.lines : [];
  const strictPricingMissing = Boolean(
    resolved.strictCatalog
    && (
      (base?.pricingProblems || []).length > 0
      || baseLines.some((line) => !validMoney(line?.unitCost) || !validMoney(line?.unitPrice))
      || (base?.commercialLines || []).some((line) => !validMoney(line?.unitCost) || !validMoney(line?.unitPrice))
      // A budget line is the cost side: its price is the cost (prebuilt wall
      // budget lines carry no separate unitCost).
      || (base?.budgetLines || []).some((line) => !validMoney(line?.unitCost ?? line?.unitPrice))
    )
  );
  if (strictPricingMissing) {
    const reason = describeMissingRecipeRates({ base, baseLines });
    return {
      sourceLineItemCode: lineItem.code || null,
      sourceLineItemLabel: lineItem.label || null,
      section: lineItem.section || null,
      sourceTotalPrice: nullableMoney(lineItem.totalPrice),
      sourceQuantity: roundQuantity(Number(lineItem.quantity || 0)),
      sourceUnit: lineItem.unit || null,
      recipe: base.recipe || "pricing_unavailable",
      note: reason,
      pricingIssues: [buildCommercialPricingIssue({
        code: lineItem.code || lineItem.quoteCatalogItemCode,
        label: lineItem.label || lineItem.code || "Quoted scope",
        reason,
      })],
      commercialLines: [],
      budgetLines: [],
      materialOrders: [],
      totals: { charge: null, cost: null },
    };
  }
  const commercialLines = Array.isArray(base?.commercialLines) && base.commercialLines.length
    ? base.commercialLines.map((line, index) => stampPrebuiltCommercialLine({
        lineItem,
        line,
        index,
      }))
    : baseLines.map((line, index) => buildCommercialLine({
        lineItem,
        quote,
        line,
        index,
      }));
  const budgetLines = Array.isArray(base?.budgetLines) && base.budgetLines.length
    ? base.budgetLines.map((line, index) => stampPrebuiltBudgetLine({
        lineItem,
        line,
        index,
      }))
    : baseLines.map((line, index) => buildBudgetLine({
        lineItem,
        line,
        index,
      }));
  const totals = base?.totals
    ? {
        charge: nullableMoney(base.totals.charge),
        cost: nullableMoney(base.totals.cost),
      }
    : {
        charge: roundMoney(sum(commercialLines.map((line) => line.totalPrice))),
        cost: roundMoney(sum(budgetLines.map((line) => line.totalPrice))),
      };

  return {
    sourceLineItemCode: lineItem.code || null,
    sourceLineItemLabel: lineItem.label || null,
    section: lineItem.section || null,
    sourceTotalPrice: nullableMoney(lineItem.totalPrice),
    sourceQuantity: roundQuantity(Number(lineItem.quantity || 0)),
    sourceUnit: lineItem.unit || null,
    recipe: base.recipe,
    note: base.note || null,
    pricingIssues: [...(base.pricingIssues || [])],
    commercialLines,
    budgetLines,
    materialOrders: dedupeBy(
      [
        ...normalizeMaterialOrders({
          materialOrders: base.materialOrders || [],
          lineItem,
        }),
        ...supplementalMaterialOrders,
      ],
      (order) => order.code
    ),
    totals,
  };
}

function resolveExactRetainingWallBreakdown({
  lineItem,
  retainingWallContext,
}) {
  const zone = findRetainingWallZoneForLineItem({ lineItem, retainingWallContext });
  if (!zone?.exactWallBreakdown) return null;
  return {
    recipe: zone.exactWallBreakdown.recipe || "retaining_wall_exact",
    note: zone.exactWallBreakdown.note || null,
    commercialLines: zone.exactWallBreakdown.commercialLines || [],
    budgetLines: zone.exactWallBreakdown.budgetLines || [],
    materialOrders: zone.exactWallBreakdown.materialOrders || [],
    totals: zone.exactWallBreakdown.totals || null,
  };
}

/**
 * Why a recipe line cannot be priced, naming the catalogue items: the
 * assembly's own pricing problems (missing, archived, unpriced, unit
 * mismatch) when it has them, else the item codes left without a rate.
 */
function describeMissingRecipeRates({ base, baseLines }) {
  const budgetGaps = (base?.budgetLines || []).filter((line) => !validMoney(line?.unitCost ?? line?.unitPrice));
  const problems = (base?.pricingProblems || []).map((problem) => problem.message).filter(Boolean);
  if (problems.length) return `Catalogue pricing is missing: ${[...new Set(problems)].join("; ")}.`;
  const codes = [...new Set([
    ...baseLines,
    ...(base?.commercialLines || []),
  ]
    .filter((line) => !validMoney(line?.unitCost) || !validMoney(line?.unitPrice))
    .concat(budgetGaps)
    .map((line) => String(line?.itemCode || "").trim())
    .filter(Boolean))];
  return codes.length
    ? `The price catalogue has no buy and sell rate for ${codes.join(", ")}.`
    : "One or more required commercial catalogue rates are missing.";
}

function compileDirectLineItem({ lineItem, quote, quoteCatalog, authorityProvider }) {
  const rule = resolveRuleForLineItem({ lineItem, quoteCatalog });
  const quantity = Number(lineItem.quantity || 0) || 1;
  const itemCode = rule?.priceCatalog?.code || rule?.authorityItemCode || rule?.authorityPricing?.itemCode || rule?.code || lineItem.quoteCatalogEntry?.authorityItemCode || lineItem.quoteCatalogItemCode || lineItem.quoteCatalogEntry?.code || FALLBACK_ADJUSTMENT_ITEM_CODE;
  const unitPrice = nullableMoney(lineItem.unitPrice ?? lineItem.totalPrice);
  const inferredCost = resolveDirectUnitCost({
    lineItem,
    rule,
    unitPrice,
    authorityProvider,
  });
  if (inferredCost == null) {
    return {
      recipe: "direct_pass_through",
      note: "Authority cost rate is unresolved for this direct commercial line. Field will not infer internal cost locally.",
      pricingIssues: [buildDirectPricingIssue({
        lineItem,
        rule,
        itemCode,
        authorityProvider,
      })],
      lines: [],
    };
  }

  return {
    recipe: "direct_pass_through",
    note: rule ? null : "No exact recipe or quote-catalog rule matched. Using direct pass-through commercial line.",
    lines: [
      {
        itemCode,
        label: rule?.label || lineItem.quoteCatalogEntry?.label || lineItem.label || "Quoted Scope",
        description: formatCatalogUnitText(lineItem.rationale || lineItem.scopeSummary || lineItem.label || "Quoted scope"),
        quantity,
        unit: lineItem.unit || rule?.unit || "job",
        unitCost: inferredCost,
        unitPrice,
        pricingSource: rule?.authorityPricing?.buyingRate != null
          ? directBuyingRatePricingSource(authorityProvider)
          : "supplied_unit_cost",
        itemMeta: buildItemMetaFromRule(rule, lineItem),
        trace: buildDirectPassThroughTrace({
          quote,
          lineItem,
          rule,
          itemCode,
          quantity,
          unitPrice,
          unitCost: inferredCost,
          authorityProvider,
        }),
      },
    ],
  };
}

function resolveDirectUnitCost({
  lineItem,
  rule,
  unitPrice,
  authorityProvider,
}) {
  if (
    lineItem?.unitCost != null
    && String(lineItem.unitCost).trim() !== ""
    && Number.isFinite(Number(lineItem.unitCost))
  ) {
    return roundMoney(Number(lineItem.unitCost));
  }
  if (rule?.authorityPricing?.buyingRate != null) {
    return roundMoney(Number(rule.authorityPricing.buyingRate));
  }
  // Field never manufactures an internal cost from a selling rate (there is
  // no fallback markup): a missing buying rate is an explicit authority issue
  // and the quote remains unverified until the catalogue supplies it.
  return null;
}

function buildCommercialLine({
  lineItem,
  quote,
  line,
  index,
}) {
  const quantity = roundQuantity(Number(line.quantity || 0));
  const unitPrice = nullableMoney(line.unitPrice);
  const unitCost = nullableMoney(line.unitCost);
  const totalPrice = unitPrice == null ? null : roundMoney(quantity * unitPrice);
  const totalCost = unitCost == null ? null : roundMoney(quantity * unitCost);
  return {
    code: buildCompiledLineCode({
      sourceLineCode: lineItem.code,
      itemCode: line.itemCode,
      index,
    }),
    itemCode: line.itemCode,
    label: line.label,
    description: formatCatalogUnitText(line.description || line.label),
    quantity,
    unit: line.unit,
    unitPrice,
    totalPrice,
    unitCost,
    totalCost,
    sourceLineItemCode: lineItem.code || null,
    section: lineItem.section || null,
    pricingSource: line.pricingSource || "recipe",
    customerVisible: false,
    syncToCommercialAuthority: true,
    itemMeta: line.itemMeta || buildInternalItemMeta(line.itemCode, line.label, line.unit),
    trace: buildCommercialLineTrace({
      quote,
      lineItem,
      line,
      quantity,
      unitPrice,
      unitCost,
      totalPrice,
      totalCost,
    }),
  };
}

function stampPrebuiltCommercialLine({
  lineItem,
  line,
  index,
}) {
  return {
    ...line,
    code: line?.code || buildCompiledLineCode({
      sourceLineCode: lineItem.code,
      itemCode: line?.itemCode,
      index,
    }),
    sourceLineItemCode: lineItem.code || null,
    section: lineItem.section || null,
    customerVisible: false,
    syncToCommercialAuthority: line?.syncToCommercialAuthority !== false,
    itemMeta: line?.itemMeta || buildInternalItemMeta(line?.itemCode, line?.label, line?.unit),
  };
}

function buildBudgetLine({
  lineItem,
  line,
  index,
}) {
  const quantity = roundQuantity(Number(line.quantity || 0));
  const unitCost = nullableMoney(line.unitCost);
  return {
    code: `${buildCompiledLineCode({
      sourceLineCode: lineItem.code,
      itemCode: line.itemCode,
      index,
    })}-cost`,
    itemCode: line.itemCode,
    label: line.label,
    description: line.description || line.label,
    quantity,
    unit: line.unit,
    unitPrice: unitCost,
    totalPrice: unitCost == null ? null : roundMoney(quantity * unitCost),
    sourceLineItemCode: lineItem.code || null,
    section: lineItem.section || null,
    pricingSource: line.pricingSource || "recipe",
    customerVisible: false,
    itemMeta: line.itemMeta || buildInternalItemMeta(line.itemCode, line.label, line.unit),
  };
}

function stampPrebuiltBudgetLine({
  lineItem,
  line,
  index,
}) {
  return {
    ...line,
    code: line?.code || `${buildCompiledLineCode({
      sourceLineCode: lineItem.code,
      itemCode: line?.itemCode,
      index,
    })}-cost`,
    sourceLineItemCode: lineItem.code || null,
    section: lineItem.section || null,
    customerVisible: false,
    itemMeta: line?.itemMeta || buildInternalItemMeta(line?.itemCode, line?.label, line?.unit),
  };
}

function buildItemMetaFromRule(rule, lineItem) {
  if (rule?.authorityPricing?.itemCode) {
    return {
      itemName: rule.authorityPricing.itemName || rule.label || lineItem.label || "Quoted Scope",
      itemGroup: rule.authorityPricing.itemGroup || null,
      isStockItem: Boolean(rule.authorityPricing.isStockItem),
      stockUom: rule.authorityPricing.stockUom || lineItem.unit || rule.unit || "Nos",
    };
  }
  return {
    itemName: rule?.label || lineItem.quoteCatalogEntry?.label || lineItem.label || "Quoted Scope",
    itemGroup: null,
    isStockItem: false,
    stockUom: lineItem.unit || rule?.unit || "Nos",
  };
}

// Internal line metadata from the line itself; item names, groups and units
// belong to the price catalogue, not to a table here.
function buildInternalItemMeta(itemCode, label, unit) {
  return {
    itemName: label || itemCode,
    itemGroup: null,
    isStockItem: false,
    stockUom: unit || "Nos",
  };
}

function buildCompiledLineCode({
  sourceLineCode,
  itemCode,
  index,
}) {
  const base = slugify(String(sourceLineCode || "line-item"));
  return `${base}::${slugify(String(itemCode || "component"))}-${index + 1}`;
}

function resolveRuleForLineItem({ lineItem, quoteCatalog }) {
  if (!quoteCatalog?.rules?.length) return null;
  const code = extractBaseRuleCode(
    lineItem.quoteCatalogItemCode
    || lineItem.quoteCatalogEntry?.code
    || lineItem.code
  );
  return resolveQuoteCatalogRule(quoteCatalog, code);
}

function resolveOptionSelectionState({
  sourceItems,
  lineItemBreakdowns,
  optionSelections,
  acceptedOptionSelections,
}) {
  const familyBuckets = new Map();
  const nonOptionBreakdowns = [];

  lineItemBreakdowns.forEach((breakdown, index) => {
    const lineItem = sourceItems[index] || null;
    const section = String(lineItem?.section || breakdown.section || "").trim();
    if (!isMutuallyExclusiveSection(section)) {
      nonOptionBreakdowns.push(breakdown);
      return;
    }

    const familyKey = normalizeOptionFamilyKey(section);
    const familyLabel = deriveOptionFamilyLabel(section);
    if (!familyBuckets.has(familyKey)) {
      familyBuckets.set(familyKey, {
        key: familyKey,
        label: familyLabel,
        originalSection: section,
        items: [],
      });
    }
    familyBuckets.get(familyKey).items.push({
      index,
      lineItem,
      breakdown,
    });
  });

  const optionFamilies = [...familyBuckets.values()].map((family, index) => {
    const familyId = `${family.key}-${index + 1}`;
    const options = family.items.map(({ lineItem, breakdown, index: optionIndex }) => ({
      sourceLineItemCode: breakdown.sourceLineItemCode || lineItem?.code || `${familyId}-option-${optionIndex + 1}`,
      sourceLineItemLabel: breakdown.sourceLineItemLabel || lineItem?.label || `Option ${optionIndex + 1}`,
      sourceSection: breakdown.section || lineItem?.section || family.originalSection,
      sourceTotalPrice: breakdown.sourceTotalPrice,
      order: optionIndex,
      commercialLines: breakdown.commercialLines,
      budgetLines: breakdown.budgetLines,
      recipe: breakdown.recipe,
      totals: breakdown.totals,
    }));
    const defaultOption = selectDefaultFamilyOption(options);
    const displayOption = findOptionByCode(options, optionSelections?.[familyId]) || defaultOption;
    const acceptedOption = findOptionByCode(options, acceptedOptionSelections?.[familyId]) || null;
    const activeOption = acceptedOption || displayOption || defaultOption;

    return {
      id: familyId,
      key: family.key,
      label: family.label,
      originalSection: family.originalSection,
      mode: "single_select",
      required: true,
      defaultPolicy: "highest_price_then_first",
      defaultOptionCode: defaultOption?.sourceLineItemCode || null,
      displayOptionCode: displayOption?.sourceLineItemCode || null,
      acceptedOptionCode: acceptedOption?.sourceLineItemCode || null,
      activeOptionCode: activeOption?.sourceLineItemCode || null,
      options: options.map((option) => ({
        sourceLineItemCode: option.sourceLineItemCode,
        sourceLineItemLabel: option.sourceLineItemLabel,
        sourceSection: option.sourceSection,
        totalPrice: option.sourceTotalPrice,
        isDefault: option.sourceLineItemCode === defaultOption?.sourceLineItemCode,
        isDisplay: option.sourceLineItemCode === displayOption?.sourceLineItemCode,
        isAccepted: option.sourceLineItemCode === acceptedOption?.sourceLineItemCode,
        isActive: option.sourceLineItemCode === activeOption?.sourceLineItemCode,
      })),
    };
  });

  const activeOptionCodes = new Set(optionFamilies.map((family) => family.activeOptionCode).filter(Boolean));
  const selectedBreakdowns = [
    ...nonOptionBreakdowns,
    ...lineItemBreakdowns.filter((breakdown) => activeOptionCodes.has(breakdown.sourceLineItemCode)),
  ];
  const defaultSelections = optionFamilies.map((family) => ({
    familyId: family.id,
    familyLabel: family.label,
    optionCode: family.defaultOptionCode,
    optionLabel: findOptionByCode(family.options, family.defaultOptionCode)?.sourceLineItemLabel || null,
  }));
  const displaySelections = optionFamilies.map((family) => ({
    familyId: family.id,
    familyLabel: family.label,
    optionCode: family.displayOptionCode,
    optionLabel: findOptionByCode(family.options, family.displayOptionCode)?.sourceLineItemLabel || null,
  }));
  const acceptedSelections = optionFamilies
    .filter((family) => family.acceptedOptionCode)
    .map((family) => ({
      familyId: family.id,
      familyLabel: family.label,
      optionCode: family.acceptedOptionCode,
      optionLabel: findOptionByCode(family.options, family.acceptedOptionCode)?.sourceLineItemLabel || null,
    }));
  const activeSelections = optionFamilies.map((family) => ({
    familyId: family.id,
    familyLabel: family.label,
    optionCode: family.activeOptionCode,
    optionLabel: findOptionByCode(family.options, family.activeOptionCode)?.sourceLineItemLabel || null,
  }));
  const hasOptionFamilies = optionFamilies.length > 0;
  const handoffReady = hasOptionFamilies
    ? optionFamilies.every((family) => Boolean(family.acceptedOptionCode))
    : true;
  const defaultScenarioId = buildScenarioIdFromSelections(defaultSelections);
  const displayScenarioId = buildScenarioIdFromSelections(displaySelections);
  const acceptedScenarioId = handoffReady ? buildScenarioIdFromSelections(acceptedSelections) : null;
  const activeScenarioId = acceptedScenarioId || displayScenarioId || defaultScenarioId;

  return {
    optionFamilies,
    selectedBreakdowns,
    activeCustomerSubtotal: roundMoney(sum(selectedBreakdowns.map((item) => item.sourceTotalPrice))),
    selectionState: {
      hasOptionFamilies,
      optionFamilyCount: optionFamilies.length,
      defaultPolicy: "highest_price_then_first",
      defaultScenarioId,
      displayScenarioId,
      acceptedScenarioId,
      activeScenarioId,
      defaultSelections,
      displaySelections,
      acceptedSelections,
      activeSelections,
      sendable: true,
      handoffReady,
      invoiceReady: handoffReady,
      optionFamilies,
      note: hasOptionFamilies
        ? (handoffReady
            ? "Customer option selections are accepted and the quote is ready for downstream handoff."
            : "A default scenario is selected for pricing and schedule output, but at least one option family still needs acceptance before handoff or invoicing.")
        : null,
    },
  };
}

function selectDefaultFamilyOption(options) {
  return [...options].sort((left, right) => {
    if (right.sourceTotalPrice !== left.sourceTotalPrice) {
      return right.sourceTotalPrice - left.sourceTotalPrice;
    }
    return left.order - right.order;
  })[0] || null;
}

function findOptionByCode(options, code) {
  const wanted = String(code || "").trim();
  if (!wanted) return null;
  return (options || []).find((option) => option.sourceLineItemCode === wanted) || null;
}

function buildScenarioQuoteTotals({
  quote,
  activeCustomerSubtotal,
  note,
}) {
  const gstRate = Number(quote?.quoteCatalog?.gstRate || 0);
  const subtotal = roundMoney(activeCustomerSubtotal);
  const gst = subtotal == null ? null : roundMoney(subtotal * gstRate);
  return {
    ...(quote?.totals || {}),
    subtotal,
    gst,
    total: subtotal == null || gst == null ? null : roundMoney(subtotal + gst),
    _note: note || null,
  };
}

function buildScenarioTotalsNote(selectionState) {
  if (!selectionState?.hasOptionFamilies) return null;
  const selections = selectionState.acceptedSelections?.length
    ? selectionState.acceptedSelections
    : selectionState.activeSelections || [];
  if (!selections.length) return null;
  const prefix = selectionState.handoffReady
    ? "Total shown for accepted selections"
    : "Total shown for default selections";
  return `${prefix}: ${selections.map((selection) => `${selection.familyLabel}: ${selection.optionLabel}`).join(" · ")}`;
}

function buildScenarioIdFromSelections(selections) {
  const parts = (selections || [])
    .map((selection) => `${selection.familyId}:${selection.optionCode}`)
    .filter((value) => !value.endsWith(":"));
  return parts.length ? parts.join("|") : "base";
}

function normalizeMaterialOrders({
  materialOrders,
  lineItem,
}) {
  return (materialOrders || []).map((order) => ({
    ...order,
    sourceLineItemCode: lineItem?.code || order?.sourceLineItemCode || null,
    section: lineItem?.section || order?.section || null,
  }));
}

function isMutuallyExclusiveSection(section) {
  return /select one/i.test(String(section || ""));
}

function normalizeOptionFamilyKey(section) {
  return `option-family-${slugify(deriveOptionFamilyLabel(section) || section || "option")}`;
}

function deriveOptionFamilyLabel(section) {
  return String(section || "")
    .replace(/[—-]\s*select one.*$/i, "")
    .replace(/\(\s*select one.*\)$/i, "")
    .trim()
    || String(section || "").trim()
    || "Option";
}

function extractBaseRuleCode(value) {
  return String(value || "").split("__")[0] || String(value || "");
}

function buildDirectPricingIssue({
  lineItem,
  rule,
  itemCode,
  authorityProvider = null,
}) {
  const resolvedItemCode = rule?.priceCatalog?.code || rule?.authorityItemCode || rule?.authorityPricing?.itemCode || rule?.code || itemCode || lineItem?.quoteCatalogItemCode || lineItem?.code || null;
  const label = rule?.label || lineItem?.quoteCatalogEntry?.label || lineItem?.label || resolvedItemCode || "Quoted Scope";
  const authorityLabel = describeCommercialAuthority(authorityProvider);
  const reason = rule?.authorityPricing?.missingItem
    ? `${authorityLabel} item ${resolvedItemCode || "unknown"} is missing or disabled.`
    : resolvedItemCode
      ? `${authorityLabel} buying rate is missing for ${resolvedItemCode}.`
      : `No ${authorityLabel.toLowerCase()}-backed catalog rule exists for the direct commercial line.`;
  return buildCommercialPricingIssue({
    code: resolvedItemCode,
    label,
    reason,
  });
}

function buildCommercialPricingIssue({ code, label, reason }) {
  return {
    code: code || null,
    label: label || code || "Quoted Scope",
    reason,
    message: `Commercial pricing unresolved for ${label || code || "quoted scope"}: ${reason}`,
  };
}

function buildCommercialLineTrace({
  quote,
  lineItem,
  line,
  quantity,
  unitPrice,
  unitCost,
  totalPrice,
  totalCost,
}) {
  const baseTrace = line?.trace && typeof line.trace === "object" ? line.trace : {};
  const itemCode = line?.itemCode || null;
  const authorityItemCode = itemCode || lineItem?.quoteCatalogEntry?.authorityItemCode || lineItem?.quoteCatalogEntry?.authorityItemCode || null;
  const quoteCatalogId = lineItem?.quoteCatalogEntry?.quoteCatalogId || quote?.quoteCatalog?.id || null;
  const baseRuleCode = extractBaseRuleCode(
    lineItem?.quoteCatalogItemCode
    || lineItem?.quoteCatalogEntry?.code
    || lineItem?.code
  );
  const lineReferences = buildLineItemTraceReferences({
    quote,
    lineItem,
    itemCode: authorityItemCode,
    quoteCatalogId,
  });
  const quantityReferences = filterTraceReferences(lineReferences, (reference) => !isPricingTraceReference(reference));
  const pricingReferences = filterTraceReferences(lineReferences, isPricingTraceReference);
  const displayUnit = formatCatalogUnit(line?.unit, "");
  const normalized = normalizeStructuredTrace(baseTrace, {
    defaultEngine: {
      id: "quote-commercial-compiler",
      label: "Quote Commercial Compiler",
      module: "apps/field/server/quote-commercial-compiler.js",
      recipe: line?.pricingSource || "recipe",
      ruleCode: baseRuleCode || null,
      itemCode: authorityItemCode,
      pricingSource: line?.pricingSource || null,
    },
    fallbackPricingDerivation: [
      buildTraceEntry(
        "Charge total",
        `${formatTraceQuantity(quantity)} ${displayUnit} × ${formatTraceMoney(unitPrice)} / ${displayUnit || "unit"} = ${formatTraceMoney(totalPrice)}`,
        { references: pricingReferences },
      ),
      buildTraceEntry(
        "Cost total",
        `${formatTraceQuantity(quantity)} ${displayUnit} × ${formatTraceMoney(unitCost)} / ${displayUnit || "unit"} = ${formatTraceMoney(totalCost)}`,
        { references: pricingReferences },
      ),
    ],
    fallbackInputs: [
      buildTraceInput("Source line item", lineItem?.label || lineItem?.code || null, null, null, quantityReferences),
      buildTraceInput("Quantity", quantity, line?.unit || null, null, quantityReferences),
      buildTraceInput("Charge / unit", unitPrice, null, "money", pricingReferences),
      buildTraceInput("Cost / unit", unitCost, null, "money", pricingReferences),
      buildTraceInput("Rule code", baseRuleCode || null, null, null, quantityReferences),
      buildTraceInput("Authority item", authorityItemCode, null, null, pricingReferences),
    ],
    fallbackReferences: lineReferences,
    fallbackNotes: [
      line?.description || null,
      lineItem?.rationale || lineItem?.scopeSummary || null,
    ],
  });

  return {
    ...normalized,
    quantityDerivation: attachFallbackReferencesToEntries(normalized.quantityDerivation, quantityReferences),
    pricingDerivation: attachFallbackReferencesToEntries(normalized.pricingDerivation, pricingReferences),
    inputs: attachFallbackReferencesToEntries(normalized.inputs, quantityReferences),
  };
}

function buildDirectPassThroughTrace({
  quote,
  lineItem,
  rule,
  itemCode,
  quantity,
  unitPrice,
  unitCost,
  authorityProvider,
}) {
  const usingAuthorityBuyRate = rule?.authorityPricing?.buyingRate != null;
  const quoteCatalogId = lineItem?.quoteCatalogEntry?.quoteCatalogId || quote?.quoteCatalog?.id || null;
  const displayUnit = formatCatalogUnit(lineItem?.unit || rule?.unit, "");
  const quantityExpression = `${formatTraceQuantity(quantity)} ${displayUnit}`;
  const buyingRateLabel = directBuyingRateLabel(authorityProvider);
  const costExpression = usingAuthorityBuyRate
    ? `${buyingRateLabel} ${formatTraceMoney(rule.authorityPricing.buyingRate)} / ${displayUnit || "unit"}`
    : `Supplied unit cost ${formatTraceMoney(unitCost)} / ${displayUnit || "unit"}`;
  const references = buildLineItemTraceReferences({
    quote,
    lineItem,
    itemCode,
    quoteCatalogId,
  });
  const quantityReferences = filterTraceReferences(references, (reference) => !isPricingTraceReference(reference));
  const pricingReferences = filterTraceReferences(references, isPricingTraceReference);
  const itemInputLabel = directItemInputLabel(authorityProvider);
  const resolvedPricingSource = usingAuthorityBuyRate
    ? directBuyingRatePricingSource(authorityProvider)
    : "supplied_unit_cost";

  return normalizeStructuredTrace({
    engine: {
      id: "quote-commercial-compiler",
      label: "Quote Commercial Compiler",
      module: "apps/field/server/quote-commercial-compiler.js",
      recipe: "direct_pass_through",
      ruleCode: extractBaseRuleCode(
        lineItem?.quoteCatalogItemCode
        || lineItem?.quoteCatalogEntry?.code
        || lineItem?.code
      ),
      itemCode,
      pricingSource: resolvedPricingSource,
      authorityProvider: authorityProvider || null,
    },
    quantityDerivation: [
      buildTraceEntry("Quantity used", quantityExpression, { references: quantityReferences }),
    ],
    pricingDerivation: [
      buildTraceEntry("Unit cost source", costExpression, { references: pricingReferences }),
    ],
    inputs: [
      buildTraceInput("Source line item", lineItem?.label || lineItem?.code || null, null, null, quantityReferences),
      buildTraceInput("Customer unit price", unitPrice, null, "money", pricingReferences),
      buildTraceInput("Resolved unit cost", unitCost, null, "money", pricingReferences),
      buildTraceInput("Quantity", quantity, displayUnit || null, null, quantityReferences),
      buildTraceInput("Authority provider", authorityProvider || "catalog", null, null, quantityReferences),
      buildTraceInput(itemInputLabel, itemCode, null, null, pricingReferences),
    ].filter(Boolean),
    references,
    notes: [
      usingAuthorityBuyRate
        ? `Direct pass-through line priced from ${describeCommercialAuthority(authorityProvider)} buying rate.`
        : isExternalAuthorityProvider(authorityProvider)
          ? "Direct pass-through line is blocked until an authority buying rate exists."
          : isPriceCatalogAuthorityProvider(authorityProvider)
            ? "Direct pass-through line is blocked until a price catalog buying rate exists."
          : "Direct pass-through line uses the unit cost supplied with the line.",
      lineItem?.rationale || lineItem?.scopeSummary || null,
    ].filter(Boolean),
  });
}

function resolveCommercialAuthorityProvider({ quoteCatalog, quote }) {
  return normalizeCommercialAuthorityProvider(
    quoteCatalog?.commercialAuthority?.provider
    || quote?.quoteCatalog?.commercialAuthority?.provider
    || quote?.commercialAuthority?.provider
    || "catalog"
  );
}

function sum(values) {
  let total = 0;
  for (const value of values || []) {
    if (!validMoney(value)) return null;
    total += Number(value);
  }
  return total;
}

function roundMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100) / 100;
}

function nullableMoney(value) {
  return validMoney(value) ? roundMoney(Number(value)) : null;
}

function roundQuantity(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function buildLineItemTraceReferences({
  quote,
  lineItem,
  itemCode,
  quoteCatalogId,
}) {
  const refs = [];
  refs.push({
    type: "job_file",
    label: "Quote inputs JSON",
    path: "quote-inputs.json",
    title: "Structured extracted quote inputs",
  });

  if ((lineItem?.evidence || []).length) {
    refs.push({
      type: "job_file",
      label: "Transcript JSON",
      path: "transcript.json",
      title: "Structured transcript with timestamps",
    });
    for (const evidence of lineItem.evidence || []) {
      refs.push({
        type: "audio_clip",
        label: evidence.segmentId ? `Audio ${evidence.segmentId}` : "Audio clip",
        title: evidence.speaker ? `${evidence.speaker} clip` : "Transcript evidence clip",
        summary: evidence.snippet || evidence.text || null,
        start: evidence.start ?? null,
        end: evidence.end ?? null,
        index: 0,
      });
    }
  }

  if ((lineItem?.provenance || []).some((entry) => entry?.sourceType === "measurement")) {
    refs.push(
      {
        type: "job_file",
        label: "Moasure summary JSON",
        path: "moasure/parsed/latest.json",
        title: "Latest parsed Moasure summary",
      },
      {
        type: "job_file",
        label: "Moasure summary Markdown",
        path: "moasure/parsed/latest.md",
        title: "Latest parsed Moasure summary markdown",
      }
    );
  }

  if (lineItem?.breakdownSourcePlan) {
    refs.push({
      type: "job_file",
      label: "Quote breakdown source JSON",
      path: "quote-breakdown-source.json",
      title: "Normalized quote breakdown source",
    });
  }

  const authorityItemCode = itemCode || lineItem?.quoteCatalogEntry?.authorityItemCode || lineItem?.quoteCatalogEntry?.authorityItemCode || null;
  const authorityPricingMeta = lineItem?.quoteCatalogEntry?.authorityPricing || null;
  refs.push(...buildCommercialTraceReferences({
    quote,
    itemCode: authorityItemCode,
    buyingPriceRecordName: authorityPricingMeta?.buyingPriceRecordName || null,
    sellingPriceRecordName: authorityPricingMeta?.sellingPriceRecordName || null,
  }));

  if (quote?.quoteCatalog?.commercialAuthority?.provider) {
    refs.push({
      type: "job_file",
      label: "Evidence pack JSON",
      path: "evidence-pack.json",
      title: "Evidence extraction boundary and catalog authority",
    });
  }

  return refs;
}

function buildCommercialTraceReferences({
  quote,
  itemCode,
  buyingPriceRecordName = null,
  sellingPriceRecordName = null,
}) {
  const refs = [];
  const authority = resolveTraceCommercialAuthority(quote);
  const provider = resolveCommercialAuthorityProvider({ quote });
  const itemReference = buildCommercialItemReference({ itemCode, provider });
  if (itemReference) refs.push(itemReference);
  refs.push(...buildCommercialPriceReferences({
    authority,
    itemCode,
    provider,
    buyingPriceRecordName,
    sellingPriceRecordName,
  }));
  return refs;
}

function resolveTraceCommercialAuthority(quote) {
  return quote?.quoteCatalog?.commercialAuthority
    || quote?.commercialAuthority
    || null;
}

function isPricingTraceReference(reference) {
  const type = String(reference?.type || "").trim().toLowerCase();
  return type === "authority_item" || type === "authority_price_record";
}

function filterTraceReferences(references, predicate) {
  return normalizeTraceReferences(references).filter(predicate);
}

function attachFallbackReferencesToEntries(entries, references) {
  const normalizedReferences = normalizeTraceReferences(references);
  if (!normalizedReferences.length) return entries;
  return (entries || []).map((entry, index) => {
    const existing = normalizeTraceReferences(entry?.references);
    if (existing.length) return entry;
    if (index > 0) return entry;
    return {
      ...entry,
      references: normalizedReferences,
    };
  });
}

function formatTraceMoney(value) {
  const numeric = roundMoney(value);
  if (numeric == null) return "unavailable";
  return `$${numeric.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatTraceQuantity(value) {
  return roundQuantity(value).toLocaleString("en-AU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dedupeNumbers(values) {
  return [...new Set((values || []).filter((value) => Number.isFinite(Number(value)) && Number(value) > 0))];
}

function dedupeBy(values, toKey) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const key = toKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}
