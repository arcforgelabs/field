import { readFile } from "./storage/fs-promises.js";
import { basename, join } from "node:path";
import { resolveActiveJobGeneration } from "./job-generation.js";
import { readSentEmailArchive } from "./sent-email-archive.js";

// Quotes emailed before the issuance ledger have no hashed copy of
// what was sent, so the issued-PDF routes refuse them rather than rebuild a
// monetary document from a since-changed draft. The send did save the PDF
// into the job folder under the attachment's file name, and the sent-email
// archive records that name, so that file is preferred. Quotes sent before the
// archive existed fall back to the PDF stored for that version when it was
// generated: the file Field served for them before the ledger. Neither is ever
// re-rendered. `source` says which copy was found.
export async function readLegacySentQuotePdf(jobDir, version, storedPdfPath = null) {
  const wanted = Number(version);
  const sends = (await readSentEmailArchive(jobDir)).filter((entry) => {
    if (entry.documentType && entry.documentType !== "quote") return false;
    if (entry.quoteVersion == null || !Number.isInteger(wanted) || wanted < 1) return true;
    return Number(entry.quoteVersion) === wanted;
  });
  const dirs = [...new Set([await resolveActiveJobGeneration(jobDir), jobDir])];
  // Newest send first: that's the copy the customer most recently received.
  for (const entry of sends) {
    for (const attachment of entry.attachments || []) {
      const fileName = String(attachment?.filename || "");
      if (!fileName.toLowerCase().endsWith(".pdf") || basename(fileName) !== fileName) continue;
      for (const dir of dirs) {
        let bytes;
        try {
          bytes = await readFile(join(dir, fileName));
        } catch {
          continue;
        }
        if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") continue;
        return { available: true, bytes, source: "sent-attachment", fileName, sentAt: entry.ts || null };
      }
    }
  }
  if (storedPdfPath) {
    try {
      const bytes = await readFile(storedPdfPath);
      if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
        return { available: true, bytes, source: "stored-version", fileName: basename(storedPdfPath), sentAt: null };
      }
    } catch { /* no stored copy */ }
  }
  return { available: false };
}
