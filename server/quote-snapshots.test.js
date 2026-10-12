// Quote snapshot rows: what a send records, and the store.
import assert from "node:assert/strict";
import test from "node:test";

import { createTestDb } from "./db-runtime/index.js";
import { openCatalogStore } from "./catalog/index.js";
import { buildQuoteSnapshotRecord, createQuoteSnapshotStore, createUnavailableQuoteSnapshotStore } from "./quote-snapshots.js";

function quoteWithLinkedRow({ itemUid, priceId, priceKey }) {
  return {
    version: 3,
    quoteNumber: "EQ-SNAP-1",
    quoteCatalog: { gstRate: 0.1, currency: "AUD" },
    lineItems: [{ code: "turf", label: "Turf", quantity: 40, unit: "m2", unitPrice: 14, totalPrice: 560, unitCost: 9, totalCost: 360 }],
    pricing: { attestation: { snapshotDigest: "digest-1" } },
    presentation: {
      organizer: {
        root: ["manual:kit", "source:turf"],
        nodes: {
          "source:turf": { kind: "source", origin: "engine", sourceCode: "turf" },
          "manual:kit": {
            kind: "source",
            origin: "manual",
            sourceCode: "manual-kit",
            labelOverride: "Edging",
            quantity: 10,
            unit: "m",
            sellRate: 55,
            buyRate: 30,
            rateMode: "manual",
            collapsed: true,
            catalogItemCode: "EDGING",
            catalogItemUid: itemUid,
            catalogPriceId: priceId,
            catalogPriceKey: priceKey,
            catalogSellRate: 50,
            catalogBuyRate: 30,
            catalogName: "Edging",
            catalogUnit: "m",
          },
        },
      },
      sourceItems: [],
    },
  };
}

test("a snapshot records each row's catalogue uid, price id and frozen values, and the totals sent", async (t) => {
  const handle = await createTestDb();
  t.after(() => handle.close());
  const catalog = await openCatalogStore({ db: handle.db });
  await catalog.createItem({ code: "turf", name: "Turf", unit: "m2", buy_price: 9, sell_price: 14, catalog_type: "goods_service" });
  const state = await catalog.getState();
  const record = buildQuoteSnapshotRecord({
    attemptId: "attempt-1",
    documentType: "quote",
    quoteVersion: 3,
    quote: quoteWithLinkedRow({ itemUid: "itm_edging", priceId: 77, priceKey: "pk_edging" }),
    meta: { id: "job-1" },
    to: "customer@example.invalid",
    cc: [],
    bcc: ["archive@example.invalid"],
    sentBy: { id: "u1", email: "estimator@example.invalid", name: "Estimator", role: "owner" },
    pdfSha256: "a".repeat(64),
    preparedAt: "2026-01-15T00:00:00.000Z",
    catalogState: state,
  });
  assert.equal(record.jobId, "job-1");
  assert.equal(record.documentNumber, "EQ-SNAP-1");
  assert.equal(record.subtotal, 1110);
  assert.equal(record.tax, 111);
  assert.equal(record.total, 1221);
  assert.deepEqual(record.recipients, { to: ["customer@example.invalid"], cc: [], bcc: ["archive@example.invalid"] });
  assert.deepEqual(record.sentBy, { id: "u1", email: "estimator@example.invalid", name: "Estimator" });
  const edging = record.lines.find((line) => line.nodeId === "manual:kit");
  assert.equal(edging.totalPrice, 550);
  assert.deepEqual(edging.catalog, {
    itemUid: "itm_edging",
    code: "EDGING",
    priceId: 77,
    priceKey: "pk_edging",
    assemblyVersion: null,
    componentOf: null,
    priceSource: "line",
    overridden: true,
    frozen: { name: "Edging", unit: "m", sellRate: 50, buyRate: 30, quantity: null },
  });
  const turf = record.lines.find((line) => line.nodeId === "source:turf");
  const turfItem = await catalog.getCurrentPrice("turf");
  assert.deepEqual(turf.lineItems[0].catalog, {
    itemUid: turfItem.itemUid,
    code: "turf",
    priceId: turfItem.priceId,
    priceKey: turfItem.priceKey,
    priceSource: "catalogue_at_send",
  });
  assert.equal(record.pricing.catalogVersion, state.version);
  assert.equal(record.pricing.pricingSnapshotDigest, "digest-1");

  // An engine line priced differently from the current catalogue price has
  // no known price id.
  await catalog.updateItem("turf", { sell_price: 16 });
  const later = buildQuoteSnapshotRecord({
    attemptId: "attempt-2",
    quote: quoteWithLinkedRow({ itemUid: "itm_edging", priceId: 77, priceKey: "pk_edging" }),
    meta: { id: "job-1" },
    to: ["customer@example.invalid"],
    catalogState: await catalog.getState(),
  });
  const laterTurf = later.lines.find((line) => line.nodeId === "source:turf").lineItems[0].catalog;
  assert.equal(laterTurf.priceId, null);
  assert.equal(laterTurf.priceSource, "unknown");

  const store = createQuoteSnapshotStore({ db: handle.db });
  await store.recordPrepared(record);
  await store.recordPrepared(record); // retried: still one row
  let rows = await store.listForJob("job-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "prepared");
  assert.equal(rows[0].total, 1221);
  assert.equal(rows[0].sentAt, null);
  await store.recordSent(record, { sentAt: "2026-01-15T00:01:00.000Z", messageId: "msg-1", threadId: "thread-1", issuanceId: "iss-1" });
  rows = await store.listForJob("job-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "sent");
  assert.equal(rows[0].messageId, "msg-1");
  assert.equal(rows[0].issuanceId, "iss-1");
  assert.equal(rows[0].sentAt, "2026-01-15T00:01:00.000Z");
  assert.equal(rows[0].lines.find((line) => line.nodeId === "manual:kit").catalog.priceId, 77);
});

test("without a database every send is refused", async () => {
  const store = createUnavailableQuoteSnapshotStore("no database configured");
  await assert.rejects(store.recordPrepared({}), { code: "QUOTE_SNAPSHOT_UNAVAILABLE", statusCode: 503 });
  assert.deepEqual(await store.listForJob("job"), []);
});
