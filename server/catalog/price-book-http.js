// HTTP for the price book, mounted under /api/price-catalog by
// createPriceCatalogRouter: the grid, bulk edits, suppliers and their item
// links, and supplier price-list imports. Errors are the catalogue's typed
// { error, code, path } bodies.
import { Router } from "express";
import multer from "multer";
import { CatalogError } from "./errors.js";
import { PRICE_LIST_MAX_BYTES } from "./csv.js";
import {
  applyBulk,
  createSupplier,
  listItemSuppliers,
  listPriceBook,
  listSuppliers,
  previewBulk,
  removeItemSupplier,
  updateSupplier,
  upsertItemSupplier,
} from "./price-book.js";
import { applyImport, discardImport, getImport, inspectPriceList, listImports, stageImport } from "./price-import.js";

function fileBytes(req) {
  if (req.file?.buffer) return { bytes: req.file.buffer, fileName: req.file.originalname || null };
  // JSON alternative for scripts and agents: { csv: "<text>", file_name }.
  if (typeof req.body?.csv === "string") return { bytes: Buffer.from(req.body.csv, "utf8"), fileName: req.body.file_name || null };
  throw new CatalogError("INVALID", "Attach the price list as `file` (multipart) or send its text as `csv`", { path: "file" });
}

function jsonField(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    throw new CatalogError("INVALID", `${field} must be JSON`, { path: field });
  }
}

/**
 * `route(handler, fallbackStatus)` and `getAuthor(req)` come from the
 * catalogue router so errors and authorship read the same everywhere.
 */
export function createPriceBookRouter({ store, catalogId, route, getAuthor }) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PRICE_LIST_MAX_BYTES, files: 1 } });
  const single = (req, res, next) => upload.single("file")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? `The price list is larger than ${PRICE_LIST_MAX_BYTES / (1024 * 1024)} MB` : err.message;
    return res.status(400).json({ error: message, code: "INVALID", path: "file" });
  });

  // ── Grid ──
  router.get("/grid", route(async (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.json(await listPriceBook(store, req.query));
  }));

  router.post("/bulk/preview", route(async (req, res) => {
    res.json(await previewBulk(store, { uids: req.body?.uids, op: req.body?.op, catalogId }));
  }, () => 400));

  router.post("/bulk/apply", route(async (req, res) => {
    const expectedVersions = req.body?.expectedVersions;
    if (!expectedVersions || typeof expectedVersions !== "object" || Array.isArray(expectedVersions)) {
      throw new CatalogError("INVALID", "Send expectedVersions ({ uid: version }) from the preview", { path: "expectedVersions" });
    }
    res.json(await applyBulk(store, {
      uids: req.body?.uids,
      op: req.body?.op,
      expectedVersions,
      catalogId,
      author: getAuthor(req),
      reason: typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : null,
    }));
  }, () => 400));

  // ── Suppliers ──
  router.get("/suppliers", route(async (req, res) => {
    res.json(await listSuppliers(store, { includeArchived: req.query.status === "all" }));
  }));

  router.post("/suppliers", route(async (req, res) => {
    res.status(201).json(await createSupplier(store, req.body || {}));
  }, () => 400));

  router.patch("/suppliers/:uid", route(async (req, res) => {
    const supplier = await updateSupplier(store, req.params.uid, req.body || {});
    if (!supplier) return res.status(404).json({ error: "not found" });
    res.json(supplier);
  }, () => 400));

  router.get("/items/:code/suppliers", route(async (req, res) => {
    const links = await listItemSuppliers(store, req.params.code);
    if (!links) return res.status(404).json({ error: "not found" });
    res.json(links);
  }));

  router.post("/items/:code/suppliers", route(async (req, res) => {
    const links = await upsertItemSupplier(store, req.params.code, req.body || {}, { author: getAuthor(req) });
    if (!links) return res.status(404).json({ error: "not found" });
    res.json(links);
  }, () => 400));

  router.delete("/items/:code/suppliers/:id", route(async (req, res) => {
    const links = await removeItemSupplier(store, req.params.code, req.params.id, { author: getAuthor(req) });
    if (!links) return res.status(404).json({ error: "not found" });
    res.json(links);
  }, () => 400));

  // ── Supplier price-list imports ──
  router.post("/imports/inspect", single, route(async (req, res) => {
    const { bytes } = fileBytes(req);
    res.json(await inspectPriceList(store, { bytes, supplierUid: req.body?.supplier_uid || null }));
  }, () => 400));

  router.get("/imports", route(async (req, res) => {
    res.json(await listImports(store, { status: req.query.status || null }));
  }));

  router.post("/imports", single, route(async (req, res) => {
    const { bytes, fileName } = fileBytes(req);
    const staged = await stageImport(store, {
      supplierUid: req.body?.supplier_uid,
      bytes,
      fileName,
      columnMap: jsonField(req.body?.column_map, "column_map"),
      effectiveFrom: req.body?.effective_from || null,
      author: getAuthor(req),
    });
    res.status(201).json(staged);
  }, () => 400));

  router.get("/imports/:uid", route(async (req, res) => {
    const record = await getImport(store, req.params.uid, { match: req.query.match || null });
    if (!record) return res.status(404).json({ error: "not found" });
    res.json(record);
  }));

  router.post("/imports/:uid/apply", route(async (req, res) => {
    res.json(await applyImport(store, req.params.uid, { decisions: req.body?.decisions || null, author: getAuthor(req) }));
  }, () => 400));

  router.post("/imports/:uid/discard", route(async (req, res) => {
    res.json(await discardImport(store, req.params.uid, { author: getAuthor(req) }));
  }, () => 400));

  return router;
}
