const REVIEW_REQUEST_PATTERN = /\b(review|manual review|verify|double-check|check|confirm|unclear|needs review|required)\b|\?/i;
const DUPLICATION_PATTERN = /\b(duplicate|duplication|duplicated|double count|double-count|repeated|repeat(ed)?|same item|same line)\b/i;
const REBUILD_PATTERN = /\b(rebuild|redo|recalculate|reconsider|rerun|re-run|rework|regenerate|reprice|reframe)\b/i;
const QUESTION_PATTERN = /\?|(?:^|\s)(why|how|should|can we|does this|is this|what if)\b/i;
const EXTRACTION_NOTE_LIMITS = Object.freeze({
  operatorPerItem: 5,
  operatorGlobal: 5,
  system: 2,
});

export const SYSTEM_REBUILD_NOTE_AUTHOR = "Field System";
export const SYSTEM_REBUILD_NOTE_TITLE = "System rebuild summary";

export function inferClarificationNoteSource(note) {
  const author = String(note?.author || note?.actor?.label || "").trim().toLowerCase();
  if (!author) return "operator";
  if (author === SYSTEM_REBUILD_NOTE_AUTHOR.toLowerCase() || author === "system") return "system";
  return "operator";
}

export function normalizeClarificationNote(note) {
  const title = normalizeText(note?.title);
  const text = normalizeText(note?.text);
  const author = normalizeText(note?.author || note?.actor?.label);
  const surface = normalizeText(note?.surface);
  const layer = normalizeText(note?.layer);
  const itemCode = normalizeText(note?.itemCode || note?.item_code);
  const itemLabel = normalizeText(note?.itemLabel || note?.item_label);
  const createdAt = normalizeText(note?.createdAt || note?.created_at);
  const version = normalizeText(note?.version);
  const source = inferClarificationNoteSource({ ...note, author });
  const combinedText = `${title || ""}\n${text || ""}`.trim();
  const signals = {
    reviewRequested: source === "operator" && REVIEW_REQUEST_PATTERN.test(combinedText),
    duplicationConcern: source === "operator" && DUPLICATION_PATTERN.test(combinedText),
    rebuildDirective: source === "operator" && REBUILD_PATTERN.test(combinedText),
    questionRaised: source === "operator" && QUESTION_PATTERN.test(combinedText),
  };

  return {
    title,
    text,
    author,
    surface,
    layer,
    itemCode,
    itemLabel,
    createdAt,
    version,
    source,
    actionable: source === "operator" && (
      signals.reviewRequested
      || signals.duplicationConcern
      || signals.rebuildDirective
      || signals.questionRaised
      || surface === "triage"
      || surface === "breakdown"
      || surface === "review"
      || layer === "L5"
      || layer === "L6"
    ),
    signals,
  };
}

export function normalizeClarificationNotes(notes) {
  return asArray(notes)
    .map((note) => normalizeClarificationNote(note))
    .filter((note) => note.text);
}

