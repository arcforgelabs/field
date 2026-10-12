import { WALL_RATE_CARD_ITEMS } from "./retaining-wall-items.js";

export const DEFAULT_STOCKED_STEEL_LENGTHS_MM = Object.freeze([1000, 1400, 1800, 2200]);

const STEEL_MATERIAL_META = Object.freeze({
  ibeam: {
    materialId: "ibeam_125_galv",
    baseItemCode: WALL_RATE_CARD_ITEMS.ibeam,
    label: "I-Beam 125 Galv",
  },
  cchannel: {
    materialId: "cchannel_125_galv",
    baseItemCode: WALL_RATE_CARD_ITEMS.cchannel,
    label: "C-Channel 125 Galv",
  },
});

export function buildSteelStockCatalog({
  material,
  buyMap = {},
  sellMap = {},
  fallbackCostRate = null,
  fallbackChargeRate = null,
  lengthsMm = DEFAULT_STOCKED_STEEL_LENGTHS_MM,
}) {
  const meta = STEEL_MATERIAL_META[material];
  if (!meta) return [];

  return lengthsMm
    .map((lengthMm) => {
      const lengthM = Number(lengthMm || 0) / 1000;
      const itemCode = `${meta.baseItemCode}-${Math.round(Number(lengthMm || 0))}`;
      const explicitCost = toMoney(buyMap[itemCode]);
      const explicitCharge = toMoney(sellMap[itemCode]);
      // A stock length without its own catalogue item is priced pro rata
      // from the per-metre catalogue rate; with neither it has no price.
      const derivedCost = fallbackCostRate != null ? toMoney(Number(fallbackCostRate) * lengthM) : null;
      const derivedCharge = fallbackChargeRate != null ? toMoney(Number(fallbackChargeRate) * lengthM) : null;

      return {
        itemCode,
        itemName: `${meta.label} ${Math.round(Number(lengthMm || 0))}mm`,
        label: `${meta.label} ${Math.round(Number(lengthMm || 0))}mm`,
        unit: "each",
        lengthMm: Math.round(Number(lengthMm || 0)),
        lengthM: toQuantity(lengthM),
        cost_ex_gst: explicitCost != null ? explicitCost : derivedCost,
        charge_ex_gst: explicitCharge != null ? explicitCharge : derivedCharge,
      };
    })
    .filter((entry) => entry.lengthMm > 0);
}

export function selectSteelStockForLength({
  material,
  requiredLengthM,
  rateCard,
}) {
  const meta = STEEL_MATERIAL_META[material];
  if (!meta) return null;

  const requiredMm = Math.max(0, Math.round(Number(requiredLengthM || 0) * 1000));
  const catalog = getSteelStockCatalog(rateCard, material);
  if (!catalog.length) return null;

  const selected = catalog.find((entry) => entry.lengthMm >= requiredMm) || catalog[catalog.length - 1];
  const selectedLengthM = Number(selected.lengthM || selected.lengthMm / 1000 || 0);
  const exactLengthM = toQuantity(requiredMm / 1000);
  const extraEmbedmentM = toQuantity(Math.max(0, selectedLengthM - exactLengthM));

  return {
    material,
    materialKey: meta.materialId,
    itemCode: selected.itemCode,
    itemName: selected.itemName,
    label: selected.label,
    unit: selected.unit || "each",
    exactLengthM,
    exactLengthMm: requiredMm,
    selectedLengthM: toQuantity(selectedLengthM),
    selectedLengthMm: selected.lengthMm,
    extraEmbedmentM,
    cost_ex_gst: selected.cost_ex_gst != null ? Number(selected.cost_ex_gst) : null,
    charge_ex_gst: selected.charge_ex_gst != null ? Number(selected.charge_ex_gst) : null,
  };
}

export function getSteelStockCatalog(rateCard, material) {
  const meta = STEEL_MATERIAL_META[material];
  if (!meta) return [];
  const stockLengths = rateCard?.materials?.[meta.materialId]?.stock_lengths;
  if (!Array.isArray(stockLengths) || !stockLengths.length) {
    const materialEntry = rateCard?.materials?.[meta.materialId] || {};
    return buildSteelStockCatalog({
      material,
      fallbackCostRate: materialEntry.cost_ex_gst != null ? Number(materialEntry.cost_ex_gst) : null,
      fallbackChargeRate: materialEntry.charge_ex_gst != null
        ? Number(materialEntry.charge_ex_gst)
        : null,
    });
  }
  return [...stockLengths]
    .map((entry) => ({
      ...entry,
      lengthMm: Math.round(Number(entry?.lengthMm || Number(entry?.lengthM || 0) * 1000 || 0)),
      lengthM: toQuantity(Number(entry?.lengthM || Number(entry?.lengthMm || 0) / 1000 || 0)),
      cost_ex_gst: entry?.cost_ex_gst != null ? Number(entry.cost_ex_gst) : null,
      charge_ex_gst: entry?.charge_ex_gst != null ? Number(entry.charge_ex_gst) : null,
    }))
    .filter((entry) => entry.lengthMm > 0)
    .sort((left, right) => left.lengthMm - right.lengthMm);
}

export function resolveSteelStockRateEntry(rateCard, itemCode) {
  const normalized = String(itemCode || "").trim();
  if (!normalized) return null;
  for (const material of Object.keys(STEEL_MATERIAL_META)) {
    const match = getSteelStockCatalog(rateCard, material).find((entry) => entry.itemCode === normalized);
    if (match) {
      return {
        material,
        ...match,
      };
    }
  }
  return null;
}

function toMoney(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100) / 100;
}

function toQuantity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 1000) / 1000;
}
