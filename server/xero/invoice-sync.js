// Issued invoices to the owner's Xero (#93, phase 1).
//
// The outbox is the invoice rows themselves, as for the R2 replica
// (documents/replicator.js): issuing never waits on Xero and never writes
// anything for it. After an issue commits, the sync is told (`kick`); a
// scheduler tick also runs every minute. Each pass:
//
//   1. queues every invoice issued since Create in Xero was turned on
//      (`auto_from`) that is not queued yet: a `xero_invoice_syncs` row,
//      `pending`, for the connected Xero organisation (`tenant_id`), with the
//      mode (draft or approved) at that moment. A restart loses nothing: the
//      next pass finds the same invoices;
//   2. holds what was queued for another organisation than the connected one
//      (`held`): it is never sent to the new organisation by itself;
//   3. sends what is due, one invoice at a time. While Create in Xero is Off,
//      invoices it queued by itself wait; ones an owner sent still go.
//
// A worker claims each row with a lease (`lease_owner`, `lease_until`), and
// every write it makes names its lease, so two servers (an overlapping
// republish) never send the same invoice, and a late worker never overwrites
// another's result.
//
// Sending one invoice (syncOnce):
//
//   a. an invoice credited or voided before it reached Xero is skipped (credit
//      notes are phase 2);
//   b. the Xero invoice it already has in this organisation is read; failing
//      that, Xero is asked for an invoice with this number, so a retry after
//      Xero's idempotency window (6 minutes) still never makes a second one;
//   c. the contact: the one found before, else by the customer's email, else
//      by name, else created. A contact Xero no longer accepts (removed,
//      archived, merged) is looked up again once;
//   d. the invoice is created as a DRAFT with an Idempotency-Key derived from
//      Field's invoice uid and what is sent;
//   e. its Xero id, organisation and status are stored at once, on the sync
//      row, on the Field invoice row and in xero_invoice_links;
//   f. Field's issued PDF, the stored bytes, is attached;
//   g. Xero's totals are compared with Field's to the cent. A difference is
//      `mismatch` and the invoice stays a draft. In Approved mode, a draft
//      whose totals match is then approved (AUTHORISED), and checked again.
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
import { hostname } from "node:os";
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { invoiceQuoteNumber } from "../invoices/customer-wording.js";
import { XeroError } from "./client.js";
import { XeroPayloadError, attachmentFileName, buildXeroInvoice, cents, contactFor, totalsMatch, xeroReference } from "./invoice-payload.js";

const { invoices, invoiceLines, issuedDocuments, quotes, xeroInvoiceSyncs, xeroInvoiceLinks } = schema;

export const XERO_SYNC_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  firstDelayMs: 20_000,
  kickDelayMs: 1_500,
  batchSize: 10,
  backoffBaseMs: 60_000,
  backoffMaxMs: 60 * 60_000,
  maxAttempts: 8,
  /** How long a worker's claim on an invoice holds (longer than any one send takes). */
  leaseMs: 5 * 60_000,
  /** Xero's attachment limit (Attachments API). */
  maxAttachmentBytes: 10 * 1024 * 1024,
});

/** Delay before attempt n+1 after n failed attempts: 1, 2, 4 ... minutes, at most an hour. */
export function syncBackoffMs(attempts, { backoffBaseMs = XERO_SYNC_DEFAULTS.backoffBaseMs, backoffMaxMs = XERO_SYNC_DEFAULTS.backoffMaxMs } = {}) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(n - 1, 30));
}

// Sync instances made in this process, for distinct worker ids.
let instances = 0;

