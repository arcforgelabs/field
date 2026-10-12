// The totals printed on an issued quote, read back from what the customer was
// sent (#241): the PDF itself, or the quote markdown stored with the
// delivery. Used by the backfill to check that quote rows equal the sent
// document to the cent.
//
// Field's PDFs are written by PDFKit with the standard Helvetica fonts: each
// page's content stream is Flate-compressed and every piece of text is a TJ
// array of hex strings in WinAnsi. The totals box prints "Subtotal", the
// amount, "GST (10%)", the amount, "Total (inc. GST)", the amount, in that
// order. Reading those back needs no PDF library. A PDF from another
// generator, or one whose text cannot be found, gives null: the caller
// reports it as unreadable rather than guessing.
import { inflateSync } from "node:zlib";
import { roundMoney } from "./totals.js";

/** The text runs of a PDF, in content-stream order. */
export function pdfTextRuns(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const source = buffer.toString("latin1");
  const runs = [];
  const streamStart = /stream\r?\n/g;
  let match;
  while ((match = streamStart.exec(source))) {
    const start = match.index + match[0].length;
    const end = source.indexOf("endstream", start);
    if (end < 0) break;
    let content;
    try {
      content = inflateSync(buffer.subarray(start, end)).toString("latin1");
    } catch {
      continue;
    }
    for (const array of content.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ/g)) {
      runs.push([...array[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((hex) => Buffer.from(hex[1], "hex").toString("latin1")).join(""));
    }
    streamStart.lastIndex = end;
  }
  return runs.map((run) => run.trim()).filter(Boolean);
}

/** "$1,234.50" or "-$12.00" -> "1234.50"; anything else -> null. */
export function parseMoneyText(value) {
  const match = /^(-)?\s*(?:A?\$)\s*(-)?([0-9][0-9,]*(?:\.[0-9]+)?)$/.exec(String(value || "").trim());
  if (!match) return null;
  const negative = Boolean(match[1] || match[2]);
  return roundMoney(`${negative ? "-" : ""}${match[3].replace(/,/g, "")}`);
}

/**
 * The subtotal, GST and total a quote PDF prints, as decimal strings, or
 * null when the totals box is not found. The last totals box in the
 * document wins (there is one per quote).
 */
export function extractQuotePdfTotals(bytes) {
  let runs;
  try {
    runs = pdfTextRuns(bytes);
  } catch {
    return null;
  }
  let found = null;
  for (let index = 0; index + 5 < runs.length; index += 1) {
    if (runs[index] !== "Subtotal") continue;
    if (!/^GST\b/.test(runs[index + 2]) || !/^Total\b/.test(runs[index + 4])) continue;
    const subtotal = parseMoneyText(runs[index + 1]);
    const taxTotal = parseMoneyText(runs[index + 3]);
    const total = parseMoneyText(runs[index + 5]);
    if (subtotal !== null && taxTotal !== null && total !== null) found = { subtotal, taxTotal, total };
  }
  return found;
}

/** The totals in a quote's markdown ("## Totals", "- Subtotal: $…"), or null. */
export function extractQuoteMarkdownTotals(markdown) {
  const textValue = String(markdown || "");
  const start = textValue.search(/^## Totals[ \t]*$/m);
  if (start < 0) return null;
  const rest = textValue.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n");
  const read = (label) => {
    const line = new RegExp(`^- ${label}:\\s*(.+)$`, "m").exec(section);
    return line ? parseMoneyText(line[1]) : null;
  };
  const subtotal = read("Subtotal");
  const taxTotal = read("GST");
  const total = read("Total");
  return subtotal !== null && taxTotal !== null && total !== null ? { subtotal, taxTotal, total } : null;
}
