import test from "node:test";
import assert from "node:assert/strict";
import { buildQuoteProofSummary } from "./quote-proof.js";

test("seeded fixture is marked structural only with explicit extraction caveat", () => {
  const proof = buildQuoteProofSummary({
    meta: {
      id: "rec_seeded",
      captureMode: "recording",
    },
    transcript: {
      model: "seed-fixture",
      segments: [{ text: "Seeded transcript" }],
    },
    evidencePack: { sections: [] },
    quoteBreakdownSource: { kind: "quote-breakdown-source", version: 1 },
    quoteInputs: { reviewStatus: "ready" },
    quote: {
      status: "ready",
      review: { status: "ready" },
      missingInputs: [],
    },
    quoteLifecycle: {
      lastBuildReason: "staging_seed_fixture",
      sendCount: 0,
    },
    hasQuotePdf: true,
  });

  assert.equal(proof.runType, "seeded_fixture");
  assert.equal(proof.verdict, "structural_only");
  assert.match(proof.claim, /does not prove audio extraction/i);
  assert.equal(proof.artifacts.quotePdf, true);
  assert.equal(proof.whatIsNotProven.some((item) => /audio/i.test(item)), true);
});

test("audio-backed ready quote is marked review ready", () => {
  const proof = buildQuoteProofSummary({
    meta: {
      id: "rec_audio",
      audioFile: "recording.webm",
      captureMode: "recording",
    },
    transcript: {
      model: "gpt-4o-transcribe",
      segments: [{ text: "Need a retaining wall and drainage." }],
    },
    evidencePack: { sections: [] },
    quoteBreakdownSource: { kind: "quote-breakdown-source", version: 1 },
    quoteInputs: { reviewStatus: "ready" },
    quote: {
      status: "ready",
      review: { status: "ready" },
      missingInputs: [],
      pricing: {
        ready: true,
        displayable: true,
        sendable: true,
        attestation: {
          status: "verified",
          requestNonce: "nonce-1",
          verifiedNonce: "nonce-1",
        },
      },
    },
    quoteLifecycle: {
      lastBuildReason: "quote_build",
      sendCount: 0,
    },
    hasQuotePdf: true,
  });

  assert.equal(proof.runType, "audio_capture");
  assert.equal(proof.verdict, "review_ready");
  assert.equal(proof.canSend, true);
  assert.equal(proof.artifacts.quoteBreakdownSource, true);
  assert.equal(proof.recommendedFirstFiles.includes("quote-breakdown-source.json"), true);
});
