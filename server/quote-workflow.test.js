import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getEvidenceIndex } from "./evidence-index.js";
import { getLedger, registerRawFile, storeRawFile } from "./ingestion-ledger.js";
import { runAtomicJobGeneration } from "./job-generation.js";
import { refreshQuoteCatalogAuthority } from "./quote-catalogs.js";
import { readQuoteLifecycle, recordQuoteLanded, recordQuoteSent } from "./quote-lifecycle.js";
import {
  allocateQuoteNumber,
  buildAndPersistQuote,
  buildQuoteInStagedGeneration,
  preflightQuotePricingAuthority,
  resolveBaselineQuoteForRebuild,
} from "./quote-workflow.js";
import { closeTestPriceCatalogs, createTestPriceCatalog, seedCatalogFromPriceMaps } from "./test-price-catalog.js";
import { closeFieldDb, getFieldDb, upsertJob } from "./field-db.js";

const TEST_PRICE_CATALOG = await createTestPriceCatalog({ track: false });
const TEST_PRICE_CATALOG_DB = TEST_PRICE_CATALOG.store;
test.after(() => TEST_PRICE_CATALOG.close());

function drainageFixture({ id, title, pipelineStage = "draft" }) {
  return {
    meta: {
      id,
      createdAt: "2026-03-26T09:15:00.000Z",
      title,
      label: title,
      outputMode: "quote",
      quoteCatalogId: "default",
      pipelineStage,
    },
    transcript: {
      fullText: "Install twelve metres of drainage.",
      speakers: ["Operator"],
      cleaned: {
        title,
        cleanedText: "Operator: Install twelve metres of drainage.",
        turns: [
          { speaker: "Operator", text: "Install twelve metres of drainage." },
        ],
      },
      segments: [],
    },
    quoteInputs: {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage installation for one run.",
      assumptions: [],
      jobScope: {
        customerGoal: "Drain water away from the site.",
        workSummary: "Install a drainage run.",
        siteContext: "Residential block.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          confidence: 0.97,
          rationale: "Measured run length was stated explicitly.",
          section: "Drainage",
          evidence: [],
        },
      ],
    },
  };
}

