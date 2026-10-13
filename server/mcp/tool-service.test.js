import test from "node:test";
import assert from "node:assert/strict";
import { createFieldMcpService, validateToolArguments } from "./tool-service.js";

function fixture() {
  let item = { uid: "u1", code: "A", buy_price: 100, sell_price: 125, children: [{ uid: "u2", code: "B", name: "Bolt" }] };
  let quote = { id: "q1", quote: { lineItems: [] }, presentation: { title: "Keep" } };
  let writes = 0;
  let receivedQuotePatch = null;
  let categories = [{ id: "1", name: "Plant" }];
  let children = [{ code: "B", quantity: 1 }];
  const catalogs = [{ id: "landscaping", name: "Landscaping" }];
  const service = createFieldMcpService({
    listPriceItems: async () => [item],
    getPriceItem: async () => ({ ...item, name: "Alpha", uid: "u1" }),
    updatePriceItem: async (_code, patch) => {
      writes += 1;
      item = { ...item, ...patch };
      return item;
    },
    listQuotes: async () => [quote],
    getQuote: async () => structuredClone({
      ...quote,
      meta: { id: "q1", title: "Keep", status: "draft", siteAddress: "1 Main" },
      quoteEvidencePack: { huge: "x".repeat(1000) },
      transcript: { turns: ["nope"] },
      jobState: { details: { secret: true } },
    }),
    createQuote: async () => {
      writes += 1;
      return { id: "new" };
    },
    updateQuote: async (_id, patch) => {
      writes += 1;
      receivedQuotePatch = patch;
      quote = { ...quote, ...patch };
      return quote;
    },
    recalculateQuote: async () => {
      writes += 1;
      quote = { ...quote, recalculated: true };
      return quote;
    },
    listQuoteCatalogs: async () => catalogs,
    getQuoteCatalog: async (id) => catalogs.find((row) => row.id === id) || null,
    listCategories: async () => categories,
    listChildren: async () => children,
    createCategory: async ({ name }) => {
      writes += 1;
      const created = { id: "2", name };
      categories = [...categories, created];
      return created;
    },
    updateCategory: async () => { writes += 1; return categories[0]; },
    deleteCategory: async () => { writes += 1; categories = []; return { ok: true }; },
    addChild: async () => { writes += 1; return children[0]; },
    updateChild: async () => { writes += 1; return children[0]; },
    removeChild: async () => { writes += 1; children = []; },
  });
  return {
    service,
    get writes() { return writes; },
    get receivedQuotePatch() { return receivedQuotePatch; },
    setItem(value) { item = value; },
  };
}

test("mutations retain dry-run, exact APPLY, race guard, and audit", async () => {
  const f = fixture();
  const preview = await f.service.call("field_price_item_update", { code: "A", sellPrice: 130 });
  assert.equal(preview.dryRun, true);
  assert.equal(f.writes, 0);

  await assert.rejects(
    f.service.call("field_price_item_update", {
      code: "A",
      sellPrice: 130,
      apply: true,
      confirmation: "apply",
      expectedVersion: preview.expectedVersion,
    }),
    (error) => error.code === "confirmation_required",
  );

  f.setItem({ code: "A", buy_price: 100, sell_price: 126 });
  await assert.rejects(
    f.service.call("field_price_item_update", {
      code: "A",
      sellPrice: 130,
      apply: true,
      confirmation: "APPLY",
      expectedVersion: preview.expectedVersion,
    }),
    (error) => error.code === "stale_version",
  );
  assert.equal(f.writes, 0);

  const fresh = await f.service.call("field_price_item_update", { code: "A", sellPrice: 130 });
  const applied = await f.service.call("field_price_item_update", {
    code: "A",
    sellPrice: 130,
    apply: true,
    confirmation: "APPLY",
    expectedVersion: fresh.expectedVersion,
  }, { subject: "u" });
  assert.equal(f.writes, 1);
  assert.equal(applied.audit.before.sell_price, 126);
  assert.equal(applied.audit.after.sell_price, 130);
});

test("quote dry-run is read-only and omitted patch fields remain omitted on apply", async () => {
  const f = fixture();
  const params = { jobId: "q1", patch: { assumptions: { a: true } } };
  const preview = await f.service.call("field_quote_draft_update", params);
  assert.equal(preview.dryRun, true);
  assert.equal(f.writes, 0);

  await f.service.call("field_quote_draft_update", {
    ...params,
    apply: true,
    confirmation: "APPLY",
    expectedVersion: preview.expectedVersion,
  }, { subject: "u" });
  assert.deepEqual(f.receivedQuotePatch, { assumptions: { a: true } });
  assert.equal(Object.hasOwn(f.receivedQuotePatch, "presentation"), false);
  assert.equal(Object.hasOwn(f.receivedQuotePatch, "paymentSchedule"), false);
});

