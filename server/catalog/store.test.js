import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";

import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";

// Rows written straight to a tenant table go in as the default organisation, the store's organisation.
const asDefaultOrg = (db) => ({ execute: (query) => withOrg(db, DEFAULT_ORG_UID, (tx) => tx.execute(query)) });
import { setRecipeChildrenByParentForTests } from "../price-catalog/catalog-recipes.js";
import { openCatalogStore } from "./index.js";
import { selectRows } from "./state.js";

async function freshStore(t, options = {}) {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db, ...options });
  return { store, db: handle.db };
}

async function history(db, code) {
  return selectRows(db, sql`
    select field, old_value, new_value, changed_by from catalog_history
    where item_uid = (select uid from items where lower(code) = lower(${code}))
    order by id`);
}

// ── Items ──

test("new catalog entries receive opaque UIDs and default to components", async (t) => {
  const { store } = await freshStore(t);
  const item = await store.createItem({ name: "New catalog component", unit: "each" });
  assert.match(item.uid, /^cat_[a-f0-9]{24}$/);
  assert.equal(item.code, item.uid);
  assert.equal(item.catalog_type, "component");
  assert.equal(item.version, 1);

  const coded = await store.createItem({ code: "LEGACY-AUTHORITY-CODE", name: "Legacy authority code", catalog_type: "goods_service" });
  assert.equal(coded.code, "LEGACY-AUTHORITY-CODE");
  assert.equal(coded.catalog_type, "goods_service");
  assert.equal(coded.visibility, "sellable");
});

test("codes are unique case-insensitively and lookups ignore case", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "Excavator-Hour", name: "Excavator", unit: "hour", buy_price: 100, sell_price: 150 });
  await assert.rejects(store.createItem({ code: "EXCAVATOR-HOUR", name: "Other" }), { code: "CODE_CONFLICT" });
  assert.equal((await store.getItem("excavator-hour")).name, "Excavator");
});

test("an alias unit is stored as its canonical unit and shown as entered", async (t) => {
  const { store } = await freshStore(t);
  const plant = await store.createItem({ code: "plant", name: "Plant", unit: "plant", buy_price: 1, sell_price: 2 });
  assert.equal(plant.unit, "plant");
  assert.equal(plant.unit_code, "each");
  const metre = await store.createItem({ code: "edge", name: "Edge", unit: "m", buy_price: 1, sell_price: 2 });
  assert.equal(metre.unit, "m");
  await assert.rejects(store.createItem({ code: "odd", name: "Odd", unit: "furlong" }), { code: "UNKNOWN_UNIT" });
});

test("codes never change: an edit is refused, a repeated code is accepted, and the old code still finds the item", async (t) => {
  const { store } = await freshStore(t);
  const parent = await store.createItem({ code: "kit", name: "Kit", buy_price_mode: "computed", sell_price_mode: "computed" });
  const part = await store.createItem({ code: "part-copy", name: "Part", unit: "each", buy_price: 4, sell_price: 6 });
  await store.addChild({ parentCode: "kit", childCode: "part-copy", quantity: 2 });

  await assert.rejects(
    store.updateItem("part-copy", { code: "PART" }, { author: "Estimator" }),
    (error) => error.code === "CODE_READ_ONLY" && error.statusCode === 400 && error.path === "code",
  );
  const same = await store.updateItem("part-copy", { code: "part-copy", name: "Part, renamed" });
  assert.equal(same.code, "part-copy");
  assert.equal(same.name, "Part, renamed");
  assert.equal((await store.getItem("PART-COPY")).uid, part.uid, "the legacy code resolves case-insensitively");
  const kit = await store.getItem(parent.uid);
  assert.equal(kit.effective_sell_price, 12);
});

test("updates are optimistic: a stale expectedVersion is refused, a current one applies", async (t) => {
  const { store } = await freshStore(t);
  const item = await store.createItem({ code: "rate", name: "Rate", buy_price: 10, sell_price: 20 });
  const updated = await store.updateItem("rate", { sell_price: 25 }, { expectedVersion: item.version });
  assert.equal(updated.version, item.version + 1);
  await assert.rejects(
    store.updateItem("rate", { sell_price: 30 }, { expectedVersion: item.version }),
    (error) => error.code === "VERSION_CONFLICT" && error.statusCode === 409,
  );
  assert.equal((await store.getItem("rate")).sell_price, 25);
});

test("an update that changes nothing does not bump the item or catalogue version", async (t) => {
  const { store } = await freshStore(t);
  const item = await store.createItem({ code: "rate", name: "Rate", buy_price: 10, sell_price: 20 });
  const before = await store.catalogVersion();
  const same = await store.updateItem("rate", { name: "Rate", sell_price: 20, status: "active" });
  assert.equal(same.version, item.version);
  assert.deepEqual(await store.catalogVersion(), before);
});

