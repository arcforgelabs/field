// Catalogue-linked quote rows: the frozen line, the draft diff and its apply.
import assert from "node:assert/strict";
import test from "node:test";

import { createTestDb } from "./db-runtime/index.js";
import { openCatalogStore } from "./catalog/index.js";
import {
  applyQuoteCatalogChanges,
  buildCatalogQuoteLine,
  buildKitComponentNode,
  catalogLinkFields,
  computeQuoteCatalogChanges,
  convertRate,
  upgradeOrganizerCatalogLinks,
} from "./quote-catalog-sync.js";
import { normalizePresentationOrganizer, resolvePresentationOrganizer } from "./quote-presentation-organizer.js";
import { kitSnapshot } from "./catalog/rollup.js";
import { calculatePresentationScheduleTotals } from "../shared/quote-presentation-renderer.js";

async function freshStore(t) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  return openCatalogStore({ db: handle.db });
}

async function item(store, { code, name = code, unit = "each", buy = null, sell = null, mode = "manual", ...rest }) {
  return store.createItem({
    code,
    name,
    unit,
    buy_price: buy,
    sell_price: sell,
    buy_price_mode: mode,
    sell_price_mode: mode,
    catalog_type: "goods_service",
    ...rest,
  });
}

// A row the way the quote editor adds a leaf catalogue item.
function leafRow(line, { quantity = 1, unit = line.unit } = {}) {
  return {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: `manual-catalog-${line.code.toLowerCase()}`,
    labelOverride: line.name,
    amountVisible: true,
    quantity,
    unit,
    sellRate: convertRate(line.sellRate, line.unit, unit),
    buyRate: convertRate(line.buyRate, line.unit, unit),
    rateMode: "catalog-linked",
    ...catalogLinkFields(line, { unit }),
  };
}

// A kit row and its component rows, the way the quote editor adds a kit
// (client buildCatalogQuoteRows): the kit row freezes its components.
function kitRows(line, parentId = "manual:kit") {
  const nodes = {};
  const children = line.components.map((component, index) => {
    const id = `${parentId}:child-${index}`;
    nodes[id] = buildKitComponentNode({ parentCode: line.code, parentUid: line.itemUid, component, nonce: "n0" });
    return id;
  });
  nodes[parentId] = {
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: "manual-catalog-kit",
    labelOverride: line.name,
    amountVisible: true,
    quantity: 1,
    unit: line.unit,
    sellRate: 0,
    buyRate: 0,
    rateMode: "catalog-linked",
    ...catalogLinkFields(line, { kitComponents: true }),
    children,
  };
  return nodes;
}

function organizerOf(nodes, root = Object.keys(nodes).filter((id) => !Object.values(nodes).some((node) => (node.children || []).includes(id)))) {
  return { root, nodes };
}

test("a quote line freezes the item's uid, price id, price key and kit components in entry units", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "EXCAVATOR-HOUR", name: "Excavator", unit: "hour", buy: 180, sell: 300 });
  await item(store, { code: "GRAVEL", name: "Gravel", unit: "m3", buy: 40, sell: 60 });
  await item(store, { code: "DRAIN-KIT", name: "Drain kit", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN-KIT", childCode: "EXCAVATOR-HOUR", quantity: 0.5 });
  await store.addChild({ parentCode: "DRAIN-KIT", childCode: "GRAVEL", quantity: 0.2 });

  const state = await store.getState();
  const leaf = buildCatalogQuoteLine(state, "GRAVEL");
  assert.equal(leaf.sellRate, 60);
  assert.equal(leaf.buyRate, 40);
  assert.ok(leaf.priceId, "a leaf records its item_prices row");
  assert.match(leaf.priceKey, /^pk_/);
  assert.equal(leaf.components.length, 0);

  const kit = buildCatalogQuoteLine(state, "drain-kit");
  assert.equal(kit.code, "DRAIN-KIT");
  assert.equal(kit.sellRate, 0.5 * 300 + 0.2 * 60);
  assert.equal(kit.priceId, null, "a rolled-up kit has no single price row");
  assert.equal(kit.components.length, 2);
  const excavator = kit.components.find((component) => component.code === "EXCAVATOR-HOUR");
  assert.equal(excavator.unit, "min", "hours are entered in minutes, as the editor does");
  assert.equal(excavator.quantity, 30);
  assert.equal(excavator.sellRate, 5, "the rate is converted to the entry unit");
  assert.equal(buildCatalogQuoteLine(state, "NOPE"), null);
});

test("organizer normalization keeps a row's catalogue link and frozen catalogue rate", () => {
  const organizer = normalizePresentationOrganizer({
    root: ["manual:a"],
    nodes: {
      "manual:a": {
        kind: "source",
        origin: "manual",
        sourceCode: "manual-a",
        labelOverride: "Gravel",
        quantity: 2,
        unit: "metres",
        sellRate: 70,
        buyRate: 40,
        rateMode: "manual",
        catalogItemCode: "GRAVEL",
        catalogItemUid: "itm_1",
        catalogPriceId: 12,
        catalogPriceKey: "pk_abc",
        catalogSellRate: 60,
        catalogBuyRate: 40,
        catalogName: "Gravel",
        catalogUnit: "m",
        catalogQuantity: 0.2,
        catalogComponentOf: "itm_kit",
        catalogPriceSource: "bogus",
      },
    },
  });
  const node = organizer.nodes["manual:a"];
  assert.equal(node.catalogItemUid, "itm_1");
  assert.equal(node.catalogPriceId, 12);
  assert.equal(node.catalogPriceKey, "pk_abc");
  assert.equal(node.catalogSellRate, 60, "the catalogue rate is no longer discarded on save");
  assert.equal(node.catalogBuyRate, 40);
  assert.equal(node.catalogUnit, "m");
  assert.equal(node.catalogQuantity, 0.2);
  assert.equal(node.catalogComponentOf, "itm_kit");
  assert.equal("catalogPriceSource" in node, false);
  const resolved = resolvePresentationOrganizer({ sourceItems: [], organizer });
  assert.equal(resolved.nodes["manual:a"].catalogItemUid, "itm_1");
  assert.equal(resolved.nodes["manual:a"].catalogSellRate, 60);
});

test("a price change shows as a row diff, applies, and then the draft is current", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "TURF", name: "Turf", unit: "m2", buy: 9.05, sell: 14 });
  const line = buildCatalogQuoteLine(await store.getState(), "TURF");
  const organizer = organizerOf({ "manual:turf": leafRow(line, { quantity: 40 }) });

  assert.equal(computeQuoteCatalogChanges({ state: await store.getState(), organizer }).changedCount, 0);

  await store.updateItem("TURF", { buy_price: 32.64, sell_price: 45 }, { author: "Estimator" });
  const state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer });
  assert.equal(diff.changedCount, 1);
  const [row] = diff.lines;
  assert.equal(row.nodeId, "manual:turf");
  assert.equal(row.status, "changed");
  assert.equal(row.applicable, true);
  assert.equal(row.overridden, false);
  assert.deepEqual(row.fields.map((field) => [field.field, field.from, field.to]), [
    ["sellRate", 14, 45],
    ["buyRate", 9.05, 32.64],
  ]);
  assert.equal(diff.catalogVersion, state.version);

  const applied = applyQuoteCatalogChanges({ state, organizer });
  assert.deepEqual(applied.applied, ["manual:turf"]);
  const node = applied.organizer.nodes["manual:turf"];
  assert.equal(node.sellRate, 45);
  assert.equal(node.buyRate, 32.64);
  assert.equal(node.quantity, 40, "the job quantity is the operator's, not the catalogue's");
  assert.equal(node.catalogPriceKey, buildCatalogQuoteLine(state, "TURF").priceKey);
  assert.notEqual(node.catalogPriceId, line.priceId);
  assert.equal(organizer.nodes["manual:turf"].sellRate, 14, "the input organizer is not mutated");
  assert.equal(computeQuoteCatalogChanges({ state, organizer: applied.organizer }).changedCount, 0);
});

