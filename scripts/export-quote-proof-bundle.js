#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, createReadStream } from "../server/storage/fs.js";
import { cp, mkdir, readFile, stat, writeFile } from "../server/storage/fs-promises.js";
import { basename, dirname, join, relative, resolve } from "node:path";
import { buildQuoteProofSummary } from "../server/quote-proof.js";
import { escapeMarkdownCell } from "../shared/markdown-table.js";

const FILE_SPECS = [
  { path: "meta.json", category: "capture", required: true, description: "Recording identity and top-level pipeline status." },
  { path: "transcript-raw.json", category: "capture", required: false, description: "Faithful raw transcript segments from transcription." },
  { path: "transcript.json", category: "capture", required: true, description: "Cleaned transcript plus segment evidence where present." },
  { path: "evidence-pack.json", category: "extraction", required: false, description: "Canonical extraction bundle handed to quote-mode extraction." },
  { path: "quote-inputs.json", category: "extraction", required: false, description: "Structured extracted quote facts." },
  { path: "quote-overrides.json", category: "review", required: false, description: "Manual quote corrections applied after extraction." },
  { path: "quote-lifecycle.json", category: "review", required: false, description: "Lifecycle audit for builds, corrections, and sends." },
  { path: "quote.json", category: "quote", required: false, description: "Current deterministic quote payload." },
  { path: "quote.md", category: "quote", required: false, description: "Human-readable markdown quote render." },
  { path: "quote.pdf", category: "quote", required: false, description: "Customer-facing PDF artifact." },
  { path: "report.md", category: "supporting", required: false, description: "Standard report artifact if generated." },
  { path: "tasks.json", category: "supporting", required: false, description: "Standard task extraction artifact if generated." },
  { path: "job-state/details.json", category: "review", required: false, description: "Operator-maintained details state." },
  { path: "job-state/gaps.json", category: "review", required: false, description: "Current missing-input review state." },
  { path: "job-state/activity.jsonl", category: "review", required: false, description: "Append-only activity log." },
  { path: "moasure/parsed/latest.json", category: "measurement", required: false, description: "Latest parsed measurement summary consumed by pricing." },
];

