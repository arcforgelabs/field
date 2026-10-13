import PDFDocument from "pdfkit";
import { createHash } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "./storage/fs-promises.js";
import { dirname, join } from "node:path";
import {
  buildInvoiceDocumentNumber,
  buildReceiptDocumentNumber,
  buildMilestoneInvoicePdfPath,
  buildMilestoneReceiptPdfPath,
  buildInvoicePaymentSummary,
  DEFAULT_PAYMENT_SCHEDULE,
  getJobDocumentLabel,
  normalizeStoredMilestoneInvoices,
  prepareMilestoneInvoiceDocument,
  resolveJobDocumentType,
  resolvePaymentSchedule,
} from "./job-documents.js";
import { readJobMeta } from "./job-meta-store.js";
import { getCustomerPresentationFinancials, getCustomerScheduleItems } from "./quote-presentation.js";
import { QUOTE_BREAKDOWN_SOURCE_FILE } from "./quote-breakdown-source.js";
import {
  ARTIFACT_STATE,
  deriveArtifactState,
} from "./invoice-artifact-state.js";
import {
  QUOTE_VERSION_CONTEXT_FILE,
} from "./quote-version-context.js";
import { resolveActiveJobGeneration, resolveWritableJobGeneration, runAtomicJobGeneration } from "./job-generation.js";
import { isIssuedQuoteVersion } from "./quote-pricing-attestation.js";
import { countFieldMetric } from "./observability/sentry.js";
import { findAnyIssuedDocument, readQuoteIssuanceLedger } from "./quote-issuance.js";
import { applyBusinessProfileOverride, businessDisplayName, configuresBusinessName } from "./business-profile.js";
import { loadQuoteRows } from "./quotes/read-model.js";
import { claimDescription, customerQuoteReference, jobQuoteReference, quoteReferenceFromMeta, quoteReferenceLine } from "./invoices/customer-wording.js";
import { isSequenceInvoiceNumber } from "./invoices/numbers.js";
import { extractInvoicePdfTotals } from "./invoices/issued-totals.js";

const QUOTE_VERSIONS_DIR = "quote-versions";

// ── Business details — fallback defaults, overridden by quoteCatalog.businessProfile,
// and both by the installation's configured businessProfile (server/business-profile.js) ──
const BUSINESS_DEFAULTS = {
  abn: "",
  address: "Your business address",
  phone: "",
  email: "quotes@example.com",
  paymentMethods: {
    bankTransfer: {
      accountName: "", // empty: the account name printed is the business's legal name
      bsb: "000-000",
      accountNumber: "00000000",
      bank: "Your bank",
    },
  },
};

// The business a document prints (issued documents record it).
export function resolveDocumentBusiness(quote) {
  return resolveBusiness(quote);
}

function resolveBusiness(quote) {
  return applyBusinessProfileOverride(resolveCatalogBusiness(quote));
}

function resolveCatalogBusiness(quote) {
  const profile = quote?.quoteCatalog?.businessProfile;
  if (!profile) return BUSINESS_DEFAULTS;
  if (quote?.quoteCatalog?.id === "field-verification") {
    return {
      ...BUSINESS_DEFAULTS,
      ...profile,
      paymentMethods: profile.paymentMethods || {},
    };
  }
  return {
    ...BUSINESS_DEFAULTS,
    ...profile,
    paymentMethods: BUSINESS_DEFAULTS.paymentMethods,
  };
}

export async function getNextQuoteVersion(jobDir) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const currentQuotePath = join(jobDir, "quote.json");
  const versionsDir = join(jobDir, QUOTE_VERSIONS_DIR);
  let currentVersion = 0;
  if (existsSync(currentQuotePath)) {
    try {
      currentVersion = Number(JSON.parse(await readFile(currentQuotePath, "utf8"))?.version || 0);
    } catch {
      currentVersion = 0;
    }
  }
  if (!existsSync(versionsDir)) return Math.max(1, currentVersion + 1);

  const entries = await readdir(versionsDir).catch(() => []);
  const latest = entries.reduce((max, entry) => {
    const match = /^v(\d{3,})$/.exec(entry);
    if (!match) return max;
    return Math.max(max, Number(match[1]));
  }, 0);

  return Math.max(1, currentVersion, latest) + 1;
}

export async function listQuoteVersions(jobDir) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const versions = new Map();
  const current = await buildQuoteVersionEntry({
    baseDir: jobDir,
    fallbackLabel: null,
  });
  if (current) {
    versions.set(current.version, current);
  }

  const versionsDir = join(jobDir, QUOTE_VERSIONS_DIR);
  if (!existsSync(versionsDir)) {
    return [...versions.values()].sort((a, b) => b.version - a.version);
  }

  const entries = await readdir(versionsDir).catch(() => []);
  const archived = await Promise.all(entries.map(async (entry) => {
    const match = /^v(\d{3,})$/.exec(entry);
    if (!match) return null;
    return await buildQuoteVersionEntry({
      baseDir: join(versionsDir, entry),
      fallbackLabel: entry,
    });
  }));

  for (const entry of archived.filter(Boolean)) {
    if (!versions.has(entry.version)) versions.set(entry.version, entry);
  }

  return [...versions.values()].sort((a, b) => b.version - a.version);
}

export function parseQuoteVersion(versionRef) {
  const raw = String(versionRef ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/^v/i, "");
  const version = Number.parseInt(normalized, 10);
  return Number.isFinite(version) && version > 0 ? version : null;
}

export async function readQuoteArtifacts(jobDir, versionRef = null) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const version = parseQuoteVersion(versionRef);
  const baseDir = version
    ? join(jobDir, QUOTE_VERSIONS_DIR, formatQuoteVersionLabel(version))
    : jobDir;

  const quotePath = join(baseDir, "quote.json");
  if (!existsSync(quotePath)) return null;

  const quoteMarkdownPath = join(baseDir, "quote.md");
  const quoteOverridesPath = join(baseDir, "quote-overrides.json");
  const quotePdfPath = join(baseDir, "quote.pdf");
  const quoteBreakdownSourcePath = join(baseDir, QUOTE_BREAKDOWN_SOURCE_FILE);

  const quote = JSON.parse(await readFile(quotePath, "utf8"));
  const quoteMarkdown = existsSync(quoteMarkdownPath)
    ? await readFile(quoteMarkdownPath, "utf8")
    : null;
  const reportMarkdownPath = join(baseDir, "report.md");
  const reportMarkdown = existsSync(reportMarkdownPath)
    ? await readFile(reportMarkdownPath, "utf8")
    : null;
  const quoteOverrides = existsSync(quoteOverridesPath)
    ? JSON.parse(await readFile(quoteOverridesPath, "utf8"))
    : null;
  const quoteBreakdownSource = existsSync(quoteBreakdownSourcePath)
    ? JSON.parse(await readFile(quoteBreakdownSourcePath, "utf8"))
    : null;

  return {
    version: quote?.version || version || null,
    label: formatQuoteVersionLabel(quote?.version || version || 1),
    quote,
    quoteMarkdown,
    reportMarkdown,
    quoteOverrides,
    quoteBreakdownSource,
    quotePdfPath: existsSync(quotePdfPath) ? quotePdfPath : null,
  };
}

/** An operator's name for the main PDF, made safe; null when nothing is left. */
export function sanitizeAttachmentFilename(filename) {
  const raw = String(filename || "").trim();
  if (!raw) return null;
  const withoutExtension = raw.replace(/\.pdf$/i, "");
  const cleaned = withoutExtension
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (!cleaned) return null;
  return `${cleaned}.pdf`;
}

export function buildQuotePdfFilename(meta, quote, documentType = null) {
  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  const milestoneInvoice = meta?.milestoneInvoice || null;
  const qNum = resolvedDocumentType === "invoice"
    ? buildInvoiceDocumentNumber({ meta, quote, milestoneInvoice })
    : resolvedDocumentType === "receipt"
      ? buildReceiptDocumentNumber({ meta, quote, milestoneInvoice })
      : (quote?.quoteNumber || meta?.quoteNumber || "");
  const name = meta?.contactName || meta?.title?.split("—")[0]?.trim() || "";
  const scope = (quote?.summary || "").split("\n")[0].replace(/[^\w\s,&\-]/g, "").trim().slice(0, 80);
  const parts = [qNum, name, scope].filter(Boolean);
  const label = getJobDocumentLabel(resolvedDocumentType);
  if (!parts.length) return `${label.toLowerCase()}.pdf`;
  return `${parts.join(" — ").replace(/[/\\:*?"<>|]+/g, "-")} — ${label}.pdf`;
}

export function formatQuoteVersionLabel(version) {
  return `v${String(version).padStart(3, "0")}`;
}

export async function writeQuoteArtifacts({
  jobDir,
  meta,
  quote,
  quoteMarkdown,
  quoteOverrides = null,
  quoteBreakdownSource = undefined,
}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const pdfBuffer = await generateQuotePdfBuffer({
    meta,
    quote,
    documentType: "quote",
  });
  const quoteBreakdownSourcePath = join(jobDir, QUOTE_BREAKDOWN_SOURCE_FILE);

  const writes = [
    writeFile(join(jobDir, "quote.json"), JSON.stringify(quote, null, 2)),
    writeFile(join(jobDir, "quote.md"), quoteMarkdown),
    writeFile(join(jobDir, "quote.pdf"), pdfBuffer),
    writeFile(join(jobDir, "report.md"), quoteMarkdown),
  ];

  // Also write a descriptive-named PDF for human browsing
  const descriptiveName = buildQuotePdfFilename(meta, quote, "quote");
  if (descriptiveName !== "quote.pdf") {
    writes.push(writeFile(join(jobDir, descriptiveName), pdfBuffer));
  }

  if (quoteOverrides) {
    const serialized = JSON.stringify(quoteOverrides, null, 2);
    writes.push(writeFile(join(jobDir, "quote-overrides.json"), serialized));
  }
  if (quoteBreakdownSource !== undefined) {
    if (quoteBreakdownSource) {
      writes.push(writeFile(quoteBreakdownSourcePath, JSON.stringify(quoteBreakdownSource, null, 2)));
    } else if (existsSync(quoteBreakdownSourcePath)) {
      writes.push(unlink(quoteBreakdownSourcePath).catch(() => {}));
    }
  }

  await Promise.all(writes);

  return {
    pdfBuffer,
    versionDirName: formatQuoteVersionLabel(quote.version),
  };
}

export async function writeQuoteVersionSnapshot({
  jobDir,
  meta,
  quote,
  quoteMarkdown,
  quoteOverrides = null,
  quoteBreakdownSource = null,
  allowExistingRewrite = false,
}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const versionDirName = formatQuoteVersionLabel(quote.version);
  const versionDir = join(jobDir, QUOTE_VERSIONS_DIR, versionDirName);
  // Ordinary publication is append-only. The only caller allowed to opt
  // into rewriting an existing snapshot is the explicit legacy migration,
  // which has no issuance ledger to preserve yet and is normalising pre-ledger
  // data in place. Keep the opt-in at this owner so route code cannot weaken
  // version immutability accidentally.
  if (!allowExistingRewrite && existsSync(join(versionDir, "quote.json"))) {
    const err = new Error(`quote version ${quote.version} already exists and cannot be overwritten`);
    err.statusCode = 409;
    throw err;
  }
  await mkdir(versionDir, { recursive: true });

  const pdfBuffer = await generateQuotePdfBuffer({
    meta,
    quote,
    documentType: "quote",
  });
  const writes = [
    writeFile(join(versionDir, "quote.json"), JSON.stringify(quote, null, 2)),
    writeFile(join(versionDir, "quote.md"), quoteMarkdown),
    writeFile(join(versionDir, "quote.pdf"), pdfBuffer),
    writeFile(join(versionDir, "report.md"), quoteMarkdown),
  ];

  if (quoteOverrides) {
    writes.push(writeFile(join(versionDir, "quote-overrides.json"), JSON.stringify(quoteOverrides, null, 2)));
  }
  if (quoteBreakdownSource) {
    writes.push(writeFile(
      join(versionDir, QUOTE_BREAKDOWN_SOURCE_FILE),
      JSON.stringify(quoteBreakdownSource, null, 2),
    ));
  }

  await Promise.all(writes);
  return {
    pdfBuffer,
    versionDirName,
  };
}

// Root quote artifacts represent the CURRENT version and only get archived
// into `quote-versions/vNNN/` once the quote is forked away from it
// (`forkCurrentQuoteVersion`). A single-version job — quoted, landed,
// invoiced, never revised — has no archive directory at all, so a lookup
// keyed purely on the versions directory always misses even when the
// pinned version IS the current, locked root quote. Mirror
// `creditAndReissueJobMilestoneInvoice`'s own current-vs-requested-version fallback
// instead of 410ing the common case.
async function resolvePinnedQuoteArtifactsForReconstruction(jobDir, pinnedQuoteVersion) {
  if (!pinnedQuoteVersion) return null;
  const versionedArtifacts = await readQuoteArtifacts(jobDir, pinnedQuoteVersion);
  if (versionedArtifacts?.quote) return versionedArtifacts;
  const rootArtifacts = await readQuoteArtifacts(jobDir);
  const rootVersion = Number(rootArtifacts?.quote?.version || rootArtifacts?.version || 0) || null;
  if (rootVersion && rootVersion === Number(pinnedQuoteVersion)) {
    return rootArtifacts;
  }
  return null;
}

