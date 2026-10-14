import express from "express";
import { readFileSync, existsSync } from "./storage/fs.js";
import { mkdir, readdir, readFile, writeFile, stat, rm } from "./storage/fs-promises.js";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "./storage/fs.js";
import { setDataRoot } from "./storage/write-recorder.js";
import { closeDb, getDb, runMigrations } from "./db-runtime/index.js";
import { assertRowSecurity, requestOrgUid, resolveDeploymentOrg } from "./db-runtime/tenancy.js";
import { createQuoteSnapshotStore, createUnavailableQuoteSnapshotStore } from "./quote-snapshots.js";
import { createIssuedDocumentService } from "./documents/issued-documents.js";
import { createIssuedDocumentRecorder, createUnavailableIssuedDocumentRecorder, installIssuedDocumentRecorder } from "./documents/recorder.js";
import { registerIssuedDocumentRoutes } from "./documents/routes.js";
import { createQuoteRowService } from "./quotes/quote-rows.js";
import { createQuoteRowRecorder, createUnavailableQuoteRowRecorder, installQuoteRowRecorder } from "./quotes/recorder.js";
import { loadQuoteRows, quoteReadsStatus, quoteRowsFromArtifact } from "./quotes/read-model.js";
import { createInvoiceRowService } from "./invoices/invoice-rows.js";
import { createInvoiceRowRecorder, createUnavailableInvoiceRowRecorder, installInvoiceRowRecorder } from "./invoices/recorder.js";
import { createInvoiceIssueService, createUnavailableInvoiceIssuer, installInvoiceIssuer } from "./invoices/issue.js";
import { creditNoteAttachment, creditNoteNumberFor } from "./invoices/credit-note-attachment.js";
import {
  EMAIL_ATTACHMENT_LIMITS,
  EmailAttachmentError,
  assertEmailAttachmentLimits,
  documentAttachmentRecord,
  documentMimeAttachments,
  loadDocumentAttachments,
  parseDocumentRefs,
} from "./documents/email-attachments.js";
import { recordAttachedDocumentsEmailed } from "./documents/delivery.js";
import { applyMergeFields, applyMergeFieldsToText } from "../shared/email-templates.js";
import { adjustmentNoteValues, buildEmailMergeValues } from "./email-merge-fields.js";
import { PENDING_NUMBER_TEXT, isDraftInvoice, jobQuoteForEmail, readEmailDocumentView, registerEmailComposeRoutes, withPendingNumber } from "./email-compose-routes.js";
import { resolveReplyThread } from "./email-threads.js";
import { CREDIT_NOTE_ON_REISSUE_CHOICES, createBusinessSettingsService } from "./invoices/business-settings.js";
import { createMilestoneRuleService, installMilestoneRules, MILESTONE_CAP_KINDS, MILESTONE_CAP_MODES, MILESTONE_RULE_VALUE_BASES, resolveBusinessRegion } from "./invoices/milestone-rules.js";
import { AU_REGIONS } from "../shared/regions.js";
import { createXeroHttp } from "./xero/client.js";
import { fakeXeroBaseUrl, readXeroSecrets, xeroEndpoints } from "./xero/config.js";
import { createXeroConnectionService } from "./xero/connection.js";
import { loadSecretsKeyring } from "./secrets/keyring.js";
import { createCredentialStore } from "./secrets/credentials.js";
import { createIntegrationSetup } from "./secrets/setup.js";
import { registerSecretsKeyRoutes } from "./secrets/routes.js";
import { createXeroInvoiceSync } from "./xero/invoice-sync.js";
import { registerXeroRoutes } from "./xero/routes.js";
import { assertQuoteRowsIfMatch, currentQuoteRowsTag } from "./quotes/concurrency.js";

// A job detail's quote read from its rows (#10), kept beside the detail object.
const jobDetailQuoteRows = new WeakMap();
import { createPostgresBlobStore, createReplicaFallbackBlobStore } from "./documents/blob-store.js";
import { resolveDocumentReplicaConfig } from "./documents/r2-config.js";
import { createR2ObjectStore } from "./documents/r2-client.js";
import { createDisabledReplicator, createDocumentReplicator } from "./documents/replicator.js";
import { startDurableStorage } from "./storage/durable-store.js";
import { heldDataMigrations, runDataMigrations } from "./data-migrations/index.js";
import { createDataMigrationDryRunHandler, DRY_RUN_PATH as DATA_MIGRATIONS_DRY_RUN_PATH } from "./data-migrations/dry-run-route.js";
import { AMOUNT_DISAGREEMENTS_PATH, AMOUNT_SETTLE_PATH, createInvoiceAmountDisagreementsHandler, createInvoiceAmountSettleHandler } from "./invoices/amount-routes.js";
import { businessDisplayName } from "./business-profile.js";
import { registerSqliteImage } from "./storage/durable-hooks.js";
import {
  createClerkAuth,
  createClerkAuthRouter,
  loadClerkAdapter,
  resolveAuthorizedParties,
  resolveClerkKeys,
  resolveFieldAuthMode,
  resolveOwnerVerificationConfig,
} from "./auth/clerk-auth.js";
import { createClerkFrontendApiProxy, resolveClerkProxyPath } from "./auth/clerk-proxy.js";
import { resolveTrustProxy } from "./auth/trust-proxy.js";
import rateLimit from "express-rate-limit";
import { addressLimitOptions, createRateLimits, describeConfiguredBudgets, resolveRateLimitBudgets } from "./rate-limits.js";
import multer from "multer";
import { assertNoRemovedIntegrationConfig } from "./config-guard.js";
import { renderDemoBootstrapPage } from "./demo-bootstrap-page.js";
import { loadFieldConfig, resolveFieldPort } from "./runtime-config.js";
import { deployedBuildStatus } from "./deployed-build.js";
import { createUpdateChecker } from "./update-check.js";
import { applyStoredGmailOAuthUsers, saveGmailOAuthUser } from "./gmail-oauth-store.js";
import { hasGoogleServiceAccountKey } from "./google-service-account.js";
import { registerGmailOAuthRoutes } from "./gmail-oauth-routes.js";
import {
  initFieldSentry,
  reportBackgroundError,
  sentryBrowserBootstrapScript,
  sentryErrorResponseReporter,
  sentryPublicStatus,
  setupSentryExpress,
} from "./observability/sentry.js";
import { JOB_LIST_PER_JOB_MS, listJobsWithinDeadline, withDeadline } from "./job-list-guard.js";
import { assertCommit, assertDigest, assertVerificationConfig } from "../scripts/verification/contract.js";
import { ensureVerificationFixtureState } from "../scripts/verification/start.js";
import { uploadMoasureBatchToDrive, getDriveClient } from "./drive-upload.js";
import {
  DEFAULT_QUOTE_CATALOG_ID,
  configureBusinessProfile,
  getCommercialAuthorityStatus,
  getQuoteCatalog,
  hasQuoteCatalog,
  listQuoteCatalogs,
  readQuoteCatalogReference,
  refreshQuoteCatalogAuthority,
  serializeQuoteCatalog,
} from "./quote-catalogs.js";
import {
  deleteQuoteVersion,
  generateQuotePdfBuffer,
  getNextQuoteVersion,
  listQuoteVersions,
  parseQuoteVersion,
  readQuoteArtifacts,
  formatQuoteVersionLabel,
  writeQuoteArtifacts,
  writeQuoteVersionSnapshot,
} from "./quote-artifacts.js";
import { buildIssuedInvoicePdfFilename } from "./invoice-pdf-filename.js";
import {
  applyMilestoneInvoiceCompatFields,
  coerceInvoicePaidAmount,
  getMilestoneInvoiceRevisions,
  normalizePaymentSchedule,
  resolveJobDocumentType,
  resolveRequestedMilestoneInvoice,
} from "./job-documents.js";
import { buildQuoteEvidencePack } from "./quote-evidence-pack.js";
import {
  buildAndPersistQuote,
  buildQuoteInStagedGeneration,
  readQuoteOverrides,
} from "./quote-workflow.js";
import { markQuoteBuilt, readQuoteLifecycle, recordQuoteArchived, recordQuotePipelineStageChange } from "./quote-lifecycle.js";
import { applyQuoteIdentity, ensureQuoteIdentityMeta } from "./quote-identity.js";
import { getMoasurePaths, readMoasureSummary, removeMoasureFile, scanMoasure, storeMoasureUpload } from "./moasure.js";
import { buildQuoteProofSummary } from "./quote-proof.js";
import {
  assertQuotePricingDisplayable,
  attachQuotePricingAttestation,
  withCurrentPricingVerdict,
  buildQuotePricingAttestation,
  isIssuedQuoteVersion,
  isQuotePricingDisplayable,
} from "./quote-pricing-attestation.js";
import {
  getDisplayableJobReport,
  getDisplayableQuoteMarkdown,
  sanitizePricingSurface,
  serializeClientJobDetail,
  sanitizeQuoteForPricingDisplay,
  sanitizeClientJobMeta,
} from "./quote-pricing-visibility.js";
import { buildReviewState, findReviewItem, restoreStatusForResolvedGap } from "./review-state.js";
import {
  applyJobQuoteCatalogChanges,
  generateJobMilestones,
  readJobMilestoneRules,
  markJobLanded,
  markJobMilestoneUnsent,
  markJobMilestoneUnpaid,
  migrateJobMilestoneInvoices,
  readJobQuoteCatalogChanges,
  recordJobMilestonePayment,
  regenerateRecordingQuote,
  creditAndReissueJobMilestoneInvoice,
  sendJobQuote,
  setJobPipelineStage,
  settleJobMilestoneInvoiceAmounts,
  updateJobMilestone,
  updateJobQuote,
  voidJobMilestonePayment,
} from "./job-actions.js";
import { GMAIL_SEND_SCOPES, assertAllowedQuoteRecipients, composeDocumentEmail, composeJobEmail, findSentMessageInMailbox, formatDeliveryMessageId, hasServiceAccountGmail, resetGmailClient, resolveGmailDelegatedUser, resolveGmailLoginHint, resolveMailSender, resolveMessageIdHost, sendJobEmail, sendTestEmail } from "./send-quote-email.js";
import { GOOGLE_CONTACTS_READONLY_SCOPE, googleContactsHttpError, listGoogleContacts, resetGoogleContactsCache } from "./google-contacts.js";
import { appendSentEmailArchive, readSentEmailArchive } from "./sent-email-archive.js";
import { apiCachePolicy } from "./api-cache-policy.js";
import {
  RESEND_SETTLE_MS,
  classifyDeliveryFailure,
  createScheduledEmail,
  listScheduledEmails,
  rescheduleEmailDraft,
  saveEmailDraft,
  discardEmailDraft,
  normalizeHoldSeconds,
  returnScheduledEmailToDraft,
  sendEmailDraftNow,
  startScheduledEmailScheduler,
} from "./scheduled-email-queue.js";
import { google } from "googleapis";
import {
  addJobNote,
  appendJobActivity,
  applyDetailsToMeta,
  archiveJob,
  ensureJobState,
  previewJobState,
  setGapState,
  updateJobDetailField,
} from "./job-state.js";
import {
  initUsers,
  ensureUser,
  authenticateUser,
  resolveBootstrapUsers,
  createUser,
  updateUser,
  updatePassword,
  deleteUser,
  findUserByToken,
  findUserByEmail,
  findUserById,
  listUsers,
  addToken,
  revokeToken,
  revokeAllTokens,
  revokeTokenByPlaintext,
  listUserTokens,
  recordTokenUse,
  tokenIdForPlaintext,
} from "./users.js";
import { createAccessAuditStore } from "./auth/access-audit.js";
import { createAccessEventsRouter, createPasswordTokenRouter } from "./auth/token-access.js";
import { initEmailTemplates, listEmailTemplates, updateEmailTemplate } from "./email-templates.js";
import { generateEvidenceQuoteMarkdown } from "./generate-evidence-quote.js";
import { applyPresentationToQuote, getCustomerPresentationFinancials } from "./quote-presentation.js";
import { openCatalogStore } from "./catalog/index.js";
import {
  buildPriceCatalogRuntimeStatus,
  initializePriceCatalogRuntime,
  resolvePriceCatalogStartupPolicy,
} from "./price-catalog/catalog-runtime.js";
import { createPriceCatalogRouter } from "./price-catalog/catalog-api.js";
import {
  createRemoteMcpRouter,
  createFieldMcpService,
  MCP_SCOPES,
  resolveRemoteMcpRuntimeConfig,
} from "./mcp/remote-mcp.js";
import { authorizeFieldMcpScopes } from "./mcp/scope-authority.js";
import {
  resolveWallRateCard,
  resolveWallRequiredPriceCodes,
} from "./price-catalog/wall-rate-card.js";
import { assertPriceCatalogSnapshotComplete } from "./price-catalog/catalog-snapshot.js";
import { RATE_CARD_REQUIRED_PRICE_CODES } from "./retaining-wall-rate-card.js";
import {
  buildInternalBreakdownMarkdown,
} from "./quote-internal-breakdown.js";
import { buildWallZoneRenderPayloadForJob, readWallZones } from "./wall-zones.js";
import { runExclusiveJobMutation } from "./job-mutation-guard.js";
import { installJobGenerationCommitListener, resolveActiveJobGeneration, runAtomicJobGeneration } from "./job-generation.js";
import {
  findIssuedQuoteVersion,
  readIssuedQuoteArtifact,
  readQuoteIssuanceLedger,
} from "./quote-issuance.js";
import { resolveQuoteCatalogIdFromMeta } from "./quote-catalog-ids.js";
import { getFieldDb, getFieldDbHandle, rebaseJobDirs, reconcileJobIndex, upsertJob, findJobInDb, listJobsFromDb, insertNote, getNotesForJob, getJobLog, deleteNote, deleteJob } from "./field-db.js";
import { JOB_NOT_DELETABLE_ERROR, assessJobDeletion } from "./job-deletion.js";
import {
  buildQuoteEditPolicy,
  shouldForkQuoteMutation,
} from "./quote-edit-policy.js";
import { readDocumentQuoteArtifacts, readPreparedJobDocument, readSelectedReportMarkdown, resolveIssuedMilestoneInvoiceArtifact, resolveIssuedQuotePdf } from "./job-document-context.js";
import { hydrateJobMeta, readJobMeta, writeJobMeta } from "./job-meta-store.js";
import { renderRetainingWallStandaloneHtml } from "../shared/retaining-wall-render.js";
import {
  readSelectedQuoteVersionArtifacts,
} from "./quote-version-context.js";
import {
  normalizeQuoteBuildState,
} from "./quote-build-state.js";

let config;
let CONFIG_SOURCE;
try {
  ({ config, source: CONFIG_SOURCE } = loadFieldConfig({ defaultPath: join(import.meta.dirname, "../config.json") }));
} catch (err) {
  console.error(`[field] ${err.message}`);
  process.exit(1);
}
const IS_VERIFICATION_RUNTIME = process.env.FIELD_ENV === "field-verification";
const PRICE_CATALOG_STARTUP_POLICY = resolvePriceCatalogStartupPolicy({
  env: process.env,
  isVerificationRuntime: IS_VERIFICATION_RUNTIME,
});
const DATA_DIR = resolve(process.env.FIELD_DATA || config.dataDir || join(import.meta.dirname, "../data"));
// Writes under DATA_DIR go through the storage shim, which reports them to
// durable storage when FIELD_STORAGE=postgres (server/storage/durable-store.js).
setDataRoot(DATA_DIR);
const VERIFICATION_DATA_DIR = resolve("/var/lib/field-verification/data");
let VERIFICATION_IMAGE_DIGEST = null;
let VERIFICATION_FIELD_REVISION = null;
let RATE_LIMIT_BUDGETS;
try {
  assertNoRemovedIntegrationConfig(config, CONFIG_SOURCE);
  // Rate limit budgets (server/rate-limits.js): the defaults, or what
  // config.rateLimits changes. A wrong value stops Field here.
  RATE_LIMIT_BUDGETS = resolveRateLimitBudgets(config.rateLimits);
  const tunedBudgets = describeConfiguredBudgets(RATE_LIMIT_BUDGETS);
  if (tunedBudgets) console.log(`[field] rate limits from ${CONFIG_SOURCE}: ${tunedBudgets}`);
  if (IS_VERIFICATION_RUNTIME) {
    if (DATA_DIR !== VERIFICATION_DATA_DIR) throw new Error("field-verification data path must use the isolated container mount");
    assertVerificationConfig(config, { dataDir: VERIFICATION_DATA_DIR });
    VERIFICATION_IMAGE_DIGEST = assertDigest(process.env.FIELD_IMAGE_DIGEST, "FIELD_IMAGE_DIGEST");
    VERIFICATION_FIELD_REVISION = assertCommit(process.env.FIELD_REVISION, "FIELD_REVISION");
  }
  // The installation's own business identity and payment details, merged over
  // the quote catalogue's (server/business-profile.js). Never logged.
  if (configureBusinessProfile(config.businessProfile)) {
    console.log(`[field] business profile: configured in ${CONFIG_SOURCE}, merged over the quote catalogue's`);
  }
} catch (err) {
  console.error(`[field] ${err.message}`);
  process.exit(1);
}

const PORT = resolveFieldPort({ config });
const AUTH_TOKEN = process.env.FIELD_TOKEN || config.authToken;
// Human sign-in: FIELD_AUTH=clerk signs people in with Clerk; unset keeps
// password login. Decided once at boot; an unknown value stops Field.
let FIELD_AUTH_MODE;
try {
  FIELD_AUTH_MODE = resolveFieldAuthMode(process.env);
} catch (err) {
  console.error(`[auth] ${err.message}`);
  process.exit(1);
}
// Issued documents in R2 (#12): FIELD_DOCUMENT_REPLICA=r2 copies issued
// document bytes to a locked R2 bucket after they are stored in PostgreSQL.
// Decided once at boot; with replication on, a missing or malformed FIELD_R2_*
// variable stops Field here. The message names the variable, never its value.
// In a Replit workspace without FIELD_R2_ALLOW_WORKSPACE=1 the setting is
// ignored with one warning and nothing is written to R2.
let DOCUMENT_REPLICA_CONFIG;
try {
  DOCUMENT_REPLICA_CONFIG = resolveDocumentReplicaConfig(process.env);
} catch (err) {
  console.error(`[documents-replica] ${err.message}`);
  process.exit(1);
}
if (DOCUMENT_REPLICA_CONFIG.warning) console.warn(`[documents-replica] ${DOCUMENT_REPLICA_CONFIG.warning}`);
const UI_CONFIG = {
  deploymentTheme: process.env.FIELD_DEPLOY_THEME || config.deploymentTheme || "gohub",
  workerDisplayName: process.env.FIELD_WORKER_DISPLAY_NAME || config.workerDisplayName || "Agent",
  assistantDisplayName: process.env.FIELD_ASSISTANT_DISPLAY_NAME || config.assistantDisplayName || "",
  // The name stock email signatures sign with.
  businessName: businessDisplayName(getQuoteCatalog()?.businessProfile),
};

if (!AUTH_TOKEN) {
  console.error("FIELD_TOKEN or config.authToken required");
  process.exit(1);
}
await initFieldSentry();

await mkdir(DATA_DIR, { recursive: true });

// PostgreSQL: FIELD_DB_URL or DATABASE_URL; PGlite only when asked for
// (FIELD_PGLITE=1 or FIELD_PGLITE_DIR, local development). Pending migrations
// are applied before anything else touches the database; Field does not start
// on a database it cannot migrate. With no database configured nothing is
// opened and getDb() fails closed; the price catalogue below then refuses to
// boot unless its emergency override is set.
//
// Tenancy: this deployment serves one organisation (FIELD_ORG, else the
// default organisation); every tenant table is behind row-level security, and
// Field does not start on a database role for which RLS would not hold.
let deploymentOrg = null;
try {
  const migrations = await runMigrations();
  if (migrations.skipped) {
    console.log(`[db] ${migrations.target}: migrations skipped; features that need PostgreSQL will refuse to run`);
  } else {
    console.log(`[db] ${migrations.target}: ${migrations.applied} migration(s) applied now, ${migrations.total} in total`);
    const rls = await assertRowSecurity(getDb());
    deploymentOrg = await resolveDeploymentOrg(getDb());
    console.log(`[db] organisation ${deploymentOrg.slug} (${deploymentOrg.uid}); row-level security enforced ${rls.via === "set-role" ? "by SET ROLE field_app" : `by FORCE ROW LEVEL SECURITY on role ${rls.user}`}`);
    if (rls.via === "set-role" && rls.loginBypasses) {
      console.warn(`[db] database role ${rls.user} bypasses RLS itself: only queries inside an organisation transaction (db-runtime/tenancy.js) are filtered`);
    }
  }
} catch (err) {
  console.error(`[db] migrations failed: ${err.message}`);
  process.exit(1);
}

// Durable storage: with FIELD_STORAGE=postgres the data directory is a
// working copy of PostgreSQL. Take the single-writer lock and rebuild it before
// anything below reads it; refuse to start if that fails. Unset: no-op.
let durableStorage = null;
try {
  durableStorage = await startDurableStorage({
    dataDir: DATA_DIR,
    onLockLost: (error) => {
      console.error(`[storage] ${error.message}; exiting so a restart rebuilds from PostgreSQL`);
      process.exit(1);
    },
  });
} catch (err) {
  console.error(`[storage] durable storage failed to start: ${err.message}`);
  process.exit(1);
}
if (durableStorage) {
  const boot = durableStorage.bootStats;
  console.log(
    boot.seeded
      ? `[storage] postgres: seeded ${boot.files} file(s) from ${DATA_DIR}`
      : `[storage] postgres: rebuilt ${DATA_DIR}: ${boot.files} file(s), ${boot.written} written, ${boot.unchanged} unchanged, ${boot.images} SQLite image(s)${boot.quarantined ? `, ${boot.quarantined} unknown local file(s) moved to ${boot.quarantineDir}` : ""}${boot.keptLocal ? `, ${boot.keptLocal} differing local file(s) copied to ${boot.quarantineDir} before restoring` : ""}`,
  );
  // The price catalogue lives in PostgreSQL tables, so field.db is the only
  // SQLite database left to image.
  registerSqliteImage("field.db", getFieldDbHandle);
}

// Gmail OAuth tokens granted at runtime live in the data directory; overlay
// them on any tokens still held in config.
try {
  applyStoredGmailOAuthUsers(config, DATA_DIR);
} catch (err) {
  console.warn(`[field] stored Gmail OAuth tokens unreadable; using config tokens only: ${err.message}`);
}
// The infrastructure compose contract may override the image CMD, so this
// safety-critical bootstrap belongs in the server process itself. It is a
// strict no-op outside the isolated synthetic verification runtime.
await ensureVerificationFixtureState();

// Initialize user accounts
await initUsers(DATA_DIR);
await initEmailTemplates(DATA_DIR);
for (const user of resolveBootstrapUsers({ config, authToken: AUTH_TOKEN })) {
  await ensureUser(user);
}

// Clerk sign-in (FIELD_AUTH=clerk). Field users and roles live in PostgreSQL,
// so this needs the database; the first boot imports users.json's people.
// Keys are read from the environment and never printed.
let clerkAuth = null;
let clerkPublicConfig = null;
// Clerk Frontend API proxy (CLERK_PROXY_URL, set by Replit's managed Clerk).
let clerkProxyMount = null;
// Set once the MCP router exists (further down); revokes a person's MCP
// installations when an owner removes or disables them.
let revokeMcpSubjects = async () => 0;
if (FIELD_AUTH_MODE === "clerk") {
  try {
    const keys = resolveClerkKeys(process.env);
    const ownerVerification = resolveOwnerVerificationConfig(process.env);
    const authorizedParties = resolveAuthorizedParties({ env: process.env, config });
    const db = getDb();
    clerkAuth = createClerkAuth({
      db,
      orgUid: deploymentOrg.uid,
      clerk: await loadClerkAdapter({ ...keys, authorizedParties }),
      legacy: { findUserByToken, findUserById, recordTokenUse },
      breakGlassKey: AUTH_TOKEN,
      ...ownerVerification,
    });
    console.log(`[auth] owner actions: second factor within ${ownerVerification.ownerMfaMaxAgeMinutes} min${ownerVerification.ownerGoogleDomains.length ? `, or Google Workspace sign-in on ${ownerVerification.ownerGoogleDomains.join(", ")} with no password` : " (FIELD_OWNER_GOOGLE_DOMAINS unset: Google Workspace path off)"}; Clerk authorized parties: ${authorizedParties.length ? authorizedParties.join(", ") : "Clerk default (FIELD_PUBLIC_ORIGIN unset)"}`);
    const imported = await clerkAuth.importLegacyUsers(listUsers());
    if (imported.imported) {
      console.log(`[auth] imported ${imported.imported} user(s) from users.json into PostgreSQL (admin -> owner, user -> staff)`);
    }
    clerkPublicConfig = { publishableKey: keys.publishableKey, proxyUrl: keys.proxyUrl };
    const clerkProxyPath = resolveClerkProxyPath(keys.proxyUrl);
    if (clerkProxyPath) {
      const { clerkFrontendApiProxy } = await import("@clerk/backend/proxy");
      clerkProxyMount = {
        path: clerkProxyPath,
        handler: createClerkFrontendApiProxy({
          proxyPath: clerkProxyPath,
          publishableKey: keys.publishableKey,
          secretKey: keys.secretKey,
          proxy: clerkFrontendApiProxy,
        }),
      };
      console.log(`[auth] Clerk Frontend API proxied at ${clerkProxyPath} (CLERK_PROXY_URL)`);
    }
    console.log(`[auth] Clerk sign-in on (CLERK_SECRET_KEY, ${keys.publishableSource}); password login retired, break-glass via X-Field-Break-Glass`);
  } catch (err) {
    console.error(`[auth] Clerk sign-in could not start: ${err.message}`);
    process.exit(1);
  }
}
// Price catalogue (PostgreSQL, server/catalog). Without a database, or with a
// catalogue that cannot price, boot stops unless the emergency override
// allows a degraded boot; the catalogue editor stays available whenever the
// database opened, so a degraded catalogue can be fixed in place.
let scheduledEmailScheduler = null;
let priceCatalogRuntime;
try {
  priceCatalogRuntime = await initializePriceCatalogRuntime({
    config,
    policy: PRICE_CATALOG_STARTUP_POLICY,
    isVerificationRuntime: IS_VERIFICATION_RUNTIME,
    openCatalogStore: () => openCatalogStore({
      orgUid: deploymentOrg?.uid,
      dataDir: DATA_DIR,
      catalogId: config.quoteCatalogId || DEFAULT_QUOTE_CATALOG_ID,
    }),
    refreshQuoteCatalogAuthority,
  });
} catch (error) {
  // A refused catalogue has been logged with its reason: an outage, not a
  // crash to trace. Anything else is a bug; show it.
  if (error?.code !== "FIELD_PRICE_CATALOG_UNAVAILABLE") console.error(error);
  process.exit(1);
}
const { priceCatalog, catalogStore, priceCatalogFailure } = priceCatalogRuntime;

// Quote snapshots: every quote, invoice and receipt send records what
// was sent in PostgreSQL before the email goes out. With no database, sends
// are refused rather than made without a record.
try {
  config.quoteSnapshots = createQuoteSnapshotStore({ db: getDb(), orgUid: deploymentOrg?.uid });
} catch (err) {
  console.warn(`[quote-snapshot] ${err.message}; quote and invoice sends will be refused`);
  config.quoteSnapshots = createUnavailableQuoteSnapshotStore(err.code === "FIELD_NO_DATABASE" ? "no database configured" : err.message);
}

// The R2 replica of issued document bytes (#12). PostgreSQL stays the store
// of record; with FIELD_DOCUMENT_REPLICA=r2 each blob is copied to R2 after
// its issue transaction commits, and a scheduler tick retries (and backfills)
// whatever is pending. R2 being down marks the replica degraded in /health and
// /api/storage/status; it never stops Field serving or issuing.
let documentReplica = createDisabledReplicator();
let issuedDocumentBlobs;
if (DOCUMENT_REPLICA_CONFIG.enabled) {
  if (!deploymentOrg) {
    console.warn("[documents-replica] FIELD_DOCUMENT_REPLICA=r2 needs the database, which this server does not have: nothing is replicated");
    documentReplica = createDisabledReplicator({ state: "degraded", code: "NO_DATABASE" });
  } else {
    const { connection } = DOCUMENT_REPLICA_CONFIG;
    const store = createR2ObjectStore(connection);
    documentReplica = createDocumentReplicator({ db: getDb(), orgUid: deploymentOrg.uid, store });
    issuedDocumentBlobs = createReplicaFallbackBlobStore({ replica: store });
    console.log(`[documents-replica] r2: bucket ${connection.bucket} at ${new URL(connection.endpoint).host}; issued document bytes are copied after each issue, pending ones retried every minute`);
    void documentReplica.refreshStatus();
    void documentReplica.checkBucket().then((check) => {
      if (check.ok) console.log(`[documents-replica] r2: bucket ${connection.bucket} reachable, credentials accepted`);
      else console.warn(`[documents-replica] r2: bucket ${connection.bucket} not usable (${check.code}); the replica is degraded, Field keeps serving and issuing from PostgreSQL`);
    });
  }
}