test("an overridden row keeps its link, is listed as overridden, and apply releases the override", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "EDGING", name: "Block edging", unit: "m", buy: 30, sell: 50 });
  const line = buildCatalogQuoteLine(await store.getState(), "EDGING");
  // The editor changed the row's unit to mm (rates rescaled) and its rate,
  // which used to unlink it from the catalogue.
  const row = { ...leafRow(line, { quantity: 1200, unit: "mm" }), rateMode: "manual", sellRate: 0.055 };
  const organizer = organizerOf({ "manual:edging": row });
  const saved = normalizePresentationOrganizer(organizer);
  assert.equal(saved.nodes["manual:edging"].catalogItemUid, line.itemUid);

  await store.updateItem("EDGING", { sell_price: 60 }, { author: "Estimator" });
  const state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer: saved });
  assert.equal(diff.changedCount, 1);
  assert.equal(diff.lines[0].overridden, true);
  assert.equal(diff.lines[0].selectedByDefault, false);
  assert.deepEqual(diff.lines[0].fields.find((field) => field.field === "sellRate"), {
    field: "sellRate", from: 0.05, to: 0.06, rowValue: 0.055, unit: "mm",
  });

  // No review data: an overridden row is never replaced unless forced.
  const unreviewed = applyQuoteCatalogChanges({ state, organizer: saved, nodeIds: ["manual:edging"] });
  assert.deepEqual(unreviewed.applied, []);
  assert.equal(unreviewed.skipped[0].status, "overridden");
  // Ticked in the banner, which sends the state it reviewed.
  const applied = applyQuoteCatalogChanges({ state, organizer: saved, nodeIds: ["manual:edging"], reviewed: reviewedFor(diff, ["manual:edging"]) });
  const node = applied.organizer.nodes["manual:edging"];
  assert.equal(node.rateMode, "catalog-linked");
  assert.equal(node.unit, "mm");
  assert.equal(node.sellRate, 0.06, "the per-metre rate is applied per millimetre");
  assert.equal(node.catalogSellRate, 0.06);
});

test("kit contents and quantities diff against the catalogue and apply as rows", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", name: "Pipe", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "PIT", name: "Pit", unit: "each", buy: 90, sell: 140 });
  await item(store, { code: "GEOFABRIC", name: "Geofabric", unit: "m2", buy: 3, sell: 5 });
  await item(store, { code: "DRAIN", name: "Drain run", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.1 });
  const before = buildCatalogQuoteLine(await store.getState(), "DRAIN");
  const organizer = organizerOf(kitRows(before));

  assert.equal(computeQuoteCatalogChanges({ state: await store.getState(), organizer }).changedCount, 0);

  await store.updateChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.2 });
  await store.removeChild({ parentCode: "DRAIN", childCode: "PIPE" });
  await store.addChild({ parentCode: "DRAIN", childCode: "GEOFABRIC", quantity: 1.5 });
  const state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer });
  const kitLine = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.ok(kitLine, "the kit row is listed");
  assert.equal(kitLine.isKit, true);
  assert.deepEqual(kitLine.kit.added.map((entry) => entry.code), ["GEOFABRIC"]);
  assert.deepEqual(kitLine.kit.removed.map((entry) => entry.code), ["PIPE"]);
  assert.deepEqual(kitLine.kit.quantities.map((entry) => [entry.code, entry.from, entry.to]), [["PIT", 0.1, 0.2]]);

  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: ["manual:kit"] });
  const nodes = applied.organizer.nodes;
  const childCodes = nodes["manual:kit"].children.map((id) => nodes[id].catalogItemCode);
  assert.deepEqual(childCodes, ["PIT", "GEOFABRIC"]);
  const pitRow = Object.values(nodes).find((node) => node.catalogItemCode === "PIT");
  assert.equal(pitRow.quantity, 0.2);
  assert.equal(pitRow.catalogQuantity, 0.2);
  const geofabricRow = Object.values(nodes).find((node) => node.catalogItemCode === "GEOFABRIC");
  assert.equal(geofabricRow.sellRate, 5);
  assert.equal(geofabricRow.catalogComponentOf, before.itemUid);
  assert.equal(Object.values(nodes).some((node) => node.catalogItemCode === "PIPE"), false);
  assert.equal(computeQuoteCatalogChanges({ state, organizer: applied.organizer }).changedCount, 0);
});

test("missing, archived, unpriced and unit-mismatched rows are listed and never applied", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "LOAM", name: "Loam", unit: "m3", buy: 40, sell: 70 });
  await item(store, { code: "DISPOSAL", name: "Disposal", unit: "tonne", buy: 20, sell: 30 });
  await item(store, { code: "PART", name: "Part", unit: "each", buy: 5, sell: 8 });
  await item(store, { code: "KIT", name: "Kit", unit: "each", mode: "computed" });
  await store.addChild({ parentCode: "KIT", childCode: "PART", quantity: 2 });
  const state0 = await store.getState();
  const loam = buildCatalogQuoteLine(state0, "LOAM");
  const disposal = buildCatalogQuoteLine(state0, "DISPOSAL");
  const kit = buildCatalogQuoteLine(state0, "KIT");
  const organizer = organizerOf({
    "manual:loam": leafRow(loam),
    "manual:gone": { ...leafRow(loam), catalogItemUid: "itm_deleted", catalogItemCode: "GONE" },
    // A per-tonne item on a per-metre row: there is no conversion.
    "manual:disposal": { ...leafRow(disposal), unit: "m" },
    "manual:kit": leafRow(kit),
  });
  await store.archiveItem("LOAM");
  await store.archiveItem("PART");
  const state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer });
  const byNode = Object.fromEntries(diff.lines.map((line) => [line.nodeId, line]));
  assert.equal(byNode["manual:loam"].status, "archived");
  assert.equal(byNode["manual:gone"].status, "missing");
  assert.equal(byNode["manual:disposal"].status, "unit_mismatch");
  assert.equal(byNode["manual:kit"].status, "unpriced", "an archived component makes the kit unpriced, never zero");
  assert.match(byNode["manual:kit"].message, /PART is archived/);
  assert.equal(diff.applicableCount, 0);
  const applied = applyQuoteCatalogChanges({ state, organizer });
  assert.deepEqual(applied.applied, []);
  assert.equal(applied.skipped.length, 4);
  assert.deepEqual(applied.organizer, JSON.parse(JSON.stringify(organizer)));
});

test("rows linked by code only are upgraded to the uid and listed as price source unknown", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "SLEEPER-copy", name: "Sleeper", unit: "each", buy: 20, sell: 35 });
  const legacy = {
    kind: "source",
    origin: "manual",
    sourceCode: "manual-sleeper",
    labelOverride: "Sleeper",
    quantity: 12,
    unit: "each",
    sellRate: 35,
    buyRate: 20,
    rateMode: "catalog-linked",
    catalogItemCode: "SLEEPER-copy",
  };
  const organizer = organizerOf({ "manual:sleeper": legacy });
  let state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer });
  assert.equal(diff.changedCount, 1);
  assert.equal(diff.lines[0].priceSourceUnknown, true);
  assert.equal(diff.lines[0].selectedByDefault, false, "a legacy row starts unselected");
  assert.deepEqual(diff.lines[0].fields, [], "same values, but the price it came from is unknown");

  const upgraded = upgradeOrganizerCatalogLinks({ state, organizer });
  assert.equal(upgraded.upgraded, 1);
  const uid = upgraded.organizer.nodes["manual:sleeper"].catalogItemUid;
  assert.ok(uid);
  assert.equal(upgraded.organizer.nodes["manual:sleeper"].catalogPriceSource, "unknown");
  assert.equal(upgradeOrganizerCatalogLinks({ state, organizer: upgraded.organizer }).upgraded, 0);

  // Codes never change (they are aliases); a rename and a reprice keep the
  // link, which is the uid now.
  await store.updateItem("SLEEPER-copy", { name: "Concrete sleeper", sell_price: 36 }, { author: "Estimator" });
  state = await store.getState();
  const after = computeQuoteCatalogChanges({ state, organizer: upgraded.organizer });
  assert.equal(after.lines[0].status, "changed");
  assert.deepEqual(after.lines[0].fields.map((field) => field.field), ["sellRate"]);
  const applied = applyQuoteCatalogChanges({ state, organizer: upgraded.organizer });
  const node = applied.organizer.nodes["manual:sleeper"];
  assert.equal(node.catalogItemCode, "SLEEPER-copy");
  assert.equal(node.sellRate, 36);
  assert.ok(node.catalogPriceId);
  assert.equal("catalogPriceSource" in node, false);
  assert.equal(computeQuoteCatalogChanges({ state, organizer: applied.organizer }).changedCount, 0);
});

