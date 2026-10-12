/**
 * Runtime policy for the Field price catalogue.
 *
 * The catalogue is a commercial authority, not an optional enhancement. The
 * only supported way to boot without it is an explicitly named emergency
 * override, and that override is deliberately unavailable to the isolated
 * verification runtime.
 */

export const PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV = "FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE";

import { buildPriceCatalogSnapshot } from "./catalog-snapshot.js";

const FALSE_ENV_VALUES = new Set(["", "0", "false", "no", "off"]);

export function isEnabledEnvValue(value) {
  return value !== undefined
    && !FALSE_ENV_VALUES.has(String(value).trim().toLowerCase());
}

export function resolvePriceCatalogStartupPolicy({
  env = process.env,
  isVerificationRuntime = false,
} = {}) {
  const overrideRequested = isEnabledEnvValue(env?.[PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV]);
  return {
    overrideRequested,
    // Verification must prove the real commercial-authority boot contract;
    // allowing it to inherit a degraded override would make the proof lane
    // pass while pricing is unavailable.
    overrideAllowed: overrideRequested && !isVerificationRuntime,
    requiresCatalog: !(overrideRequested && !isVerificationRuntime),
    isVerificationRuntime: Boolean(isVerificationRuntime),
  };
}

export function buildPriceCatalogStartupError({
  cause,
  policy = resolvePriceCatalogStartupPolicy(),
} = {}) {
  const causeMessage = String(cause?.message || cause || "unknown catalogue failure")
    .trim()
    .replace(/[.]+$/, "");
  const verificationNote = policy.isVerificationRuntime
    ? " The field-verification runtime does not permit this override."
    : "";
  const error = new Error(
    `[price-catalog] Init failed: ${causeMessage}. `
      + "Field refuses to boot without a usable price catalogue. "
      + `Set ${PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV}=1 only for an explicit emergency degraded boot; `
      + `this is an incident override, not routine configuration.${verificationNote}`
  );
  error.code = "FIELD_PRICE_CATALOG_UNAVAILABLE";
  error.cause = cause;
  error.statusCode = 503;
  return error;
}

export function resolvePriceCatalogFailure({
  cause,
  policy = resolvePriceCatalogStartupPolicy(),
} = {}) {
  const error = buildPriceCatalogStartupError({ cause, policy });
  if (policy.overrideAllowed) {
    return {
      action: "degraded",
      error,
      state: "degraded",
      available: false,
      incidentOverride: true,
      overrideEnv: PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV,
    };
  }
  return {
    action: "abort",
    error,
    state: "unavailable",
    available: false,
    incidentOverride: false,
    overrideEnv: PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV,
  };
}

/**
 * Open the PostgreSQL catalogue for the server process. Boot needs a
 * reachable catalogue with at least one active item; anything less aborts
 * boot unless the emergency override allows a degraded boot (pricing stays
 * blocked).
 *
 * Data problems inside a usable catalogue (an unpriced item, a quote rule
 * naming an item that does not exist or is archived) do not stop Field: they
 * are logged here, listed on the catalogue health page, and every quote,
 * rate card or wall build that needs one of those items is refused with the
 * item named (preflightQuotePricingAuthority, resolveWallRateCard). One bad
 * item must not take quoting, invoicing and sending offline.
 *
 * `openCatalogStore()` returns the store (server/catalog/store.js); it throws
 * when no database is configured, which is an outage like any other.
 *
 * Returns `priceCatalog` (the store, for pricing; null when boot is
 * degraded) and `catalogStore` (the store whenever the database opened, so a
 * degraded catalogue can still be edited to fix it).
 */
