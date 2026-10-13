import {
  buildCommercialItemReference,
  buildCommercialPriceReferences,
  buildTraceEntry,
  buildTraceInput,
  isPriceCatalogAuthorityProvider,
  normalizeAuthorityBaseUrl,
  normalizeCommercialAuthorityProvider,
  normalizeStructuredTrace,
} from "./quote-trace.js";
import { getCustomerScheduleItems } from "./quote-presentation.js";
import { formatCatalogUnit, formatCatalogUnitText } from "../shared/catalog-units.js";
import { buildDisambiguatedSourceLabels } from "../shared/source-label-disambiguation.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(value) {
  return `$${Number(value || 0).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatUnit(value) {
  return formatCatalogUnit(value, "");
}

function formatUnitText(value) {
  return formatCatalogUnitText(value);
}

function formatQuantity(value) {
  return Number(value || 0).toLocaleString("en-AU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value) {
  return `${Number(value || 0).toLocaleString("en-AU", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function formatMeasurementPlanSummary(plan) {
  if (!plan?.measurements) return null;
  const grossCut = Number(plan.measurements.grossCutVolumeM3 || 0);
  const fill = Number(plan.measurements.fillVolumeM3 || 0);
  const exportVolume = Number(plan.measurements.netExportVolumeM3 || 0);
  if (!(grossCut > 0) && !(fill > 0) && !(exportVolume > 0)) return null;
  return `Measurement plan: cut ${formatQuantity(grossCut)} ${formatUnit("m3")}, fill ${formatQuantity(fill)} ${formatUnit("m3")}, export ${formatQuantity(exportVolume)} ${formatUnit("m3")}.`;
}

function resolveBreakdownContext(quote) {
  const internalPricing = quote?.internalPricing || {};
  const breakdowns = asArray(internalPricing?.lineItemBreakdowns);
  return {
    internalPricing,
    lineItems: asArray(quote?.lineItems),
    customerScheduleItems: getCustomerScheduleItems(quote),
    commercialLines: asArray(quote?.commercialLines).length
      ? asArray(quote?.commercialLines)
      : asArray(internalPricing?.commercialLines),
    budgetLines: asArray(quote?.budgetLines).length
      ? asArray(quote?.budgetLines)
      : asArray(internalPricing?.budgetLines),
    materialOrders: asArray(quote?.materialOrders).length
      ? asArray(quote?.materialOrders)
      : asArray(internalPricing?.materialOrders).length
        ? asArray(internalPricing?.materialOrders)
        : breakdowns.flatMap((breakdown) => asArray(breakdown?.materialOrders)),
    optionFamilies: asArray(quote?.selectionState?.optionFamilies).length
      ? asArray(quote?.selectionState?.optionFamilies)
      : asArray(internalPricing?.selectionState?.optionFamilies),
    selectionState: quote?.selectionState || internalPricing?.selectionState || {},
    breakdowns,
    pricingIssues: asArray(internalPricing?.pricingIssues),
  };
}

function calculateMargin(totals = {}) {
  const charge = Number(totals.charge || 0);
  const cost = Number(totals.cost || 0);
  const amount = charge - cost;
  const percent = charge > 0 ? (amount / charge) * 100 : 0;
  return { amount, percent };
}

function findBudgetLineForCommercialLine(budgetLines, commercialLine) {
  return asArray(budgetLines).find((budgetLine) => budgetLine?.code === `${commercialLine?.code}-cost`)
    || asArray(budgetLines).find((budgetLine) => budgetLine?.itemCode === commercialLine?.itemCode)
    || null;
}

function buildMarkdownTable(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `|${headers.map((header) => header.includes(":") ? header : "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function markdownRow(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function findSourceLineItem(lineItems, breakdown) {
  const sourceCode = breakdown?.sourceLineItemCode;
  if (!sourceCode) return null;
  return asArray(lineItems).find((lineItem) => lineItem?.code === sourceCode) || null;
}

function describeMissingInternalBreakdown({ lineItems, totals, quote }) {
  const hasPricedScope = asArray(lineItems).length > 0 || Number(totals?.total || 0) > 0;
  if (!hasPricedScope) {
    return "No internal commercial breakdown is available because this job does not currently have a compiled priced scope.";
  }
  return "No internal commercial breakdown was persisted for this legacy quote. Quantity provenance cannot be reconstructed from the current stored artifacts alone.";
}

function isRetainingWallBreakdown(breakdown) {
  return /^retaining_wall_|^rock_wall_/.test(String(breakdown?.recipe || ""));
}

function buildLineTrace({
  quote,
  breakdown,
  commercialLine,
  budgetLine,
  sourceContext = {},
}) {
  const authorityProvider = resolveTraceAuthorityProvider(quote);
  const itemReference = buildCommercialItemReference({
    itemCode: commercialLine?.itemCode,
    provider: authorityProvider,
  });
  const sourceLineItem = findSourceLineItem(quote?.lineItems, breakdown);
  const rawTrace = commercialLine?.trace && typeof commercialLine.trace === "object" ? commercialLine.trace : {};
  const quantity = Number(commercialLine?.quantity || 0);
  const unit = formatUnit(commercialLine?.unit);
  const unitCost = Number(commercialLine?.unitCost ?? budgetLine?.unitPrice ?? 0);
  const unitPrice = Number(commercialLine?.unitPrice || 0);
  const totalCost = Number(commercialLine?.totalCost ?? budgetLine?.totalPrice ?? quantity * unitCost);
  const totalPrice = Number(commercialLine?.totalPrice || 0);
  const trace = normalizeStructuredTrace(rawTrace, {
    defaultEngine: {
      id: "internal_breakdown",
      label: inferTraceEngineLabel(breakdown),
      module: null,
      recipe: breakdown?.recipe || null,
      ruleCode: sourceLineItem?.quoteCatalogItemCode || sourceLineItem?.quoteCatalogEntry?.code || null,
      pricingSource: commercialLine?.pricingSource || null,
    },
    fallbackQuantityDerivation: [
      buildTraceEntry(
        "Quantity used",
        `Internal commercial line uses ${formatQuantity(quantity)}${unit ? ` ${unit}` : ""} from ${sourceLineItem?.label || breakdown?.sourceLineItemLabel || breakdown?.sourceLineItemCode || "the quoted source line item"}.`,
        {
          references: [{
            type: "job_file",
            label: "Quote inputs JSON",
            path: "quote-inputs.json",
            title: "Structured quote inputs",
          }],
        },
      ),
    ],
    fallbackPricingDerivation: [
      buildTraceEntry(
        "Charge total",
        `${formatQuantity(quantity)} ${unit} × ${formatMoney(unitPrice)} / ${unit || "unit"} = ${formatMoney(totalPrice)}`,
        {
          references: itemReference ? [itemReference] : [],
        },
      ),
      buildTraceEntry(
        "Cost total",
        `${formatQuantity(quantity)} ${unit} × ${formatMoney(unitCost)} / ${unit || "unit"} = ${formatMoney(totalCost)}`,
        {
          references: itemReference ? [itemReference] : [],
        },
      ),
    ],
    fallbackInputs: [
      buildTraceInput(
        "Source line item",
        sourceLineItem?.label || breakdown?.sourceLineItemLabel || breakdown?.sourceLineItemCode || "Quoted line item",
        null,
        null,
        [{
          type: "job_file",
          label: "Quote inputs JSON",
          path: "quote-inputs.json",
          title: "Structured quote inputs",
        }],
      ),
      buildTraceInput("Quantity", quantity, unit),
      buildTraceInput("Charge / unit", unitPrice, null, "money"),
      buildTraceInput("Cost / unit", unitCost, null, "money"),
      ...(commercialLine?.itemCode
        ? [buildTraceInput(
          buildCommercialItemInputLabel(authorityProvider),
          commercialLine.itemCode,
          null,
          null,
          itemReference ? [itemReference] : []
        )]
        : []),
    ],
    fallbackReferences: buildFallbackTraceReferences({
      quote,
      sourceLineItem,
      commercialLine,
      breakdown,
      sourceContext,
    }),
    fallbackNotes: [
      commercialLine?.description || commercialLine?.label || null,
      sourceLineItem?.rationale || sourceLineItem?.scopeSummary || null,
    ],
  });

  return {
    ...trace,
    sourceLineItem,
  };
}

function inferTraceEngineLabel(breakdown) {
  if (isRetainingWallBreakdown(breakdown)) return "Retaining Wall Engine";
  if (String(breakdown?.recipe || "") === "direct_pass_through") return "Quote Commercial Compiler";
  if (/_option$/.test(String(breakdown?.recipe || ""))) return "Quantity Rule Engine";
  return "Internal Pricing Engine";
}

function resolveTraceAuthorityProvider(quote) {
  return normalizeCommercialAuthorityProvider(
    quote?.quoteCatalog?.commercialAuthority?.provider
    || quote?.commercialAuthority?.provider
    || "catalog"
  );
}

function buildCommercialItemInputLabel(provider) {
  if (isPriceCatalogAuthorityProvider(provider)) return "Price catalog item";
  return provider.startsWith("price_catalog") ? "External authority item" : "Catalog item";
}

function buildFallbackTraceReferences({
  quote,
  sourceLineItem,
  commercialLine,
  breakdown,
  sourceContext,
}) {
  const refs = [];
  const authorityProvider = resolveTraceAuthorityProvider(quote);
  if (sourceLineItem) {
    refs.push({
      type: "job_file",
      label: "Quote inputs JSON",
      path: "quote-inputs.json",
      title: "Structured quote inputs",
    });
    if (asArray(sourceLineItem.evidence).length) {
      refs.push({
        type: "job_file",
        label: "Transcript JSON",
        path: "transcript.json",
        title: "Transcript with timestamps",
      });
      for (const evidence of asArray(sourceLineItem.evidence)) {
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
  }

  if (commercialLine?.itemCode) {
    const itemReference = buildCommercialItemReference({
      itemCode: commercialLine.itemCode,
      provider: authorityProvider,
    });
    if (itemReference) refs.push(itemReference);
    refs.push(...buildFallbackCommercialPriceReferences({
      quote,
      itemCode: commercialLine.itemCode,
      sourceContext,
    }));
  }

  const hasMeasurementSignal = isRetainingWallBreakdown(breakdown)
    || asArray(sourceLineItem?.provenance).some((entry) => entry?.sourceType === "measurement");
  if (hasMeasurementSignal) {
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
    for (const ref of asArray(sourceContext?.moasureRawFiles)) {
      refs.push(ref);
    }
  }

  if (sourceLineItem?.breakdownSourcePlan) {
    refs.push({
      type: "job_file",
      label: "Quote breakdown source JSON",
      path: "quote-breakdown-source.json",
      title: "Normalized quote breakdown source",
    });
  }

  if (isRetainingWallBreakdown(breakdown)) {
    refs.push(
      { type: "job_file", label: "Wall design JSON", path: "wall-design.json", title: "Retaining wall design spec" },
      { type: "job_file", label: "Bay heights JSON", path: "bay-heights.json", title: "Extracted retaining wall bay heights" },
      { type: "job_file", label: "Bay model JSON", path: "bay-model.json", title: "Computed retaining wall bay model" }
    );
  }

  return refs;
}

function buildFallbackCommercialPriceReferences({
  quote,
  itemCode,
  sourceContext,
}) {
  const authority = quote?.quoteCatalog?.commercialAuthority
    || quote?.commercialAuthority
    || null;
  const provider = resolveTraceAuthorityProvider(quote);
  if (isPriceCatalogAuthorityProvider(provider) && !sourceContext?.priceCatalogBase) return [];
  const authorityBaseUrl = normalizeAuthorityBaseUrl(
    sourceContext?.authorityBaseUrl
    || authority?.publicBaseUrl
    || authority?.baseUrl
  );
  if (provider.startsWith("price_catalog") && !authorityBaseUrl) return [];

  return buildCommercialPriceReferences({
    authority,
    itemCode,
    provider,
  });
}

function resolveReferenceHref(reference, sourceContext = {}) {
  if (!reference) return null;
  if (reference.type === "job_file" && sourceContext.sourceFileBase && reference.path) {
    return `${sourceContext.sourceFileBase}path=${encodeURIComponent(reference.path)}`;
  }
  if (reference.type === "job_file" && reference.path) {
    return reference.path;
  }
  if (reference.type === "audio_clip" && sourceContext.audioBase) {
    const index = reference.index ?? 0;
    const clip = typeof reference.start === "number" || typeof reference.end === "number"
      ? `#t=${Math.max(0, Number(reference.start || 0))}${typeof reference.end === "number" ? `,${Math.max(0, Number(reference.end))}` : ""}`
      : "";
    return `${sourceContext.audioBase}&index=${encodeURIComponent(String(index))}${clip}`;
  }
  if (reference.type === "app_path" && reference.path) {
    return reference.path;
  }
  if ((reference.type === "price_catalog_item" || reference.type === "catalog_item") && sourceContext.priceCatalogBase && reference.itemCode) {
    return `${sourceContext.priceCatalogBase}/items/${encodeURIComponent(reference.itemCode)}`;
  }
  if (reference.type === "authority_price_record" && sourceContext.authorityBaseUrl) {
    const base = normalizeAuthorityBaseUrl(sourceContext.authorityBaseUrl);
    if (reference.priceRecordName) {
      return `${base}/app/item-price/${encodeURIComponent(reference.priceRecordName)}`;
    }
    if (reference.itemCode) {
      return `${base}/app/item/${encodeURIComponent(reference.itemCode)}`;
    }
  }
  if (reference.type === "authority_item" && sourceContext.authorityBaseUrl && reference.itemCode) {
    return `${normalizeAuthorityBaseUrl(sourceContext.authorityBaseUrl)}/app/item/${encodeURIComponent(reference.itemCode)}`;
  }
  return null;
}
export function buildInternalBreakdownMarkdown({ meta = {}, quote = {} }) {
  const {
    internalPricing,
    lineItems,
    customerScheduleItems,
    commercialLines,
    budgetLines,
    materialOrders,
    optionFamilies,
    selectionState,
    breakdowns,
    pricingIssues,
  } = resolveBreakdownContext(quote);
  const totals = quote?.totals || {};
  const missingInternalBreakdownMessage = describeMissingInternalBreakdown({
    lineItems,
    totals,
    quote,
  });
  const internalTotals = internalPricing?.totals || {
    charge: commercialLines.reduce((sum, line) => sum + Number(line?.totalPrice || 0), 0),
    cost: budgetLines.reduce((sum, line) => sum + Number(line?.totalPrice || 0), 0),
  };
  const grossMargin = calculateMargin(internalTotals);
  const breakdownLabelMeta = buildDisambiguatedSourceLabels(breakdowns, {
    getLabel: (breakdown) => breakdown?.sourceLineItemLabel,
    getSection: (breakdown) => breakdown?.sourceSection ?? breakdown?.section ?? findSourceLineItem(lineItems, breakdown)?.section,
    getCode: (breakdown) => breakdown?.sourceLineItemCode,
  });
  const lines = [];
  const ln = (value = "") => lines.push(value);

  ln(`# Internal Pricing Breakdown — ${meta.title || meta.label || meta.id || "Quote"}`);
  ln();
  ln(`**Quote:** ${quote?.quoteNumber || meta.quoteNumber || "N/A"} | **Job:** ${quote?.jobNumber || meta.jobNumber || "N/A"}`);
  ln(`**Generated:** ${new Date().toISOString().slice(0, 10)} | **INTERNAL ONLY — NOT FOR CUSTOMER**`);
  ln();

  ln("## Customer Totals");
  ln();
  ln(buildMarkdownTable(
    ["", "Amount"],
    [
      ["Subtotal", markdownRow(formatMoney(totals?.subtotal))],
      ["GST", markdownRow(formatMoney(totals?.gst))],
      ["**Total**", `**${markdownRow(formatMoney(totals?.total))}**`],
    ]
  ));
  if (totals?._note) {
    ln();
    ln(`*${totals._note}*`);
  }
  ln();

  ln("## Internal Summary");
  ln();
  ln(buildMarkdownTable(
    ["", "Amount"],
    [
      ["Internal charge", markdownRow(formatMoney(internalTotals.charge))],
      ["Internal cost", markdownRow(formatMoney(internalTotals.cost))],
      ["**Gross margin**", `**${markdownRow(formatMoney(grossMargin.amount))}**`],
      ["**Margin %**", `**${markdownRow(formatPercent(grossMargin.percent))}**`],
    ]
  ));
  ln();

  if (internalPricing?.note) {
    ln(`> ${internalPricing.note}`);
    ln();
  }

  if (pricingIssues.length) {
    ln("## Pricing Issues");
    ln();
    for (const issue of pricingIssues) {
      ln(`- ${issue?.code || "pricing"}: ${issue?.reason || issue?.message || "Unknown pricing issue"}`);
    }
    ln();
  }

  if (selectionState?.hasOptionFamilies && optionFamilies.length) {
    ln("## Option State");
    ln();
    ln(`Mode: ${internalPricing?.mode || "?"} | Handoff ready: ${selectionState?.handoffReady ? "Yes" : "No"}`);
    if (selectionState?.note) {
      ln();
      ln(selectionState.note);
    }
    ln();
    for (const family of optionFamilies) {
      ln(`**${family?.label || family?.id || "Option Family"}**`);
      for (const option of asArray(family?.options)) {
        const flags = [
          option?.isDefault ? "default" : null,
          option?.isDisplay ? "display" : null,
          option?.isAccepted ? "accepted" : null,
          option?.isActive ? "active" : null,
        ].filter(Boolean).join(", ");
        ln(`- ${option?.sourceLineItemLabel || option?.sourceLineItemCode || "Option"}: ${formatMoney(option?.totalPrice)}${flags ? ` [${flags}]` : ""}`);
      }
      ln();
    }
  }

  // Customer-Facing Line Items intentionally omitted from internal breakdown
  // — available via the quote presentation organizer and PDF.

  if (materialOrders.length) {
    ln("## Material Orders");
    ln();
    ln("Procurement-facing quantities derived from the current selected scenario.");
    ln();
    const mdOrderGroups = new Map();
    for (const order of materialOrders) {
      const key = order?.itemCode || order?.label || "unknown";
      if (!mdOrderGroups.has(key)) {
        mdOrderGroups.set(key, { itemCode: order.itemCode, label: order.label, unit: formatUnit(order.unit), unitCost: order.unitCost, unitPrice: order.unitPrice, totalQty: 0, sources: [] });
      }
      const group = mdOrderGroups.get(key);
      group.totalQty += Number(order.quantity || 0);
      group.sources.push({ section: order.section, quantity: order.quantity, sourceLineItemCode: order.sourceLineItemCode });
    }
    ln(buildMarkdownTable(
      ["Item Code", "Label", "Total Qty", "Unit", "Cost/Unit", "Charge/Unit", "Total Cost", "Total Charge"],
      [...mdOrderGroups.values()].map((group) => [
        markdownRow(group.itemCode || ""),
        markdownRow(group.label || ""),
        markdownRow(formatQuantity(group.totalQty)) + (group.sources.length > 1 ? ` (${group.sources.length})` : ""),
        markdownRow(group.unit || ""),
        markdownRow(group.unitCost == null ? "" : formatMoney(group.unitCost)),
        markdownRow(group.unitPrice == null ? "" : formatMoney(group.unitPrice)),
        markdownRow(group.unitCost == null ? "" : formatMoney(group.unitCost * group.totalQty)),
        markdownRow(group.unitPrice == null ? "" : formatMoney(group.unitPrice * group.totalQty)),
      ])
    ));
    ln();
    for (const [, group] of mdOrderGroups.entries()) {
      ln(`<details>`);
      ln(`<summary>${group.label || group.itemCode} — ${formatQuantity(group.totalQty)} ${group.unit || ""} from ${group.sources.length} section${group.sources.length === 1 ? "" : "s"}</summary>`);
      ln();
      ln(buildMarkdownTable(
        ["Section", "Qty", "Source Line"],
        group.sources.map((s) => [
          markdownRow(s.section || ""),
          markdownRow(formatQuantity(s.quantity)),
          markdownRow(s.sourceLineItemCode || ""),
        ])
      ));
      ln(`</details>`);
      ln();
    }
  }

  if (breakdowns.length) {
    ln("## Internal Breakdowns");
    ln();
    for (const [index, breakdown] of breakdowns.entries()) {
      const breakdownMargin = calculateMargin(breakdown?.totals || {});
      const sourceLineItem = findSourceLineItem(lineItems, breakdown);
      const measurementPlanSummary = formatMeasurementPlanSummary(sourceLineItem?.breakdownSourcePlan);
      ln(`### ${breakdownLabelMeta[index]?.displayLabel || breakdown?.sourceLineItemLabel || breakdown?.sourceLineItemCode || "Quoted line item"}`);
      ln();
      ln(
        `Recipe: \`${breakdown?.recipe || "unknown"}\` | `
        + `Customer price: ${formatMoney(breakdown?.sourceTotalPrice)} | `
        + `Internal charge: ${formatMoney(breakdown?.totals?.charge)} | `
        + `Cost: ${formatMoney(breakdown?.totals?.cost)} | `
        + `**Margin: ${formatMoney(breakdownMargin.amount)} (${formatPercent(breakdownMargin.percent)})**`
      );
      if (breakdown?.note) {
        ln();
        ln(`_${breakdown.note}_`);
      }
      if (measurementPlanSummary) {
        ln();
        ln(`_${measurementPlanSummary}_`);
      }
      ln();
      ln(buildMarkdownTable(
        ["Item Code", "Description", "Qty", "Unit", "Cost/Unit", "Charge/Unit", "Cost Total", "Charge Total"],
        asArray(breakdown?.commercialLines).map((commercialLine) => {
          const budgetLine = findBudgetLineForCommercialLine(breakdown?.budgetLines, commercialLine);
          const unitCost = commercialLine?.unitCost ?? budgetLine?.unitPrice ?? 0;
          const totalCost = commercialLine?.totalCost ?? budgetLine?.totalPrice ?? (Number(commercialLine?.quantity || 0) * Number(unitCost || 0));
          return [
            markdownRow(commercialLine?.itemCode || ""),
            markdownRow(formatUnitText(commercialLine?.description || commercialLine?.label || "")),
            markdownRow(formatQuantity(commercialLine?.quantity)),
            markdownRow(formatUnit(commercialLine?.unit)),
            markdownRow(formatMoney(unitCost)),
            markdownRow(formatMoney(commercialLine?.unitPrice)),
            markdownRow(formatMoney(totalCost)),
            markdownRow(formatMoney(commercialLine?.totalPrice)),
          ];
        })
      ));
      ln();
      ln("#### Line Traces");
      ln();
      for (const commercialLine of asArray(breakdown?.commercialLines)) {
        const budgetLine = findBudgetLineForCommercialLine(breakdown?.budgetLines, commercialLine);
        const trace = buildLineTrace({
          quote,
          breakdown,
          commercialLine,
          budgetLine,
        });
        ln(`- **${commercialLine?.itemCode || "line"}** ${formatUnitText(commercialLine?.description || commercialLine?.label || "")}`);
        if (trace.quantityDerivation.length) {
          ln("  Quantity Derivation:");
          for (const entry of trace.quantityDerivation) {
            ln(`  - ${entry.label}: ${formatUnitText(entry.expression)}`);
            if (entry.note) ln(`    Note: ${formatUnitText(entry.note)}`);
            if (entry.references?.length) {
              ln(`    Sources: ${entry.references.map((reference) => reference.label || reference.title || reference.path || reference.itemCode || "Reference").join(" · ")}`);
            }
          }
        }
        if (trace.inputs.length) {
          ln("  Consumed Inputs:");
          for (const input of trace.inputs) {
            ln(`  - ${input.label}: ${input.value}`);
            if (input.references?.length) {
              ln(`    Sources: ${input.references.map((reference) => reference.label || reference.title || reference.path || reference.itemCode || "Reference").join(" · ")}`);
            }
          }
        }
        if (trace.references.length) {
          ln("  Evidence & Sources:");
          for (const reference of trace.references) {
            const href = resolveReferenceHref(reference);
            const label = reference.label || reference.title || reference.path || reference.itemCode || "Reference";
            ln(`  - ${label}${href ? `: ${href}` : ""}`);
          }
        }
        if (trace.pricingDerivation.length) {
          ln("  Pricing Math:");
          for (const entry of trace.pricingDerivation) {
            ln(`  - ${entry.label}: ${formatUnitText(entry.expression)}`);
            if (entry.note) ln(`    Note: ${formatUnitText(entry.note)}`);
            if (entry.references?.length) {
              ln(`    Sources: ${entry.references.map((reference) => reference.label || reference.title || reference.path || reference.itemCode || "Reference").join(" · ")}`);
            }
          }
        }
        ln("  Engine / Rule / Module:");
        ln(`  - Engine: ${trace.engine.label || "Internal Pricing Engine"}`);
        if (trace.engine.recipe) ln(`  - Recipe: ${trace.engine.recipe}`);
        if (trace.engine.ruleCode) ln(`  - Rule / source code: ${trace.engine.ruleCode}`);
        if (trace.engine.pricingSource) ln(`  - Pricing source: ${trace.engine.pricingSource}`);
        if (trace.engine.module) ln(`  - Module: ${trace.engine.module}`);
        if (trace.notes.length) {
          ln("  Notes:");
          for (const note of trace.notes) {
            ln(`  - ${formatUnitText(note)}`);
          }
        }
        if (trace.components.length) {
          ln("  Components:");
          for (const component of trace.components) {
            ln(`  - ${component.title}`);
            for (const entry of component.quantityDerivation || []) {
              ln(`    - ${entry.label}: ${formatUnitText(entry.expression)}`);
            }
          }
        }
        ln();
      }
    }
  } else if (commercialLines.length) {
    ln("## Commercial Lines");
    ln();
    ln(buildMarkdownTable(
      ["Item Code", "Label", "Qty", "Unit", "Unit Price", "Total"],
      commercialLines.map((line) => [
        markdownRow(line?.itemCode || ""),
        markdownRow(line?.label || ""),
        markdownRow(formatQuantity(line?.quantity)),
        markdownRow(formatUnit(line?.unit)),
        markdownRow(formatMoney(line?.unitPrice)),
        markdownRow(formatMoney(line?.totalPrice)),
      ])
    ));
    ln();
  } else {
    ln("## Internal Breakdowns");
    ln();
    ln(`> ${missingInternalBreakdownMessage}`);
    ln();
  }

  if (budgetLines.length) {
    ln("## Budget Summary");
    ln();
    ln(buildMarkdownTable(
      ["", "Amount"],
      [
        ["Total cost (budget)", markdownRow(formatMoney(budgetLines.reduce((sum, line) => sum + Number(line?.totalPrice || 0), 0)))],
        ["Total charge (internal)", markdownRow(formatMoney(commercialLines.reduce((sum, line) => sum + Number(line?.totalPrice || 0), 0)))],
        ["**Gross margin**", `**${markdownRow(formatMoney(grossMargin.amount))}**`],
        ["**Margin %**", `**${markdownRow(formatPercent(grossMargin.percent))}**`],
      ]
    ));
    ln();
  }

  if (internalPricing?.coverage) {
    ln("## Coverage");
    ln();
    for (const [key, value] of Object.entries(internalPricing.coverage)) {
      ln(`- ${key}: ${value}`);
    }
    ln();
  }

  return `${lines.join("\n")}\n`;
}