// Single owner of "does this milestone invoice's PDF need writing, and how?"
// Dispatches on `artifactState` —
// every branch below follows directly from the state, rather than each
// caller (this function previously, `resolveIssuedMilestoneInvoiceArtifact`,
// `persistMilestoneInvoiceState`) recombining `pdfIssuedAt` / `legacyOrigin`
// / `pdfUnrecoverable` a different way.
//
// Returns `{ pdfBuffer, pdfPath, relativePdfPath, alreadyIssued, selfHealed,
// reconstructed, artifactTransition }`.
// `artifactTransition` is either `null` (no change — already correctly
// stored) or `{ pdfPath, toState, pdfSha256, pdfIssuedAt }`, the exact
// arguments the caller passes to `transitionArtifactState` to commit the
// change to whichever revision (active or historical) owns this path — the
// one function that owns the actual mutation. On failure, throws with
// `err.artifactTransition` set to a `{ pdfPath, toState: MISSING, reason }`
// descriptor so a catching caller does not have to reconstruct one by hand.
export async function writeMilestoneInvoiceArtifact({
  jobDir,
  meta,
  quote,
  milestoneInvoice,
  // async (invoiceNumber) => hash-verified copies Field emailed, each with
  // its bytes (server/invoices/sent-copies.js); a legacy revision whose PDF
  // is missing adopts one instead of being unrecoverable.
  findSentCopy = null,
}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  if (!milestoneInvoice) {
    throw new Error("milestone invoice required");
  }

  const relativePdfPath = milestoneInvoice.pdfPath || buildMilestoneInvoicePdfPath(milestoneInvoice);
  const pdfPath = join(jobDir, relativePdfPath);
  const issuedRevision = milestoneInvoice.issuedRevision || null;
  const state = deriveArtifactState(issuedRevision);

  // Path-scoped, not milestone-scoped: a *retired* revision can
  // share this exact path (e.g. right after an unsend restores an identical
  // revision number onto the same invoice number). Once ANY revision —
  // active or historical — was genuinely issued at this exact path, that
  // file is immutable regardless of who renders next.
  const historicalMatch = (milestoneInvoice.revisionHistory || [])
    .find((entry) => deriveArtifactState(entry) !== ARTIFACT_STATE.UNWRITTEN && entry?.pdfPath === relativePdfPath);

  // A revision is a money document — its file must never be silently
  // overwritten by a fresh render — the moment it is anything other than a
  // never-touched, never-issued mint. This is true whether that comes from
  // the ACTIVE revision's own state (STORED, ADOPT_PENDING, or MISSING) or
  // from a historical revision sharing this exact path.
  const isMoneyDocument = state !== ARTIFACT_STATE.UNWRITTEN || Boolean(historicalMatch);
  const identitySource = issuedRevision?.pdfPath === relativePdfPath ? issuedRevision : historicalMatch;

  if (isMoneyDocument) {
    // The file may genuinely be present — the common case, an already-
    // stored revision on an ordinary touch — or it may have reappeared out
    // of band even though the last known state was MISSING (an operator
    // restoring it from backup, exactly what the artifact_unrecoverable
    // activity invites them to do). Either way: if a file is sitting at
    // this exact path, IT is the real issued document. Adopt it — read it,
    // hash it, and stamp its own recorded issue time — and never overwrite
    // it with a reconstruction that would silently launder the swap under
    // the original issue timestamp with a fresh sha. This is
    // not a bolted-on guard: it falls directly out of "any money-document
    // state re-verifies disk before acting," which is exactly what the
    // state model is for.
    // Adopt bytes as this revision's issued PDF: read, hashed and stamped
    // with the revision's own issue time (preferred over a previously
    // recorded artifact timestamp, as in the reconstruct branch below).
    const adopt = (bytes, adoptedFrom = null) => {
      const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
      const pdfIssuedAt = identitySource?.issuedAt || identitySource?.pdfIssuedAt || null;
      // A legacy file adopted for the first time: before revisions were
      // frozen, Field re-rendered a milestone's PDF only when an action
      // targeted it, but re-allocated its amounts on every action, so the
      // file and the record can come from different quote versions. Adopt
      // the file regardless (it is never overwritten), and say so when its
      // claim differs from the record, so an owner settles which was sent.
      let adoptedClaimDiffers = null;
      if ((state === ARTIFACT_STATE.ADOPT_PENDING || adoptedFrom) && identitySource) {
        const printed = extractInvoicePdfTotals(bytes);
        const recordedTotal = Math.round(Number(identitySource.total || 0) * 100);
        if (printed && Math.round(Number(printed.total) * 100) !== recordedTotal) {
          adoptedClaimDiffers = { printedTotal: printed.total, recordedTotal: (recordedTotal / 100).toFixed(2) };
        }
      }
      return {
        pdfBuffer: bytes,
        pdfPath,
        relativePdfPath,
        alreadyIssued: true,
        selfHealed: state !== ARTIFACT_STATE.STORED,
        adoptedClaimDiffers,
        adoptedFrom,
        // Convenience top-level mirrors of the transition's data fields —
        // callers that only care about the bytes/hash/timestamp (tests,
        // simple consumers) don't need to unpack `artifactTransition`.
        pdfSha256,
        pdfIssuedAt,
        artifactTransition: {
          pdfPath: relativePdfPath,
          toState: ARTIFACT_STATE.STORED,
          pdfSha256,
          pdfIssuedAt,
        },
      };
    };
    if (existsSync(pdfPath)) {
      return adopt(await readFile(pdfPath));
    }

    // No file at all. A legacy revision (issued before revisions recorded
    // their quote version) only has a version inferred from whatever quote
    // was current when it was first frozen, not the one its PDF was drawn
    // from. Redrawing it from that guess would store a document the customer
    // was never sent under the original issue time, so it is unrecoverable
    // until the file itself is restored (the adopt branch above takes it),
    // unless Field holds the copy it emailed.
    if (identitySource?.quoteVersionInferred) {
      // The copy Field emailed, verified by its hash, is the document the
      // customer received: adopt it when it is unambiguous.
      const copies = findSentCopy ? await findSentCopy(identitySource.invoiceNumber || milestoneInvoice.invoiceNumber) : [];
      const distinct = new Set(copies.map((copy) => copy.sha256));
      if (copies.length && distinct.size === 1 && copies[0].bytes) {
        await mkdir(dirname(pdfPath), { recursive: true });
        await writeFile(pdfPath, copies[0].bytes);
        return adopt(copies[0].bytes, copies[0].source);
      }
      const message = `the PDF for invoice ${milestoneInvoice.invoiceNumber || relativePdfPath} is missing, and it was issued before Field recorded which quote version an invoice was drawn from, so it is not redrawn from a guessed version; restore the file to ${relativePdfPath}`;
      const err = new Error(message);
      err.statusCode = 410;
      err.artifactTransition = {
        pdfPath: relativePdfPath,
        toState: ARTIFACT_STATE.MISSING,
        reason: message,
      };
      throw err;
    }
    // Otherwise reconstruct from the quote version this revision was
    // actually issued against, or fail loudly — never render from whatever
    // quote this call happens to be carrying.
    const pinnedQuoteVersion = issuedRevision?.quoteVersion || historicalMatch?.quoteVersion || null;
    const pinnedArtifacts = await resolvePinnedQuoteArtifactsForReconstruction(jobDir, pinnedQuoteVersion);
    if (!pinnedArtifacts?.quote) {
      const message = `the PDF for invoice ${milestoneInvoice.invoiceNumber || relativePdfPath} is missing and the quote version it was issued against (${pinnedQuoteVersion || "unknown"}) is unavailable to reconstruct it`;
      const err = new Error(message);
      err.statusCode = 410;
      err.artifactTransition = {
        pdfPath: relativePdfPath,
        toState: ARTIFACT_STATE.MISSING,
        reason: message,
      };
      throw err;
    }
    const reconstructedPrepared = prepareMilestoneInvoiceDocument({
      meta,
      quote: pinnedArtifacts.quote,
      milestoneInvoice,
    });
    await mkdir(dirname(pdfPath), { recursive: true });
    const reconstructedBuffer = await generateQuotePdfBuffer({
      meta: reconstructedPrepared.meta,
      quote: reconstructedPrepared.quote,
      documentType: "invoice",
      jobDir,
      reconstructed: true,
    });
    await writeFile(pdfPath, reconstructedBuffer);
    const pdfSha256 = createHash("sha256").update(reconstructedBuffer).digest("hex");
    const pdfIssuedAt = identitySource?.issuedAt || identitySource?.pdfIssuedAt || null;
    return {
      pdfBuffer: reconstructedBuffer,
      pdfPath,
      relativePdfPath,
      alreadyIssued: true,
      reconstructed: true,
      pdfSha256,
      pdfIssuedAt,
      artifactTransition: {
        pdfPath: relativePdfPath,
        toState: ARTIFACT_STATE.STORED,
        pdfSha256,
        pdfIssuedAt,
      },
    };
  }

  // UNWRITTEN with no historical claim on this path either: a genuine first
  // mint. Render fresh from the current quote and write once.
  const prepared = prepareMilestoneInvoiceDocument({
    meta,
    quote,
    milestoneInvoice,
  });
  await mkdir(dirname(pdfPath), { recursive: true });

  const pdfBuffer = await generateQuotePdfBuffer({
    meta: prepared.meta,
    quote: prepared.quote,
    documentType: "invoice",
    jobDir,
  });
  await writeFile(pdfPath, pdfBuffer);
  const pdfSha256 = createHash("sha256").update(pdfBuffer).digest("hex");

  return {
    pdfBuffer,
    pdfPath,
    relativePdfPath,
    alreadyIssued: false,
    pdfSha256,
    artifactTransition: {
      pdfPath: relativePdfPath,
      toState: ARTIFACT_STATE.STORED,
      pdfSha256,
      // No prior issue event to preserve — the caller stamps "now".
      pdfIssuedAt: null,
    },
  };
}

// The bytes of an invoice the issue service just issued (server/invoices/
// issue.js), written once at the path its revision records. They are the
// exact bytes stored in document_blobs; the next artifact write adopts them
// as the stored revision rather than rendering again.
export async function writeIssuedInvoicePdf({ jobDir, relativePdfPath, pdfBuffer }) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const pdfPath = join(jobDir, relativePdfPath);
  await mkdir(dirname(pdfPath), { recursive: true });
  await writeFile(pdfPath, pdfBuffer);
  return { pdfPath, relativePdfPath };
}

export async function readMilestoneInvoiceRevisionArtifact({
  jobDir,
  revision = null,
}) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const relativePdfPath = revision?.pdfPath || null;
  if (!relativePdfPath) return null;
  const pdfPath = join(jobDir, relativePdfPath);
  if (!existsSync(pdfPath)) return null;
  return {
    pdfBuffer: await readFile(pdfPath),
    pdfPath,
    relativePdfPath,
  };
}

export async function writeMilestoneReceiptArtifact({
  jobDir,
  meta,
  quote,
  milestoneInvoice,
}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  if (!milestoneInvoice) {
    throw new Error("milestone receipt required");
  }

  const prepared = prepareMilestoneInvoiceDocument({
    meta,
    quote,
    milestoneInvoice,
    documentType: "receipt",
  });
  const relativePdfPath = milestoneInvoice.receiptPdfPath || buildMilestoneReceiptPdfPath(milestoneInvoice);
  const pdfPath = join(jobDir, relativePdfPath);
  // An issued receipt (RCT-…) is a money document: its stored bytes are the
  // receipt, sent as they are. If they were lost it is drawn again with its
  // number, marked "Reconstructed copy".
  const issuedReceipt = milestoneInvoice.issuedReceipt?.pdfPath === relativePdfPath ? milestoneInvoice.issuedReceipt : null;
  if (issuedReceipt && existsSync(pdfPath)) {
    return { pdfBuffer: await readFile(pdfPath), pdfPath, relativePdfPath, alreadyIssued: true };
  }
  await mkdir(dirname(pdfPath), { recursive: true });

  const pdfBuffer = await generateQuotePdfBuffer({
    meta: prepared.meta,
    quote: prepared.quote,
    documentType: "receipt",
    jobDir,
    reconstructed: Boolean(issuedReceipt),
  });
  await writeFile(pdfPath, pdfBuffer);

  return {
    pdfBuffer,
    pdfPath,
    relativePdfPath,
  };
}

export async function deleteMilestoneReceiptArtifact({
  jobDir,
  milestoneInvoice,
}) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  if (!milestoneInvoice) return;
  const relativePdfPath = milestoneInvoice.receiptPdfPath || buildMilestoneReceiptPdfPath(milestoneInvoice);
  const pdfPath = join(jobDir, relativePdfPath);
  if (!existsSync(pdfPath)) return;
  await unlink(pdfPath).catch(() => {});
}

