#!/usr/bin/env node
// Verify the R2 replica of issued documents (#240): every issued document's
// bytes are in the bucket and hash to its recorded SHA-256. Read-only: it
// GETs and hashes each object and never writes, in R2 or in PostgreSQL.
//
//   npm run documents:verify-r2 [-- --json]
//
// Needs the database (FIELD_DB_URL or DATABASE_URL) and the four R2 settings
// (FIELD_R2_ENDPOINT, FIELD_R2_BUCKET, FIELD_R2_ACCESS_KEY_ID,
// FIELD_R2_SECRET_ACCESS_KEY); FIELD_DOCUMENT_REPLICA does not need to be set.
// The organisation is the deployment's (FIELD_ORG, default organisation). Neither
// the connection string nor a credential is ever printed.
//
// Exit codes: 0 every blob present with the right hash; 1 could not run;
// 2 something missing, mismatched or unreadable (listed).
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: npm run documents:verify-r2 [-- --json]");
  process.exit(0);
}
const asJson = args.includes("--json");

const { closeDb, getDb, getDbInfo, getMigrationStatus } = await import("../server/db-runtime/index.js");
const { resolveDeploymentOrg } = await import("../server/db-runtime/tenancy.js");
const { resolveR2Connection } = await import("../server/documents/r2-config.js");
const { createR2ObjectStore } = await import("../server/documents/r2-client.js");
const { verifyR2 } = await import("../server/documents/verify-r2.js");

function describe(entry) {
  const documents = entry.documents.map((document) => `${document.documentType} ${document.number} (${document.uid})`).join(", ") || "no issued document (resent bytes)";
  return `${entry.key}: ${documents}${entry.recordedReplicated ? "; recorded as replicated" : ""}${entry.code ? `; ${entry.code}` : ""}`;
}

let exitCode = 0;
try {
  const connection = resolveR2Connection(process.env);
  const db = getDb();
  const migrations = await getMigrationStatus(db);
  if (migrations.pending > 0) throw new Error(`${migrations.pending} migration(s) pending on ${getDbInfo().target}: boot the server once to apply them`);
  const org = await resolveDeploymentOrg(db);
  const store = createR2ObjectStore(connection);
  if (!asJson) console.log(`[verify-r2] ${getDbInfo().target}, organisation ${org.slug}; bucket ${connection.bucket}`);
  await store.checkBucket();
  const report = await verifyR2({ db, orgUid: org.uid, store });
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[verify-r2] ${report.blobs} stored blob(s) for ${report.issuedDocuments} issued document(s): ${report.present} present with the right hash`);
    for (const [label, entries] of [["missing from R2", report.missing], ["in R2 with different bytes", report.mismatched], ["could not be read", report.errors]]) {
      console.log(`[verify-r2] ${label}: ${entries.length}`);
      for (const entry of entries) console.log(`  ${describe(entry)}`);
    }
    console.log(`[verify-r2] ${report.ok ? "OK" : "PROBLEMS FOUND"}`);
  }
  if (!report.ok) exitCode = 2;
} catch (error) {
  console.error(`[verify-r2] ${error.code ? `${error.code}: ` : ""}${error.message}`);
  exitCode = 1;
} finally {
  await closeDb().catch(() => {});
}
process.exit(exitCode);
