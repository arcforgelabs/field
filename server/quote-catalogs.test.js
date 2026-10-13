import assert from "node:assert/strict";
import test from "node:test";

import { getQuoteCatalog, hasQuoteCatalog, listQuoteCatalogs, readQuoteCatalogReference, serializeQuoteCatalog } from "./quote-catalogs.js";
import { DEFAULT_QUOTE_CATALOG_ID, resolveQuoteCatalogIdFromMeta } from "./quote-catalog-ids.js";

// formatMaybeMoney() re-coerced an already
// null-or-number rate with Number(value) before checking Number.isFinite —
// Number(null) is 0, which is finite, so a null sellRate/buyingRate took the
// money branch and rendered as a real "$0.00" instead of the intended "-"
// unpriced marker. This reference table is both operator-readable
// (GET /api/quote-catalogs/:id/reference) and fed to AI extraction as
// pricing context, so a disposal rule with no rate looked indistinguishable
// from a rule that is genuinely free.
test("readQuoteCatalogReference renders '-' for an unpriced disposal rule, never '$0.00'", async () => {
  // The sample catalogue's disposal rules (unclean-fill-disposal, clean-fill-
  // disposal, concrete-waste-disposal, green-waste-disposal) carry no json5
  // unitPrice by design and no test in this file activates a
  // price-catalog authority, so the default "catalog" provider resolves
  // their sellRate/buyingRate to null via resolveRuleSellRate.
  const reference = await readQuoteCatalogReference("default");
  assert.ok(reference, "default reference should exist");

  const lines = reference.body.split("\n");
  const disposalLines = lines.filter((line) => /^\|\s*(unclean|clean|concrete-waste|green-waste)-.*disposal\s*\|/.test(line));
  assert.ok(disposalLines.length >= 4, "expected at least the four disposal rules in the Line Items table");

  for (const line of disposalLines) {
    assert.doesNotMatch(line, /\$0\.00/, `unpriced disposal rule rendered a false $0.00: ${line}`);
    // Both the Sell and Buy columns must show the unpriced marker.
    const cells = line.split("|").map((cell) => cell.trim());
    // Splitting a leading-pipe row on "|" yields a leading "" cell, so the
    // table's Code column lands at index 1:
    // "" | Code | Item | Authority Item | Status | Sell | Buy | Default Qty | Use When | ""
    const [, , , , , sellCell, buyCell] = cells;
    assert.equal(sellCell, "-", `expected unpriced sell rate to render "-", got "${sellCell}" for: ${line}`);
    assert.equal(buyCell, "-", `expected unpriced buy rate to render "-", got "${buyCell}" for: ${line}`);
  }
});

// Stored quotes, jobs and links written before #122 name the sample
// catalogue by its old id. A sent document never changes, so that id must
// still find the same catalogue, while nothing new is written with it.
test("the sample catalogue is \"default\", and its old id still resolves to it", () => {
  assert.equal(DEFAULT_QUOTE_CATALOG_ID, "default");
  assert.equal(getQuoteCatalog().id, "default");
  assert.ok(listQuoteCatalogs().every((quoteCatalog) => quoteCatalog.id !== "embark-default"));

  assert.ok(hasQuoteCatalog("embark-default"));
  assert.equal(getQuoteCatalog("embark-default"), getQuoteCatalog("default"));
  assert.equal(serializeQuoteCatalog("embark-default").id, "default");
  assert.equal(resolveQuoteCatalogIdFromMeta({ quoteCatalogId: "embark-default" }), "default");
  assert.equal(resolveQuoteCatalogIdFromMeta({ quoteCatalogId: "field-verification" }), "field-verification");
  assert.equal(hasQuoteCatalog("someone-else"), false);
});