test("prices are append-only rows; the current row is the latest effective one", async (t) => {
  let now = new Date("2026-03-01T00:00:00.000Z");
  const { store } = await freshStore(t, { clock: () => now });
  const item = await store.createItem({ code: "turf", name: "Turf", unit: "m2", buy_price: 9.05, sell_price: 12 });
  const firstPriceId = item.price_id;
  assert.ok(firstPriceId);

  now = new Date("2026-03-02T00:00:00.000Z");
  const repriced = await store.updateItem("turf", { buy_price: 32.64 }, { author: "Estimator", reason: "supplier increase" });
  assert.notEqual(repriced.price_id, firstPriceId);
  assert.equal(repriced.buy_price, 32.64);
  assert.equal(repriced.sell_price, 12, "an unchanged side is carried into the new row");

  // A back-dated price that is still the latest row takes effect at once.
  now = new Date("2026-03-05T00:00:00.000Z");
  const backdated = await store.updateItem("turf", { sell_price: 13 }, { effectiveFrom: "2026-03-04T00:00:00.000Z" });
  assert.equal(backdated.sell_price, 13);
  assert.equal(backdated.price_effective_from, "2026-03-04T00:00:00.000Z");
  const prices = await store.getPriceHistory("turf");
  assert.deepEqual(prices.map((row) => [row.cost_per_unit, row.sell_price, row.current]), [
    [32.64, 13, true],
    [32.64, 12, false],
    [9.05, 12, false],
  ]);
  assert.equal(prices[1].reason, "supplier increase");

  // One dated before the current row would never become current: refused.
  await assert.rejects(
    store.updateItem("turf", { sell_price: 14 }, { effectiveFrom: "2026-03-03T00:00:00.000Z" }),
    (error) => error.code === "INVALID" && error.path === "effective_from",
  );
  await assert.rejects(store.updateItem("turf", { sell_price: 14 }, { effectiveFrom: "not a date" }), { code: "INVALID" });
  assert.equal((await store.getItem("turf")).sell_price, 13);
});

test("future-dated prices are refused, so a later edit can never be silently undone", async (t) => {
  // The reviewer's reproduction: GRAVEL cost 40 / sell 60; schedule sell 70
  // from 1 Nov; on 15 Oct raise cost to 50; on 2 Nov the cost rise must stand.
  let now = new Date("2026-10-11T00:00:00.000Z");
  const { store, db } = await freshStore(t, { clock: () => now });
  await store.createItem({ code: "GRAVEL", name: "Gravel", unit: "tonne", buy_price: 40, sell_price: 60 });
  const versionBefore = await store.catalogVersion();

  await assert.rejects(
    store.updateItem("GRAVEL", { sell_price: 70 }, { effectiveFrom: "2026-11-01T00:00:00.000Z" }),
    (error) => error.code === "FUTURE_PRICE_UNSUPPORTED" && error.statusCode === 400 && error.path === "effective_from",
  );
  await assert.rejects(
    store.createItem({ code: "SAND", name: "Sand", unit: "tonne", buy_price: 30, sell_price: 45, effective_from: "2026-11-01T00:00:00.000Z" }),
    { code: "FUTURE_PRICE_UNSUPPORTED" },
  );
  assert.deepEqual(await store.catalogVersion(), versionBefore, "a refused write changes nothing");
  assert.equal(await store.getItem("SAND"), null);

  now = new Date("2026-10-15T00:00:00.000Z");
  const raised = await store.updateItem("GRAVEL", { buy_price: 50 });
  assert.deepEqual([raised.buy_price, raised.sell_price], [50, 60]);

  now = new Date("2026-11-02T00:00:00.000Z");
  const later = await store.getItem("GRAVEL");
  assert.deepEqual([later.buy_price, later.sell_price], [50, 60], "the 15 Oct cost rise is still current on 2 Nov");
  const [{ count }] = await selectRows(db, sql`select count(*)::int as count from item_prices where effective_from > ${"2026-10-11T00:00:00.000Z"}::timestamptz and item_uid = ${later.uid} and cost_per_unit = 40`);
  assert.equal(Number(count), 0, "no scheduled row was written");
});

