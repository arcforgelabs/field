// Catalogue health: data problems the operator should fix, reported without
// changing any data. The checks from the SQLite catalogue are kept (same keys
// and shapes) and joined by the ones #148 asks for: items the quote rules or
// the wall engine reference that do not exist or are archived, archived items
// still in use, active items sharing a name at different prices, `-copy`
// codes, and unit problems.
import { nameKey } from "../../shared/catalog-name-key.js";
import { DEFAULT_QUOTE_CATALOG_ID } from "../quote-catalog-ids.js";
import { listKnownDisposalItemCodes } from "../price-catalog/catalog-recipes.js";
import { resolveRuleUnitConversion } from "../price-catalog/catalog-pricing.js";
import { resolveItemRef } from "./refs.js";
import { effectivePrices } from "./rollup.js";
import { normalizeCode } from "./state.js";
import { canConvert, pricingBasisFactor, resolveUnitCode } from "./units.js";
import { catalogTypeOf, displayUnit, inactiveComponentDependencies } from "./views.js";

function buildCheck({ key, label, severity, count }) {
  return { key, label, severity, count, ok: count === 0 };
}

export function activeNameCollisionGroups(state) {
  const groups = new Map();
  for (const item of state.items.values()) {
    if (item.status !== "active") continue;
    const key = nameKey(item.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      nameKey: key,
      name: members[0].name,
      items: members.map((item) => ({ code: item.code, uid: item.uid, name: item.name })),
    }));
}

const COPY_CODE = /-copy(?:-\d+)?$/i;

/**
 * `references` lists the item codes Field's pricing reads by code (quote
 * rules, quantity rules, the rate card and the wall engine), each as
 * { code, source }. A missing or archived target is a pricing failure
 * waiting to happen, so it is reported here as well as failing closed.
 * `assemblies` are the quote catalog's recipes: a component whose item is
 * priced in a unit its quantity cannot convert to is reported too (the
 * recipe refuses to price it). `rules` are the quote rules as
 * { code, itemCode, quantityUnit }: a rule whose item is sold in a unit its
 * quantity cannot convert to is reported (the rule fails closed).
 */