// Version snapshots are the reconstruction basis for money
// documents: a revision pins the quote version it needs to rebuild a lost
// PDF from. Deleting a version any issued revision — active
// or historical — is still pinned to silently converts every future lost
// PDF pinned to it into a permanent 410, with no way back.
//
// This guard is DELIBERATELY broader than what today's write-path
// reconstruction alone would need: `writeMilestoneInvoiceArtifact` only
// ever adopts or reconstructs at the ACTIVE revision's own path, so a
// SUPERSEDED (historical) revision's lost PDF cannot actually be rebuilt
// today even when its pinned version survives. The
// guard still protects historical pins anyway: historical reads, downloads,
// previews and resend paths must select the intended version
// deterministically, and Field treats a superseded revision's
// PDF as no less a money document than the active one. Narrowing this guard
// to active revisions only would not close that reconstruction gap — it
// would just additionally allow deleting the one thing that could later
// let it be closed. Keeping the broad guard costs an operator an occasional
// blocked deletion; narrowing it would foreclose ever rebuilding a
// superseded revision whose version is deleted before that fix lands. If a historical
// reconstruction endpoint is later built, this guard already covers it with
// no change needed.
async function findQuoteVersionReference(jobDir, version) {
  const meta = await readJobMeta(jobDir).catch(() => null);
  const milestoneInvoices = normalizeStoredMilestoneInvoices(meta?.milestoneInvoices || []);
  for (const milestoneInvoice of milestoneInvoices) {
    const candidates = [
      milestoneInvoice.issuedRevision,
      ...(Array.isArray(milestoneInvoice.revisionHistory) ? milestoneInvoice.revisionHistory : []),
    ];
    const match = candidates.find((revision) => Number(revision?.quoteVersion) === Number(version));
    if (match) {
      return { milestoneInvoice, revision: match };
    }
  }
  return null;
}

export async function deleteQuoteVersion(jobDir, versionRef, { inExistingGeneration = false } = {}) {
  if (inExistingGeneration) return deleteQuoteVersionInPlace(jobDir, versionRef);
  return runAtomicJobGeneration(jobDir, (stagedJobDir) => deleteQuoteVersionInPlace(stagedJobDir, versionRef));
}

async function deleteQuoteVersionInPlace(jobDir, versionRef) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const version = parseQuoteVersion(versionRef);
  if (!version) throw new Error("invalid version");

  const versionDir = join(jobDir, QUOTE_VERSIONS_DIR, formatQuoteVersionLabel(version));
  if (!existsSync(versionDir)) {
    const err = new Error("version not found");
    err.statusCode = 404;
    throw err;
  }

  const reference = await findQuoteVersionReference(jobDir, version);
  if (reference) {
    const err = new Error(
      `quote version ${version} cannot be deleted: it is the reconstruction basis for invoice ${reference.revision.invoiceNumber || reference.milestoneInvoice.invoiceNumber} (revision ${reference.revision.revisionNumber}); it must remain available in case that invoice's PDF is ever lost`,
    );
    err.statusCode = 409;
    throw err;
  }

  const versionQuote = existsSync(join(versionDir, "quote.json"))
    ? JSON.parse(await readFile(join(versionDir, "quote.json"), "utf8"))
    : null;
  const currentMeta = await readJobMeta(jobDir).catch(() => null);
  const lifecyclePath = join(jobDir, "quote-lifecycle.json");
  const lifecycle = existsSync(lifecyclePath)
    ? JSON.parse(await readFile(lifecyclePath, "utf8"))
    : null;
  // Any delivery from this version (quote, invoice or receipt) keeps it.
  const issuanceRecord = findAnyIssuedDocument(await readQuoteIssuanceLedger(jobDir), version);
  if (isIssuedQuoteVersion({
    quote: versionQuote,
    quoteLifecycle: lifecycle,
    version,
    meta: currentMeta,
    issuanceRecord,
  })) {
    const err = new Error(`quote version ${version} cannot be deleted: an issued document is immutable`);
    err.statusCode = 409;
    throw err;
  }

  await rm(versionDir, { recursive: true, force: true });
}

// Files that define a quote version — swapped together when a version is
// promoted so root quote artifacts and rebuild context never diverge.
const QUOTE_VERSIONED_FILES = [
  "quote.json",
  "quote.md",
  "quote.pdf",
  "quote-overrides.json",
  QUOTE_BREAKDOWN_SOURCE_FILE,
];

const QUOTE_PROMOTED_FILES = [...new Set([
  ...QUOTE_VERSIONED_FILES,
  QUOTE_VERSION_CONTEXT_FILE,
  // Operational transcript/ledger/evidence-index/moasure trees remain owned
  // by their root writers. Only commercial context is promoted with the
  // active quote generation; historical snapshots retain the full context
  // under their immutable version directory.
  "quote-inputs.json",
  "evidence-pack.json",
  "quote-breakdown-source.json",
])];

async function readVersionFileSet(baseDir, fileNames) {
  const files = new Map();
  for (const name of fileNames) {
    const path = join(baseDir, name);
    files.set(name, existsSync(path) ? await readFile(path) : null);
  }
  return files;
}

async function writeVersionFileSet(baseDir, files) {
  await mkdir(baseDir, { recursive: true });
  for (const [name, contents] of files.entries()) {
    const path = join(baseDir, name);
    if (contents === null) {
      if (existsSync(path)) await unlink(path).catch(() => {});
      continue;
    }
    await writeFile(path, contents);
  }
}

export async function promoteQuoteVersion(jobDir, versionRef, { inExistingGeneration = false } = {}) {
  if (inExistingGeneration) return promoteQuoteVersionInPlace(jobDir, versionRef);
  return runAtomicJobGeneration(jobDir, (stagedJobDir) => promoteQuoteVersionInPlace(stagedJobDir, versionRef));
}

async function promoteQuoteVersionInPlace(jobDir, versionRef) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const t0 = Date.now();
  const targetVersion = parseQuoteVersion(versionRef);
  if (!targetVersion) {
    const err = new Error("invalid version");
    err.statusCode = 400;
    throw err;
  }

  const targetDir = join(jobDir, QUOTE_VERSIONS_DIR, formatQuoteVersionLabel(targetVersion));
  if (!existsSync(targetDir)) {
    const err = new Error("version not found");
    err.statusCode = 404;
    throw err;
  }

  const rootQuotePath = join(jobDir, "quote.json");
  if (!existsSync(rootQuotePath)) {
    const err = new Error("no current quote to replace");
    err.statusCode = 409;
    throw err;
  }

  const currentQuote = JSON.parse(await readFile(rootQuotePath, "utf8"));
  const currentVersion = Number(currentQuote?.version || 1);
  if (currentVersion === targetVersion) {
    const err = new Error("version is already current");
    err.statusCode = 409;
    throw err;
  }
  // Any delivery from the target (quote, invoice or receipt) retains its
  // archived files after the promotion.
  const targetIssuanceRecord = findAnyIssuedDocument(await readQuoteIssuanceLedger(jobDir), targetVersion);
  const targetQuote = existsSync(join(targetDir, "quote.json"))
    ? JSON.parse(await readFile(join(targetDir, "quote.json"), "utf8"))
    : null;
  const lifecyclePath = join(jobDir, "quote-lifecycle.json");
  const lifecycle = existsSync(lifecyclePath)
    ? JSON.parse(await readFile(lifecyclePath, "utf8"))
    : null;
  const currentMeta = await readJobMeta(jobDir).catch(() => null);
  const targetWasIssued = isIssuedQuoteVersion({
    quote: targetQuote,
    quoteLifecycle: lifecycle,
    version: targetVersion,
    meta: currentMeta,
    issuanceRecord: targetIssuanceRecord,
  });

  const currentRootFiles = await readVersionFileSet(jobDir, QUOTE_PROMOTED_FILES);
  const targetFiles = await readVersionFileSet(targetDir, QUOTE_PROMOTED_FILES);

  // 1) Archive the currently-current files into quote-versions/v<current>/
  const currentArchiveDir = join(jobDir, QUOTE_VERSIONS_DIR, formatQuoteVersionLabel(currentVersion));
  await writeVersionFileSet(currentArchiveDir, currentRootFiles);
  console.log(`[promote-version]   archive current v${currentVersion} (${Date.now() - t0}ms)`);

  // 2) Copy target files from quote-versions/v<target>/ to root, clearing
  //    any stale root files the target version doesn't carry.
  await writeVersionFileSet(jobDir, targetFiles);
  console.log(`[promote-version]   copy target v${targetVersion} to root (${Date.now() - t0}ms)`);

  // 2b) Reset delivery state on the promoted quote so it re-enters as a draft
  //     with today's date, not the stale sent-date from its previous life.
  if (existsSync(rootQuotePath)) {
    const promotedRaw = JSON.parse(await readFile(rootQuotePath, "utf8"));
    const resetQuote = {
      ...promotedRaw,
      updatedAt: new Date().toISOString(),
      delivery: {
        ...(promotedRaw.delivery || {}),
        status: "draft",
        finalizedAt: null,
      },
    };
    await writeFile(rootQuotePath, JSON.stringify(resetQuote, null, 2));
  }

  // 3) Re-mirror report.md (writeQuoteArtifacts keeps it in lock-step with quote.md)
  const newQuoteMdPath = join(jobDir, "quote.md");
  if (existsSync(newQuoteMdPath)) {
    await writeFile(join(jobDir, "report.md"), await readFile(newQuoteMdPath));
  }

  // An issued source is append-only evidence. Legacy unsent promotions retain
  // the historical remove behavior for compatibility, while issued targets
  // remain available under their original version key.
  if (!targetWasIssued) {
    await rm(targetDir, { recursive: true, force: true });
    console.log(`[promote-version]   remove target archive dir (${Date.now() - t0}ms)`);
  } else {
    console.log(`[promote-version]   retained issued source v${targetVersion}`);
  }

  const promotedQuote = JSON.parse(await readFile(rootQuotePath, "utf8"));
  return {
    previousVersion: currentVersion,
    currentVersion: targetVersion,
    quote: promotedQuote,
  };
}

export async function forkCurrentQuoteVersion(jobDir, { inExistingGeneration = false } = {}) {
  if (inExistingGeneration) return forkCurrentQuoteVersionInPlace(jobDir);
  return runAtomicJobGeneration(jobDir, (stagedJobDir) => forkCurrentQuoteVersionInPlace(stagedJobDir));
}

async function forkCurrentQuoteVersionInPlace(jobDir) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const rootQuotePath = join(jobDir, "quote.json");
  if (!existsSync(rootQuotePath)) {
    const err = new Error("no current quote to fork");
    err.statusCode = 409;
    throw err;
  }

  const currentQuote = JSON.parse(await readFile(rootQuotePath, "utf8"));
  const currentVersion = Number(currentQuote?.version || 1);
  const newVersion = await getNextQuoteVersion(jobDir);

  // Archive current root files into quote-versions/v<currentVersion>/
  const archiveDir = join(jobDir, QUOTE_VERSIONS_DIR, formatQuoteVersionLabel(currentVersion));
  if (existsSync(archiveDir)) {
    const err = new Error(`version ${currentVersion} is already archived`);
    err.statusCode = 409;
    throw err;
  }
  await mkdir(archiveDir, { recursive: true });
  for (const name of QUOTE_PROMOTED_FILES) {
    const src = join(jobDir, name);
    if (!existsSync(src)) continue;
    await writeFile(join(archiveDir, name), await readFile(src));
  }

  // Bump version number in the root quote.json; reset delivery so the new
  // version starts as a fresh draft with today's date, not the old sent date.
  const updatedQuote = {
    ...currentQuote,
    version: newVersion,
    updatedAt: new Date().toISOString(),
    delivery: {
      ...(currentQuote.delivery || {}),
      status: "draft",
      finalizedAt: null,
    },
  };
  await writeFile(rootQuotePath, JSON.stringify(updatedQuote, null, 2));

  return { previousVersion: currentVersion, currentVersion: newVersion };
}

