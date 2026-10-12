// Read-only check of the R2 replica (#12): every issued document's bytes are
// in the bucket at `<org_uid>/<sha256>` and hash to the document's
// pdf_sha256. Other stored bytes (a resend rendered again) are checked too.
// It GETs each object and hashes it; it never writes, in R2 or in PostgreSQL.
//
//   verifyR2({ db, orgUid, store }) -> report
//
// report.ok is true only when every blob is present with the right hash.
import { sql } from "drizzle-orm";
import { queryRows } from "../db-runtime/index.js";
import { withOrg } from "../db-runtime/tenancy.js";
import { sha256Hex } from "./blob-store.js";
import { objectKeyFor } from "./r2-client.js";

export async function verifyR2({ db, orgUid, store, onProgress = () => {} }) {
  const rows = await withOrg(db, orgUid, (tx) => queryRows(sql`
    select b.sha256, b.byte_length, b.created_at, r.r2_replicated_at,
           coalesce(json_agg(json_build_object('uid', d.uid, 'documentType', d.document_type, 'number', d.number))
                    filter (where d.uid is not null), '[]') as documents
    from document_blobs b
    left join issued_documents d on d.org_uid = b.org_uid and d.pdf_sha256 = b.sha256
    left join document_blob_replicas r on r.org_uid = b.org_uid and r.sha256 = b.sha256
    group by b.sha256, b.byte_length, b.created_at, r.r2_replicated_at
    order by b.created_at, b.sha256`, tx), { accessMode: "read only" });

  const report = {
    bucket: store.bucket,
    orgUid,
    blobs: rows.length,
    issuedDocuments: 0,
    present: 0,
    missing: [],
    mismatched: [],
    errors: [],
    ok: false,
  };
  for (const row of rows) {
    const documents = typeof row.documents === "string" ? JSON.parse(row.documents) : row.documents;
    report.issuedDocuments += documents.length;
    const entry = {
      sha256: row.sha256,
      key: objectKeyFor(orgUid, row.sha256),
      byteLength: Number(row.byte_length),
      recordedReplicated: Boolean(row.r2_replicated_at),
      documents,
    };
    try {
      const bytes = await store.get(entry.key);
      if (!bytes) report.missing.push(entry);
      else if (bytes.length !== entry.byteLength || sha256Hex(bytes) !== row.sha256) {
        report.mismatched.push({ ...entry, objectSha256: sha256Hex(bytes), objectByteLength: bytes.length });
      } else report.present += 1;
    } catch (error) {
      report.errors.push({ ...entry, code: error?.code || "ERROR" });
    }
    onProgress(entry);
  }
  report.ok = report.missing.length === 0 && report.mismatched.length === 0 && report.errors.length === 0;
  return report;
}