export function buildCatalogHealthReport(state, { catalogId = DEFAULT_QUOTE_CATALOG_ID, references = [], assemblies = [], rules = [], generatedAt = state.now } = {}) {
  const prices = effectivePrices(state);
  const items = [...state.items.values()];
  const active = items.filter((item) => item.status === "active");
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const priceOf = (item) => prices.get(item.uid) || { cost: null, sell: null };

  const collisionGroups = activeNameCollisionGroups(state);
  const duplicateNameRows = collisionGroups
    .map((group) => ({ name_key: group.nameKey, name: group.items[0].name, count: group.items.length, items: group.items }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const duplicatePriceRows = collisionGroups.filter((group) => {
    const keys = new Set(group.items.map((member) => {
      const effective = priceOf(state.items.get(member.uid));
      return `${effective.cost}|${effective.sell}`;
    }));
    return keys.size > 1;
  });

  // Only active kits matter: an archived kit retired together with its parts
  // depends on nothing anyone can quote.
  const inactiveComponentRows = inactiveComponentDependencies(state).filter((row) => state.items.get(row.parentUid)?.status === "active");
  const costAboveSellRows = active
    .filter((item) => {
      const effective = priceOf(item);
      return effective.cost != null && effective.sell != null && effective.cost > effective.sell;
    })
    .sort(byName);
  const missingCategoryRows = active.filter((item) => !String(item.category || "").trim()).sort(byName);
  const missingPriceRows = active
    .filter((item) => priceOf(item).cost == null || priceOf(item).sell == null)
    .sort(byName);
  const computedWithoutChildrenRows = active
    .filter((item) => (item.costMode === "rollup" || item.sellMode === "rollup") && !(state.components.get(item.uid) || []).length)
    .sort(byName);
  const incompletePricingBasisRows = active
    .filter((item) => ["per_tonne", "per_load"].includes(item.pricingBasis))
    .filter((item) => !(pricingBasisFactor(state, item) > 0))
    .sort(byName);
  const disposalMissingBasisRows = [...listKnownDisposalItemCodes(catalogId)]
    .filter(Boolean)
    .map((code) => ({ ruleCode: code, item: state.items.get(state.byCode.get(normalizeCode(code))) || null }))
    .filter(({ item }) => !item || !item.pricingBasis)
    .map(({ ruleCode, item }) => ({ code: item?.code || ruleCode, name: item?.name || null, status: item?.status || null, missingItem: !item }));
  const disposalItemMissingSellPriceRows = active
    .filter((item) => item.pricingBasis != null)
    .filter((item) => priceOf(item).sell == null || priceOf(item).sell <= 0)
    .sort(byName);

  // References from pricing code to items: by uid where the configuration
  // declares one, else by legacy code (#178 step 4). Grouped by the item they
  // resolve to; an unresolved one by what it named.
  const referenceMap = new Map();
  const conflictRows = [];
  for (const reference of references) {
    const code = String(reference?.code || "").trim();
    const uid = String(reference?.uid || "").trim();
    if (!code && !uid) continue;
    const resolved = resolveItemRef(state, { uid, code });
    const key = resolved.item ? `item:${resolved.item.uid}` : `missing:${normalizeCode(code || uid)}`;
    if (!referenceMap.has(key)) referenceMap.set(key, { item: resolved.item, code: code || uid, sources: new Set(), byUid: false });
    const entry = referenceMap.get(key);
    entry.sources.add(reference.source || "pricing");
    if (resolved.by === "uid") entry.byUid = true;
    if (resolved.conflict) conflictRows.push({ item: resolved.item, code, source: reference.source || "pricing" });
  }
  const missingReferenceRows = [];
  const archivedReferenceRows = [];
  const byCodeOnlyRows = [];
  for (const reference of referenceMap.values()) {
    const item = reference.item;
    if (!item) missingReferenceRows.push({ code: reference.code, sources: [...reference.sources].sort() });
    else if (item.status !== "active") archivedReferenceRows.push({ item, sources: [...reference.sources].sort() });
    if (item && !reference.byUid) byCodeOnlyRows.push({ item, sources: [...reference.sources].sort() });
  }
  byCodeOnlyRows.sort((a, b) => byName(a.item, b.item));
  missingReferenceRows.sort((a, b) => a.code.localeCompare(b.code));
  const archivedInUseRows = new Map();
  for (const { item, sources } of archivedReferenceRows) archivedInUseRows.set(item.uid, { item, usedBy: sources });
  for (const row of inactiveComponentRows) {
    const item = state.items.get(row.childUid);
    if (!item) continue;
    if (!archivedInUseRows.has(item.uid)) archivedInUseRows.set(item.uid, { item, usedBy: [] });
    archivedInUseRows.get(item.uid).usedBy.push(`kit ${row.parentCode}`);
  }
  // Every item's own code must be one of its aliases (item_code_aliases,
  // migration 0006 keeps it so); without the row an old quote naming the
  // item by that code would still resolve today, but only by accident.
  const codesByUid = state.codesByUid || new Map();
  const codeAliasMissingRows = items
    .filter((item) => !(codesByUid.get(item.uid) || []).some((code) => normalizeCode(code) === normalizeCode(item.code)))
    .sort(byName);
  const copyCodeRows = items.filter((item) => item.status === "active" && COPY_CODE.test(item.code)).sort(byName);
  const unmappedUnitRows = items
    .filter((item) => item.status === "active" && state.units.get(item.unitCode)?.dimension === "other")
    .sort(byName);
  const componentUnitRows = [];
  for (const [parentUid, components] of state.components) {
    for (const component of components) {
      if (!component.entryUnit) continue;
      const child = state.items.get(component.childUid);
      if (!child) continue;
      if (!canConvert(state, component.entryUnit, child.unitCode, { itemUid: child.uid })) {
        componentUnitRows.push({ parent: state.items.get(parentUid), child, entryUnit: component.entryUnit });
      }
    }
  }

  const recipeUnitRows = [];
  for (const assembly of assemblies) {
    for (const component of assembly.components || []) {
      const item = resolveItemRef(state, { uid: component.itemUid, code: component.itemCode }).item;
      if (!item || item.status !== "active") continue;
      const known = Boolean(resolveUnitCode(state, component.unit));
      if (!known || !canConvert(state, component.unit, item.unitCode, { itemUid: item.uid })) {
        recipeUnitRows.push({ assembly, component, item, known });
      }
    }
  }

  const ruleUnitRows = [];
  for (const rule of rules) {
    const item = resolveItemRef(state, { uid: rule.itemUid, code: rule.itemCode }).item;
    if (!item || item.status !== "active" || !rule.quantityUnit) continue;
    const { mismatch } = resolveRuleUnitConversion(state, item, rule.quantityUnit);
    if (mismatch) ruleUnitRows.push({ rule, item, mismatch });
  }
  ruleUnitRows.sort((a, b) => a.rule.code.localeCompare(b.rule.code));

  const checks = [
    buildCheck({ key: "missing_uid", label: "Missing UID", severity: "critical", count: 0 }),
    buildCheck({ key: "code_alias_missing", label: "Code Without Alias", severity: "critical", count: codeAliasMissingRows.length }),
    buildCheck({ key: "missing_referenced_item", label: "Missing Referenced Items", severity: "critical", count: missingReferenceRows.length }),
    buildCheck({ key: "reference_uid_code_conflict", label: "Reference Uid And Code Disagree", severity: "critical", count: conflictRows.length }),
    buildCheck({ key: "reference_by_code", label: "Items Referenced Only By Code", severity: "info", count: byCodeOnlyRows.length }),
    buildCheck({ key: "archived_item_in_use", label: "Archived Items In Use", severity: "warning", count: archivedInUseRows.size }),
    buildCheck({ key: "duplicate_active_name", label: "Duplicate Active Names", severity: "warning", count: duplicateNameRows.length }),
    buildCheck({ key: "duplicate_name_price_mismatch", label: "Same Name, Different Price", severity: "warning", count: duplicatePriceRows.length }),
    buildCheck({ key: "inactive_component_dependency", label: "Inactive Component Dependencies", severity: "warning", count: inactiveComponentRows.length }),
    buildCheck({ key: "cost_above_sell", label: "Cost Above Selling", severity: "critical", count: costAboveSellRows.length }),
    buildCheck({ key: "missing_category", label: "Missing Category", severity: "info", count: missingCategoryRows.length }),
    buildCheck({ key: "missing_price", label: "Missing Price", severity: "warning", count: missingPriceRows.length }),
    buildCheck({ key: "computed_without_children", label: "Computed Without Children", severity: "warning", count: computedWithoutChildrenRows.length }),
    buildCheck({ key: "incomplete_pricing_basis", label: "Incomplete Disposal Costing Basis", severity: "critical", count: incompletePricingBasisRows.length }),
    buildCheck({ key: "disposal_item_missing_basis", label: "Disposal Item Missing Costing Basis", severity: "critical", count: disposalMissingBasisRows.length }),
    buildCheck({ key: "disposal_item_missing_sell_price", label: "Disposal Item Missing Sell Price", severity: "critical", count: disposalItemMissingSellPriceRows.length }),
    buildCheck({ key: "copy_code", label: "Copy Codes", severity: "info", count: copyCodeRows.length }),
    buildCheck({ key: "unmapped_unit", label: "Unmapped Units", severity: "warning", count: unmappedUnitRows.length }),
    buildCheck({ key: "component_unit_mismatch", label: "Component Unit Mismatch", severity: "warning", count: componentUnitRows.length }),
    buildCheck({ key: "recipe_unit_mismatch", label: "Recipe Unit Mismatch", severity: "critical", count: recipeUnitRows.length }),
    buildCheck({ key: "rule_unit_mismatch", label: "Quote Rule Unit Mismatch", severity: "critical", count: ruleUnitRows.length }),
  ];

  const issue = (key, severity, label, item, extra) => ({
    key,
    severity,
    label,
    code: item?.code ?? null,
    uid: item?.uid ?? null,
    name: item?.name ?? null,
    status: item?.status ?? null,
    ...extra,
  });

  return {
    generatedAt,
    catalogId,
    catalogVersion: state.version,
    etag: state.etag,
    summary: {
      totalItems: items.length,
      activeItems: active.length,
      archivedItems: items.filter((item) => item.status === "archived").length,
      missingUidCount: 0,
      codeAliasMissingCount: codeAliasMissingRows.length,
      missingReferencedItemCount: missingReferenceRows.length,
      referenceUidCodeConflictCount: conflictRows.length,
      referenceByCodeCount: byCodeOnlyRows.length,
      archivedItemInUseCount: archivedInUseRows.size,
      duplicateActiveNameCount: duplicateNameRows.length,
      duplicateNamePriceMismatchCount: duplicatePriceRows.length,
      inactiveComponentDependencyCount: inactiveComponentRows.length,
      costAboveSellCount: costAboveSellRows.length,
      missingCategoryCount: missingCategoryRows.length,
      missingPriceCount: missingPriceRows.length,
      computedWithoutChildrenCount: computedWithoutChildrenRows.length,
      incompletePricingBasisCount: incompletePricingBasisRows.length,
      disposalItemMissingBasisCount: disposalMissingBasisRows.length,
      disposalItemMissingSellPriceCount: disposalItemMissingSellPriceRows.length,
      copyCodeCount: copyCodeRows.length,
      unmappedUnitCount: unmappedUnitRows.length,
      componentUnitMismatchCount: componentUnitRows.length,
      recipeUnitMismatchCount: recipeUnitRows.length,
      ruleUnitMismatchCount: ruleUnitRows.length,
    },
    duplicateCensus: {
      groupCount: collisionGroups.length,
      itemCount: collisionGroups.reduce((sum, group) => sum + group.items.length, 0),
      safeToEnforce: collisionGroups.length === 0,
      groups: collisionGroups.map((group) => ({
        nameKey: group.nameKey,
        name: group.name,
        count: group.items.length,
        items: group.items.map(({ code, uid }) => ({ code, uid })),
      })),
    },
    checks,
    issues: [
      ...codeAliasMissingRows.map((item) => issue("code_alias_missing", "critical", "Code Without Alias", item, {
        message: `${item.name}'s legacy code is not recorded as an alias, so documents that name it by code are not guaranteed to find it.`,
      })),
      ...missingReferenceRows.map((row) => ({
        key: "missing_referenced_item",
        severity: "critical",
        label: "Missing Referenced Item",
        code: row.code,
        uid: null,
        name: null,
        status: "missing",
        usedBy: row.sources,
        message: `${row.sources.join(", ")} ${row.sources.length === 1 ? "prices" : "price"} with catalogue item "${row.code}", which does not exist. Quotes that need it are refused until it is added or the reference is changed.`,
      })),
      ...conflictRows.map(({ item, code, source }) => issue("reference_uid_code_conflict", "critical", "Reference Uid And Code Disagree", item, {
        usedBy: [source],
        referencedCode: code,
        message: `${source} names ${item.name} by uid but its code ${code} belongs to another item; it prices from ${item.name}. Fix the reference.`,
      })),
      ...byCodeOnlyRows.map(({ item, sources }) => issue("reference_by_code", "info", "Item Referenced Only By Code", item, {
        usedBy: sources,
        message: `${sources.join(", ")} ${sources.length === 1 ? "names" : "name"} ${item.name} only by its legacy code. It resolves through the code's alias; naming it by uid in the configuration removes the dependency on codes.`,
      })),
      ...[...archivedInUseRows.values()].map(({ item, usedBy }) => issue("archived_item_in_use", "warning", "Archived Item In Use", item, {
        usedBy,
        message: `${item.name} (${item.code}) is ${item.status} but still used by ${usedBy.join(", ")}; anything priced from it is unpriced until it is reactivated or replaced.`,
      })),
      ...duplicateNameRows.flatMap((row) => {
        const codes = row.items.map((item) => item.code);
        return row.items.map((item) => ({
          key: "duplicate_active_name",
          severity: "warning",
          label: "Duplicate Active Name",
          code: item.code,
          uid: item.uid,
          name: row.name,
          count: row.count,
          relatedCodes: codes.filter((other) => other !== item.code),
          message: `${row.count} active catalog items share this name.`,
        }));
      }),
      ...duplicatePriceRows.flatMap((group) => group.items.map((member) => {
        const item = state.items.get(member.uid);
        const effective = priceOf(item);
        return issue("duplicate_name_price_mismatch", "warning", "Same Name, Different Price", item, {
          buyPrice: effective.cost,
          sellPrice: effective.sell,
          relatedCodes: group.items.map((other) => other.code).filter((code) => code !== item.code),
          message: `${group.items.length} active items are named "${group.name}" but are not priced the same.`,
        });
      })),
      ...inactiveComponentRows.map((row) => ({
        key: "inactive_component_dependency",
        severity: "warning",
        label: "Inactive Component Dependency",
        code: row.parentCode,
        uid: row.parentUid,
        name: row.parentName,
        childCode: row.childCode,
        childName: row.childName,
        childStatus: row.childStatus,
        message: `${row.parentName || row.parentCode} depends on inactive component ${row.childName || row.childCode}.`,
      })),
      ...costAboveSellRows.map((item) => issue("cost_above_sell", "critical", "Cost Above Selling", item, {
        buyPrice: priceOf(item).cost,
        sellPrice: priceOf(item).sell,
        message: "Cost price is higher than selling price.",
      })),
      ...missingCategoryRows.map((item) => issue("missing_category", "info", "Missing Category", item, {
        catalogType: catalogTypeOf(item),
        message: "Active catalog item has no category.",
      })),
      ...missingPriceRows.map((item) => issue("missing_price", "warning", "Missing Price", item, {
        buyPrice: priceOf(item).cost,
        sellPrice: priceOf(item).sell,
        buyPriceMode: item.costMode === "rollup" ? "computed" : "manual",
        sellPriceMode: item.sellMode === "rollup" ? "computed" : "manual",
        problems: priceOf(item).problems,
        message: "Active catalog item is missing a cost or selling price.",
      })),
      ...computedWithoutChildrenRows.map((item) => issue("computed_without_children", "warning", "Computed Without Children", item, {
        buyPriceMode: item.costMode === "rollup" ? "computed" : "manual",
        sellPriceMode: item.sellMode === "rollup" ? "computed" : "manual",
        message: "Computed pricing is enabled, but no editable child items are linked.",
      })),
      ...incompletePricingBasisRows.map((item) => issue("incomplete_pricing_basis", "critical", "Incomplete Disposal Costing Basis", item, {
        pricingBasis: item.pricingBasis,
        pricingBasisFactor: pricingBasisFactor(state, item),
        message: item.pricingBasis === "per_tonne"
          ? "Disposal item is missing the density its per_tonne basis needs — it will fail closed as not-quoteable."
          : "Disposal item is missing the load capacity its per_load basis needs — it will fail closed as not-quoteable.",
      })),
      ...disposalMissingBasisRows.map((row) => ({
        key: "disposal_item_missing_basis",
        severity: "critical",
        label: "Disposal Item Missing Costing Basis",
        code: row.code,
        name: row.name,
        status: row.status,
        missingItem: row.missingItem,
        message: row.missingItem
          ? `A quote-catalog disposal rule points at "${row.code}", but no catalogue item with that code exists — it will fail closed as not-quoteable.`
          : `${row.name || row.code} is referenced as a disposal rule's item but has no pricing_basis — it will fail closed as not-quoteable.`,
      })),
      ...disposalItemMissingSellPriceRows.map((item) => issue("disposal_item_missing_sell_price", "critical", "Disposal Item Missing Sell Price", item, {
        pricingBasis: item.pricingBasis,
        sellPrice: priceOf(item).sell,
        message: priceOf(item).sell == null
          ? `${item.name || item.code} has a valid costing basis (${item.pricingBasis}) but no sell price — it will fail closed as not-quoteable rather than price at $0.`
          : `${item.name || item.code} has a valid costing basis (${item.pricingBasis}) but an authored sell price of $0 — it will fail closed as not-quoteable, not price a real $0 line.`,
      })),
      ...copyCodeRows.map((item) => issue("copy_code", "info", "Copy Code", item, {
        variantOfUid: item.variantOfUid,
        message: `${item.name} carries a "-copy" legacy code. Codes are hidden and never change; if it is a variant, link it to its original with "variant of".`,
      })),
      ...unmappedUnitRows.map((item) => issue("unmapped_unit", "warning", "Unmapped Unit", item, {
        unit: displayUnit(item),
        message: `Unit "${displayUnit(item)}" is not one of Field's units, so it cannot be converted.`,
      })),
      ...componentUnitRows.map(({ parent, child, entryUnit }) => issue("component_unit_mismatch", "warning", "Component Unit Mismatch", parent, {
        childCode: child.code,
        childName: child.name,
        message: `${parent?.name || parent?.code} enters ${child.name} in ${entryUnit}, which cannot be converted to its unit (${displayUnit(child)}).`,
      })),
      ...recipeUnitRows.map(({ assembly, component, item, known }) => issue("recipe_unit_mismatch", "critical", "Recipe Unit Mismatch", item, {
        recipe: assembly.code,
        component: component.key,
        recipeUnit: component.unit,
        unit: displayUnit(item),
        message: known
          ? `The ${assembly.code} recipe uses ${item.name} (${item.code}) per ${component.unit}, but it is priced per ${displayUnit(item)} and the catalogue has no conversion between them. Quotes that need this recipe are refused until the item's unit or a conversion is fixed.`
          : `The ${assembly.code} recipe uses ${item.name} (${item.code}) in "${component.unit}", which is not a known unit.`,
      })),
      ...ruleUnitRows.map(({ rule, item, mismatch }) => issue("rule_unit_mismatch", "critical", "Quote Rule Unit Mismatch", item, {
        rule: rule.code,
        ruleUnit: mismatch.quantityUnit,
        unit: displayUnit(item),
        message: `Quote rule ${rule.code} measures its quantity in ${mismatch.quantityUnit}, but ${item.name} (${item.code}) is sold per ${mismatch.itemUnit} and ${mismatch.reason}. Lines for this rule are refused (not relabelled) until the item's unit or a conversion is fixed.`,
      })),
    ],
  };
}