test("a price row already scheduled for later blocks an immediate price edit instead of undoing it", async (t) => {
  // Scheduled rows cannot be written through the store, but a row inserted
  // another way (e.g. by hand) must not silently undo an edit on its date.
  let now = new Date("2026-03-01T00:00:00.000Z");
  const { store, db } = await freshStore(t, { clock: () => now });
  const item = await store.createItem({ code: "turf", name: "Turf", unit: "m2", buy_price: 32.64, sell_price: 12 });
  await asDefaultOrg(db).execute(sql`insert into item_prices (item_uid, cost_per_unit, sell_price, effective_from, source, changed_by, created_at)
    values (${item.uid}, '32.64', '45', '2026-04-01T00:00:00.000Z', 'manual', 'test', '2026-03-01T00:00:00.000Z')`);
  await assert.rejects(
    store.updateItem("turf", { buy_price: 35 }),
    (error) => error.code === "PENDING_PRICE_CHANGE" && error.statusCode === 409 && error.details.effectiveFrom === "2026-04-01T00:00:00.000Z",
  );
  const renamed = await store.updateItem("turf", { name: "Turf roll" });
  assert.equal(renamed.name, "Turf roll", "edits that leave the price alone still apply");
  assert.equal(renamed.sell_price, 12);

  const versionBefore = await store.catalogVersion();
  now = new Date("2026-04-02T00:00:00.000Z");
  assert.equal((await store.getItem("turf")).sell_price, 45, "the scheduled row becomes current on its date");
  assert.notEqual((await store.catalogVersion()).etag, versionBefore.etag, "the ETag moves when a dated price takes effect");
});

test("markup sell mode sells at cost plus the row's markup", async (t) => {
  const { store } = await freshStore(t);
  const item = await store.createItem({ code: "pipe", name: "Pipe", unit: "m", buy_price: 10, markup_pct: 25 });
  assert.equal(item.sell_mode, "markup");
  assert.equal(item.sell_price, 12.5);
  const repriced = await store.updateItem("pipe", { buy_price: 20 });
  assert.equal(repriced.sell_price, 25, "a markup item re-prices with its cost");
  const fixed = await store.updateItem("pipe", { sell_price: 30, sell_price_mode: "manual" });
  assert.equal(fixed.sell_mode, "fixed");
  assert.equal(fixed.sell_price, 30);
});

test("variant_of links an item to its original; cycles are refused", async (t) => {
  const { store } = await freshStore(t);
  const original = await store.createItem({ code: "sleeper", name: "Sleeper", unit: "each", buy_price: 1, sell_price: 2 });
  const copy = await store.createItem({ code: "sleeper-copy", name: "Sleeper 2.4m", unit: "each", buy_price: 1, sell_price: 2, variant_of_uid: "sleeper" });
  assert.equal(copy.variant_of_uid, original.uid);
  await assert.rejects(store.updateItem("sleeper", { variant_of_uid: copy.uid }), { code: "CYCLE" });
  await assert.rejects(store.updateItem("sleeper-copy", { variant_of_uid: "missing" }), { code: "UNKNOWN_REF" });
  const cleared = await store.updateItem("sleeper-copy", { variant_of_uid: null });
  assert.equal(cleared.variant_of_uid, null);
  const post = await store.createItem({ code: "POST-LEGACY-7", name: "Steel post", unit: "each", buy_price: 1, sell_price: 2 });
  const byName = await store.updateItem("sleeper-copy", { variant_of: "  steel POST " });
  assert.equal(byName.variant_of_uid, post.uid, "the price book names the original, not its code");
});

test("an item created without a code is keyed by its uid, and renaming it changes neither", async (t) => {
  const { store } = await freshStore(t);
  const item = await store.createItem({ name: "Gravel, 20mm", unit: "tonne", buy_price: 40, sell_price: 60 });
  assert.equal(item.code, item.uid);
  const renamed = await store.updateItem(item.uid, { name: "Crushed rock, 20mm" });
  assert.equal(renamed.name, "Crushed rock, 20mm");
  assert.equal(renamed.uid, item.uid);
  assert.equal(renamed.code, item.uid);
});