// Issued documents: every quote, invoice and receipt that is issued or
// emailed is also recorded in PostgreSQL by uid, with its exact bytes. The job
// files stay the source of truth for now: a failure here is logged and shown
// in /api/storage/status, never turned into a failed send.
let issuedDocumentRecorder;
try {
  issuedDocumentRecorder = createIssuedDocumentRecorder({
    service: createIssuedDocumentService({
      db: getDb(),
      orgUid: deploymentOrg?.uid,
      ...(issuedDocumentBlobs ? { blobs: issuedDocumentBlobs } : {}),
      onBlobsStored: (sha256s) => documentReplica.notifyStored(sha256s),
    }),
  });
} catch (err) {
  const reason = err.code === "FIELD_NO_DATABASE" ? "no database configured" : err.message;
  console.warn(`[issued-documents] ${reason}: issued documents are not recorded in PostgreSQL (the job files still hold them)`);
  issuedDocumentRecorder = createUnavailableIssuedDocumentRecorder(reason);
}
installIssuedDocumentRecorder(issuedDocumentRecorder);

// Integration secrets (#112, docs/INTEGRATIONS.md): credentials entered in
// Settings, Integrations, and OAuth tokens, per organisation, encrypted under
// FIELD_SECRETS_KEY (FIELD_SECRETS_KEY_PREVIOUS while rotating). Without a
// usable key, integrations fail closed. Boot re-encrypts values an earlier
// key wrote.
const secretsKeyring = loadSecretsKeyring(process.env);
if (secretsKeyring.problem) console.warn(`[secrets] ${secretsKeyring.problem}: integration credentials and tokens cannot be stored or read (docs/INTEGRATIONS.md)`);
// Settings, Team, Access (#133): who revoked a token or disconnected an agent.
const accessAudit = deploymentOrg ? createAccessAuditStore({ db: getDb(), orgUid: deploymentOrg.uid }) : null;
const integrationCredentials = deploymentOrg ? createCredentialStore({ db: getDb(), orgUid: deploymentOrg.uid, keyring: secretsKeyring }) : null;
if (integrationCredentials) await integrationCredentials.rewrap().catch((error) => console.warn(`[secrets] re-encrypting with the current key failed (${error?.code || "error"})`));
// The Connect wizard (docs/XERO.md): where the owner is, and credentials the
// browser encrypted with a key it generated before the deployment had it.
// Once FIELD_SECRETS_KEY is that key, boot stores them as the credentials.
const xeroSetup = deploymentOrg
  ? createIntegrationSetup({ db: getDb(), orgUid: deploymentOrg.uid, keyring: secretsKeyring, integration: "xero", fields: ["client_id", "client_secret"], valid: (values) => /^\S{8,200}$/.test(values.client_id) && /^\S{8,200}$/.test(values.client_secret) })
  : null;
if (xeroSetup) await xeroSetup.promote();

// Xero (#93, docs/XERO.md): the owner's own Xero app. Its client id and
// secret are entered in Settings (stored as above); XERO_CLIENT_ID and
// XERO_CLIENT_SECRET in the environment override them. The connection and
// its encrypted tokens are in PostgreSQL. Issued invoices go to Xero after
// their issue commits (server/xero/invoice-sync.js): the issued invoice rows
// are the outbox, so issuing and emailing never wait on Xero.
const xeroSecrets = readXeroSecrets(process.env);
const xeroHttpFor = (secrets) => createXeroHttp({ clientId: secrets.clientId, clientSecret: secrets.clientSecret, endpoints: xeroEndpoints(fakeXeroBaseUrl()) });
const xeroConnection = deploymentOrg
  ? createXeroConnectionService({ db: getDb(), orgUid: deploymentOrg.uid, keyring: secretsKeyring, credentialStore: integrationCredentials, environment: xeroSecrets, http: xeroHttpFor })
  : null;
if (xeroConnection) await xeroConnection.upgradeStoredTokens();
const xeroSyncIntervalMs = Number(process.env.FIELD_XERO_SYNC_INTERVAL_MS);
const xeroInvoiceSync = xeroConnection ? createXeroInvoiceSync({
  db: getDb(),
  orgUid: deploymentOrg.uid,
  connection: xeroConnection,
  http: () => xeroHttpFor(xeroSecrets),
  blobs: issuedDocumentBlobs || createPostgresBlobStore(),
  ...(Number.isFinite(xeroSyncIntervalMs) && xeroSyncIntervalMs >= 1000 ? { intervalMs: xeroSyncIntervalMs, firstDelayMs: xeroSyncIntervalMs } : {}),
}) : null;
if (xeroInvoiceSync) {
  xeroConnection.onChange((event) => { if (event.type !== "disconnected") xeroInvoiceSync.kick(); });
  xeroInvoiceSync.start();
}

// The invoice issue service (#28, step 4b): an invoice is issued when it is
// finalised (authorised, sent, revised), in one PostgreSQL transaction that
// allocates its INV-YYYY-M-N number, renders and stores its PDF and writes
// its row. Without a database, issuing an invoice is refused: it is never
// issued outside the sequence. After it commits, the Xero sync is told; it
// never runs inside the issue.
try {
  installInvoiceIssuer(createInvoiceIssueService({
    db: getDb(),
    orgUid: deploymentOrg?.uid,
    ...(issuedDocumentBlobs ? { blobs: issuedDocumentBlobs } : {}),
    onBlobsStored: (sha256s) => {
      xeroInvoiceSync?.kick();
      return documentReplica.notifyStored(sha256s);
    },
  }));
} catch (err) {
  const reason = err.code === "FIELD_NO_DATABASE" ? "this server has no database" : err.message;
  console.warn(`[invoice-issue] ${reason}: invoices cannot be issued (sending or authorising an invoice is refused)`);
  installInvoiceIssuer(createUnavailableInvoiceIssuer(reason));
}

// Quote rows (#6): every committed change to a job's quote versions is also
// written as quotes, quote_sections and quote_lines rows, checked against the
// totals Field shows. The job files stay the source of truth: a failure is
// logged and shown in /api/storage/status, never turned into a failed save.
let quoteRowRecorder;
try {
  quoteRowRecorder = createQuoteRowRecorder({
    service: createQuoteRowService({ db: getDb(), orgUid: deploymentOrg?.uid }),
    issuedDocuments: issuedDocumentRecorder.service || null,
  });
} catch (err) {
  const reason = err.code === "FIELD_NO_DATABASE" ? "no database configured" : err.message;
  console.warn(`[quote-rows] ${reason}: quote rows are not recorded in PostgreSQL (the job files still hold them)`);
  quoteRowRecorder = createUnavailableQuoteRowRecorder(reason);
}
installQuoteRowRecorder(quoteRowRecorder);

// Invoice rows (#27): every committed milestone change is also written as
// payment_milestones, invoices, payments and receipts rows, checked against
// what was issued and what Field shows. After the quote rows, so invoices
// link the quote versions they bill. The job files stay the source of truth:
// a failure is logged and shown in /api/storage/status, never turned into a
// failed action.
let invoiceRowRecorder;
try {
  invoiceRowRecorder = createInvoiceRowRecorder({
    service: createInvoiceRowService({ db: getDb(), orgUid: deploymentOrg?.uid }),
    quoteRows: quoteRowRecorder.service || null,
    issuedDocuments: issuedDocumentRecorder.service || null,
  });
} catch (err) {
  const reason = err.code === "FIELD_NO_DATABASE" ? "no database configured" : err.message;
  console.warn(`[invoice-rows] ${reason}: invoice rows are not recorded in PostgreSQL (the job files still hold them)`);
  invoiceRowRecorder = createUnavailableInvoiceRowRecorder(reason);
}
installInvoiceRowRecorder(invoiceRowRecorder);
installJobGenerationCommitListener(async (jobDir) => {
  await quoteRowRecorder.syncJob(jobDir, { reason: "job generation committed" });
  await invoiceRowRecorder.syncJob(jobDir, { reason: "job generation committed" });
});

// Initialize field database (SQLite — jobs + evidence tracking)
let fieldDb = null;
try {
  fieldDb = getFieldDb(DATA_DIR);
  const rebase = rebaseJobDirs(fieldDb, DATA_DIR);
  if (rebase.rebased > 0) console.log(`[field-db] Pointed ${rebase.rebased} of ${rebase.total} jobs at ${DATA_DIR}`);
  // Every boot, after durable storage has restored the data directory, so a
  // restored or older field.db never hides a job that is on disk (#32).
  const result = await reconcileJobIndex(fieldDb, DATA_DIR);
  console.log(`[field-db] ${result.total} jobs indexed${describeJobIndexRepair(result)}`);
} catch (err) {
  console.error(`[field-db] Init failed: ${err.message}`);
}

const priceCatalogRuntimeStatus = buildPriceCatalogRuntimeStatus({
  available: Boolean(priceCatalog),
  policy: PRICE_CATALOG_STARTUP_POLICY,
  error: priceCatalogFailure,
});

const app = express();
// Behind Replit's proxy every request comes from the proxy's address; `trust
// proxy` makes req.ip the client's (rate limits, break-glass's too, are per client).
// See server/auth/trust-proxy.js for the choice and FIELD_TRUST_PROXY.
let TRUST_PROXY;
try {
  TRUST_PROXY = resolveTrustProxy(process.env);
} catch (err) {
  console.error(`[field] ${err.message}`);
  process.exit(1);
}
if (TRUST_PROXY.value !== false) {
  app.set("trust proxy", TRUST_PROXY.value);
  console.log(`[field] trust proxy: ${TRUST_PROXY.value} (${TRUST_PROXY.source})`);
}
// Rate limits (server/rate-limits.js, #135), before everything else: every
// request counts against its client address (req.ip, as `trust proxy` makes
// it), and a route without a Field sign-in (password login, OAuth, the
// Gmail and Xero callbacks) also against its class's budget for that
// address. Signed-in callers get their own budgets in requireAuth below.
// rateLimit() is called here, on the app, so code scanning (CodeQL
// js/missing-rate-limiting) sees a rate limiter ahead of every route.
const rateLimits = createRateLimits(RATE_LIMIT_BUDGETS);
app.use(rateLimit(addressLimitOptions(RATE_LIMIT_BUDGETS)));
app.use(rateLimits.byAddress);
// First, so every 5xx answer below is reported (server/observability/sentry.js).
app.use(sentryErrorResponseReporter());
// Before durable storage and the body parsers: Clerk needs the raw request body.
if (clerkProxyMount) app.use(clerkProxyMount.path, clerkProxyMount.handler);
if (durableStorage) app.use(durableStorage.middleware());
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    // The running commit, so an operator can confirm what a publish deployed.
    build: deployedBuildStatus(),
    sentry: sentryPublicStatus(),
    // Public: storage state only. Counts, timestamps and the last error are
    // admin-only (GET /api/storage/status). The R2 replica (#12) reports its
    // state, pending count, oldest pending age and last error code.
    storage: {
      ...(durableStorage ? durableStorage.publicStatus() : {}),
      documentReplica: documentReplica.publicStatus(),
    },
  });
});
if (!priceCatalogRuntimeStatus.available) {
  // Make the emergency state visible on every response, not only in the boot
  // log. The operator endpoint below also returns the failure detail.
  app.use((_req, res, next) => {
    res.setHeader("X-Field-Price-Catalog-State", "degraded");
    res.setHeader("X-Field-Price-Catalog-Override", priceCatalogRuntimeStatus.overrideEnv);
    next();
  });
}
if (IS_VERIFICATION_RUNTIME) {
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Field-Verification-Identity", "field-verification");
    res.setHeader("X-Field-Verification-Image-Digest", VERIFICATION_IMAGE_DIGEST);
    res.setHeader("X-Field-Verification-Field-Revision", VERIFICATION_FIELD_REVISION);
    next();
  });
}
app.use(express.json());
app.use("/api", apiCachePolicy);

// Serve the built React client.
const clientDist = join(import.meta.dirname, "../client/dist");
const clientIndex = join(clientDist, "index.html");
function sendClientIndex(res) {
  let html = readFileSync(clientIndex, "utf8");
  const snippet = sentryBrowserBootstrapScript();
  if (snippet) {
    html = html.includes("</head>")
      ? html.replace("</head>", `${snippet}</head>`)
      : `${snippet}${html}`;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(html);
}
if (existsSync(clientIndex)) {
  app.get(["/", "/index.html"], (_req, res) => sendClientIndex(res));
}
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
}

// Auth middleware — per-user bearer token, from the Authorization header only.
// A token in the URL (?token=) is never read: URLs end up in logs, browser
// history and Referer headers, and the token would authorise everything.
function extractToken(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }
  return null;
}

// The request's organisation (req.fieldOrg, read by db-runtime/tenancy.js
// withRequestOrg): a person's is the membership they signed in through;
// machine tokens, service accounts and break-glass belong to the deployment's.
// A caller from any other organisation is refused.
function attachRequestOrg(req, res, next) {
  const uid = req.caller?.orgUid ?? deploymentOrg?.uid ?? null;
  if (deploymentOrg && uid !== deploymentOrg.uid) {
    return res.status(403).json({ error: "This sign-in belongs to another organisation.", code: "wrong_org" });
  }
  req.fieldOrg = uid ? { uid } : null;
  next();
}

// Once the caller is known, the request counts against that caller's budget
// and its route's class budget (server/rate-limits.js), never before: an
// unverified token must not spend anyone's budget.
function requireAuth(req, res, next) {
  const limitCaller = () => rateLimits.byCaller(req, res, next);
  if (clerkAuth) return clerkAuth.requireAuth(req, res, () => attachRequestOrg(req, res, limitCaller));
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });
  const caller = findUserByToken(token);
  if (!caller) return res.status(401).json({ error: "unauthorized" });
  recordTokenUse(token);
  req.caller = caller;
  attachRequestOrg(req, res, limitCaller);
}

// With Clerk sign-in this is the owner gate: an owner signed in with Clerk and
// a verified owner sign-in (or the break-glass key); machine tokens never pass.
function requireAdmin(req, res, next) {
  if (clerkAuth) return clerkAuth.requireOwner(req, res, next);
  if (!req.caller || req.caller.role !== "admin") {
    return res.status(403).json({ error: "admin role required" });
  }
  next();
}

function requireCatalogStore() {
  if (catalogStore) return catalogStore;
  throw Object.assign(new Error(priceCatalogRuntimeStatus.message || "Price catalog is unavailable."), {
    code: "catalog_unavailable",
    statusCode: 503,
  });
}

function requirePriceCatalog(req, res, next) {
  if (priceCatalogRuntimeStatus.available) return next();
  return res.status(503).json({
    error: priceCatalogRuntimeStatus.message
      || "Price catalog is unavailable; commercial pricing is blocked.",
    source: "unavailable",
    pricingBlocked: true,
    incidentOverride: priceCatalogRuntimeStatus.incidentOverride,
    overrideEnv: priceCatalogRuntimeStatus.overrideEnv,
  });
}

const QUOTE_PDF_PREVIEW_TTL_MS = 15 * 60 * 1000;
const QUOTE_PDF_PREVIEW_LIMIT = 64;
const quotePdfPreviewCache = new Map();

function cleanupQuotePdfPreviewCache(now = Date.now()) {
  for (const [previewId, preview] of quotePdfPreviewCache) {
    if ((preview?.expiresAt || 0) <= now) quotePdfPreviewCache.delete(previewId);
  }

  if (quotePdfPreviewCache.size <= QUOTE_PDF_PREVIEW_LIMIT) return;

  const oldestEntries = [...quotePdfPreviewCache.entries()]
    .sort((a, b) => (a[1]?.createdAt || 0) - (b[1]?.createdAt || 0));
  const overflow = oldestEntries.length - QUOTE_PDF_PREVIEW_LIMIT;
  for (const [previewId] of oldestEntries.slice(0, overflow)) {
    quotePdfPreviewCache.delete(previewId);
  }
}

// The preview URL carries no credential: it is fetched with the caller's
// Authorization header (the client and the CLI), or with the Clerk session
// cookie when a browser opens it directly.
function createQuotePdfPreview({ jobId, pdfBuffer, fileName }) {
  const now = Date.now();
  cleanupQuotePdfPreviewCache(now);

  const previewId = randomUUID();
  quotePdfPreviewCache.set(previewId, {
    jobId,
    pdfBuffer,
    fileName,
    createdAt: now,
    expiresAt: now + QUOTE_PDF_PREVIEW_TTL_MS,
  });

  return {
    previewId,
    fileName,
    url: `/api/jobs/${encodeURIComponent(jobId)}/quote-pdf-preview/${encodeURIComponent(previewId)}`,
  };
}

function readQuotePdfPreview({ jobId, previewId }) {
  const now = Date.now();
  cleanupQuotePdfPreviewCache(now);

  const preview = quotePdfPreviewCache.get(previewId);
  if (!preview) return null;
  if (preview.jobId !== jobId || preview.expiresAt <= now) {
    quotePdfPreviewCache.delete(previewId);
    return null;
  }
  return preview;
}

function getRequestActor(req, kind = "user") {
  const name = String(req.headers["x-actor-name"] || req.body?.userName || "User").trim();
  return { kind, label: name || "User" };
}

function getRequestProvenance(req) {
  return {
    agentTool: String(req.headers["x-agent-tool"] || config.agentTool || "unknown").trim() || "unknown",
    llmEngine: String(req.headers["x-llm-engine"] || config.llmEngine || "unknown").trim() || "unknown",
    agentSessionId: String(req.headers["x-agent-session-id"] || "").trim() || null,
  };
}

function getUploadedBy(req) {
  return String(
    req.headers["x-uploaded-by"]
    || req.headers["x-user-email"]
    || req.body?.uploadedBy
    || req.body?.userEmail
    || req.headers["x-actor-name"]
    || "unknown"
  ).trim() || "unknown";
}

function getAudioExtension(mimeType) {
  if (mimeType === "audio/webm") return "webm";
  if (mimeType === "audio/mp4") return "mp4";
  if (mimeType === "audio/ogg") return "ogg";
  if (mimeType === "audio/mpeg") return "mp3";
  if (mimeType === "audio/wav") return "wav";
  if (mimeType === "audio/x-m4a" || mimeType === "audio/m4a") return "m4a";
  return "webm";
}

function buildRejectedOverrideState({
  actor,
  originCategory,
  reason,
  detail = null,
  relatedLineItems = [],
}) {
  return {
    excluded: true,
    reason,
    at: new Date().toISOString(),
    by: actor,
    originCategory,
    detail,
    relatedLineItems,
  };
}

function isDemoModeEnabled() {
  const value = process.env.FIELD_DEMO_MODE ?? config.demo?.enabled;
  return value === true || value === "true" || value === "1";
}

function resolveDemoUserConfig() {
  const configured = config.demo?.user && typeof config.demo.user === "object"
    ? config.demo.user
    : {};
  const email = String(configured.email || process.env.FIELD_DEMO_EMAIL || "demo@example.com").trim().toLowerCase();
  const password = configured.password || process.env.FIELD_DEMO_PASSWORD || AUTH_TOKEN;
  if (!email) throw new Error("demo user email required");
  if (!password) throw new Error("demo user password required");
  return {
    email,
    password,
    name: configured.name || process.env.FIELD_DEMO_NAME || "Demo Operator",
    role: configured.role || "admin",
    kind: "human",
  };
}

async function appendReviewItemActivity({
  jobDir,
  actor,
  itemId,
  itemKind,
  originCategory,
  action,
  title,
  body,
}) {
  await appendJobActivity({
    jobDir,
    activity: {
      kind: "review.item_decision",
      ts: new Date().toISOString(),
      actor,
      title,
      body,
      reviewItemId: itemId,
      reviewItemKind: itemKind,
      reviewAction: action,
      originCategory,
    },
  });
}

// How the client should sign people in. Public: the publishable key is meant
// for browsers. The client reads this at runtime, so one build serves both
// Replit's development and production Clerk instances.
app.get("/api/auth/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(clerkAuth
    ? { ok: true, mode: "clerk", clerk: clerkPublicConfig }
    : { ok: true, mode: "password" });
});

// With Clerk sign-in these answer /api/auth/* and /api/users* first: password
// login is retired and user/token management is owner-only.
if (clerkAuth) {
  app.use(createClerkAuthRouter({
    auth: clerkAuth,
    db: getDb(),
    users: {
      listUsers,
      createUser,
      deleteUser,
      findUserById,
      findUserByEmail,
      findUserByToken,
      ensureUser,
      addToken,
      revokeToken,
      revokeAllTokens,
      revokeTokenByPlaintext,
      listUserTokens,
      tokenIdForPlaintext,
    },
    revokeMcpAccess: (subjects) => revokeMcpSubjects(subjects),
    accessAudit,
    limitCaller: rateLimits.byCaller,
  }));
}

// Email/password login — mints a fresh user token and returns it with the profile.
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }
  const user = await authenticateUser(email, password);
  if (!user) return res.status(401).json({ error: "invalid credentials" });
  const minted = await addToken(user.id, "session");
  res.json({ ok: true, token: minted.token, user });
});

// Get current user profile from the bearer token.
app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.caller });
});

if (IS_VERIFICATION_RUNTIME) {
  app.get("/api/verification/identity", requireAuth, (_req, res) => {
    try {
      const marker = JSON.parse(readFileSync(join(DATA_DIR, ".field-verification-fixture-marker.json"), "utf8"));
      res.json({
        installationId: "field-verification",
        imageDigest: VERIFICATION_IMAGE_DIGEST,
        fieldRevision: VERIFICATION_FIELD_REVISION,
        fixtureMarker: marker,
      });
    } catch (error) {
      res.status(503).json({ error: `verification identity unavailable: ${error.message}` });
    }
  });
}

// Logout: revoke the current token.
app.post("/api/auth/logout", requireAuth, async (req, res) => {
  const incoming = extractToken(req);
  if (incoming) await revokeTokenByPlaintext(req.caller.id, incoming);
  res.json({ ok: true });
});

app.get(["/demo", "/demo-account-create"], async (_req, res) => {
  // The demo mints a password-era session; it has no place behind Clerk sign-in.
  if (!isDemoModeEnabled() || clerkAuth) {
    return res.status(404).send("Not found");
  }

  try {
    const demoUser = resolveDemoUserConfig();
    await ensureUser(demoUser);
    const user = findUserByEmail(demoUser.email);
    if (!user) throw new Error("demo user could not be resolved");
    const minted = await addToken(user.id, "demo-session");
    if (!minted?.token) throw new Error("demo token could not be minted");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderDemoBootstrapPage({ token: minted.token }));
  } catch (err) {
    console.error(`[demo] failed to create demo session: ${err.message}`);
    res.status(500).send("Demo unavailable");
  }
});

// ── User management ──────────────────────────────────────────────
// Each bearer token maps to exactly one user. Admin endpoints require role === "admin".
app.get("/api/storage/status", requireAuth, requireAdmin, async (_req, res) => {
  res.json({
    ...(durableStorage ? durableStorage.status() : { enabled: false }),
    issuedDocuments: issuedDocumentRecorder.status(),
    quoteRows: quoteRowRecorder.status(),
    invoiceRows: invoiceRowRecorder.status(),
    quoteReads: quoteReadsStatus(),
    documentReplica: documentReplica.status(),
    xero: xeroInvoiceSync ? await xeroInvoiceSync.status().catch(() => ({ enabled: true, error: "XERO_STATUS_FAILED" })) : { enabled: false },
  });
});

// The data-migration dry run against the live data and database, writing
// nothing (server/data-migrations/dry-run-route.js): how an operator checks a
// release in production without its credentials. Admin (owner) only, one at
// a time, with a time limit.
app.get(DATA_MIGRATIONS_DRY_RUN_PATH, requireAuth, requireAdmin, createDataMigrationDryRunHandler({
  run: async ({ signal }) => {
    if (!catalogStore || !deploymentOrg) return null;
    return runDataMigrations({
      db: getDb(),
      orgUid: deploymentOrg.uid,
      dataDir: DATA_DIR,
      getState: () => catalogStore.getState({ fresh: true }),
      catalogStore,
      mode: "dry-run",
      signal,
      logger: { log() {}, warn() {} },
    });
  },
}));

// Legacy invoices whose milestone record and PDFs disagree
// (server/invoices/amount-routes.js): the read-only report of every one, and
// the owner's decision about which amounts each was issued for. Admin (owner)
// only.
app.get(AMOUNT_DISAGREEMENTS_PATH, requireAuth, requireAdmin, createInvoiceAmountDisagreementsHandler({
  dataDir: DATA_DIR,
  issuedDocuments: () => issuedDocumentRecorder.service || null,
}));
app.post(AMOUNT_SETTLE_PATH, requireAuth, requireAdmin, createInvoiceAmountSettleHandler({
  findJob,
  settle: (job, input, req) => runExclusiveJobMutation(job.meta.id, "settle invoice amounts", async () => (
    runAtomicJobGeneration(job.dir, async (stagedJobDir) => settleJobMilestoneInvoiceAmounts({
      jobDir: stagedJobDir,
      meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
      config,
      ...input,
      actor: getRequestActor(req),
      issuedDocuments: issuedDocumentRecorder.service || null,
    }), { timeoutMs: 120_000 })
  )),
}));

app.get("/api/users", requireAuth, requireAdmin, (_req, res) => {
  res.json({ ok: true, users: listUsers() });
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { email, name, password, role, kind, settings, permissions } = req.body || {};
  if (!email) return res.status(400).json({ error: "email required" });
  const resolvedKind = typeof kind === "string" ? kind : "human";
  if (resolvedKind === "human" && !password) {
    return res.status(400).json({ error: "password required for human accounts" });
  }
  try {
    const user = await createUser({ email, name, password, role, kind: resolvedKind, settings, permissions });
    res.status(201).json({ ok: true, user });
  } catch (err) {
    if (err.code === "EEXISTS") return res.status(409).json(errorBody(err));
    res.status(400).json(errorBody(err));
  }
});

app.patch("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const { name, role, settings, permissions } = req.body || {};
  const user = await updateUser(req.params.id, { name, role, settings, permissions });
  if (!user) return res.status(404).json({ error: "user not found" });
  res.json({ ok: true, user });
});

app.post("/api/users/:id/password", requireAuth, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "password required" });
  const target = findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "user not found" });
  const isSelf = req.caller && req.caller.id === target.id;
  const isAdmin = req.caller && req.caller.role === "admin";
  if (!isSelf && !isAdmin) return res.status(403).json({ error: "forbidden" });
  const updated = await updatePassword(target.id, password);
  res.json({ ok: true, user: updated });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (req.caller && req.caller.id === req.params.id) {
    return res.status(400).json({ error: "cannot delete yourself" });
  }
  const removed = await deleteUser(req.params.id);
  if (!removed) return res.status(404).json({ error: "user not found" });
  res.json({ ok: true });
});

// Token management with password sign-in: admin or self (server/auth/
// token-access.js). With Clerk sign-in the routes above answer first, owners
// only. Revoking writes an access audit event; the token this request used
// needs ?confirm=current.
app.use(createPasswordTokenRouter({
  users: { findUserById, listUserTokens, addToken, revokeToken, tokenIdForPlaintext },
  requireAuth,
  audit: () => accessAudit,
}));
// Settings, Team, Access: the latest token revokes and agent disconnects.
app.use(createAccessEventsRouter({ requireAuth, requireOwner: requireAdmin, audit: () => accessAudit }));

app.get("/api/ui-config", requireAuth, (_req, res) => {
  res.json({
    ok: true,
    ui: UI_CONFIG,
  });
});

app.get("/api/email-templates", requireAuth, (_req, res) => {
  res.json({ ok: true, ...listEmailTemplates() });
});

