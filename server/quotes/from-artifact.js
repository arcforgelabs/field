// Today's quote artifact (quote.json and its presentation organizer) as quote
// rows (#6; docs/PRICING_ENGINE.md "Moving today's data"). Pure: it reads
// the artifact the way the PDF does and returns rows plus the totals Field
// shows, so a caller can prove the rows reproduce them before writing.
//
// The rows are the customer-facing schedule as the renderer resolves it
// (shared/quote-presentation-renderer.js through server/quote-presentation.js),
// every row with the values it prints:
//
//   organizer group at the top level   a section, when its amount is the sum
//                                       of its rows; its rows follow in it
//   nested group                        a `note` line its rows sit under,
//                                       under the same condition
//   group with a fixed price, or whose  one `custom` line at its printed
//   amount is not the sum of its rows   amount (1 lot); its rows become
//                                       `component` lines under it
//   catalogue-linked row                an `item` line: item uid, price id
//                                       and price key from the row's link
//   manual row, engine row              a `custom` line
//   row under a priced row (kit         a `component` line: shown, never
//   components, engine breakdowns,      counted, because the row above
//   rows under a fixed price)           carries the price
//   "listed only" row                   its line, optional and not selected
//   row excluded from the price         its line, `isExcluded`: never printed
//                                       and never counted (the editor keeps it)
//
// Each line and section also keeps what the documents print besides money
// (#10): amount hidden or blank, collapsed, row style, how it is styled
// (`rowKind`), the rate printed beside a fixed price (`displayUnitSell`), its
// internal notes and cost. Sections and lines share one `sortOrder` sequence,
// so the printed order of sections and top-level lines is kept.
//
// Every line keeps the quantity and unit it prints, its rate to four decimals
// (the row's own rate, which the PDF prints rounded to cents) and, as its
// official amount, the total it printed (decided 2026-10-12). When
// round(quantity x rate, 2) gives that total the line's total is `computed`.
// When it does not (a rate with more than two decimals whose amount the PDF
// rounded differently, a fixed price no whole-cent rate reaches, an amount
// rolled up from rows) the total is `printed`, with the reason in
// `lineTotalReason`; such lines are listed in `printedLines`.
//
// GST is worked out once on the subtotal, as every sent PDF did. Before the
// renderer rounded GST exactly (#2), a PDF whose tax fell exactly on half a
// cent could print it a cent low ($21.15 at 10 %: $2.11, not $2.12). A sent
// version whose sent PDF did that keeps the GST as printed, with the reason,
// on the quote (`taxTotalSource`); the caller passes the totals read from
// that PDF as `printed`.
import { createHash } from "node:crypto";
import { getCustomerPresentationFinancials, getCustomerScheduleItems, getCustomerScheduleView } from "../quote-presentation.js";
import { comparePrintedSchedule, financialsFromRows, printedRate, scheduleFromRows } from "./schedule.js";
import { partiesDetails } from "../documents/job-sources.js";
import { centsToText, fixed, isHalfCentTax, lineTotalCents, quoteTotals, roundMoney, toCents, toScaled, unitSellForTotal } from "./totals.js";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isGenerated(row) {
  return row?.origin === "generated" || row?.sourceKind === "generated_component";
}

function isListedOnly(row) {
  return row?.pricingContribution === "listed_only";
}

function hasOverride(row) {
  return typeof row?.priceOverride === "number" && Number.isFinite(row.priceOverride);
}

/** What a row adds to the quote's subtotal, in cents (the renderer's contribution). */
function contributionCents(row) {
  if (row?.excludedFromPrice) return 0n;
  if (row?.contributionPrice !== undefined && row?.contributionPrice !== null) return toCents(finite(row.contributionPrice));
  if (isListedOnly(row)) return 0n;
  return toCents(finite(row?.totalPrice));
}

function money(value) {
  return roundMoney(finite(value));
}

function quantityText(value) {
  const { scaled } = toScaled(Math.max(0, finite(value, 1)), 4);
  const raw = scaled.toString().padStart(5, "0");
  return `${raw.slice(0, -4)}.${raw.slice(-4)}`;
}

function rate4(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return null;
  return fixed(Number(value), 4);
}