// What the rows a quote adds for a catalogue line total, per one of the item:
// the item row's own rate plus each included component row (rate x qty).
function quoteRowsTotal(line) {
  const own = line.components.length ? 0 : line.sellRate;
  return Math.round(line.components.reduce((sum, component) => (
    component.pricingContribution === "listed_only" ? sum : sum + component.sellRate * component.quantity
  ), own) * 100) / 100;
}

test("a recipe kit with a materials allowance goes on a quote as one row at the kit's own price", async (t) => {
  const store = await freshStore(t);
  // tree-supply-install's recipe (quote-catalogs/embark-default.json5) is
  // labour, vehicle time and a balance "materials allowance" remainder.
  await item(store, { code: "LABOURER-HOUR", unit: "hour", buy: 40, sell: 80 });
  await item(store, { code: "VEHICLE-HOUR", unit: "hour", buy: 20, sell: 40 });
  await item(store, { code: "tree-supply-install", unit: "each", buy: 150, sell: 300 });
  const state = await store.getState();
  const kit = kitSnapshot(state, buildCatalogQuoteLine(state, "tree-supply-install").itemUid);
  assert.ok(kit.components.some((component) => component.balance), "the recipe has a balance (allowance) component");

  const line = buildCatalogQuoteLine(state, "tree-supply-install");
  assert.equal(line.sellRate, 300);
  assert.equal(line.buyRate, 150);
  assert.deepEqual(line.components, [], "recipe children are not expanded into rows that drop the allowance");
  assert.equal(line.componentsWithheld, "recipe");
  assert.equal(quoteRowsTotal(line), 300, "the quote rows total the catalogue sell price");
});

test("a recipe kit without a balance whose own price differs from its recipe goes on as one row", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "EXCAVATOR-HOUR", unit: "hour", buy: 60, sell: 120 });
  await item(store, { code: "mini-loader-hour", unit: "hour", buy: 50, sell: 100 });
  await item(store, { code: "site-levelling", unit: "m3", buy: 40, sell: 95 });
  const state = await store.getState();
  const kit = kitSnapshot(state, buildCatalogQuoteLine(state, "site-levelling").itemUid);
  assert.ok(kit.components.length > 0 && kit.components.every((component) => !component.balance), "a recipe with no balance");
  const line = buildCatalogQuoteLine(state, "site-levelling");
  assert.deepEqual(line.components, []);
  assert.equal(line.sellRate, 95);
  assert.equal(quoteRowsTotal(line), 95);
});

test("a catalogue kit expands into rows only when the rows total its cost and sell to the cent", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "EXCAVATOR-HOUR", unit: "hour", buy: 180, sell: 300 });
  await item(store, { code: "GRAVEL", unit: "m3", buy: 40, sell: 60 });
  await item(store, { code: "TAG", unit: "each", buy: 1, sell: 2 });
  await item(store, { code: "DRAIN-KIT", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN-KIT", childCode: "EXCAVATOR-HOUR", quantity: 0.35 });
  await store.addChild({ parentCode: "DRAIN-KIT", childCode: "GRAVEL", quantity: 0.2 });
  await item(store, { code: "FIXED-KIT", unit: "m", buy: 100, sell: 250 });
  await store.addChild({ parentCode: "FIXED-KIT", childCode: "GRAVEL", quantity: 1 });
  const state = await store.getState();

  const rolled = buildCatalogQuoteLine(state, "DRAIN-KIT");
  assert.equal(rolled.components.length, 2);
  assert.equal(rolled.componentsWithheld, null);
  assert.equal(quoteRowsTotal(rolled), Math.round(rolled.sellRate * 100) / 100);
  const cost = rolled.components.reduce((sum, component) => sum + component.buyRate * component.quantity, 0);
  assert.ok(Math.abs(cost - rolled.buyRate) < 0.005);

  // A kit priced by hand: its one component ($60) does not add up to $250.
  const fixed = buildCatalogQuoteLine(state, "FIXED-KIT");
  assert.equal(fixed.sellRate, 250);
  assert.deepEqual(fixed.components, []);
  assert.equal(fixed.componentsWithheld, "does_not_sum");
  assert.equal(quoteRowsTotal(fixed), 250);
});

test("a kit added as rows that the catalogue no longer expands is listed and applies as one row", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "PIT", unit: "each", buy: 90, sell: 140 });
  await item(store, { code: "DRAIN", name: "Drain run", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.1 });
  const before = buildCatalogQuoteLine(await store.getState(), "DRAIN");
  assert.equal(before.components.length, 2);
  const organizer = organizerOf(kitRows(before));
  const withOwnRow = cloneForTest(organizer);
  withOwnRow.nodes["manual:mine"] = { kind: "source", sourceKind: "manual", origin: "manual", sourceCode: "manual-mine", quantity: 1, unit: "each", sellRate: 5, buyRate: 1 };
  withOwnRow.nodes["manual:kit"].children.push("manual:mine");

  // The kit's sell is now set by hand ($40/m), so its rows no longer add up.
  await store.updateItem("DRAIN", { buy_price: 25, sell_price: 40, buy_price_mode: "manual", sell_price_mode: "manual" }, { author: "Estimator" });
  const state = await store.getState();
  assert.deepEqual(buildCatalogQuoteLine(state, "DRAIN").components, []);

  const diff = computeQuoteCatalogChanges({ state, organizer });
  const kitLine = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.ok(kitLine, "the kit row is listed");
  assert.equal(kitLine.applicable, true);
  assert.equal(kitLine.kit.collapsed, true);
  assert.equal(kitLine.kit.removed.length, 2);
  assert.match(kitLine.message, /one line/);
  assert.deepEqual(kitLine.fields.filter((field) => field.field === "sellRate").map((field) => field.to), [40]);
  assert.equal(kitLine.legacyKitRows, false);
  assert.equal(kitLine.selectedByDefault, true, "a clean collapse of generated rows starts selected");

  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: ["manual:kit"] });
  assert.deepEqual(applied.applied, ["manual:kit"]);
  const node = applied.organizer.nodes["manual:kit"];
  assert.equal(node.sellRate, 40);
  assert.equal(node.buyRate, 25);
  assert.equal(node.children, undefined, "the component rows are gone");
  assert.equal(Object.keys(applied.organizer.nodes).length, 1);
  assert.equal(computeQuoteCatalogChanges({ state, organizer: applied.organizer }).changedCount, 0);

  // A kit row with a row of the operator's own under it is listed, not applied.
  const mixed = computeQuoteCatalogChanges({ state, organizer: withOwnRow }).lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(mixed.applicable, false);
  const refused = applyQuoteCatalogChanges({ state, organizer: withOwnRow, nodeIds: ["manual:kit"] });
  assert.deepEqual(refused.applied, []);
  assert.equal(refused.organizer.nodes["manual:kit"].children.length, 3);
});

function cloneForTest(value) {
  return JSON.parse(JSON.stringify(value));
}

// A row the operator adds from the picker and nests under a kit row: a leaf
// catalogue row with the picker's sourceCode and no catalogComponentOf.
function pickerRow(line, { quantity = 1, nonce = "op1" } = {}) {
  return { ...leafRow(line, { quantity }), sourceCode: `manual-catalog-${line.code.toLowerCase()}-${nonce}` };
}