export async function initializePriceCatalogRuntime({
  config = {},
  policy = resolvePriceCatalogStartupPolicy(),
  isVerificationRuntime = null,
  openCatalogStore,
  refreshQuoteCatalogAuthority,
  logger = console,
} = {}) {
  if (typeof openCatalogStore !== "function") {
    throw new TypeError("initializePriceCatalogRuntime requires openCatalogStore");
  }
  if (typeof refreshQuoteCatalogAuthority !== "function") {
    throw new TypeError("initializePriceCatalogRuntime requires refreshQuoteCatalogAuthority");
  }

  void isVerificationRuntime;
  let priceCatalog = null;
  let catalogStore = null;
  let priceCatalogFailure = null;
  config.priceCatalog = null;

  const log = (level, ...args) => {
    const method = logger?.[level];
    if (typeof method === "function") method(...args);
  };

  const recordPriceCatalogFailure = (cause) => {
    const outcome = resolvePriceCatalogFailure({ cause, policy });
    if (outcome.action === "abort") {
      log("error", outcome.error.message);
      throw outcome.error;
    }
    priceCatalog = null;
    config.priceCatalog = null;
    priceCatalogFailure = outcome.error;
    const causeMessage = String(cause?.message || cause).trim().replace(/[.]+$/, "");
    log(
      "error",
      `[price-catalog] DEGRADED BOOT: commercial pricing is unavailable because ${causeMessage}. `
        + `This is an incident state enabled by ${outcome.overrideEnv}=1; `
        + "quote/rate-card pricing remains blocked until the catalogue is restored.",
    );
  };

  try {
    // Boot never provisions catalogue items: an empty catalogue is an outage
    // until an operator imports one (npm run catalog:import-legacy).
    catalogStore = await openCatalogStore();
    priceCatalog = catalogStore;
    const state = await priceCatalog.getState();
    const active = [...state.items.values()].filter((item) => item.status === "active");
    if (active.length === 0) throw new Error("price catalog has no active items");
    const unpriced = active.filter((item) => {
      const row = state.prices.get(item.uid);
      return (item.costMode === "manual" && row?.cost == null)
        || (item.sellMode === "fixed" && row?.sell == null)
        || (item.sellMode === "markup" && row?.markupPct == null);
    });
    const snapshot = buildPriceCatalogSnapshot(state, {
      quoteCatalogId: config.quoteCatalogId,
      includeRateCard: true,
    });
    const missing = snapshot.completeness?.missingPriceCodes || [];
    if (unpriced.length || missing.length) {
      log(
        "warn",
        `[price-catalog] catalogue data problems (see /pricing/health); quotes that need these items are refused: `
          + [
            unpriced.length ? `${unpriced.length} active item(s) without both buy and sell prices (${unpriced.map((item) => item.code).sort().join(", ")})` : null,
            missing.length ? `missing, archived or unpriced items referenced by pricing: ${missing.join(", ")}` : null,
          ].filter(Boolean).join("; "),
      );
    }
    config.priceCatalog = priceCatalog;
    config.priceCatalogStartupSnapshot = snapshot;
    log("log", `[price-catalog] Loaded ${active.length} items (catalogue version ${state.version})`);
  } catch (err) {
    recordPriceCatalogFailure(err);
  }

  if (priceCatalog) {
    try {
      const authority = await refreshQuoteCatalogAuthority({
        priceCatalog,
        required: false,
      });
      if (authority?.mode !== "active") {
        throw new Error(
          authority?.reason
          || authority?.error
          || `price catalog authority is ${authority?.mode || "unavailable"}`
        );
      }
    } catch (err) {
      recordPriceCatalogFailure(err);
    }
  }

  if (!priceCatalog && !priceCatalogFailure) {
    recordPriceCatalogFailure(new Error("price catalog database is unavailable"));
  }

  return { priceCatalog, catalogStore, priceCatalogFailure };
}

export function buildPriceCatalogRuntimeStatus({
  available,
  policy = resolvePriceCatalogStartupPolicy(),
  error = null,
} = {}) {
  const isAvailable = Boolean(available);
  return {
    state: isAvailable ? "ready" : "degraded",
    available: isAvailable,
    incidentOverride: !isAvailable && policy.overrideAllowed,
    overrideRequested: policy.overrideRequested,
    overrideEnv: PRICE_CATALOG_ALLOW_UNAVAILABLE_ENV,
    verificationRuntime: policy.isVerificationRuntime,
    ...(error
      ? {
          error: String(error?.cause?.message || error?.message || error),
          message: error.message,
        }
      : {}),
  };
}
