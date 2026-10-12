/**
 * The state of a quote row that a "catalogue changed" check reviewed (#148).
 *
 * The server's diff (server/quote-catalog-sync.js) gives each listed row a
 * `reviewKey`: a fingerprint of the row as the check saw it, and of the rows
 * directly under it (a kit's component rows, or the operator's own rows).
 * Anything that changes what applying would do moves the key: a typed rate,
 * an override, a quantity, a unit, the link, or a row added, removed or
 * edited under it. How a row is shown (expanded or collapsed in the editor,
 * its notes, row style and amount visibility) is left out: neither the diff
 * nor the apply reads it, so it never sends the operator back to check again.
 *
 * The quote editor computes the same key on its draft before it applies. A
 * ticked row whose key no longer matches was edited after the check, so the
 * editor checks again instead of applying (an edited row is overridden and
 * the new list leaves it unticked). The apply route skips any row whose key
 * differs from the one the caller reviewed, so an edit is never replaced on
 * the strength of a stale list.
 *
 * Pure and synchronous, for Node and the browser alike. The key follows JSON
 * semantics (undefined fields are dropped, key order does not matter), so a
 * draft and the same draft sent to the server as JSON give the same key.
 */

// Row fields that only change how a row is shown.
const VIEW_ONLY_FIELDS = new Set(["collapsed", "notes", "rowStyle", "amountVisible", "amountBlank"]);

function reviewedFields(node) {
  if (!node || typeof node !== "object") return node ?? null;
  const fields = {};
  for (const [key, value] of Object.entries(node)) {
    if (!VIEW_ONLY_FIELDS.has(key)) fields[key] = value;
  }
  return fields;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    return json === undefined ? "null" : json;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined || typeof entry === "function" ? "null" : stableJson(entry))).join(",")}]`;
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined || typeof entry === "function") continue;
    parts.push(`${JSON.stringify(key)}:${stableJson(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

// cyrb53: a fast, well-mixed 53-bit string hash. Not cryptographic: it only
// has to tell one state of a row from the next.
function hash53(input) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * The review key of one organizer row: the row and the rows directly under
 * it, or null when the row is not on the organizer.
 */
export function quoteCatalogReviewKey(organizer, nodeId) {
  const nodes = organizer?.nodes || {};
  const node = Object.prototype.hasOwnProperty.call(nodes, nodeId) ? nodes[nodeId] : null;
  if (!node) return null;
  const children = (Array.isArray(node.children) ? node.children : [])
    .map((childId) => [childId, reviewedFields(Object.prototype.hasOwnProperty.call(nodes, childId) ? nodes[childId] : null)]);
  return `rk1-${hash53(stableJson({ node: reviewedFields(node), children }))}`;
}