async function buildQuoteVersionEntry({ baseDir, fallbackLabel }) {
  const quotePath = join(baseDir, "quote.json");
  if (!existsSync(quotePath)) return null;

  let quote = null;
  let createdAt = null;
  try {
    quote = JSON.parse(await readFile(quotePath, "utf8"));
  } catch {
    quote = null;
  }
  try {
    const quoteStat = await stat(quotePath);
    createdAt = quoteStat.mtime.toISOString();
  } catch {
    createdAt = null;
  }

  const version = Number(quote?.version || parseQuoteVersion(fallbackLabel) || 1);
  return {
    label: fallbackLabel || formatQuoteVersionLabel(version),
    version,
    createdAt: quote?.delivery?.finalizedAt || quote?.updatedAt || quote?.generatedAt || createdAt,
    total: quote ? getCustomerPresentationFinancials(quote).subtotal : null,
    status: quote?.delivery?.status || quote?.status || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// PDF GENERATION
// ═══════════════════════════════════════════════════════════════════════

export async function generateQuotePdfBuffer(options) {
  try {
    return await renderQuotePdfBuffer(options);
  } catch (error) {
    let documentType = "unknown";
    try {
      documentType = resolveJobDocumentType({ meta: options?.meta, documentType: options?.documentType ?? null }) || "unknown";
    } catch {
      // The count must not replace the rendering error.
    }
    countFieldMetric("field.pdf.generation_failed", { document_type: documentType });
    throw error;
  }
}

async function renderQuotePdfBuffer({
  meta,
  quote,
  images,
  sitePlanPng,
  documentType = null,
  invoicePaidAmount = null,
  // The job's directory, so a milestone invoice can say which revision of
  // the quote it claims against (only when the customer was sent more than
  // one; server/invoices/customer-wording.js). Without it, no revision.
  jobDir = null,
  // A copy of an issued invoice drawn again because its stored PDF was
  // lost: marked "Reconstructed copy". One issued before step 4b (an EI-
  // number) is drawn in the layout it was issued with (owner, 2026-10-13).
  reconstructed = false,
  // Fixes the PDF's creation date (and so its file id), which otherwise is
  // the moment of rendering. Only for comparing two renderings byte for byte.
  creationDate = null,
}) {
  // Pre-load terms for PDF rendering
  if (typeof globalThis.__fieldLoadTerms === "function") {
    try {
      globalThis.__fieldCachedTerms = await globalThis.__fieldLoadTerms();
    } catch { globalThis.__fieldCachedTerms = null; }
  }
  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  const documentLabel = getJobDocumentLabel(resolvedDocumentType);
  const milestoneInvoice = meta?.milestoneInvoice || null;
  const documentRef = resolvedDocumentType === "invoice"
    ? invoiceDocumentRef({ meta, quote, milestoneInvoice })
    : resolvedDocumentType === "receipt"
      ? buildReceiptDocumentNumber({ meta, quote, milestoneInvoice })
      : (quote.quoteNumber || meta.id);
  const pdfBusiness = resolveBusiness(quote);
  const milestoneLayout = resolvedDocumentType === "invoice" && milestoneInvoice
    ? {
        legacy: Boolean(reconstructed) && !isSequenceInvoiceNumber(milestoneInvoice.issuedRevision?.invoiceNumber || milestoneInvoice.invoiceNumber),
        reconstructed: Boolean(reconstructed),
        quoteReference: meta?.customerQuoteReference || (jobDir
          ? await customerQuoteReference({ jobDir, meta, milestone: milestoneInvoice, quote, quoteVersion: milestoneInvoice.issuedRevision?.quoteVersion || quote?.version || null })
          : quoteReferenceFromMeta({ meta, milestone: milestoneInvoice, quote })),
      }
    : null;
  // A quote prints its schedule and totals from its rows (#10); invoices and
  // receipts (milestone invoices print claim lines, step 4b) still print the
  // quote's schedule from the files until they are
  // rows themselves.
  const scheduleView = resolvedDocumentType === "quote" ? await loadQuoteRows({ quote, meta }) : null;
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      info: {
        Title: `${invoiceTitle({ documentLabel, isInvoice: resolvedDocumentType === "invoice", milestoneInvoice, legacy: milestoneLayout?.legacy })} ${documentRef}`,
        Author: businessDisplayName(pdfBusiness),
        Subject: `${documentLabel} for ${meta.title || "Earthworks"}`,
        ...(creationDate ? { CreationDate: creationDate } : {}),
      },
    });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    renderQuotePdf(doc, {
      meta,
      quote,
      images,
      sitePlanPng,
      documentType: resolvedDocumentType,
      invoicePaidAmount,
      scheduleView,
      milestoneLayout,
      reconstructed: Boolean(reconstructed),
    });
    doc.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════
// CREDIT (ADJUSTMENT) NOTE
// ═══════════════════════════════════════════════════════════════════════

/**
 * The PDF of a credit note (#28, step 4b): an issued invoice credited in
 * full, with the invoice issued in its place. Laid out to meet the ATO's
 * requirements for an adjustment note: it says it is an adjustment note;
 * names the supplier with its ABN; names the recipient (required where the
 * original invoice was $1,000 or more; always printed here); gives its date
 * and number, the original invoice and the reason; and shows the amount of
 * the adjustment, the GST adjustment and the difference between the price on
 * the original invoice and the adjusted price.
 *
 *   creditNote   { number, issuedAt, reason, currency, lines: [{ name,
 *                detail (a quieter second line), subtotal, gst, total }],
 *                subtotal, gst, total } (credited, positive)
 *   credited     { number, issuedAt, subtotal, gst, total } the original
 *   replacement  { number, subtotal, gst, total } the invoice issued in its place
 */
export async function generateCreditNotePdfBuffer({
  meta,
  quote,
  creditNote,
  credited,
  replacement,
  reference = null,
  creationDate = null,
}) {
  const biz = resolveBusiness(quote);
  const deliveryDefaults = (quote?.quoteCatalog || quote?.profile || {}).deliveryDefaults || {};
  const currency = creditNote.currency || "AUD";
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      info: {
        Title: `Adjustment note ${creditNote.number}`,
        Author: businessDisplayName(biz),
        Subject: `Adjustment note for ${credited.number}`,
        ...(creationDate ? { CreationDate: creationDate } : {}),
      },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc._footerRef = creditNote.number;
    doc._footerBizName = businessDisplayName(biz);
    renderHeader(doc, {
      quoteRef: creditNote.number,
      deliveryDefaults,
      biz,
      documentLabel: "Adjustment note",
      issuedAt: creditNote.issuedAt,
    });

    // Recipient, and the documents this note adjusts.
    const topY = doc.y;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(C.light);
    doc.text("ISSUED TO", M, topY);
    doc.font("Helvetica").fontSize(10).fillColor(C.dark);
    doc.text(meta?.contactName || meta?.customerName || meta?.title || meta?.label || "Customer", M, topY + 14, { width: 240 });
    let leftY = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    if (meta?.siteAddress) {
      doc.text(meta.siteAddress, M, leftY + 2, { width: 240 });
      leftY = doc.y;
    }
    if (meta?.contactEmail) doc.text(meta.contactEmail, M, leftY + 2, { width: 240 });
    leftY = doc.y;

    doc.font("Helvetica-Bold").fontSize(8).fillColor(C.light);
    doc.text("ADJUSTMENT NOTE DETAILS", 300, topY, { width: CW - 250, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    const details = [
      `Issued: ${formatDate(creditNote.issuedAt)}`,
      `Original tax invoice: ${credited.number}`,
      credited.issuedAt ? `Invoice date: ${formatDate(credited.issuedAt)}` : null,
      reference ? `Job reference: ${reference}` : null,
      `Replaced by: ${replacement.number}`,
    ].filter(Boolean);
    details.forEach((line, index) => doc.text(line, 300, topY + 14 + index * 13, { width: CW - 250, align: "right" }));
    doc.y = Math.max(leftY + 10, topY + 18 + details.length * 13);

    // Why.
    addSpace(doc, 12);
    const reasonTop = doc.y;
    doc.font("Helvetica").fontSize(9);
    const reasonText = String(creditNote.reason || "");
    const reasonHeight = doc.heightOfString(reasonText, { width: CW - 28, lineGap: 3 }) + 32;
    doc.roundedRect(M, reasonTop, CW, reasonHeight, 4).fill(C.surfaceWarm);
    doc.fillColor(C.light).font("Helvetica-Bold").fontSize(9);
    doc.text("REASON FOR THE ADJUSTMENT", M + 14, reasonTop + 10, { lineBreak: false });
    doc.fillColor(C.body).font("Helvetica").fontSize(9);
    doc.text(reasonText, M + 14, reasonTop + 22, { width: CW - 28, lineGap: 3 });
    doc.y = reasonTop + reasonHeight + 16;

    // The adjustment, line by line.
    const cols = { item: M, exGst: M + 270, gst: M + 345, incGst: M + 410 };
    const rowEnd = W - M;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.light);
    doc.text("ADJUSTMENT", M, doc.y);
    doc.moveDown(0.4);
    const headY = doc.y;
    doc.rect(M, headY, CW, 18).fill(C.surfaceCool);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(C.muted);
    doc.text("Description", cols.item + 6, headY + 5, { lineBreak: false });
    doc.text("Ex GST", cols.exGst, headY + 5, { width: cols.gst - cols.exGst - 8, align: "right", lineBreak: false });
    doc.text("GST", cols.gst, headY + 5, { width: cols.incGst - cols.gst - 8, align: "right", lineBreak: false });
    doc.text("Inc GST", cols.incGst, headY + 5, { width: rowEnd - cols.incGst, align: "right", lineBreak: false });
    doc.y = headY + 22;
    for (const line of creditNote.lines) {
      const rowY = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(C.body);
      doc.text(line.name, cols.item + 6, rowY + 2, { width: cols.exGst - cols.item - 16 });
      if (line.detail) {
        doc.font("Helvetica").fontSize(8.5).fillColor(C.muted);
        doc.text(line.detail, cols.item + 6, doc.y + 1, { width: cols.exGst - cols.item - 16 });
        doc.font("Helvetica").fontSize(9).fillColor(C.body);
      }
      const height = Math.max(doc.y - rowY, 14);
      doc.text(formatMoney(-line.subtotal, currency), cols.exGst, rowY + 2, { width: cols.gst - cols.exGst - 8, align: "right", lineBreak: false });
      doc.text(formatMoney(-line.gst, currency), cols.gst, rowY + 2, { width: cols.incGst - cols.gst - 8, align: "right", lineBreak: false });
      doc.text(formatMoney(-line.total, currency), cols.incGst, rowY + 2, { width: rowEnd - cols.incGst, align: "right", lineBreak: false });
      doc.y = rowY + height + 6;
      doc.moveTo(M, doc.y).lineTo(rowEnd, doc.y).strokeColor(C.ruleLight).lineWidth(0.5).stroke();
      doc.y += 4;
    }

    // The totals of the adjustment.
    addSpace(doc, 10);
    const boxW = 260;
    const boxX = W - M - boxW;
    const boxTop = doc.y;
    doc.save();
    doc.roundedRect(boxX, boxTop, boxW, 76, 4).fill(C.surfaceWarm);
    doc.restore();
    doc.save();
    doc.rect(boxX, boxTop, 3, 76).fill(C.brand);
    doc.restore();
    const labelX = boxX + 16;
    const innerW = boxW - 32;
    doc.font("Helvetica").fillColor(C.body).fontSize(9.5);
    doc.text("Adjustment (ex GST)", labelX, boxTop + 12, { lineBreak: false });
    doc.text(formatMoney(-creditNote.subtotal, currency), labelX, boxTop + 12, { width: innerW, align: "right", lineBreak: false });
    doc.text("GST adjustment", labelX, boxTop + 28, { lineBreak: false });
    doc.text(formatMoney(-creditNote.gst, currency), labelX, boxTop + 28, { width: innerW, align: "right", lineBreak: false });
    doc.moveTo(labelX, boxTop + 44).lineTo(labelX + innerW, boxTop + 44).strokeColor(C.brandBorder).lineWidth(0.5).stroke();
    doc.font("Helvetica-Bold").fillColor(C.dark).fontSize(12);
    doc.text("Total credited", labelX, boxTop + 52, { lineBreak: false });
    doc.text(formatMoney(-creditNote.total, currency), labelX, boxTop + 52, { width: innerW, align: "right", lineBreak: false });
    doc.y = boxTop + 90;

    // The price difference: the original invoice against the adjusted price.
    ensurePageSpace(doc, 110);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.light);
    doc.text("PRICE DIFFERENCE", M, doc.y);
    doc.moveDown(0.4);
    const diffTop = doc.y;
    const diffCols = { label: M, exGst: M + 270, gst: M + 345, incGst: M + 410 };
    const diffRow = (label, subtotal, gst, total, { bold = false } = {}) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(bold ? C.dark : C.body);
      doc.text(label, diffCols.label, y, { width: diffCols.exGst - diffCols.label - 16, lineBreak: false });
      doc.text(formatMoney(subtotal, currency), diffCols.exGst, y, { width: diffCols.gst - diffCols.exGst - 8, align: "right", lineBreak: false });
      doc.text(formatMoney(gst, currency), diffCols.gst, y, { width: diffCols.incGst - diffCols.gst - 8, align: "right", lineBreak: false });
      doc.text(formatMoney(total, currency), diffCols.incGst, y, { width: rowEnd - diffCols.incGst, align: "right", lineBreak: false });
      doc.y = y + 16;
    };
    const cents = (value) => Math.round(Number(value || 0) * 100);
    const diff = (a, b) => (cents(a) - cents(b)) / 100;
    diffRow(`Original invoice ${credited.number}`, credited.subtotal, credited.gst, credited.total);
    diffRow(`Adjusted price: invoice ${replacement.number}`, replacement.subtotal, replacement.gst, replacement.total);
    doc.moveTo(M, doc.y).lineTo(rowEnd, doc.y).strokeColor(C.brandBorder).lineWidth(0.5).stroke();
    doc.y += 4;
    diffRow("Difference", diff(replacement.subtotal, credited.subtotal), diff(replacement.gst, credited.gst), diff(replacement.total, credited.total), { bold: true });
    doc.y = Math.max(doc.y, diffTop + 52) + 10;

    doc.font("Helvetica").fontSize(8.5).fillColor(C.muted);
    doc.text(`This adjustment note cancels tax invoice ${credited.number} in full. Tax invoice ${replacement.number} replaces it; any payment made against ${credited.number} is applied to ${replacement.number}.`, M, doc.y, { width: CW, lineGap: 2 });

    renderPageFooter(doc, creditNote.number);
    doc.end();
  });
}