test("a picker-added row nested under a one-row recipe kit is the operator's row, not a kit change", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "LABOURER-HOUR", unit: "hour", buy: 40, sell: 80 });
  await item(store, { code: "VEHICLE-HOUR", unit: "hour", buy: 20, sell: 40 });
  await item(store, { code: "tree-supply-install", unit: "each", buy: 150, sell: 300 });
  const state = await store.getState();
  const kitLine = buildCatalogQuoteLine(state, "tree-supply-install");
  assert.deepEqual(kitLine.components, [], "the recipe kit goes on as one row");
  const labour = buildCatalogQuoteLine(state, "LABOURER-HOUR");
  const organizer = organizerOf({
    "manual:tree": { ...leafRow(kitLine), children: ["manual:labour"] },
    "manual:labour": pickerRow(labour, { quantity: 2 }),
  });

  const diff = computeQuoteCatalogChanges({ state, organizer });
  assert.equal(diff.changedCount, 0, "nothing changed in the catalogue");

  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: null });
  assert.deepEqual(applied.applied, []);
  assert.deepEqual(applied.organizer.nodes["manual:tree"].children, ["manual:labour"]);
  assert.equal(applied.organizer.nodes["manual:labour"].quantity, 2, "the operator's labour stays on the quote");

  // A real price change on the labour row is that row's own change, and
  // applying it leaves the kit row and the nesting alone.
  await store.updateItem("LABOURER-HOUR", { sell_price: 90 }, { author: "Estimator" });
  const changed = computeQuoteCatalogChanges({ state: await store.getState(), organizer });
  assert.deepEqual(changed.lines.map((line) => [line.nodeId, line.isKit, line.kit?.collapsed ?? null]), [["manual:labour", false, null]]);
});

test("a component item's row of the operator's own under a catalogue kit is never counted as a kit member", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "PIT", unit: "each", buy: 90, sell: 140 });
  await item(store, { code: "DRAIN", name: "Drain run", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.1 });
  const before = buildCatalogQuoteLine(await store.getState(), "DRAIN");
  const pipe = buildCatalogQuoteLine(await store.getState(), "PIPE");
  const organizer = organizerOf(kitRows(before));
  organizer.nodes["manual:extra-pipe"] = pickerRow(pipe, { quantity: 4 });
  organizer.nodes["manual:kit"].children.push("manual:extra-pipe");

  // Expanded kit, catalogue unchanged: the extra pipe is not a member.
  assert.equal(computeQuoteCatalogChanges({ state: await store.getState(), organizer }).changedCount, 0);

  // The kit's price is now set by hand, so the catalogue collapses it. The
  // collapse is listed, but it would delete the operator's pipe: not applicable.
  await store.updateItem("DRAIN", { buy_price: 25, sell_price: 40, buy_price_mode: "manual", sell_price_mode: "manual" }, { author: "Estimator" });
  const state = await store.getState();
  const kitEntry = computeQuoteCatalogChanges({ state, organizer }).lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(kitEntry.kit.collapsed, true);
  assert.equal(kitEntry.applicable, false);
  assert.deepEqual(kitEntry.kit.removed.map((removal) => removal.nodeId).sort(), ["manual:kit:child-0", "manual:kit:child-1"]);
  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: null });
  assert.equal(applied.applied.includes("manual:kit"), false);
  assert.equal(applied.organizer.nodes["manual:extra-pipe"].quantity, 4, "apply-all leaves the operator's row in place");
  assert.ok(applied.organizer.nodes["manual:kit"].children.includes("manual:extra-pipe"));

  // A DB kit already on the quote as one row with only the operator's own
  // component-item row under it: no members, so no collapse and no change.
  const oneRow = organizerOf({
    "manual:drain": { ...leafRow(buildCatalogQuoteLine(state, "DRAIN")), children: ["manual:pipe"] },
    "manual:pipe": pickerRow(pipe, { quantity: 3 }),
  });
  assert.equal(computeQuoteCatalogChanges({ state, organizer: oneRow }).changedCount, 0);
  const untouched = applyQuoteCatalogChanges({ state, organizer: oneRow, nodeIds: null });
  assert.deepEqual(untouched.organizer.nodes["manual:drain"].children, ["manual:pipe"]);
});

test("component rows added before catalogComponentOf existed are still recognised by their sourceCode", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "PIT", unit: "each", buy: 90, sell: 140 });
  await item(store, { code: "DRAIN", name: "Drain run", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.1 });
  // The way the base-era editor added a kit: code links only, the kit row at
  // rate 0, component sourceCodes `manual-catalog-<kit>-<child>-<nonce>-<i>`.
  const legacyChild = (code, index, quantity, unit, sellRate, buyRate) => ({
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: `manual-catalog-drain-${code.toLowerCase()}-lx1-ab12-${index}`,
    labelOverride: code,
    amountVisible: true,
    quantity,
    unit,
    sellRate,
    buyRate,
    catalogSellRate: sellRate,
    catalogBuyRate: buyRate,
    rateMode: "catalog-linked",
    catalogItemCode: code,
  });
  const organizer = organizerOf({
    "manual:legacy": {
      kind: "source",
      sourceKind: "manual",
      origin: "manual",
      pricingMode: "manual",
      sourceCode: "manual-catalog-drain-lx1-ab12",
      labelOverride: "Drain run",
      amountVisible: true,
      quantity: 1,
      unit: "m",
      sellRate: 0,
      buyRate: 0,
      catalogSellRate: 29,
      catalogBuyRate: 19,
      rateMode: "catalog-linked",
      catalogItemCode: "DRAIN",
      children: ["manual:legacy:0", "manual:legacy:1"],
    },
    "manual:legacy:0": legacyChild("PIPE", 0, 1, "m", 15, 10),
    "manual:legacy:1": legacyChild("PIT", 1, 0.1, "each", 140, 90),
  });
  await store.updateItem("DRAIN", { buy_price: 25, sell_price: 40, buy_price_mode: "manual", sell_price_mode: "manual" }, { author: "Estimator" });
  const state = await store.getState();
  const kitEntry = computeQuoteCatalogChanges({ state, organizer }).lines.find((line) => line.nodeId === "manual:legacy");
  assert.equal(kitEntry.kit.collapsed, true);
  assert.equal(kitEntry.applicable, true);
  assert.equal(kitEntry.kit.removed.length, 2);
  assert.equal(kitEntry.legacyKitRows, true);
  assert.equal(kitEntry.selectedByDefault, false, "a collapse resting on legacy rows starts unselected");
  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: ["manual:legacy"] });
  assert.deepEqual(applied.applied, ["manual:legacy"]);
  assert.deepEqual(Object.keys(applied.organizer.nodes), ["manual:legacy"]);
  assert.equal(applied.organizer.nodes["manual:legacy"].sellRate, 40);
});

test("a collapse that would discard edits on component rows starts unselected (overridden)", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "PIT", unit: "each", buy: 90, sell: 140 });
  await item(store, { code: "DRAIN", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.1 });
  const organizer = organizerOf(kitRows(buildCatalogQuoteLine(await store.getState(), "DRAIN")));
  await store.updateItem("DRAIN", { buy_price: 25, sell_price: 40, buy_price_mode: "manual", sell_price_mode: "manual" }, { author: "Estimator" });
  const state = await store.getState();
  const clean = computeQuoteCatalogChanges({ state, organizer }).lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(clean.overridden, false);

  const edited = cloneForTest(organizer);
  edited.nodes["manual:kit:child-1"].quantity = 0.3;
  const entry = computeQuoteCatalogChanges({ state, organizer: edited }).lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(entry.kit.collapsed, true);
  assert.equal(entry.overridden, true, "the operator's quantity edit would be lost");
  assert.equal(entry.selectedByDefault, false);
});