app.put("/api/email-templates/:documentType/:templateId", requireAuth, async (req, res) => {
  try {
    const template = await updateEmailTemplate(
      req.params.documentType,
      req.params.templateId,
      req.body,
      req.caller,
    );
    res.json({ ok: true, template });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.get("/api/commercial-authority", requireAuth, (_req, res) => {
  res.json({
    ok: true,
    authority: getCommercialAuthorityStatus(),
    priceCatalogRuntime: priceCatalogRuntimeStatus,
  });
});

// Mount price catalog API
// One id per boot when FIELD_REVISION is unset: catalogue ETags change on every
// restart, so recipe changes shipped by a deploy are never served as a 304.
// Built from the boot time and pid, not randomness: the verification harness
// seeds the random source, and drawing from it here would shift its ids.
const CATALOG_BOOT_REVISION = `boot${Date.now().toString(36)}${process.pid.toString(36)}`;
if (catalogStore) {
  // The catalog health report's disposal checks are
  // scoped to the one quote catalog this installation actually serves —
  // config.quoteCatalogId for verification, DEFAULT_QUOTE_CATALOG_ID
  // otherwise — so an installation never shows a permanent critical for
  // another installation's disposal codes.
  app.use("/api/price-catalog", requireAuth, createPriceCatalogRouter({
    store: catalogStore,
    dataDir: DATA_DIR,
    catalogId: config.quoteCatalogId || DEFAULT_QUOTE_CATALOG_ID,
    revision: String(process.env.FIELD_REVISION || "").trim() || CATALOG_BOOT_REVISION,
  }));
} else {
  // Keep the health contract available during an explicitly permitted
  // degraded boot. A 503 and an unavailable source are more truthful than a
  // 404 or an empty/default health report.
  app.get("/api/price-catalog/health", requireAuth, (_req, res) => {
    res.status(503).json({
      ok: false,
      state: "degraded",
      source: "unavailable",
      error: priceCatalogRuntimeStatus.error || "price catalog database is unavailable",
      incidentOverride: priceCatalogRuntimeStatus.incidentOverride,
      overrideEnv: priceCatalogRuntimeStatus.overrideEnv,
    });
  });
}

app.post("/api/commercial-authority/refresh", requireAuth, async (_req, res) => {
  try {
    const authority = await refreshQuoteCatalogAuthority({
      priceCatalog,
      required: false,
    });
    res.json({ ok: true, authority });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// The served quote catalogs carry catalogue prices; re-project them when the
// catalogue has changed since the last projection (cheap when it has not).
async function refreshServedQuoteCatalogs(_req, res, next) {
  try {
    if (priceCatalog) await refreshQuoteCatalogAuthority({ priceCatalog, required: false, force: false });
    next();
  } catch (error) {
    res.status(503).json({ error: error.message, pricingBlocked: true });
  }
}

app.get("/api/quote-catalogs", requireAuth, requirePriceCatalog, refreshServedQuoteCatalogs, (_req, res) => {
  const quoteCatalogs = listQuoteCatalogs();
  res.json({
    defaultQuoteCatalogId: DEFAULT_QUOTE_CATALOG_ID,
    quoteCatalogs,
  });
});

app.get("/api/quote-catalogs/:id", requireAuth, requirePriceCatalog, refreshServedQuoteCatalogs, (req, res) => {
  const quoteCatalog = serializeQuoteCatalog(req.params.id);
  if (!quoteCatalog) return res.status(404).json({ error: "not found" });
  res.json(quoteCatalog);
});

app.get("/api/quote-catalogs/:id/reference", requireAuth, requirePriceCatalog, refreshServedQuoteCatalogs, async (req, res) => {
  const reference = await readQuoteCatalogReference(req.params.id);
  if (!reference) return res.status(404).json({ error: "not found" });
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.send(reference.body);
});

// Terms and conditions
const TERMS_PATH = join(DATA_DIR, "terms.json");
const DEFAULT_TERMS = [
  { id: "payment", title: "Payment", body: "Payment is due prior to commencement unless otherwise agreed in writing." },
  { id: "scope", title: "Scope", body: "This quote covers only the works described in the pricing schedule above. Any additional works, variations, or unforeseen conditions will be quoted separately before commencement." },
  { id: "site-access", title: "Site Access", body: "The client is responsible for providing clear and safe access to the work area. Any delays caused by restricted access may result in additional charges." },
  { id: "unforeseen", title: "Unforeseen Conditions", body: "If unforeseen ground conditions (rock, contaminated soil, underground services, water) are encountered, additional costs will be quoted and agreed before proceeding." },
  { id: "permits", title: "Permits & Approvals", body: "Unless stated otherwise, council permits, engineering certifications, and any third-party approvals are the responsibility of the client and are not included in this quote." },
];

async function loadTerms() {
  try {
    if (existsSync(TERMS_PATH)) {
      return JSON.parse(await readFile(TERMS_PATH, "utf8"));
    }
  } catch { /* ignore */ }
  return DEFAULT_TERMS;
}

async function saveTerms(terms) {
  await writeFile(TERMS_PATH, JSON.stringify(terms, null, 2));
}

// Business settings (business_settings, #28): whether an invoice returned to
// draft and reissued with different content is credited first. Everyone can
// read it; an owner changes it.
const businessSettings = deploymentOrg ? createBusinessSettingsService({ db: getDb(), orgUid: deploymentOrg.uid }) : null;

app.get("/api/settings/invoicing", requireAuth, async (_req, res) => {
  if (!businessSettings) return res.status(503).json({ error: "business settings need the database, which this server does not have" });
  try {
    res.json({ ok: true, ...(await businessSettings.get()), choices: CREDIT_NOTE_ON_REISSUE_CHOICES });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.put("/api/settings/invoicing", requireAuth, requireAdmin, async (req, res) => {
  if (!businessSettings) return res.status(503).json({ error: "business settings need the database, which this server does not have" });
  try {
    const actor = req.caller?.id || req.caller?.email || req.caller?.name || null;
    const patch = Object.fromEntries(["creditNoteOnReissue", "country", "region", "updateCheck"]
      .filter((key) => Object.hasOwn(req.body || {}, key))
      .map((key) => [key, req.body[key]]));
    res.json({ ok: true, ...(await businessSettings.update(patch, { actor })), choices: CREDIT_NOTE_ON_REISSUE_CHOICES });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// Is a newer Field release out (server/update-check.js)? Owners only: Settings
// shows it, with the release notes and the operator's upgrade guide. Off when
// an owner turns business_settings.update_check off; then nothing is asked.
const updateChecker = createUpdateChecker();

app.get("/api/updates", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const enabled = businessSettings ? (await businessSettings.get()).updateCheck : true;
    res.json({ ok: true, ...(await updateChecker.status({ enabled })) });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// Milestone rules (#29, step 4c): the organisation's default milestones and
// caps by region and contract value, as rows. Everyone can read them; only
// an owner changes them, and only here (Settings, the CLI as an owner). A
// job's own schedule can depart from them, but never from their caps.
const milestoneRuleService = deploymentOrg ? createMilestoneRuleService({ db: getDb(), orgUid: deploymentOrg.uid }) : null;
installMilestoneRules(milestoneRuleService);

async function milestoneRulesBody() {
  const listed = await milestoneRuleService.list();
  const business = await resolveBusinessRegion({ service: milestoneRuleService, businessAddress: getQuoteCatalog()?.businessProfile?.address || config?.businessProfile?.address || null });
  return {
    ok: true,
    ...listed,
    businessRegion: business,
    options: {
      valueBases: MILESTONE_RULE_VALUE_BASES,
      capModes: MILESTONE_CAP_MODES,
      capKinds: MILESTONE_CAP_KINDS,
      regions: { AU: AU_REGIONS },
    },
  };
}

app.get("/api/settings/milestone-rules", requireAuth, async (_req, res) => {
  if (!milestoneRuleService) return res.status(503).json({ error: "milestone rules need the database, which this server does not have" });
  try {
    res.json(await milestoneRulesBody());
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.put("/api/settings/milestone-rules", requireAuth, requireAdmin, async (req, res) => {
  if (!milestoneRuleService) return res.status(503).json({ error: "milestone rules need the database, which this server does not have" });
  try {
    const actor = req.caller?.id || req.caller?.email || req.caller?.name || null;
    await milestoneRuleService.replace(req.body?.rules, { actor, expectedVersion: req.body?.expectedVersion ?? null });
    res.json(await milestoneRulesBody());
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

// Settings, Integrations, Xero and the invoices' Xero state (#93, #112).
// Changes are for owners only; the screen and a job's Xero state are
// read-only for everyone signed in.
registerXeroRoutes(app, {
  requireAuth,
  requireOwner: requireAdmin,
  isOwner: (req) => new Promise((resolve) => {
    // The owner gate, asked without answering the request.
    const probe = { status: () => probe, json: () => resolve(false), send: () => resolve(false), setHeader: () => {}, end: () => resolve(false) };
    try {
      requireAdmin(req, probe, () => resolve(true));
    } catch {
      resolve(false);
    }
  }),
  connection: () => xeroConnection,
  sync: () => xeroInvoiceSync,
  setup: () => xeroSetup,
  publicUrl: () => config.publicUrl || null,
  actorOf: (req) => req.caller?.name || req.caller?.email || req.caller?.id || null,
});

// The browser generated a FIELD_SECRETS_KEY (owners): an audit event only.
// The key never reaches the server.
registerSecretsKeyRoutes(app, {
  requireAuth,
  requireOwner: requireAdmin,
  credentialStore: () => integrationCredentials,
  actorOf: (req) => req.caller?.name || req.caller?.email || req.caller?.id || null,
});

app.get("/api/terms", requireAuth, async (_req, res) => {
  res.json({ ok: true, terms: await loadTerms() });
});

app.put("/api/terms", requireAuth, async (req, res) => {
  const terms = req.body?.terms;
  if (!Array.isArray(terms)) return res.status(400).json({ error: "terms must be an array" });
  await saveTerms(terms);
  res.json({ ok: true });
});

// Make loadTerms available for PDF generation
globalThis.__fieldLoadTerms = loadTerms;

app.patch("/api/quote-catalogs/:id/items/:code", requireAuth, async (_req, res) => {
  res.status(410).json({
    error: "Local price edits are disabled. Update the active commercial authority and refresh the Field catalog instead.",
  });
});

app.post("/api/quote-catalogs/:id/items", requireAuth, async (_req, res) => {
  res.status(410).json({
    error: "Local catalog writes are disabled. Create the item in the active commercial authority first, then add metadata mapping only if required.",
  });
});

app.post("/api/quote-catalogs/:id/defaults/:field/alternatives", requireAuth, async (req, res) => {
  try {
    const { addQuoteCatalogAlternative } = await import("./quote-catalogs.js");
    const alternatives = addQuoteCatalogAlternative(req.params.id, decodeURIComponent(req.params.field), req.body);
    res.json({ ok: true, alternatives });
  } catch (err) {
    res.status(400).json(errorBody(err));
  }
});

// Upload config — store in temp, move after
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
});

// Email uploads: 10 MB each and at most 10 files, the email limits
// (server/documents/email-attachments.js). Over a limit is a 413 with the
// limit, before anything is prepared or sent.
const emailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: EMAIL_ATTACHMENT_LIMITS.maxUploadBytes, files: EMAIL_ATTACHMENT_LIMITS.maxAttachments },
});
function emailUploads(req, res, next) {
  emailUpload.array("attachments", EMAIL_ATTACHMENT_LIMITS.maxAttachments)(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      const tooBig = error.code === "LIMIT_FILE_SIZE";
      return res.status(413).json({
        error: tooBig
          ? `each upload can be at most ${EMAIL_ATTACHMENT_LIMITS.maxUploadBytes / (1024 * 1024)} MB`
          : `an email can carry at most ${EMAIL_ATTACHMENT_LIMITS.maxAttachments} attachments`,
        code: tooBig ? "EMAIL_UPLOAD_TOO_LARGE" : "EMAIL_TOO_MANY_ATTACHMENTS",
        limitBytes: tooBig ? EMAIL_ATTACHMENT_LIMITS.maxUploadBytes : undefined,
        limit: tooBig ? undefined : EMAIL_ATTACHMENT_LIMITS.maxAttachments,
      });
    }
    return next(error);
  });
}

// The issue service in the caller's organisation, for attaching Field
// documents by uid; null without a database (attaching is then refused, 503).
function emailDocumentService(req) {
  try {
    return createIssuedDocumentService({ db: getDb(), orgUid: requestOrgUid(req), ...(issuedDocumentBlobs ? { blobs: issuedDocumentBlobs } : {}) });
  } catch {
    return issuedDocumentRecorder.service || null;
  }
}

function emailAttachmentErrorBody(error) {
  return { error: error.message, code: error.code, ...(error.details || {}) };
}

// A held send (Undo send) is due in seconds; the scheduler is woken for it
// rather than waiting for its next poll.
function wakeSchedulerAfter(holdSeconds) {
  const timer = setTimeout(() => { void scheduledEmailScheduler?.runNow?.(); }, Math.max(0, Number(holdSeconds) || 0) * 1000 + 300);
  timer.unref?.();
}

// Send a test to me: the email as it would go, to the signed-in person only,
// "[Test]" in the subject. The document this email is for attaches as it is
// stored when it is issued, else as a preview copy (PREVIEW-…pdf). Nothing
// is issued, queued, archived or recorded as an event.
async function sendTestCopy({ req, job, payload, documentType = null, loadedDocuments = [], uploads = [] }) {
  const meta = normalizeJobMeta(job.meta);
  const attachments = [];
  let view = { documentType: null, meta, quote: null, milestoneInvoice: null };
  if (documentType) {
    const read = await readEmailDocumentView({ job, meta, documentType, milestoneIndex: payload?.milestoneIndex ?? null, version: payload?.version ?? null });
    view = withPendingNumber(read, PENDING_NUMBER_TEXT);
    const pdf = await readJobDocumentPdf({ job, documentType, version: payload?.version ?? null, milestoneIndex: payload?.milestoneIndex ?? null });
    if (pdf.status) {
      const error = new Error(pdf.error);
      error.statusCode = pdf.status;
      throw error;
    }
    const filename = pdf.issued && !isDraftInvoice(read) ? pdf.filename : `PREVIEW-${pdf.filename}`;
    attachments.push({ filename, contentType: "application/pdf", buffer: pdf.bytes });
  }
  attachments.push(...documentMimeAttachments(loadedDocuments), ...uploads);
  const values = buildEmailMergeValues({
    meta: view.meta,
    quote: view.quote,
    documentType: view.documentType,
    milestoneInvoice: view.milestoneInvoice,
    config,
    user: req.caller,
    attachmentNames: attachments.map((attachment) => attachment.filename),
    adjustmentNote: payload?.adjustmentNote ? await adjustmentNoteValues(emailDocumentService(req), payload.adjustmentNote) : null,
  });
  if (isDraftInvoice(view)) values.documentNumber = PENDING_NUMBER_TEXT;
  const customBody = payload?.customBody ? applyMergeFields(String(payload.customBody), values, { final: true }) : null;
  const subject = payload?.subject ? applyMergeFieldsToText(String(payload.subject), values, { final: true }) : null;
  const fromName = (() => { try { return resolveMailSender({ config, user: req.caller }).fromName; } catch { return null; } })();
  const built = view.documentType
    ? await composeDocumentEmail({ meta: view.meta, quote: view.quote, documentType: view.documentType, customBody, subjectOverride: subject, fromName })
    : composeJobEmail({ meta, subject, customBody, fromName });
  return sendTestEmail({ config, user: req.caller, subject: built.subject, body: built.body, htmlBody: built.htmlBody, attachments });
}

// An error as the API returns it. A hard milestone cap (#29) also says which
// rule refused the issue, and what it allows.
function errorBody(err) {
  return {
    error: err.message,
    ...(err?.code === "MILESTONE_CAP_EXCEEDED" ? { code: err.code, findings: err.findings || [] } : {}),
  };
}

function sendErrorBody(err, isAuthExpired) {
  return {
    ...(err?.code === "MILESTONE_CAP_EXCEEDED" ? { findings: err.findings || [] } : {}),
    error: err.message,
    ...(isAuthExpired ? { code: "gmail_auth_expired" } : err.code ? { code: err.code } : {}),
    // "unknown": Gmail may have sent it (a time-out, a reset, a 5xx), so the
    // composer says Not confirmed and does not offer to send it again.
    deliveryOutcome: classifyDeliveryFailure(err),
  };
}

app.post("/api/jobs/manual", requireAuth, async (req, res) => {
  try {
    const created = await createManualJob({
      quoteCatalogId: req.body?.quoteCatalogId || DEFAULT_QUOTE_CATALOG_ID,
      gps: req.body?.gps || null,
      siteAddress: req.body?.siteAddress || null,
      quotedBy: req.body?.quotedBy || null,
    });
    const visible = buildClientQuoteMutationView(created);
    res.json({
      ok: true,
      id: created.meta.id,
      status: created.meta.status,
      ...visible,
      quoteVersions: created.quoteVersions,
    });
  } catch (err) {
    console.error(`[manual-job] failed: ${err.message}`);
    res.status(500).json(errorBody(err));
  }
});

function describeJobIndexRepair({ added = 0, moved = 0 } = {}) {
  const parts = [];
  if (added) parts.push(`added ${added} job(s) missing from the index`);
  if (moved) parts.push(`repointed ${moved} job(s) whose folder moved`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

// The job list reads field.db. Boot reconciles it with the data directory;
// while running, a row whose folder is gone means the index and the data
// directory disagree, so the list reconciles again (once per disagreement,
// one reconcile at a time) before it answers (#32).
let jobIndexReconcile = null;
let unresolvedMissingJobDirs = new Set();

function reconcileJobIndexOnce(reason) {
  jobIndexReconcile ||= reconcileJobIndex(fieldDb, DATA_DIR)
    .then((result) => {
      if (result.added || result.moved) console.log(`[field-db] ${reason}: ${result.total} jobs indexed${describeJobIndexRepair(result)}`);
      return result;
    })
    .finally(() => { jobIndexReconcile = null; });
  return jobIndexReconcile;
}

async function listIndexedJobRows(reason) {
  let rows = listJobsFromDb(fieldDb);
  const missing = rows.filter((row) => !existsSync(row.dir)).map((row) => row.dir);
  if (missing.some((dir) => !unresolvedMissingJobDirs.has(dir))) {
    await reconcileJobIndexOnce(reason);
    rows = listJobsFromDb(fieldDb);
    unresolvedMissingJobDirs = new Set(rows.filter((row) => !existsSync(row.dir)).map((row) => row.dir));
  }
  return rows;
}

// List jobs
app.get("/api/jobs", requireAuth, async (_req, res) => {
  // Fast path: read from DB. Every step has a time limit
  // (server/job-list-guard.js): a job whose files cannot be read in time is
  // left out and reported, so one stuck read never hangs the whole board.
  if (fieldDb) {
    try {
      const rows = await withDeadline(listIndexedJobRows("job list"), JOB_LIST_PER_JOB_MS, "index")
        .catch((error) => {
          if (error?.code !== "FIELD_JOB_LIST_TIMEOUT") throw error;
          reportJobListSkip({ id: null, step: "index", reason: "timeout" }, error);
          return listJobsFromDb(fieldDb);
        });
      const deletionDeps = await withDeadline(buildJobListDeletionDeps(), JOB_LIST_PER_JOB_MS, "scheduled emails")
        .catch((error) => {
          reportJobListSkip({ id: null, step: "scheduled emails", reason: error?.code === "FIELD_JOB_LIST_TIMEOUT" ? "timeout" : "error" }, error);
          return { ...jobDeletionDeps(), listScheduledEmails: async () => [] };
        });
      const { jobs, skipped } = await listJobsWithinDeadline(rows, {
        readMeta: (row) => readNormalizedJobMeta(row.dir),
        listJob: (row, meta) => listJobWithDeletable(row.dir, meta, deletionDeps),
        onSkip: reportJobListSkip,
      });
      if (skipped.length) res.set("X-Field-Jobs-Skipped", String(skipped.length));
      return res.json(jobs);
    } catch { /* fall through to directory scan */ }
  }
  // Fallback: directory scan
  const jobs = [];
  try {
    const deletionDeps = await buildJobListDeletionDeps();
    const dateDirs = await readdir(DATA_DIR);
    for (const dateDir of dateDirs.sort().reverse()) {
      const datePath = join(DATA_DIR, dateDir);
      const s = await stat(datePath);
      if (!s.isDirectory()) continue;
      const ids = await readdir(datePath);
      for (const id of ids) {
        const jobDir = join(datePath, id);
        const activeJobDir = await resolveActiveJobGeneration(jobDir);
        if (existsSync(join(activeJobDir, "meta.json"))) {
          const meta = await readNormalizedJobMeta(jobDir);
          if (meta) jobs.push(await listJobWithDeletable(jobDir, meta, deletionDeps));
        }
      }
    }
  } catch { /* empty data dir */ }
  res.json(jobs);
});

// One line and one Sentry event per job left out of the list: the job id and
// the step, never its folder (older folders are named after the site address).
function reportJobListSkip(entry, error) {
  console.warn(`[jobs] job list left out ${entry.id ? `job ${entry.id}` : "a step"}: ${entry.step} ${entry.reason}`);
  reportBackgroundError(error instanceof Error ? error : new Error(`job list ${entry.step} ${entry.reason}`), {
    area: "job-list",
    step: entry.step,
    reason: entry.reason,
    job: entry.id || undefined,
  });
}

// The list only needs a yes/no, so the assessment stops at the first reason;
// most jobs are ruled out by their meta alone without reading more files.
async function buildJobListDeletionDeps() {
  const scheduledByJob = new Map();
  const scheduled = await listScheduledEmails({ dataDir: DATA_DIR }).catch(() => []);
  for (const email of scheduled) {
    if (!email?.jobId) continue;
    if (!scheduledByJob.has(email.jobId)) scheduledByJob.set(email.jobId, []);
    scheduledByJob.get(email.jobId).push(email);
  }
  return {
    ...jobDeletionDeps(),
    listScheduledEmails: async (jobId) => scheduledByJob.get(jobId) || [],
  };
}

async function listJobWithDeletable(jobDir, meta, deletionDeps) {
  const listed = await sanitizeListedJobMeta(jobDir, meta);
  const { deletable } = await assessJobDeletion({ dir: jobDir, meta }, deletionDeps, { quick: true })
    .catch(() => ({ deletable: false }));
  return { ...listed, deletable };
}

async function sanitizeListedJobMeta(jobDir, meta) {
  if ((meta?.outputMode || "report") !== "quote") return meta;
  const artifacts = await readQuoteArtifacts(jobDir).catch(() => null);
  const lifecycle = await readQuoteLifecycle(jobDir).catch(() => null);
  const quote = artifacts?.quote || null;
  const issuanceRecord = findIssuedQuoteVersion(
    await readQuoteIssuanceLedger(jobDir).catch(() => null),
    quote?.version || meta?.quoteVersion,
    "quote",
  );
  // A legacy sent-looking flag is not enough for the current list surface.
  // Only an issuance record whose exact bytes still hash-checks may bypass a
  // current attestation; otherwise the financial summary must be null.
  const issuedArtifact = issuanceRecord
    ? await readIssuedQuoteArtifact(jobDir, issuanceRecord, "quoteMarkdown").catch(() => null)
    : null;
  const issuedVersion = Boolean(issuedArtifact?.available);
  return sanitizeClientJobMeta(meta, quote, {
    historical: false,
    issuedVersion,
    current: true,
  });
}

// Get job detail
app.get("/api/jobs/:id", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const selectedVersion = parseRequestedQuoteVersion(req.query?.version);
    const detail = await loadJobDetail(job, { version: selectedVersion });
    // The quote rows' version, for the editor to send back as If-Match (#10).
    // Only for the latest version: that is the one a save writes.
    const rowsTag = jobDetailQuoteRows.get(detail)?.versionTag;
    if (rowsTag && (!detail.versionView || detail.versionView.isLatest)) res.setHeader("X-Field-Quote-Rows-Version", rowsTag);
    res.json(buildClientJobDetail(detail));
  } catch (err) {
    res.status(err.statusCode || 400).json(errorBody(err));
  }
});

app.patch("/api/jobs/:id/details", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const key = String(req.body?.key || "").trim();
  if (!key) return res.status(400).json({ error: "detail key required" });

  try {
    const updated = await runExclusiveJobMutation(job.meta.id, "job detail update", async () => runAtomicJobGeneration(
      job.dir,
      async (stagedJobDir) => {
        // Details and their activity entry are job-state at the root; only the
        // derived meta belongs to the commercial generation.
        const next = await updateJobDetailField({
          jobDir: job.dir,
          meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
          key,
          value: req.body?.value ?? null,
          actor: getRequestActor(req),
        });
        next.meta = await persistNormalizedJobMeta(stagedJobDir, next.meta);
        return next;
      },
    ));
    res.json({
      ok: true,
      activity: updated.activityEntry,
      detail: buildClientJobDetail(await loadJobDetail({ ...job, meta: updated.meta })),
    });
  } catch (err) {
    console.error(`[job-detail] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/notes", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const notes = fieldDb ? getNotesForJob(fieldDb, job.meta.id) : [];
  res.json({ notes });
});

// The job's engine log (quote rebuilds and their checks), newest first.
app.get("/api/jobs/:id/log", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ log: fieldDb ? getJobLog(fieldDb, job.meta.id) : [] });
});

app.post("/api/jobs/:id/notes", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "note text required" });

    const anchor = req.body?.anchor || null;
    const title = req.body?.title ? String(req.body.title).trim() : null;
    const actor = getRequestActor(req);

    // A note is operational job-state, which lives at the job root and is
    // excluded from commercial generations, so it is written there directly.
    const activityNote = await runExclusiveJobMutation(job.meta.id, "job note", async () => addJobNote({
      jobDir: job.dir,
      text: anchor ? `[${anchor.surface}/${anchor.layer || ""}/${anchor.itemLabel || anchor.itemCode || ""}] ${text}` : text,
      actor,
    }));

    // Write to notes_ledger DB with anchor context
    if (fieldDb) {
      insertNote(fieldDb, {
        id: activityNote.id,
        jobId: job.meta.id,
        text,
        title: title || null,
        author: actor?.label || actor?.kind || null,
        surface: anchor?.surface || "general",
        layer: anchor?.layer || null,
        itemCode: anchor?.itemCode || null,
        itemLabel: anchor?.itemLabel || null,
        itemSnapshot: anchor?.itemSnapshot || null,
        version: anchor?.version || null,
      });
    }

    res.json({
      ok: true,
      note: activityNote,
      detail: buildClientJobDetail(await loadJobDetail(job)),
    });
  } catch (err) {
    console.error(`[job-note] ${job.meta.id} failed: ${err.message}`);
    res.status(err.message === "note text required" ? 400 : 500).json(errorBody(err));
  }
});

app.delete("/api/jobs/:id/notes/:noteId", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (fieldDb) {
    const result = deleteNote(fieldDb, req.params.noteId, job.meta.id);
    if (result.changes === 0) return res.status(404).json({ error: "note not found" });
  }
  res.json({ ok: true });
});

app.post("/api/jobs/:id/gaps/:gapId/actions", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const detail = await loadJobDetail(job);
  const gap = detail.jobState?.gaps?.find((item) => item.id === req.params.gapId);
  if (!gap) return res.status(404).json({ error: "gap not found" });

  const mode = String(req.body?.mode || "").trim().toLowerCase();
  if (!["accept", "confirm", "reject", "reopen"].includes(mode)) {
    return res.status(400).json({ error: "unsupported gap mode" });
  }

  try {
    if (mode === "accept") {
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "reason required" });
      if (!gap.assumption?.available) {
        return res.status(400).json({ error: "no assumption is available for this gap" });
      }
      const assumptionValue = gap.assumption.defaultValue || gap.assumption.value || "Accepted assumption";
      await setGapState({
        jobDir: job.dir,
        gapId: gap.id,
        status: "accepted",
        reason,
        note: assumptionValue,
        actor: getRequestActor(req),
      });

      if (gap.kind === "option_selection_pending" && gap.selection?.familyId) {
        const optionCode = gap.selection.displayOptionCode || gap.selection.defaultOptionCode;
        if (!optionCode) {
          return res.status(400).json({ error: "no default option is available for this selection gap" });
        }
        const persisted = await updateJobQuote({
          jobDir: job.dir,
          meta: normalizeJobMeta(job.meta),
          config,
          patch: {
            acceptedOptionSelections: {
              [gap.selection.familyId]: optionCode,
            },
          },
          actor: getRequestActor(req),
          buildReason: "option_selection_accept",
        });
        return res.json({
          ok: true,
          mode,
          detail: buildClientJobDetail(await loadJobDetail({ ...job, meta: persisted.meta })),
        });
      }

      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(job)),
      });
    }

    if (mode === "confirm") {
      const reason = String(req.body?.reason || "").trim() || "Confirmed from explicit quote review input.";
      const note = String(req.body?.note || "").trim();
      if (!note) return res.status(400).json({ error: "note required" });
      const actor = getRequestActor(req);
      await setGapState({
        jobDir: job.dir,
        gapId: gap.id,
        status: "confirmed",
        reason,
        note,
        actor,
      });

      // Write triage clarification to the notes ledger so reingest captures it
      const activityNote = await addJobNote({
        jobDir: job.dir,
        text: `[triage/L5/${gap.field}] ${note}`,
        actor,
      });
      if (fieldDb) {
        insertNote(fieldDb, {
          id: activityNote.id,
          jobId: job.meta.id,
          text: note,
          author: actor?.label || actor?.kind || null,
          surface: "triage",
          layer: "L5",
          itemCode: gap.id,
          itemLabel: gap.field,
        });
      }

      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(job)),
      });
    }

    if (mode === "reopen") {
      const nextStatus = String(req.body?.status || "open").trim().toLowerCase();
      if (!["open", "in_progress"].includes(nextStatus)) {
        return res.status(400).json({ error: "unsupported reopen status" });
      }
      await setGapState({
        jobDir: job.dir,
        gapId: gap.id,
        status: nextStatus,
        reason: String(req.body?.reason || "").trim() || "Gap returned to review.",
        actor: getRequestActor(req),
      });
      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(job)),
      });
    }

    const reasonCode = String(req.body?.reasonCode || "").trim() || "false_positive";
    const reason = String(req.body?.reason || "").trim() || "Marked as not a real gap.";
    await setGapState({
      jobDir: job.dir,
      gapId: gap.id,
      status: "rejected",
      reason,
      reasonCode,
      actor: getRequestActor(req),
    });
    res.json({
      ok: true,
      mode,
      detail: buildClientJobDetail(await loadJobDetail(job)),
    });
  } catch (err) {
    console.error(`[gap-action] ${job.meta.id} failed: ${err.message}`);
    res.status(500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/review/items/:itemId/actions", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const detail = await loadJobDetail(job);
    const review = detail.review || buildReviewState({
      quote: detail.quote || null,
      jobState: detail.jobState || null,
      quoteOverrides: detail.quoteOverrides || null,
    });
    const match = findReviewItem(review, req.params.itemId);
    if (!match) return res.status(404).json({ error: "review item not found" });

    const item = match.item;
    const mode = String(req.body?.mode || "").trim().toLowerCase();
    const allowedActions = item.allowedActions || [];
    if (!allowedActions.includes(mode)) {
      return res.status(400).json({ error: "unsupported review action for this item" });
    }

    const actor = getRequestActor(req);
    let nextJob = job;

    if (match.category === "assumed" && mode === "edit") {
      const value = String(req.body?.value || req.body?.note || "").trim();
      if (!value) return res.status(400).json({ error: "value required" });

      if (item.gapId) {
        await setGapState({
          jobDir: job.dir,
          gapId: item.gapId,
          status: "accepted",
          reason: String(req.body?.reason || "").trim() || "Assumption revised during quote review.",
          note: value,
          actor,
        });
      }

      const persisted = await updateJobQuote({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        config,
        patch: {
          assumptions: {
            [item.field]: {
              value,
              note: String(req.body?.reason || "").trim() || null,
            },
          },
        },
        actor,
        buildReason: "review_assumption_edit",
      });
      nextJob = { ...job, meta: persisted.meta };

      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(nextJob)),
      });
    }

    if (match.category === "assumed" && mode === "confirm") {
      if (!item.gapId) {
        return res.status(400).json({ error: "this review item is not linked to a durable gap" });
      }
      const note = String(req.body?.note || item.value || "").trim();
      if (!note) return res.status(400).json({ error: "note required" });

      if (note !== item.value) {
        const persisted = await updateJobQuote({
          jobDir: job.dir,
          meta: normalizeJobMeta(job.meta),
          config,
          patch: {
            assumptions: {
              [item.field]: {
                value: note,
                note: String(req.body?.reason || "").trim() || null,
              },
            },
          },
          actor,
          buildReason: "review_assumption_confirm",
        });
        nextJob = { ...job, meta: persisted.meta };
      }

      await setGapState({
        jobDir: job.dir,
        gapId: item.gapId,
        status: "confirmed",
        reason: String(req.body?.reason || "").trim() || "Confirmed from assumed review item.",
        note,
        actor,
      });
      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(nextJob)),
      });
    }

    if (match.category === "assumed" && mode === "reject") {
      const reason = String(req.body?.reason || "").trim() || "Marked as not needed for this quote.";
      const persisted = await updateJobQuote({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        config,
        patch: {
          assumptions: {
            [item.field]: {
              value: item.value,
              note: String(req.body?.note || "").trim() || null,
              reviewState: buildRejectedOverrideState({
                actor,
                originCategory: "assumed",
                reason,
                detail: item.detail,
                relatedLineItems: item.relatedLineItems || [],
              }),
            },
          },
        },
        actor,
        buildReason: "review_assumption_reject",
      });
      nextJob = { ...job, meta: persisted.meta };
      if (item.gapId) {
        await setGapState({
          jobDir: job.dir,
          gapId: item.gapId,
          status: "rejected",
          reason,
          reasonCode: "not_needed",
          actor,
        });
      }
      await appendReviewItemActivity({
        jobDir: job.dir,
        actor,
        itemId: item.id,
        itemKind: "assumption",
        originCategory: "assumed",
        action: "reject",
        title: "Assumption removed",
        body: `${item.field} — ${reason}`,
      });
      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(nextJob)),
      });
    }

    if (match.category === "confirmed" && item.kind === "line_item" && mode === "reject") {
      if (!item.code) {
        return res.status(400).json({ error: "confirmed line item code missing" });
      }
      const reason = String(req.body?.reason || "").trim() || "Removed from the current quote.";
      const persisted = await updateJobQuote({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        config,
        patch: {
          lineItems: {
            [item.code]: {
              label: item.label,
              reviewState: buildRejectedOverrideState({
                actor,
                originCategory: "confirmed",
                reason,
                detail: item.detail,
              }),
            },
          },
        },
        actor,
        buildReason: "review_confirmed_remove",
      });
      nextJob = { ...job, meta: persisted.meta };
      await appendReviewItemActivity({
        jobDir: job.dir,
        actor,
        itemId: item.id,
        itemKind: "line_item",
        originCategory: "confirmed",
        action: "reject",
        title: "Quoted item removed",
        body: `${item.label} — ${reason}`,
      });
      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(nextJob)),
      });
    }

    if (match.category === "confirmed" && item.kind === "resolved_gap" && mode === "reopen") {
      const gapId = item.id.replace(/^resolved-gap:/, "");
      const gap = (detail.jobState?.gaps || []).find((entry) => entry.id === gapId) || null;
      const restoreStatus = restoreStatusForResolvedGap(detail.jobState || null, gap);
      await setGapState({
        jobDir: job.dir,
        gapId,
        status: restoreStatus,
        reason:
          String(req.body?.reason || "").trim()
          || (restoreStatus === "accepted"
            ? "Returned confirmed item to assumed review."
            : "Returned confirmed item to active review."),
        note:
          restoreStatus === "accepted"
            ? String(gap?.resolution?.note || gap?.assumption?.value || gap?.assumption?.defaultValue || "").trim() || null
            : null,
        actor,
      });
      await appendReviewItemActivity({
        jobDir: job.dir,
        actor,
        itemId: item.id,
        itemKind: "resolved_gap",
        originCategory: "confirmed",
        action: "reopen",
        title: restoreStatus === "accepted" ? "Confirmed item returned to assumed review" : "Confirmed item reopened",
        body:
          restoreStatus === "accepted"
            ? `${item.label} returned to assumed review.`
            : `${item.label} returned to gap review.`,
      });
      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(nextJob)),
      });
    }

    if (match.category === "rejected" && mode === "reopen") {
      if (item.kind === "gap") {
        await setGapState({
          jobDir: job.dir,
          gapId: item.gapId || item.id,
          status: "open",
          reason: String(req.body?.reason || "").trim() || "Returned rejected gap to active review.",
          actor,
        });
      } else if (item.kind === "assumption") {
        if (item.gapId) {
          const assumptionOverride = detail.quoteOverrides?.assumptions?.[item.label];
          await setGapState({
            jobDir: job.dir,
            gapId: item.gapId,
            status: "accepted",
            reason: String(req.body?.reason || "").trim() || "Returned assumption to active review.",
            note: String(assumptionOverride?.value || "").trim() || "Accepted assumption",
            actor,
          });
        }
        const persisted = await updateJobQuote({
          jobDir: job.dir,
          meta: normalizeJobMeta(job.meta),
          config,
          patch: {
            assumptions: {
              [item.label]: {
                reviewState: null,
              },
            },
          },
          actor,
          buildReason: "review_assumption_restore",
        });
        nextJob = { ...job, meta: persisted.meta };
      } else if (item.kind === "line_item") {
        const code = item.id.replace(/^line-item:/, "");
        const persisted = await updateJobQuote({
          jobDir: job.dir,
          meta: normalizeJobMeta(job.meta),
          config,
          patch: {
            lineItems: {
              [code]: {
                reviewState: null,
              },
            },
          },
          actor,
          buildReason: "review_line_item_restore",
        });
        nextJob = { ...job, meta: persisted.meta };
      } else {
        return res.status(400).json({ error: "unsupported rejected item kind" });
      }
      await appendReviewItemActivity({
        jobDir: job.dir,
        actor,
        itemId: item.id,
        itemKind: item.kind,
        originCategory: item.originCategory,
        action: "reopen",
        title: "Rejected item restored",
        body: `${item.label} returned to active review.`,
      });
      return res.json({
        ok: true,
        mode,
        detail: buildClientJobDetail(await loadJobDetail(nextJob)),
      });
    }

    return res.status(400).json({ error: "unsupported review item action" });
  } catch (err) {
    console.error(`[review-item-action] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// Archiving writes the job-state details and activity at the job root, then
// the archive stamp on meta.json and quote-lifecycle.json. Those two are
// commercial files: they live in a committed generation, which must never be
// written in place (a changed generation fails validation and the job falls
// back to the previous one), so they are written into a staged generation.
async function archiveJobAndPersist(job, { reason = null, actor }) {
  const archived = await archiveJob({ jobDir: job.dir, meta: job.meta, reason, actor });
  const { archivedAt, archivedReason } = archived.meta;
  archived.meta = await runAtomicJobGeneration(job.dir, async (stagedJobDir) => {
    // Re-read meta under the generation lock so a write that landed after
    // findJob (a send, a payment) is kept rather than overwritten.
    const currentMeta = await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta);
    const meta = await persistNormalizedJobMeta(stagedJobDir, {
      ...applyDetailsToMeta(currentMeta, archived.details),
      archivedAt,
      archivedReason,
    });
    if ((meta.outputMode || "report") === "quote") {
      await recordQuoteArchived({
        jobDir: stagedJobDir,
        meta,
        archivedAt: meta.archivedAt || archived.details?.archivedAt || null,
        archivedReason: meta.archivedReason || reason || null,
      });
    }
    return meta;
  });
  return archived;
}

app.post("/api/jobs/:id/archive", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const archived = await archiveJobAndPersist(job, {
      reason: req.body?.reason || null,
      actor: getRequestActor(req),
    });
    res.json({
      ok: true,
      detail: buildClientJobDetail(await loadJobDetail({ ...job, meta: archived.meta })),
    });
  } catch (err) {
    console.error(`[archive] ${job.meta.id} failed: ${err.message}`);
    res.status(500).json(errorBody(err));
  }
});

app.post("/api/jobs/bulk-archive", requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "ids required" });

  const results = [];
  for (const id of ids) {
    const job = await findJob(id);
    if (!job) {
      results.push({ id, ok: false, error: "not found" });
      continue;
    }
    try {
      await archiveJobAndPersist(job, {
        reason: req.body?.reason || null,
        actor: getRequestActor(req),
      });
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }

  res.json({ ok: true, results });
});

app.get("/api/jobs/:id/quote", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const requestedVersion = parseRequestedQuoteVersion(req.query?.version);
    const { selectedQuoteArtifacts: artifacts } = await readDocumentQuoteArtifacts({
      jobDir: job.dir,
      meta: job.meta,
      requestedVersion,
    });
    const issuanceLedger = await readQuoteIssuanceLedger(job.dir);
    const issuanceRecord = findIssuedQuoteVersion(issuanceLedger, artifacts?.version || requestedVersion, "quote");
    let exactIssuedMarkdown = null;
    if (issuanceRecord) {
      const issuedMarkdown = await readIssuedQuoteArtifact(job.dir, issuanceRecord, "quoteMarkdown");
      if (!issuedMarkdown.available) {
        return res.status(410).json({ error: "the exact issued quote bytes are unavailable" });
      }
      exactIssuedMarkdown = issuedMarkdown.bytes.toString("utf8");
    }
    if (!artifacts?.quoteMarkdown && !exactIssuedMarkdown) {
      return res.status(404).json({ error: "quote not generated" });
    }
    const historical = Boolean(
      artifacts.version
      && Number(artifacts.version) !== Number((await readQuoteArtifacts(job.dir))?.version || artifacts.version),
    );
    // A legacy archive can carry a finalized/sent-looking quote without the
    // exact bytes that were delivered.  Monetary documents must never be
    // reconstructed from that archive (or, worse, from the current draft).
    const issuedVersion = isIssuedQuoteVersion({
      quote: artifacts.quote,
      quoteLifecycle: await readQuoteLifecycle(job.dir),
      version: artifacts.version,
      meta: job.meta,
      issuanceRecord,
    });
    if (!issuanceRecord && issuedVersion) {
      return res.status(410).json({ error: "the exact issued quote bytes are unavailable" });
    }
    assertQuotePricingDisplayable(artifacts.quote, "opened", {
      pipelineStage: job.meta?.pipelineStage,
      historical,
      issuedVersion,
      current: !historical,
    });

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.end(exactIssuedMarkdown || artifacts.quoteMarkdown);
  } catch (err) {
    res.status(err.statusCode || 400).json(errorBody(err));
  }
});

// The PDF of a job's quote, invoice or receipt as GET /api/jobs/:id/quote-pdf
// serves it: a sent quote or an issued invoice from the bytes it was issued
// with, anything else rendered now. { bytes, filename, headers } or
// { status, error }. Also the preview copy a test email attaches.
async function readJobDocumentPdf({ job, documentType = null, version = null, milestoneIndex = null, revision = null }) {
  const resolved = await readPreparedJobDocument({
    jobDir: job.dir,
    meta: job.meta,
    documentType: documentType ?? null,
    requestedVersion: parseRequestedQuoteVersion(version),
    milestoneIndex,
  });
  const artifacts = resolved.selectedQuoteArtifacts;
  const isQuoteDocument = resolved.preparedDocumentType === "quote";
  const issuanceLedger = await readQuoteIssuanceLedger(job.dir);
  // The quote issuance ledger contains quote bytes only. Invoice and
  // receipt requests resolve their own milestone artifact below; consulting
  // the quote ledger here could return a quote PDF for a payment document.
  const issuanceRecord = isQuoteDocument
    ? findIssuedQuoteVersion(
        issuanceLedger,
        resolved.selectedVersion || artifacts?.version || parseRequestedQuoteVersion(version),
        "quote",
      )
    : null;
  const historical = Boolean(
    resolved.selectedVersion
    && resolved.latestVersion
    && Number(resolved.selectedVersion) !== Number(resolved.latestVersion),
  );
  const issuedVersion = isIssuedQuoteVersion({
    quote: resolved.preparedQuote,
    quoteLifecycle: resolved.quoteLifecycle,
    version: resolved.selectedVersion,
    meta: resolved.meta,
    issuanceRecord,
  });
  // A sent quote is served from its issued copy, never re-rendered. Only a
  // quote request asks: an invoice on a job whose quote was sent renders.
  const issuedQuote = await resolveIssuedQuotePdf({
    jobDir: job.dir,
    documentType: resolved.preparedDocumentType,
    issuanceRecord,
    issuedVersion,
    selectedVersion: resolved.selectedVersion,
    storedPdfPath: artifacts?.quotePdfPath,
  });
  if (issuedQuote.gone) return { status: 410, error: "the exact issued quote PDF bytes are unavailable" };
  if (issuedQuote.bytes) {
    return issuedQuote.source === "issuance-ledger"
      ? { bytes: issuedQuote.bytes, filename: "issued-quote.pdf", issued: true, resolved }
      : { bytes: issuedQuote.bytes, filename: buildQuotePdfFilename(job.meta, resolved.preparedQuote, "", "quote"), headers: { "X-Field-Issued-Copy": issuedQuote.source }, issued: true, resolved };
  }
  if (isQuoteDocument && !artifacts?.quote) return { status: 404, error: "quote PDF not generated" };
  // A sent invoice is served from the bytes it was issued with, never
  // re-rendered from the current (possibly since-changed) quote. `?revision=`
  // addresses a superseded revision; without it the current issued revision
  // is returned when one exists.
  const issued = await resolveIssuedMilestoneInvoiceArtifact({
    jobDir: job.dir,
    documentType: resolved.preparedDocumentType,
    milestoneInvoice: resolved.preparedMilestoneInvoice,
    requestedRevision: revision ?? null,
  });
  if (issued.notFound) return { status: 404, error: "invoice revision not found" };
  if (issued.storedArtifact) {
    // The invoice number is customer-editable free text and can contain
    // characters (an em dash, a curly quote) above Latin-1, which Node
    // rejects in a raw header value. Slugify it the same way
    // `buildQuotePdfFilename` slugifies the quote reference.
    return { bytes: issued.storedArtifact.pdfBuffer, filename: buildIssuedInvoicePdfFilename(issued.revision.invoiceNumber), issued: true, resolved };
  }
  if (issued.gone) return { status: 410, error: "the stored PDF for this superseded invoice revision is unavailable" };

  assertQuotePricingDisplayable(resolved.preparedQuote, "previewed", {
    pipelineStage: job.meta?.pipelineStage,
    historical,
    issuedVersion,
    current: !historical,
  });

  const versionSuffix = artifacts.version ? `-${artifacts.label}` : "";
  const pdfName = buildQuotePdfFilename(job.meta, resolved.preparedQuote, versionSuffix, resolved.preparedDocumentType);
  if (resolved.preparedDocumentType === "invoice" || resolved.preparedDocumentType === "receipt") {
    const pdfBuffer = await generateQuotePdfBuffer({
      meta: resolved.preparedMeta,
      quote: resolved.preparedQuote,
      documentType: resolved.preparedDocumentType,
      invoicePaidAmount: resolved.preparedMeta?.invoicePaidAmount,
      jobDir: job.dir,
    });
    return { bytes: pdfBuffer, filename: pdfName, rendered: true, resolved };
  }
  if (!artifacts.quotePdfPath) return { status: 404, error: "quote PDF not generated" };
  return { bytes: await readFile(artifacts.quotePdfPath), filename: pdfName, resolved };
}

app.get("/api/jobs/:id/quote-pdf", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const pdf = await readJobDocumentPdf({
      job,
      documentType: req.query?.documentType ?? null,
      version: req.query?.version,
      milestoneIndex: req.query?.milestoneIndex,
      revision: req.query?.revision ?? null,
    });
    if (pdf.status) return res.status(pdf.status).json({ error: pdf.error });
    res.setHeader("Content-Type", "application/pdf");
    for (const [name, value] of Object.entries(pdf.headers || {})) res.setHeader(name, value);
    res.setHeader("Content-Disposition", pdf.filename === "issued-quote.pdf" ? "inline; filename=issued-quote.pdf" : `inline; filename="${pdf.filename}"`);
    res.end(pdf.bytes);
  } catch (err) {
    res.status(err.statusCode || 400).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/quote-pdf-preview/:previewId", requireAuth, (req, res) => {
  const preview = readQuotePdfPreview({
    jobId: req.params.id,
    previewId: req.params.previewId,
  });
  if (!preview) {
    return res.status(404).json({ error: "quote PDF preview expired" });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${preview.fileName}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(preview.pdfBuffer);
});

app.post("/api/jobs/:id/quote-pdf-preview", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const documentType = resolveJobDocumentType({
      meta: job.meta,
      documentType: req.body?.documentType,
    });
    const { meta: resolvedMeta, selectedQuoteArtifacts: artifacts } = await readDocumentQuoteArtifacts({
      jobDir: job.dir,
      meta: job.meta,
      documentType,
      requestedVersion: parseRequestedQuoteVersion(req.body?.version),
    });
    if (!artifacts?.quote) {
      return res.status(404).json({ error: "quote not generated" });
    }
    const draftOrganizer = req.body?.organizer || null;
    const draftValidityDays = req.body?.validityDays || null;
    const draftScopeText = req.body?.scopeText || null;
    const draftPaymentSchedule = req.body?.paymentSchedule != null
      ? normalizePaymentSchedule(req.body.paymentSchedule)
      : null;
    const presentationOverrides = {
      ...(draftOrganizer ? { organizer: draftOrganizer } : {}),
      ...(draftValidityDays ? { validityDays: draftValidityDays } : {}),
      ...(draftScopeText ? { scopeText: draftScopeText } : {}),
    };
    const previewMeta = draftPaymentSchedule && documentType === "quote"
      ? { ...resolvedMeta, paymentSchedule: draftPaymentSchedule }
      : resolvedMeta;
    const overrides = Object.keys(presentationOverrides).length
      ? { presentation: presentationOverrides }
      : null;
    const previewQuote = overrides
      ? applyPresentationToQuote({
          quote: artifacts.quote,
          overrides,
          defaultScopeText: artifacts.quote.summary || null,
          preferDefaultScopeText: true,
        })
      : artifacts.quote;
    const prepared = await readPreparedJobDocument({
      jobDir: job.dir,
      meta: previewMeta,
      documentType,
      requestedVersion: parseRequestedQuoteVersion(req.body?.version),
      milestoneIndex: req.body?.milestoneIndex,
      quote: previewQuote,
    });

    const issuanceLedger = await readQuoteIssuanceLedger(job.dir);
    const quoteIssuanceRecord = prepared.preparedDocumentType === "quote"
      ? findIssuedQuoteVersion(
          issuanceLedger,
          prepared.selectedVersion || prepared.preparedQuote?.version || artifacts.version,
          "quote",
        )
      : null;
    const historical = Boolean(
      prepared.selectedVersion
      && prepared.latestVersion
      && Number(prepared.selectedVersion) !== Number(prepared.latestVersion),
    );
    const issuedVersion = isIssuedQuoteVersion({
      quote: prepared.preparedQuote,
      quoteLifecycle: prepared.quoteLifecycle,
      version: prepared.selectedVersion,
      meta: prepared.preparedMeta,
      issuanceRecord: quoteIssuanceRecord,
    });
    const issuedQuote = await resolveIssuedQuotePdf({
      jobDir: job.dir,
      documentType: prepared.preparedDocumentType,
      issuanceRecord: quoteIssuanceRecord,
      issuedVersion,
      selectedVersion: prepared.selectedVersion,
      storedPdfPath: prepared.selectedQuoteArtifacts?.quotePdfPath,
    });
    if (issuedQuote.gone) {
      return res.status(410).json({ error: "the exact issued quote PDF bytes are unavailable" });
    }
    if (issuedQuote.bytes) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ok: true,
        ...createQuotePdfPreview({
          jobId: job.meta.id,
          pdfBuffer: issuedQuote.bytes,
          fileName: buildQuotePdfFilename(job.meta, prepared.preparedQuote, "", "quote"),
        }),
      });
    }

    // A sent invoice is previewed from its stored issued bytes, never
    // re-rendered from the current (possibly since-changed) quote. This
    // route keeps its existing request shape — no revision selection here.
    const issued = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir: job.dir,
      documentType: prepared.preparedDocumentType,
      milestoneInvoice: prepared.preparedMilestoneInvoice,
    });
    if (issued.storedArtifact) {
      // The preview GET route below (`/quote-pdf-preview/:previewId`) sets
      // this straight into a Content-Disposition header with no try/catch,
      // so it must already be header-safe here.
      const issuedPreviewPdfName = buildIssuedInvoicePdfFilename(issued.revision.invoiceNumber);
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ok: true,
        ...createQuotePdfPreview({
          jobId: job.meta.id,
          pdfBuffer: issued.storedArtifact.pdfBuffer,
          fileName: issuedPreviewPdfName,
        }),
      });
    }

    assertQuotePricingDisplayable(prepared.preparedQuote, "previewed", {
      pipelineStage: job.meta?.pipelineStage,
      historical,
      issuedVersion,
      current: !historical,
    });

    const pdfBuffer = await generateQuotePdfBuffer({
      meta: prepared.preparedMeta,
      quote: prepared.preparedQuote,
      documentType: prepared.preparedDocumentType,
      invoicePaidAmount: req.body?.invoicePaidAmount ?? prepared.preparedMeta?.invoicePaidAmount,
      jobDir: job.dir,
    });
    const previewPdfName = buildQuotePdfFilename(job.meta, prepared.preparedQuote, "", prepared.preparedDocumentType);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      ...createQuotePdfPreview({
        jobId: job.meta.id,
        pdfBuffer,
        fileName: previewPdfName,
      }),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/milestones/:index/pdf", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const resolved = await readPreparedJobDocument({
      jobDir: job.dir,
      meta: job.meta,
      documentType: "invoice",
      milestoneIndex: req.params.index,
    });
    const artifacts = resolved.selectedQuoteArtifacts;
    if (!artifacts?.quote) {
      return res.status(404).json({ error: "quote not generated" });
    }
    if (!resolved.preparedMilestoneInvoice) {
      return res.status(404).json({ error: "milestone invoice not found" });
    }

    // A revision that has been issued is served from the bytes that were
    // issued, never re-rendered. `?revision=` addresses superseded revisions;
    // without it the current revision is returned.
    const issued = await resolveIssuedMilestoneInvoiceArtifact({
      jobDir: job.dir,
      documentType: resolved.preparedDocumentType,
      milestoneInvoice: resolved.preparedMilestoneInvoice,
      requestedRevision: req.query?.revision ?? null,
    });
    if (issued.notFound) {
      return res.status(404).json({ error: "invoice revision not found" });
    }
    if (issued.storedArtifact) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        // See the /quote-pdf route above: slugify the invoice number so a
        // non-Latin-1 character never reaches a raw header value.
        `inline; filename="${buildIssuedInvoicePdfFilename(issued.revision.invoiceNumber)}"`,
      );
      res.setHeader("Cache-Control", "no-store");
      return res.end(issued.storedArtifact.pdfBuffer);
    }
    if (issued.gone) {
      return res.status(410).json({ error: "the stored PDF for this superseded invoice revision is unavailable" });
    }

    const historical = Boolean(
      resolved.selectedVersion
      && resolved.latestVersion
      && Number(resolved.selectedVersion) !== Number(resolved.latestVersion),
    );
    const issuedVersion = isIssuedQuoteVersion({
      quote: resolved.preparedQuote,
      quoteLifecycle: resolved.quoteLifecycle,
      version: resolved.selectedVersion,
      meta: resolved.preparedMeta,
    });
    assertQuotePricingDisplayable(resolved.preparedQuote, "previewed", {
      pipelineStage: job.meta?.pipelineStage,
      historical,
      issuedVersion,
      current: !historical,
    });

    const pdfBuffer = await generateQuotePdfBuffer({
      meta: resolved.preparedMeta,
      quote: resolved.preparedQuote,
      documentType: resolved.preparedDocumentType,
      invoicePaidAmount: resolved.preparedMeta?.invoicePaidAmount,
      jobDir: job.dir,
    });
    const pdfName = buildQuotePdfFilename(job.meta, resolved.preparedQuote, "", resolved.preparedDocumentType);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${pdfName}"`);
    res.setHeader("Cache-Control", "no-store");
    res.end(pdfBuffer);
  } catch (err) {
    res.status(err.statusCode || 400).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/internal-breakdown", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const selectedVersion = parseRequestedQuoteVersion(req.query?.version);
    const detail = await loadJobDetail(job, { version: selectedVersion });
    if (!detail.quote) {
      return res.status(404).json({ error: "quote not generated" });
    }
    const historical = Boolean(detail.versionView && !detail.versionView.isLatest);
    const issuedVersion = Boolean(detail.versionView?.selectedVersionIssued);
    assertQuotePricingDisplayable(detail.quote, "opened", {
      pipelineStage: detail.meta?.pipelineStage,
      historical,
      issuedVersion,
      current: !historical,
    });
    const visibleDetail = serializeClientJobDetail(detail, { historical, issuedVersion });

    // HTML rendering is retired. The endpoint serves machine-readable
    // breakdowns: markdown by default, JSON on request. Only callers that
    // explicitly ask for `format=html` get redirected to the SPA shell —
    // never the implicit fallthrough that was making API callers think the
    // endpoint was broken.
    const requestedFormat = String(req.query?.format || "md").trim().toLowerCase();

    if (requestedFormat === "json") {
      res.json({
        ok: true,
        version: detail.quote?.version || null,
        meta: visibleDetail.meta || job.meta,
        quote: visibleDetail.quote,
      });
      return;
    }

    if (requestedFormat === "html") {
      res.redirect(302, `/#/jobs/${encodeURIComponent(job.meta.id)}`);
      return;
    }

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.end(buildInternalBreakdownMarkdown({
      meta: visibleDetail.meta || job.meta,
      quote: visibleDetail.quote,
    }));
  } catch (err) {
    res.status(err.statusCode || 400).json(errorBody(err));
  }
});

