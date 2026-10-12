// A quote's printed schedule and totals from its rows (#10). Pure: it takes
// sections and lines either as the mapping returns them (local `key`s) or as
// the quote service reads them (uids), and returns what the PDF prints, in
// the shape the renderer (shared/quote-presentation-renderer.js) gives it:
//
//   { kind, label, depth, quantity, unit, unitPrice, totalPrice, amountVisible,
//     amountBlank, rowStyle, collapsed, excludedFromPrice, origin }
//
// A section and a `note` heading print as a group row whose amount is the sum
// of the counted lines under it. A line prints its quantity, unit, the rate
// a document printed (`display_unit_sell`, else its unit sell rounded the way
// the renderer rounds it) and its total. Children of a collapsed row are not
// printed. Excluded rows are listed with `excludedFromPrice`, which the PDF
// leaves out, as it always has.
import { toCents } from "./totals.js";

const COUNTED = new Set(["item", "custom"]);

function idOf(entry) {
  return entry.key ?? entry.uid;
}

function sectionOf(line) {
  return line.sectionKey ?? line.sectionUid ?? null;
}

function parentOf(line) {
  return line.parentKey ?? line.parentLineUid ?? null;
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== "";
}

/** The rate as the renderer prints it: Math.round(rate x 100) / 100, in floating point. */
export function printedRate(unitSell) {
  return Math.round(Number(unitSell || 0) * 100) / 100;
}

function isCounted(line) {
  return COUNTED.has(line.lineType) && line.isSelected !== false && !line.isExcluded && hasValue(line.unitSell);
}

/**
 * The printed schedule. `sections` and `lines` share one `sortOrder`
 * sequence, which is the printed order of sections and top-level lines.
 */
export function scheduleFromRows({ sections = [], lines = [] }) {
  const children = new Map();
  const sectionLines = new Map(sections.map((section) => [idOf(section), []]));
  const roots = [];
  for (const line of [...lines].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const parent = parentOf(line);
    if (parent) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(line);
    } else if (sectionOf(line) && sectionLines.has(sectionOf(line))) {
      sectionLines.get(sectionOf(line)).push(line);
    } else {
      roots.push({ type: "line", entry: line });
    }
  }
  for (const section of sections) roots.push({ type: "section", entry: section });
  roots.sort((a, b) => a.entry.sortOrder - b.entry.sortOrder);

  // Counted lines under a line (its descendants), in cents, and whether it has any priced row under it.
  const below = new Map();
  function measure(list) {
    let cents = 0n;
    let rows = 0;
    for (const line of list) {
      const inner = measureLine(line);
      cents += inner.cents;
      rows += inner.rows;
    }
    return { cents, rows };
  }
  function measureLine(line) {
    const id = idOf(line);
    if (below.has(id)) return below.get(id);
    const inner = measure(children.get(id) || []);
    const own = isCounted(line) ? toCents(line.lineTotal) : 0n;
    const result = { cents: own + inner.cents, rows: inner.rows + (line.lineType === "note" ? 0 : 1), inner };
    below.set(id, result);
    return result;
  }

  const items = [];
  function groupItem({ label, depth, amount, amountVisible, amountBlank, rowStyle, collapsed, excluded }) {
    const total = excluded ? 0 : Number(amount) / 100;
    return {
      kind: "group",
      label,
      depth,
      quantity: 1,
      unit: "lot",
      unitPrice: total,
      totalPrice: total,
      amountVisible: excluded ? false : amountVisible,
      amountBlank,
      rowStyle,
      collapsed,
      excludedFromPrice: excluded,
      origin: null,
    };
  }
  function walkLine(line, depth, ancestorExcluded) {
    const excluded = ancestorExcluded || line.isExcluded === true;
    const kids = children.get(idOf(line)) || [];
    if (line.lineType === "note") {
      const inner = measure(kids);
      if (!inner.rows && !inner.cents) return;
      items.push(groupItem({
        label: line.name,
        depth,
        amount: inner.cents,
        amountVisible: line.showAmount !== false,
        amountBlank: line.amountBlank === true,
        rowStyle: line.rowStyle || null,
        collapsed: line.isCollapsed === true,
        excluded,
      }));
    } else {
      const groupKind = line.rowKind === "group";
      const total = excluded ? 0 : Number(line.lineTotal);
      const rate = hasValue(line.displayUnitSell) ? Number(line.displayUnitSell) : printedRate(line.unitSell);
      items.push({
        kind: groupKind ? "group" : "source",
        label: line.name,
        depth,
        quantity: groupKind ? 1 : Number(line.quantity),
        unit: groupKind ? "lot" : line.unitCode,
        unitPrice: excluded ? 0 : (groupKind ? total : rate),
        totalPrice: total,
        amountVisible: excluded ? false : line.showAmount !== false,
        amountBlank: line.amountBlank === true,
        rowStyle: line.rowStyle || null,
        collapsed: line.isCollapsed === true,
        excludedFromPrice: excluded,
        origin: line.rowKind === "generated" ? "generated" : null,
      });
    }
    if (line.isCollapsed) return;
    for (const child of kids) walkLine(child, depth + 1, excluded);
  }
  for (const root of roots) {
    if (root.type === "line") {
      walkLine(root.entry, 0, false);
      continue;
    }
    const section = root.entry;
    const list = sectionLines.get(idOf(section)) || [];
    const inner = measure(list);
    if (!inner.rows && !inner.cents) continue;
    const excluded = section.isExcluded === true;
    items.push(groupItem({
      label: section.title,
      depth: 0,
      amount: inner.cents,
      amountVisible: section.showSubtotal !== false,
      amountBlank: section.amountBlank === true,
      rowStyle: section.rowStyle || null,
      collapsed: section.isCollapsed === true,
      excluded,
    }));
    if (section.isCollapsed) continue;
    for (const line of list) walkLine(line, 1, excluded);
  }
  return items;
}

/**
 * The totals the documents print and the job shows, as numbers: subtotal,
 * GST and total from the quote row (or a mapping's totals), and the cost of
 * the counted lines (internal).
 */
export function financialsFromRows({ totals, lines = [] }) {
  let cost = 0n;
  for (const line of lines) {
    if (isCounted(line) && hasValue(line.lineCost)) cost += toCents(line.lineCost);
  }
  const subtotal = Number(totals.subtotal);
  return {
    charge: subtotal,
    cost: Number(cost) / 100,
    subtotal,
    gst: Number(totals.taxTotal),
    total: Number(totals.total),
  };
}

const COMPARED = ["label", "depth", "quantity", "unit", "unitPrice", "totalPrice"];

function printedShape(item) {
  return {
    group: item.kind === "group",
    generated: item.origin === "generated" || item.sourceKind === "generated_component",
    rowStyle: item.rowStyle || null,
    amountVisible: item.amountVisible !== false,
    amountBlank: item.amountBlank === true,
    ...Object.fromEntries(COMPARED.map((field) => [field, item[field] ?? null])),
  };
}

/**
 * The printed rows (excluded ones left out, as the PDF does) that differ
 * between the rows' schedule and the renderer's. Empty when the PDF would be
 * the same.
 */
export function comparePrintedSchedule(fromRows, fromRenderer) {
  const a = fromRows.filter((item) => !item.excludedFromPrice).map(printedShape);
  const b = (fromRenderer || []).filter((item) => !item.excludedFromPrice).map(printedShape);
  const differences = [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const rows = a[index] || null;
    const renderer = b[index] || null;
    if (JSON.stringify(rows) !== JSON.stringify(renderer)) differences.push({ index, rows, renderer });
  }
  return differences;
}