export async function exportQuoteProofBundle({
  jobDir,
  outputDir = resolve(jobDir, "..", `${basename(jobDir)}-proof-bundle`),
  displaySourceRoot,
  displayRoot,
} = {}) {
  if (!jobDir) {
    throw new Error("jobDir is required");
  }

  const resolvedRecordingDir = resolve(jobDir);
  const resolvedOutputDir = resolve(outputDir);
  const displayRecordingDir = displaySourceRoot && displayRoot
    ? join(displayRoot, relative(resolve(displaySourceRoot), resolvedRecordingDir))
    : resolvedRecordingDir;
  const displayBundleDir = displaySourceRoot && displayRoot
    ? join(displayRecordingDir, basename(resolvedOutputDir))
    : resolvedOutputDir;
  await mkdir(resolvedOutputDir, { recursive: true });

  const meta = await readJsonIfExists(join(resolvedRecordingDir, "meta.json"));
  const transcript = await readJsonIfExists(join(resolvedRecordingDir, "transcript.json"));
  const evidencePack = await readJsonIfExists(join(resolvedRecordingDir, "evidence-pack.json"));
  const quoteInputs = await readJsonIfExists(join(resolvedRecordingDir, "quote-inputs.json"));
  const quote = await readJsonIfExists(join(resolvedRecordingDir, "quote.json"));
  const quoteLifecycle = await readJsonIfExists(join(resolvedRecordingDir, "quote-lifecycle.json"));

  const discoveredFiles = [];
  for (const spec of FILE_SPECS) {
    const sourcePath = join(resolvedRecordingDir, spec.path);
    if (!existsSync(sourcePath)) continue;
    const destinationPath = join(resolvedOutputDir, spec.path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath);
    discoveredFiles.push(await describeFile({
      jobDir: resolvedRecordingDir,
      sourcePath,
      bundlePath: spec.path,
      category: spec.category,
      description: spec.description,
      required: spec.required,
    }));
  }

  const missingRequired = FILE_SPECS
    .filter((spec) => spec.required)
    .filter((spec) => !discoveredFiles.some((file) => file.path === spec.path))
    .map((spec) => spec.path);

  const proof = buildQuoteProofSummary({
    meta,
    transcript,
    evidencePack,
    quoteInputs,
    quote,
    quoteLifecycle,
    hasQuotePdf: discoveredFiles.some((file) => file.path === "quote.pdf"),
  });

  const manifest = {
    kind: "quote-proof-bundle",
    version: 2,
    generatedAt: new Date().toISOString(),
    sourceRecordingDir: displayRecordingDir,
    bundleDir: displayBundleDir,
    recording: {
      id: meta?.id || null,
      title: meta?.title || meta?.label || basename(resolvedRecordingDir),
      createdAt: meta?.createdAt || null,
      outputMode: meta?.outputMode || null,
      quoteCatalogId: meta?.quoteCatalogId || null,
      source: meta?.source || null,
    },
    proof,
    summary: {
      fileCount: discoveredFiles.length,
      missingRequired,
      hasExtractionBundle: discoveredFiles.some((file) => file.path === "evidence-pack.json"),
      hasQuoteInputs: discoveredFiles.some((file) => file.path === "quote-inputs.json"),
      hasQuoteJson: discoveredFiles.some((file) => file.path === "quote.json"),
      hasQuotePdf: discoveredFiles.some((file) => file.path === "quote.pdf"),
    },
    files: discoveredFiles,
  };

  const receipt = {
    kind: "quote-run-receipt",
    version: 1,
    generatedAt: manifest.generatedAt,
    jobId: manifest.recording.id,
    title: manifest.recording.title,
    environment: process.env.FIELD_ENV || process.env.NODE_ENV || null,
    runType: proof.runType,
    verdict: proof.verdict,
    buildReason: proof.buildReason,
    claim: proof.claim,
    recommendedFirstFiles: proof.recommendedFirstFiles,
    artifacts: discoveredFiles.map((file) => ({
      path: file.path,
      category: file.category,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    })),
  };

  await writeFile(join(resolvedOutputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(resolvedOutputDir, "quote-run-receipt.json"), JSON.stringify(receipt, null, 2));
  await writeFile(join(resolvedOutputDir, "README.md"), renderBundleReadme(manifest));
  await writeFile(join(resolvedOutputDir, "PROOF.md"), renderProofCard({ manifest, receipt }));

  return {
    ok: true,
    jobDir: resolvedRecordingDir,
    outputDir: resolvedOutputDir,
    files: discoveredFiles.length,
    missingRequired,
    proof,
  };
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const jobDirArg = args.find((arg) => !arg.startsWith("--"));
  const outputArgIndex = args.indexOf("--out");
  const outputDirArg = outputArgIndex >= 0 ? args[outputArgIndex + 1] : null;

  if (!jobDirArg) {
    console.error("Usage: node scripts/export-quote-proof-bundle.js <recording-dir> [--out <bundle-dir>]");
    process.exit(1);
  }

  const result = await exportQuoteProofBundle({
    jobDir: jobDirArg,
    outputDir: outputDirArg ? resolve(outputDirArg) : undefined,
  });

  console.log(JSON.stringify(result, null, 2));
}

async function describeFile({ jobDir, sourcePath, bundlePath, category, description, required }) {
  const stats = await stat(sourcePath);
  return {
    path: bundlePath,
    category,
    required,
    description,
    sizeBytes: stats.size,
    sha256: await hashFile(sourcePath),
    sourceRelativePath: relative(jobDir, sourcePath) || basename(sourcePath),
  };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", rejectPromise);
  });
  return hash.digest("hex");
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

