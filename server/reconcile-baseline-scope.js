function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function reconcileBaselineScope({
  quoteInputs = null,
  baselineQuote = null,
  clarificationNotes = [],
} = {}) {
  if (!quoteInputs || typeof quoteInputs !== "object") return quoteInputs;

  const baselineItems = asArray(baselineQuote?.lineItems)
    .filter((item) => item && typeof item === "object")
    .filter((item) => item.customerVisible !== false)
    .map((item) => normalizeBaselineLineItem(item))
    .filter((item) => item.quoteCatalogItemCode || item.label);

  if (!baselineItems.length) return quoteInputs;

  const existingCandidates = asArray(quoteInputs.lineItemCandidates);
  const existingKeySet = new Set(existingCandidates.map((item) => buildCandidateKey(item)).filter(Boolean));
  const notes = asArray(clarificationNotes)
    .filter((note) => note?.source === "operator");
  const preserved = [];

  for (const baselineItem of baselineItems) {
    const key = buildCandidateKey(baselineItem);
    if (key && existingKeySet.has(key)) continue;
    if (hasExplicitRemovalDirective(notes, baselineItem)) continue;
    preserved.push(baselineItem);
    if (key) existingKeySet.add(key);
  }

  if (!preserved.length) return quoteInputs;

  const baselineVersion = Number(baselineQuote?.version || 1);
  const preservedCandidates = preserved.map((item) => ({
    label: item.label,
    description: item.scopeSummary || item.label || null,
    // DEL-30 (P2-1): carry the baseline item's own `code` forward. For an
    // option sibling this is its distinct per-candidate identity (not the
    // shared rule code) — dropping it here would let the next rebuild's
    // grouping (server/generate-evidence-quote.js:1018-1024) merge siblings
    // that share one catalogue rule back into a single line item, and would
    // make this preserved candidate indistinguishable from its sibling on a
    // later reconcile pass (buildCandidateKey below).
    code: item.code || null,
    quoteCatalogItemCode: item.quoteCatalogItemCode,
    quantity: item.quantity,
    unit: item.unit,
    fillVolumeM3: null,
    netVolumeM3: null,
    confidence: null,
    rationale: `Preserved from prior quote v${baselineVersion} because no explicit removal instruction was found.`,
    section: item.section,
    evidence: [],
    evidenceSummary: [],
  }));
  const preservedAssumptions = preserved.map((item) => ({
    statement: buildPreservedAssumption({ item, baselineVersion, notes }),
    evidence: [],
    evidenceSummary: [],
  }));

  return {
    ...quoteInputs,
    reviewStatus: "manual_review",
    lineItemCandidates: [
      ...existingCandidates,
      ...preservedCandidates,
    ],
    assumptions: dedupeAssumptions([
      ...asArray(quoteInputs.assumptions),
      ...preservedAssumptions,
    ]),
  };
}

function normalizeBaselineLineItem(item) {
  return {
    code: normalizeText(item.code),
    quoteCatalogItemCode: normalizeText(item.quoteCatalogItemCode) || extractRuleCode(item.code),
    label: normalizeText(item.label),
    scopeSummary: normalizeText(item.scopeSummary),
    section: normalizeText(item.section),
    quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null,
    unit: normalizeText(item.unit),
  };
}

function extractRuleCode(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const sectionIndex = normalized.indexOf("__section-");
  return sectionIndex >= 0 ? normalized.slice(0, sectionIndex) : normalized;
}