const SENDABLE = ["issued", "paid"];
const GONE_IN_FIELD = ["credited", "void"];
const GONE_IN_XERO = ["VOIDED", "DELETED"];
const OUTAGE = ["XERO_RATE_LIMITED", "XERO_UNREACHABLE", "XERO_TIMEOUT", "XERO_UNAVAILABLE"];
// Xero's refusal of a second invoice with the same number ("Invoice # must be unique").
const NUMBER_TAKEN = /invoice\s*(#|number)[^.]*unique|unique[^.]*invoice\s*(#|number)/i;

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
  if (row.state === "pending") return ["XERO_NOT_CONNECTED", "XERO_CODES_INVALID", "XERO_CREATE_OFF"].includes(row.lastErrorCode) ? "Waiting for Xero" : "Sending to Xero";
  if (row.state === "failed") return "Xero failed";
  if (row.state === "skipped") return row.lastErrorCode === "XERO_VOIDED_IN_XERO" ? "Voided in Xero" : "Not sent to Xero";
  if (row.state === "held") return "Held: another Xero organisation";
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
  // No random draw at boot: the quote/invoice proof seeds the random source, and
  // drawing from it here would shift every id it makes after.
  workerId = `xero-sync-${hostname()}-${process.pid}-${Math.round(performance.timeOrigin)}-${(instances += 1)}`,
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
  const mine = (invoiceUid) => and(eq(xeroInvoiceSyncs.invoiceUid, invoiceUid), eq(xeroInvoiceSyncs.leaseOwner, workerId));

  async function readSync(invoiceUid) {
    return tx(async (inner) => (await inner.select().from(xeroInvoiceSyncs).where(eq(xeroInvoiceSyncs.invoiceUid, invoiceUid)))[0] || null);
  }

  // Writes while this worker holds the claim. Returns false when it lost it.
  async function writeMine(invoiceUid, values, inner = null) {
    const write = async (t) => (await t.update(xeroInvoiceSyncs).set({ ...values, updatedAt: now() }).where(mine(invoiceUid)).returning({ uid: xeroInvoiceSyncs.invoiceUid })).length > 0;
    return inner ? write(inner) : tx(write);
  }

  // The last write of a send: its result, and the claim let go.
  function finish(invoiceUid, values) {
    return writeMine(invoiceUid, { ...values, leaseOwner: null, leaseUntil: null });
  }

  // Leases run on the database's clock (now()), not this server's, so two
  // servers with skewed clocks agree on when one has expired.
  const leaseEnds = () => sql`now() + make_interval(secs => ${settings.leaseMs / 1000})`;
  const leaseFree = () => or(isNull(xeroInvoiceSyncs.leaseUntil), lte(xeroInvoiceSyncs.leaseUntil, sql`now()`));

  /** Claim a due row for this worker, or null when another holds it or it is not due. */
  async function claim(invoiceUid, tenantId) {
    const at = now();
    return tx(async (inner) => {
      const [row] = await inner.update(xeroInvoiceSyncs)
        .set({ leaseOwner: workerId, leaseUntil: leaseEnds(), lastAttemptAt: at, updatedAt: at })
        .where(and(
          eq(xeroInvoiceSyncs.invoiceUid, invoiceUid),
          eq(xeroInvoiceSyncs.state, "pending"),
          eq(xeroInvoiceSyncs.tenantId, tenantId),
          leaseFree(),
          or(isNull(xeroInvoiceSyncs.nextAttemptAt), lte(xeroInvoiceSyncs.nextAttemptAt, at)),
        ))
        .returning();
      return row || null;
    });
  }

  class LeaseLost extends Error {
    constructor() {
      super("the claim on this invoice was lost");
      this.code = "XERO_LEASE_LOST";
    }
  }

  // Before each Xero call: the claim is renewed, or the send stops, so a slow
  // pass never runs on after its lease expired and another server took it.
  async function renew(invoiceUid) {
    const held = await tx(async (inner) => (await inner.update(xeroInvoiceSyncs).set({ leaseUntil: leaseEnds() }).where(mine(invoiceUid)).returning({ uid: xeroInvoiceSyncs.invoiceUid })).length > 0);
    if (!held) throw new LeaseLost();
  }

  function leasedClient(client, invoiceUid) {
    return { accounting: async (request) => { await renew(invoiceUid); return client.accounting(request); } };
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

  // Field's invoice uid, the step, and a digest of the organisation and what
  // is sent: Xero keeps keys per app, so the same request to another
  // organisation (or another Xero invoice) must not reuse a key.
  function idempotencyKey(invoiceUid, step, tenantId, body) {
    const digest = createHash("sha256").update(`${tenantId}\n${typeof body === "string" ? body : JSON.stringify(body)}`).digest("hex").slice(0, 16);
    return `field-${invoiceUid}-${step}-${digest}`;
  }

  // The contact: by email, else by name (Xero's searchTerm, matched exactly
  // here), else created. Xero refuses a second contact with the same name, so
  // a refused create looks the name up again. Archived contacts are skipped.
  // `refused`: a contact Xero just refused; a new key, so Xero cannot replay
  // the create that returned it.
  async function lookUpContact(client, token, customer, invoiceUid, tenantId, refused = null) {
    const search = async (term) => {
      const found = await client.accounting({ ...token, path: "/Contacts", query: { searchTerm: term, summaryOnly: "true" } });
      return (Array.isArray(found?.Contacts) ? found.Contacts : []).filter((contact) => contact.ContactStatus !== "ARCHIVED");
    };
    const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    if (customer.email) {
      const byEmail = (await search(customer.email)).find((contact) => same(contact.EmailAddress, customer.email));
      if (byEmail) return byEmail.ContactID;
    }
    const byName = async () => (await search(customer.name)).find((contact) => same(contact.Name, customer.name));
    const named = await byName();
    if (named) return named.ContactID;
    const body = { Contacts: [{ Name: customer.name, ...(customer.email ? { EmailAddress: customer.email } : {}) }] };
    try {
      const created = await client.accounting({ ...token, method: "PUT", path: "/Contacts", json: body, idempotencyKey: idempotencyKey(invoiceUid, "contact", tenantId, refused ? { body, refused } : body) });
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

  async function findByNumber(client, token, number) {
    const found = await client.accounting({ ...token, path: "/Invoices", query: { InvoiceNumbers: number } });
    return (found?.Invoices || []).find((entry) => entry.InvoiceNumber === number && entry.Type === "ACCREC" && !GONE_IN_XERO.includes(entry.Status)) || null;
  }

  // The Xero invoice as Xero has it now, voided or deleted included; one Xero
  // no longer finds at all counts as deleted.
  async function getInvoice(client, token, invoiceId) {
    try {
      const found = await client.accounting({ ...token, path: `/Invoices/${encodeURIComponent(invoiceId)}` });
      return found?.Invoices?.[0] || { InvoiceID: invoiceId, Status: "DELETED" };
    } catch (error) {
      if (error?.code === "XERO_NOT_FOUND") return { InvoiceID: invoiceId, Status: "DELETED" };
      throw error;
    }
  }

  // The owner voided or deleted the Xero invoice: its id goes into the
  // history first, and its status onto the invoice row, so the database lets
  // a new draft replace it (migration 0018's trigger). The sync row forgets it.
  async function recordGone(invoiceUid, tenantId, gone) {
    const at = now();
    return tx(async (inner) => {
      const owned = await writeMine(invoiceUid, { xeroInvoiceId: null, xeroStatus: gone.Status, xeroTotal: null, createdInXeroAt: null, attachedAt: null }, inner);
      if (!owned) return false;
      await inner.insert(xeroInvoiceLinks).values({ invoiceUid, tenantId, xeroInvoiceId: gone.InvoiceID, linkedAt: at }).onConflictDoNothing();
      await inner.update(invoices).set({ xeroStatus: gone.Status }).where(and(eq(invoices.uid, invoiceUid), eq(invoices.xeroInvoiceId, gone.InvoiceID)));
      return true;
    });
  }

  // The Xero invoice, on the sync row, the invoice row and in the history.
  async function recordXeroInvoice(invoiceUid, tenantId, xeroInvoice, extra = {}) {
    const at = now();
    return tx(async (inner) => {
      const owned = await writeMine(invoiceUid, {
        xeroInvoiceId: xeroInvoice.InvoiceID,
        xeroStatus: xeroInvoice.Status || null,
        xeroTotal: xeroInvoice.Total == null ? null : (cents(xeroInvoice.Total) / 100).toFixed(2),
        createdInXeroAt: sql`coalesce(${xeroInvoiceSyncs.createdInXeroAt}, ${at.toISOString()}::timestamptz)`,
        ...extra,
      }, inner);
      if (!owned) return false;
      await inner.insert(xeroInvoiceLinks).values({ invoiceUid, tenantId, xeroInvoiceId: xeroInvoice.InvoiceID, linkedAt: at }).onConflictDoNothing();
      await inner.update(invoices).set({ xeroInvoiceId: xeroInvoice.InvoiceID, xeroTenantId: tenantId, xeroStatus: xeroInvoice.Status || null }).where(eq(invoices.uid, invoiceUid));
      return true;
    });
  }

  // Create the draft. A contact found on an earlier try that Xero no longer
  // accepts is forgotten, looked up again, and the draft tried once more.
  // `replacing`: a Xero invoice the owner voided or deleted; a new key, so Xero
  // cannot replay the create that made it.
  async function createDraft({ client, token, row, loaded, state, replacing = null }) {
    const { invoice, lines, document, quote } = loaded;
    const customer = contactFor({ details: document?.details || null, quoteCustomer: quote?.customer || null });
    const build = (contactId) => ({
      Invoices: [buildXeroInvoice({
        invoice,
        lines,
        contactId,
        // The reference the issue recorded and printed; for an invoice issued
        // before that, the same line from the quote row (invoiceQuoteNumber).
        reference: document?.details?.referenceLine
          || xeroReference({ jobReference: invoice.reference, quoteNumber: invoiceQuoteNumber({ quoteRow: quote }), quoteVersion: invoice.quoteVersion ?? quote?.version }),
        settings: { salesAccountCode: state.salesAccountCode, taxType: state.taxType },
        mode: "draft",
      })],
    });
    const send = async (contactId) => {
      const body = build(contactId);
      let created;
      try {
        created = await client.accounting({ ...token, method: "PUT", path: "/Invoices", query: { unitdp: 4 }, json: body, idempotencyKey: idempotencyKey(row.invoiceUid, "invoice", row.tenantId, replacing ? { body, replacing } : body) });
      } catch (error) {
        if (error?.code === "XERO_VALIDATION" && NUMBER_TAKEN.test(error.reason || "")) {
          throw new XeroPayloadError("XERO_INVOICE_NUMBER_TAKEN", `Xero already has an invoice numbered ${invoice.number}, perhaps one that was voided or deleted there, so Field did not create a second. Rename or remove that one in Xero, then press Retry.`);
        }
        throw error;
      }
      const xeroInvoice = created?.Invoices?.[0] || null;
      if (!xeroInvoice?.InvoiceID) throw new XeroError("XERO_INVOICE_NOT_CREATED", "Xero did not return the new invoice.", { retryable: true });
      return { xeroInvoice, contactId };
    };
    const cached = row.xeroContactId || null;
    let refused = null;
    if (cached) {
      try {
        return await send(cached);
      } catch (error) {
        // Only a refusal that names the contact is about the contact.
        if (error?.code !== "XERO_VALIDATION" || !/contact/i.test(error.reason || "")) throw error;
        refused = cached;
        await writeMine(row.invoiceUid, { xeroContactId: null });
        logger.warn?.(`[xero] invoice ${row.invoiceUid}: Xero refused the contact found before; looking it up again`);
      }
    }
    const contactId = await lookUpContact(client, token, customer, row.invoiceUid, row.tenantId, refused);
    await writeMine(row.invoiceUid, { xeroContactId: contactId });
    return send(contactId);
  }

  function mismatchReason(fieldInvoice, xeroInvoice) {
    return `Xero's totals differ from Field's: Xero ${money(xeroInvoice.SubTotal)} + GST ${money(xeroInvoice.TotalTax)} = ${money(xeroInvoice.Total)}; Field ${money(fieldInvoice.subtotal)} + GST ${money(fieldInvoice.taxTotal)} = ${money(fieldInvoice.total)}. Check the invoice in Xero.`;
  }

  // One invoice, start to finish. Returns { outcome, code? }.
  async function syncOnce(invoiceUid) {
    const state = await connection.state();
    if (state.status !== "connected" || !state.tenantId) return { invoiceUid, outcome: "waiting" };
    const row = await claim(invoiceUid, state.tenantId);
    if (!row) return { invoiceUid, outcome: "not-claimed" };
    // Off: what Field queued by itself waits; an owner's send still goes.
    if (row.queuedBy === "auto" && state.createMode === "off") {
      await finish(invoiceUid, { lastErrorCode: "XERO_CREATE_OFF", lastErrorReason: "Create in Xero is Off. It goes when Create in Xero is on again, or when an owner sends it." });
      return { invoiceUid, outcome: "off" };
    }
    // The saved codes are not the organisation's: nothing goes until they are.
    if (state.codesProblem) {
      await finish(invoiceUid, { lastErrorCode: "XERO_CODES_INVALID", lastErrorReason: state.codesMessage || "The sales account or the GST tax type is not one the Xero organisation has. Choose them in Settings, Integrations, Xero.", nextAttemptAt: null });
      return { invoiceUid, outcome: "waiting", code: "XERO_CODES_INVALID" };
    }
    try {
      const loaded = await loadInvoice(invoiceUid);
      if (!loaded) throw new XeroPayloadError("XERO_INVOICE_MISSING", "The invoice is no longer in Field.");
      const { invoice, document } = loaded;
      // The Xero invoice it already has in this organisation; an id from another
      // organisation counts as none.
      const known = row.xeroInvoiceId || (invoice.xeroTenantId === row.tenantId ? invoice.xeroInvoiceId : null);
      if (!known && !SENDABLE.includes(invoice.status)) {
        await finish(invoiceUid, { state: "skipped", lastErrorCode: "XERO_NOT_ISSUED", lastErrorReason: GONE_IN_FIELD.includes(invoice.status) ? "It was credited or voided in Field before it reached Xero. Credit notes go to Xero in a later phase." : "It is not issued.", nextAttemptAt: null });
        return { invoiceUid, outcome: "skipped" };
      }
      const client = leasedClient(http(), invoiceUid);
      const outcome = await connection.withAccessToken(async (token) => {
        let attached = Boolean(row.attachedAt);
        let replacing = null;
        let xeroInvoice = known ? await getInvoice(client, token, known) : null;
        if (xeroInvoice && GONE_IN_XERO.includes(xeroInvoice.Status)) {
          if (!await recordGone(invoiceUid, row.tenantId, xeroInvoice)) return { lost: true };
          // Credited or voided in Field too: both agree now, and nothing is created.
          if (GONE_IN_FIELD.includes(invoice.status)) return { settled: true };
          // Voided or deleted in Xero by the owner: a new draft replaces it.
          logger.warn?.(`[xero] invoice ${invoiceUid}: its Xero invoice was voided or deleted there; a new draft replaces it`);
          replacing = xeroInvoice.InvoiceID;
          xeroInvoice = null;
          attached = false;
        }
        // Credited or voided in Field, and Xero still has it: Field never
        // creates, attaches or approves anything for it. The owner voids it in
        // Xero (the job says so); phase 2 does that itself.
        if (GONE_IN_FIELD.includes(invoice.status)) return { voidNeeded: true };
        if (!xeroInvoice) xeroInvoice = await findByNumber(client, token, invoice.number);
        let contact = row.xeroContactId || null;
        if (!xeroInvoice) ({ xeroInvoice, contactId: contact } = await createDraft({ client, token, row, loaded, state, replacing }));
        if (!await recordXeroInvoice(invoiceUid, row.tenantId, xeroInvoice, contact ? { xeroContactId: contact } : {})) return { lost: true };

        if (!attached) {
          const bytes = await pdfBytes(document);
          if (!bytes) throw new XeroPayloadError("XERO_PDF_MISSING", "Field could not read the invoice's issued PDF, so it was not attached in Xero.");
          if (bytes.length > settings.maxAttachmentBytes) throw new XeroPayloadError("XERO_PDF_TOO_LARGE", "The invoice's PDF is larger than Xero's 10 MB attachment limit, so it was not attached.");
          const name = attachmentFileName(invoice.number);
          await client.accounting({ ...token, method: "PUT", path: `/Invoices/${encodeURIComponent(xeroInvoice.InvoiceID)}/Attachments/${encodeURIComponent(name)}`, query: { IncludeOnline: "true" }, body: bytes, contentType: "application/pdf", idempotencyKey: idempotencyKey(invoiceUid, "pdf", row.tenantId, `${xeroInvoice.InvoiceID}:${document.pdfSha256}`) });
          await writeMine(invoiceUid, { attachedAt: now() });
        }

        // The totals first; only a draft that matches is approved.
        if (!totalsMatch(invoice, xeroInvoice)) return { xeroInvoice, matches: false };
        if (row.mode === "authorised" && xeroInvoice.Status === "DRAFT") {
          const body = { Invoices: [{ InvoiceID: xeroInvoice.InvoiceID, Status: "AUTHORISED" }] };
          const approved = await client.accounting({ ...token, method: "POST", path: `/Invoices/${encodeURIComponent(xeroInvoice.InvoiceID)}`, json: body, idempotencyKey: idempotencyKey(invoiceUid, "approve", row.tenantId, body) });
          xeroInvoice = approved?.Invoices?.[0] || xeroInvoice;
          await recordXeroInvoice(invoiceUid, row.tenantId, xeroInvoice);
        }
        return { xeroInvoice, matches: totalsMatch(invoice, xeroInvoice) };
      });

      if (outcome.lost) return { invoiceUid, outcome: "not-claimed" };
      if (outcome.settled) {
        await finish(invoiceUid, { state: "skipped", lastErrorCode: "XERO_VOIDED_IN_XERO", lastErrorReason: `It was ${invoice.status === "void" ? "voided" : "credited"} in Field and voided in Xero. Nothing more to do.`, nextAttemptAt: null });
        return { invoiceUid, outcome: "skipped" };
      }
      if (outcome.voidNeeded) {
        await finish(invoiceUid, { state: "skipped", lastErrorCode: "XERO_VOID_NEEDED", lastErrorReason: `It was ${invoice.status === "void" ? "voided" : "credited"} in Field after it reached Xero, and Xero still has it. Void it, or credit it, in Xero.`, nextAttemptAt: null });
        return { invoiceUid, outcome: "skipped" };
      }
      const { xeroInvoice, matches } = outcome;
      if (matches) {
        await finish(invoiceUid, { state: "created", fieldTotal: invoice.total, lastErrorCode: null, lastErrorReason: null, nextAttemptAt: null });
        counts.created += 1;
        counts.lastSuccessAt = iso(now());
        return { invoiceUid, outcome: "created" };
      }
      await finish(invoiceUid, { state: "mismatch", fieldTotal: invoice.total, lastErrorCode: "XERO_TOTALS_DIFFER", lastErrorReason: `${mismatchReason(invoice, xeroInvoice)}${row.mode === "authorised" ? " It was left as a draft, not approved." : ""}`, nextAttemptAt: null });
      counts.mismatched += 1;
      logger.warn?.(`[xero] invoice ${invoiceUid}: Xero's totals differ from Field's (XERO_TOTALS_DIFFER); left as a draft and shown to the owner`);
      return { invoiceUid, outcome: "mismatch" };
    } catch (error) {
      if (error instanceof LeaseLost) return { invoiceUid, outcome: "not-claimed", code: error.code };
      return failed(invoiceUid, error);
    }
  }

  async function failed(invoiceUid, error) {
    const code = codeOf(error);
    counts.lastErrorCode = code;
    const current = await readSync(invoiceUid);
    if (current?.leaseOwner !== workerId) return { invoiceUid, outcome: "not-claimed", code };
    const attempts = Number(current.attempts || 0) + 1;
    if (error?.reconnect) {
      // The connection is marked by the token refresh; an API refusal marks it here.
      if (["XERO_FORBIDDEN", "XERO_SCOPE_MISSING"].includes(code)) await connection.markNeedsReconnect?.(code);
      await finish(invoiceUid, { lastErrorCode: "XERO_NOT_CONNECTED", lastErrorReason: short(error.reason || "Waiting for Xero to be connected again."), nextAttemptAt: null });
      logger.warn?.(`[xero] invoice ${invoiceUid} waits for the owner to connect Xero again (${code})`);
      return { invoiceUid, outcome: "waiting", code };
    }
    const retryable = Boolean(error?.retryable) || !(error instanceof XeroError || error instanceof XeroPayloadError);
    const reason = short(error?.reason || "Field could not send it to Xero. It tries again by itself.");
    if (retryable && attempts < settings.maxAttempts) {
      const wait = Math.max(syncBackoffMs(attempts, settings), Number(error?.retryAfterMs) || 0);
      await finish(invoiceUid, { attempts, lastErrorCode: code, lastErrorReason: reason, nextAttemptAt: new Date(now().getTime() + wait) });
      logger.warn?.(`[xero] invoice ${invoiceUid} not in Xero yet (${code}); retried in ${Math.round(wait / 1000)} s`);
      return { invoiceUid, outcome: "retry", code };
    }
    await finish(invoiceUid, { state: "failed", attempts, lastErrorCode: code, lastErrorReason: retryable ? `${reason} Field stopped after ${attempts} tries; press Retry.` : reason, nextAttemptAt: null });
    counts.failed += 1;
    logger.warn?.(`[xero] invoice ${invoiceUid} failed in Xero (${code}); shown to the owner`);
    return { invoiceUid, outcome: "failed", code };
  }

  /** Send one queued invoice now (one at a time per invoice in this process). */
  function syncInvoice(invoiceUid) {
    if (inflight.has(invoiceUid)) return inflight.get(invoiceUid);
    const run = syncOnce(invoiceUid).finally(() => inflight.delete(invoiceUid));
    inflight.set(invoiceUid, run);
    return run;
  }

  // Invoices issued since Create in Xero was turned on, not queued yet.
  async function queueNewlyIssued(state) {
    if (state.status !== "connected" || !state.tenantId || state.createMode === "off" || !state.autoFrom) return 0;
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
        .values(rows.map(({ uid }) => ({ invoiceUid: uid, tenantId: state.tenantId, state: "pending", mode: state.createMode, queuedBy: "auto", queuedAt: at, createdAt: at, updatedAt: at })))
        .onConflictDoNothing();
      return rows.length;
    });
  }

  // Queued for another organisation than the connected one: held, never sent there.
  async function holdOtherOrganisations(state) {
    if (state.status !== "connected" || !state.tenantId) return;
    await tx((inner) => inner.update(xeroInvoiceSyncs).set({
      state: "held",
      lastErrorCode: "XERO_OTHER_ORGANISATION",
      lastErrorReason: `It was queued for another Xero organisation. Xero is now connected to ${state.tenantName || "a different organisation"}, so Field did not send it. Send it again to create it there.`,
      nextAttemptAt: null,
      updatedAt: now(),
    }).where(and(eq(xeroInvoiceSyncs.state, "pending"), ne(xeroInvoiceSyncs.tenantId, state.tenantId))));
  }

  async function due(state) {
    const at = now();
    return tx((inner) => inner.select({ uid: xeroInvoiceSyncs.invoiceUid }).from(xeroInvoiceSyncs)
      .where(and(
        eq(xeroInvoiceSyncs.state, "pending"),
        eq(xeroInvoiceSyncs.tenantId, state.tenantId),
        or(isNull(xeroInvoiceSyncs.nextAttemptAt), lte(xeroInvoiceSyncs.nextAttemptAt, at)),
        leaseFree(),
        ...(state.createMode === "off" ? [eq(xeroInvoiceSyncs.queuedBy, "owner")] : []),
      ))
      .orderBy(asc(xeroInvoiceSyncs.queuedAt), asc(xeroInvoiceSyncs.invoiceUid))
      .limit(settings.batchSize));
  }

  /** One pass: queue what was issued, hold what is for another organisation, send what is due. Never throws. */
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const results = [];
      try {
        const state = await connection.state();
        await queueNewlyIssued(state);
        if (state.status !== "connected" || !state.tenantId) return results;
        await holdOtherOrganisations(state);
        // Not checked yet (Xero could not be read when it was connected): try again.
        if (state.codesProblem === "XERO_CODES_UNCHECKED") {
          await connection.checkCodes?.();
          Object.assign(state, await connection.state());
        }
        if (state.codesProblem) return results;
        for (const { uid } of await due(state)) {
          if (stopped) break;
          const result = await syncInvoice(uid);
          results.push(result);
          // Xero is down, slowing us, or needs the owner: stop this pass.
          if (result.outcome === "waiting" || OUTAGE.includes(result.code)) break;
        }
      } catch (error) {
        counts.lastErrorCode = codeOf(error);
        logger.warn?.(`[xero] the invoice sync pass failed (${codeOf(error)}); it runs again on the next tick`);
      }
      return results;
    })().finally(() => { ticking = null; });
    return ticking;
  }

  // Not in the connected organisation: no Xero id there, and no row working
  // on it there (a failed, skipped or held row, or one for another organisation).
  function sendable({ invoice, sync }, tenantId) {
    if (!SENDABLE.includes(invoice.status) || !invoice.issuedAt) return false;
    if (invoice.xeroInvoiceId && invoice.xeroTenantId === tenantId) return false;
    if (!sync) return true;
    if (sync.tenantId !== tenantId) return true;
    return ["skipped", "failed", "held"].includes(sync.state) && !sync.xeroInvoiceId;
  }

  /** Candidates an owner may send to the connected organisation. */
  async function candidates({ invoiceUids = null, issuedSince = null, tenantId }) {
    return tx(async (inner) => {
      const conditions = [inArray(invoices.status, SENDABLE), sql`${invoices.issuedAt} is not null`];
      if (Array.isArray(invoiceUids)) conditions.push(inArray(invoices.uid, invoiceUids.length ? invoiceUids : ["-"]));
      if (issuedSince) conditions.push(gte(invoices.issuedAt, issuedSince));
      const rows = await inner.select({ invoice: invoices, sync: xeroInvoiceSyncs, document: issuedDocuments }).from(invoices)
        .leftJoin(xeroInvoiceSyncs, and(eq(xeroInvoiceSyncs.orgUid, invoices.orgUid), eq(xeroInvoiceSyncs.invoiceUid, invoices.uid)))
        .leftJoin(issuedDocuments, and(eq(issuedDocuments.orgUid, invoices.orgUid), eq(issuedDocuments.uid, invoices.issuedDocumentUid)))
        .where(and(...conditions))
        .orderBy(asc(invoices.issuedAt))
        .limit(200);
      return rows.filter((row) => sendable(row, tenantId));
    });
  }

  function previewRow({ invoice, sync, document }, mode, tenantId) {
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
      previously: sync ? (sync.tenantId !== tenantId ? "Sent to another Xero organisation" : xeroStateLabel(sync)) : null,
      problem: !invoice.issuedDocumentUid ? "Its issued PDF is not stored, so it cannot be attached." : (customer ? null : "It has no customer name or email for the Xero contact."),
    };
  }

  // What an owner's push creates: the mode now, and Draft while Create in Xero is off.
  function pushMode(state) {
    return state.createMode === "authorised" ? "authorised" : "draft";
  }

  async function connected() {
    const state = await connection.state();
    if (state.status !== "connected" || !state.tenantId) throw Object.assign(new Error("Connect Xero first (Settings, Integrations, Xero)."), { statusCode: 409, code: "XERO_NOT_CONNECTED" });
    return state;
  }

  // A fresh start for the connected organisation: what the row knew about an
  // earlier try (or another organisation) is forgotten; the invoice row keeps
  // its history until a new Xero invoice replaces it.
  function fresh(state, values) {
    return {
      tenantId: state.tenantId,
      state: "pending",
      attempts: 0,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseUntil: null,
      lastErrorCode: null,
      lastErrorReason: null,
      xeroContactId: null,
      ...values,
    };
  }

  return {
    enabled: true,
    workerId,
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
      const rows = state.tenantId ? await candidates({ invoiceUids, issuedSince, tenantId: state.tenantId }) : [];
      return { connected: state.status === "connected", mode, organisation: state.tenantName || null, invoices: rows.map((row) => previewRow(row, mode, state.tenantId)) };
    },

    /** Queue these invoices for the connected organisation (an owner's choice, after the preview). */
    async push({ invoiceUids, actor = null }) {
      const state = await connected();
      const mode = pushMode(state);
      const rows = (await candidates({ invoiceUids, tenantId: state.tenantId })).filter((row) => row.invoice.issuedDocumentUid);
      const at = now();
      await tx(async (inner) => {
        for (const { invoice } of rows) {
          const values = fresh(state, {
            mode,
            queuedBy: "owner",
            requestedBy: actor,
            queuedAt: at,
            xeroInvoiceId: null,
            xeroStatus: null,
            xeroTotal: null,
            fieldTotal: null,
            createdInXeroAt: null,
            attachedAt: null,
            updatedAt: at,
          });
          await inner.insert(xeroInvoiceSyncs).values({ invoiceUid: invoice.uid, ...values, createdAt: at })
            .onConflictDoUpdate({ target: [xeroInvoiceSyncs.orgUid, xeroInvoiceSyncs.invoiceUid], set: values });
        }
      });
      this.kick();
      return { queued: rows.map(({ invoice }) => invoice.uid), mode };
    },

    /** An owner's Retry: send it again now, from where it stopped, with the contact looked up again. */
    async retry({ invoiceUid, actor = null }) {
      const state = await connected();
      const current = await readSync(invoiceUid);
      // Not queued, or queued for another organisation: a fresh send here.
      if (!current || current.tenantId !== state.tenantId || current.state === "held") return this.push({ invoiceUids: [invoiceUid], actor });
      if (!["failed", "mismatch", "pending", "skipped"].includes(current.state)) {
        throw Object.assign(new Error("This invoice is already in Xero."), { statusCode: 409, code: "XERO_ALREADY_CREATED" });
      }
      await tx((inner) => inner.update(xeroInvoiceSyncs).set({ ...fresh(state, { requestedBy: actor }), queuedBy: "owner", updatedAt: now() })
        .where(and(eq(xeroInvoiceSyncs.invoiceUid, invoiceUid), leaseFree())));
      this.kick();
      return { queued: [invoiceUid] };
    },

    /** Each invoice of a job, by number: its Xero state for the Invoices tab. */
    async jobStatus(jobId) {
      const state = await connection.state();
      const tenantId = state.tenantId;
      const rows = await tx((inner) => inner.select({ invoice: invoices, sync: xeroInvoiceSyncs }).from(invoices)
        .leftJoin(xeroInvoiceSyncs, and(eq(xeroInvoiceSyncs.orgUid, invoices.orgUid), eq(xeroInvoiceSyncs.invoiceUid, invoices.uid)))
        .where(eq(invoices.jobId, String(jobId))));
      const byNumber = {};
      for (const { invoice, sync } of rows) {
        if (invoice.status === "draft") continue;
        const here = sync && sync.tenantId === tenantId ? sync : null;
        const elsewhere = sync && !here ? sync : null;
        const xeroStatus = here?.xeroStatus || (invoice.xeroTenantId === tenantId ? invoice.xeroStatus : null) || null;
        const inXero = Boolean(here?.xeroInvoiceId || (invoice.xeroInvoiceId && invoice.xeroTenantId === tenantId));
        let entry;
        if (GONE_IN_FIELD.includes(invoice.status) && inXero && !GONE_IN_XERO.includes(xeroStatus)) {
          // Credited or voided in Field after it reached Xero: phase 2 does this itself.
          entry = { state: "void-in-xero", label: "Void this in Xero", reason: `It was ${invoice.status === "void" ? "voided" : "credited"} in Field after it reached Xero, and Xero still has it. Void it, or credit it, in Xero. A later phase of Field does this itself.` };
        } else if (elsewhere || here?.state === "held") {
          entry = { state: "held", label: (elsewhere && ["created", "mismatch"].includes(elsewhere.state)) ? "In another Xero organisation" : "Held: another Xero organisation", reason: here?.lastErrorReason || "It went, or was queued, to the Xero organisation connected before. Send it again to create it in the one connected now." };
        } else if (here?.state === "pending" && state.codesProblem) {
          entry = { state: "pending", label: "Waiting for Xero", reason: state.codesMessage };
        } else {
          entry = { state: here?.state || "not-sent", label: xeroStateLabel(here), reason: here && here.state !== "created" ? here.lastErrorReason || null : null };
        }
        byNumber[invoice.number] = {
          invoiceUid: invoice.uid,
          ...entry,
          xeroStatus,
          nextAttemptAt: here?.state === "pending" ? iso(here.nextAttemptAt) : null,
          // Nothing to retry once Field has credited or voided it.
          canRetry: Boolean(here && ["failed", "mismatch"].includes(here.state)) && !GONE_IN_FIELD.includes(invoice.status),
          canSend: Boolean(tenantId) && state.status === "connected" && sendable({ invoice, sync }, tenantId),
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
        held: sql`count(*) filter (where ${xeroInvoiceSyncs.state} = 'held')`.mapWith(Number),
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