test("tool arguments reject unknown properties, invalid types, and no-op updates", async () => {
  assert.throws(
    () => validateToolArguments("field_quote_get", { jobId: "q1", surprise: true }),
    (error) => error.code === "validation_error",
  );
  assert.throws(
    () => validateToolArguments("field_quote_list", { limit: 0 }),
    (error) => error.code === "validation_error",
  );
  assert.throws(
    () => validateToolArguments("field_price_item_update", { code: "A" }),
    (error) => error.code === "validation_error",
  );
  assert.throws(
    () => validateToolArguments("field_quote_draft_update", { jobId: "q1", patch: {} }),
    (error) => error.code === "validation_error",
  );
});

test("quote list returns an output-schema-compatible record", async () => {
  const f = fixture();
  const result = await f.service.call("field_quote_list", {
    search: "",
    status: "draft",
    limit: 25,
  });
  assert.ok(!Array.isArray(result));
  assert.deepEqual(result, {
    quotes: [{ id: "q1", quote: { lineItems: [] }, presentation: { title: "Keep" } }],
  });
});

test("quote validation stays read-only", async () => {
  const f = fixture();
  assert.equal((await f.service.call("field_quote_validate", { jobId: "q1" })).valid, true);
  assert.equal(f.writes, 0);
});

test("price item list returns an output-schema-compatible record, by uid, with no codes", async () => {
  const f = fixture();
  const result = await f.service.call("field_price_item_list", { search: "A" });
  assert.ok(!Array.isArray(result));
  assert.equal(result.items[0].uid, "u1");
  assert.equal("code" in result.items[0], false);
  assert.deepEqual(result.items[0].children, [{ uid: "u2", name: "Bolt" }]);
});

test("an item is named by uid; the deprecated code argument still works", async () => {
  const f = fixture();
  const byItem = await f.service.call("field_price_item_get", { item: "u1" });
  const byCode = await f.service.call("field_price_item_get", { code: "A" });
  assert.deepEqual(byItem, byCode);
  assert.equal("code" in byItem.item, false);
  assert.throws(() => validateToolArguments("field_price_item_get", {}), /item is required/);
  assert.throws(() => validateToolArguments("field_price_item_update", { buyPrice: 1 }), /item is required/);
  assert.doesNotThrow(() => validateToolArguments("field_catalog_structure_update", { action: "child_add", parentItem: "u1", childItem: "u2" }));
});

test("markup preview uses a single basis instead of XOR percents", async () => {
  const f = fixture();
  assert.throws(
    () => validateToolArguments("field_markup_preview", {
      cost: 100,
      markupPercent: 25,
      marginPercent: 20,
    }),
    (error) => error.code === "validation_error",
  );
  assert.throws(
    () => validateToolArguments("field_markup_preview", { cost: 100 }),
    (error) => error.code === "validation_error",
  );
  const marked = await f.service.call("field_markup_preview", {
    cost: 100,
    basis: "markup",
    percent: 25,
  });
  assert.equal(marked.basis, "markup");
  assert.equal(marked.price, 125);
  const margined = await f.service.call("field_markup_preview", {
    cost: 80,
    basis: "margin",
    percent: 20,
  });
  assert.equal(margined.basis, "margin");
  assert.equal(margined.price, 100);
});

test("quote get defaults to a focused record without evidence payloads", async () => {
  const f = fixture();
  const focused = await f.service.call("field_quote_get", { jobId: "q1" });
  assert.equal(focused.view, "quote");
  assert.equal(focused.jobId, "q1");
  assert.deepEqual(focused.quote, { lineItems: [] });
  assert.equal(Object.hasOwn(focused, "quoteEvidencePack"), false);
  assert.equal(Object.hasOwn(focused, "transcript"), false);
  assert.equal(Object.hasOwn(focused, "jobState"), false);

  const summary = await f.service.call("field_quote_get", { jobId: "q1", view: "summary" });
  assert.equal(summary.view, "summary");
  assert.equal(Object.hasOwn(summary, "quote"), false);

  const full = await f.service.call("field_quote_get", { jobId: "q1", view: "full" });
  assert.equal(full.view, "full");
  assert.equal(full.quoteEvidencePack.huge.length, 1000);
});