// ── Color palette ──
const C = {
  brand: "#c8912a",
  brandLight: "#f4e6cc",
  brandBorder: "#dfc48a",
  dark: "#1a1a1a",
  body: "#2d2d2d",
  muted: "#6b6b6b",
  light: "#999999",
  rule: "#e0e0e0",
  ruleLight: "#eeeeee",
  bg: "#ffffff",
  surfaceWarm: "#faf8f4",
  surfaceCool: "#f5f5f5",
};

const W = 595.28; // A4 width in points
const M = 50; // margin
const CW = W - M * 2; // content width

function renderQuotePdf(doc, {
  meta,
  quote,
  images,
  sitePlanPng,
  documentType = "quote",
  invoicePaidAmount = null,
  scheduleView = null,
  milestoneLayout = null,
  reconstructed = false,
}) {
  const delivery = quote.delivery || { status: "draft" };
  const quoteCatalog = quote.quoteCatalog || quote.profile || {};
  const deliveryDefaults = quoteCatalog.deliveryDefaults || {};
  const biz = resolveBusiness(quote);
  const bank = biz.paymentMethods?.bankTransfer || {};
  const currency = quote.totals?.currency || "AUD";
  const allCustomerScheduleItems = scheduleView?.items || getCustomerScheduleItems(quote);
  // Filter out items excluded from price for the customer-facing PDF
  const customerScheduleItems = allCustomerScheduleItems.filter((item) => !item.excludedFromPrice);
  const milestoneInvoice = meta?.milestoneInvoice || null;
  const vLabel = `v${String(quote.version || 1).padStart(3, "0")}`;
  const isReceipt = documentType === "receipt";
  const isInvoice = documentType === "invoice";
  const isPaymentDocument = isInvoice || isReceipt;
  const documentLabel = getJobDocumentLabel(documentType);
  const isDraft = !isPaymentDocument && delivery.status !== "final";
  const quoteRef = isInvoice
    ? invoiceDocumentRef({ meta, quote, milestoneInvoice })
    : isReceipt
      ? buildReceiptDocumentNumber({ meta, quote, milestoneInvoice })
    : (quote.quoteNumber || meta.quoteNumber || meta.id);
  const activePayments = (milestoneInvoice?.payments || []).filter((payment) => !payment?.voidedAt);
  const latestPayment = activePayments[activePayments.length - 1] || null;
  const issuedAt = isInvoice
    ? (
        milestoneInvoice?.issuedAt
        || meta?.invoiceSentAt
        || (milestoneInvoice ? null : meta?.landedAt)
        || new Date().toISOString()
      )
    : isReceipt
      ? (
          milestoneInvoice?.paidAt
          || latestPayment?.date
          || latestPayment?.recordedAt
          || milestoneInvoice?.issuedAt
          || new Date().toISOString()
        )
    : quote.generatedAt;

  // Recalculate customer-facing totals from visible schedule items (respects exclusions + manual items)
  const pdfQuote = buildExclusionAdjustedQuote(quote, scheduleView?.financials);
  const invoicePaymentSummary = isPaymentDocument
    ? buildInvoicePaymentSummary({ meta, quote: pdfQuote, invoicePaidAmount })
    : null;

  // Stash footer info so ensurePageSpace can render it before page breaks
  doc._footerRef = quoteRef;
  doc._footerV = vLabel;
  doc._footerBizName = businessDisplayName(biz);

  // ─── PAGE 1: HEADER ───
  renderHeader(doc, {
    isDraft,
    vLabel,
    quoteRef,
    quote,
    deliveryDefaults,
    biz,
    documentType,
    documentLabel: invoiceTitle({ documentLabel, isInvoice, milestoneInvoice, legacy: milestoneLayout?.legacy }),
    issuedAt,
    reconstructed: Boolean(reconstructed),
  });

  // ─── CLIENT + BUSINESS DETAILS ───
  renderParties(doc, {
    meta,
    quote,
    documentType,
    documentLabel,
    issuedAt,
    invoicePaymentSummary,
  });

  // ─── SCOPE SUMMARY ───
  if (quote.summary) {
    addSpace(doc, 16);
    renderScopeSummary(doc, quote.summary);
  }

  // ─── SITE PLAN (if provided) ───
  if (sitePlanPng?.length) {
    renderPageFooter(doc, quoteRef);
    doc.addPage({ layout: "landscape" });
    renderSitePlanPage(doc, sitePlanPng, quoteRef);
    doc.addPage(); // back to portrait for pricing
    renderHeader(doc, { isDraft, vLabel, quoteRef, quote, deliveryDefaults, biz });
  }

  if (isInvoice && milestoneInvoice && !milestoneLayout?.legacy) {
    // ─── CLAIM LINES (step 4b, #28) ───
    // A milestone invoice claims a share of the quote: one claim line per
    // milestone it bills, against the quote it references, with its
    // subtotal, GST and total. The quote's schedule is the quote's
    // document; only a small summary of the contract is printed here.
    addSpace(doc, 20);
    renderClaimLines(doc, { milestoneInvoice, quoteReference: milestoneLayout?.quoteReference, currency });
    addSpace(doc, 14);
    renderClaimTotalsBox(doc, { milestoneInvoice, currency });
    addSpace(doc, 14);
    renderQuoteSummary(doc, {
      quote: pdfQuote,
      milestoneInvoice,
      priorClaimsTotal: sumPriorMilestoneClaims({ meta, milestoneInvoice }),
      quoteReference: milestoneLayout?.quoteReference,
      currency,
    });
  } else {
    // A quote, a receipt, an invoice without milestones, and a pre-4b
    // milestone invoice drawn again in the layout it was issued with.
    // ─── LINE ITEMS TABLE ───
    addSpace(doc, 20);
    renderLineItemsTable(doc, customerScheduleItems, currency, {
      heading: isInvoice ? "CONTRACT SCHEDULE" : "PRICING SCHEDULE",
      subheading: isInvoice
        ? "Full scope from the approved quote. This invoice claims a portion shown below."
        : null,
    });

    // ─── TOTALS / CLAIM ───
    addSpace(doc, 14);
    if (isInvoice && milestoneInvoice) {
      renderProgressClaimBox(doc, {
        quote: pdfQuote,
        milestoneInvoice,
        priorClaimsTotal: sumPriorMilestoneClaims({ meta, milestoneInvoice }),
        currency,
      });
    } else {
      renderTotalsBox(doc, pdfQuote, currency);
      if (invoicePaymentSummary) {
        addSpace(doc, 12);
        renderInvoicePaymentSummary(doc, invoicePaymentSummary);
      }
    }

    // ─── VARIETY PROFILES (after totals, before payment) ───
    const varietyProfiles = quote.varietyProfiles || [];
    if (varietyProfiles.length) {
      addSpace(doc, 20);
      renderVarietyProfiles(doc, varietyProfiles);
    } else if (images?.length) {
      addSpace(doc, 12);
      renderVarietyImages(doc, images);
    }
  }

  // ─── PAYMENT (stays with pricing) ───
  addSpace(doc, 16);
  renderPaymentDetails(doc, {
    meta,
    quote,
    deliveryDefaults,
    biz,
    bank,
    quoteRef: quoteRef === DRAFT_INVOICE_REF ? null : quoteRef,
    documentType,
    milestoneInvoice,
    // A step 4b invoice names its quote the way the claim line does.
    milestoneReference: isInvoice && milestoneInvoice && milestoneLayout && !milestoneLayout.legacy
      ? milestoneReferenceLine(milestoneInvoice, milestoneLayout.quoteReference)
      : null,
  });

  // ─── Footer on pricing page ───
  renderPageFooter(doc, quoteRef);

  if (!isPaymentDocument) {
    // ─── TERMS on a new page ───
    doc.addPage();
    renderTermsPage(doc);

    // ─── Footer on final page ───
    renderPageFooter(doc, quoteRef);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SECTIONS
// ═══════════════════════════════════════════════════════════════════════

function renderHeader(doc, {
  quoteRef,
  deliveryDefaults,
  biz,
  documentLabel,
  issuedAt,
  reconstructed = false,
}) {
  // Top accent bar
  doc.save();
  doc.rect(0, 0, W, 6).fill(C.brand);
  doc.restore();

  // Business name block
  doc.fillColor(C.dark).font("Helvetica-Bold").fontSize(22);
  doc.text(configuresBusinessName() ? businessDisplayName(biz) : (deliveryDefaults.issuerName || businessDisplayName(biz)), M, 30);

  doc.font("Helvetica").fontSize(9).fillColor(C.muted);
  const bizY = 56;
  doc.text(`ABN ${biz.abn}`, M, bizY);
  doc.text(biz.address, M, bizY + 12);
  doc.text(`${biz.phone}  ·  ${biz.email}`, M, bizY + 24);

  // Document title + ref block (right side)
  // A longer title ("Adjustment note") is set smaller so it clears the business name.
  doc.fillColor(C.dark).font("Helvetica-Bold").fontSize(String(documentLabel || "").length > 8 ? 22 : 28);
  doc.text(documentLabel, 300, 30, { width: CW - 250, align: "right" });

  doc.font("Helvetica").fontSize(9).fillColor(C.muted);
  doc.text(quoteRef, 300, 60, { width: CW - 250, align: "right" });
  doc.text(formatDate(issuedAt), 300, 72, { width: CW - 250, align: "right" });
  if (reconstructed) {
    // Drawn again because the stored PDF was lost: never passed off as the
    // copy that was sent.
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.brand);
    doc.text("Reconstructed copy", 300, 86, { width: CW - 250, align: "right" });
  }

  // Separator
  doc.moveTo(M, 104).lineTo(W - M, 104).strokeColor(C.rule).lineWidth(0.5).stroke();
  doc.y = 114;
}

function renderParties(doc, {
  meta,
  quote,
  documentType,
  documentLabel,
  issuedAt,
  invoicePaymentSummary = null,
}) {
  const topY = doc.y;
  const isReceipt = documentType === "receipt";
  const isInvoice = documentType === "invoice";
  const isPaymentDocument = isInvoice || isReceipt;
  const milestoneInvoice = meta?.milestoneInvoice || null;

  // Left: Prepared for
  doc.font("Helvetica-Bold").fontSize(8).fillColor(C.light);
  doc.text(
    isReceipt
      ? "RECEIPT FOR"
      : isInvoice
        ? "INVOICED TO"
        : "PREPARED FOR",
    M,
    topY
  );
  const clientName = meta.contactName || meta.title || meta.label || "Client";
  doc.font("Helvetica").fontSize(10).fillColor(C.dark);
  doc.text(clientName, M, topY + 14);
  if (meta.siteAddress && meta.contactName) {
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    doc.text(meta.siteAddress, M, topY + 28);
  }

  // Right: Job reference
  doc.font("Helvetica-Bold").fontSize(8).fillColor(C.light);
  doc.text(`${documentLabel.toUpperCase()} DETAILS`, 300, topY, { width: CW - 250, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor(C.body);
  const invoiceStatusLabel = isPaymentDocument
    ? formatInvoiceStatusLabel({ milestoneInvoice, invoicePaymentSummary })
    : null;
  const items = isPaymentDocument
    ? [
        isDraftInvoice(milestoneInvoice) && !isReceipt ? null : `${isReceipt ? "Received" : "Issued"}: ${formatDate(issuedAt)}`,
        // A receipt names the invoice it pays.
        isReceipt && (milestoneInvoice?.issuedReceipt?.invoiceNumber || milestoneInvoice?.issuedRevision?.invoiceNumber || milestoneInvoice?.invoiceNumber)
          ? `For invoice: ${milestoneInvoice.issuedReceipt?.invoiceNumber || milestoneInvoice.issuedRevision?.invoiceNumber || milestoneInvoice.invoiceNumber}`
          : null,
        !isReceipt && milestoneInvoice?.dueDate ? `Due: ${formatDate(milestoneInvoice.dueDate)}` : null,
        // An issued invoice (INV-…) names its job and the quote it bills,
        // as its Xero invoice's Reference does (#93): "Job 2610-07 · Quote
        // EQ-2610-07 v2". Issued PDFs are stored and never drawn again, so
        // only invoices issued from this change print it.
        !isReceipt && milestoneInvoice?.issuedRevision?.jobReference
          ? `Reference: ${jobQuoteReference({
            jobReference: milestoneInvoice.issuedRevision.jobReference,
            quoteNumber: milestoneInvoice.reference || quote?.quoteNumber || meta?.quoteNumber,
            quoteVersion: milestoneInvoice.issuedRevision.quoteVersion,
          })}`
          : null,
        // An invoice issued in place of a credited one says which.
        !isReceipt && milestoneInvoice?.issuedRevision?.creditNoteNumber && milestoneInvoice.issuedRevision.supersedesInvoiceNumber
          ? `Replaces: ${milestoneInvoice.issuedRevision.supersedesInvoiceNumber}`
          : null,
        !isReceipt && milestoneInvoice?.issuedRevision?.creditNoteNumber
          ? `Credit note: ${milestoneInvoice.issuedRevision.creditNoteNumber}`
          : null,
        milestoneInvoice?.milestoneLabel
          ? `Milestone: ${milestoneInvoice.milestoneLabel}${milestoneInvoice?.milestoneCount ? ` (${Number(milestoneInvoice.milestoneIndex || 0) + 1} of ${milestoneInvoice.milestoneCount})` : ""}`
          : null,
        invoiceStatusLabel ? `Status: ${invoiceStatusLabel}` : null,
      ]
    : [
        `Issued: ${formatDate(issuedAt)}`,
        `Valid for: ${(quote.presentation?.validityDays || quote.quoteCatalog?.deliveryDefaults?.validityDays || 14)} days`,
      ];
  const detailLines = items.filter(Boolean);
  detailLines.forEach((line, i) => {
    doc.text(line, 300, topY + 14 + i * 13, { width: CW - 250, align: "right" });
  });

  doc.y = topY + Math.max(56, 18 + detailLines.length * 13);
}

function renderScopeSummary(doc, summary) {
  const boxTop = doc.y;

  // Measure text to determine box height
  doc.font("Helvetica").fontSize(9);
  const textTop = boxTop + 22;
  const textHeight = doc.heightOfString(summary, { width: CW - 28, lineGap: 3 });
  const boxHeight = textHeight + 32;

  // Background box
  doc.roundedRect(M, boxTop, CW, boxHeight, 4).fill(C.surfaceWarm);

  // Section label
  doc.fillColor(C.light).font("Helvetica-Bold").fontSize(9);
  doc.text("SCOPE OF WORKS", M + 14, boxTop + 10, { lineBreak: false });

  // Summary text — supports bullet-point format with newlines
  doc.fillColor(C.body).font("Helvetica").fontSize(9);
  doc.text(summary, M + 14, textTop, { width: CW - 28, lineGap: 3 });

  doc.y = boxTop + boxHeight + 4;
}

function renderVarietyImages(doc, images) {
  if (!images?.length) return;

  const count = images.length;
  const gap = 10;
  const imgW = (CW - gap * (count - 1)) / count;
  const imgH = Math.round(imgW * 0.52);
  const totalH = imgH + 18; // image + label + padding

  ensurePageSpace(doc, totalH + 10);

  const rowTop = doc.y;

  for (let i = 0; i < count; i++) {
    const x = M + i * (imgW + gap);
    const img = images[i];
    // Strip leading number prefix from label (e.g. "1 Prestige Buffalo" → "Prestige Buffalo")
    const label = img.label.replace(/^\d+\s+/, "");
    try {
      doc.image(img.path, x, rowTop, { width: imgW, height: imgH, cover: [imgW, imgH] });
    } catch {
      // draw placeholder box if image fails
      doc.rect(x, rowTop, imgW, imgH).fill(C.surfaceCool);
    }
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.dark);
    doc.text(label, x, rowTop + imgH + 3, { width: imgW, align: "center", lineBreak: false });
  }

  doc.y = rowTop + totalH;
}

function renderVarietyProfiles(doc, profiles) {
  if (!profiles?.length) return;

  // Section heading — styled like Terms & Conditions
  doc.font("Helvetica-Bold").fontSize(16).fillColor(C.dark);
  doc.text("Lawn Varieties", M, doc.y);
  doc.moveDown(0.3);
  doc.moveTo(M, doc.y).lineTo(W - M, doc.y).strokeColor(C.rule).lineWidth(0.5).stroke();
  doc.moveDown(0.6);

  for (const profile of profiles) {
    const imgH = 85;
    ensurePageSpace(doc, imgH + 60);

    const imgTop = doc.y;

    // Banner image — clip to target rect, position based on cropY (0=top, 0.5=center, 1=bottom)
    if (profile.imagePath) {
      try {
        doc.save();
        doc.rect(M, imgTop, CW, imgH).clip();
        const imgObj = doc.openImage(profile.imagePath);
        const scaledH = (imgObj.height / imgObj.width) * CW;
        const overflow = Math.max(0, scaledH - imgH);
        const cropY = profile.cropY ?? 0.5;
        const yOffset = -overflow * cropY;
        doc.image(imgObj, M, imgTop + yOffset, { width: CW });
        doc.restore();
      } catch {
        doc.rect(M, imgTop, CW, imgH).fill(C.surfaceCool);
      }
    }

    // Move cursor below image
    doc.y = imgTop + imgH + 8;

    // Name
    doc.font("Helvetica-Bold").fontSize(11).fillColor(C.dark);
    doc.text(profile.name, M, doc.y, { width: CW });
    doc.moveDown(0.15);

    // Description
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    doc.text(profile.description, M, doc.y, { width: CW, lineGap: 2 });
    doc.moveDown(1.2);
  }
}

function renderLineItemsTable(doc, lineItems, currency, {
  heading = "PRICING SCHEDULE",
  subheading = null,
} = {}) {
  ensurePageSpace(doc, 100 + (subheading ? 12 : 0));

  // Section heading
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.light);
  doc.text(heading, M, doc.y);
  doc.moveDown(0.3);
  if (subheading) {
    doc.font("Helvetica").fontSize(8.5).fillColor(C.muted);
    doc.text(subheading, M, doc.y, { width: CW });
  }
  doc.moveDown(0.5);

  // Column positions
  const cols = {
    item: M,
    qty: M + 260,
    rate: M + 330,
    total: M + 410,
  };
  const rowEnd = W - M;

  // Detect simplified mode: all items are "1 lot" → hide qty/rate columns
  const sourceRows = lineItems.filter((item) => item?.kind !== "group" && item?.kind !== "component");
  const allLot = sourceRows.length > 0 && sourceRows.every((item) => item.unit === "lot" && item.quantity === 1);

  // Table header
  const headerY = doc.y;
  doc.save();
  doc.rect(M, headerY - 2, CW, 18).fill(C.surfaceCool);
  doc.restore();

  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C.muted);
  doc.text("Item", cols.item + 6, headerY + 2);
  if (!allLot) {
    doc.text("Qty", cols.qty, headerY + 2);
    doc.text("Rate", cols.rate, headerY + 2);
  }
  doc.text("Amount", cols.total, headerY + 2, { width: rowEnd - cols.total, align: "right" });

  doc.y = headerY + 22;

  if (!lineItems.length) {
    doc.font("Helvetica").fillColor(C.muted).fontSize(10);
    doc.text("No priced line items have been generated yet.", cols.item + 6, doc.y);
    return;
  }

  let dataRowIndex = 0;

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];
    const isGroupRow = item?.kind === "group";
    // Canonical origin check — every renderer-emitted item carries origin now.
    // Fall back to the legacy sourceKind for any persisted data written before
    // the schema collapse.
    const isGeneratedDetailRow = item?.origin === "generated"
      || item?.sourceKind === "generated_component";
    const isSourceRow = (item?.kind === "source" || (!item?.kind && !isGroupRow)) && !isGeneratedDetailRow;
    const depth = Number(item?.depth || 0);

    // Determine row style: explicit rowStyle > depth-based default
    const effectiveStyle = item.rowStyle
      || (depth === 0 && (isSourceRow || isGroupRow) ? "branded" : null)
      || (isGroupRow || isSourceRow ? "bold" : "normal");

    // Branded section header
    if (effectiveStyle === "branded") {
      dataRowIndex = 0;
      let childCount = 0;
      for (let j = i + 1; j < lineItems.length; j++) {
        const nextStyle = lineItems[j]?.rowStyle || (Number(lineItems[j]?.depth || 0) === 0 ? "branded" : null);
        if (nextStyle === "branded") break;
        childCount++;
      }
      ensurePageSpace(doc, 22 + Math.min(childCount, 5) * 22);

      const sectionY = doc.y + 3;
      doc.save();
      doc.rect(M, sectionY - 2, CW, 19).fill(C.surfaceWarm);
      doc.rect(M, sectionY - 2, 3, 19).fill(C.brand);
      doc.restore();

      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.brand);
      doc.text(item.label, M + 12, sectionY + 2, { width: CW - 140 });
      if (item.amountVisible !== false) {
        doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.brand);
        doc.text(formatMoney(item.totalPrice, currency), cols.total, sectionY + 2, { width: rowEnd - cols.total, align: "right" });
      } else if (!item.amountBlank) {
        doc.font("Helvetica").fontSize(9).fillColor(C.muted);
        doc.text("Included", cols.total, sectionY + 2, { width: rowEnd - cols.total, align: "right" });
      }
      doc.y = sectionY + 21;
      continue;
    }

    const labelX = cols.item + 6 + Math.min(depth, 4) * 18;
    // Bold rows (depth ≤1) keep their children together unless the section is too tall for a full page
    if (effectiveStyle === "bold" && depth <= 1) {
      let childCount = 0;
      for (let j = i + 1; j < lineItems.length; j++) {
        if (Number(lineItems[j]?.depth || 0) <= depth) break;
        childCount++;
      }
      const sectionH = 22 + childCount * 22;
      const pageContentH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
      if (sectionH <= pageContentH) {
        ensurePageSpace(doc, sectionH);
      } else {
        ensurePageSpace(doc, 22 + Math.min(childCount, 2) * 22);
      }
    } else {
      ensurePageSpace(doc, 28);
    }
    const rowY = doc.y;

    if (dataRowIndex % 2 === 1 && effectiveStyle === "normal") {
      doc.save();
      doc.rect(M, rowY - 1, CW, 22).fill("#fafafa");
      doc.restore();
    }
    dataRowIndex++;

    const isBold = effectiveStyle === "bold";
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fillColor(C.dark).fontSize(9);
    doc.text(item.label, labelX, rowY + 2, { width: 340 - Math.min(depth, 4) * 18 });

    doc.font("Helvetica").fillColor(C.body).fontSize(9);
    if (!allLot && !isBold) {
      doc.text(`${formatQty(item.quantity)} ${item.unit}`, cols.qty, rowY + 2, { width: 60 });
      doc.text(formatMoney(item.unitPrice, currency), cols.rate, rowY + 2, { width: 70 });
    }
    doc.font(isBold ? "Helvetica-Bold" : "Helvetica").fillColor(C.dark);
    doc.text(
      item.amountVisible === false ? (item.amountBlank ? "" : "Included") : formatMoney(item.totalPrice, currency),
      cols.total,
      rowY + 2,
      { width: rowEnd - cols.total, align: "right" }
    );

    doc.y = rowY + 20;
    doc.moveTo(M, doc.y).lineTo(rowEnd, doc.y).strokeColor(C.ruleLight).lineWidth(0.5).stroke();
    doc.y += 2;
  }
}

