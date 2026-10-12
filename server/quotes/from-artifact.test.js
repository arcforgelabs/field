// Mapping today's quote artifacts to quote rows (#241): organizer groups,
// manual qty x rate rows, catalogue kits as component rows, engine lines,
// fixed prices, listed-only and excluded rows. Every version reproduces what
// Field shows: a line keeps the total it printed (decided 2026-10-12), marked
// `printed` with the reason where qty x rate does not give it, and GST is
// worked out once on the subtotal.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getCustomerPresentationFinancials } from "../quote-presentation.js";
import { compareTotals, mapQuoteArtifact, mappedDigest, quoteTaxRatePercent, shownTotals } from "./from-artifact.js";
import {
  FIXTURE_META,
  engineQuote,
  fixedLotQuote,
  floatRoundedLineQuote,
  HALF_CENT_PRINTED,
  halfCentGstQuote,
  listedExcludedOverrideQuote,
  perLineGstQuote,
  sectionedQuote,
  subCentRateQuote,
} from "./test-fixtures.js";

const summary = (line) => `${line.lineType} ${line.name}: ${line.quantity} ${line.unitCode} x ${line.unitSell} = ${line.lineTotal}${line.lineTotalSource === "printed" ? " (printed)" : ""}`;

describe("mapQuoteArtifact", () => {
  test("groups become sections, a nested group a heading, and the rows reproduce the shown totals", () => {
    const mapped = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META });
    assert.deepEqual(mapped.shown, { subtotal: "1851.00", taxTotal: "185.10", total: "2036.10" });
    assert.deepEqual(mapped.totals, mapped.shown);
    assert.deepEqual(compareTotals(mapped.totals, mapped.shown), []);
    assert.deepEqual(mapped.printedLines, []);
    assert.deepEqual(mapped.sections.map((section) => [section.title, section.sourceNodeId]), [["Retaining wall", "group:walls"]]);
    const [walls] = mapped.sections;
    assert.deepEqual(mapped.lines.map(summary), [
      "item Sleepers, 200 mm: 12.0000 m x 85.5000 = 1026.00",
      "item Wall bay kit: 2.0000 each x 50.0000 = 100.00",
      "component Steel post: 3.0000 each x 10.0000 = 30.00",
      "component Concrete: 1.0000 each x 20.0000 = 20.00",
      "note Extras: 1.0000 lot x null = 0.00",
      "custom Capping: 1.0000 lot x 75.0000 = 75.00",
      "custom Drainage: 1.0000 lot x 500.0000 = 500.00",
      "component Ag pipe: 10.0000 m x 42.0000 = 420.00",
      "custom Council fee: 1.0000 lot x 150.0000 = 150.00",
    ]);
    const byName = Object.fromEntries(mapped.lines.map((line) => [line.name, line]));
    for (const name of ["Sleepers, 200 mm", "Wall bay kit", "Steel post", "Concrete", "Extras", "Capping"]) assert.equal(byName[name].sectionKey, walls.key, name);
    assert.equal(byName.Drainage.sectionKey, null);
    assert.equal(byName["Steel post"].parentKey, byName["Wall bay kit"].key);
    assert.equal(byName.Capping.parentKey, byName.Extras.key);
    assert.equal(byName["Ag pipe"].parentKey, byName.Drainage.key);
    assert.deepEqual([byName["Sleepers, 200 mm"].itemUid, byName["Sleepers, 200 mm"].priceUid, byName["Sleepers, 200 mm"].priceKey, byName["Sleepers, 200 mm"].code], ["itm_SLEEPER", "41", "pk-sleeper", "MAT-SLEEPER-200"]);
    assert.deepEqual([byName["Wall bay kit"].itemUid, byName["Wall bay kit"].priceUid, byName["Wall bay kit"].priceKey], ["itm_KIT", null, "pk-kit"]);
    assert.equal(byName["Steel post"].itemUid, "itm_POST");
    assert.equal(byName["Sleepers, 200 mm"].unitCost, "60.0000");
    assert.equal(byName.Drainage.isPriceOverride, true);
    assert.match(byName.Drainage.overrideReason, /fixed price on a group/);
    assert.ok(mapped.lines.every((line) => line.taxCode === "GST" && line.taxRate === "10.000"));
    assert.ok(mapped.lines.every((line) => line.lineTotalSource === "computed"));
    assert.equal(mapped.header.taxTotalSource, "computed");
  });

  test("the header: number, version, customer, scope, currency and validity", () => {
    const { header } = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META });
    assert.equal(header.number, "EQ-2501-01");
    assert.equal(header.version, 1);
    assert.equal(header.title, FIXTURE_META.title);
    assert.equal(header.scopeText, "Retaining wall and drainage");
    assert.deepEqual(header.customer, { name: "Pat Smith", email: "pat@example.invalid", siteAddress: "1 Example Road, Exampleton SA" });
    assert.equal(header.currency, "AUD");
    assert.match(header.validUntilOn, /^2026-10-2[56]$/, "generated date (local) plus 14 days");
    const frozen = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META, customer: { name: "As sent" } });
    assert.deepEqual(frozen.header.customer, { name: "As sent" });
    assert.equal(mapQuoteArtifact({ quote: { ...sectionedQuote(), quoteNumber: null }, meta: { id: "job-9" } }).header.number, "job-9", "the PDF prints the job id when there is no number");
  });

  test("engine lines become custom lines at their printed 1 lot", () => {
    const mapped = mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META });
    assert.deepEqual(mapped.lines.map(summary), [
      "custom Excavation: 1.0000 lot x 1200.0000 = 1200.00",
      "custom Haulage: 1.0000 lot x 333.3000 = 333.30",
    ]);
    assert.deepEqual(mapped.lines.map((line) => line.code), ["excavation", "haulage"]);
    assert.deepEqual(mapped.totals, { subtotal: "1533.30", taxTotal: "153.33", total: "1686.63" });
    assert.deepEqual(compareTotals(mapped.totals, mapped.shown), []);
  });

  test("listed-only rows are optional and not selected; excluded rows are kept but never counted; a fixed price keeps its quantity", () => {
    const mapped = mapQuoteArtifact({ quote: listedExcludedOverrideQuote(), meta: FIXTURE_META });
    assert.equal(mapped.excludedRows, 1);
    assert.deepEqual(mapped.lines.map(summary), [
      "custom Optional turf: 3.0000 m2 x 30.0000 = 90.00",
      "custom Removed item: 1.0000 lot x 999.0000 = 999.00",
      "custom Edging: 4.0000 m x 30.0000 = 120.00",
    ]);
    const [listed, removed, fixed] = mapped.lines;
    assert.deepEqual([removed.isExcluded, removed.lineCost], [true, null], "excluded: kept for the editor, its own rate and amount");
    assert.equal(fixed.displayUnitSell, "25.0000", "the PDF printed the row's original rate beside the fixed price");
    assert.equal(mapped.printable, true);
    assert.deepEqual([listed.isOptional, listed.isSelected], [true, false]);
    assert.equal(fixed.isPriceOverride, true);
    assert.match(fixed.overrideReason, /120\.00 for 4 m \(printed rate 25\.00\)/);
    assert.deepEqual(mapped.totals, mapped.shown);

    const lot = mapQuoteArtifact({ quote: fixedLotQuote(), meta: FIXTURE_META });
    assert.deepEqual(lot.lines.map(summary), ["custom Site clean: 1.0000 lot x 480.0000 = 480.00"]);
    assert.deepEqual(lot.totals, lot.shown);
  });

  test("a fixed price no whole-cent rate reaches keeps its printed total, with the reason", () => {
    const quote = fixedLotQuote();
    Object.assign(quote.presentation.organizer.nodes["manual:lot"], { quantity: 3, unit: "m", sellRate: 30, priceOverride: 100 });
    const mapped = mapQuoteArtifact({ quote, meta: FIXTURE_META });
    assert.deepEqual(mapped.shown, { subtotal: "100.00", taxTotal: "10.00", total: "110.00" });
    assert.deepEqual(mapped.lines.map(summary), ["custom Site clean: 3.0000 m x 30.0000 = 100.00 (printed)"]);
    const [line] = mapped.lines;
    assert.equal(line.isPriceOverride, true);
    assert.match(line.lineTotalReason, /fixed price 100\.00 for 3 m, which no whole-cent rate gives \(printed rate 30\.00\)/);
    assert.deepEqual(mapped.totals, mapped.shown);
    assert.equal(mapped.printedLines.length, 1);
  });

  test("a rate with more than two decimals is kept to four, and reproduces its printed amount", () => {
    const mapped = mapQuoteArtifact({ quote: subCentRateQuote(), meta: FIXTURE_META });
    assert.deepEqual(mapped.lines.map(summary), ["custom Odd rate: 3.0000 m x 33.3350 = 100.01"]);
    assert.deepEqual(mapped.totals, mapped.shown);
    assert.deepEqual(mapped.printedLines, []);
  });

  test("an amount the old renderer rounded in floating point is kept as printed", () => {
    const mapped = mapQuoteArtifact({ quote: floatRoundedLineQuote(), meta: FIXTURE_META });
    assert.deepEqual(mapped.shown.subtotal, "3.01");
    assert.deepEqual(mapped.lines.map(summary), ["custom Float rate: 3.0000 m x 1.0050 = 3.01 (printed)"]);
    assert.match(mapped.lines[0].lineTotalReason, /printed 3\.01, where 3 m x 1\.0050 is 3\.02/);
    assert.deepEqual(mapped.totals, mapped.shown);
  });

  test("GST is worked out once on the subtotal, as every sent PDF did", () => {
    const quote = perLineGstQuote();
    assert.equal(getCustomerPresentationFinancials(quote).gst, 3.02);
    const mapped = mapQuoteArtifact({ quote, meta: FIXTURE_META });
    assert.deepEqual(mapped.totals, { subtotal: "30.15", taxTotal: "3.02", total: "33.17" }, "not 3 x 1.01 per line");
    assert.equal(mapped.header.taxTotalSource, "computed");
  });

  test("GST on exactly half a cent is rounded exactly, and kept as a sent PDF printed it, with the reason", () => {
    const exact = mapQuoteArtifact({ quote: halfCentGstQuote(), meta: FIXTURE_META });
    assert.deepEqual(exact.shown, { subtotal: "21.15", taxTotal: "2.12", total: "23.27" });
    assert.deepEqual(exact.totals, exact.shown);
    assert.equal(exact.header.taxTotalSource, "computed");

    // A sent PDF's GST is taken only in the half-cent case, a cent apart.
    const other = mapQuoteArtifact({ quote: engineQuote(), meta: FIXTURE_META, printed: { subtotal: "1533.30", taxTotal: "153.34", total: "1686.64" } });
    assert.equal(other.header.taxTotalSource, "computed");
    assert.equal(other.totals.taxTotal, "153.33");

    const mapped = mapQuoteArtifact({ quote: halfCentGstQuote(), meta: FIXTURE_META, printed: HALF_CENT_PRINTED });
    assert.deepEqual(mapped.totals, HALF_CENT_PRINTED);
    assert.equal(mapped.header.taxTotalSource, "printed");
    assert.match(mapped.header.taxTotalReason, /21\.15 at 10 % is exactly half a cent, which the PDF rounded to 2\.11 rather than 2\.12/);
  });

  test("tax rate follows the quote's GST rate as the renderer reads it", () => {
    assert.equal(quoteTaxRatePercent({ quoteCatalog: { gstRate: 0.1 } }), "10.000");
    assert.equal(quoteTaxRatePercent({ quoteCatalog: { gstRate: 0.15 } }), "15.000");
    assert.equal(quoteTaxRatePercent({}), "10.000");
    // Today a zero rate reads as 10 % (`gstRate || 0.1`), so the rows do too.
    const zero = sectionedQuote();
    zero.quoteCatalog.gstRate = 0;
    const mapped = mapQuoteArtifact({ quote: zero, meta: FIXTURE_META });
    assert.ok(mapped.lines.every((line) => line.taxCode === "GST" && line.taxRate === "10.000"));
    assert.deepEqual(mapped.totals, shownTotals(zero));
  });

  test("the digest is stable for the same artifact and changes with any row", () => {
    const a = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META });
    const b = mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META });
    assert.equal(mappedDigest(a), mappedDigest(b));
    const changed = sectionedQuote();
    changed.presentation.organizer.nodes["manual:capping"].sellRate = 80;
    assert.notEqual(mappedDigest(mapQuoteArtifact({ quote: changed, meta: FIXTURE_META })), mappedDigest(a));
  });

  test("an empty quote maps to no lines and zero totals", () => {
    const mapped = mapQuoteArtifact({ quote: { version: 1, quoteNumber: "EQ-2501-09" }, meta: FIXTURE_META });
    assert.deepEqual(mapped.lines, []);
    assert.deepEqual(mapped.totals, { subtotal: "0.00", taxTotal: "0.00", total: "0.00" });
    assert.deepEqual(compareTotals(mapped.totals, mapped.shown), []);
  });
});
