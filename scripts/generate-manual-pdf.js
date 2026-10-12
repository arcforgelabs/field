#!/usr/bin/env node
/**
 * Generate a PDF for a specific job by ID.
 * Usage: node scripts/generate-manual-pdf.js <job-id>
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateQuotePdfBuffer, buildQuotePdfFilename } from "../server/quote-artifacts.js";
import { generateEvidenceQuoteMarkdown } from "../server/generate-evidence-quote.js";
import { assertQuotePricingDisplayable, isIssuedQuoteVersion } from "../server/quote-pricing-attestation.js";
import { readQuoteLifecycle } from "../server/quote-lifecycle.js";
import { resolveActiveJobGeneration, runAtomicJobGeneration } from "../server/job-generation.js";
import { findIssuedQuoteVersion, readIssuedQuoteArtifact, readQuoteIssuanceLedger } from "../server/quote-issuance.js";

const DATA_DIR = process.env.FIELD_DATA
  ? resolve(process.env.FIELD_DATA)
  : join(import.meta.dirname, "..", "data");

async function findJobDir(jobId) {
  const dates = await readdir(DATA_DIR);
  for (const date of dates) {
    const datePath = join(DATA_DIR, date);
    const entries = await readdir(datePath).catch(() => []);
    for (const entry of entries) {
      if (entry.startsWith(jobId) || entry === jobId) {
        return join(datePath, entry);
      }
    }
  }
  return null;
}

async function main() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error("Usage: node scripts/generate-manual-pdf.js <job-id>");
    process.exit(1);
  }

  const jobRoot = await findJobDir(jobId);
  if (!jobRoot) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }

  console.log(`Found job at: ${jobRoot}`);

  await runAtomicJobGeneration(jobRoot, async (stagedJobRoot) => {
  const jobDir = await resolveActiveJobGeneration(stagedJobRoot);
  const meta = JSON.parse(await readFile(join(jobDir, "meta.json"), "utf8"));
  const quote = JSON.parse(await readFile(join(jobDir, "quote.json"), "utf8"));
  const quoteLifecycle = await readQuoteLifecycle(jobDir);
  const issuanceLedger = await readQuoteIssuanceLedger(jobDir);
  const issuanceRecord = findIssuedQuoteVersion(issuanceLedger, quote.version, "quote");
  const issuedVersion = isIssuedQuoteVersion({
    quote,
    quoteLifecycle,
    version: quote.version,
    meta,
    issuanceRecord,
  });
  if (issuedVersion && !issuanceRecord) {
    throw new Error("this quote version is marked issued but has no hash-valid issuance record; refusing to rerender it");
  }
  assertQuotePricingDisplayable(quote, "render", {
    pipelineStage: meta.pipelineStage || meta.deliveryStatus,
    issuedVersion,
    current: true,
  });

  if (issuanceRecord) {
    const issuedPdf = await readIssuedQuoteArtifact(jobDir, issuanceRecord, "quotePdf");
    if (!issuedPdf.available) throw new Error("the exact issued quote PDF bytes are unavailable; refusing to rerender it");
    await writeFile(join(jobDir, "quote.pdf"), issuedPdf.bytes);
    console.log(`Exact issued PDF restored: ${join(jobDir, "quote.pdf")}`);
    return;
  }

  console.log(`Generating PDF for: ${meta.title}`);
  console.log(`  Quote total: $${quote.totals.total} ${quote.totals.currency}`);
  console.log(`  Status: ${quote.delivery?.status || "draft"}`);

  // Generate markdown
  const md = generateEvidenceQuoteMarkdown({ meta, quote });
  const mdPath = join(jobDir, "quote.md");
  await writeFile(mdPath, md);
  console.log(`Markdown written: ${mdPath}`);

  // Resolve variety profile images from quote data
  const imagesDir = join(jobDir, "images");
  if (Array.isArray(quote.varietyProfiles)) {
    for (const profile of quote.varietyProfiles) {
      if (profile.image) {
        const imgPath = join(imagesDir, profile.image);
        if (existsSync(imgPath)) {
          profile.imagePath = imgPath;
        }
      }
    }
    const resolved = quote.varietyProfiles.filter((p) => p.imagePath);
    if (resolved.length) console.log(`  Variety profiles: ${resolved.map((p) => p.name).join(", ")}`);
  }

  // Discover remaining images in images/ subdirectory (fallback if no variety profiles)
  const images = [];
  if (!quote.varietyProfiles?.length && existsSync(imagesDir)) {
    const imgFiles = (await readdir(imagesDir)).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
    for (const f of imgFiles) {
      const label = f.replace(/\.(jpg|jpeg|png)$/i, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      images.push({ path: join(imagesDir, f), label });
    }
    if (images.length) console.log(`  Images: ${images.map((i) => i.label).join(", ")}`);
  }

  // Generate PDF
  const pdfBuffer = await generateQuotePdfBuffer({ meta, quote, images });

  const safeFilename = buildQuotePdfFilename(meta, quote);
  const pdfPath = join(jobDir, safeFilename);
  await writeFile(pdfPath, pdfBuffer);
  // Also write as quote.pdf for stable internal references
  await writeFile(join(jobDir, "quote.pdf"), pdfBuffer);
  console.log(`PDF written: ${pdfPath} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
