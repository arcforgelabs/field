// Issued invoices to the owner's Xero (#93, phase 1).
//
// The outbox is the invoice rows themselves, as for the R2 replica
// (documents/replicator.js): issuing never waits on Xero and never writes
// anything for it. After an issue commits, the sync is told (`kick`); a
// scheduler tick also runs every minute. Each pass:
//
//   1. queues every invoice issued since Create in Xero was turned on
//      (`auto_from`) that is not queued yet: a `xero_invoice_syncs` row,
//      `pending`, with the mode (draft or approved) at that moment. A restart
//      loses nothing: the next pass finds the same invoices;
//   2. sends what is due, one invoice at a time.
//
// Sending one invoice (syncInvoice):
//
//   a. an invoice credited or voided before it reached Xero is skipped (credit
//      notes are phase 2);
//   b. Xero is asked for an invoice with this number first, so a retry after
//      Xero's idempotency window (6 minutes) still never makes a second one;
//   c. the contact: found by the customer's email, else by name, else created;
//   d. the invoice is created (invoice-payload.js) with an Idempotency-Key
//      derived from Field's invoice uid and what is sent;
//   e. its Xero id and status are stored at once, on the sync row and on the
//      Field invoice row (migration 0018);
//   f. Field's issued PDF, the stored bytes, is attached;
//   g. Xero's totals are compared with Field's to the cent. A difference is
//      `mismatch`, shown to the owner.
//
// A failure is retryable (Xero unreachable, 5xx, 429, a token that needed
// refreshing) or not (Xero refused what was sent, a PDF over Xero's limit).
// Retryable ones back off 1, 2, 4 ... minutes up to an hour, at least as long
// as Xero's Retry-After, and give up after `maxAttempts` as `failed`. While
// the owner must connect again, invoices wait as they are. An owner can retry
// any of them, and send invoices issued before the connection after a
// preview.
//
// Logs carry the invoice uid and a code, never a number, a customer or an
// amount, and never a token.
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { XeroError } from "./client.js";
import { XeroPayloadError, attachmentFileName, buildXeroInvoice, cents, contactFor, totalsMatch, xeroReference } from "./invoice-payload.js";

const { invoices, invoiceLines, issuedDocuments, quotes, xeroInvoiceSyncs } = schema;

export const XERO_SYNC_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  firstDelayMs: 20_000,
  kickDelayMs: 1_500,
  batchSize: 10,
  backoffBaseMs: 60_000,
  backoffMaxMs: 60 * 60_000,
  maxAttempts: 8,
  /** Xero's attachment limit (Attachments API). */
  maxAttachmentBytes: 10 * 1024 * 1024,
});

/** Delay before attempt n+1 after n failed attempts: 1, 2, 4 ... minutes, at most an hour. */
export function syncBackoffMs(attempts, { backoffBaseMs = XERO_SYNC_DEFAULTS.backoffBaseMs, backoffMaxMs = XERO_SYNC_DEFAULTS.backoffMaxMs } = {}) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(n - 1, 30));
}

const SENDABLE = ["issued", "paid"];

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function codeOf(error) {
  const code = String(error?.code || "");
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "XERO_SYNC_ERROR";
}

function money(value) {
  return `$${(cents(value) / 100).toFixed(2)}`;
}

function short(text, max = 400) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The label the invoice shows for its Xero state. */
export function xeroStateLabel(row) {
  if (!row) return "Not sent to Xero";
  if (row.state === "pending") return row.lastErrorCode === "XERO_NOT_CONNECTED" ? "Waiting for Xero" : "Sending to Xero";
  if (row.state === "failed") return "Xero failed";
  if (row.state === "skipped") return "Not sent to Xero";
  if (row.state === "mismatch") return "In Xero, totals differ";
  switch (row.xeroStatus) {
    case "AUTHORISED": return "Approved in Xero";
    case "PAID": return "Paid in Xero";
    case "SUBMITTED": return "Awaiting approval in Xero";
    case "VOIDED":
    case "DELETED": return "Voided in Xero";
    default: return "Xero draft created";
  }
}

