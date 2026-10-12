import assert from "node:assert/strict";
import test from "node:test";

import { readQuoteCatalogReference } from "./quote-catalogs.js";

// DEL-46 (P2-A, round 7): formatMaybeMoney() re-coerced an already
// null-or-number rate with Number(value) before checking Number.isFinite —
// Number(null) is 0, which is finite, so a null sellRate/buyingRate took the
// money branch and rendered as a real "$0.00" instead of the intended "-"
// unpriced marker. This reference table is both operator-readable
// (GET /api/quote-catalogs/:id/reference) and fed to AI extraction as
// pricing context, so a disposal rule with no rate looked indistinguishable
// from a rule that is genuinely free.
test("readQuoteCatalogReference renders '-' for an unpriced disposal rule, never '$0.00' (DEL-46 round 7)", async () => {
  // embark-default's disposal rules (unclean-fill-disposal, clean-fill-
  // disposal, concrete-waste-disposal, green-waste-disposal) carry no json5
  // unitPrice by design (DEL-46) and no test in this file activates a
  // price-catalog authority, so the default "catalog" provider resolves
  // their sellRate/buyingRate to null via resolveRuleSellRate.
  const reference = await readQuoteCatalogReference("embark-default");
  assert.ok(reference, "embark-default reference should exist");

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