test("catalog sidecar reads and guarded structure updates are available", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.call("field_quote_catalog_list", {}), {
    catalogs: [{ id: "landscaping", name: "Landscaping" }],
  });
  const review = await f.service.call("field_pricing_review", { item: "u1" });
  assert.deepEqual(review.item, { uid: "u1", name: "Alpha" });
  assert.equal(review.price, 125);
  assert.deepEqual(await f.service.call("field_catalog_structure", {}), {
    categories: [{ id: "1", name: "Plant" }],
  });
  const preview = await f.service.call("field_catalog_structure_update", {
    action: "category_create",
    name: "Mulch",
  });
  assert.equal(preview.dryRun, true);
  assert.equal(f.writes, 0);
  await f.service.call("field_catalog_structure_update", {
    action: "category_create",
    name: "Mulch",
    apply: true,
    confirmation: "APPLY",
    expectedVersion: preview.expectedVersion,
  }, { subject: "u" });
  assert.equal(f.writes, 1);
});

test("an edit landing between the MCP re-read and its write is refused, not overwritten", async (t) => {
  const { createTestDb } = await import("../db-runtime/index.js");
  const { openCatalogStore } = await import("../catalog/index.js");
  const handle = await createTestDb();
  t.after(() => handle.close());
  const store = await openCatalogStore({ db: handle.db });
  await store.createItem({ code: "A", name: "Alpha", buy_price: 100, sell_price: 125 });
  let interleave = null; // a concurrent HTTP edit, run just before the MCP write
  const service = createFieldMcpService({
    getPriceItem: async (code) => {
      const item = await store.getItem(code);
      return { ...item, children: await store.listChildren(item.uid) };
    },
    updatePriceItem: async (code, patch, actor, { expectedVersion = null } = {}) => {
      if (interleave) await interleave();
      return store.updateItem(code, patch, { author: `oauth:${actor.subject}`, expectedVersion });
    },
    listCategories: async () => store.listCategories(),
    listChildren: async (code) => store.listChildren(code),
    createCategory: async (body, _actor, guard = {}) => {
      if (interleave) await interleave();
      return store.createCategory(body, guard);
    },
    getCatalogVersion: async () => store.catalogVersion(),
  });
  const apply = async (name, params) => {
    const preview = await service.call(name, params);
    return service.call(name, { ...params, apply: true, confirmation: "APPLY", expectedVersion: preview.expectedVersion }, { subject: "u" });
  };

  interleave = async () => { interleave = null; await store.updateItem("A", { sell_price: 140 }, { author: "http" }); };
  await assert.rejects(apply("field_price_item_update", { code: "A", sellPrice: 130 }), (error) => error.code === "stale_version");
  assert.equal((await store.getItem("A")).sell_price, 140, "the concurrent edit stands");
  const applied = await apply("field_price_item_update", { code: "A", sellPrice: 130 });
  assert.equal(applied.audit.after.sell_price, 130);

  interleave = async () => { interleave = null; await store.createCategory({ name: "Plant" }); };
  await assert.rejects(apply("field_catalog_structure_update", { action: "category_create", name: "Mulch" }), (error) => error.code === "stale_version");
  assert.deepEqual((await store.listCategories()).map((row) => row.name), ["Plant"]);
  await apply("field_catalog_structure_update", { action: "category_create", name: "Mulch" });
  assert.deepEqual((await store.listCategories()).map((row) => row.name).sort(), ["Mulch", "Plant"]);
});

test("milestone rules are readable and a job can be checked before issue; rules are not written through MCP", async () => {
  const rules = [{ uid: "mrl_01JAAAAAAAAAAAAAAAAAAAAAAA", name: "SA domestic, under $20,000", caps: [{ kind: "deposit", mode: "hard", maxAmount: 1000, maxPercent: null }] }];
  const service = createFieldMcpService({
    listMilestoneRules: async () => ({ ok: true, rules, version: "1:x", businessRegion: { country: "AU", region: "SA", from: "settings" }, options: {} }),
    checkJobMilestones: async (id) => ({ hasRules: true, rule: rules[0], milestones: [{ milestoneIndex: 0, blocked: id === "job-1" }] }),
  });
  assert.deepEqual(await service.call("field_milestone_rules_list", {}, { subject: "agent" }), { rules, version: "1:x", businessRegion: { country: "AU", region: "SA", from: "settings" } });
  const checked = await service.call("field_milestone_check", { jobId: "job-1" }, { subject: "agent" });
  assert.equal(checked.jobId, "job-1");
  assert.equal(checked.milestones[0].blocked, true);
  assert.throws(() => validateToolArguments("field_milestone_check", {}), /arguments.jobId is required/);
  assert.throws(() => validateToolArguments("field_milestone_rules_update", {}), /Unknown tool/);
  const unavailable = createFieldMcpService({});
  await assert.rejects(unavailable.call("field_milestone_rules_list", {}, { subject: "agent" }), /need the database/);
});
