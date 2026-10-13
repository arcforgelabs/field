// A fake Xero for tests (#93): Xero's identity server and the accounting
// calls Field makes, on 127.0.0.1, in memory. No test ever talks to Xero.
// Not a test file itself.
//
// It behaves as Xero's docs say (docs/XERO.md "Xero's documentation"):
//   - the authorization code is single use; tokens need HTTP Basic client
//     authentication; every refresh rotates the refresh token, and a spent
//     refresh token is refused with invalid_grant (no grace period here, so
//     a test notices a token that was not stored);
//   - API calls need a live access token and a connected xero-tenant-id;
//   - Idempotency-Key replays the first response for the same request, and
//     refuses the same key with a different request (400);
//   - an ACCREC invoice without an InvoiceNumber is numbered INV-0001, ...;
//     a duplicate InvoiceNumber is refused, as Xero's "must be unique";
//   - totals: SubTotal is the sum of LineAmount, TotalTax the sum of each
//     line's TaxAmount (as sent, or worked out from its TaxType), and Total
//     their sum.
// `failNext(match, response, times)` makes the next matching calls fail.
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

const RATES = { OUTPUT: 10, EXEMPTOUTPUT: 0, BASEXCLUDED: 0, INPUT: 10 };
const TAX_RATES = [
  { TaxType: "OUTPUT", Name: "GST on Income", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: 10 },
  { TaxType: "EXEMPTOUTPUT", Name: "GST Free Income", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: 0 },
  { TaxType: "BASEXCLUDED", Name: "BAS Excluded", Status: "ACTIVE", CanApplyToRevenue: true, EffectiveRate: 0 },
  { TaxType: "INPUT", Name: "GST on Expenses", Status: "ACTIVE", CanApplyToRevenue: false, EffectiveRate: 10 },
];
const ACCOUNTS = [
  { Code: "200", Name: "Sales", Type: "REVENUE", Class: "REVENUE", Status: "ACTIVE" },
  { Code: "260", Name: "Other Revenue", Type: "OTHERINCOME", Class: "REVENUE", Status: "ACTIVE" },
  { Code: "4000", Name: "Earthworks income", Type: "SALES", Class: "REVENUE", Status: "ACTIVE" },
  { Code: "299", Name: "Old sales", Type: "REVENUE", Class: "REVENUE", Status: "ARCHIVED" },
  { Code: "310", Name: "Cost of Goods Sold", Type: "DIRECTCOSTS", Class: "EXPENSE", Status: "ACTIVE" },
];

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

