/**
 * Pricing Schedule catalogue search contract.
 *
 * Queries and eligible fields are trimmed, lower-cased, and have repeated
 * whitespace collapsed. The searchable fields are code, UID, name, unit,
 * category, and the catalogue kind label. A multi-term query matches when
 * every term occurs in the combined searchable fields, so terms may be split
 * across fields. Results rank full-field exact matches before full-query
 * prefixes, then full-query substrings, then term-level matches. Ties are
 * resolved by normalized name, code, UID, unit, category, and kind label.
 *
 * The input array is never mutated, and an empty query returns every input
 * item in the same deterministic tie order.
 */

const SEARCH_FIELD_WEIGHTS = Object.freeze({
  name: 6,
  code: 5,
  uid: 4,
  category: 3,
  unit: 2,
  kindLabel: 1,
});

const GOODS_SERVICE_CATALOG_TYPES = new Set(["goods_service", "product", "service"]);
const SEARCH_FIELD_NAMES = Object.freeze(["name", "code", "uid", "unit", "category", "kindLabel"]);

export function normalizeCatalogSearchText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function tokenizeCatalogSearchQuery(query) {
  const normalized = normalizeCatalogSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

function defaultCatalogKindLabel(item) {
  const catalogType = normalizeCatalogSearchText(item?.catalog_type);
  return GOODS_SERVICE_CATALOG_TYPES.has(catalogType) ? "Goods & Service" : "Component";
}

function getSearchFieldValues(item, { getKindLabel } = {}) {
  return {
    code: normalizeCatalogSearchText(item?.code),
    uid: normalizeCatalogSearchText(item?.uid),
    name: normalizeCatalogSearchText(item?.name),
    unit: normalizeCatalogSearchText(item?.unit),
    category: normalizeCatalogSearchText(item?.category),
    kindLabel: normalizeCatalogSearchText(
      typeof getKindLabel === "function" ? getKindLabel(item) : defaultCatalogKindLabel(item),
    ),
  };
}

function compareSearchText(first, second) {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function compareSearchFieldValues(first, second) {
  for (const fieldName of SEARCH_FIELD_NAMES) {
    const comparison = compareSearchText(first.fields[fieldName], second.fields[fieldName]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function scoreSearchFields(fields, query, terms) {
  if (!terms.length) return 0;

  let score = 0;
  for (const fieldName of SEARCH_FIELD_NAMES) {
    const value = fields[fieldName];
    if (!value) continue;
    const weight = SEARCH_FIELD_WEIGHTS[fieldName];

    if (value === query) score = Math.max(score, 100000 + weight);
    else if (value.startsWith(query)) score = Math.max(score, 10000 + weight);
    else if (value.includes(query)) score = Math.max(score, 1000 + weight);

    for (const term of terms) {
      if (value === term) score += 100 + weight;
      else if (value.startsWith(term)) score += 10 + weight;
      else if (value.includes(term)) score += 1 + weight;
    }
  }
  return score;
}

function compareSearchEntries(first, second) {
  const scoreDelta = second.score - first.score;
  return scoreDelta || compareSearchFieldValues(first, second);
}

export function searchCatalogItems(items, query, options = {}) {
  const normalizedQuery = normalizeCatalogSearchText(query);
  const terms = tokenizeCatalogSearchQuery(normalizedQuery);

  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const fields = getSearchFieldValues(item, options);
      const haystack = SEARCH_FIELD_NAMES.map((fieldName) => fields[fieldName])
        .filter(Boolean)
        .join(" ");
      if (terms.length && !terms.every((term) => haystack.includes(term))) return null;
      return { item, fields, score: scoreSearchFields(fields, normalizedQuery, terms) };
    })
    .filter(Boolean)
    .sort(compareSearchEntries)
    .map(({ item }) => item);
}

/**
 * Build the complete result model used by the Pricing Schedule quick picker.
 * The model deliberately has no presentation-window limit; the results
 * container owns scrolling while keyboard selection owns the active row.
 */
export function buildCatalogQuickSearchModel(items, query, options = {}) {
  return { results: searchCatalogItems(items, query, options) };
}

function normalizeCatalogSearchCount(resultCount) {
  const numericCount = Number(resultCount);
  return Number.isFinite(numericCount) ? Math.max(0, Math.trunc(numericCount)) : 0;
}

export function clampCatalogSearchSelection(selectedIndex, resultCount) {
  const numericIndex = Number(selectedIndex);
  const index = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : 0;
  const maxIndex = Math.max(normalizeCatalogSearchCount(resultCount) - 1, 0);
  return Math.max(0, Math.min(index, maxIndex));
}

export function moveCatalogSearchSelection(selectedIndex, resultCount, direction) {
  const maxIndex = Math.max(normalizeCatalogSearchCount(resultCount) - 1, 0);
  const currentIndex = clampCatalogSearchSelection(selectedIndex, resultCount);
  if (direction === "next") return Math.min(currentIndex + 1, maxIndex);
  if (direction === "previous") return Math.max(currentIndex - 1, 0);
  return currentIndex;
}

export function getSelectedCatalogSearchItem(items, selectedIndex) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[clampCatalogSearchSelection(selectedIndex, items.length)] ?? null;
}

/**
 * Keep active-row IDs injective for catalogue identity: opaque UIDs take
 * precedence, while UID-less rows retain the exact code through URI encoding.
 */
export function getCatalogSearchResultId(item) {
  const uid = item?.uid;
  if (uid != null && String(uid).trim() !== "") {
    return "catalog-search-result-uid-" + encodeURIComponent(String(uid));
  }
  return "catalog-search-result-code-" + encodeURIComponent(String(item?.code ?? ""));
}

/**
 * Filter the flat list returned by the price-catalog items endpoint. Detail
 * responses expose children for editing, but searchable child catalogue
 * records remain eligible because they are also rows in this list.
 */
export function filterCatalogItems(items, filters = {}, options = {}) {
  let result = Array.isArray(items) ? items : [];
  const status = String(filters.status ?? "").trim();
  if (status && status !== "all") {
    result = result.filter((item) => item.status === status);
  }

  const category = String(filters.category ?? "").trim();
  if (category && category !== "all") {
    result = result.filter((item) => (
      category === "uncategorised" ? !item.category : item.category === category
    ));
  }

  return searchCatalogItems(result, filters.search, options);
}
