import assert from "node:assert/strict";
import test from "node:test";

import { quoteCatalogReviewKey } from "./quote-catalog-review.js";

function organizer() {
  return {
    root: ["manual:kit", "manual:turf"],
    nodes: {
      "manual:turf": { kind: "source", sourceKind: "manual", rateMode: "catalog-linked", sellRate: 14, buyRate: 9, quantity: 20, unit: "m2", catalogItemUid: "itm_turf" },
      "manual:kit": { kind: "source", sourceKind: "manual", rateMode: "catalog-linked", sellRate: 0, buyRate: 0, children: ["manual:a"], catalogItemUid: "itm_kit" },
      "manual:a": { kind: "source", sourceKind: "manual", rateMode: "catalog-linked", sellRate: 5, buyRate: 2, quantity: 2, catalogQuantity: 2, catalogComponentOf: "itm_kit" },
    },
  };
}

test("the key survives a JSON round trip, key order and undefined fields", () => {
  const draft = organizer();
  const key = quoteCatalogReviewKey(draft, "manual:turf");
  assert.match(key, /^rk1-[0-9a-f]{14}$/);
  assert.equal(quoteCatalogReviewKey(JSON.parse(JSON.stringify(draft)), "manual:turf"), key);
  const reordered = organizer();
  const { sellRate, ...rest } = reordered.nodes["manual:turf"];
  reordered.nodes["manual:turf"] = { notes: undefined, ...rest, sellRate };
  assert.equal(quoteCatalogReviewKey(reordered, "manual:turf"), key);
});

test("a typed rate or an override moves a row's key", () => {
  const key = quoteCatalogReviewKey(organizer(), "manual:turf");
  const typed = organizer();
  Object.assign(typed.nodes["manual:turf"], { rateMode: "manual", sellRate: 12.5 });
  assert.notEqual(quoteCatalogReviewKey(typed, "manual:turf"), key);
  const overridden = organizer();
  overridden.nodes["manual:turf"].priceOverride = 250;
  assert.notEqual(quoteCatalogReviewKey(overridden, "manual:turf"), key);
});

test("editing, adding or removing a row under a kit moves the kit's key, not its siblings'", () => {
  const kitKey = quoteCatalogReviewKey(organizer(), "manual:kit");
  const turfKey = quoteCatalogReviewKey(organizer(), "manual:turf");
  const edited = organizer();
  edited.nodes["manual:a"].quantity = 3;
  assert.notEqual(quoteCatalogReviewKey(edited, "manual:kit"), kitKey);
  assert.equal(quoteCatalogReviewKey(edited, "manual:turf"), turfKey);
  const removed = organizer();
  delete removed.nodes["manual:a"];
  assert.notEqual(quoteCatalogReviewKey(removed, "manual:kit"), kitKey);
  const added = organizer();
  added.nodes["manual:mine"] = { kind: "source", sourceKind: "manual", rateMode: "manual", sellRate: 1 };
  added.nodes["manual:kit"].children.push("manual:mine");
  assert.notEqual(quoteCatalogReviewKey(added, "manual:kit"), kitKey);
});

test("expanding, collapsing or annotating a row does not move its key", () => {
  const kitKey = quoteCatalogReviewKey(organizer(), "manual:kit");
  const viewed = organizer();
  Object.assign(viewed.nodes["manual:kit"], { collapsed: true, notes: "check levels", rowStyle: "bold", amountVisible: false });
  viewed.nodes["manual:a"].collapsed = false;
  assert.equal(quoteCatalogReviewKey(viewed, "manual:kit"), kitKey);
});

test("a row that is not on the organizer has no key", () => {
  assert.equal(quoteCatalogReviewKey(organizer(), "manual:gone"), null);
  assert.equal(quoteCatalogReviewKey(organizer(), "toString"), null);
  assert.equal(quoteCatalogReviewKey(null, "manual:turf"), null);
});