test("removing a kit component row keeps rows the operator nested under it", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "PIT", unit: "each", buy: 90, sell: 140 });
  await item(store, { code: "GLUE", unit: "each", buy: 2, sell: 4 });
  await item(store, { code: "DRAIN", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.1 });
  let state = await store.getState();
  const organizer = organizerOf(kitRows(buildCatalogQuoteLine(state, "DRAIN")));
  organizer.nodes["manual:glue"] = pickerRow(buildCatalogQuoteLine(state, "GLUE"), { quantity: 6 });
  organizer.nodes["manual:kit:child-0"].children = ["manual:glue"];

  await store.removeChild({ parentCode: "DRAIN", childCode: "PIPE" });
  state = await store.getState();
  const entry = computeQuoteCatalogChanges({ state, organizer }).lines.find((line) => line.nodeId === "manual:kit");
  assert.deepEqual(entry.kit.removed.map((removal) => removal.code), ["PIPE"]);
  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: ["manual:kit"] });
  const nodes = applied.organizer.nodes;
  assert.equal(nodes["manual:kit:child-0"], undefined, "the PIPE component row is removed");
  assert.equal(nodes["manual:glue"].quantity, 6, "the operator's row stays");
  assert.deepEqual(nodes["manual:kit"].children, ["manual:glue", "manual:kit:child-1"]);
});

// The quote's charge and cost the way the renderer totals the schedule.
function quoteTotal(organizer) {
  const totals = calculatePresentationScheduleTotals({ organizer, sourceItems: [] });
  return { charge: Math.round(totals.charge * 100) / 100, cost: Math.round(totals.cost * 100) / 100 };
}

// The rows the banner ticks before the operator does.
function defaultSelection(diff) {
  return diff.lines.filter((line) => line.selectedByDefault).map((line) => line.nodeId);
}

// What the banner sends with its selection: the state each row was listed in.
function reviewedFor(diff, nodeIds) {
  return Object.fromEntries(nodeIds.map((nodeId) => [nodeId, diff.lines.find((line) => line.nodeId === nodeId).reviewKey]));
}

async function treeSupplyInstallStore(t) {
  const store = await freshStore(t);
  await item(store, { code: "LABOURER-HOUR", unit: "hour", buy: 40, sell: 80 });
  await item(store, { code: "VEHICLE-HOUR", unit: "hour", buy: 20, sell: 40 });
  await item(store, { code: "tree-supply-install", unit: "each", buy: 150, sell: 300 });
  return store;
}

// A recipe kit as the base-era editor (52fc3e9 handleAddCatalogItemToQuote)
// put it on a quote and the base server stored it: the kit row at rate 0
// priced from one row per non-balance recipe child, code links only (the base
// server kept catalogItemCode and rateMode, not catalogSellRate), sourceCodes
// `manual-catalog-<kit>-<nonce>` and `manual-catalog-<kit>-<child>-<nonce>-<i>`.
function baseEraRecipeKit(state, { kitId = "manual:k", nonce = "lx1-ab12" } = {}) {
  const line = buildCatalogQuoteLine(state, "tree-supply-install");
  const kit = kitSnapshot(state, line.itemUid);
  const nodes = {
    [kitId]: {
      kind: "source",
      sourceKind: "manual",
      origin: "manual",
      pricingMode: "manual",
      sourceCode: `manual-catalog-tree-supply-install-${nonce}`,
      labelOverride: "Tree supply and install",
      amountVisible: true,
      quantity: 1,
      unit: "each",
      sellRate: 0,
      buyRate: 0,
      rateMode: "catalog-linked",
      catalogItemCode: "tree-supply-install",
      children: [],
    },
  };
  kit.components.filter((component) => !component.balance && component.item?.code).forEach((component, index) => {
    const id = `${kitId}:${index}`;
    nodes[id] = {
      kind: "source",
      sourceKind: "manual",
      origin: "manual",
      pricingMode: "manual",
      sourceCode: `manual-catalog-tree-supply-install-${component.item.code.toLowerCase()}-${nonce}-${index}`,
      labelOverride: component.item.code,
      amountVisible: true,
      quantity: Number(component.quantity),
      unit: component.item.unit,
      sellRate: component.item.sell,
      buyRate: component.item.cost,
      rateMode: "catalog-linked",
      catalogItemCode: component.item.code,
    };
    nodes[kitId].children.push(id);
  });
  return nodes;
}

test("an older recipe-kit draft expanded by the base editor collapses to one row and is never double-priced", async (t) => {
  const store = await treeSupplyInstallStore(t);
  const state = await store.getState();
  // The open path upgrades code links to uids first (job-actions).
  const organizer = upgradeOrganizerCatalogLinks({ state, organizer: organizerOf(baseEraRecipeKit(state)) }).organizer;
  assert.deepEqual(organizer.nodes["manual:k"].children, ["manual:k:0", "manual:k:1"]);
  assert.deepEqual(quoteTotal(organizer), { charge: 31.2, cost: 15.6 }, "the base-era rows total $31.20");

  const diff = computeQuoteCatalogChanges({ state, organizer });
  const kitEntry = diff.lines.find((line) => line.nodeId === "manual:k");
  assert.equal(kitEntry.isKit, true, "the recipe children are recognised as the kit's rows");
  assert.equal(kitEntry.kit.collapsed, true);
  assert.deepEqual(kitEntry.kit.removed.map((removal) => removal.nodeId), ["manual:k:0", "manual:k:1"]);
  assert.equal(kitEntry.applicable, true);
  assert.equal(kitEntry.legacyKitRows, true);
  assert.equal(kitEntry.selectedByDefault, false, "legacy rows: the operator ticks it");
  assert.deepEqual(kitEntry.fields.map((field) => [field.field, field.from, field.to]), [["sellRate", 31.2, 300], ["buyRate", 15.6, 150]], "from is what the rows add up to");
  // No line gives the kit row its own rate while its rows stay under it.
  assert.equal(diff.lines.some((line) => line.nodeId === "manual:k" && !line.kit?.collapsed && line.applicable), false);

  // The banner's default apply changes nothing; it never adds $300 on top.
  const byDefault = applyQuoteCatalogChanges({ state, organizer, nodeIds: defaultSelection(diff) });
  assert.deepEqual(byDefault.applied, []);
  assert.deepEqual(quoteTotal(byDefault.organizer), { charge: 31.2, cost: 15.6 });

  // Ticked, it becomes one row at the catalogue price, and so does apply-all.
  for (const nodeIds of [["manual:k"], null]) {
    const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds });
    assert.ok(applied.applied.includes("manual:k"));
    assert.deepEqual(Object.keys(applied.organizer.nodes), ["manual:k"]);
    assert.equal(applied.organizer.nodes["manual:k"].sellRate, 300);
    assert.equal(applied.organizer.nodes["manual:k"].buyRate, 150);
    assert.deepEqual(quoteTotal(applied.organizer), { charge: 300, cost: 150 }, "not $331.20");
    assert.equal(computeQuoteCatalogChanges({ state, organizer: applied.organizer }).changedCount, 0);
  }
});