function renderTotalsBox(doc, quote, currency) {
  ensurePageSpace(doc, 90);

  const boxW = 210;
  const boxX = W - M - boxW;
  const boxTop = doc.y;

  // Box background
  doc.save();
  doc.roundedRect(boxX, boxTop, boxW, 76, 4).fill(C.surfaceWarm);
  doc.restore();

  // Accent left edge
  doc.save();
  doc.rect(boxX, boxTop, 3, 76).fill(C.brand);
  doc.restore();

  const labelX = boxX + 16;
  const valueX = boxX + boxW - 16;

  // Subtotal
  doc.font("Helvetica-Bold").fillColor(C.dark).fontSize(13);
  doc.text("Subtotal", labelX, boxTop + 12);
  doc.text(formatMoney(quote.totals?.subtotal || 0, currency), labelX, boxTop + 12, { width: valueX - labelX, align: "right" });

  // GST
  doc.font("Helvetica").fillColor(C.body).fontSize(9.5);
  doc.text("GST (10%)", labelX, boxTop + 28);
  doc.text(formatMoney(quote.totals?.gst || 0, currency), labelX, boxTop + 28, { width: valueX - labelX, align: "right" });

  // Separator
  doc.moveTo(labelX, boxTop + 44).lineTo(valueX, boxTop + 44).strokeColor(C.brandBorder).lineWidth(0.5).stroke();

  // Total (inc. GST)
  doc.font("Helvetica").fillColor(C.body).fontSize(9.5);
  doc.text("Total (inc. GST)", labelX, boxTop + 52);
  doc.text(formatMoney(quote.totals?.total || 0, currency), labelX, boxTop + 52, { width: valueX - labelX, align: "right" });

  doc.y = boxTop + 86;
}

