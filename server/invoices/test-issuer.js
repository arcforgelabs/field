// Test helper: an invoice issue service (issue.js) on a throwaway PGlite
// database, installed the way the server installs it, for tests that issue
// invoices through job-actions.js. Never used by the server.
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { createIssuedDocumentService } from "../documents/issued-documents.js";
import { createInvoiceIssueService, installInvoiceIssuer } from "./issue.js";

export async function installTestInvoiceIssuer({ orgUid = DEFAULT_ORG_UID } = {}) {
  const t = await createTestDb();
  const service = createInvoiceIssueService({ db: t.db, orgUid });
  installInvoiceIssuer(service);
  return {
    db: t.db,
    orgUid,
    service,
    documents: createIssuedDocumentService({ db: t.db, orgUid }),
    async close() {
      installInvoiceIssuer(null);
      await t.close();
    },
  };
}