/**
 * `connection` is the connection service (connection.js); `http()` the Xero
 * client (client.js) for the configured secrets; `blobs` the issued
 * document byte store.
 */
export function createXeroInvoiceSync({
  db,
  orgUid = undefined,
  connection,
  http,
  blobs,
  now = () => new Date(),
  logger = console,
  ...options
}) {
  if (!db || !connection || typeof http !== "function" || !blobs) throw new Error("the Xero invoice sync needs a database, the connection, an HTTP client and the byte store");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);
  const settings = { ...XERO_SYNC_DEFAULTS, ...options };
  const inflight = new Map();
  let ticking = null;
  let timer = null;
  let firstTimer = null;
  let kickTimer = null;
  let stopped = false;
  const counts = { created: 0, failed: 0, mismatched: 0, lastErrorCode: null, lastSuccessAt: null };

  const tx = (fn) => scope.transaction(fn);

  async function readSync(invoiceUid) {
    return tx(async (inner) => (await inner.select().from(xeroInvoiceSyncs).where(eq(xeroInvoiceSyncs.invoiceUid, invoiceUid)))[0] || null);
  }

  async function writeSync(invoiceUid, values) {
    await tx((inner) => inner.update(xeroInvoiceSyncs).set({ ...values, updatedAt: now() }).where(eq(xeroInvoiceSyncs.invoiceUid, invoiceUid)));
  }

  // Everything the Xero invoice is built from, read in one transaction.
  async function loadInvoice(invoiceUid) {
    return tx(async (inner) => {
      const [invoice] = await inner.select().from(invoices).where(eq(invoices.uid, invoiceUid));
      if (!invoice) return null;
      const lines = await inner.select().from(invoiceLines).where(eq(invoiceLines.invoiceUid, invoiceUid)).orderBy(asc(invoiceLines.sortOrder));
      const [document] = invoice.issuedDocumentUid ? await inner.select().from(issuedDocuments).where(eq(issuedDocuments.uid, invoice.issuedDocumentUid)) : [];
      let [quote] = invoice.quoteUid ? await inner.select().from(quotes).where(eq(quotes.uid, invoice.quoteUid)) : [];
      if (!quote && Number(invoice.quoteVersion) > 0) {
        [quote] = await inner.select().from(quotes).where(and(eq(quotes.jobId, invoice.jobId), eq(quotes.version, Number(invoice.quoteVersion))));
      }
      return { invoice, lines, document: document || null, quote: quote || null };
    });
  }

  async function pdfBytes(document) {
    if (!document?.pdfSha256) return null;
    return tx((inner) => blobs.get(document.pdfSha256, { tx: inner, orgUid: scope.orgUid }));
  }

  // The contact: by email, else by name (Xero's searchTerm, matched exactly
  // here), else created. Xero refuses a second contact with the same name, so
  // a refused create looks the name up again.
  async function contactId(client, token, customer, invoiceUid) {
    const search = async (term) => {
      const found = await client.accounting({ ...token, path: "/Contacts", query: { searchTerm: term, summaryOnly: "true" } });
      return Array.isArray(found?.Contacts) ? found.Contacts : [];
    };
    const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    if (customer.email) {
      const byEmail = (await search(customer.email)).find((contact) => same(contact.EmailAddress, customer.email) && contact.ContactStatus !== "ARCHIVED");
      if (byEmail) return byEmail.ContactID;
    }
    const byName = async () => (await search(customer.name)).find((contact) => same(contact.Name, customer.name));
    const named = await byName();
    if (named) return named.ContactID;
    const body = { Contacts: [{ Name: customer.name, ...(customer.email ? { EmailAddress: customer.email } : {}) }] };
    try {
      const created = await client.accounting({ ...token, method: "PUT", path: "/Contacts", json: body, idempotencyKey: idempotencyKey(invoiceUid, "contact", body) });
      const id = created?.Contacts?.[0]?.ContactID;
      if (!id) throw new XeroError("XERO_CONTACT_NOT_CREATED", "Xero did not return the new contact.", { retryable: true });
      return id;
    } catch (error) {
      if (error?.code !== "XERO_VALIDATION") throw error;
      const again = await byName();
      if (again) return again.ContactID;
      throw error;
    }
  }

  function idempotencyKey(invoiceUid, step, body) {
    const digest = createHash("sha256").update(typeof body === "string" ? body : JSON.stringify(body)).digest("hex").slice(0, 16);
    return `field-${invoiceUid}-${step}-${digest}`;
  }

  async function findByNumber(client, token, number) {
    const found = await client.accounting({ ...token, path: "/Invoices", query: { InvoiceNumbers: number } });
    return (found?.Invoices || []).find((entry) => entry.InvoiceNumber === number && entry.Type === "ACCREC" && !["DELETED", "VOIDED"].includes(entry.Status)) || null;
  }

  async function getInvoice(client, token, invoiceId) {
    const found = await client.accounting({ ...token, path: `/Invoices/${encodeURIComponent(invoiceId)}` });
    return found?.Invoices?.[0] || null;
  }

  async function recordCreated(invoiceUid, xeroInvoice, contact = null) {
    const values = {
      xeroInvoiceId: xeroInvoice.InvoiceID,
      xeroStatus: xeroInvoice.Status || null,
      xeroTotal: xeroInvoice.Total == null ? null : (cents(xeroInvoice.Total) / 100).toFixed(2),
      ...(contact ? { xeroContactId: contact } : {}),
    };
    await tx(async (inner) => {
      await inner.update(xeroInvoiceSyncs).set({ ...values, createdInXeroAt: sql`coalesce(${xeroInvoiceSyncs.createdInXeroAt}, ${now().toISOString()}::timestamptz)`, updatedAt: now() }).where(eq(xeroInvoiceSyncs.invoiceUid, invoiceUid));
      await inner.update(invoices).set({ xeroInvoiceId: xeroInvoice.InvoiceID, xeroStatus: xeroInvoice.Status || null }).where(eq(invoices.uid, invoiceUid));
    });
  }

  // One invoice, start to finish. Returns { outcome, code? }.
  async function syncOnce(invoiceUid) {
    const sync = await readSync(invoiceUid);
    if (!sync || !["pending"].includes(sync.state)) return { invoiceUid, outcome: sync?.state || "unknown" };
    const at = now();
    await writeSync(invoiceUid, { lastAttemptAt: at });
    try {
      const loaded = await loadInvoice(invoiceUid);
      if (!loaded) throw new XeroPayloadError("XERO_INVOICE_MISSING", "The invoice is no longer in Field.");
      const { invoice, lines, document, quote } = loaded;
      if (!invoice.xeroInvoiceId && !sync.xeroInvoiceId && !SENDABLE.includes(invoice.status)) {
        await writeSync(invoiceUid, { state: "skipped", lastErrorCode: "XERO_NOT_ISSUED", lastErrorReason: invoice.status === "credited" || invoice.status === "void" ? "It was credited or voided in Field before it reached Xero. Credit notes go to Xero in a later phase." : "It is not issued.", nextAttemptAt: null });
        return { invoiceUid, outcome: "skipped" };
      }
      const state = await connection.state();
      if (state.status !== "connected") {
        await writeSync(invoiceUid, { lastErrorCode: "XERO_NOT_CONNECTED", lastErrorReason: "Waiting for Xero to be connected again (Settings, Integrations, Xero).", nextAttemptAt: null });
        return { invoiceUid, outcome: "waiting" };
      }
      const client = http();
      const result = await connection.withAccessToken(async (token) => {
        let xeroInvoice = null;
        let contact = sync.xeroContactId || null;
        const known = sync.xeroInvoiceId || invoice.xeroInvoiceId;
        if (known) xeroInvoice = await getInvoice(client, token, known);
        if (!xeroInvoice) xeroInvoice = await findByNumber(client, token, invoice.number);
        if (!xeroInvoice) {
          const customer = contactFor({ details: document?.details || null, quoteCustomer: quote?.customer || null });
          contact = contact || await contactId(client, token, customer, invoiceUid);
          await writeSync(invoiceUid, { xeroContactId: contact });
          const body = {
            Invoices: [buildXeroInvoice({
              invoice,
              lines,
              contactId: contact,
              reference: xeroReference({ jobReference: invoice.reference, quoteNumber: quote?.number, quoteVersion: invoice.quoteVersion ?? quote?.version }),
              settings: { salesAccountCode: state.salesAccountCode, taxType: state.taxType },
              mode: sync.mode,
            })],
          };
          const created = await client.accounting({ ...token, method: "PUT", path: "/Invoices", query: { unitdp: 4 }, json: body, idempotencyKey: idempotencyKey(invoiceUid, "invoice", body) });
          xeroInvoice = created?.Invoices?.[0] || null;
          if (!xeroInvoice?.InvoiceID) throw new XeroError("XERO_INVOICE_NOT_CREATED", "Xero did not return the new invoice.", { retryable: true });
        }
        await recordCreated(invoiceUid, xeroInvoice, contact);

        if (!sync.attachedAt) {
          const bytes = await pdfBytes(document);
          if (!bytes) throw new XeroPayloadError("XERO_PDF_MISSING", "Field could not read the invoice's issued PDF, so it was not attached in Xero.");
          if (bytes.length > settings.maxAttachmentBytes) throw new XeroPayloadError("XERO_PDF_TOO_LARGE", "The invoice's PDF is larger than Xero's 10 MB attachment limit, so it was not attached.");
          const name = attachmentFileName(invoice.number);
          await client.accounting({ ...token, method: "PUT", path: `/Invoices/${encodeURIComponent(xeroInvoice.InvoiceID)}/Attachments/${encodeURIComponent(name)}`, query: { IncludeOnline: "true" }, body: bytes, contentType: "application/pdf", idempotencyKey: idempotencyKey(invoiceUid, "pdf", document.pdfSha256) });
          await writeSync(invoiceUid, { attachedAt: now() });
        }
        return { invoice, xeroInvoice };
      });

      const { invoice: fieldInvoice, xeroInvoice } = result;
      if (totalsMatch(fieldInvoice, xeroInvoice)) {
        await writeSync(invoiceUid, { state: "created", fieldTotal: fieldInvoice.total, lastErrorCode: null, lastErrorReason: null, nextAttemptAt: null });
        counts.created += 1;
        counts.lastSuccessAt = iso(now());
        return { invoiceUid, outcome: "created" };
      }
      const reason = `Xero's totals differ from Field's: Xero ${money(xeroInvoice.SubTotal)} + GST ${money(xeroInvoice.TotalTax)} = ${money(xeroInvoice.Total)}; Field ${money(fieldInvoice.subtotal)} + GST ${money(fieldInvoice.taxTotal)} = ${money(fieldInvoice.total)}. Check the invoice in Xero.`;
      await writeSync(invoiceUid, { state: "mismatch", fieldTotal: fieldInvoice.total, lastErrorCode: "XERO_TOTALS_DIFFER", lastErrorReason: reason, nextAttemptAt: null });
      counts.mismatched += 1;
      logger.warn?.(`[xero] invoice ${invoiceUid}: Xero's totals differ from Field's (XERO_TOTALS_DIFFER); shown to the owner`);
      return { invoiceUid, outcome: "mismatch" };
    } catch (error) {
      return failed(invoiceUid, error);
    }
  }

  async function failed(invoiceUid, error) {
    const code = codeOf(error);
    counts.lastErrorCode = code;
    const current = await readSync(invoiceUid);
    const attempts = Number(current?.attempts || 0) + 1;
    if (error?.reconnect) {
      // The connection is marked by the token refresh; an API refusal marks it here.
      if (["XERO_FORBIDDEN", "XERO_SCOPE_MISSING"].includes(code)) await connection.markNeedsReconnect?.(code);
      await writeSync(invoiceUid, { lastErrorCode: "XERO_NOT_CONNECTED", lastErrorReason: short(error.reason || "Waiting for Xero to be connected again."), nextAttemptAt: null });
      logger.warn?.(`[xero] invoice ${invoiceUid} waits for the owner to connect Xero again (${code})`);
      return { invoiceUid, outcome: "waiting", code };
    }
    const retryable = Boolean(error?.retryable) || !(error instanceof XeroError || error instanceof XeroPayloadError);
    const reason = short(error?.reason || "Field could not send it to Xero. It tries again by itself.");
    if (retryable && attempts < settings.maxAttempts) {
      const wait = Math.max(syncBackoffMs(attempts, settings), Number(error?.retryAfterMs) || 0);
      await writeSync(invoiceUid, { attempts, lastErrorCode: code, lastErrorReason: reason, nextAttemptAt: new Date(now().getTime() + wait) });
      logger.warn?.(`[xero] invoice ${invoiceUid} not in Xero yet (${code}); retried in ${Math.round(wait / 1000)} s`);
      return { invoiceUid, outcome: "retry", code };
    }
    await writeSync(invoiceUid, { state: "failed", attempts, lastErrorCode: code, lastErrorReason: retryable ? `${reason} Field stopped after ${attempts} tries; press Retry.` : reason, nextAttemptAt: null });
    counts.failed += 1;
    logger.warn?.(`[xero] invoice ${invoiceUid} failed in Xero (${code}); shown to the owner`);
    return { invoiceUid, outcome: "failed", code };
  }

  /** Send one queued invoice now (one at a time per invoice). */
  function syncInvoice(invoiceUid) {
    if (inflight.has(invoiceUid)) return inflight.get(invoiceUid);
    const run = syncOnce(invoiceUid).finally(() => inflight.delete(invoiceUid));
    inflight.set(invoiceUid, run);
    return run;
  }

  // Invoices issued since Create in Xero was turned on, not queued yet.
  async function queueNewlyIssued(state) {
    if (state.status !== "connected" || state.createMode === "off" || !state.autoFrom) return 0;
    return tx(async (inner) => {
      const at = now();
      const rows = await inner.select({ uid: invoices.uid }).from(invoices)
        .leftJoin(xeroInvoiceSyncs, and(eq(xeroInvoiceSyncs.orgUid, invoices.orgUid), eq(xeroInvoiceSyncs.invoiceUid, invoices.uid)))
        .where(and(
          isNull(xeroInvoiceSyncs.invoiceUid),
          isNull(invoices.xeroInvoiceId),
          inArray(invoices.status, SENDABLE),
          gte(invoices.issuedAt, new Date(state.autoFrom)),
        ));
      if (!rows.length) return 0;
      await inner.insert(xeroInvoiceSyncs)
        .values(rows.map(({ uid }) => ({ invoiceUid: uid, state: "pending", mode: state.createMode, queuedBy: "auto", queuedAt: at, createdAt: at, updatedAt: at })))
        .onConflictDoNothing();
      return rows.length;
    });
  }

  async function due() {
    return tx((inner) => inner.select({ uid: xeroInvoiceSyncs.invoiceUid }).from(xeroInvoiceSyncs)
      .where(and(eq(xeroInvoiceSyncs.state, "pending"), or(isNull(xeroInvoiceSyncs.nextAttemptAt), lte(xeroInvoiceSyncs.nextAttemptAt, now()))))
      .orderBy(asc(xeroInvoiceSyncs.queuedAt), asc(xeroInvoiceSyncs.invoiceUid))
      .limit(settings.batchSize));
  }

  /** One pass: queue what was issued, then send what is due. Never throws. */
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const results = [];
      try {
        const state = await connection.state();
        await queueNewlyIssued(state);
        if (state.status !== "connected") return results;
        for (const { uid } of await due()) {
          if (stopped) break;
          const result = await syncInvoice(uid);
          results.push(result);
          // Xero is down, slowing us, or needs the owner: stop this pass.
          if (result.outcome === "waiting" || ["XERO_RATE_LIMITED", "XERO_UNREACHABLE", "XERO_TIMEOUT", "XERO_UNAVAILABLE"].includes(result.code)) break;
        }
      } catch (error) {
        counts.lastErrorCode = codeOf(error);
        logger.warn?.(`[xero] the invoice sync pass failed (${codeOf(error)}); it runs again on the next tick`);
      }
      return results;
    })().finally(() => { ticking = null; });
    return ticking;
  }

  /** Candidates an owner may send: issued or paid, not in Xero and not queued. */
  async function candidates({ invoiceUids = null, issuedSince = null } = {}) {
    return tx(async (inner) => {
      const conditions = [inArray(invoices.status, SENDABLE), isNull(invoices.xeroInvoiceId), sql`${invoices.issuedAt} is not null`];
      if (Array.isArray(invoiceUids)) conditions.push(inArray(invoices.uid, invoiceUids.length ? invoiceUids : ["-"]));
      if (issuedSince) conditions.push(gte(invoices.issuedAt, issuedSince));
      const rows = await inner.select({ invoice: invoices, sync: xeroInvoiceSyncs, document: issuedDocuments }).from(invoices)
        .leftJoin(xeroInvoiceSyncs, and(eq(xeroInvoiceSyncs.orgUid, invoices.orgUid), eq(xeroInvoiceSyncs.invoiceUid, invoices.uid)))
        .leftJoin(issuedDocuments, and(eq(issuedDocuments.orgUid, invoices.orgUid), eq(issuedDocuments.uid, invoices.issuedDocumentUid)))
        .where(and(...conditions))
        .orderBy(asc(invoices.issuedAt))
        .limit(200);
      return rows.filter(({ sync }) => !sync || ["skipped", "failed"].includes(sync.state) && !sync.xeroInvoiceId);
    });
  }

  function previewRow({ invoice, sync, document }, mode) {
    let customer = null;
    try {
      customer = contactFor({ details: document?.details || null }).name;
    } catch {}
    return {
      invoiceUid: invoice.uid,
      jobId: invoice.jobId,
      number: invoice.number,
      reference: invoice.reference,
      customer,
      issuedAt: iso(invoice.issuedAt),
      total: invoice.total,
      status: invoice.status,
      creates: mode === "authorised" ? "Approved invoice" : "Draft invoice",
      previously: sync ? xeroStateLabel(sync) : null,
      problem: !invoice.issuedDocumentUid ? "Its issued PDF is not stored, so it cannot be attached." : (customer ? null : "It has no customer name or email for the Xero contact."),
    };
  }

  // What an owner's push creates: the mode now, and Draft while Create in Xero is off.
  function pushMode(state) {
    return state.createMode === "authorised" ? "authorised" : "draft";
  }

  return {
    enabled: true,
    tick,
    syncInvoice,

    /** After an issue commits: send soon, without blocking. Never throws. */
    kick() {
      if (stopped || kickTimer) return;
      kickTimer = setTimeout(() => { kickTimer = null; void tick(); }, settings.kickDelayMs);
      kickTimer.unref?.();
    },

    /** What sending these invoices (or those issued since a date) would create. Writes nothing. */
    async preview({ invoiceUids = null, issuedSince = null } = {}) {
      const state = await connection.state();
      const mode = pushMode(state);
      const rows = await candidates({ invoiceUids, issuedSince });
      return { connected: state.status === "connected", mode, organisation: null, invoices: rows.map((row) => previewRow(row, mode)) };
    },

    /** Queue these invoices for Xero (an owner's choice, after the preview). */
    async push({ invoiceUids, actor = null }) {
      const state = await connection.state();
      if (state.status !== "connected") throw Object.assign(new Error("Connect Xero first (Settings, Integrations, Xero)."), { statusCode: 409, code: "XERO_NOT_CONNECTED" });
      const mode = pushMode(state);
      const rows = (await candidates({ invoiceUids })).filter((row) => row.invoice.issuedDocumentUid);
      const at = now();
      await tx(async (inner) => {
        for (const { invoice } of rows) {
          const values = { state: "pending", mode, queuedBy: "owner", requestedBy: actor, queuedAt: at, attempts: 0, nextAttemptAt: null, lastErrorCode: null, lastErrorReason: null, updatedAt: at };
          await inner.insert(xeroInvoiceSyncs).values({ invoiceUid: invoice.uid, ...values, createdAt: at })
            .onConflictDoUpdate({ target: [xeroInvoiceSyncs.orgUid, xeroInvoiceSyncs.invoiceUid], set: values });
        }
      });
      this.kick();
      return { queued: rows.map(({ invoice }) => invoice.uid), mode };
    },

    /** An owner's Retry: send it again now, from where it stopped. */
    async retry({ invoiceUid, actor = null }) {
      const current = await readSync(invoiceUid);
      if (!current) return this.push({ invoiceUids: [invoiceUid], actor });
      if (!["failed", "mismatch", "pending", "skipped"].includes(current.state)) {
        throw Object.assign(new Error("This invoice is already in Xero."), { statusCode: 409, code: "XERO_ALREADY_CREATED" });
      }
      await writeSync(invoiceUid, { state: "pending", attempts: 0, nextAttemptAt: null, lastErrorCode: null, lastErrorReason: null, requestedBy: actor });
      this.kick();
      return { queued: [invoiceUid] };
    },

    /** Each invoice of a job, by number: its Xero state for the Invoices tab. */
    async jobStatus(jobId) {
      const state = await connection.state();
      const rows = await tx((inner) => inner.select({ invoice: invoices, sync: xeroInvoiceSyncs }).from(invoices)
        .leftJoin(xeroInvoiceSyncs, and(eq(xeroInvoiceSyncs.orgUid, invoices.orgUid), eq(xeroInvoiceSyncs.invoiceUid, invoices.uid)))
        .where(eq(invoices.jobId, String(jobId))));
      const byNumber = {};
      for (const { invoice, sync } of rows) {
        if (invoice.status === "draft") continue;
        byNumber[invoice.number] = {
          invoiceUid: invoice.uid,
          state: sync?.state || "not-sent",
          label: xeroStateLabel(sync),
          xeroStatus: sync?.xeroStatus || invoice.xeroStatus || null,
          reason: sync && sync.state !== "created" ? sync.lastErrorReason || null : null,
          nextAttemptAt: sync?.state === "pending" ? iso(sync.nextAttemptAt) : null,
          canRetry: Boolean(sync && ["failed", "mismatch"].includes(sync.state)),
          canSend: !sync && !invoice.xeroInvoiceId && SENDABLE.includes(invoice.status),
        };
      }
      return { connected: state.status === "connected", connection: state.status, createMode: state.createMode, invoices: byNumber };
    },

    /** For GET /api/storage/status (owner). Counts and codes only. */
    async status() {
      const [row] = await tx((inner) => inner.select({
        pending: sql`count(*) filter (where ${xeroInvoiceSyncs.state} = 'pending')`.mapWith(Number),
        failed: sql`count(*) filter (where ${xeroInvoiceSyncs.state} = 'failed')`.mapWith(Number),
        mismatch: sql`count(*) filter (where ${xeroInvoiceSyncs.state} = 'mismatch')`.mapWith(Number),
        created: sql`count(*) filter (where ${xeroInvoiceSyncs.state} = 'created')`.mapWith(Number),
      }).from(xeroInvoiceSyncs));
      return { enabled: true, ...row, lastErrorCode: counts.lastErrorCode, lastSuccessAt: counts.lastSuccessAt };
    },

    start({ firstDelayMs = settings.firstDelayMs } = {}) {
      if (timer || stopped) return;
      firstTimer = setTimeout(() => { void tick(); }, firstDelayMs);
      firstTimer.unref?.();
      timer = setInterval(() => { void tick(); }, settings.intervalMs);
      timer.unref?.();
    },

    async stop() {
      stopped = true;
      for (const handle of [timer, firstTimer, kickTimer]) if (handle) clearTimeout(handle);
      if (timer) clearInterval(timer);
      timer = null;
      firstTimer = null;
      kickTimer = null;
      while (ticking || inflight.size) await Promise.allSettled([ticking, ...inflight.values()]);
    },

    /** Resolves when nothing is running (tests). */
    async idle() {
      while (ticking || inflight.size || kickTimer) {
        if (kickTimer && !ticking && !inflight.size) await new Promise((wake) => setTimeout(wake, 20));
        await Promise.allSettled([ticking, ...inflight.values()]);
      }
    },
  };
}
