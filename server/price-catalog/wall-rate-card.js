import {
  buildRateCardFromPriceMaps,
  RETAINING_WALL_REQUIRED_PRICE_CODES,
  WALL_RATE_CARD_ITEMS,
} from "../retaining-wall-rate-card.js";
import { buildPriceCatalogSnapshot, assertPriceCatalogSnapshotComplete } from "./catalog-snapshot.js";
import { FALLBACK_ADJUSTMENT_ITEM_CODE } from "../retaining-wall-commercial.js";

export { RETAINING_WALL_REQUIRED_PRICE_CODES };

/**
 * Derive the money dependencies actually emitted by a generated wall model.
 * The static baseline protects the ordinary sleeper recipe; this projection
 * closes the conditional paths (rock material, APC delivery minimum, and any
 * future resource line added by the design) without making those paths rely
 * on a hand-maintained allowlist alone.
 */
export function resolveWallRequiredPriceCodes({ model = null, design = null } = {}) {
  const codes = new Set(RETAINING_WALL_REQUIRED_PRICE_CODES);
  for (const line of [
    ...(model?.bays || []).flatMap((bay) => bay?.resource_lines || []),
    ...(model?.ancillary_lines || []),
  ]) {
    const code = String(line?.itemCode || "").trim();
    if (!code) continue;
    codes.add(code === FALLBACK_ADJUSTMENT_ITEM_CODE ? WALL_RATE_CARD_ITEMS.apcDeliveryMinimum : code);
  }
  const rock = design?.options?.rock_wall || design?.options?.bluestone;
  if (rock?.enabled !== false && rock) {
    codes.add(String(rock.materials?.rock_item_code || WALL_RATE_CARD_ITEMS.bluestoneLarge).trim());
  }
  return [...codes].filter(Boolean);
}

/**
 * Resolve retaining-wall rates from the live commercial authority only
 * (`priceCatalog`: the catalogue store, server/catalog/store.js). There is
 * no cached or default rate card: when the catalogue cannot supply every
 * rate the wall needs, the result is `rateCard: null` with an error naming
 * the missing items, and wall pricing stays blocked.
 */
export async function resolveWallRateCard({
  priceCatalog = null,
  pricingSnapshot = null,
  requiredCodes = null,
  model = null,
  design = null,
} = {}) {
  if (!priceCatalog && !pricingSnapshot?.buyMap) {
    return {
      rateCard: null,
      source: "unavailable",
      error: "Price catalog database is unavailable; wall pricing is blocked.",
    };
  }

  try {
    const snapshot = pricingSnapshot?.buyMap
      ? pricingSnapshot
      : buildPriceCatalogSnapshot(await priceCatalog.getState());
    assertPriceCatalogSnapshotComplete(snapshot, {
      requiredCodes: requiredCodes || resolveWallRequiredPriceCodes({ model, design }),
    });
    const rateCard = buildRateCardFromPriceMaps({
      buyMap: snapshot.buyMap,
      sellMap: snapshot.sellMap,
      _fetchedAt: snapshot.fetchedAt,
      _source: "price_catalog",
    });
    return { rateCard, source: "price_catalog", pricingSnapshot: snapshot };
  } catch (error) {
    return {
      rateCard: null,
      source: "unavailable",
      error: `Price catalog rate card unavailable: ${error.message}`,
    };
  }
}