test("duplicateItem copies only the selected parent while reusing child item references", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "wall", name: "Wall service", unit: "m", catalog_type: "goods_service", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.createItem({ code: "post", name: "Post", unit: "each", buy_price: 30, sell_price: 50 });
  await store.createItem({ code: "steel", name: "Steel", unit: "m", buy_price: 8, sell_price: 12 });
  await store.addChild({ parentCode: "wall", childCode: "post", quantity: 3, entryQuantity: 3, entryUnit: "each", applicationMode: "fixed", pricingContribution: "listed_only" });
  await store.addChild({ parentCode: "post", childCode: "steel", quantity: 2 });

  const duplicated = await store.duplicateItem("wall", {}, { author: "test" });
  assert.notEqual(duplicated.code, "wall");
  assert.match(duplicated.uid, /^cat_[a-f0-9]{24}$/);
  assert.equal(duplicated.code, duplicated.uid, "a copy's code is its own uid, not a -copy of the source");
  assert.equal(duplicated.name, "Copy of Wall service");
  assert.equal(duplicated.children.length, 1);
  assert.deepEqual(
    { code: duplicated.children[0].code, quantity: duplicated.children[0].quantity, entry_quantity: duplicated.children[0].entry_quantity, entry_unit: duplicated.children[0].entry_unit, application_mode: duplicated.children[0].application_mode, pricing_contribution: duplicated.children[0].pricing_contribution },
    { code: "post", quantity: 3, entry_quantity: 3, entry_unit: "each", application_mode: "fixed", pricing_contribution: "listed_only" },
  );
  assert.equal((await store.getItem("post")).children[0].code, "steel");
  assert.equal((await store.listItems()).filter((item) => item.code.includes("copy")).length, 0);
  await store.updateItem(duplicated.code, { name: "Duplicate-only wall" });
  assert.equal((await store.getItem("wall")).name, "Wall service");
});

test("duplicateItem links recipe-backed visible children and suffixes generated names", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "wall-1000", name: "1000mm wall", unit: "bay", catalog_type: "goods_service", buy_price: 1600, sell_price: 2400, buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.createItem({ code: "wall-counter-1000", name: "Wall counter", unit: "each", buy_price: 300, sell_price: 450 });
  await store.createItem({ code: "wall-materials-1000", name: "Wall materials", unit: "bay", buy_price: 500, sell_price: 700 });
  setRecipeChildrenByParentForTests(new Map([["wall-1000", [
    { childCode: "wall-counter-1000", quantity: 1, source: "recipe", recipeCode: "wall-recipe" },
    { childCode: "wall-materials-1000", quantity: 1, source: "recipe", recipeCode: "wall-recipe" },
  ]]]));
  t.after(() => setRecipeChildrenByParentForTests(null));

  const first = await store.duplicateItem("wall-1000");
  assert.deepEqual(first.children.map((child) => [child.code, child.quantity, child.source]), [
    ["wall-counter-1000", 1, "db"],
    ["wall-materials-1000", 1, "db"],
  ]);
  const second = await store.duplicateItem("wall-1000");
  assert.equal(first.name, "Copy of 1000mm wall");
  assert.equal(second.name, "Copy of 1000mm wall (2)");
  await assert.rejects(store.duplicateItem("wall-1000", { name: "Wall counter" }), { code: "NAME_CONFLICT" });
});

test("deleteItem removes the item and the kit links that use it; its history stays", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "service", name: "Service", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.createItem({ code: "child", name: "Child", unit: "each", buy_price: 10, sell_price: 20 });
  await store.createItem({ code: "leaf", name: "Leaf", unit: "each", buy_price: 2, sell_price: 4 });
  await store.addChild({ parentCode: "service", childCode: "child", quantity: 2 });
  await store.addChild({ parentCode: "child", childCode: "leaf", quantity: 3 });
  await store.attachEvidence({ itemCode: "child", side: "general", kind: "note", note: "delete me" });

  const deleted = await store.deleteItem("child", { author: "test" });
  assert.equal(deleted.code, "child");
  assert.equal(await store.getItem("child"), null);
  assert.equal((await store.getItem("service")).children.length, 0);
  assert.equal((await store.getItem("leaf")).name, "Leaf");
  const [{ count }] = await selectRows(db, sql`select count(*)::int as count from catalog_evidence`);
  assert.equal(count, 0);
  const kept = await selectRows(db, sql`select field, new_value from catalog_history where item_code = 'child' order by id`);
  assert.deepEqual(kept.at(-1), { field: "*", new_value: "deleted" });
});

// ── Name guard ──

test("the active-name guard: collisions refused, archived and own-name edits allowed", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "a", name: "Gravel 20mm" });
  await assert.rejects(store.createItem({ code: "b", name: "  gravel   20MM " }), (error) => error.code === "NAME_CONFLICT" && error.conflict.code === "a");
  await store.createItem({ code: "c", name: "Gravel 20mm", status: "archived" });
  await assert.rejects(store.updateItem("c", { status: "active" }), { code: "NAME_CONFLICT" });
  await store.updateItem("a", { name: "Gravel 20mm" });
  await store.createItem({ code: "d", name: "Sand" });
  await assert.rejects(store.updateItem("d", { name: "gravel 20mm" }), { code: "NAME_CONFLICT" });

  // A pre-existing duplicate pair (imported as-is) stays editable.
  await asDefaultOrg(db).execute(sql`update items set name = 'Sand' where code = 'a'`);
  store.invalidate();
  const edited = await store.updateItem("a", { name: "Sand", status: "active", sell_price: 99 });
  assert.equal(edited.sell_price, 99);
});