// Deleting is permanent, so only a job nobody has put anything into may be
// deleted (see server/job-deletion.js). Everything else is archived instead.
function jobDeletionDeps() {
  return {
    getNotes: async (jobId) => (fieldDb && jobId ? getNotesForJob(fieldDb, jobId) : []),
    listScheduledEmails: async (jobId) => (jobId ? listScheduledEmails({ dataDir: DATA_DIR, jobId }) : []),
  };
}

async function deleteUntouchedJob(job, logLabel) {
  try {
    return await runExclusiveJobMutation(job.meta.id, "job delete", async () => {
      const assessment = await assessJobDeletion(job, jobDeletionDeps());
      if (!assessment.deletable) {
        return { ok: false, status: 409, error: JOB_NOT_DELETABLE_ERROR, reasons: assessment.reasons };
      }

      const folderId = job.meta.driveFileIds?.folderId;
      if (folderId) {
        try {
          const drive = getDriveClient(config);
          await drive.files.update({ fileId: folderId, requestBody: { trashed: true }, supportsAllDrives: true });
        } catch (err) {
          console.error(`[${logLabel}] drive trash ${job.meta.id} failed (non-fatal): ${err.message}`);
        }
      }

      await rm(job.dir, { recursive: true, force: true });
      if (fieldDb) deleteJob(fieldDb, job.meta.id);
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, status: err.statusCode || 500, error: err.message };
  }
}

// Stream audio
// Delete a single job (local files + Drive trash)
app.delete("/api/jobs/:id", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const result = await deleteUntouchedJob(job, "delete");
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, ...(result.reasons ? { reasons: result.reasons } : {}) });
  }
  res.json({ ok: true });
});