test("a kit row at rate 0 over rows that are not its generated rows is listed, never given its own rate", async (t) => {
  const store = await treeSupplyInstallStore(t);
  const state = await store.getState();
  const labour = buildCatalogQuoteLine(state, "LABOURER-HOUR");

  // Base era: the generated rows were deleted and the operator nested their
  // own picker-added labour under the kit row.
  const legacy = baseEraRecipeKit(state);
  delete legacy["manual:k:0"];
  delete legacy["manual:k:1"];
  legacy["manual:k"].children = ["manual:mine"];
  legacy["manual:mine"] = pickerRow(labour, { quantity: 2 });
  const organizer = upgradeOrganizerCatalogLinks({ state, organizer: organizerOf(legacy) }).organizer;
  const before = quoteTotal(organizer);
  assert.deepEqual(before, { charge: 160, cost: 80 });
  const kitEntry = computeQuoteCatalogChanges({ state, organizer }).lines.find((line) => line.nodeId === "manual:k");
  assert.equal(kitEntry.isKit, false);
  assert.equal(kitEntry.pricedFromChildren, true);
  assert.equal(kitEntry.applicable, false);
  assert.equal(kitEntry.selectedByDefault, false);
  assert.match(kitEntry.message, /on top of them/);
  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: null });
  assert.equal(applied.applied.includes("manual:k"), false);
  assert.equal(applied.organizer.nodes["manual:k"].sellRate, 0);
  assert.deepEqual(quoteTotal(applied.organizer), before);

  // New era: a DB kit added as rows, its generated rows deleted and the
  // operator's own row under it; then the kit's price moves.
  await item(store, { code: "PIPE", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "GLUE", unit: "each", buy: 2, sell: 4 });
  await item(store, { code: "DRAIN", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  const drain = buildCatalogQuoteLine(await store.getState(), "DRAIN");
  const nodes = kitRows(drain);
  delete nodes["manual:kit:child-0"];
  nodes["manual:kit"].children = ["manual:glue"];
  nodes["manual:glue"] = pickerRow(buildCatalogQuoteLine(await store.getState(), "GLUE"), { quantity: 3 });
  const newEra = organizerOf(nodes);
  assert.equal(computeQuoteCatalogChanges({ state: await store.getState(), organizer: newEra }).changedCount, 0);
  await store.updateItem("PIPE", { sell_price: 18 }, { author: "Estimator" });
  const moved = await store.getState();
  const entry = computeQuoteCatalogChanges({ state: moved, organizer: newEra }).lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(entry.applicable, false, "applying would put $18 on top of the operator's glue");
  assert.equal(entry.pricedFromChildren, true);
  const kept = applyQuoteCatalogChanges({ state: moved, organizer: newEra, nodeIds: ["manual:kit"] });
  assert.deepEqual(kept.applied, []);
  assert.deepEqual(quoteTotal(kept.organizer), quoteTotal(newEra));
});

test("legacy kit rows count only under the kit row they were added with (the nonce anchors the match)", async (t) => {
  const store = await treeSupplyInstallStore(t);
  const state = await store.getState();
  // tree-supply-install added twice; a generated row of the second copy was
  // dragged under the first.
  const first = baseEraRecipeKit(state, { kitId: "manual:a", nonce: "lx1-aaaa" });
  const second = baseEraRecipeKit(state, { kitId: "manual:b", nonce: "lx2-bbbb" });
  const nodes = { ...first, ...second };
  nodes["manual:a"].children.push("manual:b:0");
  nodes["manual:b"].children = nodes["manual:b"].children.filter((id) => id !== "manual:b:0");
  const organizer = upgradeOrganizerCatalogLinks({ state, organizer: organizerOf(nodes) }).organizer;
  const diff = computeQuoteCatalogChanges({ state, organizer });
  const a = diff.lines.find((line) => line.nodeId === "manual:a");
  assert.deepEqual(a.kit.removed.map((removal) => removal.nodeId), ["manual:a:0", "manual:a:1"], "the dragged row is not copy A's");
  assert.equal(a.applicable, false, "collapsing copy A would delete the dragged row");
  const b = diff.lines.find((line) => line.nodeId === "manual:b");
  assert.deepEqual(b.kit.removed.map((removal) => removal.nodeId), ["manual:b:1"]);

  // A kit row whose own sourceCode is not the base editor's has no legacy rows.
  const renamed = cloneForTest(organizerOf(first));
  renamed.nodes["manual:a"].sourceCode = "manual-something-else";
  const renamedEntry = computeQuoteCatalogChanges({ state, organizer: renamed }).lines.find((line) => line.nodeId === "manual:a");
  assert.equal(renamedEntry.isKit, false);
  assert.equal(renamedEntry.applicable, false, "priced from rows Field cannot tell were generated");

  // A row whose sourceCode merely starts with the kit's component prefix is not a member.
  const prefixed = cloneForTest(organizerOf(first));
  prefixed.nodes["manual:a:0"].sourceCode = "manual-catalog-tree-supply-install-labourer-hour-lx1-aaaa-0-extra";
  const prefixedEntry = computeQuoteCatalogChanges({ state, organizer: prefixed }).lines.find((line) => line.nodeId === "manual:a");
  assert.deepEqual(prefixedEntry.kit.removed.map((removal) => removal.nodeId), ["manual:a:1"]);
  assert.equal(prefixedEntry.applicable, false);
});

test("a catalogue kit's legacy rows flag their quantity change as unknown and start unselected", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", unit: "m", buy: 10, sell: 15 });
  await item(store, { code: "PIT", unit: "each", buy: 90, sell: 140 });
  await item(store, { code: "DRAIN", name: "Drain run", unit: "m", mode: "computed" });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIPE", quantity: 1 });
  await store.addChild({ parentCode: "DRAIN", childCode: "PIT", quantity: 0.1 });
  const legacyChild = (code, index, quantity, unit, sellRate, buyRate) => ({
    kind: "source",
    sourceKind: "manual",
    origin: "manual",
    pricingMode: "manual",
    sourceCode: `manual-catalog-drain-${code.toLowerCase()}-lx1-ab12-${index}`,
    labelOverride: code,
    amountVisible: true,
    quantity,
    unit,
    sellRate,
    buyRate,
    rateMode: "catalog-linked",
    catalogItemCode: code,
  });
  const organizer = organizerOf({
    "manual:legacy": {
      kind: "source",
      sourceKind: "manual",
      origin: "manual",
      pricingMode: "manual",
      sourceCode: "manual-catalog-drain-lx1-ab12",
      quantity: 1,
      unit: "m",
      sellRate: 0,
      buyRate: 0,
      rateMode: "catalog-linked",
      catalogItemCode: "DRAIN",
      children: ["manual:legacy:0", "manual:legacy:1"],
    },
    "manual:legacy:0": legacyChild("PIPE", 0, 1, "m", 15, 10),
    // The operator may have edited this quantity; the row cannot say.
    "manual:legacy:1": legacyChild("PIT", 1, 0.2, "each", 140, 90),
  });
  const state = await store.getState();
  const entry = computeQuoteCatalogChanges({ state, organizer }).lines.find((line) => line.nodeId === "manual:legacy");
  assert.equal(entry.isKit, true);
  assert.equal(entry.legacyKitRows, true);
  assert.deepEqual(entry.kit.quantities.map((change) => [change.code, change.from, change.to, change.fromUnknown]), [["PIT", 0.2, 0.1, true]]);
  assert.equal(entry.applicable, true);
  assert.equal(entry.selectedByDefault, false);
});

async function pipeFittingKitStore(t) {
  const store = await freshStore(t);
  await item(store, { code: "PIPE", unit: "each", buy: 10, sell: 20 });
  await item(store, { code: "FITTING", unit: "each", buy: 2, sell: 5 });
  await item(store, { code: "KIT", unit: "each", mode: "computed" });
  await store.addChild({ parentCode: "KIT", childCode: "PIPE", quantity: 2 });
  await store.addChild({ parentCode: "KIT", childCode: "FITTING", quantity: 4 });
  return store;
}

function kitChildByCode(organizer, code) {
  return organizer.nodes["manual:kit"].children.find((id) => organizer.nodes[id].catalogItemCode === code);
}