test("buildAndPersistQuote refreshes local price catalog authority and preserves quote-stage rate overrides", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-"));
  const dataDir = await mkdtemp(join(tmpdir(), "field-price-catalog-"));
  const db = (await createTestPriceCatalog({ priceMaps: null })).store;
  await seedCatalogFromPriceMaps(db, {
    buyMap: {
      drainage: 120,
      "LABOURER-HOUR": 50,
      "ADMIN-FEE": 200,
      "VEHICLE-HOUR": 45,
      "DRAIN-PIPE-M": 14,
      "DRAIN-PIT": 95,
      "DRAIN-GRAVEL-M": 11,
      "clean-fill-disposal": 9,
      "EXCAVATOR-HOUR": 180,
      "site-establishment": 150,
      cleanup: 120,
    },
    sellMap: {
      drainage: 210,
      "LABOURER-HOUR": 80,
      "ADMIN-FEE": 300,
      "VEHICLE-HOUR": 75,
      "DRAIN-PIPE-M": 22,
      "DRAIN-PIT": 145,
      "DRAIN-GRAVEL-M": 18,
      "clean-fill-disposal": 14,
      "EXCAVATOR-HOUR": 300,
      "site-establishment": 180,
      cleanup: 150,
    },
  });
  const fetchCalls = [];

  t.mock.method(globalThis, "fetch", async (input) => {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : input.url);
    fetchCalls.push(url.toString());
    throw new Error(`Unexpected network fetch: ${url}`);
  });

  try {
    const meta = {
      id: "quote-workflow-test",
      createdAt: "2026-03-26T09:15:00.000Z",
      title: "Workflow Authority Test",
      label: "Workflow Authority Test",
      outputMode: "quote",
      quoteCatalogId: "default",
      pipelineStage: "draft",
    };

    const transcript = {
      fullText: "Install twelve metres of drainage.",
      speakers: ["Operator"],
      cleaned: {
        title: "Workflow Authority Test",
        cleanedText: "Operator: Install twelve metres of drainage.",
        turns: [
          { speaker: "Operator", text: "Install twelve metres of drainage." },
        ],
      },
      segments: [
        {
          segmentId: "S001",
          speaker: "Operator",
          text: "Install twelve metres of drainage.",
          start: 0,
          end: 4.2,
        },
      ],
    };

    const quoteInputs = {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage installation for one run.",
      assumptions: [],
      jobScope: {
        customerGoal: "Drain water away from the site.",
        workSummary: "Install a drainage run.",
        siteContext: "Residential block.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 12,
          unit: "lm",
          confidence: 0.97,
          rationale: "Measured run length was stated explicitly.",
          section: "Drainage",
          evidence: [],
        },
      ],
    };

    const result = await buildAndPersistQuote({
      jobDir,
      meta,
      transcript,
      quoteInputs,
      overrides: {
        lineItems: {
          "drainage__section-drainage": {
            unitPrice: 240,
          },
        },
      },
      config: {
        operatorName: "Test Operator",
        priceCatalog: db,
      },
      buildReason: "test_runtime_authority_refresh",
    });

    const drainageLine = result.quote.lineItems.find((item) => item.code === "drainage__section-drainage");
    assert.ok(drainageLine);
    assert.equal(result.quote.pricing.authorityProvider, "price_catalog");
    assert.equal(result.quote.pricing.displayable, true);
    assert.equal(result.quote.pricing.sendable, true);
    assert.equal(result.quote.pricing.attestation?.status, "verified");
    assert.equal(result.quote.pricing.attestation?.requestNonce, result.quote.pricing.attestation?.verifiedNonce);
    assert.equal(result.quote.pricing.blockingReason || null, null);
    assert.equal(result.quote.commercialAuthority?.provider, "price_catalog");
    assert.equal(result.quote.quoteCatalog?.commercialAuthority?.provider, "price_catalog");
    assert.equal(drainageLine.unitPrice, 240);
    assert.match(drainageLine.manualOverride?.summary || "", /rate changed to \$240\.00/i);

    const evidencePack = JSON.parse(await readFile(join(jobDir, "evidence-pack.json"), "utf8"));
    const breakdownSource = JSON.parse(await readFile(join(jobDir, "quote-breakdown-source.json"), "utf8"));
    assert.equal(evidencePack.quoteCatalog?.commercialAuthority?.provider, "price_catalog");
    assert.equal(breakdownSource.kind, "quote-breakdown-source");
    assert.equal(breakdownSource.evidence.lineItemCandidateCount, 1);
    assert.equal(result.quote.breakdownSource?.kind, "quote-breakdown-source");

    assert.deepEqual(fetchCalls, []);
  } finally {
    await closeTestPriceCatalogs();
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await rm(jobDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("buildAndPersistQuote uses price catalog as the live pricing authority when available", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-catalog-"));
  const dataDir = await mkdtemp(join(tmpdir(), "field-price-catalog-"));
  const db = (await createTestPriceCatalog({ priceMaps: null })).store;
  await seedCatalogFromPriceMaps(db, {
    buyMap: {
      drainage: 120,
      "LABOURER-HOUR": 50,
      "ADMIN-FEE": 200,
      "VEHICLE-HOUR": 45,
      "DRAIN-PIPE-M": 14,
      "DRAIN-PIT": 95,
      "DRAIN-GRAVEL-M": 11,
      "clean-fill-disposal": 9,
      "EXCAVATOR-HOUR": 180,
      "site-establishment": 150,
      cleanup: 120,
    },
    sellMap: {
      drainage: 210,
      "LABOURER-HOUR": 80,
      "ADMIN-FEE": 300,
      "VEHICLE-HOUR": 75,
      "DRAIN-PIPE-M": 22,
      "DRAIN-PIT": 145,
      "DRAIN-GRAVEL-M": 18,
      "clean-fill-disposal": 14,
      "EXCAVATOR-HOUR": 300,
      "site-establishment": 180,
      cleanup: 150,
    },
    author: "test",
  });

  t.mock.method(globalThis, "fetch", async (input) => {
    throw new Error(`Unexpected network fetch during price catalog build: ${String(input)}`);
  });

  try {
    const result = await buildAndPersistQuote({
      jobDir,
      meta: {
        id: "quote-workflow-price-catalog",
        createdAt: "2026-04-04T09:15:00.000Z",
        title: "Workflow Catalog Test",
        label: "Workflow Catalog Test",
        outputMode: "quote",
        quoteCatalogId: "default",
        pipelineStage: "draft",
      },
      transcript: {
        fullText: "Install twelve metres of drainage.",
        speakers: ["Operator"],
        cleaned: {
          title: "Workflow Catalog Test",
          cleanedText: "Operator: Install twelve metres of drainage.",
          turns: [
            { speaker: "Operator", text: "Install twelve metres of drainage." },
          ],
        },
        segments: [],
      },
      quoteInputs: {
        recordingIntent: "job-scope",
        reviewStatus: "ready",
        summary: "Drainage installation for one run.",
        assumptions: [],
        jobScope: {
          customerGoal: "Drain water away from the site.",
          workSummary: "Install a drainage run.",
          siteContext: "Residential block.",
        },
        missingInputs: [],
        processReferences: [],
        siteConstraints: [],
        measurements: [],
        lineItemCandidates: [
          {
            quoteCatalogItemCode: "drainage",
            label: "Drainage installation",
            quantity: 12,
            unit: "lm",
            confidence: 0.97,
            rationale: "Measured run length was stated explicitly.",
            section: "Drainage",
            evidence: [],
          },
        ],
      },
      config: {
        operatorName: "Test Operator",
        priceCatalog: db,
      },
      buildReason: "test_price_catalog_authority",
    });

    assert.equal(result.quote.pricing.authorityProvider, "price_catalog");
    assert.equal(result.quote.commercialAuthority?.provider, "price_catalog");
    assert.equal(result.quote.quoteCatalog?.commercialAuthority?.provider, "price_catalog");
    assert.equal(result.quote.pricing.attestation?.status, "verified");
  } finally {
    await closeTestPriceCatalogs();
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await rm(jobDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("buildAndPersistQuote refuses unavailable pricing before mutating an issued landed quote", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-unavailable-landed-"));
  const artifacts = {
    "quote.json": Buffer.from("{\"version\":1,\"totals\":{\"total\":250}}"),
    "quote.md": Buffer.from("# Issued quote\n\nTotal: $250.00"),
    "quote.pdf": Buffer.from("issued-pdf-bytes"),
    "report.md": Buffer.from("# Issued report\n\nTotal: $250.00"),
    "meta.json": Buffer.from("{\"pipelineStage\":\"landed\",\"quoteVersion\":1}"),
    "quote-lifecycle.json": Buffer.from("{\"lastSentQuoteVersion\":1}"),
    "quote-inputs.json": Buffer.from("{\"summary\":\"Issued scope\"}"),
    "evidence-pack.json": Buffer.from("{\"version\":1}"),
    "quote-breakdown-source.json": Buffer.from("{\"version\":1}"),
  };

  try {
    for (const [fileName, payload] of Object.entries(artifacts)) {
      await writeFile(join(jobDir, fileName), payload);
    }
    const beforeEntries = (await readdir(jobDir, { recursive: true })).sort();

    await assert.rejects(
      buildAndPersistQuote({
        jobDir,
        meta: {
          id: "quote-workflow-unavailable-landed",
          createdAt: "2026-03-26T09:15:00.000Z",
          title: "Unavailable Landed Quote",
          label: "Unavailable Landed Quote",
          outputMode: "quote",
          quoteCatalogId: "default",
          pipelineStage: "landed",
          quoteVersion: 1,
        },
        transcript: { fullText: "Install drainage." },
        quoteInputs: { summary: "Replacement scope" },
        config: { operatorName: "Test Operator", priceCatalog: null },
        buildReason: "test_price_catalog_unavailable_landed",
      }),
      (error) => {
        assert.equal(error.code, "FIELD_PRICE_CATALOG_UNAVAILABLE");
        assert.equal(error.statusCode, 503);
        assert.match(error.message, /commercial pricing is unavailable/i);
        return true;
      },
    );

    for (const [fileName, payload] of Object.entries(artifacts)) {
      assert.deepEqual(
        await readFile(join(jobDir, fileName)),
        payload,
        `${fileName} must remain byte-identical when pricing is unavailable`,
      );
    }
    assert.deepEqual(
      (await readdir(jobDir, { recursive: true })).sort(),
      beforeEntries,
      "no quote, lifecycle, metadata, input, or evidence paths may be created",
    );
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("quote-input command preflight rejects before an issued context can fork or replace inputs", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-command-preflight-"));
  const artifacts = {
    "quote.json": Buffer.from("{\"version\":1,\"totals\":{\"total\":250}}"),
    "quote.md": Buffer.from("# Issued quote\n\nTotal: $250.00"),
    "quote.pdf": Buffer.from("issued-pdf-bytes"),
    "report.md": Buffer.from("# Issued report\n\nTotal: $250.00"),
    "meta.json": Buffer.from("{\"pipelineStage\":\"landed\",\"quoteVersion\":1}"),
    "quote-lifecycle.json": Buffer.from("{\"lastSentQuoteVersion\":1}"),
    "quote-inputs.json": Buffer.from("{\"summary\":\"Issued scope\"}"),
  };
  const replacementInputs = {
    lineItemCandidates: [{ quoteCatalogItemCode: "drainage", quantity: 12 }],
  };

  try {
    for (const [fileName, payload] of Object.entries(artifacts)) {
      await writeFile(join(jobDir, fileName), payload);
    }
    const beforeEntries = (await readdir(jobDir, { recursive: true })).sort();
    let contextMutationStarted = false;

    await assert.rejects(
      (async () => {
        // This is the command order used by PUT /api/jobs/:id/quote-inputs:
        // preflight first, then ensureEditableQuoteVersionForContextMutation,
        // then replace quote-inputs.json and invoke the defensive builder.
        await preflightQuotePricingAuthority({ priceCatalog: null });
        contextMutationStarted = true;
        await writeFile(
          join(jobDir, "quote-inputs.json"),
          JSON.stringify(replacementInputs, null, 2),
        );
      })(),
      (error) => {
        assert.equal(error.code, "FIELD_PRICE_CATALOG_UNAVAILABLE");
        assert.equal(error.statusCode, 503);
        assert.match(error.message, /commercial pricing is unavailable/i);
        return true;
      },
    );

    assert.equal(contextMutationStarted, false, "issued context must not fork or write before the preflight");
    for (const [fileName, payload] of Object.entries(artifacts)) {
      assert.deepEqual(
        await readFile(join(jobDir, fileName)),
        payload,
        `${fileName} must remain byte-identical when the command preflight rejects`,
      );
    }
    assert.deepEqual(
      (await readdir(jobDir, { recursive: true })).sort(),
      beforeEntries,
      "the rejected command must not create a fork or replacement context",
    );
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("buildAndPersistQuote refuses unavailable pricing for a fresh draft without creating quote artifacts", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-unavailable-draft-"));

  try {
    await assert.rejects(
      buildAndPersistQuote({
        jobDir,
        meta: {
          id: "quote-workflow-unavailable-draft",
          createdAt: "2026-03-26T09:15:00.000Z",
          title: "Unavailable Draft Quote",
          label: "Unavailable Draft Quote",
          outputMode: "quote",
          quoteCatalogId: "default",
          pipelineStage: "draft",
        },
        transcript: { fullText: "Install drainage." },
        quoteInputs: { summary: "Draft scope" },
        config: { operatorName: "Test Operator" },
        buildReason: "test_price_catalog_unavailable_draft",
      }),
      (error) => {
        assert.equal(error.statusCode, 503);
        assert.match(error.message, /commercial pricing is unavailable/i);
        return true;
      },
    );
    assert.deepEqual(await readdir(jobDir), []);
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("staged quote rebuild leaves issued state byte-identical when a later build step fails", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-atomic-failure-"));
  const fixture = drainageFixture({
    id: "quote-workflow-atomic-failure",
    title: "Atomic failure",
    pipelineStage: "landed",
  });
  const artifacts = {
    "quote.json": Buffer.from("{\"version\":1,\"totals\":{\"total\":250}}"),
    "quote.md": Buffer.from("# Issued quote\n\nTotal: $250.00"),
    "quote.pdf": Buffer.from("issued-pdf-bytes"),
    "report.md": Buffer.from("# Issued report\n\nTotal: $250.00"),
    "meta.json": Buffer.from("{\"pipelineStage\":\"landed\",\"quoteVersion\":1}"),
    "quote-lifecycle.json": Buffer.from("{\"lastSentQuoteVersion\":1}"),
    "quote-inputs.json": Buffer.from("{\"summary\":\"Issued scope\"}"),
  };

  try {
    for (const [fileName, payload] of Object.entries(artifacts)) {
      await writeFile(join(jobDir, fileName), payload);
    }
    const beforeEntries = (await readdir(jobDir, { recursive: true })).sort();
    const config = {
      priceCatalog: TEST_PRICE_CATALOG_DB,
      get operatorName() {
        throw new Error("injected later build failure");
      },
    };

    await assert.rejects(
      buildAndPersistQuote({
        jobDir,
        ...fixture,
        config,
        buildReason: "test_atomic_later_failure",
      }),
      /injected later build failure/,
    );

    for (const [fileName, payload] of Object.entries(artifacts)) {
      assert.deepEqual(
        await readFile(join(jobDir, fileName)),
        payload,
        `${fileName} must remain unchanged when the staged build fails`,
      );
    }
    assert.deepEqual((await readdir(jobDir, { recursive: true })).sort(), beforeEntries);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("refreshQuoteCatalogAuthority fails closed when local price catalog pricing is required", async () => {
  try {
    await assert.rejects(
      refreshQuoteCatalogAuthority({ priceCatalog: null, required: true }),
      (error) => {
        assert.equal(error?.statusCode, 503);
        assert.match(error?.message || "", /price catalog/i);
        return true;
      }
    );
  } finally {
    await refreshQuoteCatalogAuthority({ priceCatalog: null, required: false });
  }
});

test("buildAndPersistQuote leaves pending photo evidence uninterpreted and calls no model", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-ingest-"));
  const fetchCalls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    fetchCalls.push(String(input instanceof URL ? input : (typeof input === "string" ? input : input.url)));
    throw new Error("Field must not call a model or any network service while building a quote");
  });

  try {
    const transcript = {
      fullText: "Install drainage and tidy the rear yard.",
      speakers: ["Operator"],
      cleaned: {
        title: "Image Ingestion Quote",
        cleanedText: "Operator: Install drainage and tidy the rear yard.",
        turns: [
          { speaker: "Operator", text: "Install drainage and tidy the rear yard." },
        ],
      },
      segments: [],
    };

    const quoteInputs = {
      recordingIntent: "job-scope",
      reviewStatus: "ready",
      summary: "Drainage works with rear yard tidy up.",
      assumptions: [],
      jobScope: {
        customerGoal: "Stabilize the rear yard.",
        workSummary: "Drainage and yard tidy.",
        siteContext: "Residential site.",
      },
      missingInputs: [],
      processReferences: [],
      siteConstraints: [],
      measurements: [],
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "drainage",
          label: "Drainage installation",
          quantity: 8,
          unit: "lm",
          confidence: 0.9,
          rationale: "Stated in the transcript.",
          section: "Drainage",
          evidence: [],
        },
      ],
    };

    const storedImage = await storeRawFile({
      jobDir,
      category: "images",
      fileName: "rear-yard.jpg",
      buffer: Buffer.from("fake-image"),
    });
    const imageFileId = await registerRawFile({
      jobDir,
      filePath: storedImage.relativePath,
      fileName: storedImage.fileName,
      mimeType: "image/jpeg",
      sizeBytes: 10,
      uploadedBy: "samuel",
    });

    await buildAndPersistQuote({
      jobDir,
      meta: {
        id: "quote-workflow-image-ingest",
        createdAt: "2026-03-26T09:15:00.000Z",
        title: "Image Ingestion Quote",
        label: "Image Ingestion Quote",
        outputMode: "quote",
        quoteCatalogId: "default",
        pipelineStage: "draft",
      },
      transcript,
      quoteInputs,
      config: {
        operatorName: "Test Operator",
        priceCatalog: TEST_PRICE_CATALOG_DB,
      },
      provenance: {
        agentTool: "codex",
        llmEngine: "gpt-4o",
        agentSessionId: "session-quote-ingest",
      },
      buildReason: "test_image_ingestion_before_quote",
    });

    const persisted = await readFile(join(jobDir, "quote.json"), "utf8");
    assert.ok(JSON.parse(persisted).lineItems.length > 0);

    const ledger = await getLedger({ jobDir });
    const imageEntry = ledger.files.find((file) => file.fileId === imageFileId);
    assert.notEqual(imageEntry?.ingested, true);
    assert.deepEqual(fetchCalls, []);

    const evidenceIndex = await getEvidenceIndex({ jobDir });
    assert.equal(
      evidenceIndex.artifacts.some((artifact) => String(artifact.artifactId).startsWith("site-conditions.json")),
      false,
    );
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("resolveBaselineQuoteForRebuild prefers the last customer-seen snapshot over the current draft", async () => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-baseline-"));

  try {
    await writeFile(join(jobDir, "quote.json"), JSON.stringify({
      version: 2,
      summary: "Current degraded draft",
    }, null, 2));
    await writeFile(join(jobDir, "quote.md"), "Current degraded draft");

    const versionDir = join(jobDir, "quote-versions", "v001");
    await mkdir(versionDir, { recursive: true });
    await writeFile(join(versionDir, "quote.json"), JSON.stringify({
      version: 1,
      summary: "Customer-seen baseline",
    }, null, 2));
    await writeFile(join(versionDir, "quote.md"), "Customer-seen baseline");

    const baseline = await resolveBaselineQuoteForRebuild({
      jobDir,
      currentArtifacts: {
        quote: {
          version: 2,
          summary: "Current degraded draft",
        },
      },
      currentVersion: 2,
      historicalCustomerSeenVersion: 1,
    });

    assert.equal(baseline?.version, 1);
    assert.equal(baseline?.summary, "Customer-seen baseline");
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

// A landed job's quote is revised via a two-call sequence — a
// force-fork call (creating a new draft version off the sent version), then
// a second buildAndPersistQuote call against the just-forked meta that no
// longer needs to fork (it's already past the last-sent version). That
// second call must not mistake "this call didn't fork" for "this job was
// never sent" and silently reset it to draft.
test("buildAndPersistQuote preserves landed delivery state across a non-forking rebuild of an already-forked draft", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-landed-"));

  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });

  try {
    const fixture = drainageFixture({
      id: "quote-workflow-landed-preserve",
      title: "Landed Preservation Test",
    });

    const initial = await buildAndPersistQuote({
      jobDir,
      ...fixture,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "test_initial_build",
    });
    assert.equal(initial.quote.version, 1);
    assert.equal(initial.meta.pipelineStage, "draft");

    // Simulate the job having been sent and landed (recorded via the
    // lifecycle helpers the real send/land actions use), independent of
    // buildAndPersistQuote.
    const sentAt = "2026-03-27T00:00:00.000Z";
    const landedAt = "2026-03-28T00:00:00.000Z";
    await runAtomicJobGeneration(jobDir, async (stagedJobDir) => {
      await recordQuoteSent({
        jobDir: stagedJobDir,
        meta: initial.meta,
        quoteVersion: 1,
        to: "customer@example.com",
      });
      await recordQuoteLanded({
        jobDir: stagedJobDir,
        meta: { ...initial.meta, quoteSentAt: sentAt, pipelineStage: "sent" },
        landedAt,
      });
    });
    const invoiceSentAt = "2026-03-29T00:00:00.000Z";
    const landedMeta = {
      ...initial.meta,
      pipelineStage: "landed",
      deliveryStatus: "landed",
      quoteSentAt: sentAt,
      landedAt,
      invoiceSentAt,
      invoicePaidAmount: 150,
    };

    // Call 1: the force-fork, mirroring
    // ensureEditableQuoteVersionForContextMutation's call into
    // regenerateRecordingQuote(forceForkSentQuote: true) in server/index.js.
    const forked = await buildAndPersistQuote({
      jobDir,
      meta: landedMeta,
      transcript: fixture.transcript,
      quoteInputs: fixture.quoteInputs,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      forkSentQuote: true,
      buildReason: "quote_context_seed",
    });
    assert.equal(forked.quote.version, 2, "fork should create a new draft version");
    assert.equal(forked.meta.pipelineStage, "landed", "the forking call already preserved landed state");
    assert.equal(forked.meta.landedAt, landedAt);
    assert.equal(forked.meta.invoiceSentAt, invoiceSentAt);
    assert.equal(forked.meta.invoicePaidAmount, 150);

    const lifecycleAfterFork = await readQuoteLifecycle(jobDir);
    assert.equal(lifecycleAfterFork.lastSentQuoteVersion, 1, "the customer-seen version must still be v1");

    // Call 2: the same operation's second buildAndPersistQuote call,
    // mirroring the PUT /api/jobs/:id/quote-inputs handler
    // (server/index.js:4566), which rebuilds against the meta it just got
    // back from call 1 without passing forkSentQuote. Version 2 is already
    // past the last-sent version (1), so this correctly computes "no fork
    // needed" -- that must not be misread as "reset to draft".
    const rebuilt = await buildAndPersistQuote({
      jobDir,
      meta: forked.meta,
      transcript: fixture.transcript,
      quoteInputs: fixture.quoteInputs,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "set_quote_inputs",
    });

    assert.equal(rebuilt.quote.version, 2, "second call should not fork again");
    assert.equal(rebuilt.meta.pipelineStage, "landed");
    assert.equal(rebuilt.meta.deliveryStatus, "landed");
    assert.equal(rebuilt.meta.quoteSentAt, sentAt);
    assert.equal(rebuilt.meta.landedAt, landedAt);
    assert.equal(rebuilt.meta.invoiceSentAt, invoiceSentAt, "invoice progress must survive the rebuild too");
    assert.equal(rebuilt.meta.invoicePaidAmount, 150);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("buildAndPersistQuote still zeroes invoice progress for a genuinely draft job (no invoice has ever been sent)", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-invoice-draft-"));

  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });

  try {
    const fixture = drainageFixture({
      id: "quote-workflow-invoice-draft",
      title: "Invoice Draft Test",
    });

    const initial = await buildAndPersistQuote({
      jobDir,
      ...fixture,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "test_initial_build",
    });

    assert.equal(initial.meta.invoiceSentAt, null);
    assert.equal(initial.meta.invoicePaidAmount, 0);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("buildAndPersistQuote preserves sent delivery state across a non-forking rebuild of an already-forked draft", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-sent-"));

  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });

  try {
    const fixture = drainageFixture({
      id: "quote-workflow-sent-preserve",
      title: "Sent Preservation Test",
    });

    const initial = await buildAndPersistQuote({
      jobDir,
      ...fixture,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "test_initial_build",
    });

    const sentAt = "2026-03-27T00:00:00.000Z";
    await runAtomicJobGeneration(jobDir, (stagedJobDir) => recordQuoteSent({
      jobDir: stagedJobDir,
      meta: initial.meta,
      quoteVersion: 1,
      to: "customer@example.com",
    }));
    const sentMeta = {
      ...initial.meta,
      pipelineStage: "sent",
      deliveryStatus: "sent",
      quoteSentAt: sentAt,
    };

    const forked = await buildAndPersistQuote({
      jobDir,
      meta: sentMeta,
      transcript: fixture.transcript,
      quoteInputs: fixture.quoteInputs,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      forkSentQuote: true,
      buildReason: "quote_context_seed",
    });
    assert.equal(forked.quote.version, 2);
    assert.equal(forked.meta.pipelineStage, "sent");

    const rebuilt = await buildAndPersistQuote({
      jobDir,
      meta: forked.meta,
      transcript: fixture.transcript,
      quoteInputs: fixture.quoteInputs,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "set_quote_inputs",
    });

    assert.equal(rebuilt.quote.version, 2, "second call should not fork again");
    assert.equal(rebuilt.meta.pipelineStage, "sent");
    assert.equal(rebuilt.meta.deliveryStatus, "sent");
    assert.equal(rebuilt.meta.quoteSentAt, sentAt);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

test("buildAndPersistQuote still lands a genuinely draft job's rebuild on draft", async (t) => {
  const jobDir = await mkdtemp(join(tmpdir(), "field-quote-workflow-draft-"));

  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });

  try {
    const fixture = drainageFixture({
      id: "quote-workflow-draft-stays-draft",
      title: "Draft Stays Draft Test",
    });

    const initial = await buildAndPersistQuote({
      jobDir,
      ...fixture,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "test_initial_build",
    });
    assert.equal(initial.meta.pipelineStage, "draft");
    assert.equal(initial.meta.quoteSentAt, null);
    assert.equal(initial.meta.landedAt, null);

    const rebuilt = await buildAndPersistQuote({
      jobDir,
      meta: initial.meta,
      transcript: fixture.transcript,
      quoteInputs: fixture.quoteInputs,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "set_quote_inputs",
    });

    assert.equal(rebuilt.quote.version, 1, "a never-sent draft rebuild does not need to fork");
    assert.equal(rebuilt.meta.pipelineStage, "draft");
    assert.equal(rebuilt.meta.deliveryStatus, "draft");
    assert.equal(rebuilt.meta.quoteSentAt, null);
    assert.equal(rebuilt.meta.landedAt, null);
    assert.equal(rebuilt.meta.lostAt, null);
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("a staged quote build without the job root refuses before writing", async (t) => {
  const stagedJobDir = await mkdtemp(join(tmpdir(), "field-staged-build-"));
  t.after(() => rm(stagedJobDir, { recursive: true, force: true }));
  const fixture = drainageFixture({ id: "job-staged-no-root", title: "Staged without root" });

  await assert.rejects(
    buildQuoteInStagedGeneration({
      jobDir: stagedJobDir,
      meta: fixture.meta,
      transcript: fixture.transcript,
      quoteInputs: fixture.quoteInputs,
      config: { priceCatalog: TEST_PRICE_CATALOG_DB },
    }),
    /requires operationalJobDir or operationalSnapshot/,
  );
  assert.deepEqual(await readdir(stagedJobDir), []);
});

// Quote numbers (EQ-YYMM-NN) are allocated per calendar month across every
// job in the data directory. Each test below uses its own month so numbers
// reserved by one test cannot leak into another.
async function writeJobFixtureMeta(dataDir, dateDir, slug, meta) {
  const jobDir = join(dataDir, dateDir, slug);
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(meta, null, 2));
  return jobDir;
}

test("two quote numbers allocated at the same time for different jobs are distinct", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-quote-number-concurrent-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const createdAt = "2026-01-12T00:00:00.000Z";
  await writeJobFixtureMeta(dataDir, "2026-01-10", "existing", { id: "existing", quoteNumber: "EQ-2601-01" });
  const jobA = await writeJobFixtureMeta(dataDir, "2026-01-12", "job-a", { id: "job-a", createdAt });
  const jobB = await writeJobFixtureMeta(dataDir, "2026-01-12", "job-b", { id: "job-b", createdAt });

  const numbers = await Promise.all([
    allocateQuoteNumber(jobA, createdAt, { jobId: "job-a" }),
    allocateQuoteNumber(jobB, createdAt, { jobId: "job-b" }),
  ]);

  assert.equal(new Set(numbers).size, 2, `expected distinct numbers, got ${numbers.join(", ")}`);
  assert.deepEqual([...numbers].sort(), ["EQ-2601-02", "EQ-2601-03"]);
});

test("a job retrying allocation keeps the number it was already given", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-quote-number-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const createdAt = "2026-02-12T00:00:00.000Z";
  const jobA = await writeJobFixtureMeta(dataDir, "2026-02-12", "job-a", { id: "job-a", createdAt });

  const first = await allocateQuoteNumber(jobA, createdAt, { jobId: "job-a" });
  const retry = await allocateQuoteNumber(jobA, createdAt, { jobId: "job-a" });

  assert.equal(first, "EQ-2602-01");
  assert.equal(retry, first, "a failed build that is retried must not burn a number");
});

test("quote number allocation reads the active generation, not a stale root meta.json", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-quote-number-stale-root-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const createdAt = "2026-04-12T00:00:00.000Z";
  const issuedJob = await writeJobFixtureMeta(dataDir, "2026-04-02", "issued", { id: "issued", createdAt });
  await runAtomicJobGeneration(issuedJob, async (stagedJobDir) => {
    await writeFile(join(stagedJobDir, "meta.json"), JSON.stringify({
      id: "issued",
      createdAt,
      quoteNumber: "EQ-2604-03",
    }, null, 2));
  });
  // The root copy is only a post-commit projection; simulate it lagging the
  // committed generation.
  await writeFile(join(issuedJob, "meta.json"), JSON.stringify({ id: "issued", createdAt }, null, 2));
  const newJob = await writeJobFixtureMeta(dataDir, "2026-04-12", "new", { id: "new", createdAt });

  assert.equal(await allocateQuoteNumber(newJob, createdAt, { jobId: "new" }), "EQ-2604-04");
});

test("quote number allocation refuses a number field.db records for another job", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-quote-number-db-"));
  t.after(async () => {
    closeFieldDb();
    await rm(dataDir, { recursive: true, force: true });
  });
  const createdAt = "2026-05-12T00:00:00.000Z";
  const db = getFieldDb(dataDir);
  upsertJob(db, {
    id: "indexed-elsewhere",
    dateDir: "2026-05-01",
    dir: join(dataDir, "2026-05-01", "indexed-elsewhere"),
    quoteNumber: "EQ-2605-07",
    createdAt,
  });
  const newJob = await writeJobFixtureMeta(dataDir, "2026-05-12", "new", { id: "new", createdAt });

  assert.equal(await allocateQuoteNumber(newJob, createdAt, { jobId: "new" }), "EQ-2605-08");
});

test("two quotes built at the same time in one month get different quote numbers", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-quote-number-build-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  const builds = ["concurrent-a", "concurrent-b"].map(async (id) => {
    const jobDir = join(dataDir, "2026-03-26", id);
    await mkdir(jobDir, { recursive: true });
    const fixture = drainageFixture({ id, title: `Concurrent ${id}` });
    await writeFile(join(jobDir, "meta.json"), JSON.stringify(fixture.meta, null, 2));
    return buildAndPersistQuote({
      jobDir,
      ...fixture,
      config: { operatorName: "Test Operator", priceCatalog: TEST_PRICE_CATALOG_DB },
      buildReason: "test_initial_build",
    });
  });

  const [first, second] = await Promise.all(builds);

  assert.match(first.meta.quoteNumber, /^EQ-2603-\d{2}$/);
  assert.match(second.meta.quoteNumber, /^EQ-2603-\d{2}$/);
  assert.notEqual(first.meta.quoteNumber, second.meta.quoteNumber);
});