// Bulk delete jobs (local files + Drive trash). Jobs that may not be deleted
// are kept and reported with their reasons; the rest are deleted.
app.post("/api/jobs/bulk-delete", requireAuth, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids required" });

  const results = [];
  for (const id of ids) {
    const job = await findJob(id);
    if (!job) { results.push({ id, ok: false, error: "not found" }); continue; }

    const result = await deleteUntouchedJob(job, "bulk-delete");
    results.push(result.ok
      ? { id, ok: true }
      : { id, ok: false, error: result.error, ...(result.reasons ? { reasons: result.reasons } : {}) });
  }

  res.json({ results });
});

app.post("/api/jobs/:id/versions", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "fork quote version", async () => runAtomicJobGeneration(
      job.dir,
      async (stagedJobDir) => {
        const stagedMeta = await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta);
        const currentArtifacts = await readQuoteArtifacts(stagedJobDir);
        if (!currentArtifacts?.quote) {
          const error = new Error("no current quote to fork");
          error.statusCode = 409;
          throw error;
        }
        if (!existsSync(join(job.dir, "transcript.json")) || !existsSync(join(stagedJobDir, "quote-inputs.json"))) {
          const error = new Error("fresh quote inputs are required before a new version can be created");
          error.statusCode = 409;
          throw error;
        }
        const rebuilt = await regenerateRecordingQuote({
          jobDir: stagedJobDir,
          operationalJobDir: job.dir,
          meta: stagedMeta,
          transcript: JSON.parse(await readFile(join(job.dir, "transcript.json"), "utf8")),
          config,
          provenance: getRequestProvenance(req),
          actor: getRequestActor(req),
          forceForkSentQuote: true,
          inExistingGeneration: true,
          buildReason: "quote_version_fork",
        });
        return {
          previousVersion: Number(currentArtifacts.quote.version || stagedMeta.quoteVersion || 1),
          currentVersion: Number(rebuilt?.quote?.version || rebuilt?.meta?.quoteVersion || 0) || null,
        };
      },
      { timeoutMs: 120_000 },
    ));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.delete("/api/jobs/:id/versions/:version", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    await deleteQuoteVersion(job.dir, req.params.version);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/versions/:version/promote", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  const startTime = Date.now();
  const jobId = job.meta.id;
  const version = req.params.version;

  try {
    console.log(`[promote-version] Starting: job=${jobId} version=${version}`);
    const promoted = await runAtomicJobGeneration(job.dir, async (stagedJobDir) => {
      const sourceVersion = parseQuoteVersion(req.params.version);
      const sourceDir = sourceVersion
        ? join(stagedJobDir, "quote-versions", formatQuoteVersionLabel(sourceVersion))
        : null;
      const sourceQuotePath = sourceDir ? join(sourceDir, "quote.json") : null;
      if (!sourceVersion || !sourceDir || !existsSync(sourceQuotePath)) {
        const error = new Error("quote version not found");
        error.statusCode = 404;
        throw error;
      }
      const currentArtifacts = await readQuoteArtifacts(stagedJobDir);
      if (!currentArtifacts?.quote) {
        const error = new Error("no current quote to promote from");
        error.statusCode = 409;
        throw error;
      }
      // The current quote's transcript and measurements are root-authoritative
      // and never copied into the staged generation.
      const currentContext = await readQuotePromotionContext(stagedJobDir, { operationalJobDir: job.dir });
      const sourceContext = await readQuotePromotionContext(sourceDir);
      const transcript = sourceContext.transcript || currentContext.transcript;
      const quoteInputs = sourceContext.quoteInputs || currentContext.quoteInputs;
      if (!transcript || !quoteInputs) {
        const error = new Error("the selected quote version has no rebuildable quote context");
        error.statusCode = 409;
        throw error;
      }
      const rebuilt = await regenerateRecordingQuote({
        jobDir: stagedJobDir,
        operationalJobDir: job.dir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        config,
        provenance: getRequestProvenance(req),
        actor: getRequestActor(req),
        forceForkSentQuote: true,
        inExistingGeneration: true,
        transcript,
        quoteInputs,
        moasureSummary: sourceContext.moasureSummary || undefined,
        contextSnapshot: currentContext,
        buildReason: "quote_version_promote",
      });
      const currentVersion = Number(rebuilt?.quote?.version || rebuilt?.meta?.quoteVersion || 0) || null;
      return {
        previousVersion: Number(currentArtifacts.quote.version || 1),
        currentVersion,
        sourceVersion,
        meta: rebuilt?.meta || null,
      };
    });
    const { currentVersion, previousVersion, sourceVersion } = promoted;
    console.log(`[promote-version] Rebuilt source v${sourceVersion} as fresh v${currentVersion} from v${previousVersion} (${Date.now() - startTime}ms)`);
    console.log(`[promote-version] Meta/lifecycle published: job=${jobId} (${Date.now() - startTime}ms)`);

    if (fieldDb) {
      try {
        upsertJob(fieldDb, {
          id: job.meta.id,
          dateDir: job.dateDir,
          dir: job.dir,
          title: job.meta.title || job.meta.siteAddress || null,
          siteAddress: job.meta.siteAddress || null,
          quoteNumber: promoted.meta?.quoteNumber || job.meta?.quoteNumber || null,
          createdAt: job.meta.createdAt,
          updatedAt: new Date().toISOString(),
        });
        console.log(`[promote-version] DB updated: job=${jobId} (${Date.now() - startTime}ms)`);
      } catch (e) {
        console.warn(`[promote-version] DB update failed (best-effort): job=${jobId} ${e.message}`);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`[promote-version] Complete: job=${jobId} (${totalTime}ms)`);
    res.json({ ok: true, currentVersion, previousVersion, sourceVersion });
  } catch (err) {
    console.error(`[promote-version] Error: job=${jobId} version=${version} (${Date.now() - startTime}ms) ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

function scheduledEmailActor(user) {
  if (!user) return null;
  return { id: user.id || null, email: user.email || null, name: user.name || null };
}

function scheduledEmailSender(user) {
  if (!user) return null;
  const gmail = user.settings?.gmail || null;
  return {
    id: user.id || null,
    email: user.email || null,
    name: user.name || null,
    kind: user.kind || null,
    settings: gmail ? {
      gmail: {
        email: gmail.email || null,
        fromEmail: gmail.fromEmail || null,
        replyTo: gmail.replyTo || null,
      },
    } : undefined,
  };
}

function milestoneScheduleSignature(invoice) {
  if (!invoice) return null;
  return JSON.stringify({
    milestoneIndex: invoice.milestoneIndex ?? null,
    invoiceNumber: invoice.invoiceNumber || null,
    receiptNumber: invoice.receiptNumber || null,
    revisionNumber: invoice.revisionNumber ?? invoice.issuedRevision?.revisionNumber ?? null,
    status: invoice.status || null,
    total: invoice.total ?? null,
    amountPaid: invoice.amountPaid ?? null,
    issuedAt: invoice.issuedAt || null,
    paidAt: invoice.paidAt || null,
  });
}

async function buildScheduledDocumentSnapshot({ job, payload }) {
  const context = await readDocumentQuoteArtifacts({
    jobDir: job.dir,
    meta: normalizeJobMeta(job.meta),
    documentType: payload.documentType || null,
    requestedVersion: payload.version || "latest",
    intent: "delivery",
  });
  const documentType = context.resolvedDocumentType;
  const milestoneIndex = payload.milestoneIndex ?? null;
  const milestoneInvoice = documentType === "invoice" || documentType === "receipt"
    ? resolveRequestedMilestoneInvoice({ meta: context.meta, milestoneIndex })
    : null;
  return {
    documentType,
    quoteVersion: context.selectedVersion || context.selectedQuoteArtifacts?.quote?.version || context.meta?.quoteVersion || null,
    milestoneIndex: milestoneInvoice?.milestoneIndex ?? milestoneIndex,
    invoiceNumber: milestoneInvoice?.invoiceNumber || null,
    milestoneSignature: milestoneScheduleSignature(milestoneInvoice),
  };
}

function uploadedEmailAttachments(files) {
  return Array.isArray(files)
    ? files.map((file) => ({
        filename: file.originalname || "attachment",
        contentType: file.mimetype || "application/octet-stream",
        buffer: file.buffer,
      }))
    : [];
}

async function processScheduledEmail(record) {
  const job = await findJob(record.jobId);
  if (!job) throw new Error("job no longer exists");
  const payload = record.payload || {};
  // The person the attempt goes as: whoever sent it, kept while an earlier
  // attempt is unknown even when someone else edits it (its mailbox is the
  // one searched and sent from).
  const user = record.deliverySender || record.sender || null;

  if (payload.kind === "document") {
    const currentSnapshot = await buildScheduledDocumentSnapshot({
      job,
      payload: {
        ...payload,
        version: record.snapshot?.quoteVersion || payload.version || null,
        milestoneIndex: record.snapshot?.milestoneIndex ?? payload.milestoneIndex ?? null,
      },
    });
    if (
      record.snapshot?.milestoneSignature
      && currentSnapshot.milestoneSignature !== record.snapshot.milestoneSignature
    ) {
      const changed = new Error("the selected invoice or receipt changed after this email was scheduled; review it and schedule a new send");
      changed.deliveryOutcome = "rejected_before_dispatch";
      throw changed;
    }
    return await runExclusiveJobMutation(job.meta.id, "send scheduled quote/invoice", async () => {
      return await sendJobQuote({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        dataDir: DATA_DIR,
        config,
        user,
        to: payload.to,
        cc: payload.cc || [],
        bcc: payload.bcc || [],
        customBody: payload.customBody || null,
        documentType: record.snapshot?.documentType || payload.documentType || null,
        invoicePaidAmount: payload.invoicePaidAmount ?? null,
        milestoneIndex: record.snapshot?.milestoneIndex ?? payload.milestoneIndex ?? null,
        quoteVersion: record.snapshot?.quoteVersion || payload.version || null,
        themeFontFamily: payload.themeFontFamily || null,
        subjectOverride: payload.subject || null,
        attachmentFilename: payload.attachmentFilename || null,
        additionalAttachments: record.loadedAttachments || [],
        scheduledEmailId: record.id,
        scheduledAt: record.scheduledAt,
        // The recorded references: read again, and refused for review if
        // their bytes changed or they were credited or voided since.
        documents: payload.documents || [],
        thread: await resolveReplyThread({ jobDir: job.dir, inReplyTo: payload.inReplyTo }),
      });
    });
  }

  // Read again at dispatch, as recorded when the email was written.
  const loadedDocuments = await loadDocumentAttachments({
    service: issuedDocumentRecorder.service || null,
    jobId: job.meta.id,
    refs: payload.documents || [],
    meta: normalizeJobMeta(job.meta),
  });
  const merge = buildEmailMergeValues({
    meta: normalizeJobMeta(job.meta),
    quote: await jobQuoteForEmail(job),
    config,
    user,
    attachmentNames: [...loadedDocuments.map((document) => document.filename), ...(record.loadedAttachments || []).map((file) => file.filename)],
    adjustmentNote: payload.adjustmentNote ? await adjustmentNoteValues(issuedDocumentRecorder.service || null, payload.adjustmentNote) : null,
  });
  // A job email carries a Message-ID made from the queue record's delivery
  // attempt id. The first attempt stores the full Message-ID, the mailbox and
  // what it sent before Gmail is called; after an unknown outcome, that
  // mailbox's Sent Mail is searched for that Message-ID first.
  const reconciling = record.reconcileBeforeSend === true;
  if (reconciling && record.unknownFailureAt && Date.now() - Date.parse(record.unknownFailureAt) < RESEND_SETTLE_MS) {
    const settling = new Error("Gmail may still be delivering this email. Try again in a few minutes.");
    settling.statusCode = 409;
    settling.code = "DELIVERY_STILL_SETTLING";
    settling.deliveryOutcome = "rejected_before_dispatch";
    throw settling;
  }
  const deliveryMessageId = record.deliveryMessageId || (record.deliveryAttemptId
    ? formatDeliveryMessageId(record.deliveryAttemptId, resolveMessageIdHost({ config, user }))
    : null);
  const subject = applyMergeFieldsToText(payload.subject, merge, { final: true });
  const customBody = payload.customBody ? applyMergeFields(payload.customBody, merge, { final: true }) : null;
  const thread = await resolveReplyThread({ jobDir: job.dir, inReplyTo: payload.inReplyTo });
  let result = null;
  if (reconciling && deliveryMessageId) {
    const found = await findSentMessageInMailbox({ config, user, mailbox: record.deliveryMailbox || null, messageId: deliveryMessageId });
    if (found) {
      // It went the first time: record what went then (not a later edit),
      // and send nothing.
      const archived = (await readSentEmailArchive(job.dir).catch(() => [])).some((entry) => entry.scheduledEmailId === record.id);
      const first = record.firstSent || composeFirstSentFallback({ job, payload, subject, customBody });
      result = {
        ...first,
        id: found.id,
        threadId: found.threadId,
        reconciled: true,
        attachments: first.attachments || [],
      };
      // The documents the first attempt carried, not the edit's.
      const firstUids = new Set((first.attachments || []).map((entry) => entry.uid).filter(Boolean));
      await recordAttachedDocumentsEmailed({ jobId: job.meta.id, attachments: loadedDocuments.filter((document) => firstUids.has(document.uid)), result, user });
      if (!archived) {
        await appendSentEmailArchive({
          jobDir: job.dir,
          record: {
            kind: "email.sent",
            documentType: "email",
            scheduledEmailId: record.id,
            scheduledAt: record.scheduledAt,
            messageId: found.id,
            threadId: found.threadId,
            rfcMessageId: deliveryMessageId,
            // The chain the first attempt went with, not the edit's.
            references: first.references !== undefined ? first.references : thread?.references || null,
            reconciled: true,
            authMode: result.authMode || null,
            gmailUser: result.gmailUser || record.deliveryMailbox || null,
            from: result.from || null,
            fromName: result.fromName || null,
            replyTo: result.replyTo || null,
            to: result.to,
            cc: result.cc,
            bcc: result.bcc,
            subject: result.subject,
            bodyText: result.bodyText,
            htmlBody: result.htmlBody,
            attachments: result.attachments,
            sentBy: scheduledEmailActor(user),
          },
        });
      }
      return result;
    }
  }
  result = await sendJobEmail({
    config,
    user,
    meta: normalizeJobMeta(job.meta),
    to: payload.to,
    cc: payload.cc || [],
    bcc: payload.bcc || [],
    subject,
    customBody,
    themeFontFamily: payload.themeFontFamily || null,
    additionalAttachments: [...documentMimeAttachments(loadedDocuments), ...(record.loadedAttachments || [])],
    deliveryAttemptId: record.deliveryAttemptId || null,
    messageId: deliveryMessageId,
    // A resend after an unknown attempt goes only from that attempt's mailbox.
    mailbox: reconciling ? record.deliveryMailbox || null : null,
    onBeforeDispatch: record.stampDelivery || null,
    thread,
  });
  await recordAttachedDocumentsEmailed({ jobId: job.meta.id, attachments: loadedDocuments, result, user });
  await appendSentEmailArchive({
    jobDir: job.dir,
    record: {
      kind: "email.sent",
      documentType: "email",
      scheduledEmailId: record.id,
      scheduledAt: record.scheduledAt,
      messageId: result.id,
      rfcMessageId: deliveryMessageId,
      references: thread?.references || null,
      threadId: result.threadId,
      authMode: result.authMode,
      gmailUser: result.gmailUser,
      from: result.from,
      fromName: result.fromName,
      replyTo: result.replyTo,
      to: result.to,
      cc: result.cc,
      bcc: result.bcc,
      subject: result.subject,
      bodyText: result.bodyText,
      htmlBody: result.htmlBody,
      attachments: result.attachments,
      sentBy: scheduledEmailActor(user),
    },
  });
  return result;
}

/** What an older record (stored before Field kept the first attempt's content) went with, as best known. */
function composeFirstSentFallback({ job, payload, subject, customBody }) {
  const composed = composeJobEmail({ meta: normalizeJobMeta(job.meta), subject, customBody, themeFontFamily: payload.themeFontFamily || null });
  return { to: payload.to, cc: payload.cc || [], bcc: payload.bcc || [], subject: composed.subject, bodyText: composed.body, htmlBody: composed.htmlBody, attachments: [] };
}

app.post("/api/jobs/:id/email-quote", requireAuth, emailUploads, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  let payload = req.body || {};
  if (payload.payload) {
    try {
      payload = JSON.parse(payload.payload);
    } catch {
      return res.status(400).json({ error: "invalid email payload" });
    }
  }

  const to = payload?.to;
  const cc = payload?.cc || [];
  const bcc = payload?.bcc || [];
  const customBody = payload?.customBody || null;
  const documentType = payload?.documentType || null;
  const invoicePaidAmount = payload?.invoicePaidAmount ?? null;
  const additionalAttachments = uploadedEmailAttachments(req.files);
  if (!to) return res.status(400).json({ error: "recipient email required" });

  try {
    // Field documents attached by uid (`documents: [{ uid }]`).
    const documentService = emailDocumentService(req);
    const documentRefs = parseDocumentRefs(payload?.documents);
    if (payload?.attachCreditNote === true && documentType === "invoice") {
      // "Also attach the adjustment note" (#45): the credit note's issued
      // document by uid when the database has it (it then gets its own
      // emailed event), else its stored bytes as before.
      const number = await creditNoteNumberFor({ jobDir: job.dir, milestoneIndex: payload?.milestoneIndex ?? null });
      const issued = number && documentService
        ? await documentService.findIssuedDocument({ documentType: "credit_note", number }).catch(() => null)
        : null;
      if (issued) {
        if (!documentRefs.includes(issued.uid)) documentRefs.push(issued.uid);
      } else {
        additionalAttachments.push(await creditNoteAttachment({ jobDir: job.dir, milestoneIndex: payload?.milestoneIndex ?? null, issuedDocuments: issuedDocumentRecorder.service || null }));
      }
    }
    // Read and checked now, so a bad reference or an email over the limits
    // is refused before anything is queued, prepared or sent.
    const loadedDocuments = await loadDocumentAttachments({
      service: documentService,
      jobId: job.meta.id,
      refs: documentRefs,
      meta: normalizeJobMeta(job.meta),
    });
    assertEmailAttachmentLimits({ documents: loadedDocuments, uploads: additionalAttachments });
    const documentRecords = loadedDocuments.map(documentAttachmentRecord);
    if (payload?.test === true) {
      const result = await sendTestCopy({ req, job, payload, documentType: documentType || "quote", loadedDocuments, uploads: additionalAttachments });
      return res.json({ ok: true, test: true, result });
    }
    const holdSeconds = normalizeHoldSeconds(payload?.holdSeconds);
    if (payload?.scheduledAt || holdSeconds != null) {
      assertAllowedQuoteRecipients({ config, emails: to, label: "recipient" });
      assertAllowedQuoteRecipients({ config, emails: cc, label: "cc", required: false });
      assertAllowedQuoteRecipients({ config, emails: bcc, label: "bcc", required: false });
      const snapshot = await buildScheduledDocumentSnapshot({ job, payload });
      const scheduledPayload = {
        kind: "document",
        to,
        cc,
        bcc,
        customBody,
        documentType: snapshot.documentType,
        invoicePaidAmount,
        milestoneIndex: snapshot.milestoneIndex,
        version: snapshot.quoteVersion,
        themeFontFamily: payload?.themeFontFamily ?? null,
        subject: payload?.subject ?? null,
        attachmentFilename: payload?.attachmentFilename ?? null,
        documents: documentRecords,
        inReplyTo: payload?.inReplyTo ?? null,
      };
      const scheduledEmail = payload?.draftId
        ? await rescheduleEmailDraft({
          dataDir: DATA_DIR,
          jobId: job.meta.id,
          id: payload.draftId,
          scheduledAt: payload.scheduledAt,
          holdSeconds,
          keepAttachments: Array.isArray(payload?.keepAttachments) ? payload.keepAttachments : null,
          payload: scheduledPayload,
          snapshot,
          attachments: additionalAttachments,
          updatedBy: scheduledEmailActor(req.caller),
          sender: scheduledEmailSender(req.caller),
        })
        : await createScheduledEmail({
        dataDir: DATA_DIR,
        jobId: job.meta.id,
        scheduledAt: payload.scheduledAt,
        holdSeconds,
        payload: scheduledPayload,
        snapshot,
        attachments: additionalAttachments,
        createdBy: scheduledEmailActor(req.caller),
        sender: scheduledEmailSender(req.caller),
      });
      if (holdSeconds != null) wakeSchedulerAfter(holdSeconds);
      return res.status(202).json({ ok: true, scheduled: true, held: holdSeconds != null, scheduledEmail });
    }
    if (payload?.draftId) {
      const snapshot = await buildScheduledDocumentSnapshot({ job, payload });
      const sent = await sendEmailDraftNow({
        dataDir: DATA_DIR,
        jobId: job.meta.id,
        id: payload.draftId,
        payload: {
          kind: "document",
          to,
          cc,
          bcc,
          customBody,
          documentType: snapshot.documentType,
          invoicePaidAmount,
          milestoneIndex: snapshot.milestoneIndex,
          version: snapshot.quoteVersion,
          themeFontFamily: payload?.themeFontFamily ?? null,
          subject: payload?.subject ?? null,
          attachmentFilename: payload?.attachmentFilename ?? null,
          documents: documentRecords,
          inReplyTo: payload?.inReplyTo ?? null,
        },
        snapshot,
        attachments: additionalAttachments,
        updatedBy: scheduledEmailActor(req.caller),
        sender: scheduledEmailSender(req.caller),
        processEmail: processScheduledEmail,
      });
      return res.json({ ok: true, result: sent.result, scheduledEmail: sent.scheduledEmail });
    }
    // sendJobQuote mints and persists issued revisions for invoice/receipt
    // sends — every other milestone mutation is already serialized through
    // this same lock; this was the one unlocked path where a send racing a
    // revise could read pre-revise state and persist after the revise
    // commits, silently erasing a freshly minted revision.
    const result = await runExclusiveJobMutation(job.meta.id, "send quote/invoice", async () => {
      return await sendJobQuote({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        dataDir: DATA_DIR,
        config,
        user: req.caller,
        to,
        cc,
        bcc,
        customBody,
        documentType,
        invoicePaidAmount,
        milestoneIndex: payload?.milestoneIndex ?? null,
        quoteVersion: payload?.version ?? null,
        themeFontFamily: payload?.themeFontFamily ?? null,
        subjectOverride: payload?.subject ?? null,
        attachmentFilename: payload?.attachmentFilename ?? null,
        additionalAttachments,
        documents: documentRefs,
        thread: await resolveReplyThread({ jobDir: job.dir, inReplyTo: payload?.inReplyTo }),
        documentService,
      });
    });
    res.json({ ok: true, result });
  } catch (err) {
    if (err instanceof EmailAttachmentError) {
      return res.status(err.statusCode).json(emailAttachmentErrorBody(err));
    }
    console.error(`[email-quote] ${job.meta.id} failed: ${err.message}`);
    const isAuthExpired = !hasServiceAccountGmail(config, { user: req.caller })
      && (/invalid_grant/i.test(err.message) || /not configured for (quote|job email) sending/i.test(err.message));
    res.status(isAuthExpired ? 401 : (err.statusCode || 500)).json(sendErrorBody(err, isAuthExpired));
  }
});

app.post("/api/jobs/:id/email", requireAuth, emailUploads, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  let payload = req.body || {};
  if (payload.payload) {
    try {
      payload = JSON.parse(payload.payload);
    } catch {
      return res.status(400).json({ error: "invalid email payload" });
    }
  }

  const to = payload?.to;
  const cc = payload?.cc || [];
  const bcc = payload?.bcc || [];
  const subject = payload?.subject?.trim();
  const customBody = payload?.customBody || null;
  const additionalAttachments = uploadedEmailAttachments(req.files);
  if (!to) return res.status(400).json({ error: "recipient email required" });
  if (!subject) return res.status(400).json({ error: "email subject required" });

  try {
    const documentService = emailDocumentService(req);
    const loadedDocuments = await loadDocumentAttachments({
      service: documentService,
      jobId: job.meta.id,
      refs: parseDocumentRefs(payload?.documents),
      meta: normalizeJobMeta(job.meta),
    });
    assertEmailAttachmentLimits({ documents: loadedDocuments, uploads: additionalAttachments });
    const documentRecords = loadedDocuments.map(documentAttachmentRecord);
    if (payload?.test === true) {
      const result = await sendTestCopy({ req, job, payload, loadedDocuments, uploads: additionalAttachments });
      return res.json({ ok: true, test: true, result });
    }
    const holdSeconds = normalizeHoldSeconds(payload?.holdSeconds);
    if (payload?.scheduledAt || holdSeconds != null) {
      assertAllowedQuoteRecipients({ config, emails: to, label: "recipient" });
      assertAllowedQuoteRecipients({ config, emails: cc, label: "cc", required: false });
      assertAllowedQuoteRecipients({ config, emails: bcc, label: "bcc", required: false });
      const scheduledPayload = {
        kind: "email",
        to,
        cc,
        bcc,
        subject,
        customBody,
        themeFontFamily: payload?.themeFontFamily ?? null,
        documentType: "email",
        documents: documentRecords,
        inReplyTo: payload?.inReplyTo ?? null,
        adjustmentNote: payload?.adjustmentNote ?? null,
      };
      const scheduledEmail = payload?.draftId
        ? await rescheduleEmailDraft({
          dataDir: DATA_DIR,
          jobId: job.meta.id,
          id: payload.draftId,
          scheduledAt: payload.scheduledAt,
          holdSeconds,
          keepAttachments: Array.isArray(payload?.keepAttachments) ? payload.keepAttachments : null,
          payload: scheduledPayload,
          attachments: additionalAttachments,
          updatedBy: scheduledEmailActor(req.caller),
          sender: scheduledEmailSender(req.caller),
        })
        : await createScheduledEmail({
        dataDir: DATA_DIR,
        jobId: job.meta.id,
        scheduledAt: payload.scheduledAt,
        holdSeconds,
        payload: scheduledPayload,
        attachments: additionalAttachments,
        createdBy: scheduledEmailActor(req.caller),
        sender: scheduledEmailSender(req.caller),
      });
      if (holdSeconds != null) wakeSchedulerAfter(holdSeconds);
      return res.status(202).json({ ok: true, scheduled: true, held: holdSeconds != null, scheduledEmail });
    }
    if (payload?.draftId) {
      const sent = await sendEmailDraftNow({
        dataDir: DATA_DIR,
        jobId: job.meta.id,
        id: payload.draftId,
        payload: {
          kind: "email",
          to,
          cc,
          bcc,
          subject,
          customBody,
          themeFontFamily: payload?.themeFontFamily ?? null,
          documentType: "email",
          documents: documentRecords,
          inReplyTo: payload?.inReplyTo ?? null,
          adjustmentNote: payload?.adjustmentNote ?? null,
        },
        attachments: additionalAttachments,
        updatedBy: scheduledEmailActor(req.caller),
        sender: scheduledEmailSender(req.caller),
        processEmail: processScheduledEmail,
      });
      return res.json({ ok: true, result: sent.result, scheduledEmail: sent.scheduledEmail });
    }
    const merge = buildEmailMergeValues({
      meta: normalizeJobMeta(job.meta),
      quote: await jobQuoteForEmail(job),
      config,
      user: req.caller,
      attachmentNames: [...loadedDocuments.map((document) => document.filename), ...additionalAttachments.map((file) => file.filename)],
      adjustmentNote: payload?.adjustmentNote ? await adjustmentNoteValues(documentService, payload.adjustmentNote) : null,
    });
    const result = await sendJobEmail({
      config,
      user: req.caller,
      meta: normalizeJobMeta(job.meta),
      to,
      cc,
      bcc,
      subject: applyMergeFieldsToText(subject, merge, { final: true }),
      customBody: customBody ? applyMergeFields(customBody, merge, { final: true }) : customBody,
      themeFontFamily: payload?.themeFontFamily ?? null,
      additionalAttachments: [...documentMimeAttachments(loadedDocuments), ...additionalAttachments],
      thread: await resolveReplyThread({ jobDir: job.dir, inReplyTo: payload?.inReplyTo }),
    });
    await recordAttachedDocumentsEmailed({ jobId: job.meta.id, attachments: loadedDocuments, result, user: req.caller });
    await appendSentEmailArchive({
      jobDir: job.dir,
      record: {
        kind: "email.sent",
        documentType: "email",
        messageId: result.id,
        threadId: result.threadId,
        authMode: result.authMode,
        gmailUser: result.gmailUser,
        from: result.from,
        fromName: result.fromName,
        replyTo: result.replyTo,
        to: result.to,
        cc: result.cc,
        bcc: result.bcc,
        subject: result.subject,
        bodyText: result.bodyText,
        htmlBody: result.htmlBody,
        attachments: result.attachments,
        sentBy: req.caller ? { id: req.caller.id, email: req.caller.email, name: req.caller.name } : null,
      },
    });
    res.json({ ok: true, result });
  } catch (err) {
    if (err instanceof EmailAttachmentError) {
      return res.status(err.statusCode).json(emailAttachmentErrorBody(err));
    }
    console.error(`[job-email] ${job.meta.id} failed: ${err.message}`);
    const isAuthExpired = !hasServiceAccountGmail(config, { user: req.caller })
      && (/invalid_grant/i.test(err.message) || /not configured for job email sending/i.test(err.message));
    res.status(isAuthExpired ? 401 : (err.statusCode || 500)).json(sendErrorBody(err, isAuthExpired));
  }
});

// Drafts on the server: the composer saves as the operator writes, uploads
// included, so leaving the page or a Gmail sign-in redirect loses nothing.
app.post("/api/jobs/:id/email-drafts", requireAuth, emailUploads, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  let payload = req.body || {};
  if (payload.payload) {
    try {
      payload = JSON.parse(payload.payload);
    } catch {
      return res.status(400).json({ error: "invalid email payload" });
    }
  }
  try {
    const uploads = uploadedEmailAttachments(req.files);
    const documentRecords = (await loadDocumentAttachments({
      service: emailDocumentService(req),
      jobId: job.meta.id,
      refs: parseDocumentRefs(payload?.documents),
      meta: normalizeJobMeta(job.meta),
    })).map(documentAttachmentRecord);
    const documentType = ["quote", "invoice", "receipt"].includes(payload?.documentType) ? payload.documentType : null;
    const snapshot = documentType ? await buildScheduledDocumentSnapshot({ job, payload }).catch(() => null) : null;
    const draftPayload = {
      kind: documentType ? "document" : "email",
      to: payload?.to || [],
      cc: payload?.cc || [],
      bcc: payload?.bcc || [],
      subject: payload?.subject ?? null,
      customBody: payload?.customBody ?? null,
      documentType: documentType || "email",
      invoicePaidAmount: payload?.invoicePaidAmount ?? null,
      milestoneIndex: snapshot?.milestoneIndex ?? payload?.milestoneIndex ?? null,
      version: snapshot?.quoteVersion ?? payload?.version ?? null,
      attachmentFilename: payload?.attachmentFilename ?? null,
      attachCreditNote: payload?.attachCreditNote === true,
      documents: documentRecords,
      inReplyTo: payload?.inReplyTo ?? null,
      adjustmentNote: payload?.adjustmentNote ?? null,
    };
    const scheduledEmail = await saveEmailDraft({
      dataDir: DATA_DIR,
      jobId: job.meta.id,
      id: payload?.draftId || null,
      payload: draftPayload,
      snapshot,
      attachments: uploads,
      keepAttachments: Array.isArray(payload?.keepAttachments) ? payload.keepAttachments : null,
      updatedBy: scheduledEmailActor(req.caller),
      sender: scheduledEmailSender(req.caller),
    });
    res.json({ ok: true, scheduledEmail });
  } catch (err) {
    if (err instanceof EmailAttachmentError) return res.status(err.statusCode).json(emailAttachmentErrorBody(err));
    res.status(err.statusCode || (err.code === "ENOENT" ? 404 : 500)).json(errorBody(err));
  }
});

app.delete("/api/jobs/:id/email-drafts/:draftId", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json({ ok: true, scheduledEmail: await discardEmailDraft({ dataDir: DATA_DIR, jobId: job.meta.id, id: req.params.draftId, updatedBy: scheduledEmailActor(req.caller) }) });
  } catch (err) {
    res.status(err.statusCode || (err.code === "ENOENT" ? 404 : 500)).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/sent-emails", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json({ ok: true, sentEmails: await readSentEmailArchive(job.dir) });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/scheduled-emails", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json({ ok: true, scheduledEmails: await listScheduledEmails({ dataDir: DATA_DIR, jobId: job.meta.id }) });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.delete("/api/jobs/:id/scheduled-emails/:scheduledEmailId", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const scheduledEmail = await returnScheduledEmailToDraft({
      dataDir: DATA_DIR,
      jobId: job.meta.id,
      id: req.params.scheduledEmailId,
      updatedBy: scheduledEmailActor(req.caller),
    });
    res.json({ ok: true, scheduledEmail });
  } catch (err) {
    res.status(err.statusCode || (err.code === "ENOENT" ? 404 : 500)).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/milestones", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const detail = await loadJobDetail(job);
    res.json({
      ok: true,
      paymentSchedule: detail.meta?.paymentSchedule || null,
      milestones: detail.meta?.milestoneInvoices || [],
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/milestones/generate", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "generate milestone invoices", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => generateJobMilestones({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        config,
        paymentSchedule: req.body?.paymentSchedule || null,
        applyAccountRule: req.body?.applyAccountRule === true,
        actor: getRequestActor(req),
      }),
      {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      paymentSchedule: detail.meta?.paymentSchedule || null,
      milestones: detail.meta?.milestoneInvoices || [],
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// What the account's milestone rules say about one job (#29): its region,
// the rule that applies, where its schedule came from, and the caps each
// milestone is over. Read before issuing; it changes nothing.
app.get("/api/jobs/:id/milestone-rules", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json({ ok: true, ...(await readJobMilestoneRules({ jobDir: job.dir, meta: job.meta, config })) });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/milestones/:index/revisions", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const detail = await loadJobDetail(job);
    const milestoneInvoice = resolveRequestedMilestoneInvoice({
      meta: detail.meta,
      milestoneIndex: req.params.index,
    });
    if (!milestoneInvoice) return res.status(404).json({ error: "milestone invoice not found" });
    res.json({
      ok: true,
      milestoneIndex: milestoneInvoice.milestoneIndex,
      invoiceNumber: milestoneInvoice.invoiceNumber,
      revisionNumber: milestoneInvoice.revisionNumber,
      revisions: getMilestoneInvoiceRevisions(milestoneInvoice),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// Credit an issued invoice and issue its replacement (step 4b). `/revise` is
// the older name of the same action: an issued invoice is never revised in
// place any more.
async function creditAndReissueRoute(req, res) {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "credit and reissue milestone invoice", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => creditAndReissueJobMilestoneInvoice({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        config,
        milestoneIndex: req.params.index,
        reason: req.body?.reason ?? null,
        quoteVersion: req.body?.quoteVersion ?? null,
        expectedRevisionNumber: req.body?.expectedRevisionNumber ?? null,
        actor: getRequestActor(req),
      }), {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      creditNote: result.creditNote,
      invoice: result.invoice,
      revision: result.revision,
      paymentSchedule: result.paymentSchedule || detail.meta?.paymentSchedule || null,
      milestones: result.milestoneInvoices || detail.meta?.milestoneInvoices || [],
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
}
app.post("/api/jobs/:id/milestones/:index/credit-and-reissue", requireAuth, creditAndReissueRoute);
app.post("/api/jobs/:id/milestones/:index/revise", requireAuth, creditAndReissueRoute);

app.post("/api/jobs/:id/milestones/migrate", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "migrate milestone invoices", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => migrateJobMilestoneInvoices({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        config,
        sourceQuoteVersion: req.body?.sourceQuoteVersion ?? null,
        targetQuoteVersion: req.body?.targetQuoteVersion ?? null,
        carriedForwardAmount: req.body?.carriedForwardAmount ?? req.body?.carryAmount ?? null,
        carryMilestoneIndex: req.body?.carryMilestoneIndex ?? 0,
        adjustmentMilestoneIndex: req.body?.adjustmentMilestoneIndex ?? 1,
        voidPayments: req.body?.voidPayments || [],
        resetChangedUnpaidInvoices: req.body?.resetChangedUnpaidInvoices !== false,
        dryRun: req.body?.dryRun === true,
        actor: getRequestActor(req),
      }), {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      paymentSchedule: result.paymentSchedule || detail.meta?.paymentSchedule || null,
      milestones: result.milestoneInvoices || detail.meta?.milestoneInvoices || [],
      migrationPlan: result.migrationPlan || null,
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.put("/api/jobs/:id/milestones/:index", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "update milestone invoice", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => updateJobMilestone({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        config,
        milestoneIndex: req.params.index,
        patch: {
          ...(Object.prototype.hasOwnProperty.call(req.body || {}, "status") ? { status: req.body.status } : {}),
          ...(Object.prototype.hasOwnProperty.call(req.body || {}, "dueDate") ? { dueDate: req.body.dueDate } : {}),
        },
        actor: getRequestActor(req),
      }), {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      milestone: result.milestoneInvoice,
      paymentSchedule: detail.meta?.paymentSchedule || null,
      milestones: detail.meta?.milestoneInvoices || [],
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/milestones/:index/payment", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "record milestone payment", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => recordJobMilestonePayment({
        jobDir: stagedJobDir,
        meta: normalizeJobMeta(job.meta),
        config,
        milestoneIndex: req.params.index,
        payment: {
          amount: req.body?.amount,
          date: req.body?.date,
          reference: req.body?.reference,
          method: req.body?.method,
        },
        actor: getRequestActor(req),
      }), {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      payment: result.payment,
      milestone: result.milestoneInvoice,
      paymentSchedule: detail.meta?.paymentSchedule || null,
      milestones: detail.meta?.milestoneInvoices || [],
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/milestones/:index/payments/:paymentId/void", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "void milestone payment", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => voidJobMilestonePayment({
        jobDir: stagedJobDir,
        meta: normalizeJobMeta(job.meta),
        config,
        milestoneIndex: req.params.index,
        paymentId: req.params.paymentId,
        reason: req.body?.reason || null,
        actor: getRequestActor(req),
      }), {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      payment: result.payment,
      milestone: result.milestoneInvoice,
      paymentSchedule: detail.meta?.paymentSchedule || null,
      milestones: detail.meta?.milestoneInvoices || [],
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/milestones/:index/unpaid", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "mark milestone unpaid", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => markJobMilestoneUnpaid({
        jobDir: stagedJobDir,
        meta: normalizeJobMeta(job.meta),
        config,
        milestoneIndex: req.params.index,
        actor: getRequestActor(req),
      }), {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      milestone: result.milestoneInvoice,
      paymentSchedule: detail.meta?.paymentSchedule || null,
      milestones: detail.meta?.milestoneInvoices || [],
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/milestones/:index/unsent", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "mark milestone unsent", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => markJobMilestoneUnsent({
        jobDir: stagedJobDir,
        meta: normalizeJobMeta(job.meta),
        config,
        milestoneIndex: req.params.index,
        actor: getRequestActor(req),
      }), {
        timeoutMs: 120_000,
      });
    });
    const detail = buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta }));
    res.json({
      ok: true,
      milestone: result.milestoneInvoice,
      paymentSchedule: detail.meta?.paymentSchedule || null,
      milestones: detail.meta?.milestoneInvoices || [],
      detail,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// Gmail OAuth re-authorization flow (server/gmail-oauth-routes.js).
registerGmailOAuthRoutes(app, {
  config,
  requireAuth,
  OAuth2: google.auth.OAuth2,
  scopes: [...GMAIL_SEND_SCOPES, GOOGLE_CONTACTS_READONLY_SCOPE],
  hasServiceAccountKey: hasGoogleServiceAccountKey,
  resolveDelegatedUser: resolveGmailDelegatedUser,
  resolveLoginHint: resolveGmailLoginHint,
  saveOAuthUser: (email, tokens) => saveGmailOAuthUser(DATA_DIR, email, tokens),
  // Reset cached Gmail clients so the new token takes effect.
  onAuthorized: () => {
    resetGmailClient();
    resetGoogleContactsCache();
  },
});

app.get("/api/google/contacts", requireAuth, async (req, res) => {
  if (req.caller?.kind !== "human") {
    return res.status(403).json({ error: "Google Contacts is available only to signed-in Field users." });
  }
  try {
    const contacts = await listGoogleContacts({ config, user: req.caller });
    res.json({ ok: true, contacts });
  } catch (error) {
    const mapped = googleContactsHttpError(error);
    res.status(mapped.statusCode).json({ error: mapped.message, code: mapped.code });
  }
});

app.post("/api/jobs/:id/landed", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "mark landed", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => markJobLanded({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        dataDir: DATA_DIR,
        config,
      }));
    });
    res.json({
      ok: true,
      detail: buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta })),
    });
  } catch (err) {
    console.error(`[mark-landed] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/pipeline-stage", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "pipeline stage update", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => setJobPipelineStage({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        dataDir: DATA_DIR,
        config,
        stage: req.body?.pipelineStage || req.body?.stage,
        actor: getRequestActor(req),
      }));
    });
    res.json({
      ok: true,
      detail: buildClientJobDetail(await loadJobDetail({ ...job, meta: result.meta })),
    });
  } catch (err) {
    console.error(`[pipeline-stage] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/moasure-upload", requireAuth, upload.array("files", 12), async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  if (!Array.isArray(req.files) || req.files.length === 0) {
    return res.status(400).json({ error: "moasure files required" });
  }

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "moasure upload", async () => {
      return await runAtomicJobGeneration(job.dir, async (stagedJobDir) => {
      const requestProvenance = getRequestProvenance(req);
      let workingMeta = await ensureEditableQuoteVersionForContextMutation({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        provenance: requestProvenance,
        actor: getRequestActor(req),
        buildReason: "measurement_context_seed",
        inExistingGeneration: true,
        operationalJobDir: job.dir,
      });
      // Raw files, the ledger and the parsed summary are operational truth at
      // the job root; only the quote context and meta belong to the generation.
      const stored = await storeMoasureUpload({
        jobDir: job.dir,
        files: req.files,
        uploadedBy: getUploadedBy(req),
      });
      const moasure = await scanMoasure(job.dir, { provenance: requestProvenance, commercialJobDir: stagedJobDir });
      let nextMeta = applyMoasureMeta(workingMeta, moasure);
      const actor = getRequestActor(req);

      try {
        const driveResult = await uploadMoasureBatchToDrive({
          jobDir: job.dir,
          meta: nextMeta,
          config,
          batchId: stored.batchId,
        });
        if (driveResult) nextMeta.driveFileIds = driveResult;
      } catch (err) {
        console.error(`[moasure-upload] ${job.meta.id} drive sync failed (non-fatal): ${err.message}`);
      }

      const rebuilt = await maybeRebuildQuoteForRecording({
        jobDir: stagedJobDir,
        meta: nextMeta,
        provenance: requestProvenance,
        inExistingGeneration: true,
        operationalJobDir: job.dir,
      });
      nextMeta = rebuilt?.meta || nextMeta;
      nextMeta = await persistNormalizedJobMeta(stagedJobDir, nextMeta);
      await appendJobActivity({
        jobDir: stagedJobDir,
        activity: {
          kind: "measurement.files_uploaded",
          ts: new Date().toISOString(),
          actor,
          title: "Measurement files uploaded",
          body: buildMoasureMutationSummary({
            action: `Added ${stored.savedFiles.length} measurement file${stored.savedFiles.length === 1 ? "" : "s"} in batch ${stored.batchId}.`,
            moasure,
            quote: rebuilt?.quote || null,
          }),
        },
      });

      return {
        meta: nextMeta,
        moasure,
        quote: rebuilt?.quote || null,
        quoteVersions: rebuilt?.quoteVersions || null,
      };
      });
    });

    res.json({
      ok: true,
      ...result,
      ...(result.quote
        ? { quote: buildClientQuoteView(result.quote, result.meta?.pipelineStage, { historical: false }) }
        : {}),
    });
  } catch (err) {
    console.error(`[moasure-upload] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/moasure-scan", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "moasure scan", async () => runAtomicJobGeneration(
      job.dir,
      async (stagedJobDir) => {
    const requestProvenance = getRequestProvenance(req);
    let workingMeta = await ensureEditableQuoteVersionForContextMutation({
      jobDir: stagedJobDir,
      meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
      provenance: requestProvenance,
      actor: getRequestActor(req),
      buildReason: "measurement_context_seed",
      inExistingGeneration: true,
      operationalJobDir: job.dir,
    });
    const moasure = await scanMoasure(job.dir, { provenance: requestProvenance, commercialJobDir: stagedJobDir });
    let nextMeta = applyMoasureMeta(workingMeta, moasure);
    const actor = getRequestActor(req);

    try {
      const driveResult = await uploadMoasureBatchToDrive({
        jobDir: job.dir,
        meta: nextMeta,
        config,
        batchId: moasure.latestBatchId,
      });
      if (driveResult) nextMeta.driveFileIds = driveResult;
    } catch (err) {
      console.error(`[moasure-scan] ${job.meta.id} drive sync failed (non-fatal): ${err.message}`);
    }

    const rebuilt = await maybeRebuildQuoteForRecording({
      jobDir: stagedJobDir,
      meta: nextMeta,
      provenance: requestProvenance,
      inExistingGeneration: true,
      operationalJobDir: job.dir,
    });
    nextMeta = rebuilt?.meta || nextMeta;
    nextMeta = await persistNormalizedJobMeta(stagedJobDir, nextMeta);
    await appendJobActivity({
      jobDir: stagedJobDir,
      activity: {
        kind: "measurement.rescanned",
        ts: new Date().toISOString(),
        actor,
        title: "Measurements re-scanned",
        body: buildMoasureMutationSummary({
          action: "Re-parsed the current measurement files.",
          moasure,
          quote: rebuilt?.quote || null,
        }),
      },
    });

      return {
        meta: nextMeta,
        moasure,
        quote: rebuilt?.quote || null,
        quoteVersions: rebuilt?.quoteVersions || null,
      };
      },
    ));

    const visible = buildClientQuoteMutationView({ meta: result.meta, quote: result.quote });
    res.json({
      ok: true,
      meta: visible.meta,
      moasure: result.moasure,
      quote: visible.quote,
      quoteMarkdown: visible.quoteMarkdown,
      quoteVersions: result.quoteVersions || null,
    });
  } catch (err) {
    console.error(`[moasure-scan] ${job.meta.id} failed: ${err.message}`);
    res.status(500).json(errorBody(err));
  }
});