// ── Kits ──

test("any item can have children; child changes write child-specific history", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "parent", name: "Parent", unit: "each", buy_price: 0, sell_price: 0 });
  await store.createItem({ code: "child", name: "Child", unit: "hour", buy_price: 10, sell_price: 15 });
  const added = await store.addChild({ parentCode: "parent", childCode: "child", quantity: 1 }, { author: "Seeder" });
  assert.equal(added.code, "child");
  await store.updateChild({ parentCode: "parent", childCode: "child", quantity: 0.083333, entryQuantity: 5, entryUnit: "min" }, { author: "Estimator" });
  assert.deepEqual((await history(db, "parent")).filter((row) => row.changed_by === "Estimator"), [
    { field: "children.child.quantity", old_value: "1", new_value: "0.083333", changed_by: "Estimator" },
    { field: "children.child.entry_quantity", old_value: null, new_value: "5", changed_by: "Estimator" },
    { field: "children.child.entry_unit", old_value: null, new_value: "min", changed_by: "Estimator" },
  ]);
  const listed = await store.listChildren("parent");
  assert.deepEqual(listed.map((child) => [child.code, child.quantity, child.entry_quantity, child.entry_unit]), [["child", 0.083333, 5, "min"]]);
});

test("a component entered in a unit that cannot convert to the child's unit is refused", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "kit", name: "Kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.createItem({ code: "gravel", name: "Gravel", unit: "tonne", buy_price: 50, sell_price: 70 });
  await assert.rejects(
    store.addChild({ parentCode: "kit", childCode: "gravel", quantity: 1, entryQuantity: 1, entryUnit: "m" }),
    (error) => error.code === "UNIT_MISMATCH" && /Gravel \(gravel\) is priced per tonne/.test(error.message),
  );
  await store.createItem({ code: "labour", name: "Labour", unit: "hour", buy_price: 50, sell_price: 80 });
  const ok = await store.addChild({ parentCode: "kit", childCode: "labour", quantity: 0.5, entryQuantity: 30, entryUnit: "minutes" });
  assert.equal(ok.entry_unit, "min");
});

test("cycles and self-links are refused", async (t) => {
  const { store } = await freshStore(t);
  for (const code of ["a", "b", "c"]) await store.createItem({ code, name: code.toUpperCase(), buy_price: 1, sell_price: 1 });
  await store.addChild({ parentCode: "a", childCode: "b" });
  await store.addChild({ parentCode: "b", childCode: "c" });
  await assert.rejects(store.addChild({ parentCode: "c", childCode: "a" }), (error) => error.code === "CYCLE" && /cycle/.test(error.message));
  await assert.rejects(store.addChild({ parentCode: "a", childCode: "a" }), { code: "CYCLE" });
  await assert.rejects(store.addChild({ parentCode: "a", childCode: "b" }), { code: "INVALID" });
});