function renderBundleReadme(manifest) {
  const lines = [];
  lines.push("# Quote Proof Bundle");
  lines.push("");
  lines.push("This bundle is intended to make a quote claim auditable by a human.");
  lines.push("It is not a screenshot pack. It is a copy of the underlying run artifacts plus hashes.");
  lines.push("");
  lines.push("## Recording");
  lines.push("");
  lines.push(`- Title: ${manifest.recording.title || "Unknown"}`);
  lines.push(`- Recording ID: ${manifest.recording.id || "Unknown"}`);
  lines.push(`- Created at: ${manifest.recording.createdAt || "Unknown"}`);
  lines.push(`- Output mode: ${manifest.recording.outputMode || "Unknown"}`);
  lines.push(`- Quote catalog: ${manifest.recording.quoteCatalogId || "Unknown"}`);
  if (manifest.recording.source) {
    lines.push(`- Source: ${manifest.recording.source}`);
  }
  lines.push("");
  lines.push("## Proof");
  lines.push("");
  lines.push(`- Run type: ${manifest.proof.runType}`);
  lines.push(`- Verdict: ${manifest.proof.verdict}`);
  lines.push(`- Claim: ${manifest.proof.claim}`);
  lines.push("");
  lines.push("## Verification");
  lines.push("");
  lines.push(`- Bundle generated: ${manifest.generatedAt}`);
  lines.push(`- Source recording directory: \`${manifest.sourceRecordingDir}\``);
  lines.push(`- Missing required files: ${manifest.summary.missingRequired.length ? manifest.summary.missingRequired.join(", ") : "none"}`);
  lines.push("");
  lines.push("## How To Review");
  lines.push("");
  lines.push("1. Start with `PROOF.md` and `quote-run-receipt.json`.");
  lines.push("2. Read `meta.json` and `transcript.json` to inspect the source capture.");
  lines.push("3. Read `evidence-pack.json` and `quote-inputs.json` to inspect the extraction boundary.");
  lines.push("4. Read `quote.json` and `quote.md` to inspect deterministic pricing and presentation.");
  lines.push("5. Open `quote.pdf` only after checking the upstream artifacts.");
  lines.push("6. Use `manifest.json` or `quote-run-receipt.json` hashes if you need to confirm files have not changed.");
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push("| Path | Category | Size | SHA256 | Purpose |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const file of manifest.files) {
    lines.push(`| ${file.path} | ${file.category} | ${file.sizeBytes} | \`${file.sha256}\` | ${escapeCell(file.description)} |`);
  }
  lines.push("");
  lines.push("## Trust Boundary");
  lines.push("");
  lines.push("- Screenshots are not proof.");
  lines.push("- The PDF alone is not proof.");
  lines.push("- A claim should only be treated as validated if the upstream extraction and quote artifacts in this bundle support it.");
  lines.push("");
  return lines.join("\n");
}

function renderProofCard({ manifest, receipt }) {
  const lines = [];
  lines.push("# Proof Card");
  lines.push("");
  lines.push(`- Claim: ${receipt.claim}`);
  lines.push(`- Run type: ${receipt.runType}`);
  lines.push(`- Verdict: ${receipt.verdict}`);
  lines.push(`- Build reason: ${receipt.buildReason || "unknown"}`);
  lines.push("");
  lines.push("## Open First");
  lines.push("");
  for (const path of receipt.recommendedFirstFiles.slice(0, 5)) {
    lines.push(`- \`${path}\``);
  }
  lines.push("");
  lines.push("## What This Proves");
  lines.push("");
  for (const item of manifest.proof.whatIsProven) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  lines.push("## What This Does Not Prove");
  lines.push("");
  for (const item of manifest.proof.whatIsNotProven) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return lines.join("\n");
}

function isMainModule(importMetaUrl) {
  return process.argv[1] && resolve(process.argv[1]) === resolve(new URL(importMetaUrl).pathname);
}

function escapeCell(value) {
  return escapeMarkdownCell(value || "");
}