// DEL-30 (P0-2): identity must be keyed on the stable catalogue identifier,
// not the human label. A baseline line item generated from a catalogue rule
// carries rule.label (server/generate-evidence-quote.js), while the operator
// or transcript candidate that produced it carries whatever label the
// operator/transcript used — those routinely differ for the SAME catalogue
// item ("Concrete breakout" vs "Concrete surface demolition"). Keying on
// label as well as code made every such pair look like two different items,
// so the "missing" baseline item was re-injected as a duplicate on every
// rebuild.
//
// DEL-30 (P2-1): quoteCatalogItemCode alone is not always distinct, though.
// Option candidates in a "select one" section deliberately get their own
// `code` (the candidate's own code, not the rule code) so that siblings
// sharing one quote-catalog rule produce separate line items instead of
// merging (server/generate-evidence-quote.js:1015-1024,1200-1203) — every
// sibling still carries the SAME quoteCatalogItemCode. Keying on
// quoteCatalogItemCode alone would collapse those deliberately-separate
// siblings onto one key and silently drop all but one on rebuild. `code` is
// only ever the bare rule code (± an extractRuleCode-able `__section-`
// suffix) for an ordinary single-per-rule-per-section item, so: when `code`
// carries information beyond the rule code, it's an option sibling's own
// identity and takes priority; otherwise fall back to quoteCatalogItemCode
// so a rule-label/operator-label mismatch for that one line still resolves
// to a single identity. Label is used only as a last resort, for items that
// carry no catalogue code at all — the only stable identifier left for those.
//
// DEL-30 (P3-1, known asymmetry, tracked for a real fix under DEL-66):
// identity here is inferred from which of `code` / `quoteCatalogItemCode` an
// item happens to carry, and that inference only agrees when the baseline
// item and the candidate that's meant to match it carry the SAME shape.
// Two asymmetric cases exist, and both fail by duplicating rather than
// merging (the safer of the two failure modes, but still wrong):
//   1. Baseline is an option sibling (distinct `code`, shared
//      quoteCatalogItemCode), but a fresh candidate re-mentioning it this
//      round supplies only quoteCatalogItemCode with no `code`. The
//      candidate keys on the rule code; the baseline sibling keys on its own
//      `code`. They don't match, so the sibling is preserved again alongside
//      the freshly re-extracted candidate.
//   2. The reverse: a candidate carries its own `code` that differs from
//      quoteCatalogItemCode (nothing stops an incoming candidate from having
//      one — normalizeLineItemCandidates in server/extract-quote-inputs.js
//      spreads the input and strips only pricingReferenceId/
//      priceListItemCode), while the matching baseline item keys on the
//      catalogue code as usual. Same mismatch, same duplication.
// Neither is reachable today: options only enter via the agent-driven PUT
// /quote-inputs path, which is the only producer that sets `code`, and AI
// transcript extraction never emits one. The durable fix is a first-class,
// stable line-item identity carried end-to-end instead of inferring one
// from two optional, producer-dependent fields.
function buildCandidateKey(item) {
  const rawCode = normalizeText(item?.code);
  const catalogCode = normalizeText(item?.quoteCatalogItemCode);
  const section = normalizeText(item?.section) || "";
  const isDistinctFromRuleCode = Boolean(
    rawCode && catalogCode && extractRuleCode(rawCode) !== catalogCode
  );
  const code = isDistinctFromRuleCode
    ? rawCode
    : (catalogCode || extractRuleCode(rawCode));
  if (code) return `code::${code}::${section.toLowerCase()}`;
  const label = normalizeText(item?.label) || "";
  if (!label) return null;
  return `label::${section.toLowerCase()}::${label.toLowerCase()}`;
}

function hasExplicitRemovalDirective(notes, item) {
  return notes.some((note) => noteExplicitlyRemovesItem(note, item));
}

function noteExplicitlyRemovesItem(note, item) {
  const combined = `${note?.title || ""}\n${note?.text || ""}`.trim();
  if (!combined) return false;
  if (/\?/.test(combined)) return false;
  if (!/\b(remove|omit|exclude|drop|delete|cancel|leave out|take out|do not include|don't include|removed from (?:this|the) quote|not part of (?:this|the) quote)\b/i.test(combined)) {
    return false;
  }

  const noteItemCode = normalizeText(note?.itemCode);
  const itemCode = normalizeText(item.quoteCatalogItemCode) || normalizeText(item.code);
  if (noteItemCode && itemCode && noteItemCode === itemCode) return true;

  const noteLabel = normalizeText(note?.itemLabel);
  const itemLabel = normalizeText(item.label);
  if (noteLabel && itemLabel && noteLabel.toLowerCase() === itemLabel.toLowerCase()) return true;

  const haystack = combined.toLowerCase();
  const labelMatch = itemLabel && haystack.includes(itemLabel.toLowerCase());
  const codeMatch = itemCode && haystack.includes(itemCode.toLowerCase());
  return Boolean(labelMatch || codeMatch);
}

function buildPreservedAssumption({ item, baselineVersion, notes }) {
  const relatedQuestion = notes.find((note) => {
    if (!note?.signals?.questionRaised) return false;
    return noteTargetsItem(note, item);
  });
  const label = item.label || item.quoteCatalogItemCode || "line item";
  const suffix = relatedQuestion
    ? ` Operator question kept it in manual review: ${truncateText(noteQuestionText(relatedQuestion), 140)}`
    : "";
  return `Preserved ${label} from prior quote v${baselineVersion} because it was not explicitly removed.${suffix}`.trim();
}

function noteTargetsItem(note, item) {
  const noteItemCode = normalizeText(note?.itemCode);
  const itemCode = normalizeText(item.quoteCatalogItemCode) || normalizeText(item.code);
  if (noteItemCode && itemCode && noteItemCode === itemCode) return true;

  const noteLabel = normalizeText(note?.itemLabel);
  const itemLabel = normalizeText(item.label);
  if (noteLabel && itemLabel && noteLabel.toLowerCase() === itemLabel.toLowerCase()) return true;

  const haystack = `${note?.title || ""}\n${note?.text || ""}`.toLowerCase();
  return Boolean(
    (itemLabel && haystack.includes(itemLabel.toLowerCase()))
    || (itemCode && haystack.includes(itemCode.toLowerCase()))
  );
}

function noteQuestionText(note) {
  return normalizeText(note?.text) || normalizeText(note?.title) || "Operator requested review.";
}

function dedupeAssumptions(items) {
  const seen = new Set();
  const results = [];
  for (const item of asArray(items)) {
    const statement = normalizeText(item?.statement);
    if (!statement) continue;
    const key = statement.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      statement,
      evidence: asArray(item?.evidence),
      evidenceSummary: asArray(item?.evidenceSummary),
    });
  }
  return results;
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}