export function buildClarificationNoteSummary(notes, { includedNotes = null } = {}) {
  const normalized = normalizeClarificationNotes(notes);
  const operatorNotes = normalized.filter((note) => note.source === "operator");
  const systemNotes = normalized.filter((note) => note.source === "system");
  const actionableNotes = operatorNotes.filter((note) => note.actionable);
  const reviewRequestedNotes = operatorNotes.filter((note) => note.signals.reviewRequested);
  const duplicationConcernNotes = operatorNotes.filter((note) => note.signals.duplicationConcern);
  const rebuildDirectiveNotes = operatorNotes.filter((note) => note.signals.rebuildDirective);
  const questionRaisedNotes = operatorNotes.filter((note) => note.signals.questionRaised);
  const referencedItemCodes = [...new Set(
    operatorNotes
      .map((note) => note.itemCode)
      .filter(Boolean)
  )];
  const included = includedNotes ? normalizeClarificationNotes(includedNotes) : normalized;
  const includedOperatorNotes = included.filter((note) => note.source === "operator");
  const includedSystemNotes = included.filter((note) => note.source === "system");

  return {
    total: normalized.length,
    includedCount: included.length,
    omittedCount: Math.max(0, normalized.length - included.length),
    operatorCount: operatorNotes.length,
    includedOperatorCount: includedOperatorNotes.length,
    omittedOperatorCount: Math.max(0, operatorNotes.length - includedOperatorNotes.length),
    systemCount: systemNotes.length,
    includedSystemCount: includedSystemNotes.length,
    omittedSystemCount: Math.max(0, systemNotes.length - includedSystemNotes.length),
    actionableCount: actionableNotes.length,
    reviewRequestedCount: reviewRequestedNotes.length,
    duplicationConcernCount: duplicationConcernNotes.length,
    rebuildDirectiveCount: rebuildDirectiveNotes.length,
    questionRaisedCount: questionRaisedNotes.length,
    referencedItemCodes,
    latestCreatedAt: normalized
      .map((note) => note.createdAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
  };
}

export function selectClarificationNotesForExtraction(notes, limits = {}) {
  const normalized = normalizeClarificationNotes(notes).map((note, index) => ({
    ...note,
    _index: index,
  }));
  const resolvedLimits = {
    ...EXTRACTION_NOTE_LIMITS,
    ...(limits && typeof limits === "object" ? limits : {}),
  };
  const deduped = dedupeClarificationNotes(normalized);
  const selected = [];
  const operatorByItemCounts = new Map();
  let operatorGlobalCount = 0;
  let systemCount = 0;

  for (const note of sortNotesNewestFirst(deduped)) {
    if (note.source === "system") {
      if (systemCount >= resolvedLimits.system) continue;
      systemCount += 1;
      selected.push(note);
      continue;
    }

    const bucketKey = note.itemCode || "__global__";
    const currentCount = operatorByItemCounts.get(bucketKey) || 0;
    const bucketLimit = bucketKey === "__global__"
      ? resolvedLimits.operatorGlobal
      : resolvedLimits.operatorPerItem;
    if (currentCount >= bucketLimit) continue;
    operatorByItemCounts.set(bucketKey, currentCount + 1);
    selected.push(note);
    operatorGlobalCount += 1;
  }

  const orderedSelected = selected
    .sort((a, b) => compareNotesChronologically(a, b))
    .map(stripClarificationNoteMeta);

  return {
    notes: orderedSelected,
    summary: buildClarificationNoteSummary(normalized, {
      includedNotes: orderedSelected,
    }),
  };
}

export function buildSystemRebuildNote({
  quote = null,
  noteSummary = null,
  buildReason = "quote_build",
}) {
  const effectiveSummary = noteSummary && typeof noteSummary === "object"
    ? noteSummary
    : buildClarificationNoteSummary([]);
  const reviewReasons = asArray(quote?.review?.reasons).filter(Boolean);
  const pricingIssues = asArray(quote?.internalPricing?.pricingIssues)
    .map((issue) => issue?.reason || issue?.message || issue?.code || null)
    .filter(Boolean);
  const shouldWrite =
    buildReason === "reingest"
    || effectiveSummary.total > 0
    || reviewReasons.length > 0
    || pricingIssues.length > 0;
  if (!shouldWrite) return null;

  const versionNumber = Number(quote?.version || 1);
  const versionLabel = `v${String(versionNumber).padStart(3, "0")}`;
  const rebuiltAt = normalizeText(quote?.generatedAt) || new Date().toISOString();
  const summaryParts = [];

  summaryParts.push(
    `Considered ${effectiveSummary.total} clarification note${effectiveSummary.total === 1 ? "" : "s"} `
    + `(${effectiveSummary.operatorCount} operator, ${effectiveSummary.systemCount} system).`
  );
  if (effectiveSummary.actionableCount > 0) {
    summaryParts.push(
      `Actionable operator notes: ${effectiveSummary.actionableCount}`
      + `, including ${effectiveSummary.reviewRequestedCount} review request${effectiveSummary.reviewRequestedCount === 1 ? "" : "s"}`
      + ` and ${effectiveSummary.duplicationConcernCount} duplication concern${effectiveSummary.duplicationConcernCount === 1 ? "" : "s"}.`
    );
  }
  if (effectiveSummary.rebuildDirectiveCount > 0) {
    summaryParts.push(
      `${effectiveSummary.rebuildDirectiveCount} note${effectiveSummary.rebuildDirectiveCount === 1 ? "" : "s"} explicitly asked for a rebuild/reframe.`
    );
  }
  if (effectiveSummary.referencedItemCodes.length > 0) {
    summaryParts.push(`Referenced items: ${effectiveSummary.referencedItemCodes.slice(0, 6).join(", ")}.`);
  }

  const outcomeParts = [];
  outcomeParts.push(
    `Review status: ${quote?.review?.status === "manual_review" ? "manual review" : (quote?.review?.status || "ready")}.`
  );
  if (reviewReasons.length > 0) {
    outcomeParts.push(`Outstanding review: ${reviewReasons.slice(0, 3).join(" | ")}.`);
  }
  if (pricingIssues.length > 0) {
    outcomeParts.push(`Pricing issues: ${pricingIssues.slice(0, 3).join(" | ")}.`);
  } else if (quote?.internalPricing?.ready === true) {
    outcomeParts.push("Internal pricing is ready.");
  }

  return {
    title: SYSTEM_REBUILD_NOTE_TITLE,
    text: [
      `Quote ${versionLabel} rebuilt ${rebuiltAt}.`,
      summaryParts.join(" ").trim(),
      outcomeParts.join(" ").trim(),
    ].filter(Boolean).join("\n"),
    author: SYSTEM_REBUILD_NOTE_AUTHOR,
    surface: "breakdown",
    layer: "L6",
    itemCode: null,
    itemLabel: "Internal breakdown",
    version: String(versionNumber),
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function dedupeClarificationNotes(notes) {
  const latestByKey = new Map();
  for (const note of notes) {
    const key = [
      note.source || "",
      note.itemCode || "",
      normalizeForDedupe(note.title),
      normalizeForDedupe(note.text),
    ].join("::");
    const existing = latestByKey.get(key);
    if (!existing || compareNotesChronologically(note, existing) > 0) {
      latestByKey.set(key, note);
    }
  }
  return [...latestByKey.values()];
}

function normalizeForDedupe(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function sortNotesNewestFirst(notes) {
  return [...notes].sort((a, b) => compareNotesChronologically(b, a));
}

function compareNotesChronologically(a, b) {
  const aTime = Date.parse(a?.createdAt || "") || 0;
  const bTime = Date.parse(b?.createdAt || "") || 0;
  if (aTime !== bTime) return aTime - bTime;
  return Number(a?._index || 0) - Number(b?._index || 0);
}

function stripClarificationNoteMeta(note) {
  const { _index, ...clean } = note || {};
  return clean;
}