export async function startFakeXero({
  clientId = "fake-client-id-0001",
  clientSecret = "fake-client-secret-0001",
  tenants = [{ tenantId: "11111111-2222-3333-4444-555555555555", tenantName: "Synthetic Earthworks Pty Ltd" }],
  accessTtlSeconds = 1800,
  accounts = ACCOUNTS,
} = {}) {
  const state = {
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    connections: tenants.map((tenant) => ({ id: randomUUID(), tenantId: tenant.tenantId, tenantName: tenant.tenantName, tenantType: "ORGANISATION" })),
    invoices: [],
    contacts: [],
    attachments: [],
    idempotency: new Map(),
    calls: [],
    failures: [],
    revoked: [],
    everyCode: [],
    nextInvoiceNumber: 1,
    // The organisation's chart of accounts; a test may change it.
    accounts: [...accounts],
    // Tests can make Xero total an invoice its own way (ignore TaxAmount).
    ignoreTaxAmount: false,
  };

  function issueTokens() {
    const accessToken = `fake-access-${randomBytes(12).toString("hex")}`;
    const refreshToken = `fake-refresh-${randomBytes(12).toString("hex")}`;
    state.access.set(accessToken, Date.now() + accessTtlSeconds * 1000);
    state.refresh.set(refreshToken, true);
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: accessTtlSeconds, token_type: "Bearer", scope: "offline_access accounting.invoices" };
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  function validation(res, message) {
    send(res, 400, { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: message }] }] });
  }

  function basicOk(req) {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Basic ")) return false;
    return Buffer.from(header.slice(6), "base64").toString("utf8") === `${clientId}:${clientSecret}`;
  }

  function bearerOk(req) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expires = state.access.get(token);
    return Boolean(expires && expires > Date.now());
  }

  function tenantOk(req) {
    return state.connections.some((connection) => connection.tenantId === req.headers["xero-tenant-id"]);
  }

  function invoiceTotals(invoice) {
    let subTotal = 0;
    let totalTax = 0;
    for (const line of invoice.LineItems || []) {
      const lineAmount = line.LineAmount != null ? money(line.LineAmount) : money(Number(line.Quantity ?? 1) * Number(line.UnitAmount ?? 0));
      const rate = RATES[line.TaxType] ?? 0;
      const tax = line.TaxAmount != null && !state.ignoreTaxAmount ? money(line.TaxAmount) : money((lineAmount * rate) / 100);
      line.LineAmount = lineAmount;
      line.TaxAmount = tax;
      subTotal += lineAmount;
      totalTax += tax;
    }
    invoice.SubTotal = money(subTotal);
    invoice.TotalTax = money(totalTax);
    invoice.Total = money(subTotal + totalTax);
  }

  async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const raw = await body(req);
    const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body: raw.length && /json/.test(String(req.headers["content-type"])) ? JSON.parse(raw.toString("utf8")) : null, bytes: raw.length };
    state.calls.push(call);

    const failure = state.failures.find((entry) => entry.times > 0 && entry.method === req.method && entry.match.test(url.pathname));
    if (failure) {
      failure.times -= 1;
      if (!failure.afterProcessing) return send(res, failure.status, failure.body, failure.headers);
      // Xero did the work, but the answer is lost on the way back.
      const writeHead = res.writeHead.bind(res);
      const end = res.end.bind(res);
      res.writeHead = () => writeHead(failure.status, { "content-type": "application/json", ...failure.headers });
      res.end = () => end(JSON.stringify(failure.body ?? {}));
    }

    // Identity: authorize (auto-consent), token, revocation.
    if (url.pathname === "/identity/connect/authorize") {
      const code = `fake-code-${randomBytes(8).toString("hex")}`;
      state.codes.set(code, url.searchParams.get("redirect_uri"));
      state.everyCode.push(code);
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") || "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/connect/token" && req.method === "POST") {
      if (!basicOk(req)) return send(res, 400, { error: "invalid_client" });
      const form = new URLSearchParams(raw.toString("utf8"));
      call.grant = form.get("grant_type");
      if (form.get("grant_type") === "authorization_code") {
        const redirect = state.codes.get(form.get("code"));
        state.codes.delete(form.get("code"));
        if (!redirect || redirect !== form.get("redirect_uri")) return send(res, 400, { error: "invalid_grant" });
        return send(res, 200, issueTokens());
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = form.get("refresh_token");
        if (!state.refresh.get(token)) return send(res, 400, { error: "invalid_grant" });
        state.refresh.set(token, false);
        return send(res, 200, issueTokens());
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/connect/revocation" && req.method === "POST") {
      if (!basicOk(req)) return send(res, 400, { error: "invalid_client" });
      const token = new URLSearchParams(raw.toString("utf8")).get("token");
      state.refresh.set(token, false);
      state.revoked.push(token);
      return send(res, 200);
    }

    if (!bearerOk(req)) return send(res, 401, { Title: "Unauthorized", Status: 401, Detail: "TokenExpired" });
    if (url.pathname === "/connections" && req.method === "GET") return send(res, 200, state.connections);
    if (url.pathname.startsWith("/connections/") && req.method === "DELETE") {
      state.connections = state.connections.filter((connection) => connection.id !== decodeURIComponent(url.pathname.split("/")[2]));
      return send(res, 204);
    }
    if (!tenantOk(req)) return send(res, 403, { Type: "AuthenticationUnsuccessful", Title: "Forbidden", Status: 403 });

    // Idempotency-Key: replay the first answer to the same request.
    const key = req.headers["idempotency-key"];
    const fingerprint = `${req.method} ${url.pathname}${url.search} ${raw.toString("base64")}`;
    if (key && ["POST", "PUT", "PATCH"].includes(req.method)) {
      const seen = state.idempotency.get(key);
      if (seen && seen.fingerprint !== fingerprint) return validation(res, `Idempotency Key: ${key} is used with a different request`);
      if (seen) return send(res, seen.status, seen.body);
    }
    const remember = (status, payload) => {
      if (key && ["POST", "PUT", "PATCH"].includes(req.method)) state.idempotency.set(key, { fingerprint, status, body: payload });
      return send(res, status, payload);
    };

    const api = url.pathname.replace(/^\/api\.xro\/2\.0/, "");
    // Each organisation sees only its own invoices and contacts (entries a
    // test pushes without one are everyone's).
    const tenant = req.headers["xero-tenant-id"];
    const mine = (entry) => !entry.tenantId || entry.tenantId === tenant;
    const invoicesHere = state.invoices.filter(mine);
    const contactsHere = state.contacts.filter(mine);
    if (api === "/Accounts" && req.method === "GET") return send(res, 200, { Accounts: state.accounts });
    if (api === "/TaxRates" && req.method === "GET") return send(res, 200, { TaxRates: TAX_RATES });
    if (api === "/Contacts" && req.method === "GET") {
      // searchTerm: case-insensitive, in the name or the email (as Xero's).
      const term = String(url.searchParams.get("searchTerm") || "").toLowerCase();
      const found = term ? contactsHere.filter((contact) => contact.Name.toLowerCase().includes(term) || String(contact.EmailAddress || "").toLowerCase().includes(term)) : contactsHere;
      return send(res, 200, { Contacts: found });
    }
    if (api === "/Contacts" && req.method === "PUT") {
      const created = [];
      for (const input of call.body?.Contacts || []) {
        if (contactsHere.some((contact) => contact.ContactStatus !== "ARCHIVED" && contact.Name.toLowerCase() === String(input.Name).toLowerCase())) return remember(400, { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: "The contact name must be unique across all active contacts." }] }] });
        const contact = { ContactID: randomUUID(), Name: input.Name, EmailAddress: input.EmailAddress || "", ContactStatus: "ACTIVE", tenantId: tenant };
        state.contacts.push(contact);
        created.push(contact);
      }
      return remember(200, { Contacts: created });
    }
    if (api === "/Invoices" && req.method === "GET") {
      const numbers = (url.searchParams.get("InvoiceNumbers") || "").split(",").filter(Boolean);
      return send(res, 200, { Invoices: invoicesHere.filter((invoice) => !numbers.length || numbers.includes(invoice.InvoiceNumber)) });
    }
    const single = /^\/Invoices\/([^/]+)$/.exec(api);
    if (single && req.method === "GET") {
      const invoice = invoicesHere.find((entry) => entry.InvoiceID === single[1] || entry.InvoiceNumber === decodeURIComponent(single[1]));
      return invoice ? send(res, 200, { Invoices: [invoice] }) : send(res, 404, { Title: "Not found" });
    }
    // An update that names only the status (approving a draft) keeps the lines.
    if (single && req.method === "POST") {
      const invoice = invoicesHere.find((entry) => entry.InvoiceID === single[1]);
      if (!invoice) return remember(404, { Title: "Not found" });
      const change = call.body?.Invoices?.[0] || {};
      if (change.Status === "AUTHORISED" && !invoice.DueDate) return remember(400, { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: "Due Date is required." }] }] });
      if (change.Status) invoice.Status = change.Status;
      return remember(200, { Invoices: [invoice] });
    }
    if (api === "/Invoices" && (req.method === "PUT" || req.method === "POST")) {
      const created = [];
      for (const input of call.body?.Invoices || []) {
        const invoice = structuredClone(input);
        if (!invoice.InvoiceNumber) invoice.InvoiceNumber = `INV-${String(state.nextInvoiceNumber++).padStart(4, "0")}`;
        // A deleted draft frees its number; a voided invoice keeps it (Xero's
        // behaviour for a voided number is not confirmed: docs/XERO.md).
        if (invoicesHere.some((existing) => existing.InvoiceNumber === invoice.InvoiceNumber && existing.Status !== "DELETED")) return remember(400, { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: "Invoice # must be unique." }] }] });
        if (!contactsHere.some((contact) => contact.ContactID === invoice.Contact?.ContactID && contact.ContactStatus !== "ARCHIVED")) return remember(400, { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: "The contact could not be found." }] }] });
        if (invoice.Status === "AUTHORISED" && !invoice.DueDate) return remember(400, { ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: [{ Message: "Due Date is required." }] }] });
        invoice.InvoiceID = randomUUID();
        invoice.tenantId = tenant;
        invoice.Status = invoice.Status || "DRAFT";
        invoiceTotals(invoice);
        state.invoices.push(invoice);
        created.push(invoice);
      }
      return remember(200, { Invoices: created });
    }
    const attachment = /^\/Invoices\/([^/]+)\/Attachments\/([^/]+)$/.exec(api);
    if (attachment && (req.method === "PUT" || req.method === "POST")) {
      const invoice = invoicesHere.find((entry) => entry.InvoiceID === attachment[1]);
      if (!invoice) return remember(404, { Title: "Not found" });
      const record = { AttachmentID: randomUUID(), InvoiceID: invoice.InvoiceID, FileName: decodeURIComponent(attachment[2]), MimeType: req.headers["content-type"], ContentLength: raw.length, IncludeOnline: url.searchParams.get("IncludeOnline") === "true", bytes: raw };
      state.attachments = state.attachments.filter((entry) => !(entry.InvoiceID === record.InvoiceID && entry.FileName === record.FileName));
      state.attachments.push(record);
      return remember(200, { Attachments: [{ AttachmentID: record.AttachmentID, FileName: record.FileName, MimeType: record.MimeType, ContentLength: record.ContentLength, IncludeOnline: record.IncludeOnline }] });
    }
    return send(res, 404, { Title: "Not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    clientId,
    clientSecret,
    state,
    /**
     * The next `times` calls of `method` to a path matching `match` answer with
     * `status`. With `afterProcessing`, the fake does the work first and the
     * answer is lost (a timeout after Xero created the invoice).
     */
    failNext({ method = "PUT", match, status, body: failureBody = {}, headers = {}, times = 1, afterProcessing = false }) {
      state.failures.push({ method, match, status, body: failureBody, headers, times, afterProcessing });
    },
    /** Every access token Xero issued expires now. */
    expireAccessTokens() {
      for (const token of state.access.keys()) state.access.set(token, 0);
    },
    /** Every refresh token is refused from now (revoked at Xero, or 60 days passed). */
    revokeAllRefreshTokens() {
      for (const token of state.refresh.keys()) state.refresh.set(token, false);
    },
    /** Every token string issued so far (for tests that check logs). */
    issuedSecrets() {
      return [...state.access.keys(), ...state.refresh.keys(), ...state.everyCode, clientSecret];
    },
    /** The token endpoint calls, of one grant type or all. */
    tokenCalls(grantType = null) {
      return state.calls.filter((call) => call.path === "/connect/token" && (!grantType || call.grant === grantType));
    },
    /** A way to sign in to the authorize endpoint for a code without a browser. */
    async authorize(authorizeUrl) {
      const response = await fetch(authorizeUrl, { redirect: "manual" });
      return new URL(response.headers.get("location"));
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
