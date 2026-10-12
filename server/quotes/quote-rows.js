// The quote service (#6): writes one quote version as `quotes`,
// `quote_sections` and `quote_lines` rows, in ONE organisation transaction.
//
//   writeVersion(input)        create or replace a draft version's rows, then
//                              set its status; a sent version's rows are
//                              never rewritten (the database refuses it too)
//   replaceDraftVersion(input) writeVersion for a draft
//   markSent(input)            a version was sent: status, send time and the
//                              issued document it was sent as
//   deleteDraftVersion(...)    a draft version that no longer exists
//   getQuoteVersion(...)       one version with its sections and lines
//   listJobQuotes(jobId)       a job's versions (headers only)
//
// Totals are always computed here, by quoteTotals over the lines being
// written: a caller cannot store totals that its lines do not add up to. A
// line's total is `computed` (round(qty x rate, 2)) unless the caller marks it
// `printed`, with a reason. A quote's GST may be kept as printed only in the
// half-cent case (totals.js isHalfCentTax), and only a cent apart.
//
// A version is keyed by (job, version). `sourceDigest` is a hash of what its
// rows were mapped from: the same digest means the same rows, so an unchanged
// version is not rewritten.
import { and, asc, eq } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { centsToText, isHalfCentTax, quoteTotals, toCents } from "./totals.js";
import { newQuoteLineUid, newQuoteSectionUid, newQuoteUid } from "./uid.js";

const { quotes, quoteSections, quoteLines, QUOTE_STATUSES } = schema;

const FROZEN_STATUSES = new Set(["sent", "accepted", "declined"]);

export function isFrozenQuote(row) {
  return Boolean(row) && (FROZEN_STATUSES.has(row.status) || row.sentAt != null);
}

function invalid(message) {
  const error = new Error(message);
  error.code = "QUOTE_ROWS_INVALID";
  error.statusCode = 400;
  return error;
}