test("a kit whose catalogue quantity change hits a component quantity the operator edited starts unselected", async (t) => {
  const store = await pipeFittingKitStore(t);
  const organizer = organizerOf(kitRows(buildCatalogQuoteLine(await store.getState(), "KIT")));
  const pipe = kitChildByCode(organizer, "PIPE");
  organizer.nodes[pipe].quantity = 3; // negotiated: 3 per kit, not 2

  // A change that does not touch the edited row is still a plain update.
  await store.updateChild({ parentCode: "KIT", childCode: "FITTING", quantity: 6 });
  let state = await store.getState();
  let diff = computeQuoteCatalogChanges({ state, organizer });
  let entry = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.deepEqual(entry.kit.quantities.map((change) => [change.code, change.from, change.to, change.overridden]), [["FITTING", 4, 6, false]]);
  assert.equal(entry.overridden, false);
  assert.equal(entry.selectedByDefault, true);
  let applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: defaultSelection(diff) });
  assert.equal(applied.organizer.nodes[pipe].quantity, 3, "the operator's PIPE quantity is untouched");

  // The catalogue now changes the edited row's quantity: applying would replace the operator's 3.
  await store.updateChild({ parentCode: "KIT", childCode: "FITTING", quantity: 4 });
  await store.updateChild({ parentCode: "KIT", childCode: "PIPE", quantity: 5 });
  state = await store.getState();
  diff = computeQuoteCatalogChanges({ state, organizer });
  entry = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.deepEqual(entry.kit.quantities.map((change) => [change.code, change.from, change.to, change.overridden]), [["PIPE", 2, 5, true]]);
  assert.equal(entry.applicable, true);
  assert.equal(entry.overridden, true, "applying would replace the operator's quantity");
  assert.equal(entry.selectedByDefault, false);
  const before = quoteTotal(organizer);
  applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: defaultSelection(diff) });
  assert.equal(applied.applied.includes("manual:kit"), false);
  assert.equal(applied.organizer.nodes[pipe].quantity, 3, "the default apply keeps the operator's 3");
  assert.deepEqual(quoteTotal(applied.organizer), before);
  applied = applyQuoteCatalogChanges({ state, organizer, defaultOnly: true });
  assert.deepEqual(applied.applied, [], "defaultOnly skips it too");
  assert.equal(applied.organizer.nodes[pipe].quantity, 3);

  // Ticking it is the operator's explicit choice of the catalogue quantity.
  applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: ["manual:kit"], reviewed: reviewedFor(diff, ["manual:kit"]) });
  assert.equal(applied.organizer.nodes[pipe].quantity, 5);
});

test("a kit whose catalogue removes a component row the operator edited starts unselected", async (t) => {
  const store = await pipeFittingKitStore(t);
  const organizer = organizerOf(kitRows(buildCatalogQuoteLine(await store.getState(), "KIT")));
  const fitting = kitChildByCode(organizer, "FITTING");
  // Negotiated on this quote: own rate and quantity.
  Object.assign(organizer.nodes[fitting], { rateMode: "manual", sellRate: 4.5, quantity: 10 });
  const before = quoteTotal(organizer);

  await store.removeChild({ parentCode: "KIT", childCode: "FITTING" });
  const state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer });
  const entry = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(entry.kit.collapsed, undefined, "the kit stays as rows");
  assert.deepEqual(entry.kit.removed.map((removal) => removal.code), ["FITTING"]);
  assert.equal(entry.applicable, true);
  assert.equal(entry.overridden, true, "applying would delete the operator's negotiated row");
  assert.equal(entry.selectedByDefault, false);

  const applied = applyQuoteCatalogChanges({ state, organizer, nodeIds: defaultSelection(diff) });
  assert.equal(applied.applied.includes("manual:kit"), false);
  assert.ok(applied.organizer.nodes[fitting], "the operator's row stays");
  assert.equal(applied.organizer.nodes[fitting].sellRate, 4.5);
  assert.equal(applied.organizer.nodes[fitting].quantity, 10);
  assert.deepEqual(quoteTotal(applied.organizer), before);

  // An unedited removed row is a plain catalogue update and starts ticked.
  const cleanStore = await pipeFittingKitStore(t);
  const cleanOrganizer = organizerOf(kitRows(buildCatalogQuoteLine(await cleanStore.getState(), "KIT")));
  await cleanStore.removeChild({ parentCode: "KIT", childCode: "FITTING" });
  const cleanEntry = computeQuoteCatalogChanges({ state: await cleanStore.getState(), organizer: cleanOrganizer })
    .lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(cleanEntry.overridden, false);
  assert.equal(cleanEntry.selectedByDefault, true);
});

// The operator deletes a generated component row on this quote (the editor's
// remove button leaves no tombstone for a catalogue kit's rows).
function deleteKitChild(organizer, childId) {
  const next = structuredClone(organizer);
  delete next.nodes[childId];
  next.nodes["manual:kit"].children = next.nodes["manual:kit"].children.filter((id) => id !== childId);
  return next;
}

test("a component row the operator deleted is their edit, never offered back as a catalogue addition", async (t) => {
  const store = await pipeFittingKitStore(t);
  const added = organizerOf(kitRows(buildCatalogQuoteLine(await store.getState(), "KIT")));
  assert.deepEqual(
    added.nodes["manual:kit"].catalogKitComponents.map((component) => [component.code, component.quantity]),
    [["PIPE", 2], ["FITTING", 4]],
    "the kit row freezes the components it was added with",
  );
  // Saving and reloading the draft keeps the frozen components.
  const organizer = normalizePresentationOrganizer(deleteKitChild(added, kitChildByCode(added, "FITTING")));
  assert.deepEqual(organizer.nodes["manual:kit"].catalogKitComponents, added.nodes["manual:kit"].catalogKitComponents);
  const operatorTotal = quoteTotal(organizer);
  assert.deepEqual(operatorTotal, { charge: 40, cost: 20 });

  // Catalogue unchanged: nothing to report.
  let state = await store.getState();
  let diff = computeQuoteCatalogChanges({ state, organizer });
  assert.equal(diff.changedCount, 0, "deleting a row is not a catalogue change");
  let applied = applyQuoteCatalogChanges({ state, organizer, defaultOnly: true });
  assert.deepEqual(applied.applied, []);
  assert.deepEqual(quoteTotal(applied.organizer), operatorTotal);

  // An unrelated component price moves: only that row changes, and the
  // default apply never brings the deleted row back.
  await store.updateItem("PIPE", { sell_price: 22 });
  state = await store.getState();
  diff = computeQuoteCatalogChanges({ state, organizer });
  const kitEntry = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(kitEntry?.kit?.added?.length ?? 0, 0, "FITTING is not listed as added");
  const pipe = kitChildByCode(organizer, "PIPE");
  assert.deepEqual(diff.lines.map((line) => line.nodeId), [pipe]);
  for (const options of [{ defaultOnly: true }, { nodeIds: defaultSelection(diff) }, {}]) {
    applied = applyQuoteCatalogChanges({ state, organizer, ...options });
    const nodes = applied.organizer.nodes;
    assert.deepEqual(nodes["manual:kit"].children, [pipe], "FITTING stays deleted");
    assert.deepEqual(quoteTotal(applied.organizer), { charge: operatorTotal.charge + 2 * 2, cost: operatorTotal.cost });
  }

  // A real catalogue addition is still offered (and ticked), and applying it
  // adds only that component: the deleted row stays deleted afterwards too.
  await item(store, { code: "GLUE", unit: "each", buy: 1, sell: 3 });
  await store.addChild({ parentCode: "KIT", childCode: "GLUE", quantity: 1 });
  state = await store.getState();
  diff = computeQuoteCatalogChanges({ state, organizer });
  const entry = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.deepEqual(entry.kit.added.map((addition) => [addition.code, addition.unconfirmed]), [["GLUE", undefined]]);
  assert.equal(entry.overridden, false);
  assert.equal(entry.selectedByDefault, true);
  applied = applyQuoteCatalogChanges({ state, organizer, defaultOnly: true });
  const codes = applied.organizer.nodes["manual:kit"].children.map((id) => applied.organizer.nodes[id].catalogItemCode);
  assert.deepEqual(codes, ["PIPE", "GLUE"]);
  assert.deepEqual(
    applied.organizer.nodes["manual:kit"].catalogKitComponents.map((component) => component.code),
    ["PIPE", "FITTING", "GLUE"],
    "applying refreshes the frozen components to the kit as it is now",
  );
  assert.equal(computeQuoteCatalogChanges({ state, organizer: applied.organizer }).changedCount, 0);
});