function unitCostText(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return null;
  const { scaled } = toScaled(Number(value), 4);
  const negative = scaled < 0n;
  const raw = (negative ? -scaled : scaled).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${raw.slice(0, -4)}.${raw.slice(-4)}`;
}

/** The schedule rows as a tree, in printed order (rows carry `depth`). */
function buildTree(items) {
  const roots = [];
  const stack = [];
  for (const item of items) {
    const depth = Math.max(0, Math.floor(finite(item?.depth, 0)));
    const node = { row: item, children: [] };
    while (stack.length > depth) stack.pop();
    const parent = depth > 0 ? stack[stack.length - 1] || null : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function countedChildrenCents(node) {
  let sum = 0n;
  for (const child of node.children) sum += contributionCents(child.row);
  return sum;
}

function catalogLink(organizerNode) {
  if (!organizerNode || typeof organizerNode !== "object") return null;
  const itemUid = text(organizerNode.catalogItemUid);
  if (!itemUid) return null;
  const priceId = organizerNode.catalogPriceId;
  return {
    itemUid,
    priceUid: priceId === null || priceId === undefined || priceId === "" ? null : String(priceId),
    priceKey: text(organizerNode.catalogPriceKey),
    code: text(organizerNode.catalogItemCode),
  };
}

/** The process-local calendar date of `iso` plus `days`, as YYYY-MM-DD (the PDF prints local dates). */
function localDatePlusDays(iso, days) {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return null;
  const date = new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function quoteValidityDays(quote) {
  return finite(quote?.presentation?.validityDays || quote?.quoteCatalog?.deliveryDefaults?.validityDays || 14, 14);
}

/** The GST rate as a percent with up to 3 decimals: 0.1 -> "10.000". */
export function quoteTaxRatePercent(quote) {
  // As the renderer reads it (getCustomerPresentationFinancials): a missing
  // or zero rate is 10 %.
  const rate = Number(quote?.quoteCatalog?.gstRate || 0.1);
  const { scaled } = toScaled(Number.isFinite(rate) ? rate * 100 : 10, 3);
  const raw = scaled.toString().padStart(4, "0");
  return `${raw.slice(0, -3)}.${raw.slice(-3)}`;
}

/** What Field shows for this artifact: the PDF's subtotal, GST and total, as decimal strings. */
export function shownTotals(quote) {
  const financials = getCustomerPresentationFinancials(quote);
  return {
    subtotal: money(financials.subtotal),
    taxTotal: money(financials.gst),
    total: money(financials.total),
  };
}

/** The number as printed: the quote number, else the job id (as the PDF does). */
export function quoteNumberOf({ quote, meta }) {
  return text(quote?.quoteNumber) || text(meta?.quoteNumber) || text(meta?.id);
}

/**
 * Map one quote version. `meta` is the job's meta (title, customer).
 * `customer` overrides the customer read from `meta` (a sent version's
 * customer as its issued document recorded it). `printed` is the totals
 * printed on the PDF the customer was sent, when one could be read: it is
 * only used to keep a half-cent GST as printed.
 *
 * Returns { header, sections, lines, shown, totals, printedLines,
 * excludedRows }: sections and lines carry local `key`s (`sectionKey`,
 * `parentKey` point at them) that the quote service turns into uids; `shown`
 * is what Field shows, `totals` is quoteTotals over the lines (with the GST
 * as printed in the half-cent case), and `printedLines` lists the lines whose
 * total is frozen as printed, with why.
 */
export function mapQuoteArtifact({ quote, meta = null, customer = null, printed = null }) {
  if (!quote || typeof quote !== "object") throw new TypeError("mapQuoteArtifact needs a quote");
  const view = getCustomerScheduleView(quote, { includeCollapsedChildren: true });
  const organizerNodes = view.organizer?.nodes || {};
  const taxRate = quoteTaxRatePercent(quote);
  // Today every quote is taxed at one rate (the catalogue's gstRate), never
  // per item; item tax codes arrive with quotes built from rows.
  const taxCode = "GST";
  const sections = [];
  const lines = [];
  const printedLines = [];
  let excludedRows = 0;
  let keySeq = 0;
  const nextKey = (prefix) => `${prefix}${(keySeq += 1)}`;
  let order = 0;
  const nextOrder = () => order++;

  const items = view.items || [];
  // A flat schedule with no organizer (pre-organizer data). An empty quote is
  // not legacy: it prints nothing either way.
  const legacy = !view.organizer && (view.items || []).length > 0;
  const roots = buildTree(legacy ? items.map((item) => ({ ...item, depth: 0 })) : items);

  function baseLine(row, { lineType, sectionKey, parentKey, excluded = false }) {
    const node = organizerNodes[row.nodeId] || null;
    const link = lineType === "note" ? null : catalogLink(node);
    return {
      key: nextKey("l"),
      sortOrder: nextOrder(),
      sectionKey,
      parentKey,
      lineType,
      itemUid: link?.itemUid || null,
      priceUid: link?.priceUid || null,
      priceKey: link?.priceKey || null,
      code: link?.code || text(row.sourceCode) || text(row.code) || null,
      name: text(row.label) || "Item",
      description: null,
      quantity: quantityText(row.quantity ?? 1),
      unitCode: text(row.unit) || "lot",
      unitCost: unitCostText(row.unitCost),
      unitSell: rowRate(row),
      lineTotal: money(row.totalPrice),
      lineTotalSource: "computed",
      lineTotalReason: null,
      isPriceOverride: false,
      overrideReason: null,
      taxCode,
      taxRate,
      isOptional: false,
      isSelected: true,
      sourceNodeId: text(row.nodeId) || text(row.code) || null,
      // Display. An excluded row renders with its amount hidden; keep the
      // row's own setting for the editor.
      isExcluded: excluded,
      showAmount: excluded ? node?.amountVisible !== false : row.amountVisible !== false,
      amountBlank: row.amountBlank === true,
      isCollapsed: row.collapsed === true,
      rowStyle: ["branded", "bold", "normal"].includes(row.rowStyle) ? row.rowStyle : null,
      notes: text(node?.notes),
      rowKind: row.kind === "group" ? "group" : isGenerated(row) ? "generated" : "row",
      displayUnitSell: null,
      lineCost: excluded ? null : money(row.totalCost),
    };
  }

  // The rate a document prints: the renderer's unit price. When the line's
  // unit sell, rounded the way the renderer rounds it, would print something
  // else (a fixed price beside the row's original rate), keep the printed one.
  function keepPrintedRate(line, row) {
    if (line.unitSell === null || line.isExcluded) return;
    const printed = finite(row.unitPrice);
    if (printedRate(line.unitSell) !== printed) line.displayUnitSell = fixed(printed, 4);
  }

  // An excluded row's amount is never printed or counted: its total is
  // quantity x its own rate, whatever the renderer zeroed.
  function excludedTotal(line) {
    if (line.unitSell === null) return;
    line.lineTotal = centsToText(lineTotalCents(line.quantity, line.unitSell));
  }

  // The row's own rate, to four decimals: a manual row's typed rate (the PDF
  // prints it rounded to cents), else the rate the renderer prints.
  function rowRate(row) {
    const node = organizerNodes[row.nodeId] || null;
    const ownRate = node?.kind === "source" && (node.origin === "manual" || node.sourceKind === "manual")
      && !(Array.isArray(node.children) && node.children.length)
      ? rate4(node.sellRate) : null;
    return ownRate ?? rate4(row.unitPrice ?? row.totalPrice) ?? "0.0000";
  }

  function rowLineType(row) {
    const node = organizerNodes[row.nodeId] || null;
    return catalogLink(node) ? "item" : "custom";
  }

  function overrideReason(row) {
    if (hasOverride(row)) return row.kind === "group" ? "fixed price on a group of rows" : "fixed price on the row";
    const node = organizerNodes[row.nodeId] || null;
    if (node?.rateMode === "manual" && catalogLink(node)
      && Number.isFinite(Number(node.catalogSellRate)) && Number(node.sellRate) !== Number(node.catalogSellRate)) {
      return "rate changed from the catalogue's";
    }
    return null;
  }

  // The line's total is the amount it printed. It is `computed` when
  // round(quantity x rate, 2) gives it, trying the row's own rate first and
  // then the rate the PDF printed; otherwise it is `printed`, with why.
  function settleTotal(line, row, { fixedReason = null } = {}) {
    if (line.unitSell === null) return;
    const gives = (rate) => centsToText(lineTotalCents(line.quantity, rate)) === line.lineTotal;
    if (!fixedReason && gives(line.unitSell)) return;
    const printedRate = rate4(money(row.unitPrice ?? row.totalPrice));
    if (!fixedReason && printedRate !== null && gives(printedRate)) {
      line.unitSell = printedRate;
      return;
    }
    const computed = centsToText(lineTotalCents(line.quantity, line.unitSell));
    const qty = line.quantity.replace(/\.?0+$/, "");
    line.lineTotalSource = "printed";
    line.lineTotalReason = fixedReason
      || `printed ${line.lineTotal}, where ${qty} ${line.unitCode} x ${line.unitSell} is ${computed}: the PDF rounds the amount from the unrounded rate, or rolls it up from the rows under it`;
    printedLines.push({ nodeId: line.sourceNodeId, name: line.name, quantity: line.quantity, unitSell: line.unitSell, printed: line.lineTotal, computed, reason: line.lineTotalReason });
  }

  // Rows under a line that carries their price: shown, never counted.
  function emitComponents(children, { sectionKey, parentKey, excluded = false }) {
    for (const child of children) {
      const childExcluded = excluded || child.row.excludedFromPrice === true;
      if (childExcluded) excludedRows += 1;
      const line = baseLine(child.row, { lineType: "component", sectionKey, parentKey, excluded: childExcluded });
      if (child.row.kind === "group") Object.assign(line, { quantity: "1.0000", unitCode: "lot", unitSell: rate4(money(child.row.totalPrice)) });
      if (childExcluded) excludedTotal(line);
      else {
        settleTotal(line, child.row);
        keepPrintedRate(line, child.row);
      }
      lines.push(line);
      emitComponents(child.children, { sectionKey, parentKey: line.key, excluded: childExcluded });
    }
  }

  function emitPriced(node, { sectionKey, parentKey, lineType, excluded = false }) {
    const { row } = node;
    const line = baseLine(row, { lineType, sectionKey, parentKey, excluded });
    if (row.kind === "group") {
      Object.assign(line, { quantity: "1.0000", unitCode: "lot", unitSell: rate4(money(row.totalPrice)), unitCost: unitCostText(row.totalCost) });
    }
    const reason = overrideReason(row);
    if (reason) Object.assign(line, { isPriceOverride: true, overrideReason: reason });
    let fixedReason = null;
    if (hasOverride(row) && row.kind !== "group") {
      // A fixed price replaces quantity x rate, but today's PDF still prints
      // the row's original rate beside it. The line keeps the quantity and
      // takes the whole-cent rate the fixed price works out to, when there is
      // one; the printed rate goes into the reason. When there is none, the
      // fixed price stays the line's printed total.
      const qty = line.quantity.replace(/\.?0+$/, "");
      const printedRate = money(row.unitPrice ?? row.totalPrice);
      const rate = unitSellForTotal(line.quantity, line.lineTotal);
      if (rate !== null) {
        if (fixed(rate, 4) !== line.unitSell) {
          line.overrideReason = `${reason}: ${line.lineTotal} for ${qty} ${line.unitCode} (printed rate ${printedRate})`;
          line.unitSell = fixed(rate, 4);
        }
      } else {
        fixedReason = `fixed price ${line.lineTotal} for ${qty} ${line.unitCode}, which no whole-cent rate gives (printed rate ${printedRate})`;
      }
    }
    if (isListedOnly(row)) Object.assign(line, { isOptional: true, isSelected: false });
    if (excluded) excludedTotal(line);
    else {
      settleTotal(line, row, { fixedReason });
      keepPrintedRate(line, row);
    }
    lines.push(line);
    emitComponents(node.children, { sectionKey, parentKey: line.key, excluded });
  }

  function emit(node, { sectionKey = null, parentKey = null, topLevel = false, excluded: ancestorExcluded = false }) {
    const { row } = node;
    const excluded = ancestorExcluded || row.excludedFromPrice === true;
    if (excluded) excludedRows += 1;
    if (legacy && row.kind === "component") {
      // Old flat schedules list a row's components after it, without depth.
      const owner = [...lines].reverse().find((line) => line.lineType !== "component" && line.lineType !== "note");
      const line = baseLine(row, { lineType: "component", sectionKey, parentKey: owner?.key || parentKey, excluded });
      if (excluded) excludedTotal(line);
      else settleTotal(line, row);
      lines.push(line);
      return;
    }
    if (row.kind === "group") {
      const transparent = !hasOverride(row) && !isListedOnly(row) && typeof row.costOverride !== "number"
        && (legacy || countedChildrenCents(node) === contributionCents(row));
      if (!transparent) {
        emitPriced(node, { sectionKey, parentKey, lineType: "custom", excluded });
        return;
      }
      const groupNode = organizerNodes[row.nodeId] || null;
      if (topLevel) {
        const key = nextKey("s");
        sections.push({
          key,
          title: text(row.label) || "Group",
          sortOrder: nextOrder(),
          showSubtotal: excluded ? groupNode?.amountVisible !== false : row.amountVisible !== false,
          sourceNodeId: text(row.nodeId),
          isExcluded: excluded,
          amountBlank: row.amountBlank === true,
          isCollapsed: row.collapsed === true,
          rowStyle: ["branded", "bold", "normal"].includes(row.rowStyle) ? row.rowStyle : null,
          notes: text(groupNode?.notes),
        });
        for (const child of node.children) emit(child, { sectionKey: key, parentKey: null, excluded });
        return;
      }
      const note = {
        ...baseLine(row, { lineType: "note", sectionKey, parentKey, excluded }),
        quantity: "1.0000",
        unitCode: "lot",
        unitCost: null,
        unitSell: null,
        lineTotal: "0.00",
        itemUid: null,
        priceUid: null,
        priceKey: null,
        lineCost: null,
      };
      lines.push(note);
      for (const child of node.children) emit(child, { sectionKey, parentKey: note.key, excluded });
      return;
    }
    if (isGenerated(row) && !legacy) {
      // A generated row that is not under its owner (the owner was removed
      // or moved): it still prints and counts on its own.
      emitPriced(node, { sectionKey, parentKey, lineType: "custom", excluded });
      return;
    }
    emitPriced(node, { sectionKey, parentKey, lineType: rowLineType(row), excluded });
  }

  for (const root of roots) emit(root, { topLevel: true });

  const computed = quoteTotals(lines);
  const shown = shownTotals(quote);
  const totals = { subtotal: computed.subtotal, taxTotal: computed.taxTotal, total: computed.total };
  let taxTotalSource = "computed";
  let taxTotalReason = null;
  const sent = printed?.subtotal != null && printed?.taxTotal != null ? printed : null;
  const taxDiff = sent ? toCents(sent.taxTotal) - toCents(computed.taxTotal) : 0n;
  if (sent && computed.taxGroups.length === 1 && (taxDiff === 1n || taxDiff === -1n)
    && toCents(computed.subtotal) === toCents(sent.subtotal) && isHalfCentTax(computed.subtotal, computed.taxGroups[0].taxRate)) {
    const sentTax = centsToText(toCents(sent.taxTotal));
    taxTotalSource = "printed";
    taxTotalReason = `GST as printed, ${sentTax}: ${computed.subtotal} at ${computed.taxGroups[0].taxRate.replace(/\.?0+$/, "")} % is exactly half a cent, which the PDF rounded to ${sentTax} rather than ${computed.taxTotal}`;
    Object.assign(totals, { taxTotal: sentTax, total: centsToText(toCents(computed.subtotal) + toCents(sent.taxTotal)) });
  }
  const parties = partiesDetails({ meta, quote });
  const generatedAt = text(quote.generatedAt);
  const header = {
    number: quoteNumberOf({ quote, meta }),
    version: Number(quote.version) || null,
    title: text(meta?.title),
    scopeText: text(quote.summary),
    termsText: null,
    customer: customer && typeof customer === "object" ? customer : parties.customer,
    currency: (text(quote?.totals?.currency) || "AUD").toUpperCase(),
    validUntilOn: generatedAt ? localDatePlusDays(generatedAt, quoteValidityDays(quote)) : null,
    catalogVersion: null,
    taxTotalSource,
    taxTotalReason,
  };
  const mapped = { header, sections, lines, shown, totals, unpriced: computed.unpriced, printedLines, excludedRows, legacy };
  // Whether the rows print exactly what the renderer prints (#10): only an
  // organizer quote can be printed from its rows.
  mapped.printDifferences = legacy ? null : comparePrintedSchedule(scheduleFromRows(mapped), getCustomerScheduleItems(quote));
  // The job's cost (shown to the operator, never printed) must come out the same too.
  const rowsCost = financialsFromRows(mapped).cost;
  const filesCost = Math.round(Number(getCustomerPresentationFinancials(quote).cost || 0) * 100) / 100;
  if (!legacy && rowsCost !== filesCost) mapped.printDifferences.push({ field: "cost", rows: rowsCost, renderer: filesCost });
  mapped.printable = !legacy && mapped.printDifferences.length === 0;
  return mapped;
}

/**
 * Compare the rows' totals with what Field shows. Returns the fields that
 * differ, each { field, rows, shown }; empty when they agree to the cent.
 */
export function compareTotals(rowsTotals, shown) {
  const differences = [];
  for (const field of ["subtotal", "taxTotal", "total"]) {
    if (toCents(rowsTotals[field]) !== toCents(shown[field])) {
      differences.push({ field, rows: rowsTotals[field], shown: shown[field] });
    }
  }
  return differences;
}

/** A stable hash of a mapped version (header, sections and lines, without keys' numbering noise). */
export function mappedDigest(mapped, extra = {}) {
  const payload = JSON.stringify({
    header: mapped.header,
    sections: mapped.sections,
    lines: mapped.lines,
    extra,
  });
  return createHash("sha256").update(payload).digest("hex");
}
