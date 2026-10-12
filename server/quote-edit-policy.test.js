import assert from "node:assert/strict";
import test from "node:test";

import {
  buildQuoteEditPolicy,
  inferLastSentQuoteVersion,
  resolveCustomerDeliveryQuoteVersion,
  resolveDefaultSelectedQuoteVersion,
  shouldForkQuoteMutation,
} from "./quote-edit-policy.js";

test("buildQuoteEditPolicy locks historical customer-seen versions and exposes the newer draft revision", () => {
  const policy = buildQuoteEditPolicy({
    meta: {
      pipelineStage: "sent",
      quoteVersion: 2,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: {
      currentQuoteVersion: 2,
      lastSentQuoteVersion: 1,
      currentPipelineStage: "sent",
    },
    latestVersion: 2,
    selectedVersion: 1,
  });

  assert.equal(policy.businessStage, "sent");
  assert.equal(policy.lastSentQuoteVersion, 1);
  assert.equal(policy.existingDraftVersion, 2);
  assert.equal(policy.selectedVersionLocked, true);
  assert.equal(policy.latestVersionLocked, false);
  assert.equal(policy.canEditSelectedVersion, false);
  assert.match(policy.lockReason || "", /historical versions are read-only/i);
});

test("shouldForkQuoteMutation only forks when the current latest version is the locked customer-seen version", () => {
  assert.equal(shouldForkQuoteMutation({
    meta: {
      pipelineStage: "sent",
      quoteVersion: 1,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: {
      currentQuoteVersion: 1,
      lastSentQuoteVersion: 1,
    },
    currentQuoteVersion: 1,
  }), true);

  assert.equal(shouldForkQuoteMutation({
    meta: {
      pipelineStage: "sent",
      quoteVersion: 2,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: {
      currentQuoteVersion: 2,
      lastSentQuoteVersion: 1,
    },
    currentQuoteVersion: 2,
  }), false);
});

test("inferLastSentQuoteVersion caps the legacy fallback at currentVersion-1 for draft jobs with historical send signals", () => {
  // Legacy draft job with no quote-lifecycle.json but meta.quoteSentAt set
  // and quoteVersion=3. The sent version cannot be 3 (the draft itself) —
  // the lock policy must fall back to the previous revision.
  assert.equal(inferLastSentQuoteVersion({
    meta: {
      pipelineStage: "draft",
      quoteVersion: 3,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: null,
  }), 2);

  // Same job with only landedAt present (no quoteSentAt) still infers.
  assert.equal(inferLastSentQuoteVersion({
    meta: {
      pipelineStage: "draft",
      quoteVersion: 4,
      landedAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: null,
  }), 3);

  // Non-draft job with no lifecycle: the current version IS the sent one.
  assert.equal(inferLastSentQuoteVersion({
    meta: {
      pipelineStage: "sent",
      quoteVersion: 2,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: null,
  }), 2);

  // No historical signals → null, regardless of quoteVersion.
  assert.equal(inferLastSentQuoteVersion({
    meta: { pipelineStage: "draft", quoteVersion: 5 },
    quoteLifecycle: null,
  }), null);

  // Lifecycle override always wins over inference.
  assert.equal(inferLastSentQuoteVersion({
    meta: {
      pipelineStage: "draft",
      quoteVersion: 3,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: { lastSentQuoteVersion: 1 },
  }), 1);

  // Draft job on v1 with legacy signals: no earlier version exists, so null.
  assert.equal(inferLastSentQuoteVersion({
    meta: {
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: null,
  }), null);
});

test("buildQuoteEditPolicy keeps the draft editable for legacy jobs missing quote-lifecycle.json", () => {
  // Simulates a legacy job restored from backup: stage=draft, quoteVersion=3,
  // meta.quoteSentAt set, no lifecycle. Without the H2 cap the policy would
  // treat v3 as customer-seen and lock it.
  const policy = buildQuoteEditPolicy({
    meta: {
      pipelineStage: "draft",
      quoteVersion: 3,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: null,
    latestVersion: 3,
    selectedVersion: 3,
  });

  assert.equal(policy.lastSentQuoteVersion, 2);
  assert.equal(policy.latestVersionLocked, false);
  assert.equal(policy.canEditSelectedVersion, true);
  assert.equal(policy.existingDraftVersion, 3);
});

test("buildQuoteEditPolicy unlocks draft v1 even with explicit lifecycle lastSentQuoteVersion", () => {
  const policy = buildQuoteEditPolicy({
    meta: {
      pipelineStage: "draft",
      quoteVersion: 1,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: {
      currentQuoteVersion: 1,
      lastSentQuoteVersion: 1,
    },
    latestVersion: 1,
    selectedVersion: 1,
  });

  assert.equal(policy.businessStage, "draft");
  assert.equal(policy.selectedVersionLocked, false);
  assert.equal(policy.latestVersionLocked, false);
  assert.equal(policy.canEditSelectedVersion, true);
  assert.equal(policy.requiresDraftRevision, false);
  assert.equal(policy.lockReason, null);
});

test("resolveDefaultSelectedQuoteVersion prefers the locked customer-seen version for non-draft jobs with a newer draft revision", () => {
  assert.equal(resolveDefaultSelectedQuoteVersion({
    meta: {
      pipelineStage: "lost",
      quoteVersion: 7,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: {
      currentQuoteVersion: 7,
      currentPipelineStage: "lost",
      lastSentQuoteVersion: 1,
    },
    latestVersion: 7,
  }), 1);

  assert.equal(resolveDefaultSelectedQuoteVersion({
    meta: {
      pipelineStage: "draft",
      quoteVersion: 7,
      quoteSentAt: "2026-03-27T00:00:00.000Z",
    },
    quoteLifecycle: {
      currentQuoteVersion: 7,
      currentPipelineStage: "draft",
      lastSentQuoteVersion: 1,
    },
    latestVersion: 7,
  }), 7);
});

test("resolveCustomerDeliveryQuoteVersion delivers the latest revision by default, unlike the view resolver", () => {
  const meta = {
    pipelineStage: "lost",
    quoteVersion: 7,
    quoteSentAt: "2026-03-27T00:00:00.000Z",
  };
  const quoteLifecycle = {
    currentQuoteVersion: 7,
    currentPipelineStage: "lost",
    lastSentQuoteVersion: 1,
  };

  // No explicit version: deliver the latest, not the locked customer-seen
  // revision — the exact case that used to silently re-send the original.
  assert.equal(resolveCustomerDeliveryQuoteVersion({
    meta,
    quoteLifecycle,
    latestVersion: 7,
  }), 7);

  // The view resolver must be unaffected by this addition — still locks to
  // the customer-seen revision.
  assert.equal(resolveDefaultSelectedQuoteVersion({
    meta,
    quoteLifecycle,
    latestVersion: 7,
  }), 1);
});

test("resolveCustomerDeliveryQuoteVersion still honours an explicit version and the plain latest-version fallbacks", () => {
  assert.equal(resolveCustomerDeliveryQuoteVersion({
    requestedVersion: 3,
    meta: { quoteVersion: 7 },
    quoteLifecycle: { currentQuoteVersion: 7, lastSentQuoteVersion: 1 },
    latestVersion: 7,
  }), 3);

  assert.equal(resolveCustomerDeliveryQuoteVersion({
    quoteLifecycle: { currentQuoteVersion: 4 },
  }), 4);

  assert.equal(resolveCustomerDeliveryQuoteVersion({
    meta: { quoteVersion: 2 },
  }), 2);

  assert.equal(resolveCustomerDeliveryQuoteVersion({}), null);
});
