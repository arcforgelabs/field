// "Also attach the adjustment note" when sending an invoice issued in place
// of a credited one (#28, step 4b): the credit note's stored PDF, exactly as
// issued. The job's copy, checked against its recorded hash, else the bytes
// of the issued document. Never rendered again.
import { readJobMeta } from "../job-meta-store.js";
import { readJobFile } from "../documents/job-sources.js";

function refused(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** The number of the adjustment note the milestone's current invoice was issued in place of, or null. */
export async function creditNoteNumberFor({ jobDir, milestoneIndex = 0 }) {
  const meta = await readJobMeta(jobDir);
  const milestone = (meta?.milestoneInvoices || []).find((entry) => Number(entry.milestoneIndex) === Number(milestoneIndex ?? 0));
  return milestone?.issuedRevision?.creditNoteNumber || null;
}

/** { filename, contentType, buffer } for the milestone's current invoice, or throws (409 none, 410 bytes unreadable). */
export async function creditNoteAttachment({ jobDir, milestoneIndex = 0, issuedDocuments = null }) {
  const meta = await readJobMeta(jobDir);
  const milestone = (meta?.milestoneInvoices || []).find((entry) => Number(entry.milestoneIndex) === Number(milestoneIndex ?? 0));
  const number = milestone?.issuedRevision?.creditNoteNumber || null;
  const note = number ? (milestone.revisionHistory || []).map((entry) => entry.creditNote).find((entry) => entry?.number === number) : null;
  if (!note) throw refused("this invoice was not issued in place of a credited one: there is no adjustment note to attach", 409);
  let bytes = null;
  const file = await readJobFile(jobDir, note.pdfPath, { expectedSha256: note.pdfSha256 });
  if (file.ok) bytes = file.bytes;
  else if (issuedDocuments) {
    const document = await issuedDocuments.findIssuedDocument({ documentType: "credit_note", number });
    if (document) bytes = (await issuedDocuments.readIssuedDocument(document.uid))?.bytes || null;
  }
  if (!bytes) throw refused(`the stored PDF of adjustment note ${number} could not be read`, 410);
  return { filename: `${number}.pdf`, contentType: "application/pdf", buffer: bytes };
}