// An issued milestone invoice is a tax invoice, and says so (step 4b). A
// draft has no number yet and is not one; a pre-4b invoice drawn again keeps
// the title it was issued with.
function invoiceTitle({ documentLabel, isInvoice, milestoneInvoice, legacy = false }) {
  return isInvoice && milestoneInvoice && !legacy && !isDraftInvoice(milestoneInvoice) ? "Tax invoice" : documentLabel;
}

// One claim line per milestone the invoice bills: the claim in plain words
// ("Deposit: 50% of the quoted price"), the quote on a quieter second line
// ("Quote EQ-2610-03, accepted 14 September 2026"), and its subtotal, GST
// and total (server/invoices/customer-wording.js).
function renderClaimLines(doc, { milestoneInvoice, quoteReference = null, currency }) {
  const cols = { item: M, exGst: M + 270, gst: M + 345, incGst: M + 410 };
  const rowEnd = W - M;
  ensurePageSpace(doc, 80);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.light);
  doc.text("CLAIM", M, doc.y);
  doc.moveDown(0.4);
  const headY = doc.y;
  doc.rect(M, headY, CW, 18).fill(C.surfaceCool);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(C.muted);
  doc.text("Description", cols.item + 6, headY + 5, { lineBreak: false });
  doc.text("Ex GST", cols.exGst, headY + 5, { width: cols.gst - cols.exGst - 8, align: "right", lineBreak: false });
  doc.text("GST", cols.gst, headY + 5, { width: cols.incGst - cols.gst - 8, align: "right", lineBreak: false });
  doc.text("Inc GST", cols.incGst, headY + 5, { width: rowEnd - cols.incGst, align: "right", lineBreak: false });
  doc.y = headY + 24;
  const rowY = doc.y;
  doc.save();
  doc.rect(M, rowY - 2, 3, 30).fill(C.brand);
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.dark);
  doc.text(claimDescription(milestoneInvoice), cols.item + 10, rowY, { width: cols.exGst - cols.item - 20 });
  const nameBottom = doc.y;
  const quoteLine = quoteReferenceLine(quoteReference);
  if (quoteLine) {
    doc.font("Helvetica").fontSize(8.5).fillColor(C.muted);
    doc.text(quoteLine, cols.item + 10, nameBottom + 1, { width: cols.exGst - cols.item - 20 });
  }
  const rowBottom = doc.y;
  doc.font("Helvetica").fontSize(9.5).fillColor(C.body);
  doc.text(formatMoney(milestoneInvoice.subtotal, currency), cols.exGst, rowY, { width: cols.gst - cols.exGst - 8, align: "right", lineBreak: false });
  doc.text(formatMoney(milestoneInvoice.gst, currency), cols.gst, rowY, { width: cols.incGst - cols.gst - 8, align: "right", lineBreak: false });
  doc.text(formatMoney(milestoneInvoice.total, currency), cols.incGst, rowY, { width: rowEnd - cols.incGst, align: "right", lineBreak: false });
  doc.y = Math.max(rowBottom, rowY + 28) + 6;
  doc.moveTo(M, doc.y).lineTo(rowEnd, doc.y).strokeColor(C.ruleLight).lineWidth(0.5).stroke();
  doc.y += 4;
}

// The invoice's totals. The labels and their order are what
// server/invoices/issued-totals.js reads back from an issued invoice.
function renderClaimTotalsBox(doc, { milestoneInvoice, currency }) {
  const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
  const boxW = 260;
  const boxX = W - M - boxW;
  const height = 84;
  ensurePageSpace(doc, height + 10);
  const boxTop = doc.y;
  doc.save();
  doc.roundedRect(boxX, boxTop, boxW, height, 4).fill(C.surfaceWarm);
  doc.restore();
  doc.save();
  doc.rect(boxX, boxTop, 3, height).fill(C.brand);
  doc.restore();
  const labelX = boxX + 16;
  const innerW = boxW - 32;
  let y = boxTop + 12;
  doc.font("Helvetica").fillColor(C.body).fontSize(9.5);
  doc.text("This claim (ex GST)", labelX, y, { lineBreak: false });
  doc.text(formatMoney(round2(milestoneInvoice.subtotal), currency), labelX, y, { width: innerW, align: "right", lineBreak: false });
  y += 15;
  doc.text("GST (10%)", labelX, y, { lineBreak: false });
  doc.text(formatMoney(round2(milestoneInvoice.gst), currency), labelX, y, { width: innerW, align: "right", lineBreak: false });
  y += 13;
  doc.moveTo(labelX, y + 4).lineTo(labelX + innerW, y + 4).strokeColor(C.brandBorder).lineWidth(0.5).stroke();
  y += 13;
  doc.font("Helvetica-Bold").fillColor(C.dark).fontSize(13);
  doc.text("Amount Due", labelX, y, { lineBreak: false });
  doc.text(formatMoney(round2(milestoneInvoice.total), currency), labelX, y, { width: innerW, align: "right", lineBreak: false });
  doc.font("Helvetica").fillColor(C.muted).fontSize(8);
  doc.text("Total including GST", labelX, y + 17, { lineBreak: false });
  doc.y = boxTop + height + 10;
}

// "Milestone 1 of 2 for Quote EQ-2610-03, accepted 14 September 2026.": the
// payment terms' milestone reference, in the claim line's words.
function milestoneReferenceLine(milestoneInvoice, quoteReference) {
  const quoteLine = quoteReferenceLine(quoteReference);
  if (!quoteLine) return null;
  const position = Number(milestoneInvoice.milestoneIndex || 0) + 1;
  const count = Number(milestoneInvoice.milestoneCount) > 0 ? Number(milestoneInvoice.milestoneCount) : position;
  return `Milestone ${position} of ${count} for ${quoteLine}.`;
}

// The contract this invoice claims against, as a two-column summary the
// width of the claim table: labels left, amounts right-aligned (Helvetica's
// figures are all one width, so the amounts line up as tabular figures),
// then a hairline and what remains after this claim, emphasised.
function renderQuoteSummary(doc, { quote, milestoneInvoice, priorClaimsTotal, quoteReference = null, currency }) {
  const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
  const contractTotal = round2(quote?.totals?.total);
  const previous = round2(priorClaimsTotal);
  const thisClaim = round2(milestoneInvoice.total);
  const remaining = round2(contractTotal - previous - thisClaim);
  const left = M + 6;
  const right = W - M;
  ensurePageSpace(doc, 110);
  const headY = doc.y;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.light);
  doc.text("QUOTE SUMMARY", M, headY, { lineBreak: false });
  doc.font("Helvetica").fontSize(8).fillColor(C.muted);
  doc.text("All amounts include GST", M, headY + 1, { width: CW, align: "right", lineBreak: false });
  doc.y = headY + 15;
  const quoteLine = quoteReferenceLine(quoteReference);
  if (quoteLine) {
    doc.font("Helvetica").fontSize(8.5).fillColor(C.muted);
    doc.text(quoteLine, left, doc.y, { width: CW - 6 });
    doc.y += 5;
  }
  const row = (label, value, { bold = false } = {}) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5).fillColor(bold ? C.dark : C.body);
    doc.text(label, left, y, { lineBreak: false });
    doc.text(formatMoney(value, currency), M, y, { width: CW, align: "right", lineBreak: false });
    doc.y = y + 15;
  };
  row("Contract value", contractTotal);
  row("Previously claimed", previous);
  row("This claim", thisClaim);
  doc.moveTo(M, doc.y).lineTo(right, doc.y).strokeColor(C.rule).lineWidth(0.5).stroke();
  doc.y += 5;
  row("Remaining after this claim", remaining, { bold: true });
  doc.y += 2;
}

// The claim box of a milestone invoice issued before step 4b, for drawing
// one again in the layout it was issued with (unchanged from then).
function renderProgressClaimBox(doc, {
  quote,
  milestoneInvoice,
  priorClaimsTotal,
  currency,
}) {
  const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
  const contractTotal = round2(quote?.totals?.total);
  const thisSubtotal = round2(milestoneInvoice?.subtotal);
  const thisGst = round2(milestoneInvoice?.gst);
  const thisTotal = round2(milestoneInvoice?.total);
  const previousClaims = round2(priorClaimsTotal);

  const boxW = 260;
  const boxX = W - M - boxW;
  const height = 134;
  ensurePageSpace(doc, height + 10);
  const boxTop = doc.y;

  doc.save();
  doc.roundedRect(boxX, boxTop, boxW, height, 4).fill(C.surfaceWarm);
  doc.restore();

  doc.save();
  doc.rect(boxX, boxTop, 3, height).fill(C.brand);
  doc.restore();

  const labelX = boxX + 16;
  const valueX = boxX + boxW - 16;
  const innerW = valueX - labelX;

  // Title
  doc.font("Helvetica-Bold").fillColor(C.light).fontSize(8);
  doc.text("THIS CLAIM", labelX, boxTop + 10, { lineBreak: false });

  let y = boxTop + 26;

  // Contract value (inc GST)
  doc.font("Helvetica").fillColor(C.body).fontSize(9.5);
  doc.text("Contract value (inc GST)", labelX, y, { lineBreak: false });
  doc.text(formatMoney(contractTotal, currency), labelX, y, { width: innerW, align: "right", lineBreak: false });
  y += 15;

  // Previously claimed
  doc.text("Previously claimed", labelX, y, { lineBreak: false });
  doc.text(formatMoney(previousClaims, currency), labelX, y, { width: innerW, align: "right", lineBreak: false });
  y += 13;

  // Separator
  doc.moveTo(labelX, y + 4).lineTo(valueX, y + 4).strokeColor(C.brandBorder).lineWidth(0.5).stroke();
  y += 11;

  // This claim subtotal
  doc.text("This claim (ex GST)", labelX, y, { lineBreak: false });
  doc.text(formatMoney(thisSubtotal, currency), labelX, y, { width: innerW, align: "right", lineBreak: false });
  y += 15;

  // GST
  doc.text("GST (10%)", labelX, y, { lineBreak: false });
  doc.text(formatMoney(thisGst, currency), labelX, y, { width: innerW, align: "right", lineBreak: false });
  y += 13;

  // Separator
  doc.moveTo(labelX, y + 4).lineTo(valueX, y + 4).strokeColor(C.brandBorder).lineWidth(0.5).stroke();
  y += 11;

  // Amount Due (prominent)
  doc.font("Helvetica-Bold").fillColor(C.dark).fontSize(13);
  doc.text("Amount Due", labelX, y, { lineBreak: false });
  doc.text(formatMoney(thisTotal, currency), labelX, y, { width: innerW, align: "right", lineBreak: false });

  doc.y = boxTop + height + 10;
}

function sumPriorMilestoneClaims({ meta, milestoneInvoice }) {
  if (!milestoneInvoice || !Array.isArray(meta?.milestoneInvoices)) return 0;
  const currentIndex = Number(milestoneInvoice.milestoneIndex || 0);
  let sum = 0;
  for (const other of meta.milestoneInvoices) {
    if (!other) continue;
    if (Number(other.milestoneIndex || 0) >= currentIndex) continue;
    sum += Number(other.total || 0);
  }
  return Math.round(sum * 100) / 100;
}

function renderInvoicePaymentSummary(doc, paymentSummary) {
  ensurePageSpace(doc, 104);

  const boxW = 210;
  const boxX = W - M - boxW;
  const boxTop = doc.y;

  doc.save();
  doc.roundedRect(boxX, boxTop, boxW, 94, 4).fill(C.surfaceCool);
  doc.restore();

  doc.save();
  doc.rect(boxX, boxTop, 3, 94).fill(C.brand);
  doc.restore();

  const labelX = boxX + 16;
  const valueX = boxX + boxW - 16;

  doc.font("Helvetica-Bold").fillColor(C.dark).fontSize(10);
  doc.text("Payment Summary", labelX, boxTop + 12);

  doc.font("Helvetica").fillColor(C.body).fontSize(9.5);
  doc.text("Invoice Total", labelX, boxTop + 30);
  doc.text(
    formatMoney(paymentSummary.total, paymentSummary.currency),
    labelX,
    boxTop + 30,
    { width: valueX - labelX, align: "right" }
  );
  doc.text("Amount Paid", labelX, boxTop + 48);
  doc.text(
    formatMoney(paymentSummary.paid, paymentSummary.currency),
    labelX,
    boxTop + 48,
    { width: valueX - labelX, align: "right" }
  );
  doc.text("Amount Outstanding", labelX, boxTop + 66);
  doc.text(
    formatMoney(paymentSummary.outstanding, paymentSummary.currency),
    labelX,
    boxTop + 66,
    { width: valueX - labelX, align: "right" }
  );

  doc.y = boxTop + 104;
}

