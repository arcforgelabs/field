// /api/price-catalog: the catalogue's HTTP API over the PostgreSQL store
// (server/catalog/store.js). Routes and response shapes are the ones the
// SQLite catalogue served; items also carry uid, version, price_id and the
// Postgres-native fields, codes can be edited, and a PATCH may name the
// version it was based on (expectedVersion) to refuse a stale write.
import { Router } from "express";
import multer from "multer";
import { join } from "node:path";
import { normalizeCatalogUnit } from "../../shared/catalog-units.js";
import { createQuoteUsage } from "../catalog/usage.js";
import { itemCodePreference } from "../catalog/item-codes.js";
import { DEFAULT_QUOTE_CATALOG_ID } from "../quote-catalog-ids.js";
import { CatalogError, CatalogNameConflictError } from "../catalog/errors.js";
import { exportCatalog } from "../catalog/export.js";
import { buildCatalogQuoteLine } from "../quote-catalog-sync.js";
import { withPriceBookHealth } from "../catalog/price-book-health.js";
import { createPriceBookRouter } from "../catalog/price-book-http.js";

function getAuthor(req) {
  return req.headers["x-actor-name"] || "operator";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalText(value) {
  const text = normalizeText(value);
  return text || null;
}

function badRequest(message, path = null) {
  return new CatalogError("INVALID", message, { path });
}

function normalizeOptionalNumber(value, field, { allowNegative = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw badRequest(`${field} must be numeric`, field);
  if (!allowNegative && numeric < 0) throw badRequest(`${field} must be zero or greater`, field);
  return numeric;
}

function normalizeEnum(value, allowed, field, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) throw badRequest(`${field} must be one of: ${allowed.join(", ")}`, field);
  return normalized;
}

function normalizeCatalogType(value, fallback = null) {
  const normalized = normalizeEnum(value, ["goods_service", "product", "service", "component", "item"], "catalog_type", fallback);
  if (normalized === "goods_service" || normalized === "product" || normalized === "service") return "goods_service";
  if (normalized === "component" || normalized === "item") return "component";
  return normalized || fallback;
}

// Fields both create and update accept beyond the legacy set.
function normalizeNativeFields(body, out) {
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  if (has("description")) out.description = normalizeOptionalText(body.description);
  // Internal notes (never printed) and what the item is (pricing engine phase 1); the
  // store validates type.
  if (has("notes")) out.notes = normalizeOptionalText(body.notes);
  if (has("type")) out.type = normalizeOptionalText(body.type);
  if (has("kind")) out.kind = normalizeEnum(body.kind, ["material", "labour", "plant", "subcontract", "fee", "assembly"], "kind", null);
  if (has("tags")) out.tags = Array.isArray(body.tags) ? body.tags.map(String) : normalizeText(body.tags).split(",").filter(Boolean);
  if (has("tax_code")) out.tax_code = normalizeOptionalText(body.tax_code) || "GST";
  if (has("cost_mode")) out.cost_mode = normalizeEnum(body.cost_mode, ["manual", "rollup"], "cost_mode");
  if (has("sell_mode")) out.sell_mode = normalizeEnum(body.sell_mode, ["fixed", "markup", "rollup"], "sell_mode");
  if (has("markup_pct")) out.markup_pct = normalizeOptionalNumber(body.markup_pct, "markup_pct", { allowNegative: true });
  if (has("variant_of_uid")) out.variant_of_uid = normalizeOptionalText(body.variant_of_uid);
  else if (has("variant_of")) out.variant_of_uid = normalizeOptionalText(body.variant_of);
  return out;
}

function normalizeCreateItemBody(body = {}) {
  const code = normalizeText(body.code);
  const name = normalizeText(body.name);
  const unit = normalizeCatalogUnit(body.unit, "job");
  if (!name) throw badRequest("name is required", "name");
  return normalizeNativeFields(body, {
    ...(code ? { code } : {}),
    name,
    unit,
    buy_price: normalizeOptionalNumber(body.buy_price, "buy_price"),
    sell_price: normalizeOptionalNumber(body.sell_price, "sell_price"),
    buy_price_mode: normalizeEnum(body.buy_price_mode, ["manual", "computed"], "buy_price_mode", "manual"),
    sell_price_mode: normalizeEnum(body.sell_price_mode, ["manual", "computed"], "sell_price_mode", "manual"),
    price_reference: normalizeOptionalText(body.price_reference),
    catalog_type: normalizeCatalogType(body.catalog_type, "component"),
    category: normalizeOptionalText(body.category),
    status: normalizeEnum(body.status, ["active", "archived"], "status", "active"),
    pricing_basis: normalizeEnum(body.pricing_basis, ["per_tonne", "per_load", "per_m3"], "pricing_basis", null),
    pricing_basis_factor: normalizeOptionalNumber(body.pricing_basis_factor, "pricing_basis_factor"),
    ...(body.effective_from ? { effective_from: body.effective_from } : {}),
  });
}

function normalizeUpdateItemPatch(body = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const patch = {};
  if (has("name")) {
    const name = normalizeText(body.name);
    if (!name) throw badRequest("name cannot be empty", "name");
    patch.name = name;
  }
  if (has("code")) {
    const code = normalizeText(body.code);
    if (!code) throw badRequest("code cannot be empty", "code");
    patch.code = code;
  }
  if (has("unit")) {
    const unit = normalizeCatalogUnit(body.unit);
    if (!unit) throw badRequest("unit cannot be empty", "unit");
    patch.unit = unit;
  }
  if (has("buy_price")) patch.buy_price = normalizeOptionalNumber(body.buy_price, "buy_price");
  if (has("sell_price")) patch.sell_price = normalizeOptionalNumber(body.sell_price, "sell_price");
  if (has("buy_price_mode")) patch.buy_price_mode = normalizeEnum(body.buy_price_mode, ["manual", "computed"], "buy_price_mode");
  if (has("sell_price_mode")) patch.sell_price_mode = normalizeEnum(body.sell_price_mode, ["manual", "computed"], "sell_price_mode");
  if (has("price_reference")) patch.price_reference = normalizeOptionalText(body.price_reference);
  if (has("catalog_type")) patch.catalog_type = normalizeCatalogType(body.catalog_type, "component");
  if (has("category")) patch.category = normalizeOptionalText(body.category);
  if (has("status")) patch.status = normalizeEnum(body.status, ["active", "archived"], "status");
  if (has("pricing_basis")) patch.pricing_basis = normalizeEnum(body.pricing_basis, ["per_tonne", "per_load", "per_m3"], "pricing_basis", null);
  if (has("pricing_basis_factor")) patch.pricing_basis_factor = normalizeOptionalNumber(body.pricing_basis_factor, "pricing_basis_factor");
  return normalizeNativeFields(body, patch);
}

/**
 * The per-item ETag GET/PATCH/POST /items answer with; If-Match takes it back.
 *
 * W/"item-<uid>-v<n>@<catalogue tag>". The item version alone cannot drive
 * 304s: an item's served prices move without a version bump when a kit
 * child's price changes, a dated price becomes current, or a deploy ships new
 * recipes. Every one of those moves the catalogue ETag (version, price epoch,
 * build revision), so it is folded in. If-Match only compares the item part.
 */
export function itemEtag(item, catalogEtag = null) {
  const catalogTag = catalogEtag ? String(catalogEtag).replace(/^W\//, "").replace(/"/g, "") : "";
  return `W/"item-${item.uid}-v${item.version}${catalogTag ? `@${catalogTag}` : ""}"`;
}

/**
 * The version a PATCH was based on: body expectedVersion, or If-Match holding
 * the item's ETag (W/"item-<uid>-v<n>") or its bare version number. Returns
 * { version, uid } (uid only when the ETag named one).
 */
function expectedVersionOf(req) {
  const fromBody = req.body?.expectedVersion ?? req.body?.expected_version;
  const raw = fromBody ?? req.headers["if-match"];
  if (raw === undefined || raw === null || raw === "") return { version: null, uid: null };
  const text = String(raw).trim();
  const tagged = /^(?:W\/)?"item-([^"@]+)-v(\d+)(?:@[^"@]*)?"$/.exec(text);
  if (tagged) return { version: Number(tagged[2]), uid: tagged[1] };
  if (/catalog-/.test(text)) {
    throw badRequest("If-Match must be the item's ETag from GET /items/:code (W/\"item-<uid>-v<n>\") or its version number; the catalogue ETag from GET /items is not an item version", "expectedVersion");
  }
  const value = Number(text.replace(/^W\//, "").replace(/"/g, ""));
  if (!Number.isInteger(value) || value < 1) throw badRequest("expectedVersion must be the item's version number or its ETag", "expectedVersion");
  return { version: value, uid: null };
}

/** Send a catalogue error with its status and typed body. */
export function respondWithCatalogError(res, err, fallbackStatus = () => 400) {
  if (err instanceof CatalogNameConflictError) {
    return res.status(409).json({ error: err.message, code: "name_conflict", conflict: err.conflict });
  }
  if (err instanceof CatalogError) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code, path: err.path, ...(err.details ? { details: err.details } : {}) });
  }
  if (err?.code === "FIELD_NO_DATABASE") return res.status(503).json({ error: err.message, code: err.code });
  return res.status(fallbackStatus(err)).json({ error: err?.message || String(err) });
}

/**
 * revision identifies the running build (FIELD_REVISION, or one id per boot).
 * Item rows also depend on the quote-catalog recipes shipped with the build,
 * so it is folded into the catalogue ETag: a deploy never answers 304 to a
 * client holding rows built from the previous recipes.
 */
export function createPriceCatalogRouter({ store, dataDir, catalogId = DEFAULT_QUOTE_CATALOG_ID, revision = null }) {
  if (!store) throw new TypeError("createPriceCatalogRouter requires the catalogue store");
  const router = Router();
  // Item codes are legacy aliases (code retirement step 6): Prefer: field-item-codes=omit
  // drops them from every JSON answer; otherwise they are marked deprecated.
  router.use(itemCodePreference);
  const upload = multer({ dest: join(dataDir, "price-catalog", "_uploads") });

  const route = (handler, fallbackStatus = () => 500) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      respondWithCatalogError(res, err, fallbackStatus);
    }
  };

  const revisionTag = revision ? `-${String(revision).replace(/[^A-Za-z0-9._-]/g, "")}` : "";
  async function catalogVersion() {
    const current = await store.catalogVersion();
    return revisionTag ? { ...current, etag: current.etag.replace(/"$/, `${revisionTag}"`) } : current;
  }

  async function withCatalogEtag(req, res) {
    const { etag, version } = await catalogVersion();
    res.setHeader("ETag", etag);
    res.setHeader("X-Field-Catalog-Version", String(version));
    res.setHeader("Cache-Control", "no-cache");
    return req.headers["if-none-match"] === etag;
  }

  router.get("/version", route(async (_req, res) => {
    res.json(await catalogVersion());
  }));

  router.get("/health", route(async (_req, res) => {
    res.json(await withPriceBookHealth(store, await store.health({ catalogId })));
  }));

  // The price book: grid, bulk edits, suppliers, supplier price-list imports.
  router.use(createPriceBookRouter({ store, catalogId, route, getAuthor }));

  router.get("/export", route(async (_req, res) => {
    const payload = await exportCatalog(store.db);
    res.setHeader("Content-Disposition", `attachment; filename="field-catalogue-${payload.catalogVersion}.json"`);
    res.json(payload);
  }));

  // ── Items ──

  router.get("/items", route(async (req, res) => {
    if (await withCatalogEtag(req, res)) return res.status(304).end();
    res.json(await store.listItems({
      status: req.query.status || undefined,
      category: req.query.category || undefined,
      kind: req.query.kind || undefined, // deprecated — derived, not stored
      search: req.query.search || undefined,
    }));
  }));

  router.post("/current-prices", route(async (req, res) => {
    const uids = Array.isArray(req.body?.uids) ? req.body.uids.map(String) : [];
    if (uids.length > 2000) throw badRequest("at most 2000 uids per request", "uids");
    await withCatalogEtag(req, res);
    res.json(await store.getCurrentPrices(uids));
  }, () => 400));

  // The catalogue tag is read before the item, so a write landing between the
  // two can only make the tag older than the body (a needless 200 later),
  // never newer (a 304 over a stale body).
  async function sendItem(res, item, catalogEtag, status = 200) {
    res.setHeader("ETag", itemEtag(item, catalogEtag));
    res.setHeader("X-Field-Item-Version", String(item.version));
    res.setHeader("Cache-Control", "no-cache");
    return res.status(status).json(item);
  }

  router.get("/items/:code", route(async (req, res) => {
    const { etag } = await catalogVersion();
    const item = await store.getItem(req.params.code);
    if (!item) return res.status(404).json({ error: "not found" });
    await sendItem(res, item, etag);
  }));

  // Which quotes use an item: a short-cached scan of every job's
  // current quote and saved versions, rows matched by uid (or legacy code).
  const usage = createQuoteUsage({ dataDir, getState: () => store.getState() });
  router.get("/usage", route(async (_req, res) => {
    res.json(await usage.counts());
  }));
  router.get("/items/:code/usage", route(async (req, res) => {
    const uid = await store.resolveIdentity(req.params.code);
    if (!uid) return res.status(404).json({ error: "not found" });
    res.json(await usage.forItem(uid, { limit: req.query.limit == null ? 5 : Math.min(50, Number(req.query.limit) || 0) }));
  }));

  router.get("/items/:code/current-price", route(async (req, res) => {
    const price = await store.getCurrentPrice(req.params.code);
    if (!price) return res.status(404).json({ error: "not found" });
    res.json(price);
  }));

  router.get("/items/:code/kit", route(async (req, res) => {
    const kit = await store.getKitSnapshot(req.params.code);
    if (!kit) return res.status(404).json({ error: "not found" });
    res.json(kit);
  }));

  // The row a quote adds for this item (and its kit components), priced now,
  // with the uid, price id and price key the row records. Never cached: the
  // quote editor reads it at the moment it adds or re-links a row.
  router.get("/items/:code/quote-line", route(async (req, res) => {
    const line = buildCatalogQuoteLine(await store.getState(), req.params.code);
    if (!line) return res.status(404).json({ error: "not found" });
    res.setHeader("Cache-Control", "no-store");
    res.json(line);
  }));

  router.get("/items/:code/prices", route(async (req, res) => {
    const prices = await store.getPriceHistory(req.params.code);
    if (!prices) return res.status(404).json({ error: "not found" });
    res.json(prices);
  }));

  router.post("/items", route(async (req, res) => {
    const { etag } = await catalogVersion();
    const item = await store.createItem(normalizeCreateItemBody(req.body), {
      author: getAuthor(req),
      reason: normalizeOptionalText(req.body?.reason),
    });
    await sendItem(res, item, etag, 201);
  }, () => 400));

  router.post("/items/:code/duplicate", route(async (req, res) => {
    const item = await store.duplicateItem(req.params.code, {
      code: normalizeOptionalText(req.body?.code),
      name: normalizeOptionalText(req.body?.name),
      status: normalizeEnum(req.body?.status, ["active", "archived"], "status", "active"),
    }, { author: getAuthor(req) });
    if (!item) return res.status(404).json({ error: "not found" });
    res.status(201).json(item);
  }, () => 400));

  router.patch("/items/:code", route(async (req, res) => {
    const expected = expectedVersionOf(req);
    if (expected.uid) {
      const uid = await store.resolveIdentity(req.params.code);
      if (uid && uid !== expected.uid) throw badRequest(`If-Match names item ${expected.uid}, not ${uid}`, "expectedVersion");
    }
    const { etag } = await catalogVersion();
    const item = await store.updateItem(req.params.code, normalizeUpdateItemPatch(req.body), {
      author: getAuthor(req),
      reason: normalizeOptionalText(req.body?.reason),
      expectedVersion: expected.version,
      effectiveFrom: normalizeOptionalText(req.body?.effective_from),
    });
    if (!item) return res.status(404).json({ error: "not found" });
    await sendItem(res, item, etag);
  }, () => 400));

  router.delete("/items/:code", route(async (req, res) => {
    const item = await store.deleteItem(req.params.code, { author: getAuthor(req) });
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  }, () => 400));

  // ── Kit components ──

  router.post("/items/:code/children", route(async (req, res) => {
    const result = await store.addChild({
      parentCode: req.params.code,
      childCode: req.body?.child_code ?? req.body?.child_uid,
      quantity: req.body?.quantity,
      entryQuantity: req.body?.entry_quantity,
      entryUnit: req.body?.entry_unit,
      applicationMode: req.body?.application_mode,
      pricingContribution: req.body?.pricing_contribution,
      sortOrder: req.body?.sort_order,
    }, { author: getAuthor(req) });
    res.status(201).json(result);
  }, () => 400));

  router.patch("/items/:code/children/:child", route(async (req, res) => {
    const result = await store.updateChild({
      parentCode: req.params.code,
      childCode: req.params.child,
      quantity: req.body?.quantity,
      entryQuantity: req.body?.entry_quantity,
      entryUnit: req.body?.entry_unit,
      applicationMode: req.body?.application_mode,
      pricingContribution: req.body?.pricing_contribution,
      sortOrder: req.body?.sort_order,
    }, { author: getAuthor(req) });
    if (!result) return res.status(404).json({ error: "child link not found" });
    res.json(result);
  }, () => 400));

  router.delete("/items/:code/children/:child", route(async (req, res) => {
    await store.removeChild({ parentCode: req.params.code, childCode: req.params.child }, { author: getAuthor(req) });
    res.json({ ok: true });
  }, () => 400));

  router.get("/items/:code/children", route(async (req, res) => {
    res.json(await store.listChildren(req.params.code));
  }));

  // ── Evidence ──

  router.post("/items/:code/evidence", upload.single("file"), route(async (req, res) => {
    const evidence = await store.attachEvidence({
      itemCode: req.params.code,
      side: req.body.side || "general",
      kind: req.file ? "file" : (req.body.url ? "link" : "note"),
      filePath: req.file?.path || undefined,
      url: req.body.url || undefined,
      note: req.body.note || undefined,
      supplier: req.body.supplier || undefined,
      originalFilename: req.file?.originalname || req.body.original_filename || undefined,
      mimeType: req.file?.mimetype || req.body.mime_type || undefined,
    }, { author: getAuthor(req), dataDir });
    res.status(201).json(evidence);
  }, () => 400));

  router.get("/items/:code/evidence", route(async (req, res) => {
    res.json(await store.listEvidence(req.params.code, { side: req.query.side || undefined }));
  }));

  router.delete("/evidence/:id", route(async (req, res) => {
    await store.removeEvidence(Number(req.params.id), { dataDir });
    res.json({ ok: true });
  }, () => 400));

  // ── History ──

  router.get("/items/:code/history", route(async (req, res) => {
    res.json(await store.getItemHistory(req.params.code, {
      limit: Number(req.query.limit) || 100,
      offset: Number(req.query.offset) || 0,
    }));
  }));

  router.get("/snapshot", route(async (req, res) => {
    if (req.query.at) {
      res.json(await store.getCatalogAtPointInTime(req.query.at));
    } else {
      res.json(await store.listItems({ status: "active" }));
    }
  }));

  router.get("/price-maps", route(async (_req, res) => {
    res.json(await store.getPriceMaps());
  }));

  // ── Categories ──

  router.get("/categories", route(async (_req, res) => {
    res.json(await store.listCategories());
  }));

  router.post("/categories", route(async (req, res) => {
    res.status(201).json(await store.createCategory({ name: req.body?.name }));
  }, () => 400));

  router.post("/categories/reorder", route(async (req, res) => {
    res.json(await store.reorderCategories(req.body?.ids));
  }, () => 400));

  router.patch("/categories/:id", route(async (req, res) => {
    res.json(await store.updateCategory(req.params.id, { name: req.body?.name }));
  }, () => 400));

  router.delete("/categories/:id", route(async (req, res) => {
    await store.deleteCategory(req.params.id);
    res.json({ ok: true });
  }, () => 400));

  return router;
}
