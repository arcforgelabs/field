import { createHash } from "node:crypto";

export const APPLY_CONFIRMATION = "APPLY";

export class FieldPluginError extends Error {
  constructor(message, { code = "field_plugin_error", status = null, details = null } = {}) {
    super(message);
    this.name = "FieldPluginError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function versionOf(value) {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex").slice(0, 24);
}

export function assertFiniteNonNegative(value, field) {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new FieldPluginError(`${field} must be a finite number greater than or equal to zero`, { code: "validation_error" });
  }
}

export function pricingMetrics({ cost, price }) {
  if (cost === undefined || cost === null || price === undefined || price === null) {
    throw new FieldPluginError("cost and price are required", { code: "validation_error" });
  }
  assertFiniteNonNegative(cost, "cost");
  assertFiniteNonNegative(price, "price");
  return {
    cost,
    price,
    profit: price - cost,
    markupPercent: cost === 0 ? null : ((price - cost) / cost) * 100,
    marginPercent: price === 0 ? null : ((price - cost) / price) * 100,
  };
}

export function priceFromMarkup(cost, markupPercent) {
  if (cost === undefined || cost === null || markupPercent === undefined || markupPercent === null) {
    throw new FieldPluginError("cost and markupPercent are required", { code: "validation_error" });
  }
  assertFiniteNonNegative(cost, "cost");
  assertFiniteNonNegative(markupPercent, "markupPercent");
  return cost * (1 + markupPercent / 100);
}

export function priceFromMargin(cost, marginPercent) {
  if (cost === undefined || cost === null) throw new FieldPluginError("cost is required", { code: "validation_error" });
  assertFiniteNonNegative(cost, "cost");
  if (typeof marginPercent !== "number" || !Number.isFinite(marginPercent) || marginPercent < 0 || marginPercent >= 100) {
    throw new FieldPluginError("marginPercent must be a finite number from 0 (inclusive) to 100 (exclusive)", { code: "validation_error" });
  }
  return cost / (1 - marginPercent / 100);
}

export function requireApply({ apply = false, confirmation = null, expectedVersion = null, currentVersion, operation, before, request }) {
  const preview = {
    ok: true,
    applied: false,
    dryRun: true,
    operation,
    expectedVersion: currentVersion,
    before,
    request,
  };
  if (!apply) return preview;
  if (confirmation !== APPLY_CONFIRMATION) {
    throw new FieldPluginError(`Applying ${operation} requires confirmation exactly ${APPLY_CONFIRMATION}`, { code: "confirmation_required" });
  }
  if (!expectedVersion) {
    throw new FieldPluginError(`Applying ${operation} requires expectedVersion from a fresh dry-run`, { code: "expected_version_required" });
  }
  if (expectedVersion !== currentVersion) {
    throw new FieldPluginError(`Stale expectedVersion for ${operation}; run a new dry-run`, {
      code: "stale_version",
      details: { expectedVersion, currentVersion },
    });
  }
  return null;
}

export async function executeGuardedMutation({ params, client, signal, operation, before, endpoint, method, body, loadCurrent, loadAfter }) {
  const currentVersion = versionOf(before);
  const preview = requireApply({ ...params, currentVersion, operation, before, request: { method, endpoint, body } });
  if (preview) return preview;
  const current = await loadCurrent();
  const refreshedVersion = versionOf(current);
  if (refreshedVersion !== params.expectedVersion) {
    throw new FieldPluginError(`Stale expectedVersion for ${operation}; run a new dry-run`, {
      code: "stale_version",
      details: { expectedVersion: params.expectedVersion, currentVersion: refreshedVersion },
    });
  }
  await client.request(endpoint, { method, body, signal });
  const after = loadAfter ? await loadAfter() : await loadCurrent();
  return {
    ok: true,
    applied: true,
    dryRun: false,
    audit: auditRecord({ operation, actor: client.settings.actor, endpoint, expectedVersion: params.expectedVersion, before: current, after }),
  };
}

export function auditRecord({ operation, actor, endpoint, expectedVersion, before, after }) {
  return {
    operation,
    actor,
    endpoint,
    occurredAt: new Date().toISOString(),
    expectedVersion,
    resultingVersion: versionOf(after),
    before,
    after,
  };
}

export function validateQuote(detail) {
  const quote = detail?.quote || detail?.selectedQuote || null;
  const lineItems = quote?.lineItems || quote?.schedule?.items || [];
  const errors = [];
  const warnings = [];
  if (!quote) errors.push({ code: "quote_missing", message: "Job detail does not contain a quote." });
  if (quote && !Array.isArray(lineItems)) errors.push({ code: "line_items_invalid", message: "Quote line items are not an array." });
  if (Array.isArray(lineItems)) {
    lineItems.forEach((line, index) => {
      const price = line.unitPrice ?? line.totalPrice ?? line.price;
      const cost = line.unitCost ?? line.totalCost ?? line.cost;
      if (price != null && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
        errors.push({ code: "invalid_price", line: index, message: "Price must be non-negative." });
      }
      if (cost == null) warnings.push({ code: "cost_missing", line: index, message: "Cost is missing; margin cannot be trusted." });
      else if (!Number.isFinite(Number(cost)) || Number(cost) < 0) errors.push({ code: "invalid_cost", line: index, message: "Cost must be non-negative." });
    });
  }
  const missingInputs = detail?.quoteInputs?.missingInputs || detail?.missingInputs || [];
  if (Array.isArray(missingInputs) && missingInputs.length) {
    warnings.push({ code: "missing_inputs", count: missingInputs.length, message: "Quote has unresolved missing inputs." });
  }
  return { valid: errors.length === 0, errors, warnings, lineItemCount: Array.isArray(lineItems) ? lineItems.length : 0 };
}