function renderPaymentDetails(doc, {
  meta,
  quote,
  deliveryDefaults,
  biz,
  bank,
  quoteRef,
  documentType,
  milestoneInvoice = null,
  milestoneReference = null,
}) {
  const isReceipt = documentType === "receipt";
  const paymentSchedule = !isReceipt
    ? resolvePaymentSchedule({ meta, quote })
    : null;
  const quotePaymentSchedule = documentType === "quote" ? paymentSchedule : null;
  const latestPayment = milestoneInvoice?.payments?.[milestoneInvoice.payments.length - 1] || null;
  const quoteScheduleHeight = quotePaymentSchedule?.milestones?.length
    ? 28 + (quotePaymentSchedule.milestones.length * 14)
    : 0;
  ensurePageSpace(doc, (milestoneInvoice ? 128 : 82) + quoteScheduleHeight);

  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.light);
  doc.text(
    isReceipt
      ? "RECEIPT DETAILS"
      : documentType === "invoice"
        ? "PAYMENT TERMS"
        : "PAYMENT DETAILS",
    M,
    doc.y
  );
  doc.moveDown(0.4);

  const startY = doc.y;

  const bankX = 310;
  const termsWidth = 220;

  if (isReceipt) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
    doc.text("Receipt Note", M, startY);
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    doc.text(
      "Payment has been received for this milestone invoice. Keep this receipt as the paid record for the job milestone below.",
      M,
      startY + 14,
      { width: termsWidth, lineGap: 2 }
    );
    let leftEndY = doc.y;

    if (milestoneInvoice?.contextNote) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
      doc.text("Milestone Reference", M, leftEndY + 8);
      doc.font("Helvetica").fontSize(9).fillColor(C.body);
      doc.text(milestoneInvoice.contextNote, M, leftEndY + 22, { width: termsWidth, lineGap: 2 });
      leftEndY = doc.y;
    }

    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
    doc.text("Receipt Reference", bankX, startY);
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    if (quoteRef) {
      doc.text(`Receipt: ${quoteRef}`, bankX, startY + 14);
    }
    if (milestoneInvoice?.invoiceNumber) {
      doc.text(`Invoice: ${milestoneInvoice.invoiceNumber}`, bankX, startY + 27);
    }
    if (milestoneInvoice?.paidAt) {
      doc.text(`Paid on: ${formatDate(milestoneInvoice.paidAt)}`, bankX, startY + 40);
    }
    if (latestPayment?.reference) {
      doc.text(`Payment ref: ${latestPayment.reference}`, bankX, startY + 53);
    }
    const receiptEndY = startY + (latestPayment?.reference ? 66 : 53);
    doc.y = Math.max(leftEndY + 8, receiptEndY);
    return;
  }

  // Left column: payment terms
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
  doc.text("Payment Terms", M, startY);
  doc.font("Helvetica").fontSize(9).fillColor(C.body);
  const paymentTerms = resolveQuotePaymentTerms({
    deliveryDefaults,
    paymentSchedule,
    currency: quote?.totals?.currency || "AUD",
  });
  const termsY = startY + 14;
  doc.text(paymentTerms, M, termsY, { width: termsWidth, lineGap: 2 });
  let leftEndY = doc.y;

  if (milestoneInvoice?.dueDate) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
    doc.text("Due Date", M, leftEndY + 8);
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    doc.text(formatDate(milestoneInvoice.dueDate), M, leftEndY + 22, { width: termsWidth });
    leftEndY = doc.y;
  }

  if (milestoneReference || milestoneInvoice?.contextNote) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
    doc.text("Milestone Reference", M, leftEndY + 8);
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    doc.text(milestoneReference || milestoneInvoice.contextNote, M, leftEndY + 22, { width: termsWidth, lineGap: 2 });
    leftEndY = doc.y;
  }

  if (quotePaymentSchedule?.milestones?.length) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
    doc.text("Milestone Schedule", M, leftEndY + 8);
    doc.font("Helvetica").fontSize(9).fillColor(C.body);
    doc.text(
      quotePaymentSchedule.milestones
        .map((milestone, index) => formatQuotePaymentMilestone(milestone, index, quote?.totals?.currency || "AUD"))
        .join("\n"),
      M,
      leftEndY + 22,
      { width: termsWidth, lineGap: 2 }
    );
    leftEndY = doc.y;
  }

  // Right column: bank details (from business profile, not hardcoded)
  doc.font("Helvetica-Bold").fontSize(9).fillColor(C.dark);
  doc.text("Bank Transfer", bankX, startY);
  doc.font("Helvetica").fontSize(9).fillColor(C.body);
  doc.text(`Account: ${bank.accountName || biz.legalName}`, bankX, startY + 14);
  doc.text(`BSB: ${bank.bsb}`, bankX, startY + 27);
  doc.text(`Account No: ${bank.accountNumber}`, bankX, startY + 40);
  doc.text(`Bank: ${bank.bank}`, bankX, startY + 53);
  if (quoteRef) {
    doc.text(`Ref: ${quoteRef}`, bankX, startY + 66);
  }

  const bankEndY = startY + (quoteRef ? 83 : 70);
  doc.y = Math.max(leftEndY + 8, bankEndY);
}

function formatQuotePaymentMilestone(milestone, index, currency = "AUD") {
  const dueDays = Number.isFinite(Number(milestone?.dueDays)) && Number(milestone.dueDays) > 0
    ? ` (${Math.round(Number(milestone.dueDays))} day${Math.round(Number(milestone.dueDays)) === 1 ? "" : "s"})`
    : "";
  const fixedTotal = Number(milestone?.fixedTotal || 0);
  const value = fixedTotal > 0
    ? `${formatMoney(fixedTotal, currency)}${Number(milestone?.percentage || 0) > 0 ? ` (${formatQuotePaymentPercentage(milestone?.percentage)}%)` : ""}`
    : `${formatQuotePaymentPercentage(milestone?.percentage)}%`;
  return `${index + 1}. ${milestone?.label || `Milestone ${index + 1}`} - ${value}${dueDays}`;
}

export function resolveQuotePaymentTerms({
  deliveryDefaults = {},
  paymentSchedule = null,
  currency = "AUD",
} = {}) {
  const fallbackTerms = deliveryDefaults.paymentTerms
    || "Payment due prior to commencement unless otherwise agreed.";
  const milestones = paymentSchedule?.milestones;
  if (!Array.isArray(milestones) || !milestones.length || isDefaultQuotePaymentSchedule(milestones)) {
    return fallbackTerms;
  }

  const scheduleSummary = milestones
    .map((milestone, index) => {
      const label = String(milestone?.label || `Milestone ${index + 1}`).trim();
      const fixedTotal = Number(milestone?.fixedTotal || 0);
      const value = fixedTotal > 0
        ? `${formatMoney(fixedTotal, currency)}${Number(milestone?.percentage || 0) > 0 ? ` (${formatQuotePaymentPercentage(milestone.percentage)}%)` : ""}`
        : `${formatQuotePaymentPercentage(milestone?.percentage)}%`;
      return `${label} - ${value}`;
    })
    .join("; ");

  return `Payments are due according to the saved milestone schedule: ${scheduleSummary}.`;
}

function isDefaultQuotePaymentSchedule(milestones) {
  return milestones.length === DEFAULT_PAYMENT_SCHEDULE.milestones.length
    && milestones.every((milestone, index) => {
      const defaultMilestone = DEFAULT_PAYMENT_SCHEDULE.milestones[index];
      return String(milestone?.label || "").trim().toLowerCase() === defaultMilestone.label.toLowerCase()
        && Number(milestone?.percentage || 0) === defaultMilestone.percentage
        && !(Number(milestone?.fixedTotal || 0) > 0)
        && !(Number(milestone?.dueDays || 0) > 0);
    });
}

function formatQuotePaymentPercentage(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2).replace(/\.?0+$/, "");
}

function renderPageFooter(doc, quoteRef) {
  const footerY = doc.page.height - 28;
  const savedY = doc.y;
  doc.moveTo(M, footerY - 10).lineTo(W - M, footerY - 10).strokeColor(C.ruleLight).lineWidth(0.5).stroke();

  // Temporarily remove bottom margin so text placement doesn't trigger a new page
  const savedBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.font("Helvetica").fontSize(7).fillColor(C.light);
  const bizName = doc._footerBizName || businessDisplayName(applyBusinessProfileOverride(BUSINESS_DEFAULTS));
  doc.text(`${bizName}  ·  ${quoteRef}`, M, footerY, { width: CW, align: "center", lineBreak: false });
  doc.page.margins.bottom = savedBottom;
  doc.y = savedY;
}

function renderSitePlanPage(doc, sitePlanPng, quoteRef) {
  // Landscape A4: 841.89 x 595.28 points
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const margin = 40;

  // Title bar
  doc.save();
  doc.rect(0, 0, pageW, 24).fill(C.dark);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(C.brand);
  doc.text("SITE PLAN", margin, 7, { continued: false });
  doc.font("Helvetica").fontSize(8).fillColor("#999999");
  doc.text(`Ref: ${quoteRef}`, pageW - margin - 120, 9, { width: 120, align: "right" });
  doc.restore();

  // Embed the site plan PNG
  const imgMaxW = pageW - margin * 2;
  const imgMaxH = pageH - margin - 60; // leave room for footer
  try {
    doc.image(sitePlanPng, margin, 34, {
      fit: [imgMaxW, imgMaxH],
      align: "center",
      valign: "center",
    });
  } catch {
    doc.font("Helvetica").fontSize(10).fillColor(C.muted);
    doc.text("Site plan image could not be rendered.", margin, pageH / 2, {
      width: imgMaxW,
      align: "center",
    });
  }

  renderPageFooter(doc, quoteRef);
}

// ═══════════════════════════════════════════════════════════════════════
// PAGE 2: TERMS + ASSUMPTIONS + OUTSTANDING
// ═══════════════════════════════════════════════════════════════════════

function renderTermsPage(doc) {
  const topY = doc.y;

  // Page title
  doc.font("Helvetica-Bold").fontSize(16).fillColor(C.dark);
  doc.text("Terms & Conditions", M, topY);
  doc.moveDown(0.6);

  // Separator
  doc.moveTo(M, doc.y).lineTo(W - M, doc.y).strokeColor(C.rule).lineWidth(0.5).stroke();
  doc.moveDown(0.8);

  // Standard terms — use stored terms if available (loaded before render)
  const storedTerms = globalThis.__fieldCachedTerms;
  if (storedTerms && storedTerms.length > 0) {
    for (const term of storedTerms) {
      renderTermsSection(doc, term.title, term.body);
    }
  } else {
    renderTermsSection(doc, "Scope", "This quote covers only the works described in the pricing schedule above. Any additional works, variations, or unforeseen conditions will be quoted separately before commencement.");
    renderTermsSection(doc, "Site Access", "The client is responsible for providing clear and safe access to the work area. Any delays caused by restricted access may result in additional charges.");
    renderTermsSection(doc, "Unforeseen Conditions", "If unforeseen ground conditions (rock, contaminated soil, underground services, water) are encountered, additional costs will be quoted and agreed before proceeding.");
    renderTermsSection(doc, "Permits & Approvals", "Unless stated otherwise, council permits, engineering certifications, and any third-party approvals are the responsibility of the client and are not included in this quote.");
  }

  // Assumptions and outstanding items are internal metadata — not shown to customers
}

function renderTermsSection(doc, title, body) {
  ensurePageSpace(doc, 40);
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(C.dark);
  doc.text(title, M, doc.y);
  doc.moveDown(0.15);
  doc.font("Helvetica").fontSize(9).fillColor(C.body);
  doc.text(body, M, doc.y, { width: CW, lineGap: 2 });
  doc.moveDown(0.6);
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function ensurePageSpace(doc, height) {
  if (doc.y + height <= doc.page.height - doc.page.margins.bottom) return;
  if (doc._footerRef) renderPageFooter(doc, doc._footerRef);
  doc.addPage();
}

function addSpace(doc, amount) {
  doc.moveDown(amount / 12);
}

function formatMoney(value, currency) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(value || 0);
}

function formatQty(value) {
  if (Number.isInteger(value)) return String(value);
  return Number(value || 0).toFixed(2).replace(/\.00$/, "");
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-AU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// What an invoice prints as its number. A milestone invoice that has not
// been issued has no number yet: the issue service allocates INV-YYYY-M-N
// when it is issued (server/invoices/issue.js), so its preview says so
// rather than printing the provisional EI-… number it is tracked under.
const DRAFT_INVOICE_REF = "Draft, not yet issued";

function isDraftInvoice(milestoneInvoice) {
  return Boolean(milestoneInvoice) && !milestoneInvoice.issuedRevision && String(milestoneInvoice.status || "draft") === "draft";
}

function invoiceDocumentRef({ meta, quote, milestoneInvoice }) {
  if (isDraftInvoice(milestoneInvoice)) return DRAFT_INVOICE_REF;
  return buildInvoiceDocumentNumber({ meta, quote, milestoneInvoice });
}

function formatInvoiceStatusLabel({ milestoneInvoice = null, invoicePaymentSummary = null } = {}) {
  if (milestoneInvoice?.status === "draft") return null;
  if ((invoicePaymentSummary?.outstanding || 0) > 0) return "Outstanding";
  return "Paid";
}

function buildExclusionAdjustedQuote(quote, financials = null) {
  const totals = financials || getCustomerPresentationFinancials(quote);
  return {
    ...quote,
    totals: {
      ...(quote.totals || {}),
      subtotal: totals.subtotal,
      gst: totals.gst,
      total: totals.total,
    },
  };
}