app.delete("/api/jobs/:id/moasure-files/:batchId/:fileName", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const result = await runExclusiveJobMutation(job.meta.id, "measurement detach", async () => runAtomicJobGeneration(
      job.dir,
      async (stagedJobDir) => {
      const requestProvenance = getRequestProvenance(req);
      let workingMeta = await ensureEditableQuoteVersionForContextMutation({
        jobDir: stagedJobDir,
        meta: await readNormalizedJobMeta(stagedJobDir) || normalizeJobMeta(job.meta),
        provenance: requestProvenance,
        actor: getRequestActor(req),
        buildReason: "measurement_context_seed",
        inExistingGeneration: true,
        operationalJobDir: job.dir,
      });
      const removed = await removeMoasureFile({
        jobDir: job.dir,
        commercialJobDir: stagedJobDir,
        batchId: req.params.batchId,
        fileName: req.params.fileName,
      });
      const moasure = await scanMoasure(job.dir, { provenance: requestProvenance, commercialJobDir: stagedJobDir });
      let nextMeta = applyMoasureMeta(workingMeta, moasure);
      const rebuilt = await maybeRebuildQuoteForRecording({
        jobDir: stagedJobDir,
        meta: nextMeta,
        provenance: requestProvenance,
        inExistingGeneration: true,
        operationalJobDir: job.dir,
      });
      nextMeta = rebuilt?.meta || nextMeta;
      nextMeta = await persistNormalizedJobMeta(stagedJobDir, nextMeta);
      await appendJobActivity({
        jobDir: stagedJobDir,
        activity: {
          kind: "measurement.file_removed",
          ts: new Date().toISOString(),
          actor: getRequestActor(req),
          title: "Measurement file removed",
          body: buildMoasureMutationSummary({
            action: `Removed ${removed.fileName} from the current draft measurement context. Historical versions keep access to the original file.`,
            moasure,
            quote: rebuilt?.quote || null,
          }),
        },
      });

      return {
        removed,
        meta: nextMeta,
        moasure,
        quote: rebuilt?.quote || null,
        quoteVersions: rebuilt?.quoteVersions || null,
      };
      },
    ));

    const visible = buildClientQuoteMutationView({ meta: result.meta, quote: result.quote });
    res.json({
      ok: true,
      ...result,
      ...visible,
    });
  } catch (err) {
    console.error(`[moasure-remove] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// Set quote inputs directly (for agent-driven or manual quotes without audio extraction)
app.put("/api/jobs/:id/quote-inputs", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const persisted = await runExclusiveJobMutation(job.meta.id, "quote input rebuild", async () => {
      const quoteInputs = req.body;
      if (!quoteInputs || !Array.isArray(quoteInputs.lineItemCandidates)) {
        const err = new Error("lineItemCandidates array required");
        err.statusCode = 400;
        throw err;
      }
      const transcript = existsSync(join(job.dir, "transcript.json"))
        ? JSON.parse(await readFile(join(job.dir, "transcript.json"), "utf8"))
        : { speakers: [], segments: [], fullText: "", cleaned: { title: job.meta?.title || "", cleanedText: "", turns: [] } };
      const overrides = await readQuoteOverrides(job.dir);
      return await buildAndPersistQuote({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        transcript,
        quoteInputs,
        config,
        provenance: getRequestProvenance(req),
        overrides,
        buildReason: "set_quote_inputs",
      });
    });
    const visible = buildClientQuoteMutationView(persisted);
    res.json({
      ok: true,
      id: persisted.meta.id,
      ...visible,
    });
  } catch (err) {
    console.error(`[set-quote-inputs] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/quote-update", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const persisted = await runExclusiveJobMutation(job.meta.id, "quote update", async () => {
      // Optimistic concurrency on the quote's rows (#10): a save made
      // against rows that moved on since the editor read them is refused.
      await assertQuoteRowsIfMatch({
        jobId: job.meta.id,
        version: (await readQuoteArtifacts(job.dir))?.version,
        ifMatch: req.get("If-Match"),
      });
      return await updateJobQuote({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        config,
        provenance: getRequestProvenance(req),
        patch: {
          lineItems: req.body?.lineItems || {},
          commercialAdjustments: req.body?.commercialAdjustments || [],
          assumptions: req.body?.assumptions || {},
          presentation: req.body?.presentation || null,
          paymentSchedule: req.body?.paymentSchedule || null,
          optionSelections: req.body?.optionSelections || {},
          acceptedOptionSelections: req.body?.acceptedOptionSelections || {},
          execution: req.body?.execution || null,
          lockStatus: req.body?.lockStatus || req.body?.deliveryStatus,
        },
        actor: getRequestActor(req),
      });
    });

    // The save is written to the quote's rows through the quote service
    // (the commit's dual-write); the files are still written alongside until
    // part three removes them. The new rows' version goes back to the editor.
    await quoteRowRecorder.syncJob(job.dir, { reason: "quote saved" });
    const rowsTag = await currentQuoteRowsTag({ jobId: job.meta.id, version: persisted.quote?.version }).catch(() => null);
    if (rowsTag) res.setHeader("X-Field-Quote-Rows-Version", rowsTag);
    res.setHeader("X-Field-Quote-Rows", rowsTag ? "written" : quoteRowRecorder.enabled ? "not-written" : "no-database");
    const visible = buildClientQuoteMutationView(persisted);
    res.json({
      ok: true,
      ...visible,
      quoteVersions: persisted.quoteVersions,
      quoteOverrides: persisted.quoteOverrides,
      quoteLifecycle: persisted.quoteLifecycle || null,
    });
  } catch (err) {
    console.error(`[quote-update] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

// Draft quote rows vs the current catalogue. POST with { organizer }
// checks the editor's unsaved draft; GET checks the saved quote.
async function sendQuoteCatalogChanges(req, res, organizer) {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const changes = await readJobQuoteCatalogChanges({
      jobDir: job.dir,
      meta: normalizeJobMeta(job.meta),
      config,
      organizer,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...changes });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
}

app.get("/api/jobs/:id/quote/catalog-changes", requireAuth, (req, res) => sendQuoteCatalogChanges(req, res, null));
app.post("/api/jobs/:id/quote/catalog-changes", requireAuth, (req, res) => {
  const organizer = req.body?.organizer;
  if (organizer != null && (typeof organizer !== "object" || Array.isArray(organizer))) {
    return res.status(400).json({ error: "organizer must be an object" });
  }
  return sendQuoteCatalogChanges(req, res, organizer || null);
});

// Apply catalogue changes to quote rows. With { organizer } the updated draft
// is returned unsaved; without it the saved quote is updated (a sent quote is
// refused with QUOTE_LOCKED). { nodeIds } picks rows; { defaultOnly: true }
// takes only the rows the banner ticks by default; neither picks every
// applicable row. { reviewed: { [nodeId]: reviewKey } } carries the state of
// each row the caller reviewed (the reviewKey its check listed): a row edited
// since is skipped (changed_since_review). A row edited on the quote
// (overridden) with no reviewed key is skipped unless { replaceEdits: true }.
app.post("/api/jobs/:id/quote/catalog-changes/apply", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const organizer = req.body?.organizer ?? null;
  const nodeIds = req.body?.nodeIds ?? null;
  if (organizer != null && (typeof organizer !== "object" || Array.isArray(organizer))) {
    return res.status(400).json({ error: "organizer must be an object" });
  }
  if (nodeIds != null && (!Array.isArray(nodeIds) || nodeIds.some((id) => typeof id !== "string"))) {
    return res.status(400).json({ error: "nodeIds must be an array of row ids" });
  }
  const defaultOnly = req.body?.defaultOnly ?? false;
  if (typeof defaultOnly !== "boolean") {
    return res.status(400).json({ error: "defaultOnly must be true or false" });
  }
  const reviewed = req.body?.reviewed ?? null;
  if (reviewed != null && (typeof reviewed !== "object" || Array.isArray(reviewed)
    || Object.values(reviewed).some((key) => typeof key !== "string"))) {
    return res.status(400).json({ error: "reviewed must map row ids to the reviewKey each was listed with" });
  }
  const replaceEdits = req.body?.replaceEdits ?? false;
  if (typeof replaceEdits !== "boolean") {
    return res.status(400).json({ error: "replaceEdits must be true or false" });
  }
  try {
    const result = await runExclusiveJobMutation(job.meta.id, "quote catalogue refresh", async () => (
      applyJobQuoteCatalogChanges({
        jobDir: job.dir,
        meta: normalizeJobMeta(job.meta),
        config,
        organizer,
        nodeIds,
        defaultOnly,
        reviewed,
        replaceEdits,
        expectedCatalogVersion: req.body?.expectedCatalogVersion ?? null,
        provenance: getRequestProvenance(req),
        actor: getRequestActor(req),
      })
    ));
    const { persisted, ...rest } = result;
    if (persisted) {
      const rowsTag = await currentQuoteRowsTag({ jobId: job.meta.id, version: persisted.quote?.version }).catch(() => null);
      if (rowsTag) res.setHeader("X-Field-Quote-Rows-Version", rowsTag);
    }
    res.json({
      ok: true,
      ...rest,
      ...(persisted ? {
        ...buildClientQuoteMutationView(persisted),
        quoteVersions: persisted.quoteVersions,
        quoteOverrides: persisted.quoteOverrides,
        quoteLifecycle: persisted.quoteLifecycle || null,
      } : {}),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
});

// Issued documents by uid: GET /api/documents/:uid/pdf and
// GET /api/jobs/:id/documents (server/documents/routes.js).
registerIssuedDocumentRoutes(app, { requireAuth, getDb, requestOrgUid, findJob, blobs: issuedDocumentBlobs });
registerEmailComposeRoutes(app, { requireAuth, findJob, config, dataDir: DATA_DIR, normalizeJobMeta, documentServiceFor: emailDocumentService });

// What each customer was sent, newest last.
app.get("/api/jobs/:id/quote-snapshots", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json({ ok: true, snapshots: await config.quoteSnapshots.listForJob(job.meta.id) });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

app.post("/api/jobs/:id/quote-regenerate", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const persisted = await runExclusiveJobMutation(job.meta.id, "quote pricing refresh", async () => {
      const normalizedMeta = normalizeJobMeta(job.meta);
      return await regenerateRecordingQuote({
        jobDir: job.dir,
        meta: normalizedMeta,
        config,
        provenance: getRequestProvenance(req),
        actor: getRequestActor(req),
        buildReason: "quote_pricing_refresh",
      });
    });

    const visible = buildClientQuoteMutationView(persisted);
    res.json({
      ok: true,
      ...visible,
      quoteVersions: persisted.quoteVersions,
      quoteOverrides: persisted.quoteOverrides,
      quoteLifecycle: persisted.quoteLifecycle || null,
    });
  } catch (err) {
    console.error(`[quote-regenerate] ${job.meta.id} failed: ${err.message}`);
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function createManualJob({ quoteCatalogId, gps = null, siteAddress = null, quotedBy = null }) {
  const id = randomUUID();
  const now = new Date();
  const createdAt = now.toISOString();
  const dateDir = createdAt.slice(0, 10);
  const jobDir = join(DATA_DIR, dateDir, id);
  await mkdir(jobDir, { recursive: true });

  // Build title from address or fallback
  let title;
  if (siteAddress) {
    const parts = siteAddress.split(",").map((s) => s.trim());
    // Extract street + suburb from address parts
    const short = parts.slice(0, 2).join(", ");
    title = `General Site Works — ${short}`;
  } else {
    title = `General Site Works — ${id.slice(0, 6)}`;
  }
  const transcript = {
    speakers: [],
    segments: [],
    fullText: "",
    cleaned: {
      title,
      cleanedText: "Manual quote draft created without an audio capture.",
      turns: [],
    },
  };
  const quoteInputs = {
    recordingIntent: "job-scope",
    summary: "Manual quote draft created without an audio recording. Replace the placeholder scope, rate, and assumptions before sending.",
    jobScope: {
      customerGoal: "Prepare a manual customer quote.",
      workSummary: "Placeholder quote shell awaiting manual scope definition.",
      siteContext: null,
    },
    reviewStatus: "manual_review",
    lineItemCandidates: [],
    processReferences: [],
    measurements: [],
    siteConstraints: [],
    missingInputs: [
      {
        field: "manual scope review",
        reason: "This quote was started manually, so the actual scope still needs to be confirmed.",
        evidence: [],
        evidenceSummary: [],
      },
      {
        field: "site access constraints",
        reason: "Site access and handling constraints were not captured when the quote shell was created.",
        evidence: [],
        evidenceSummary: [],
      },
    ],
    assumptions: [
      {
        statement: "This draft was created manually without captured audio evidence.",
        evidence: [],
        evidenceSummary: [],
      },
    ],
  };
  const meta = {
    id,
    createdAt,
    title,
    label: title,
    outputMode: "quote",
    quoteCatalogId,
    status: "processing",
    captureMode: "manual",
    audioFile: null,
    audioFiles: [],
    mimeType: null,
    sizeBytes: 0,
    durationMs: null,
    speakerCount: 0,
    taskCount: null,
    qaDropped: 0,
    siteAddress: siteAddress || null,
    gps: gps || null,
    quotedBy: quotedBy || null,
  };

  Object.assign(meta, await persistNormalizedJobMeta(jobDir, meta));
  if (fieldDb) {
    upsertJob(fieldDb, {
      id,
      dateDir,
      dir: jobDir,
      title: meta.title,
      siteAddress: meta.siteAddress,
      status: meta.status,
      quoteNumber: meta.quoteNumber,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt || meta.createdAt,
    });
  }
  await writeFile(join(jobDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  const evidencePack = buildQuoteEvidencePack({
    meta,
    transcript,
    cleanedTranscript: transcript.cleaned,
    label: title,
    quoteCatalogId,
  });
  await writeFile(join(jobDir, "evidence-pack.json"), JSON.stringify(evidencePack, null, 2));
  await writeFile(join(jobDir, "quote-inputs.json"), JSON.stringify(quoteInputs, null, 2));

  try {
    return await buildAndPersistQuote({
      jobDir,
      meta,
      transcript,
      quoteInputs,
      config,
      provenance: {
        agentTool: config.agentTool || "unknown",
        llmEngine: config.llmEngine || "unknown",
        agentSessionId: null,
      },
      buildReason: "manual_quote_shell",
    });
  } catch (err) {
    const failedMeta = {
      ...meta,
      status: "error",
      error: err.message,
    };
    await persistNormalizedJobMeta(jobDir, failedMeta);
    if (fieldDb) {
      upsertJob(fieldDb, {
        id,
        dateDir,
        dir: jobDir,
        title: failedMeta.title,
        siteAddress: failedMeta.siteAddress,
        status: failedMeta.status,
        quoteNumber: failedMeta.quoteNumber,
        createdAt: failedMeta.createdAt,
        updatedAt: new Date().toISOString(),
      });
    }
    throw err;
  }
}

async function findJob(id) {
  // Fast path: DB lookup
  if (fieldDb) {
    const row = findJobInDb(fieldDb, id);
    const activeRowDir = row ? await resolveActiveJobGeneration(row.dir) : null;
    if (row && activeRowDir && existsSync(join(activeRowDir, "meta.json"))) {
      const meta = await readNormalizedJobMeta(row.dir);
      if (meta) return { dir: row.dir, dateDir: row.date_dir, meta };
    }
  }
  // Fallback: directory scan
  try {
    const dateDirs = await readdir(DATA_DIR);
    for (const dateDir of dateDirs) {
      const dir = join(DATA_DIR, dateDir, id);
      const activeDir = await resolveActiveJobGeneration(dir);
      if (existsSync(join(activeDir, "meta.json"))) {
        const meta = await readNormalizedJobMeta(dir);
        if (!meta) continue;
        if (fieldDb) upsertJob(fieldDb, { id: meta.id || id, dateDir, dir, title: meta.title, siteAddress: meta.siteAddress, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
        return { dir, dateDir, meta };
      }
      const entries = await readdir(join(DATA_DIR, dateDir)).catch(() => []);
      for (const entry of entries) {
        if (entry.endsWith(`--${id.slice(0, 8)}`)) {
          const slugDir = join(DATA_DIR, dateDir, entry);
          const activeSlugDir = await resolveActiveJobGeneration(slugDir);
          if (existsSync(join(activeSlugDir, "meta.json"))) {
            const meta = await readNormalizedJobMeta(slugDir);
            if (!meta) continue;
            if (fieldDb) upsertJob(fieldDb, { id: meta.id || id, dateDir, dir: slugDir, title: meta.title, siteAddress: meta.siteAddress, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
            return { dir: slugDir, dateDir, meta };
          }
        }
      }
    }
  } catch { /* not found */ }
  return null;
}

function applyMoasureMeta(meta, moasure) {
  return {
    ...meta,
    moasureStatus: moasure?.status || "not_attached",
    moasureBatchCount: moasure?.batchCount || 0,
    moasureLatestBatchId: moasure?.latestBatchId || null,
  };
}

function buildMoasureMutationSummary({ action, moasure, quote }) {
  const importCount = Array.isArray(moasure?.imports) ? moasure.imports.length : 0;
  const measurementLineItems = (quote?.lineItems || [])
    .filter((item) => item.provenance?.some((entry) => entry.sourceType === "measurement"))
    .map((item) => item.label)
    .slice(0, 3);

  const parts = [
    action,
    moasure?.batchCount
      ? `${moasure.batchCount} measurement batch${moasure.batchCount === 1 ? "" : "es"} now attached.`
      : "No measurement batches remain attached.",
    importCount
      ? `${importCount} parsed measurement import${importCount === 1 ? "" : "s"} available.`
      : "No parsed measurement imports available.",
  ];

  if (measurementLineItems.length) {
    parts.push(`Current quote uses measurement data in ${measurementLineItems.join(", ")}.`);
  } else if (quote) {
    parts.push("Current quote was regenerated, but no priced line items are currently measurement-derived.");
  }

  return parts.join(" ");
}

async function ensureEditableQuoteVersionForContextMutation({
  jobDir,
  meta,
  provenance = null,
  actor = null,
  buildReason = "context_mutation_seed",
  inExistingGeneration = false,
  operationalJobDir = null,
}) {
  const normalizedMeta = normalizeJobMeta(meta);
  const currentArtifacts = await readQuoteArtifacts(jobDir);
  if (!currentArtifacts?.quote) return normalizedMeta;

  const currentQuoteLifecycle = await readQuoteLifecycle(jobDir);
  const currentQuoteVersion = Number(
    currentArtifacts?.quote?.version
    || normalizedMeta?.quoteVersion
    || 1
  );
  const needsDraftRevision = shouldForkQuoteMutation({
    meta: normalizedMeta,
    quoteLifecycle: currentQuoteLifecycle,
    currentQuoteVersion,
  });
  if (!needsDraftRevision) return normalizedMeta;

  // The transcript is operational and stays at the job root, so a staged
  // generation has to read it from there.
  const transcriptPath = operationalJobDir ? join(operationalJobDir, "transcript.json") : null;
  const seeded = await regenerateRecordingQuote({
    jobDir,
    operationalJobDir,
    meta: normalizedMeta,
    config,
    provenance,
    actor,
    buildReason,
    forceForkSentQuote: true,
    inExistingGeneration,
    transcript: transcriptPath && existsSync(transcriptPath)
      ? JSON.parse(await readFile(transcriptPath, "utf8"))
      : null,
  });
  return normalizeJobMeta(seeded?.meta || normalizedMeta);
}

async function readSelectedQuoteContext({
  jobDir,
  meta,
  requestedVersion = null,
}) {
  const normalizedMeta = normalizeJobMeta(await hydrateJobMeta(jobDir, meta));
  const detailVersion = requestedVersion == null ? "latest" : requestedVersion;
  const documentContext = await readDocumentQuoteArtifacts({
    jobDir,
    meta: normalizedMeta,
    documentType: "quote",
    requestedVersion: detailVersion,
  });
  const selectedArtifacts = await readSelectedQuoteVersionArtifacts({
    jobDir,
    selectedVersion: documentContext.selectedVersion,
    latestVersion: documentContext.latestVersion,
  });

  return {
    meta: normalizedMeta,
    ...documentContext,
    ...selectedArtifacts,
  };
}

async function maybeRebuildQuoteForRecording({
  jobDir,
  meta,
  provenance = null,
  inExistingGeneration = false,
  operationalJobDir = null,
}) {
  const transcriptPath = join(operationalJobDir || jobDir, "transcript.json");
  const quoteInputsPath = join(jobDir, "quote-inputs.json");
  if (!existsSync(transcriptPath) || !existsSync(quoteInputsPath)) return null;

  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  const quoteInputs = JSON.parse(await readFile(quoteInputsPath, "utf8"));
  const overrides = await readQuoteOverrides(jobDir);
  const buildArgs = {
    jobDir,
    operationalJobDir,
    meta: normalizeJobMeta(meta),
    transcript,
    quoteInputs,
    config,
    provenance: provenance || {
      agentTool: config.agentTool || "unknown",
      llmEngine: config.llmEngine || "unknown",
      agentSessionId: null,
    },
    overrides,
    buildReason: "moasure_refresh",
  };
  return inExistingGeneration
    ? await buildQuoteInStagedGeneration(buildArgs)
    : await buildAndPersistQuote(buildArgs);
}

async function readQuotePromotionContext(baseDir, { operationalJobDir = null } = {}) {
  const readJson = async (name, dir = baseDir) => {
    try {
      return JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      return null;
    }
  };
  const context = await readJson("quote-context.json");
  return {
    transcript: await readJson("transcript.json")
      || (operationalJobDir ? await readJson("transcript.json", operationalJobDir) : null),
    quoteInputs: await readJson("quote-inputs.json"),
    evidencePack: await readJson("evidence-pack.json"),
    moasureSummary: await readJson("moasure-summary.json")
      || (operationalJobDir ? await readMoasureSummary(operationalJobDir) : null),
    ingestionLedger: await readJson("ingestion-ledger.json"),
    evidenceIndex: await readJson("evidence-index.json"),
    visibleFileIds: Array.isArray(context?.visibleFileIds) ? context.visibleFileIds : null,
  };
}

async function loadJobDetail(job, { version = null } = {}) {
  const result = {};
  // Resolving the active generation also quarantines or repairs interrupted
  // writes before the detail is read.
  await resolveActiveJobGeneration(job.dir);
  const {
    meta,
    quoteLifecycle,
    currentQuoteArtifacts,
    selectedQuoteArtifacts,
    latestVersion,
    selectedVersion,
    transcript,
    quoteInputs,
    evidencePack,
    moasureSummary,
    visibleFiles,
    ingestionLedger,
    evidenceIndex,
  } = await readSelectedQuoteContext({
    jobDir: job.dir,
    meta: job.meta,
    requestedVersion: version,
  });
  const selectedReport = await readSelectedReportMarkdown({
    jobDir: job.dir,
    meta,
    documentType: (meta?.outputMode || "report") === "quote" ? "quote" : "report",
    requestedVersion: selectedVersion,
    intent: "view",
  });
  const rawReport = selectedReport.report;
  result.meta = meta;
  if (transcript) {
    result.transcript = transcript;
  }
  if (evidencePack) {
    result.quoteEvidencePack = evidencePack;
  }
  if (quoteInputs) {
    result.quoteInputs = quoteInputs;
  }
  if (currentQuoteArtifacts) {
    result.quote = currentQuoteArtifacts.quote;
    result.quoteMarkdown = currentQuoteArtifacts.quoteMarkdown;
    result.quoteOverrides = currentQuoteArtifacts.quoteOverrides;
    result.quoteBreakdownSource = currentQuoteArtifacts.quoteBreakdownSource;
  }

  if (selectedQuoteArtifacts && selectedQuoteArtifacts !== currentQuoteArtifacts) {
    result.quote = selectedQuoteArtifacts.quote;
    result.quoteMarkdown = selectedQuoteArtifacts.quoteMarkdown;
    result.quoteOverrides = selectedQuoteArtifacts.quoteOverrides;
    result.quoteBreakdownSource = selectedQuoteArtifacts.quoteBreakdownSource;
  }

  if (moasureSummary) {
    result.moasure = moasureSummary;
  }
  result.ingestionLedger = ingestionLedger || {
    version: 1,
    files: visibleFiles || [],
  };
  result.evidenceIndex = evidenceIndex || {
    version: 1,
    lastUpdatedAt: null,
    artifacts: [],
  };
  result.quoteVersions = (await listQuoteVersions(job.dir)).map((item) => ({
    ...item,
    isLatest: item.version === latestVersion,
    isSelected: item.version === selectedVersion,
  }));
  const issuanceLedger = await readQuoteIssuanceLedger(job.dir);
  const issuanceRecord = findIssuedQuoteVersion(
    issuanceLedger,
    selectedVersion || result.quote?.version || null,
    "quote",
  );
  if (issuanceRecord) {
    const issuedMarkdown = await readIssuedQuoteArtifact(job.dir, issuanceRecord, "quoteMarkdown");
    const issuedReport = await readIssuedQuoteArtifact(job.dir, issuanceRecord, "reportMarkdown");
    result.issuedDocumentUnavailable = !issuedMarkdown.available || !issuedReport.available;
    if (issuedMarkdown.available) result.quoteMarkdown = issuedMarkdown.bytes.toString("utf8");
    if (issuedReport.available) result.report = issuedReport.bytes.toString("utf8");
  }
  const exactIssuedReport = issuanceRecord ? (result.report || null) : null;
  const selectedVersionIssued = isIssuedQuoteVersion({
    quote: result.quote || null,
    quoteLifecycle,
    version: selectedVersion,
    meta: result.meta,
    issuanceRecord,
  });
  // Before the issuance ledger existed, older jobs could retain a
  // sent-looking quote version without the immutable bytes that were
  // delivered.  Keep the financial snapshot available for audit, but never
  // present it as an issued document or rerender a substitute from the
  // archive/current draft.
  const legacyIssuedWithoutBytes = Boolean(selectedVersionIssued && !issuanceRecord);
  if (legacyIssuedWithoutBytes) {
    result.issuedDocumentUnavailable = true;
    result.quoteMarkdown = null;
    result.report = null;
  }
  const issuedVersionForPresentation = Boolean(
    selectedVersionIssued
    && !result.issuedDocumentUnavailable,
  );
  result.versionView = latestVersion ? {
    latestVersion,
    latestLabel: `v${String(latestVersion).padStart(3, "0")}`,
    selectedVersion,
    selectedLabel: selectedVersion ? `v${String(selectedVersion).padStart(3, "0")}` : null,
    isLatest: selectedVersion === latestVersion,
    selectedVersionIssued: issuedVersionForPresentation,
  } : null;
  result.ui = UI_CONFIG;
  result.quoteLifecycle = quoteLifecycle;
  const selectedIsLatest = !selectedVersion || selectedVersion === latestVersion;
  result.jobState = selectedIsLatest
    ? await ensureJobState({
        jobDir: job.dir,
        meta: result.meta,
        transcript: result.transcript || null,
        quoteInputs: result.quoteInputs || null,
        quote: currentQuoteArtifacts?.quote || result.quote || null,
        defaults: {
          operatorName: config.operatorName || null,
        },
      })
    : await previewJobState({
        jobDir: job.dir,
        meta: result.meta,
        transcript: result.transcript || null,
        quoteInputs: result.quoteInputs || null,
        quote: result.quote || currentQuoteArtifacts?.quote || null,
        defaults: {
          operatorName: config.operatorName || null,
        },
      });
  result.meta = normalizeJobMeta({
    ...result.meta,
    siteAddress: result.jobState.details?.siteAddress || result.meta.siteAddress || null,
    customerName: result.jobState.details?.customer?.name || result.meta.customerName || result.meta.contactName || null,
    contactName: result.jobState.details?.contact?.name || result.meta.contactName || null,
    contactPhone: result.jobState.details?.contact?.phone || result.meta.contactPhone || null,
    contactEmail: result.jobState.details?.contact?.email || result.meta.contactEmail || null,
    quotedBy: (typeof result.jobState.details?.quotedBy === "string" ? result.jobState.details.quotedBy : result.jobState.details?.quotedBy?.name) || result.meta.quotedBy || null,
    archivedAt: result.jobState.details?.archivedAt || result.meta.archivedAt || null,
    archivedReason: result.jobState.details?.archivedReason || result.meta.archivedReason || null,
    captureCount: Number(result.jobState.details?.captureCount || result.meta.captureCount || 1),
    gps: result.jobState.details?.gps || result.meta.gps || null,
    moasureStatus: result.moasure?.status || result.meta.moasureStatus || "not_attached",
    moasureBatchCount: result.moasure?.batchCount || 0,
    moasureLatestBatchId: result.moasure?.latestBatchId || null,
  });
  result.report = getDisplayableJobReport({
    meta: result.meta,
    quote: result.quote,
    report: issuanceRecord ? exactIssuedReport : (legacyIssuedWithoutBytes ? null : rawReport),
    historical: Boolean(latestVersion && selectedVersion && selectedVersion !== latestVersion),
    issuedVersion: issuedVersionForPresentation,
    current: !(latestVersion && selectedVersion && selectedVersion !== latestVersion),
  });
  result.review = buildReviewState({
    quote: result.quote || currentQuoteArtifacts?.quote || null,
    jobState: result.jobState || null,
    quoteOverrides: result.quoteOverrides || null,
  });
  result.proof = buildQuoteProofSummary({
    meta: result.meta,
    transcript: result.transcript || null,
    evidencePack: result.quoteEvidencePack || null,
    quoteInputs: result.quoteInputs || null,
    quoteBreakdownSource: result.quoteBreakdownSource || null,
    quote: result.quote || null,
    quoteLifecycle: result.quoteLifecycle || null,
    hasQuotePdf: Boolean(selectedQuoteArtifacts?.quotePdfPath || currentQuoteArtifacts?.quotePdfPath),
  });
  result.quoteEditPolicy = buildQuoteEditPolicy({
    meta: result.meta,
    quoteLifecycle: result.quoteLifecycle,
    latestVersion,
    selectedVersion,
  });
  result.deletion = await assessJobDeletion({ dir: job.dir, meta: result.meta }, jobDeletionDeps())
    .catch(() => ({ deletable: false, reasons: ["Field could not check this job's history."] }));
  // The quote's customer pricing (shown by the client, read by the MCP quote
  // tool) comes from its rows (#10). Kept beside the detail, not in it, so
  // the detail's JSON is unchanged.
  if (result.quote) jobDetailQuoteRows.set(result, await loadQuoteRows({ quote: result.quote, meta: result.meta }));
  return result;
}

function buildClientJobDetail(detail) {
  if (!detail || typeof detail !== "object") return detail;
  const historical = Boolean(detail.versionView && !detail.versionView.isLatest);
  const issuedVersion = Boolean(detail.versionView?.selectedVersionIssued);
  const visibleDetail = serializeClientJobDetail(detail, { historical, issuedVersion });
  const pipelineStage = visibleDetail?.meta?.pipelineStage || null;
  return {
    ...visibleDetail,
    quote: buildClientQuoteView(visibleDetail.quote, pipelineStage, { historical, issuedVersion, rowsFinancials: jobDetailQuoteRows.get(detail)?.financials || null }),
  };
}

function buildClientQuoteMutationView({ meta = null, quote = null, quoteMarkdown = null } = {}) {
  const pipelineStage = meta?.pipelineStage || meta?.deliveryStatus || null;
  const visibleQuote = buildClientQuoteView(quote, pipelineStage, { historical: false });
  return {
    meta: sanitizeClientJobMeta(meta, quote, {
      historical: false,
      issuedVersion: false,
      current: true,
    }),
    quote: visibleQuote,
    quoteMarkdown: getDisplayableQuoteMarkdown(quote, quoteMarkdown, pipelineStage, { current: true }),
  };
}

function buildClientQuoteView(storedQuote, pipelineStage = null, { historical = false, issuedVersion = false, rowsFinancials = null } = {}) {
  if (!storedQuote || typeof storedQuote !== "object") return storedQuote;
  const quote = withCurrentPricingVerdict(storedQuote);
  const pricingDisplayable = isQuotePricingDisplayable(quote, {
    pipelineStage,
    historical,
    issuedVersion,
    current: !historical,
  });
  const visibleQuote = sanitizeQuoteForPricingDisplay(quote, pipelineStage, {
    historical,
    issuedVersion,
    current: !historical,
  });
  // From the quote's rows (#10): the database's when the caller loaded them,
  // else the rows the files map to.
  const customerPricing = pricingDisplayable ? (rowsFinancials || quoteRowsFromArtifact({ quote }).financials) : null;

  const commercialLinesCount = pricingDisplayable && Array.isArray(quote.commercialLines) ? quote.commercialLines.length : 0;
  const budgetLinesCount = pricingDisplayable && Array.isArray(quote.budgetLines) ? quote.budgetLines.length : 0;
  const materialOrdersCount = pricingDisplayable && Array.isArray(quote.materialOrders) ? quote.materialOrders.length : 0;
  const internalPricing = pricingDisplayable ? buildClientQuoteInternalPricingSummary({
    internalPricing: quote.internalPricing || null,
    commercialLinesCount,
    budgetLinesCount,
    materialOrdersCount,
    selectionState: quote.selectionState || null,
  }) : null;

  return {
    kind: visibleQuote.kind,
    version: visibleQuote.version,
    status: visibleQuote.status,
    generatedAt: visibleQuote.generatedAt,
    updatedAt: visibleQuote.updatedAt,
    jobId: visibleQuote.jobId,
    jobNumber: visibleQuote.jobNumber,
    quoteNumber: visibleQuote.quoteNumber,
    title: visibleQuote.title,
    recordingIntent: visibleQuote.recordingIntent,
    delivery: visibleQuote.delivery || null,
    quoteCatalog: visibleQuote.quoteCatalog || null,
    context: visibleQuote.context || null,
    summary: visibleQuote.summary || null,
    jobScope: visibleQuote.jobScope || null,
    processReferences: visibleQuote.processReferences || [],
    siteConstraints: visibleQuote.siteConstraints || [],
    measurements: visibleQuote.measurements || [],
    lineItems: visibleQuote.lineItems || [],
    assumptionInputs: visibleQuote.assumptionInputs || [],
    execution: visibleQuote.execution || null,
    moasure: visibleQuote.moasure || null,
    review: visibleQuote.review || null,
    missingInputs: visibleQuote.missingInputs || [],
    assumptions: visibleQuote.assumptions || [],
    commercialAuthority: visibleQuote.commercialAuthority || null,
    pricing: visibleQuote.pricing || null,
    totals: visibleQuote.totals || null,
    customerPricing,
    breakdownSource: visibleQuote.breakdownSource || null,
    presentation: visibleQuote.presentation || null,
    optionFamilies: visibleQuote.optionFamilies || [],
    selectionState: visibleQuote.selectionState || null,
    internalPricing,
    commercialLines: pricingDisplayable && Array.isArray(quote.commercialLines) ? quote.commercialLines : [],
    budgetLines: pricingDisplayable && Array.isArray(quote.budgetLines) ? quote.budgetLines : [],
    materialOrders: pricingDisplayable && Array.isArray(quote.materialOrders) ? quote.materialOrders : [],
    commercialLinesCount,
    budgetLinesCount,
    materialOrdersCount,
    hasInternalBreakdown: Boolean(
      internalPricing
      || commercialLinesCount
      || budgetLinesCount
      || materialOrdersCount
    ),
    identity: visibleQuote.identity || null,
  };
}

function buildClientQuoteInternalPricingSummary({
  internalPricing = null,
  commercialLinesCount = 0,
  budgetLinesCount = 0,
  materialOrdersCount = 0,
  selectionState = null,
}) {
  const lineItemBreakdownsCount = Array.isArray(internalPricing?.lineItemBreakdowns)
    ? internalPricing.lineItemBreakdowns.length
    : 0;
  if (
    !internalPricing
    && !commercialLinesCount
    && !budgetLinesCount
    && !materialOrdersCount
  ) {
    return null;
  }

  return {
    mode: internalPricing?.mode || null,
    unresolvedOptions: internalPricing?.unresolvedOptions === true,
    ready: internalPricing?.ready,
    coverage: internalPricing?.coverage || null,
    totals: internalPricing?.totals || null,
    note: internalPricing?.note || null,
    pricingIssues: Array.isArray(internalPricing?.pricingIssues) ? internalPricing.pricingIssues : [],
    selectionState: internalPricing?.selectionState || selectionState || null,
    lineItemBreakdowns: Array.isArray(internalPricing?.lineItemBreakdowns) ? internalPricing.lineItemBreakdowns : [],
    lineItemBreakdownsCount,
    commercialLines: Array.isArray(internalPricing?.commercialLines) ? internalPricing.commercialLines : [],
    commercialLineCount: commercialLinesCount,
    budgetLines: Array.isArray(internalPricing?.budgetLines) ? internalPricing.budgetLines : [],
    budgetLineCount: budgetLinesCount,
    materialOrders: Array.isArray(internalPricing?.materialOrders) ? internalPricing.materialOrders : [],
    materialOrderCount: materialOrdersCount,
    optionFamilies: Array.isArray(internalPricing?.optionFamilies) ? internalPricing.optionFamilies : [],
  };
}

function parseRequestedQuoteVersion(versionRef) {
  if (versionRef == null || versionRef === "") return null;
  const normalized = String(versionRef).trim().toLowerCase();
  // "latest" means the actual numeric latest version. Distinct from null,
  // which lets the server fall back to the lastSent customer-facing version
  // for non-draft jobs.
  if (normalized === "latest") return "latest";
  const parsed = parseQuoteVersion(versionRef);
  if (!parsed) {
    const err = new Error("invalid quote version");
    err.statusCode = 400;
    throw err;
  }
  return parsed;
}

function buildQuotePdfFilename(meta, quote, versionSuffix = "", documentType = null) {
  const clientName = (meta?.contactName || meta?.customerName || "").trim();
  const quoteNum = quote?.quoteNumber || meta?.quoteNumber || meta?.id || "quote";
  const slugify = (s) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  const parts = [clientName && slugify(clientName), slugify(String(quoteNum))].filter(Boolean);
  const resolvedDocumentType = resolveJobDocumentType({ meta, documentType });
  const documentSuffix = resolvedDocumentType === "invoice"
    ? "-invoice"
    : resolvedDocumentType === "receipt"
      ? "-receipt"
      : "";
  return `${parts.join("-")}${versionSuffix}${documentSuffix}.pdf`;
}

function normalizeJobMeta(meta) {
  const milestoneAwareMeta = applyMilestoneInvoiceCompatFields(meta);
  // Resolve pipeline stage from new or legacy field names
  const rawStage = milestoneAwareMeta?.pipelineStage || milestoneAwareMeta?.deliveryStatus || milestoneAwareMeta?.quoteDeliveryStatus || "draft";
  const pipelineStage = normalizePipelineStage(rawStage);

  // Auto-recover jobs stuck in "processing" for more than 10 minutes
  let status = milestoneAwareMeta?.status;
  if (status === "processing" && milestoneAwareMeta?.createdAt) {
    const age = Date.now() - new Date(milestoneAwareMeta.createdAt).getTime();
    if (age > 10 * 60 * 1000) status = "complete";
  }

  return {
    ...milestoneAwareMeta,
    status,
    quoteBuild: normalizeQuoteBuildState(milestoneAwareMeta?.quoteBuild || null),
    quoteCatalogId: resolveQuoteCatalogIdFromMeta(milestoneAwareMeta),
    pipelineStage,
    invoiceSentAt: milestoneAwareMeta?.invoiceSentAt || null,
    invoicePaidAmount: coerceInvoicePaidAmount(milestoneAwareMeta?.invoicePaidAmount),
    // Keep deliveryStatus in API responses for backward compat during migration
    deliveryStatus: pipelineStage,
  };
}

async function readNormalizedJobMeta(jobDir) {
  const meta = await readJobMeta(jobDir);
  return meta ? normalizeJobMeta(meta) : null;
}

async function persistNormalizedJobMeta(jobDir, meta) {
  return normalizeJobMeta(await writeJobMeta(jobDir, meta));
}

function resolveJobSourceFilePath(jobDir, relativePath) {
  const normalized = String(relativePath || "").replace(/^\/+/, "").trim();
  if (!normalized) {
    const err = new Error("path required");
    err.statusCode = 400;
    throw err;
  }
  const resolvedJobDir = resolve(jobDir);
  const resolvedPath = resolve(jobDir, normalized);
  if (!resolvedPath.startsWith(`${resolvedJobDir}/`) && resolvedPath !== resolvedJobDir) {
    const err = new Error("invalid source file path");
    err.statusCode = 400;
    throw err;
  }
  return resolvedPath;
}

function guessMimeTypeFromPath(filePath) {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg" || ext === "oga") return "audio/ogg";
  if (ext === "webm") return "audio/webm";
  if (ext === "mp4") return "audio/mp4";
  if (ext === "m4a") return "audio/x-m4a";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "heic") return "image/heic";
  if (ext === "txt" || ext === "log") return "text/plain; charset=utf-8";
  if (ext === "md" || ext === "markdown") return "text/markdown; charset=utf-8";
  if (ext === "json") return "application/json; charset=utf-8";
  if (ext === "csv") return "text/csv; charset=utf-8";
  if (ext === "yaml" || ext === "yml") return "application/yaml; charset=utf-8";
  return "application/octet-stream";
}

// ═══════════════════════════════════════════════════════════════════════
// RETAINING WALL PIPELINE
// ═══════════════════════════════════════════════════════════════════════
import { extractBayHeights } from "./retaining-wall-measurement.js";
import { buildBayModel } from "./retaining-wall-engine.js";
import { buildQuoteFromWallModel } from "./retaining-wall-commercial.js";
import { isPipelineSent, normalizePipelineStage } from "./pipeline.js";
import { buildWallQuoteMeta } from "./wall-quote-workflow.js";

// GET wall design spec
app.get("/api/jobs/:id/wall-design", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const activeJobDir = await resolveActiveJobGeneration(job.dir);
  const designPath = join(activeJobDir, "wall-design.json");
  if (!existsSync(designPath)) return res.json({ data: null });
  res.json({ data: JSON.parse(await readFile(designPath, "utf8")) });
});

// PUT wall design spec
app.put("/api/jobs/:id/wall-design", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    await runAtomicJobGeneration(job.dir, async (stagedJobDir) => {
      await writeFile(join(stagedJobDir, "wall-design.json"), JSON.stringify(req.body, null, 2));
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// POST import measurement → extract bay heights
app.post("/api/jobs/:id/wall-measurement", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const response = await runAtomicJobGeneration(job.dir, async (activeJobDir) => {
    // Moasure evidence is operational and stays at the job root; only the
    // bay heights derived from it belong to the generation.
    const moasureSummary = await readMoasureSummary(job.dir);
    if (!moasureSummary?.imports?.length) {
      const error = new Error("No Moasure data imported. Upload a CSV first.");
      error.statusCode = 400;
      throw error;
    }

    // Read the CSV directly for full point data
    const latestImport = moasureSummary.imports[moasureSummary.imports.length - 1];
    const batchDir = join(getMoasurePaths(job.dir).rawDir, latestImport.batchId);
    const csvPath = join(batchDir, latestImport.csvFile);

    const text = await readFile(csvPath, "utf8");
    const [headerLine, ...lines] = text.trim().split(/\r?\n/);
    const headers = headerLine.split('","').map((c) => c.replace(/^"|"$/g, ""));
    const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
    const points = lines.map((line) => {
      const row = line.split('","').map((c) => c.replace(/^"|"$/g, ""));
      return {
        path: row[idx.Path] || "",
        x: Number(row[idx["X:m"]]) || 0,
        y: Number(row[idx["Y:m"]]) || 0,
        z: Number(row[idx["Z:m"]]) || 0,
      };
    });

    // Load design for overrides
    const designPath = join(activeJobDir, "wall-design.json");
    const design = existsSync(designPath) ? JSON.parse(await readFile(designPath, "utf8")) : {};
    const heightOverrides = design?.design_overrides?.height_overrides || {};
    const bayPitchM = (design?.construction_rules?.bay_pitch_mm || 2010) / 1000;

    const result = extractBayHeights({
      points,
      bayPitchM,
      heightOverrides,
    });

    // Save bay heights
    await writeFile(join(activeJobDir, "bay-heights.json"), JSON.stringify(result, null, 2));
    return result;
    });
    res.json({ data: response });
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// POST build wall model from bay heights + design + rate card
app.post("/api/jobs/:id/wall-build", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    const response = await runAtomicJobGeneration(job.dir, async (stagedJobDir) => {
      // Resolve the live authority only after the per-job generation lock is
      // held. The model, quote, attestation, and publication therefore share
      // one immutable catalogue snapshot instead of a pre-lock read that can
      // race a catalogue edit or maintenance operation.
      const resolvedRateCard = await resolveWallRateCard({
        priceCatalog: config?.priceCatalog,
      });
      if (!resolvedRateCard.rateCard) {
        const error = new Error(resolvedRateCard.error);
        error.statusCode = 503;
        error.source = resolvedRateCard.source;
        error.pricingBlocked = true;
        throw error;
      }
      const { rateCard } = resolvedRateCard;
      const buildJobDir = stagedJobDir;
      const heightsPath = join(buildJobDir, "bay-heights.json");
      const designPath = join(buildJobDir, "wall-design.json");
      if (!existsSync(heightsPath)) {
        const error = new Error("No bay heights. Run wall-measurement first.");
        error.statusCode = 400;
        throw error;
      }
      if (!existsSync(designPath)) {
        const error = new Error("No wall design. Set design spec first.");
        error.statusCode = 400;
        throw error;
      }
      const heights = JSON.parse(await readFile(heightsPath, "utf8"));
      const design = JSON.parse(await readFile(designPath, "utf8"));
      const buildMeta = await readNormalizedJobMeta(buildJobDir) || normalizeJobMeta(job.meta);
      const model = buildBayModel({
        bayHeights: heights.bayHeights,
        bayGeometry: heights.bayGeometry,
        bendAngles: heights.bendAngles,
        design,
        rateCard,
      });
      model.perimeter_m = heights.perimeter_m;

      // The baseline wall rates are known before model generation, but the
      // design/model can add conditional monetary dependencies (rock material,
      // APC minimum delivery, or a new resource line). Validate those against
      // the same immutable authority snapshot before any wall artifact write.
      try {
        assertPriceCatalogSnapshotComplete(resolvedRateCard.pricingSnapshot, {
          requiredCodes: resolveWallRequiredPriceCodes({ model, design }),
        });
      } catch (pricingError) {
        const error = new Error(`Wall pricing is incomplete: ${pricingError.message}`);
        error.statusCode = 503;
        error.source = resolvedRateCard.source;
        error.pricingBlocked = true;
        throw error;
      }

      // Save model and all dependent quote/lifecycle state in one staged
      // generation. The caller publishes only after every write succeeds.
      await writeFile(join(buildJobDir, "bay-model.json"), JSON.stringify(model, null, 2));

    // Also generate quote.json from the model (same structure as audio-based quotes)
      const currentQuoteArtifacts = await readQuoteArtifacts(buildJobDir);
      const quoteLifecycle = await readQuoteLifecycle(buildJobDir);
      const currentVersion = Number(
        currentQuoteArtifacts?.quote?.version
        || buildMeta?.quoteVersion
        || 1
      );
      const currentStage = normalizePipelineStage(buildMeta?.pipelineStage || buildMeta?.deliveryStatus);
      const shouldForkSentQuote =
        Boolean(currentQuoteArtifacts?.quote)
        && shouldForkQuoteMutation({
          meta: buildMeta,
          quoteLifecycle,
          currentQuoteVersion: currentVersion,
        });
      if (!quoteLifecycle && shouldForkSentQuote && isPipelineSent(currentStage)) {
        await recordQuotePipelineStageChange({
          jobDir: buildJobDir,
          meta: {
            ...buildMeta,
            quoteVersion: currentVersion,
          },
          stage: currentStage,
          changedAt:
            buildMeta?.quoteSentAt
            || buildMeta?.landedAt
            || buildMeta?.lostAt
            || currentQuoteArtifacts?.quote?.delivery?.finalizedAt
            || currentQuoteArtifacts?.quote?.updatedAt
            || new Date().toISOString(),
        });
      }
      const version = shouldForkSentQuote ? await getNextQuoteVersion(buildJobDir) : currentVersion;
      model.quoteVersion = version;
      model.quoteSnapshotDigest = resolvedRateCard.pricingSnapshot?.snapshotDigest || null;
      if (shouldForkSentQuote && currentQuoteArtifacts?.quote) {
        const historicalWallDir = join(
          buildJobDir,
          "quote-versions",
          formatQuoteVersionLabel(currentVersion),
        );
        await mkdir(historicalWallDir, { recursive: true });
        for (const fileName of ["bay-model.json", "wall-design.json", "bay-heights.json", "wall-zones.json"]) {
          const sourcePath = join(buildJobDir, fileName);
          const targetPath = join(historicalWallDir, fileName);
          if (existsSync(sourcePath) && !existsSync(targetPath)) {
            await writeFile(targetPath, await readFile(sourcePath));
          }
        }
      }
      const identifiedMeta = ensureQuoteIdentityMeta({
        meta: buildMeta,
        version,
      });
      const overrides = await readQuoteOverrides(buildJobDir);
      let quoteFromModel = buildQuoteFromWallModel({
        model,
        design,
        rateCard,
        meta: identifiedMeta,
        version,
      });
      quoteFromModel = applyPresentationToQuote({
        quote: quoteFromModel,
        overrides,
        defaultScopeText: quoteFromModel.summary || null,
        preferDefaultScopeText: true,
      });
      const identityApplied = applyQuoteIdentity({
        meta: identifiedMeta,
        quote: quoteFromModel,
        overrides,
      });
      const metaWithQuoteIdentity = identityApplied.meta;
      quoteFromModel = attachQuotePricingAttestation({
        quote: identityApplied.quote,
        attestation: buildQuotePricingAttestation({
          authorityStatus: {
            provider: "price_catalog",
            mode: "active",
            refreshedAt: resolvedRateCard.pricingSnapshot?.fetchedAt || null,
            catalogRevision: resolvedRateCard.pricingSnapshot?.catalogRevision || null,
            snapshotDigest: resolvedRateCard.pricingSnapshot?.snapshotDigest || null,
          },
          livePricingAvailable: Boolean(
            quoteFromModel?.pricing?.ready !== false
            && quoteFromModel?.internalPricing?.ready !== false,
          ),
        }),
      });
      if (shouldForkSentQuote && currentQuoteArtifacts?.quote) {
        await writeQuoteVersionSnapshot({
          jobDir: buildJobDir,
          meta: metaWithQuoteIdentity,
          quote: currentQuoteArtifacts.quote,
          quoteMarkdown:
            currentQuoteArtifacts.quoteMarkdown
            || generateEvidenceQuoteMarkdown({ meta: metaWithQuoteIdentity, quote: currentQuoteArtifacts.quote }),
          quoteBreakdownSource: currentQuoteArtifacts.quoteBreakdownSource ?? null,
        });
      }
      const quoteMarkdown = generateEvidenceQuoteMarkdown({
        meta: metaWithQuoteIdentity,
        quote: quoteFromModel,
      });
      await writeQuoteArtifacts({
        jobDir: buildJobDir,
        meta: metaWithQuoteIdentity,
        quote: quoteFromModel,
        quoteMarkdown,
        quoteOverrides: overrides,
        quoteBreakdownSource: null,
      });

      const nextMeta = buildWallQuoteMeta({
        metaWithQuoteIdentity,
        quoteFromModel,
        jobMeta: buildMeta,
      });
      nextMeta.quoteSnapshotDigest = quoteFromModel?.pricing?.attestation?.snapshotDigest || null;
      const persistedMeta = await persistNormalizedJobMeta(buildJobDir, nextMeta);
      await markQuoteBuilt({
        jobDir: buildJobDir,
        meta: persistedMeta,
        quote: quoteFromModel,
        reason: "wall_build",
      });

      const displayable = isQuotePricingDisplayable(quoteFromModel, {
        pipelineStage: nextMeta.pipelineStage,
        current: true,
      });
      return {
        data: {
          model: sanitizePricingSurface(model, { displayable }),
          quote: buildClientQuoteView(quoteFromModel, nextMeta.pipelineStage, { historical: false }),
        },
      };
    });
    res.json(response);
  } catch (err) {
    res.status(err.statusCode || 500).json(errorBody(err));
  }
});

// GET wall model
app.get("/api/jobs/:id/wall-model", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  const activeJobDir = await resolveActiveJobGeneration(job.dir);
  const currentArtifacts = await readQuoteArtifacts(job.dir);
  const latestVersion = Number(currentArtifacts?.quote?.version || 0) || null;
  const requestedVersion = parseRequestedQuoteVersion(req.query?.version);
  const historical = Boolean(
    requestedVersion
    && requestedVersion !== "latest"
    && latestVersion
    && Number(requestedVersion) !== latestVersion,
  );
  const selectedVersion = historical ? Number(requestedVersion) : latestVersion;
  const selectedDir = historical
    ? join(activeJobDir, "quote-versions", formatQuoteVersionLabel(selectedVersion))
    : activeJobDir;
  const modelPath = join(selectedDir, "bay-model.json");
  if (!existsSync(modelPath)) {
    return historical
      ? res.status(410).json({ error: "the version-bound wall model is unavailable" })
      : res.json({ data: null });
  }
  const model = JSON.parse(await readFile(modelPath, "utf8"));
  const artifacts = historical
    ? await readQuoteArtifacts(job.dir, selectedVersion)
    : currentArtifacts;
  const quoteSnapshotDigest = artifacts?.quote?.pricing?.attestation?.snapshotDigest || null;
  if ((model.quoteSnapshotDigest || quoteSnapshotDigest)
    && model.quoteSnapshotDigest !== quoteSnapshotDigest) {
    return res.status(409).json({ error: "wall model pricing snapshot does not match its quote" });
  }
  const issuanceRecord = findIssuedQuoteVersion(
    await readQuoteIssuanceLedger(job.dir),
    artifacts?.quote?.version || selectedVersion || null,
    "quote",
  );
  const issuedVersion = isIssuedQuoteVersion({
    quote: artifacts?.quote || null,
    quoteLifecycle: await readQuoteLifecycle(job.dir),
    version: artifacts?.quote?.version || null,
    meta: job.meta,
    issuanceRecord,
  });
  if (historical && !issuanceRecord && issuedVersion) {
    return res.status(410).json({ error: "the exact issued wall model bytes are unavailable" });
  }
  const displayable = isQuotePricingDisplayable(artifacts?.quote, {
    pipelineStage: job.meta?.pipelineStage,
    historical,
    issuedVersion,
    current: !historical,
  });
  res.json({ data: sanitizePricingSurface(model, { displayable }) });
});

app.get("/api/jobs/:id/wall-zones", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    res.json({ data: await readWallZones(job.dir) });
  } catch (err) {
    res.status(400).json(errorBody(err));
  }
});

app.get("/api/jobs/:id/wall-zones/:zoneId/render", requireAuth, async (req, res) => {
  const job = await findJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  try {
    const selectedVersion = parseRequestedQuoteVersion(req.query?.version);
    const detail = await loadJobDetail(job, { version: selectedVersion });
    const historical = Boolean(detail.versionView && !detail.versionView.isLatest);
    const renderJobDir = historical
      ? join(
          await resolveActiveJobGeneration(job.dir),
          "quote-versions",
          formatQuoteVersionLabel(detail.versionView.selectedVersion),
        )
      : job.dir;
    const renderZones = await readWallZones(renderJobDir);
    const renderZone = renderZones?.zones?.find((zone) => zone.id === req.params.zoneId);
    if (historical) {
      const modelPath = renderZone?.bayModelPath
        ? join(renderJobDir, renderZone.bayModelPath)
        : join(renderJobDir, "bay-model.json");
      if (!modelPath.startsWith(`${resolve(renderJobDir)}/`)) {
        return res.status(400).json({ error: "invalid version-bound wall render model path" });
      }
      if (!existsSync(modelPath)) {
        return res.status(410).json({ error: "the version-bound wall render model is unavailable" });
      }
      const versionedModel = JSON.parse(await readFile(modelPath, "utf8"));
      const versionedQuoteDigest = detail.quote?.pricing?.attestation?.snapshotDigest || null;
      if ((versionedModel?.quoteSnapshotDigest || versionedQuoteDigest)
        && versionedModel.quoteSnapshotDigest !== versionedQuoteDigest) {
        return res.status(409).json({ error: "wall render pricing snapshot does not match its quote" });
      }
    }
    const resolvedRateCard = historical
      ? { rateCard: null }
      : await resolveWallRateCard({
          priceCatalog: config?.priceCatalog,
        });
    if (!historical && !resolvedRateCard.rateCard) {
      return res.status(503).json({
        error: resolvedRateCard.error,
        source: resolvedRateCard.source,
        pricingBlocked: true,
      });
    }
    const payload = await buildWallZoneRenderPayloadForJob({
      jobDir: renderJobDir,
      // A historical render stays bound to its version's own files.
      operationalJobDir: historical ? null : job.dir,
      zoneId: req.params.zoneId,
      quote: detail.quote || null,
      moasureSummary: detail.moasure || null,
      rateCard: resolvedRateCard.rateCard,
    });
    if (!payload) {
      return res.status(404).json({ error: "wall zone render not found" });
    }
    const issuedVersion = Boolean(detail.versionView?.selectedVersionIssued);
    const displayable = isQuotePricingDisplayable(detail.quote, {
      pipelineStage: detail.meta?.pipelineStage,
      historical,
      issuedVersion,
      current: !historical,
    });
    const visiblePayload = sanitizePricingSurface(payload, { displayable });
    const requestedFormat = String(req.query?.format || "json").trim().toLowerCase();
    if (requestedFormat === "html") {
      const requestedTheme = String(req.query?.theme || "").trim() || null;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderRetainingWallStandaloneHtml({ payload: visiblePayload, theme: requestedTheme }));
      return;
    }
    res.json({ data: visiblePayload });
  } catch (err) {
    res.status(400).json(errorBody(err));
  }
});

// GET rate card (live commercial authority only)
app.get("/api/rate-card", requireAuth, async (req, res) => {
  const resolvedRateCard = await resolveWallRateCard({
    priceCatalog: config?.priceCatalog,
    requiredCodes: RATE_CARD_REQUIRED_PRICE_CODES,
  });
  if (!resolvedRateCard.rateCard) {
    return res.status(503).json({
      data: null,
      source: resolvedRateCard.source,
      error: resolvedRateCard.error,
      pricingBlocked: true,
    });
  }
  res.json({ data: resolvedRateCard.rateCard, source: resolvedRateCard.source });
});

// Standards-based remote MCP. OAuth credentials are deliberately separate from
// Field's broad legacy UI/API bearer tokens; tool handlers call shared domain
// functions directly rather than looping back through HTTP.
const remoteMcpRuntime = resolveRemoteMcpRuntimeConfig({ config });
if (remoteMcpRuntime.enabled) {
  const { publicOrigin } = remoteMcpRuntime;
  const listQuotesForMcp = async ({ search, status, limit = 50 } = {}) => {
    const rows = fieldDb ? await listIndexedJobRows("MCP quote list") : [];
    let jobs = [];
    for (const row of rows) {
      const meta = await readNormalizedJobMeta(row.dir);
      if (meta) jobs.push(meta);
    }
    if (!fieldDb) {
      const dateDirectories = (await readdir(DATA_DIR).catch(() => [])).sort().reverse();
      for (const dateDir of dateDirectories) {
        const datePath = join(DATA_DIR, dateDir);
        if (!(await stat(datePath).catch(() => null))?.isDirectory()) continue;
        for (const id of await readdir(datePath)) {
          const meta = await readNormalizedJobMeta(join(datePath, id)).catch(() => null);
          if (meta) jobs.push(meta);
        }
      }
    }
    if (status) jobs = jobs.filter((job) => job.status === status);
    if (search) {
      const needle = String(search).toLowerCase();
      jobs = jobs.filter((job) => (
        [job.id, job.title, job.label, job.siteAddress]
          .some((value) => String(value || "").toLowerCase().includes(needle))
      ));
    }
    return jobs.slice(0, limit);
  };
  const mcpService = createFieldMcpService({
    listPriceItems: (filters) => requireCatalogStore().listItems(filters),
    getPriceItem: async (code) => {
      const store = requireCatalogStore();
      const item = await store.getItem(code);
      if (!item) throw Object.assign(new Error("Catalog item not found"), { code: "not_found" });
      return { ...item, children: await store.listChildren(item.uid) };
    },
    updatePriceItem: async (code, patch, actor, { expectedVersion = null } = {}) => {
      const store = requireCatalogStore();
      const item = await store.getItem(code);
      if (!item) throw Object.assign(new Error("Catalog item not found"), { code: "not_found" });
      return store.updateItem(item.uid, patch, {
        author: `oauth:${actor.subject}`,
        expectedVersion,
      });
    },
    listQuotes: listQuotesForMcp,
    listQuoteCatalogs: async () => listQuoteCatalogs(),
    getQuoteCatalog: async (id) => {
      if (!hasQuoteCatalog(id)) return null;
      if (priceCatalog) await refreshQuoteCatalogAuthority({ priceCatalog, required: false, force: false });
      return serializeQuoteCatalog(id);
    },
    listCategories: async () => requireCatalogStore().listCategories(),
    listChildren: async (code) => requireCatalogStore().listChildren(code),
    createCategory: async (body, _actor, guard = {}) => requireCatalogStore().createCategory(body, guard),
    updateCategory: async (id, body, _actor, guard = {}) => requireCatalogStore().updateCategory(id, body, guard),
    deleteCategory: async (id, _actor, guard = {}) => requireCatalogStore().deleteCategory(id, guard),
    addChild: async (body, actor, guard = {}) => requireCatalogStore().addChild(body, {
      author: `oauth:${actor.subject}`,
      ...guard,
    }),
    updateChild: async (body, actor, guard = {}) => requireCatalogStore().updateChild(body, {
      author: `oauth:${actor.subject}`,
      ...guard,
    }),
    removeChild: async (body, actor, guard = {}) => requireCatalogStore().removeChild(body, {
      author: `oauth:${actor.subject}`,
      ...guard,
    }),
    getCatalogVersion: async () => requireCatalogStore().catalogVersion(),
    ...(milestoneRuleService ? {
      listMilestoneRules: async () => milestoneRulesBody(),
      checkJobMilestones: async (id) => {
        const job = await findJob(id);
        if (!job) throw Object.assign(new Error("Quote not found"), { code: "not_found" });
        return readJobMilestoneRules({ jobDir: job.dir, meta: job.meta, config });
      },
    } : {}),
    getQuote: async (id, version = null) => {
      const job = await findJob(id);
      if (!job) throw Object.assign(new Error("Quote not found"), { code: "not_found" });
      return buildClientJobDetail(await loadJobDetail(job, { version: version || null }));
    },
    createQuote: async (params) => createManualJob({
      quoteCatalogId: params.quoteCatalogId || DEFAULT_QUOTE_CATALOG_ID,
      siteAddress: params.siteAddress || null,
      quotedBy: params.quotedBy || null,
    }),
    updateQuote: async (id, patch, actor) => {
      const job = await findJob(id);
      if (!job) throw Object.assign(new Error("Quote not found"), { code: "not_found" });
      return runExclusiveJobMutation(
        job.meta.id,
        "OAuth MCP quote update",
        () => updateJobQuote({
          jobDir: job.dir,
          meta: normalizeJobMeta(job.meta),
          config,
          provenance: {
            agentTool: "field-remote-mcp",
            llmEngine: "unknown",
            agentSessionId: null,
          },
          // Preserve omission. Supplying defaults here would clear fields the
          // caller deliberately left out of a partial quote patch.
          patch: { ...patch },
          actor: { kind: "oauth", label: actor.subject },
        }),
      );
    },
    recalculateQuote: async (id, actor) => {
      const job = await findJob(id);
      if (!job) throw Object.assign(new Error("Quote not found"), { code: "not_found" });
      return runExclusiveJobMutation(
        job.meta.id,
        "OAuth MCP quote pricing refresh",
        () => regenerateRecordingQuote({
          jobDir: job.dir,
          meta: normalizeJobMeta(job.meta),
          config,
          provenance: {
            agentTool: "field-remote-mcp",
            llmEngine: "unknown",
            agentSessionId: null,
          },
          actor: { kind: "oauth", label: actor.subject },
          buildReason: "quote_pricing_refresh",
        }),
      );
    },
  });
  const remoteMcp = await createRemoteMcpRouter({
    dataDir: DATA_DIR,
    publicOrigin,
    // Clerk sign-in: no passwords; a verified owner sign-in approves from the
    // signed-in session, and only owners manage installations.
    authenticate: clerkAuth ? async () => null : authenticateUser,
    approveWithSession: clerkAuth ? (req, res) => clerkAuth.authenticateOwnerSession(req, res) : null,
    authorizeScopes: authorizeFieldMcpScopes,
    // Every /mcp call and refresh is checked against the approver's access
    // now, so removing, disabling or demoting someone takes effect at once.
    currentScopes: clerkAuth
      ? (subject) => clerkAuth.currentMcpScopes(subject)
      : (subject) => {
        const user = findUserById(subject);
        return user ? authorizeFieldMcpScopes(user, MCP_SCOPES) : null;
      },
    authenticateInstallationRequest: clerkAuth ? [requireAuth, requireAdmin] : requireAuth,
    // Every disconnect writes an access audit event (#133).
    onInstallationDisconnected: async ({ req, installation }) => {
      if (!accessAudit) throw new Error("no access audit store (no database)");
      const name = clerkAuth ? await clerkAuth.holderName(installation.subject) : findUserById(installation.subject)?.name ?? null;
      await accessAudit.record("mcp_installation_disconnected", {
        actor: req.caller,
        target: { id: installation.id, name: installation.clientName },
        holder: { id: installation.subject, name },
      });
    },
    service: mcpService,
    // Each MCP installation has its own caller budget (server/rate-limits.js).
    limitCaller: rateLimits.byCaller,
    rateLimitBudgets: RATE_LIMIT_BUDGETS,
  });
  revokeMcpSubjects = (subjects) => remoteMcp.store.revokeSubjects(subjects);
  app.use(remoteMcp.router);
}

// SPA fallback — serve React client index.html for non-API routes
if (existsSync(clientIndex)) {
  app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    return sendClientIndex(res);
  });
}

// Data migrations (server/data-migrations/): changes to existing records
// that run once, after the schema migrations and before anything is served
// or scheduled. Each verifies itself before writing and is recorded in
// data_migrations; a failure stops boot with nothing half-applied. With
// durable storage their file changes are stored in one flush. The quote and
// invoice row backfills write each job that verifies; a refused job is
// logged, never stops boot, and leaves its backfill unrecorded so the next
// boot retries it.
// FIELD_DATA_MIGRATIONS_HOLD=<id>|all skips them (emergency stop, logged).
if (catalogStore && deploymentOrg) {
  try {
    await runDataMigrations({
      db: getDb(),
      orgUid: deploymentOrg.uid,
      dataDir: DATA_DIR,
      getState: () => catalogStore.getState({ fresh: true }),
      catalogStore,
      hold: heldDataMigrations(process.env),
      flush: async ({ reason }) => {
        if (durableStorage) await durableStorage.flushGlobal(reason);
      },
    });
  } catch (err) {
    console.error(`[data-migrations] ${err.message}`);
    process.exit(1);
  }
} else {
  console.warn("[data-migrations] skipped: no price catalogue or organisation (degraded boot)");
}

scheduledEmailScheduler = await startScheduledEmailScheduler({
  dataDir: DATA_DIR,
  processEmail: processScheduledEmail,
});
// The R2 replica's scheduler: its first pass copies every blob stored before
// replication was turned on.
documentReplica.start();

await setupSentryExpress(app);
if (durableStorage) {
  // Whatever boot wrote (users, templates, SQLite schema) is stored before serving.
  try {
    await durableStorage.flushGlobal("boot");
  } catch (err) {
    console.error(`[storage] could not store boot changes: ${err.message}`);
    process.exit(1);
  }
}
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[field] listening on http://0.0.0.0:${PORT}`);
  console.log(`[field] data: ${DATA_DIR}`);
  console.log(`[field] client: ${existsSync(clientDist) ? "React (client/dist)" : "not built (run npm run build)"}`);
});

// Graceful shutdown: stop accepting new connections, drain in-flight
// requests, then exit. Caddy's lb_try_duration holds incoming requests
// during this window so deploy restarts are invisible to users.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 10_000);
let shuttingDown = false;
const handleShutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[field] [shutdown] received ${signal}, draining`);
  server.close(async (err) => {
    if (err) {
      console.error("[field] [shutdown] server.close error:", err);
      process.exit(1);
    }
    if (scheduledEmailScheduler) await scheduledEmailScheduler.stop();
    await documentReplica.stop().catch(() => {});
    if (durableStorage) {
      // Final flush (files and the field.db image, while it is open), then
      // release the storage lock.
      try {
        await durableStorage.close();
      } catch (storageError) {
        console.error(`[field] [shutdown] durable storage final flush failed: ${storageError.message}`);
      }
    }
    try {
      await closeDb();
    } catch (dbError) {
      console.error(`[field] [shutdown] database close failed: ${dbError.message}`);
    }
    console.log("[field] [shutdown] drained cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    console.error(`[field] [shutdown] timeout after ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms, force exiting`);
    process.exit(1);
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref();
};
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
