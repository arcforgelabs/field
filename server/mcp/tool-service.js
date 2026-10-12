import {
  priceFromMargin,
  priceFromMarkup,
  pricingMetrics,
  requireApply,
  validateQuote,
  versionOf,
} from "./quoting-core.js";
import { omitItemCodes } from "../catalog/item-codes.js";

// An item is named by its uid (#178 code retirement step 6). `code`,
// `parentCode` and `childCode` are the older names for the same inputs and
// still accept a legacy code; catalogue tools never return codes.
const ITEM = { type: "string", minLength: 1, description: "Item uid. A legacy item code also works." };
const LEGACY = (field) => ({ type: "string", description: `Deprecated: the same as ${field}.` });
const CATALOG_TOOLS = new Set(["field_price_item_list", "field_price_item_get", "field_pricing_review", "field_price_item_update", "field_catalog_structure", "field_catalog_structure_update"]);

const objectSchema = (properties, required = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const CATALOG_STRUCTURE_ACTIONS = [
  "category_create",
  "category_rename",
  "category_delete",
  "child_add",
  "child_update",
  "child_remove",
];

export const TOOL_DEFINITIONS = [
  {
    name: "field_price_item_list",
    description: "Search Field price catalog items.",
    inputSchema: objectSchema({
      search: { type: "string" },
      category: { type: "string" },
      status: { type: "string" },
    }),
    outputSchema: objectSchema({
      items: {
        type: "array",
        items: { type: "object" },
      },
    }, ["items"]),
  },
  {
    name: "field_price_item_get",
    description: "Read one Field price item and its version.",
    inputSchema: objectSchema({ item: ITEM, code: LEGACY("item") }),
  },
  {
    name: "field_quote_catalog_list",
    description: "List Field quote catalogs, or inspect one existing catalog by id. Read-only.",
    inputSchema: objectSchema({
      id: { type: "string", description: "Optional quote catalog id. Omit or leave empty to list all." },
    }),
    outputSchema: objectSchema({
      catalogs: {
        type: "array",
        items: { type: "object" },
      },
    }, ["catalogs"]),
  },
  {
    name: "field_pricing_review",
    description: "Review cost, price, profit, markup, and margin for a catalog item and/or explicit values. Read-only.",
    inputSchema: objectSchema({
      item: { type: "string", description: "Optional item uid (a legacy item code also works)." },
      code: LEGACY("item"),
      cost: { type: "number", minimum: 0, description: "Explicit cost override." },
      price: { type: "number", minimum: 0, description: "Explicit sell price override." },
    }),
  },
  {
    name: "field_markup_preview",
    description: "Calculate price, markup and margin without mutation. Strict tool schemas require every property, so this tool uses a single basis instead of XOR fields.",
    inputSchema: objectSchema({
      cost: { type: "number", minimum: 0, description: "Cost amount." },
      basis: {
        type: "string",
        enum: ["markup", "margin"],
        description: "markup divides profit by cost; margin divides profit by sell price and must be below 100.",
      },
      percent: { type: "number", minimum: 0, description: "Percent for the chosen basis." },
    }, ["cost", "basis", "percent"]),
  },
  {
    name: "field_price_item_update",
    description: "Dry-run or apply a guarded price update.",
    inputSchema: objectSchema({
      item: ITEM,
      code: LEGACY("item"),
      buyPrice: { type: "number", minimum: 0 },
      sellPrice: { type: "number", minimum: 0 },
      markupPercent: { type: "number", minimum: 0 },
      apply: { type: "boolean" },
      confirmation: { type: "string" },
      expectedVersion: { type: "string" },
    }),
  },
  {
    name: "field_catalog_structure",
    description: "Inspect Field catalog categories, or one item's children. Read-only.",
    inputSchema: objectSchema({
      item: { type: "string", description: "Item uid (a legacy code also works). If supplied, list this item's children; otherwise list categories." },
      code: LEGACY("item"),
    }),
  },
  {
    name: "field_catalog_structure_update",
    description: "Dry-run or apply supported category/component-link changes. No item deletion. Requires APPLY and expectedVersion.",
    inputSchema: objectSchema({
      action: { type: "string", enum: CATALOG_STRUCTURE_ACTIONS },
      parentItem: { type: "string", description: "Parent kit uid for child actions (a legacy code also works)." },
      childItem: { type: "string", description: "Component uid for child actions (a legacy code also works)." },
      parentCode: LEGACY("parentItem"),
      childCode: LEGACY("childItem"),
      categoryId: { type: "string" },
      name: { type: "string" },
      quantity: { type: "number", minimum: 0 },
      entryQuantity: { type: "number", minimum: 0 },
      entryUnit: { type: "string" },
      apply: { type: "boolean" },
      confirmation: { type: "string" },
      expectedVersion: { type: "string" },
    }, ["action"]),
  },
  {
    name: "field_quote_list",
    description: "List quote drafts.",
    inputSchema: objectSchema({
      search: { type: "string" },
      status: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }),
    outputSchema: objectSchema({
      quotes: {
        type: "array",
        items: { type: "object" },
      },
    }, ["quotes"]),
  },
  {
    name: "field_quote_get",
    description: "Read one quote using Field selection semantics. Default view omits evidence, activity, transcripts, and workspace payloads.",
    inputSchema: objectSchema({
      jobId: { type: "string", minLength: 1 },
      version: { type: "integer", minimum: 1 },
      view: {
        type: "string",
        enum: ["summary", "quote", "full"],
        description: "summary = identity and totals; quote = focused quote (default); full = complete job detail.",
      },
    }, ["jobId"]),
  },
  {
    name: "field_quote_validate",
    description: "Validate one quote draft without delivery.",
    inputSchema: objectSchema({
      jobId: { type: "string", minLength: 1 },
      version: { type: "integer", minimum: 1 },
    }, ["jobId"]),
  },
  {
    name: "field_quote_draft_create",
    description: "Dry-run or apply creation of an unsent quote draft.",
    inputSchema: objectSchema({
      quoteCatalogId: { type: "string", minLength: 1 },
      siteAddress: { type: "string" },
      quotedBy: { type: "string" },
      apply: { type: "boolean" },
      confirmation: { type: "string" },
      expectedVersion: { type: "string" },
    }),
  },
  {
    name: "field_quote_draft_update",
    description: "Dry-run or apply a guarded quote draft update.",
    inputSchema: objectSchema({
      jobId: { type: "string", minLength: 1 },
      patch: objectSchema({
        lineItems: { type: "object" },
        commercialAdjustments: { type: "array", items: { type: "object" } },
        assumptions: { type: "object" },
        presentation: { type: ["object", "null"] },
        paymentSchedule: { type: ["object", "array", "null"] },
        optionSelections: { type: "object" },
        acceptedOptionSelections: { type: "object" },
      }),
      apply: { type: "boolean" },
      confirmation: { type: "string" },
      expectedVersion: { type: "string" },
    }, ["jobId", "patch"]),
  },
  {
    name: "field_quote_recalculate",
    description: "Dry-run or apply guarded quote pricing recalculation.",
    inputSchema: objectSchema({
      jobId: { type: "string", minLength: 1 },
      apply: { type: "boolean" },
      confirmation: { type: "string" },
      expectedVersion: { type: "string" },
    }, ["jobId"]),
  },
];

export const TOOL_SCOPES = Object.freeze({
  field_price_item_list: ["catalog.read"],
  field_price_item_get: ["catalog.read"],
  field_quote_catalog_list: ["catalog.read"],
  field_pricing_review: ["catalog.read"],
  field_markup_preview: [],
  field_price_item_update: ["catalog.read", "catalog.write"],
  field_catalog_structure: ["catalog.read"],
  field_catalog_structure_update: ["catalog.read", "catalog.write"],
  field_quote_list: ["quote.read"],
  field_quote_get: ["quote.read"],
  field_quote_validate: ["quote.read"],
  field_quote_draft_create: ["quote.read", "quote.draft"],
  field_quote_draft_update: ["quote.read", "quote.draft"],
  field_quote_recalculate: ["quote.read", "quote.draft"],
});

const definitionsByName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function validationError(message) {
  return Object.assign(new Error(message), { code: "validation_error" });
}

function notFound(message) {
  return Object.assign(new Error(message), { code: "not_found" });
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function validateValue(value, schema, path) {
  const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !allowedTypes.some((type) => matchesType(value, type))) {
    throw validationError(`${path} has an invalid type`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw validationError(`${path} must be one of ${schema.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw validationError(`${path} must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) throw validationError(`${path} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw validationError(`${path} is above maximum`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    throw validationError(`${path} is too short`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    validateObject(value, schema, path);
  }
}

function validateObject(value, schema, path = "arguments") {
  if (!matchesType(value, "object")) throw validationError(`${path} must be an object`);
  for (const required of schema.required || []) {
    if (!Object.hasOwn(value, required)) throw validationError(`${path}.${required} is required`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        throw validationError(`${path}.${key} is not supported`);
      }
    }
  }
  for (const [key, child] of Object.entries(schema.properties || {})) {
    if (Object.hasOwn(value, key)) validateValue(value[key], child, `${path}.${key}`);
  }
}

function requiredText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw validationError(`${field} is required`);
  return text;
}

/** The item an input names: `item` (a uid or legacy code), else the deprecated `code`. */
export function itemArgument(args, field = "item", legacy = "code") {
  return String(args?.[field] ?? args?.[legacy] ?? "").trim();
}

export function validateToolArguments(name, args) {
  const definition = definitionsByName.get(name);
  if (!definition) throw Object.assign(new Error("Unknown tool"), { code: "unknown_tool" });
  validateObject(args, definition.inputSchema);
  if ((name === "field_price_item_get" || name === "field_price_item_update") && !itemArgument(args)) {
    throw validationError("arguments.item is required");
  }

  if (name === "field_price_item_update"
    && !["buyPrice", "sellPrice", "markupPercent"].some((key) => Object.hasOwn(args, key))) {
    throw validationError("Price update must change buyPrice, sellPrice, or markupPercent");
  }
  if (name === "field_quote_draft_update" && Object.keys(args.patch).length === 0) {
    throw validationError("Quote patch must contain at least one field");
  }
  if (name === "field_pricing_review") {
    const hasCode = itemArgument(args) !== "";
    const hasExplicit = args.cost != null && args.price != null;
    if (!hasCode && !hasExplicit) {
      throw validationError("Pricing review requires an item or both cost and price");
    }
  }
  if (name === "field_markup_preview" && args.basis === "margin" && args.percent >= 100) {
    throw validationError("arguments.percent is above maximum");
  }
  return args;
}

export function projectQuoteRead(detail, view = "quote") {
  const resolvedView = ["summary", "quote", "full"].includes(view) ? view : "quote";
  const version = versionOf(detail);
  if (detail == null || typeof detail !== "object") {
    return { view: resolvedView, version, detail };
  }
  const meta = detail.meta && typeof detail.meta === "object" ? detail.meta : {};
  const quote = detail.quote && typeof detail.quote === "object" ? detail.quote : null;
  const identity = {
    view: resolvedView,
    version,
    jobId: meta.id || detail.id || quote?.jobId || null,
    title: meta.title || detail.title || quote?.title || null,
    status: meta.status || detail.status || quote?.status || null,
    siteAddress: meta.siteAddress || detail.siteAddress || null,
    pipelineStage: meta.pipelineStage || null,
    quoteVersion: quote?.version || detail.versionView?.selectedVersion || null,
    quoteStatus: quote?.status || null,
    totals: quote?.customerPricing || quote?.totals || null,
  };
  if (resolvedView === "summary") {
    return { ...identity, versionView: detail.versionView || null };
  }
  if (resolvedView === "full") {
    return { ...detail, view: "full", version };
  }
  return {
    ...identity,
    meta: detail.meta || null,
    quote,
    presentation: quote?.presentation || detail.presentation || null,
    review: detail.review || null,
    quoteEditPolicy: detail.quoteEditPolicy || null,
    versionView: detail.versionView || null,
    quoteVersions: Array.isArray(detail.quoteVersions)
      ? detail.quoteVersions.map((row) => ({
        version: row.version,
        label: row.label || row.selectedLabel || null,
        isLatest: row.isLatest === true,
        isSelected: row.isSelected === true,
      }))
      : [],
  };
}

export function createFieldMcpService({
  listPriceItems,
  getPriceItem,
  updatePriceItem,
  listQuotes,
  getQuote,
  createQuote,
  updateQuote,
  recalculateQuote,
  listQuoteCatalogs,
  getQuoteCatalog,
  listCategories,
  listChildren,
  createCategory,
  updateCategory,
  deleteCategory,
  addChild,
  updateChild,
  removeChild,
  getCatalogVersion = null,
}) {
  // Re-read, compare, write. The store re-checks inside its write transaction
  // (the item's version, or the catalogue version for structure changes), so a
  // write that lands between the re-read and this one is refused, not lost.
  async function guardedMutation({ params, operation, before, reread, write }) {
    const currentVersion = versionOf(before);
    const preview = requireApply({
      ...params,
      currentVersion,
      operation,
      before,
      request: {},
    });
    if (preview) return preview;

    const current = await reread();
    if (versionOf(current) !== params.expectedVersion) {
      throw Object.assign(new Error("Stale expectedVersion; run a new dry-run"), {
        code: "stale_version",
      });
    }
    let after;
    try {
      after = await write(current);
    } catch (error) {
      if (error?.code === "VERSION_CONFLICT") {
        throw Object.assign(new Error("Stale expectedVersion; run a new dry-run"), {
          code: "stale_version",
        });
      }
      throw error;
    }
    return {
      ok: true,
      applied: true,
      dryRun: false,
      audit: {
        operation,
        occurredAt: new Date().toISOString(),
        expectedVersion: params.expectedVersion,
        resultingVersion: versionOf(after),
        before: current,
        after,
      },
    };
  }

  async function catalogStructureCollection(params) {
    if (String(params.action || "").startsWith("child_")) {
      return listChildren(requiredText(itemArgument(params, "parentItem", "parentCode"), "parentItem"));
    }
    return listCategories();
  }

  async function applyCatalogStructure(params, actor, guard = {}) {
    if (params.action === "category_create") {
      return createCategory({ name: requiredText(params.name, "name") }, actor, guard);
    }
    if (params.action === "category_rename") {
      return updateCategory(requiredText(params.categoryId, "categoryId"), {
        name: requiredText(params.name, "name"),
      }, actor, guard);
    }
    if (params.action === "category_delete") {
      return deleteCategory(requiredText(params.categoryId, "categoryId"), actor, guard);
    }
    const parentItem = () => requiredText(itemArgument(params, "parentItem", "parentCode"), "parentItem");
    const childItem = () => requiredText(itemArgument(params, "childItem", "childCode"), "childItem");
    if (params.action === "child_add") {
      return addChild({
        parentCode: parentItem(),
        childCode: childItem(),
        quantity: params.quantity,
        entryQuantity: params.entryQuantity,
        entryUnit: params.entryUnit,
      }, actor, guard);
    }
    if (params.action === "child_update") {
      return updateChild({
        parentCode: parentItem(),
        childCode: childItem(),
        quantity: params.quantity,
        entryQuantity: params.entryQuantity,
        entryUnit: params.entryUnit,
      }, actor, guard);
    }
    return removeChild({
      parentCode: parentItem(),
      childCode: childItem(),
    }, actor, guard);
  }

  async function callTool(name, params, actor) {

      if (name === "field_price_item_list") return { items: await listPriceItems(params) };
      if (name === "field_price_item_get") {
        const item = await getPriceItem(itemArgument(params));
        return { item, version: versionOf(item) };
      }
      if (name === "field_quote_catalog_list") {
        const id = String(params.id || "").trim();
        if (id) {
          const catalog = await getQuoteCatalog(id);
          if (!catalog) throw notFound("Quote catalog not found");
          return { catalogs: [catalog] };
        }
        return { catalogs: await listQuoteCatalogs() };
      }
      if (name === "field_pricing_review") {
        const code = itemArgument(params);
        let item = null;
        let cost = params.cost;
        let price = params.price;
        if (code) {
          item = await getPriceItem(code);
          cost ??= item.effective_buy_price ?? item.buy_price;
          price ??= item.effective_sell_price ?? item.sell_price;
        }
        return {
          ...(item ? { item: { uid: item.uid, name: item.name } } : {}),
          ...pricingMetrics({ cost, price }),
        };
      }
      if (name === "field_markup_preview") {
        const price = params.basis === "markup"
          ? priceFromMarkup(params.cost, params.percent)
          : priceFromMargin(params.cost, params.percent);
        return { basis: params.basis, ...pricingMetrics({ cost: params.cost, price }) };
      }
      if (name === "field_price_item_update") {
        const identity = itemArgument(params);
        const before = await getPriceItem(identity);
        const buyPrice = params.buyPrice ?? before.buy_price;
        const patch = {};
        if (params.buyPrice != null) Object.assign(patch, { buy_price: params.buyPrice, buy_price_mode: "manual" });
        if (params.sellPrice != null) Object.assign(patch, { sell_price: params.sellPrice, sell_price_mode: "manual" });
        if (params.markupPercent != null) {
          Object.assign(patch, {
            sell_price: priceFromMarkup(buyPrice, params.markupPercent),
            sell_price_mode: "manual",
          });
        }
        return guardedMutation({
          params,
          operation: "price_item_update",
          before,
          reread: () => getPriceItem(identity),
          write: (current) => updatePriceItem(identity, patch, actor, {
            expectedVersion: Number.isInteger(current?.version) ? current.version : null,
          }),
        });
      }
      if (name === "field_catalog_structure") {
        const identity = itemArgument(params);
        if (identity) return { parentItem: identity, children: await listChildren(identity) };
        return { categories: await listCategories() };
      }
      if (name === "field_catalog_structure_update") {
        const before = await catalogStructureCollection(params);
        let expectedCatalogVersion = null;
        return guardedMutation({
          params,
          operation: params.action,
          before,
          // Read the catalogue version first: any write after it refuses ours.
          reread: async () => {
            expectedCatalogVersion = getCatalogVersion ? (await getCatalogVersion()).version : null;
            return catalogStructureCollection(params);
          },
          write: async () => {
            await applyCatalogStructure(params, actor, { expectedCatalogVersion });
            return catalogStructureCollection(params);
          },
        });
      }
      if (name === "field_quote_list") return { quotes: await listQuotes(params) };
      if (name === "field_quote_get") {
        const detail = await getQuote(params.jobId, params.version);
        return projectQuoteRead(detail, params.view || "quote");
      }
      if (name === "field_quote_validate") {
        const detail = await getQuote(params.jobId, params.version);
        return { jobId: params.jobId, version: versionOf(detail), ...validateQuote(detail) };
      }
      if (name === "field_quote_draft_create") {
        const before = await listQuotes({});
        const preview = requireApply({
          ...params,
          currentVersion: versionOf(before),
          operation: "quote_draft_create",
          before,
          request: {},
        });
        if (preview) return preview;
        if (versionOf(await listQuotes({})) !== params.expectedVersion) {
          throw Object.assign(new Error("Stale expectedVersion; run a new dry-run"), {
            code: "stale_version",
          });
        }
        const after = await createQuote(params, actor);
        return {
          ok: true,
          applied: true,
          dryRun: false,
          audit: {
            operation: "quote_draft_create",
            occurredAt: new Date().toISOString(),
            expectedVersion: params.expectedVersion,
            resultingVersion: versionOf(after),
            before,
            after,
          },
        };
      }
      if (name === "field_quote_draft_update" || name === "field_quote_recalculate") {
        const before = await getQuote(params.jobId);
        return guardedMutation({
          params,
          operation: name.replace("field_", ""),
          before,
          reread: () => getQuote(params.jobId),
          write: () => name === "field_quote_draft_update"
            ? updateQuote(params.jobId, { ...params.patch }, actor)
            : recalculateQuote(params.jobId, actor),
        });
      }
      throw Object.assign(new Error("Unknown tool"), { code: "unknown_tool" });
  }

  return {
    async call(name, untrustedArguments, actor) {
      const params = validateToolArguments(name, untrustedArguments);
      const result = await callTool(name, params, actor);
      // Catalogue answers name items by uid and name, never by code.
      return CATALOG_TOOLS.has(name) ? omitItemCodes(result) : result;
    },
  };
}