test("a kit row that froze no components never pre-ticks a component it cannot vouch was not deleted", async (t) => {
  const store = await pipeFittingKitStore(t);
  const added = organizerOf(kitRows(buildCatalogQuoteLine(await store.getState(), "KIT")));
  delete added.nodes["manual:kit"].catalogKitComponents; // added before Field froze them
  const organizer = deleteKitChild(added, kitChildByCode(added, "FITTING"));
  const operatorTotal = quoteTotal(organizer);

  // Unchanged catalogue: the kit's price key still matches, so its contents
  // have not changed and the missing row is the operator's.
  let state = await store.getState();
  assert.equal(computeQuoteCatalogChanges({ state, organizer }).changedCount, 0);

  await store.updateItem("PIPE", { sell_price: 22 });
  state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer });
  const entry = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.deepEqual(entry.kit.added.map((addition) => [addition.code, addition.unconfirmed]), [["FITTING", true]]);
  assert.equal(entry.overridden, true, "applying might bring back a row the operator deleted");
  assert.equal(entry.selectedByDefault, false);
  const applied = applyQuoteCatalogChanges({ state, organizer, defaultOnly: true });
  assert.equal(applied.applied.includes("manual:kit"), false);
  assert.deepEqual(applied.organizer.nodes["manual:kit"].children, [kitChildByCode(organizer, "PIPE")]);
  assert.deepEqual(quoteTotal(applied.organizer), { charge: operatorTotal.charge + 4, cost: operatorTotal.cost });
});

// The banner's ticks come from the last check. A row edited
// after that check must not be applied on the strength of the old list.
test("a ticked row whose rate the operator typed after the check is skipped, and the edit is kept", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "TURF", name: "Turf", unit: "m2", buy: 9.05, sell: 14 });
  const line = buildCatalogQuoteLine(await store.getState(), "TURF");
  const checked = organizerOf({ "manual:turf": leafRow(line, { quantity: 40 }) });
  await store.updateItem("TURF", { sell_price: 16 }, { author: "Estimator" });
  const state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer: checked });
  const [listed] = diff.lines;
  assert.equal(listed.selectedByDefault, true, "a plain update starts ticked");
  assert.match(listed.reviewKey, /^rk1-/);

  // After the check, the operator overrides the row and types $12.50.
  const draft = structuredClone(checked);
  Object.assign(draft.nodes["manual:turf"], { rateMode: "manual", sellRate: 12.5 });
  const stale = applyQuoteCatalogChanges({ state, organizer: draft, nodeIds: ["manual:turf"], reviewed: reviewedFor(diff, ["manual:turf"]) });
  assert.deepEqual(stale.applied, []);
  assert.equal(stale.skipped.length, 1);
  assert.equal(stale.skipped[0].status, "changed_since_review");
  assert.match(stale.skipped[0].reason, /changed on this quote after the catalogue was checked/);
  assert.equal(stale.organizer.nodes["manual:turf"].sellRate, 12.5, "the operator's rate is kept");
  assert.equal(stale.organizer.nodes["manual:turf"].rateMode, "manual", "and stays an override");

  // Checked again, the row is listed as edited and starts unticked; ticking
  // it against the new list is the operator's choice of the catalogue rate.
  const recheck = computeQuoteCatalogChanges({ state, organizer: draft });
  assert.equal(recheck.lines[0].overridden, true);
  assert.equal(recheck.lines[0].selectedByDefault, false);
  assert.notEqual(recheck.lines[0].reviewKey, listed.reviewKey);
  const chosen = applyQuoteCatalogChanges({ state, organizer: draft, nodeIds: ["manual:turf"], reviewed: reviewedFor(recheck, ["manual:turf"]) });
  assert.deepEqual(chosen.applied, ["manual:turf"]);
  assert.equal(chosen.organizer.nodes["manual:turf"].sellRate, 16);
});

test("a ticked kit whose member quantity the operator edited after the check is skipped, and the quantity is kept", async (t) => {
  const store = await pipeFittingKitStore(t);
  const checked = organizerOf(kitRows(buildCatalogQuoteLine(await store.getState(), "KIT")));
  const pipe = kitChildByCode(checked, "PIPE");
  await store.updateChild({ parentCode: "KIT", childCode: "PIPE", quantity: 5 });
  const state = await store.getState();
  const diff = computeQuoteCatalogChanges({ state, organizer: checked });
  const listed = diff.lines.find((line) => line.nodeId === "manual:kit");
  assert.deepEqual(listed.kit.quantities.map((change) => [change.code, change.from, change.to]), [["PIPE", 2, 5]]);
  assert.equal(listed.selectedByDefault, true);

  // After the check, the operator sets PIPE to 3 per kit.
  const draft = structuredClone(checked);
  draft.nodes[pipe].quantity = 3;
  const before = quoteTotal(draft);
  const stale = applyQuoteCatalogChanges({ state, organizer: draft, nodeIds: ["manual:kit"], reviewed: reviewedFor(diff, ["manual:kit"]) });
  assert.deepEqual(stale.applied, []);
  assert.deepEqual(stale.skipped.map((entry) => [entry.nodeId, entry.status]), [["manual:kit", "changed_since_review"]]);
  assert.equal(stale.organizer.nodes[pipe].quantity, 3, "the operator's quantity is kept");
  assert.deepEqual(quoteTotal(stale.organizer), before);

  // A row the operator did not touch still applies from the same review.
  await store.updateItem("FITTING", { sell_price: 6 });
  const later = await store.getState();
  const both = computeQuoteCatalogChanges({ state: later, organizer: checked });
  const fitting = kitChildByCode(checked, "FITTING");
  const mixed = applyQuoteCatalogChanges({ state: later, organizer: draft, nodeIds: ["manual:kit", fitting], reviewed: reviewedFor(both, ["manual:kit", fitting]) });
  assert.deepEqual(mixed.applied, [fitting]);
  assert.equal(mixed.organizer.nodes[fitting].sellRate, 6);
  assert.equal(mixed.organizer.nodes[pipe].quantity, 3);

  // Checked again, the kit is listed as touching the operator's edit and starts unticked.
  const recheck = computeQuoteCatalogChanges({ state, organizer: draft }).lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(recheck.overridden, true);
  assert.equal(recheck.selectedByDefault, false);
});

test("an API apply without review data never replaces an edited row unless replaceEdits is set", async (t) => {
  const store = await freshStore(t);
  await item(store, { code: "TURF", name: "Turf", unit: "m2", buy: 9.05, sell: 14 });
  await item(store, { code: "SOIL", name: "Soil", unit: "m3", buy: 40, sell: 60 });
  let state = await store.getState();
  const organizer = organizerOf({
    "manual:turf": { ...leafRow(buildCatalogQuoteLine(state, "TURF"), { quantity: 40 }), rateMode: "manual", sellRate: 12.5 },
    "manual:soil": leafRow(buildCatalogQuoteLine(state, "SOIL"), { quantity: 4 }),
  });
  await store.updateItem("TURF", { sell_price: 16 }, { author: "Estimator" });
  await store.updateItem("SOIL", { sell_price: 65 }, { author: "Estimator" });
  state = await store.getState();

  for (const options of [{}, { nodeIds: ["manual:turf", "manual:soil"] }, { reviewed: {} }]) {
    const applied = applyQuoteCatalogChanges({ state, organizer, ...options });
    assert.deepEqual(applied.applied, ["manual:soil"], `the unedited row applies (${JSON.stringify(options)})`);
    assert.deepEqual(applied.skipped.map((entry) => [entry.nodeId, entry.status]), [["manual:turf", "overridden"]]);
    assert.match(applied.skipped[0].reason, /edited on this quote.*replaceEdits/);
    assert.equal(applied.organizer.nodes["manual:turf"].sellRate, 12.5);
  }
  const forced = applyQuoteCatalogChanges({ state, organizer, replaceEdits: true });
  assert.deepEqual(forced.applied, ["manual:turf", "manual:soil"]);
  assert.equal(forced.organizer.nodes["manual:turf"].sellRate, 16);
  assert.equal(forced.organizer.nodes["manual:turf"].rateMode, "catalog-linked");
});