test("computed kits roll up leaf-first; listed-only children are shown, not summed", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "pipe", name: "Pipe", buy_price: 5, sell_price: 8 });
  await store.createItem({ code: "pit", name: "Pit", buy_price: 60, sell_price: 90 });
  await store.createItem({ code: "option", name: "Option", buy_price: 90, sell_price: 250 });
  await store.createItem({ code: "run", name: "Drainage run", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.createItem({ code: "job", name: "Drainage job", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.addChild({ parentCode: "run", childCode: "pipe", quantity: 10 });
  await store.addChild({ parentCode: "run", childCode: "pit", quantity: 1 });
  await store.addChild({ parentCode: "run", childCode: "option", quantity: 1, pricingContribution: "listed_only" });
  await store.addChild({ parentCode: "job", childCode: "run", quantity: 2 });

  const run = await store.getItem("run");
  assert.equal(run.effective_buy_price, 110);
  assert.equal(run.effective_sell_price, 170);
  assert.equal(run.children.find((child) => child.code === "option").pricing_contribution, "listed_only");
  assert.equal((await store.getItem("job")).effective_sell_price, 340);
  await store.updateItem("pipe", { sell_price: 9 });
  assert.equal((await store.getItem("job")).effective_sell_price, 360, "a child price change flows up without a stored cache");
});

test("an archived or unpriced child makes the kit unpriced, never zero", async (t) => {
  const { store } = await freshStore(t);
  await store.createItem({ code: "leaf", name: "Leaf", buy_price: 5, sell_price: 8 });
  await store.createItem({ code: "unpriced", name: "Unpriced" });
  await store.createItem({ code: "kit", name: "Kit", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.addChild({ parentCode: "kit", childCode: "leaf", quantity: 1 });
  assert.equal((await store.getItem("kit")).effective_sell_price, 8);

  await store.archiveItem("leaf");
  const archived = await store.getItem("kit");
  assert.equal(archived.effective_sell_price, null);
  assert.equal(archived.inactive_component_count, 1);
  assert.deepEqual(archived.pricing_problems.map((problem) => problem.kind), ["inactive_child"]);

  await store.updateItem("leaf", { status: "active" });
  await store.addChild({ parentCode: "kit", childCode: "unpriced", quantity: 1 });
  const unpriced = await store.getItem("kit");
  assert.equal(unpriced.effective_sell_price, null);
  assert.equal(unpriced.effective_buy_price, null);
});

// ── Pricing basis ──

test("pricing_basis rules: per_tonne/per_load need a factor, per_m3 refuses one", async (t) => {
  const { store } = await freshStore(t);
  const tonne = await store.createItem({ code: "fill", name: "Fill", unit: "tonne", buy_price: 20, sell_price: 30, pricing_basis: "per_tonne", pricing_basis_factor: 1.6 });
  assert.equal(tonne.pricing_basis, "per_tonne");
  assert.equal(tonne.pricing_basis_factor, 1.6);
  await assert.rejects(store.createItem({ code: "x1", name: "X1", pricing_basis: "per_tonne" }), { code: "PRICING_BASIS" });
  await assert.rejects(store.createItem({ code: "x2", name: "X2", pricing_basis: "per_load" }), { code: "PRICING_BASIS" });
  await assert.rejects(store.createItem({ code: "x3", name: "X3", pricing_basis: "per_m3", pricing_basis_factor: 2 }), { code: "PRICING_BASIS" });
  await assert.rejects(store.createItem({ code: "x4", name: "X4", pricing_basis_factor: 2 }), { code: "PRICING_BASIS" });
  const load = await store.updateItem("fill", { pricing_basis: "per_load", pricing_basis_factor: 7 });
  assert.equal(load.pricing_basis_factor, 7);
  await assert.rejects(store.updateItem("fill", { pricing_basis: "per_m3" }), { code: "PRICING_BASIS" }, "the merged state is validated, not the patch alone");
  const m3 = await store.updateItem("fill", { pricing_basis: "per_m3", pricing_basis_factor: null });
  assert.equal(m3.pricing_basis_factor, null);
  const duplicate = await store.duplicateItem("fill");
  assert.equal(duplicate.pricing_basis, "per_m3");
});

// ── Quote-line interfaces ──

test("current price, items by uid, kit snapshot and price key for quote lines", async (t) => {
  const { store } = await freshStore(t);
  const leaf = await store.createItem({ code: "labour", name: "Labour", unit: "hour", buy_price: 50, sell_price: 80 });
  const kit = await store.createItem({ code: "kit", name: "Kit", unit: "m", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.addChild({ parentCode: "kit", childCode: "labour", quantity: 0.5 });

  const leafPrice = await store.getCurrentPrice(leaf.uid);
  assert.equal(leafPrice.priceId, leaf.price_id);
  assert.equal(leafPrice.sell, 80);
  assert.equal(leafPrice.rolledUp, false);
  const kitPrice = await store.getCurrentPrice(kit.uid);
  assert.equal(kitPrice.priceId, null, "a rolled-up kit has no single price row");
  assert.equal(kitPrice.sell, 40);
  assert.match(kitPrice.priceKey, /^pk_[0-9a-f]{24}$/);

  const snapshot = await store.getKitSnapshot(kit.uid);
  assert.deepEqual(snapshot.components.map((component) => [component.item.code, component.quantity, component.item.priceId]), [["labour", 0.5, leaf.price_id]]);

  const [byUid] = await store.getItemsByUids([leaf.uid, "missing"]);
  assert.equal(byUid.code, "labour");
  const prices = await store.getCurrentPrices([kit.uid, "missing"]);
  assert.equal(prices.missing, null);
  assert.equal(prices[kit.uid].sell, 40);

  await store.updateChild({ parentCode: "kit", childCode: "labour", quantity: 1 });
  assert.notEqual((await store.getCurrentPrice(kit.uid)).priceKey, kitPrice.priceKey, "a kit's key moves when its contents change");
  await store.updateItem("labour", { sell_price: 90 });
  const after = await store.getCurrentPrice(leaf.uid);
  assert.notEqual(after.priceId, leafPrice.priceId);
  assert.notEqual(after.priceKey, leafPrice.priceKey);
});

test("the catalogue version moves on every write and the cache follows it across stores", async (t) => {
  const { store, db } = await freshStore(t);
  const other = await openCatalogStore({ db });
  const v0 = await store.catalogVersion();
  await store.createItem({ code: "a", name: "A", buy_price: 1, sell_price: 2 });
  const v1 = await other.catalogVersion();
  assert.equal(v1.version, v0.version + 1);
  assert.notEqual(v1.etag, v0.etag);
  assert.equal((await other.getItem("a")).sell_price, 2, "a second store sees the first store's write");
});

// ── Categories, evidence, history ──

test("categories are unique case-insensitively", async (t) => {
  const { store } = await freshStore(t);
  const drainage = await store.createCategory({ name: "Drainage" });
  await assert.rejects(store.createCategory({ name: "drainage" }), (error) => /already exists/.test(error.message) && error.statusCode === 409);
  const renamed = await store.updateCategory(drainage.id, { name: "Stormwater" });
  assert.equal(renamed.name, "Stormwater");
  await assert.rejects(store.updateCategory(999, { name: "Nope" }), { code: "NOT_FOUND" });
  assert.deepEqual((await store.listCategories()).map((category) => category.name), ["Stormwater"]);
  await store.deleteCategory(drainage.id);
  assert.deepEqual(await store.listCategories(), []);
});

test("categories can be reordered in one write; ids not named keep their order after", async (t) => {
  const { store } = await freshStore(t);
  const a = await store.createCategory({ name: "Earthworks" });
  const b = await store.createCategory({ name: "Drainage" });
  const c = await store.createCategory({ name: "Haulage" });
  const before = await store.catalogVersion();
  const ordered = await store.reorderCategories([c.id, a.id]);
  assert.deepEqual(ordered.map((category) => category.name), ["Haulage", "Earthworks", "Drainage"]);
  assert.deepEqual(ordered.map((category) => category.sort_order), [0, 1, 2]);
  assert.ok((await store.catalogVersion()).version > before.version);
  const unchanged = await store.catalogVersion();
  await store.reorderCategories([c.id, a.id, b.id]);
  assert.equal((await store.catalogVersion()).version, unchanged.version);
  await assert.rejects(store.reorderCategories([999]), { code: "NOT_FOUND" });
  await assert.rejects(store.reorderCategories("nope"), { code: "INVALID" });
});

test("an item's detail lists the kits it is used in", async (t) => {
  const { store } = await freshStore(t);
  const part = await store.createItem({ code: "gravel", name: "Gravel", unit: "tonne", buy_price: 40, sell_price: 60 });
  await store.createItem({ code: "path", name: "Path kit", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.createItem({ code: "base", name: "Base kit", buy_price_mode: "computed", sell_price_mode: "computed", status: "archived" });
  await store.addChild({ parentCode: "path", childCode: "gravel", quantity: 2 });
  await store.addChild({ parentCode: "base", childCode: "gravel", quantity: 0.5 });
  const detail = await store.getItem(part.uid);
  assert.deepEqual(detail.used_in.map(({ name, status, quantity }) => ({ name, status, quantity })), [
    { name: "Base kit", status: "archived", quantity: 0.5 },
    { name: "Path kit", status: "active", quantity: 2 },
  ]);
  assert.deepEqual((await store.getItem("path")).used_in, []);
});

test("point-in-time snapshot undoes later history", async (t) => {
  let now = new Date("2026-02-01T00:00:00.000Z");
  const { store } = await freshStore(t, { clock: () => now });
  await store.createItem({ code: "rate", name: "Rate", buy_price: 10, sell_price: 20 });
  now = new Date("2026-02-10T00:00:00.000Z");
  await store.updateItem("rate", { name: "Rate renamed", sell_price: 25 });
  const past = await store.getCatalogAtPointInTime("2026-02-05T00:00:00.000Z");
  assert.equal(past[0].name, "Rate");
  assert.equal(past[0].sell_price, 20);
  const itemHistory = await store.getItemHistory("rate");
  assert.equal(itemHistory[0].changed_at, "2026-02-10T00:00:00.000Z");
});

test("listItems keeps the client's status/category/search semantics and the legacy kind filter", async (t) => {
  const { store, db } = await freshStore(t);
  await store.createItem({ code: "drain-partial", name: "Drainage installation", unit: "each", category: "Drainage" });
  await store.createItem({ code: "drain-exact-b", name: "Drain", unit: "each", category: "Drainage" });
  await asDefaultOrg(db).execute(sql`insert into items (uid, code, name, unit_code, category, status, visibility, created_at, updated_at)
    values ('cat_dupe', 'drain-exact-a', 'Drain', 'each', 'Drainage', 'active', 'internal', now(), now())`);
  store.invalidate();
  await store.createItem({ code: "field-match", name: "High capacity", unit: "hour", category: "Stormwater", catalog_type: "goods_service" });
  await store.createItem({ code: "archived-drain", name: "Archived drainage", category: "Drainage", status: "archived" });
  await store.createItem({ code: "uncategorised", name: "Loose item" });
  await store.addChild({ parentCode: "drain-partial", childCode: "drain-exact-b" });

  assert.deepEqual((await store.listItems({ search: "drain" })).map((item) => item.code).slice(0, 3), ["drain-exact-a", "drain-exact-b", "drain-partial"]);
  assert.deepEqual((await store.listItems({ search: "stormwater hour goods service" })).map((item) => item.code), ["field-match"]);
  assert.deepEqual((await store.listItems({ status: "active", category: "uncategorised" })).map((item) => item.code), ["uncategorised"]);
  assert.deepEqual((await store.listItems({ status: "all", category: "Drainage" })).map((item) => item.code).sort(), ["archived-drain", "drain-exact-a", "drain-exact-b", "drain-partial"]);
  assert.deepEqual((await store.listItems({ kind: "component" })).map((item) => item.code), ["drain-partial"]);
  const parent = (await store.listItems()).find((item) => item.code === "drain-partial");
  assert.equal(parent.child_count, 1);
});

// ── Write responses ──

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A Drizzle handle whose read-only snapshot transactions can be held after
// they have read, so a load that began before a write can finish after it.
function gatedDb(db) {
  const control = { gate: null, readDone: null };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return async (fn, options) => {
          const result = await target.transaction(fn, options);
          // Hold the whole-catalogue load (repeatable read), not the version check.
          if (options?.isolationLevel === "repeatable read" && control.gate) {
            control.readDone?.resolve();
            await control.gate.promise;
          } else if (!options?.accessMode && control.gate) {
            const gate = control.gate;
            control.gate = null;
            gate.resolve();
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { proxy, control };
}

test("a write's response is read after its commit, even when a load began before it", async (t) => {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const { proxy, control } = gatedDb(handle.db);
  const store = await openCatalogStore({ db: proxy });
  const other = await openCatalogStore({ db: handle.db });
  const created = await store.createItem({ code: "rate", name: "Rate", buy_price: 10, sell_price: 20 });

  // Another writer moves the catalogue, so the next read through `store` loads.
  await other.updateItem("rate", { sell_price: 21 });
  control.gate = deferred();
  control.readDone = deferred();
  const inflight = store.getItem("rate");
  await control.readDone.promise; // that load has read version 2 and is held

  const updated = await store.updateItem("rate", { sell_price: 22 });
  assert.equal(updated.version, created.version + 2);
  assert.equal(updated.sell_price, 22, "the response is not the pre-write snapshot");
  assert.equal((await inflight).sell_price, 21);
  assert.equal((await store.getItem("rate")).sell_price, 22, "the stale load was not cached");

  // Same for a create: its response carries its own price.
  await other.updateItem("rate", { sell_price: 23 });
  control.gate = deferred();
  control.readDone = deferred();
  const inflightAgain = store.getItem("rate");
  await control.readDone.promise;
  const fresh = await store.createItem({ code: "gravel", name: "Gravel", unit: "tonne", buy_price: 40, sell_price: 60 });
  assert.deepEqual([fresh.buy_price, fresh.sell_price], [40, 60]);
  assert.ok(fresh.price_id);
  assert.ok(fresh.price_effective_from);
  await inflightAgain;
});

test("structure writes can name the catalogue version they were based on", async (t) => {
  const { store } = await freshStore(t);
  const { version } = await store.catalogVersion();
  await store.createItem({ code: "kit", name: "Kit", buy_price_mode: "computed", sell_price_mode: "computed" });
  await store.createItem({ code: "part", name: "Part", unit: "each", buy_price: 1, sell_price: 2 });
  await assert.rejects(store.createCategory({ name: "Drainage" }, { expectedCatalogVersion: version }), { code: "VERSION_CONFLICT" });
  await assert.rejects(store.addChild({ parentCode: "kit", childCode: "part", quantity: 1 }, { expectedCatalogVersion: version }), { code: "VERSION_CONFLICT" });
  const current = (await store.catalogVersion()).version;
  const category = await store.createCategory({ name: "Drainage" }, { expectedCatalogVersion: current });
  assert.equal(category.name, "Drainage");
  await assert.rejects(store.updateCategory(category.id, { name: "Stormwater" }, { expectedCatalogVersion: current }), { code: "VERSION_CONFLICT" });
  assert.deepEqual((await store.listCategories()).map((row) => row.name), ["Drainage"]);
});