function toDateOrNull(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(`not a timestamp: ${JSON.stringify(value)}`);
  return date;
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function sameTime(a, b) {
  return (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());
}

export function quoteFromRow(row) {
  return {
    uid: row.uid,
    jobId: row.jobId,
    number: row.number,
    version: row.version,
    status: row.status,
    title: row.title,
    scopeText: row.scopeText,
    termsText: row.termsText,
    customer: row.customer || {},
    currency: row.currency,
    validUntilOn: row.validUntilOn,
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    total: row.total,
    taxTotalSource: row.taxTotalSource,
    taxTotalReason: row.taxTotalReason,
    catalogVersion: row.catalogVersion,
    sentAt: iso(row.sentAt),
    acceptedAt: iso(row.acceptedAt),
    issuedDocumentUid: row.issuedDocumentUid,
    sourceDigest: row.sourceDigest,
    createdAt: iso(row.createdAt),
    createdBy: row.createdBy,
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedBy,
    versionLock: row.versionLock,
  };
}

function sectionFromRow(row) {
  return {
    uid: row.uid,
    title: row.title,
    sortOrder: row.sortOrder,
    showSubtotal: row.showSubtotal,
    sourceNodeId: row.sourceNodeId,
    isExcluded: row.isExcluded,
    amountBlank: row.amountBlank,
    isCollapsed: row.isCollapsed,
    rowStyle: row.rowStyle,
    notes: row.notes,
  };
}

function lineFromRow(row) {
  return {
    uid: row.uid,
    sectionUid: row.sectionUid,
    parentLineUid: row.parentLineUid,
    sortOrder: row.sortOrder,
    lineType: row.lineType,
    itemUid: row.itemUid,
    priceUid: row.priceUid,
    priceKey: row.priceKey,
    code: row.code,
    name: row.name,
    description: row.description,
    quantity: row.quantity,
    unitCode: row.unitCode,
    unitCost: row.unitCost,
    unitSell: row.unitSell,
    isPriceOverride: row.isPriceOverride,
    overrideReason: row.overrideReason,
    taxCode: row.taxCode,
    taxRate: row.taxRate,
    lineTotal: row.lineTotal,
    lineTotalSource: row.lineTotalSource,
    lineTotalReason: row.lineTotalReason,
    isOptional: row.isOptional,
    isSelected: row.isSelected,
    sourceNodeId: row.sourceNodeId,
    isExcluded: row.isExcluded,
    showAmount: row.showAmount,
    amountBlank: row.amountBlank,
    isCollapsed: row.isCollapsed,
    rowStyle: row.rowStyle,
    notes: row.notes,
    rowKind: row.rowKind,
    displayUnitSell: row.displayUnitSell,
    lineCost: row.lineCost,
  };
}

const CONTENT_FIELDS = [
  "lineType", "itemUid", "priceUid", "priceKey", "code", "name", "description", "quantity", "unitCode",
  "unitCost", "unitSell", "isPriceOverride", "overrideReason", "taxCode", "taxRate", "lineTotal", "lineTotalSource",
  "lineTotalReason", "isOptional", "isSelected", "sourceNodeId",
];
// What documents print besides money (#10, migration 0011).
const DISPLAY_LINE_FIELDS = [
  "isExcluded", "showAmount", "amountBlank", "isCollapsed", "rowStyle", "notes", "rowKind", "displayUnitSell", "lineCost",
];
const DISPLAY_SECTION_FIELDS = ["isExcluded", "amountBlank", "isCollapsed", "rowStyle", "notes"];
const BOOLEAN_DEFAULTS = { isExcluded: false, showAmount: true, amountBlank: false, isCollapsed: false, rowKind: "row" };

function displayValue(entry, field) {
  return entry[field] ?? BOOLEAN_DEFAULTS[field] ?? null;
}

/**
 * What a version's sections and lines say, without their ids: the same for
 * a mapping (local keys) and for stored rows (uids), so a sent version can be
 * compared with what its files map to now. With `display: false`, only the
 * money and identity of the lines (what part one stored), so a version sent
 * before the display columns existed is not a conflict for lacking them.
 */
export function contentFingerprint({ sections, lines }, { display = true } = {}) {
  const ordered = (list) => [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const sectionList = ordered(sections);
  const lineList = ordered(lines);
  const sectionIndex = new Map(sectionList.map((section, index) => [section.key ?? section.uid, index]));
  const lineIndex = new Map(lineList.map((line, index) => [line.key ?? line.uid, index]));
  return JSON.stringify({
    sections: sectionList.map((section) => [
      section.title, section.showSubtotal !== false, section.sourceNodeId ?? null,
      ...(display ? DISPLAY_SECTION_FIELDS.map((field) => displayValue(section, field)) : []),
    ]),
    lines: lineList.map((line) => [
      sectionIndex.get(line.sectionKey ?? line.sectionUid) ?? null,
      lineIndex.get(line.parentKey ?? line.parentLineUid) ?? null,
      ...CONTENT_FIELDS.map((field) => line[field] ?? null),
      ...(display ? DISPLAY_LINE_FIELDS.map((field) => displayValue(line, field)) : []),
    ]),
  });
}

async function readContent(tx, quoteUid) {
  const sections = await tx.select().from(quoteSections).where(eq(quoteSections.quoteUid, quoteUid)).orderBy(asc(quoteSections.sortOrder));
  const lines = await tx.select().from(quoteLines).where(eq(quoteLines.quoteUid, quoteUid)).orderBy(asc(quoteLines.sortOrder));
  return { sections: sections.map(sectionFromRow), lines: lines.map(lineFromRow) };
}

/**
 * quoteTotals over a mapped version's lines, refusing a `computed` line whose
 * stored total disagrees, and applying the header's GST as printed only where
 * it is allowed: one tax rate, the tax exactly on half a cent, a cent apart.
 */
export function linesTotals(mapped) {
  const totals = quoteTotals(mapped.lines);
  if (totals.inconsistent.length) {
    const line = mapped.lines[totals.inconsistent[0]];
    throw invalid(`line ${line.name || totals.inconsistent[0]}: total ${line.lineTotal} is not ${line.quantity} x ${line.unitSell}; mark it printed with the reason`);
  }
  const result = { ...totals, taxTotalSource: "computed", taxTotalReason: null };
  const header = mapped.header || {};
  if (header.taxTotalSource === "printed") {
    const printed = toCents(header.taxTotal ?? mapped.totals?.taxTotal);
    const difference = printed - toCents(totals.taxTotal);
    if (!header.taxTotalReason || totals.taxGroups.length !== 1 || (difference !== 1n && difference !== -1n)
      || !isHalfCentTax(totals.subtotal, totals.taxGroups[0].taxRate)) {
      throw invalid(`GST kept as printed (${centsToText(printed)}) must be the half-cent case, a cent from ${totals.taxTotal}, with its reason`);
    }
    Object.assign(result, {
      taxTotal: centsToText(printed),
      total: centsToText(toCents(totals.subtotal) + printed),
      taxTotalSource: "printed",
      taxTotalReason: header.taxTotalReason,
    });
  }
  return result;
}

function normalizeStatus(status) {
  if (!QUOTE_STATUSES.includes(status)) throw invalid(`unknown quote status: ${JSON.stringify(status)}`);
  return status;
}

/**
 * The service for one organisation. `db` is an orgScope, or a database with
 * `orgUid`.
 */
export function createQuoteRowService({ db, orgUid = undefined, now = () => new Date() }) {
  if (!db) throw new Error("createQuoteRowService needs a database");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);

  async function findVersion(tx, jobId, version) {
    const [row] = await tx.select().from(quotes)
      .where(and(eq(quotes.jobId, String(jobId)), eq(quotes.version, Number(version))));
    return row || null;
  }

  async function insertContent(tx, quoteUid, mapped, actor, at) {
    const sectionUids = new Map();
    const sectionRows = mapped.sections.map((section, index) => {
      const uid = newQuoteSectionUid(at.getTime());
      sectionUids.set(section.key, uid);
      return {
        uid,
        quoteUid,
        title: section.title,
        sortOrder: section.sortOrder ?? index,
        showSubtotal: section.showSubtotal !== false,
        sourceNodeId: section.sourceNodeId || null,
        isExcluded: section.isExcluded === true,
        amountBlank: section.amountBlank === true,
        isCollapsed: section.isCollapsed === true,
        rowStyle: section.rowStyle || null,
        notes: section.notes || null,
        createdAt: at,
        createdBy: actor,
      };
    });
    if (sectionRows.length) await tx.insert(quoteSections).values(sectionRows);
    const totals = linesTotals(mapped);
    const lineUids = new Map();
    const lineRows = mapped.lines.map((line, index) => {
      const uid = newQuoteLineUid(at.getTime());
      lineUids.set(line.key, uid);
      if (line.parentKey && !lineUids.has(line.parentKey)) throw invalid(`line ${line.key} comes before its parent ${line.parentKey}`);
      if (line.sectionKey && !sectionUids.has(line.sectionKey)) throw invalid(`line ${line.key} names an unknown section ${line.sectionKey}`);
      return {
        uid,
        quoteUid,
        sectionUid: line.sectionKey ? sectionUids.get(line.sectionKey) : null,
        parentLineUid: line.parentKey ? lineUids.get(line.parentKey) : null,
        sortOrder: line.sortOrder ?? index,
        lineType: line.lineType,
        itemUid: line.itemUid || null,
        priceUid: line.priceUid || null,
        priceKey: line.priceKey || null,
        code: line.code || null,
        name: line.name,
        description: line.description || null,
        quantity: String(line.quantity ?? "1"),
        unitCode: line.unitCode || "lot",
        unitCost: line.unitCost ?? null,
        unitSell: line.unitSell ?? null,
        isPriceOverride: Boolean(line.isPriceOverride),
        overrideReason: line.overrideReason || null,
        taxCode: line.taxCode || "GST",
        taxRate: String(line.taxRate ?? "10"),
        lineTotal: totals.lines[index].lineTotal ?? "0.00",
        lineTotalSource: line.lineTotalSource === "printed" ? "printed" : "computed",
        lineTotalReason: line.lineTotalSource === "printed" ? (line.lineTotalReason || null) : null,
        isOptional: Boolean(line.isOptional),
        isSelected: line.isSelected !== false,
        sourceNodeId: line.sourceNodeId || null,
        isExcluded: line.isExcluded === true,
        showAmount: line.showAmount !== false,
        amountBlank: line.amountBlank === true,
        isCollapsed: line.isCollapsed === true,
        rowStyle: line.rowStyle || null,
        notes: line.notes || null,
        rowKind: line.rowKind || "row",
        displayUnitSell: line.displayUnitSell ?? null,
        lineCost: line.lineCost ?? null,
        createdAt: at,
        createdBy: actor,
      };
    });
    if (lineRows.length) await tx.insert(quoteLines).values(lineRows);
    return totals;
  }

  function headerValues(mapped, totals) {
    const header = mapped.header || {};
    return {
      taxTotalSource: totals.taxTotalSource,
      taxTotalReason: totals.taxTotalReason,
      number: header.number,
      title: header.title ?? null,
      scopeText: header.scopeText ?? null,
      termsText: header.termsText ?? null,
      customer: header.customer && typeof header.customer === "object" ? header.customer : {},
      currency: header.currency || "AUD",
      validUntilOn: header.validUntilOn ?? null,
      catalogVersion: header.catalogVersion ?? null,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
    };
  }

  // Status, send time, acceptance and issued document, as far as the row may
  // still change them. Returns the columns that change (empty: nothing to do).
  function statusChanges(existing, { status, sentAt, acceptedAt, issuedDocumentUid }) {
    const changes = {};
    const frozen = isFrozenQuote(existing);
    if (status && status !== existing.status && !(frozen && status === "draft")) changes.status = status;
    if (sentAt && !existing.sentAt) changes.sentAt = sentAt;
    if (!sameTime(acceptedAt, existing.acceptedAt) && (acceptedAt || !frozen)) changes.acceptedAt = acceptedAt;
    if (issuedDocumentUid && !existing.issuedDocumentUid) changes.issuedDocumentUid = issuedDocumentUid;
    return changes;
  }

  async function applyStatus(tx, existing, wanted, actor, at) {
    const changes = statusChanges(existing, wanted);
    if (!Object.keys(changes).length) return existing;
    const [row] = await tx.update(quotes).set({
      ...changes,
      updatedAt: at,
      updatedBy: actor,
      versionLock: existing.versionLock + 1,
    }).where(eq(quotes.uid, existing.uid)).returning();
    return row;
  }

  /**
   * Write one version. `mapped` is from-artifact.js's mapping
   * ({ header, sections, lines }); `status`, `sentAt`, `acceptedAt` and
   * `issuedDocumentUid` describe where the version stands.
   *
   * Returns { action, quote } with action `created`, `replaced`,
   * `status-updated`, `unchanged`, or `frozen-kept` (a sent version whose
   * source now maps to different rows: nothing is rewritten; `differs`
   * says so).
   */
  async function writeVersion({
    jobId,
    version,
    mapped,
    status = "draft",
    sentAt = null,
    acceptedAt = null,
    issuedDocumentUid = null,
    sourceDigest = null,
    actor = null,
  }) {
    const cleanJobId = String(jobId ?? "").trim();
    if (!cleanJobId) throw invalid("a quote version needs its job id");
    const versionNumber = Number(version);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) throw invalid("a quote version needs a positive version number");
    if (!mapped?.header?.number) throw invalid("a quote version needs its number");
    const wanted = {
      status: normalizeStatus(status),
      sentAt: toDateOrNull(sentAt),
      acceptedAt: toDateOrNull(acceptedAt),
      issuedDocumentUid: issuedDocumentUid || null,
    };
    return scope.transaction(async (tx) => {
      const at = now();
      const existing = await findVersion(tx, cleanJobId, versionNumber);
      if (!existing) {
        const totals = linesTotals(mapped);
        const [inserted] = await tx.insert(quotes).values({
          uid: newQuoteUid(at.getTime()),
          jobId: cleanJobId,
          version: versionNumber,
          status: "draft",
          ...headerValues(mapped, totals),
          sourceDigest,
          createdAt: at,
          createdBy: actor,
          updatedAt: at,
          updatedBy: actor,
        }).returning();
        await insertContent(tx, inserted.uid, mapped, actor, at);
        const row = await applyStatus(tx, inserted, wanted, actor, at);
        return { action: "created", quote: quoteFromRow(row) };
      }
      const sameSource = sourceDigest != null && existing.sourceDigest === sourceDigest;
      if (isFrozenQuote(existing)) {
        let row = await applyStatus(tx, existing, wanted, actor, at);
        const statusChanged = row !== existing;
        if (!sameSource) {
          // The files changed around a sent version (a send writes its send
          // time into quote.json): fine as long as they still map to the rows
          // that were frozen. Its rows are never rewritten either way.
          const stored = await readContent(tx, existing.uid);
          if (contentFingerprint(stored, { display: false }) !== contentFingerprint(mapped, { display: false })) {
            return { action: "frozen-kept", differs: true, quote: quoteFromRow(row) };
          }
          if (contentFingerprint(stored) !== contentFingerprint(mapped)) {
            // Same money, but stored before the display columns existed (or
            // with other display): the rows stay as sent, and the digest is
            // left alone so nothing prints from them (read-model.js).
            return { action: statusChanged ? "status-updated" : "unchanged", displayStale: true, quote: quoteFromRow(row) };
          }
          if (sourceDigest != null) {
            [row] = await tx.update(quotes).set({ sourceDigest, updatedAt: at, updatedBy: actor, versionLock: row.versionLock + 1 })
              .where(eq(quotes.uid, existing.uid)).returning();
          }
        }
        return { action: statusChanged ? "status-updated" : "unchanged", quote: quoteFromRow(row) };
      }
      if (sameSource) {
        const row = await applyStatus(tx, existing, wanted, actor, at);
        return { action: row === existing ? "unchanged" : "status-updated", quote: quoteFromRow(row) };
      }
      await tx.delete(quoteLines).where(eq(quoteLines.quoteUid, existing.uid));
      await tx.delete(quoteSections).where(eq(quoteSections.quoteUid, existing.uid));
      const totals = await insertContent(tx, existing.uid, mapped, actor, at);
      const [updated] = await tx.update(quotes).set({
        ...headerValues(mapped, totals),
        sourceDigest,
        updatedAt: at,
        updatedBy: actor,
        versionLock: existing.versionLock + 1,
      }).where(eq(quotes.uid, existing.uid)).returning();
      const row = await applyStatus(tx, updated, wanted, actor, at);
      return { action: "replaced", quote: quoteFromRow(row) };
    });
  }

  return {
    orgUid: scope.orgUid,
    writeVersion,

    /** Create or replace a draft version's rows from today's quote artifact. */
    replaceDraftVersion(input) {
      return writeVersion({ ...input, status: "draft", sentAt: null, acceptedAt: null, issuedDocumentUid: null });
    },

    /**
     * A version was sent: status `sent` (or the status given), its send time
     * and the issued document it was sent as. Its rows are frozen from here.
     */
    async markSent({ jobId, version, sentAt, issuedDocumentUid = null, status = "sent", actor = null }) {
      return scope.transaction(async (tx) => {
        const existing = await findVersion(tx, jobId, version);
        if (!existing) throw invalid(`no quote rows for job ${jobId} v${version}`);
        const row = await applyStatus(tx, existing, {
          status: normalizeStatus(status),
          sentAt: toDateOrNull(sentAt),
          acceptedAt: existing.acceptedAt,
          issuedDocumentUid,
        }, actor, now());
        return quoteFromRow(row);
      });
    },

    /** Remove a draft version's rows (the version no longer exists). A sent version is kept. */
    async deleteDraftVersion(jobId, version) {
      return scope.transaction(async (tx) => {
        const existing = await findVersion(tx, jobId, version);
        if (!existing) return { deleted: false };
        if (isFrozenQuote(existing)) return { deleted: false, frozen: true };
        await tx.delete(quotes).where(eq(quotes.uid, existing.uid));
        return { deleted: true };
      });
    },

    async getQuoteVersion(jobId, version) {
      return scope.transaction(async (tx) => {
        const row = await findVersion(tx, jobId, version);
        if (!row) return null;
        const sections = await tx.select().from(quoteSections).where(eq(quoteSections.quoteUid, row.uid))
          .orderBy(asc(quoteSections.sortOrder));
        const lines = await tx.select().from(quoteLines).where(eq(quoteLines.quoteUid, row.uid))
          .orderBy(asc(quoteLines.sortOrder));
        return { quote: quoteFromRow(row), sections: sections.map(sectionFromRow), lines: lines.map(lineFromRow) };
      });
    },

    /** A job's quote versions, oldest first (headers only). */
    async listJobQuotes(jobId) {
      const rows = await scope.transaction((tx) => tx.select().from(quotes)
        .where(eq(quotes.jobId, String(jobId))).orderBy(asc(quotes.version)));
      return rows.map(quoteFromRow);
    },
  };
}
