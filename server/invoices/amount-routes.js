// Owner routes for legacy invoices whose milestone record and PDFs disagree
// (amount-evidence.js).
//
//   GET  /api/admin/invoices/amount-disagreements
//        Read-only. Every issued invoice whose milestone record disagrees
//        with its stored PDF or with the copy Field emailed, settled ones
//        included: job id, invoice number, both (or all three) sets of
//        amounts, which document each comes from, the quote versions they
//        were drawn from, when it was emailed, and the choices an owner has.
//        Ids, numbers, versions, dates and amounts only.
//          200 { ok, wroteNothing: true, durationMs, summary, invoices }
//          409 another report is still running   504 out of time
//
//   POST /api/admin/invoices/amount-disagreements/settle
//        { jobId, invoiceNumber, choose, total, reason }: the owner picks
//        which set the invoice was issued for ("milestone-record",
//        "stored-pdf" or "sent-copy"), confirming the total they saw, and
//        says why. Recorded on the invoice revision with who and when
//        (settleJobMilestoneInvoiceAmounts). Field never picks one itself.
//          200 { ok, settlement, milestones }   400 missing input
//          404 no such job or invoice   409 already settled, nothing to
//          settle, the total changed, or payments exceed the choice
import { listInvoiceAmountDisagreements } from "./amount-evidence.js";

export const AMOUNT_DISAGREEMENTS_PATH = "/api/admin/invoices/amount-disagreements";
export const AMOUNT_SETTLE_PATH = `${AMOUNT_DISAGREEMENTS_PATH}/settle`;
export const AMOUNT_DISAGREEMENTS_TIMEOUT_MS = 120_000;

const TIMED_OUT = Symbol("timed out");

export function createInvoiceAmountDisagreementsHandler({ dataDir, issuedDocuments = () => null, timeoutMs = AMOUNT_DISAGREEMENTS_TIMEOUT_MS, logger = console }) {
  let running = null;
  return async function invoiceAmountDisagreements(_req, res) {
    if (running) {
      return res.status(409).json({ error: "The invoice amount report is already running. Try again when it has finished.", code: "INVOICE_AMOUNT_REPORT_RUNNING" });
    }
    let stopped = false;
    const started = Date.now();
    const work = Promise.resolve()
      .then(() => listInvoiceAmountDisagreements({
        dataDir: typeof dataDir === "function" ? dataDir() : dataDir,
        issuedDocuments: issuedDocuments(),
        onJob: () => {
          if (stopped) throw Object.assign(new Error("stopped (time limit)"), { code: "INVOICE_AMOUNT_REPORT_ABORTED" });
        },
      }))
      .then((report) => ({ report }), (error) => ({ error }));
    running = work.finally(() => { running = null; });
    let timer = null;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
    try {
      const outcome = await Promise.race([work, deadline]);
      if (outcome === TIMED_OUT) {
        stopped = true;
        return res.status(504).json({ error: `The report did not finish within ${Math.round(timeoutMs / 1000)} s. Try again shortly.`, code: "INVOICE_AMOUNT_REPORT_TIMEOUT", wroteNothing: true });
      }
      if (outcome.error) {
        logger.error?.(`[invoice-amounts] the report could not run: ${outcome.error.message}`);
        return res.status(500).json({ error: "The report could not run. The server log has the reason.", code: "INVOICE_AMOUNT_REPORT_FAILED", wroteNothing: true });
      }
      const { summary, invoices } = outcome.report;
      return res.json({ ok: true, wroteNothing: true, durationMs: Date.now() - started, summary, invoices });
    } finally {
      clearTimeout(timer);
    }
  };
}

const CHOICES = new Set(["milestone-record", "stored-pdf", "sent-copy"]);

/**
 * `findJob(id)` resolves a job ({ dir, meta }) or null; `settle(job, input,
 * req)` runs the settle action as a committed job generation and resolves to
 * its result.
 */
export function createInvoiceAmountSettleHandler({ findJob, settle }) {
  return async function settleInvoiceAmounts(req, res) {
    const body = req.body || {};
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    const invoiceNumber = typeof body.invoiceNumber === "string" ? body.invoiceNumber.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const missing = [!jobId && "jobId", !invoiceNumber && "invoiceNumber", !CHOICES.has(body.choose) && "choose", (body.total == null || body.total === "") && "total", !reason && "reason"].filter(Boolean);
    if (missing.length) {
      return res.status(400).json({ error: `${missing.join(", ")} required; choose is one of ${[...CHOICES].join(", ")} and total is the total of the set you chose`, code: "INVOICE_AMOUNT_SETTLE_INVALID" });
    }
    const job = await findJob(jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    try {
      const result = await settle(job, { invoiceNumber, choose: body.choose, total: body.total, reason }, req);
      return res.json({ ok: true, settlement: result.settlement, milestones: result.milestoneInvoices || [] });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  };
}
