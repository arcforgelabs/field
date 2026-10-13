// The Xero connection of one organisation (#93, phase 1).
//
// The owner presses Connect: Field records a sign-in in progress (a random
// state, kept only as its SHA-256) and sends the owner to Xero. A web app
// uses Xero's standard authorization code flow with its client secret; Xero
// documents PKCE for apps that cannot keep a secret (docs/XERO.md). Xero sends them back to this installation's redirect
// address with a code; Field checks the state, exchanges the code for tokens,
// lists the organisations the tokens reach (GET /connections) and stores the
// tokens encrypted (token-crypto.js). With one organisation it is connected;
// with several the owner chooses one in Settings.
//
// Access tokens are short-lived and refreshed before they expire. Xero
// rotates the refresh token on every refresh, so the new one is stored in the
// same database transaction that read the old one, under a row lock: two
// servers never spend the same refresh token. A refresh Xero rejects
// (invalid_grant: expired, revoked, or the app's secret changed) marks the
// connection `needs_reconnect` with a code, and invoices wait until the owner
// connects again. Disconnect revokes the tokens at Xero (best effort) and
// clears them here; the settings stay.
//
// Nothing here logs a token, a code or a secret. The status the browser gets
// says only whether each secret is set.
import { eq } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { XeroError, hashState, newAuthorizationRequest } from "./client.js";
import { XERO_SCOPES } from "./config.js";
import { createTokenCipher, TokenCryptoError } from "./token-crypto.js";

const { xeroConnections, XERO_CREATE_MODES } = schema;

export const XERO_DEFAULTS = Object.freeze({
  createMode: "draft",
  salesAccountCode: "200",
  taxType: "OUTPUT",
  invoiceNumbering: "field",
});

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 2 * 60_000;
/** How long the owner has to finish signing in to Xero. */
const STATE_TTL_MS = 10 * 60_000;

export const XERO_CREATE_MODE_CHOICES = Object.freeze([
  { value: "off", label: "Off", description: "Field creates nothing in Xero." },
  { value: "draft", label: "Draft invoice", description: "A draft in Xero for every invoice Field issues. Nothing is approved or sent. Recommended." },
  { value: "authorised", label: "Approved invoice", description: "An approved (AUTHORISED) invoice in Xero. Xero does not email it; Field sends the customer's copy." },
]);

/** What the owner reads for a reconnect code. */
const RECONNECT_MESSAGES = Object.freeze({
  XERO_REFRESH_REJECTED: "Xero no longer accepts Field's sign-in: it expired or was revoked. Connect again.",
  XERO_CLIENT_REJECTED: "Xero did not accept XERO_CLIENT_ID and XERO_CLIENT_SECRET. Check them, then connect again.",
  CLIENT_SECRET_CHANGED: "XERO_CLIENT_SECRET changed since Xero was connected, so the stored sign-in cannot be read. Connect again.",
  XERO_FORBIDDEN: "Xero refused access to the organisation. Connect again.",
  XERO_SCOPE_MISSING: "Field's Xero sign-in lacks a permission it needs. Connect again.",
  XERO_TOKEN_INVALID: "Xero's sign-in answer was incomplete. Connect again.",
  XERO_TOKEN_REFUSED: "Xero refused Field's sign-in. Connect again.",
  XERO_SECRETS_MISSING: "XERO_CLIENT_ID and XERO_CLIENT_SECRET are not both set.",
  TOKEN_DECRYPT_FAILED: "The stored Xero sign-in could not be read. Connect again.",
});

export class XeroConnectionError extends Error {
  constructor(message, { code = "XERO_CONNECTION_INVALID", statusCode = 400 } = {}) {
    super(message);
    this.name = "XeroConnectionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function reconnectCode(error) {
  if (error instanceof TokenCryptoError) return "TOKEN_DECRYPT_FAILED";
  const code = String(error?.code || "");
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "XERO_REFRESH_REJECTED";
}

/**
 * `secrets` from config.js readXeroSecrets(); `http(secrets)` builds the
 * client (client.js createXeroHttp) for those secrets.
 */
export function createXeroConnectionService({
  db,
  orgUid = undefined,
  secrets,
  http,
  now = () => new Date(),
  scopes = XERO_SCOPES,
  logger = console,
}) {
  if (!db) throw new Error("createXeroConnectionService needs a database");
  if (!secrets || typeof http !== "function") throw new Error("createXeroConnectionService needs the Xero secrets and an HTTP client factory");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);
  const listeners = new Set();
  let refreshing = null;

  const client = () => http(secrets);
  const cipher = () => createTokenCipher({ clientSecret: secrets.clientSecret, orgUid: scope.orgUid });

  async function read(tx) {
    const [row] = await tx.select().from(xeroConnections);
    return row || null;
  }

  // Update the organisation's row, or create it. Not INSERT ... ON CONFLICT:
  // PostgreSQL checks the row it would insert before it finds the conflict,
  // and a partial update (status `connected` with the tokens already stored)
  // would fail the connected check as an insert.
  async function upsert(tx, values) {
    const at = now();
    const update = () => tx.update(xeroConnections).set({ ...values, updatedAt: at }).where(eq(xeroConnections.orgUid, scope.orgUid)).returning();
    const [updated] = await update();
    if (updated) return updated;
    const [inserted] = await tx.insert(xeroConnections).values({ ...values, createdAt: at, updatedAt: at }).onConflictDoNothing().returning();
    return inserted || (await update())[0];
  }

  function requireSecrets() {
    if (!secrets.configured) {
      throw new XeroConnectionError("Set XERO_CLIENT_ID and XERO_CLIENT_SECRET as deployment secrets first (docs/XERO.md).", { code: "XERO_SECRETS_MISSING", statusCode: 409 });
    }
  }

  function settingsOf(row) {
    return {
      createMode: row?.createMode || XERO_DEFAULTS.createMode,
      salesAccountCode: row?.salesAccountCode || XERO_DEFAULTS.salesAccountCode,
      taxType: row?.taxType || XERO_DEFAULTS.taxType,
      invoiceNumbering: row?.invoiceNumbering || XERO_DEFAULTS.invoiceNumbering,
      autoFrom: iso(row?.autoFrom),
    };
  }

  // What is wrong with the saved codes in the connected organisation, in words.
  function codesMessage(row) {
    if (row?.status !== "connected" || !row?.codesProblem) return null;
    const where = row.tenantName || "your Xero organisation";
    if (row.codesProblem === "XERO_ACCOUNT_CODE_UNKNOWN") return `Sales account ${row.salesAccountCode} is not an active revenue account in ${where}. Choose one below; invoices wait until then.`;
    if (row.codesProblem === "XERO_TAX_TYPE_UNKNOWN") return `GST tax type ${row.taxType} is not an active tax rate for sales in ${where}. Choose one below; invoices wait until then.`;
    if (row.codesProblem === "XERO_CODES_UNCHECKED") return `Field has not been able to check the sales account and the GST tax type against ${where} yet. Invoices wait; Field checks again by itself, or save the codes below.`;
    return `The saved codes are not ones ${where} has. Choose them below; invoices wait until then.`;
  }

  // The saved codes against the organisation's lists: the problem code, or null.
  function codesProblemFor(row, codes) {
    if (!codes.accounts.some((account) => account.code === (row?.salesAccountCode || XERO_DEFAULTS.salesAccountCode))) return "XERO_ACCOUNT_CODE_UNKNOWN";
    if (!codes.taxRates.some((rate) => rate.taxType === (row?.taxType || XERO_DEFAULTS.taxType))) return "XERO_TAX_TYPE_UNKNOWN";
    return null;
  }

  function connectionOf(row) {
    const status = row?.status || "disconnected";
    return {
      codesProblem: status === "connected" ? row?.codesProblem || null : null,
      codesMessage: codesMessage(row),
      codesCheckedAt: status === "connected" ? iso(row?.codesCheckedAt) : null,
      status,
      tenantName: status === "disconnected" ? null : row?.tenantName || null,
      connectedAt: status === "disconnected" ? null : iso(row?.connectedAt),
      connectedBy: status === "disconnected" ? null : row?.connectedBy || null,
      reconnectReason: status === "needs_reconnect" ? row?.reconnectReason || null : null,
      reconnectMessage: status === "needs_reconnect" ? RECONNECT_MESSAGES[row?.reconnectReason] || RECONNECT_MESSAGES.XERO_REFRESH_REJECTED : null,
      organisations: status === "choose_organisation"
        ? (row?.availableTenants || []).map((tenant) => ({ tenantId: tenant.tenantId, tenantName: tenant.tenantName || "Unnamed organisation" }))
        : [],
    };
  }

  // A secret changed since the tokens were stored: they cannot be read.
  function keyChanged(row) {
    return Boolean(row?.keyFingerprint && secrets.clientSecret && row.keyFingerprint !== cipher().fingerprint);
  }

  async function markNeedsReconnect(code, { tx = null } = {}) {
    const write = (inner) => upsert(inner, { status: "needs_reconnect", reconnectReason: code, accessTokenEnc: null, accessExpiresAt: null });
    if (tx) await write(tx);
    else await scope.transaction(write);
    logger.warn?.(`[xero] the connection needs the owner to connect again (${code})`);
  }

  function notify(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  return {
    /** The connection and settings for the owner's screen. Never a token. */
    async status() {
      let row = await scope.transaction(read);
      if (row?.status === "connected" && keyChanged(row)) {
        await markNeedsReconnect("CLIENT_SECRET_CHANGED");
        row = await scope.transaction(read);
      }
      return {
        secrets: secrets.status(),
        scopes: [...scopes],
        connection: connectionOf(row),
        settings: settingsOf(row),
        choices: { createMode: XERO_CREATE_MODE_CHOICES },
      };
    },

    /** The settings the invoice sync reads. */
    async settings() {
      return settingsOf(await scope.transaction(read));
    },

    /** The raw connection state the invoice sync reads (no tokens). */
    async state() {
      const row = await scope.transaction(read);
      return {
        status: row?.status || "disconnected",
        tenantId: row?.tenantId || null,
        tenantName: row?.tenantName || null,
        codesProblem: row?.status === "connected" ? row?.codesProblem || null : null,
        codesMessage: codesMessage(row),
        ...settingsOf(row),
      };
    },

    /** Start connecting: record the sign-in in progress and return Xero's sign-in address. */
    async startConnect({ redirectUri, actor = null }) {
      requireSecrets();
      if (!redirectUri) throw new XeroConnectionError("Set publicUrl, this installation's public address, in the configuration first. Field builds the redirect address from it (docs/XERO.md).", { code: "XERO_PUBLIC_URL_MISSING", statusCode: 409 });
      const { state } = newAuthorizationRequest();
      await scope.transaction((tx) => upsert(tx, {
        pendingStateHash: hashState(state),
        pendingBy: actor,
        pendingExpiresAt: new Date(now().getTime() + STATE_TTL_MS),
      }));
      return { url: client().authorizeUrl({ redirectUri, state, scopes }) };
    },

    /**
     * Xero sent the owner back with `code` and `state`. The state must be the
     * one in progress and unexpired. The callback needs no sign-in, so a
     * wrong state changes nothing: only the owner's own state is spent (used
     * or expired), and a guessed request cannot break a sign-in in progress.
     * Returns the new connection status.
     */
    async completeConnect({ code, state, redirectUri }) {
      requireSecrets();
      if (!state || !code) throw new XeroConnectionError("Xero did not return a sign-in code.", { code: "XERO_CALLBACK_INCOMPLETE" });
      const pending = await scope.transaction(async (tx) => {
        const row = await read(tx);
        const ours = Boolean(row?.pendingStateHash) && row.pendingStateHash === hashState(state);
        if (!ours) return null;
        await upsert(tx, { pendingStateHash: null, pendingBy: null, pendingExpiresAt: null });
        return row.pendingExpiresAt && new Date(row.pendingExpiresAt) > now() ? row : null;
      });
      if (!pending) throw new XeroConnectionError("This Xero sign-in was not started here, was used already or took too long. Press Connect again.", { code: "XERO_STATE_INVALID", statusCode: 400 });
      const tokens = await client().exchangeCode({ code, redirectUri });
      const tenants = (await client().connections(tokens.accessToken))
        .filter((entry) => !entry.tenantType || entry.tenantType === "ORGANISATION")
        .map((entry) => ({ tenantId: String(entry.tenantId), tenantName: String(entry.tenantName || ""), connectionId: String(entry.id || "") }));
      if (!tenants.length) throw new XeroConnectionError("No Xero organisation was connected. Press Connect again and choose one.", { code: "XERO_NO_ORGANISATION", statusCode: 409 });
      const at = now();
      const box = cipher();
      const sealed = {
        accessTokenEnc: box.encrypt(tokens.accessToken, "access_token"),
        refreshTokenEnc: box.encrypt(tokens.refreshToken, "refresh_token"),
        accessExpiresAt: new Date(at.getTime() + tokens.expiresInSeconds * 1000),
        refreshIssuedAt: at,
        keyFingerprint: box.fingerprint,
        reconnectReason: null,
      };
      const result = await scope.transaction(async (tx) => {
        const previous = await read(tx);
        const kept = tenants.find((tenant) => tenant.tenantId === previous?.tenantId);
        const chosen = kept || (tenants.length === 1 ? tenants[0] : null);
        if (!chosen) {
          await upsert(tx, { ...sealed, status: "choose_organisation", availableTenants: tenants, connectedBy: pending.pendingBy });
          return "choose_organisation";
        }
        await upsert(tx, {
          ...sealed,
          status: "connected",
          tenantId: chosen.tenantId,
          tenantName: chosen.tenantName,
          connectionId: chosen.connectionId,
          availableTenants: [],
          connectedAt: at,
          connectedBy: pending.pendingBy,
          // Sends wait until the codes are checked against this organisation.
          codesProblem: "XERO_CODES_UNCHECKED",
          codesCheckedAt: null,
          // The same organisation again (after a reconnect) keeps its start;
          // a new one starts now: earlier invoices are never pushed by themselves.
          autoFrom: kept && previous?.autoFrom ? previous.autoFrom : ((previous?.createMode || XERO_DEFAULTS.createMode) === "off" ? null : at),
        });
        return "connected";
      });
      if (result === "connected") {
        await this.checkCodes();
        notify({ type: "connected" });
      }
      return { status: result };
    },

    /** With several organisations: the owner's choice. */
    async chooseOrganisation({ tenantId, actor = null }) {
      const result = await scope.transaction(async (tx) => {
        const row = await read(tx);
        if (row?.status !== "choose_organisation") throw new XeroConnectionError("There is no organisation to choose. Press Connect.", { code: "XERO_NOTHING_TO_CHOOSE", statusCode: 409 });
        const chosen = (row.availableTenants || []).find((tenant) => tenant.tenantId === tenantId);
        if (!chosen) throw new XeroConnectionError("That organisation is not one Xero connected. Choose one from the list.", { code: "XERO_UNKNOWN_ORGANISATION" });
        const at = now();
        await upsert(tx, {
          status: "connected",
          tenantId: chosen.tenantId,
          tenantName: chosen.tenantName,
          connectionId: chosen.connectionId,
          availableTenants: [],
          connectedAt: at,
          connectedBy: row.connectedBy || actor,
          codesProblem: "XERO_CODES_UNCHECKED",
          codesCheckedAt: null,
          autoFrom: row.createMode === "off" ? null : at,
          updatedBy: actor,
        });
        return "connected";
      });
      await this.checkCodes();
      notify({ type: "connected" });
      return { status: result };
    },

    /** Revoke at Xero (best effort) and forget the tokens and organisation. Settings stay. */
    async disconnect({ actor = null } = {}) {
      const row = await scope.transaction(read);
      if (row?.refreshTokenEnc && secrets.configured && !keyChanged(row)) {
        try {
          await client().revoke(cipher().decrypt(row.refreshTokenEnc, "refresh_token"));
        } catch (error) {
          logger.warn?.(`[xero] revoking the refresh token at Xero failed (${error?.code || "XERO_ERROR"}); Field forgets it anyway. Remove Field in Xero's Connected apps if it is still listed.`);
        }
      }
      await scope.transaction((tx) => upsert(tx, {
        status: "disconnected",
        tenantId: null,
        tenantName: null,
        connectionId: null,
        availableTenants: [],
        accessTokenEnc: null,
        refreshTokenEnc: null,
        accessExpiresAt: null,
        refreshIssuedAt: null,
        keyFingerprint: null,
        reconnectReason: null,
        connectedAt: null,
        connectedBy: null,
        autoFrom: null,
        updatedBy: actor,
      }));
      notify({ type: "disconnected" });
      return { status: "disconnected" };
    },

    /** The owner's settings: what to create, the sales account code and the GST tax type. */
    async updateSettings(input = {}, { actor = null } = {}) {
      const changes = {};
      if (input.createMode !== undefined) {
        if (!XERO_CREATE_MODES.includes(input.createMode)) throw new XeroConnectionError(`createMode must be one of ${XERO_CREATE_MODES.join(", ")}`);
        changes.createMode = input.createMode;
      }
      if (input.salesAccountCode !== undefined) {
        const code = String(input.salesAccountCode ?? "").trim();
        if (!/^[A-Za-z0-9._-]{1,10}$/.test(code)) throw new XeroConnectionError("The sales account code is the account's code in Xero, for example 200: letters and digits, up to 10.", { code: "XERO_ACCOUNT_CODE_INVALID" });
        changes.salesAccountCode = code;
      }
      if (input.taxType !== undefined) {
        const taxType = String(input.taxType ?? "").trim().toUpperCase();
        if (!/^[A-Z0-9_]{1,40}$/.test(taxType)) throw new XeroConnectionError("The tax type is Xero's code for it, for example OUTPUT (GST on Income).", { code: "XERO_TAX_TYPE_INVALID" });
        changes.taxType = taxType;
      }
      // Checked against the organisation's own accounts and tax rates when
      // Field can read them; saved with a warning when it cannot.
      let warning = null;
      let checked = null;
      if (changes.salesAccountCode !== undefined || changes.taxType !== undefined) {
        const current = await scope.transaction(read);
        if (current?.status === "connected") {
          const codes = await this.codes();
          if (codes.available) {
            if (changes.salesAccountCode !== undefined && !codes.accounts.some((account) => account.code === changes.salesAccountCode)) {
              throw new XeroConnectionError(`${changes.salesAccountCode} is not an active revenue account in ${current.tenantName || "your Xero organisation"}. Choose one from the list.`, { code: "XERO_ACCOUNT_CODE_UNKNOWN" });
            }
            if (changes.taxType !== undefined && !codes.taxRates.some((rate) => rate.taxType === changes.taxType)) {
              throw new XeroConnectionError(`${changes.taxType} is not an active tax rate for sales in ${current.tenantName || "your Xero organisation"}. Choose one from the list.`, { code: "XERO_TAX_TYPE_UNKNOWN" });
            }
            checked = { codesProblem: codesProblemFor({ ...current, ...changes }, codes), codesCheckedAt: now() };
          } else {
            warning = `Saved, but Field could not check these codes with Xero (${codes.code}). Check them in Xero.`;
            checked = { codesProblem: null, codesCheckedAt: null };
          }
        }
      }
      const row = await scope.transaction(async (tx) => {
        const previous = await read(tx);
        if (changes.createMode !== undefined) {
          const was = previous?.createMode || XERO_DEFAULTS.createMode;
          // Turned on: invoices issued from now go by themselves. Turned off: none do.
          if (changes.createMode === "off") changes.autoFrom = null;
          else if (was === "off" || !previous?.autoFrom) changes.autoFrom = previous?.status === "connected" || previous?.status === "needs_reconnect" ? now() : null;
        }
        return upsert(tx, { ...changes, ...(checked || {}), updatedBy: actor });
      });
      if (checked) notify({ type: "settings" });
      return warning ? { ...settingsOf(row), warning } : settingsOf(row);
    },

    /**
     * Check the saved account and tax codes against the connected
     * organisation (after connecting, or switching organisation), and record
     * the result: the screen shows it, and invoices wait while a code is not
     * the organisation's. When Xero cannot be read nothing is recorded as
     * wrong. Never throws.
     */
    async checkCodes() {
      try {
        const row = await scope.transaction(read);
        if (row?.status !== "connected") return null;
        const codes = await this.codes();
        // Xero could not be read: sends keep waiting, with that reason.
        const result = codes.available ? { codesProblem: codesProblemFor(row, codes), codesCheckedAt: now() } : { codesProblem: "XERO_CODES_UNCHECKED", codesCheckedAt: null };
        await scope.transaction((tx) => upsert(tx, result));
        if (result.codesProblem) logger.warn?.(`[xero] the saved codes are not confirmed for the connected organisation (${result.codesProblem}); invoices wait`);
        return result;
      } catch (error) {
        logger.warn?.(`[xero] the saved codes could not be checked (${/^[A-Z0-9_]{1,64}$/.test(String(error?.code || "")) ? error.code : "XERO_ERROR"})`);
        return null;
      }
    },

    /**
     * The organisation's active revenue accounts and the active tax rates
     * that apply to sales, from Xero (accounting.settings.read), for the
     * owner's lists. Never throws: { available: false, code } when Xero cannot
     * be read, and the screen falls back to typing the codes.
     */
    async codes() {
      try {
        const client = http(secrets);
        const [accounts, rates] = await this.withAccessToken(async (token) => Promise.all([
          client.accounting({ ...token, path: "/Accounts" }),
          client.accounting({ ...token, path: "/TaxRates" }),
        ]));
        return {
          available: true,
          accounts: (accounts?.Accounts || [])
            .filter((account) => account?.Code && account.Status === "ACTIVE" && (account.Class === "REVENUE" || ["REVENUE", "SALES", "OTHERINCOME"].includes(account.Type)))
            .map((account) => ({ code: String(account.Code), name: String(account.Name || account.Code) }))
            .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
          taxRates: (rates?.TaxRates || [])
            .filter((rate) => rate?.TaxType && rate.Status === "ACTIVE" && rate.CanApplyToRevenue !== false)
            .map((rate) => ({ taxType: String(rate.TaxType), name: String(rate.Name || rate.TaxType), rate: Number(rate.EffectiveRate ?? rate.DisplayTaxRate ?? 0) })),
        };
      } catch (error) {
        const code = /^[A-Z0-9_]{1,64}$/.test(String(error?.code || "")) ? error.code : "XERO_ERROR";
        logger.warn?.(`[xero] the accounts and tax rates could not be read (${code})`);
        return { available: false, code, accounts: [], taxRates: [] };
      }
    },

    /**
     * Run `fn({ accessToken, tenantId })` with a fresh access token for the
     * connected organisation. Refreshes first when the token is about to
     * expire, and once more when Xero answers 401. A rejected refresh marks
     * the connection `needs_reconnect` and throws a XeroError with
     * `reconnect: true`.
     */
    async withAccessToken(fn) {
      let token = await this.accessToken();
      try {
        return await fn(token);
      } catch (error) {
        if (error?.code !== "XERO_UNAUTHORISED") throw error;
        token = await this.accessToken({ force: true });
        return fn(token);
      }
    },

    async accessToken({ force = false } = {}) {
      if (!secrets.configured) throw new XeroError("XERO_SECRETS_MISSING", RECONNECT_MESSAGES.XERO_SECRETS_MISSING, { reconnect: true });
      const row = await scope.transaction(read);
      if (row?.status !== "connected") {
        throw new XeroError("XERO_NOT_CONNECTED", row?.status === "needs_reconnect" ? (RECONNECT_MESSAGES[row.reconnectReason] || RECONNECT_MESSAGES.XERO_REFRESH_REJECTED) : "Xero is not connected.", { reconnect: true });
      }
      if (keyChanged(row)) {
        await markNeedsReconnect("CLIENT_SECRET_CHANGED");
        throw new XeroError("CLIENT_SECRET_CHANGED", RECONNECT_MESSAGES.CLIENT_SECRET_CHANGED, { reconnect: true });
      }
      const fresh = row.accessTokenEnc && row.accessExpiresAt && new Date(row.accessExpiresAt).getTime() - REFRESH_MARGIN_MS > now().getTime();
      if (fresh && !force) {
        try {
          return { accessToken: cipher().decrypt(row.accessTokenEnc, "access_token"), tenantId: row.tenantId };
        } catch (error) {
          await markNeedsReconnect(reconnectCode(error));
          throw new XeroError("TOKEN_DECRYPT_FAILED", RECONNECT_MESSAGES.TOKEN_DECRYPT_FAILED, { reconnect: true });
        }
      }
      // One refresh at a time in this process; the row lock covers other processes.
      if (!refreshing) {
        refreshing = this.refreshNow({ force }).finally(() => { refreshing = null; });
      }
      return refreshing;
    },

    /** Spend the stored refresh token for new tokens, under a row lock. */
    async refreshNow({ force = false } = {}) {
      try {
        return await scope.transaction(async (tx) => {
          const [row] = await tx.select().from(xeroConnections).for("update");
          if (row?.status !== "connected") throw new XeroError("XERO_NOT_CONNECTED", "Xero is not connected.", { reconnect: true });
          const box = cipher();
          // Another process refreshed while we waited for the lock.
          const fresh = row.accessTokenEnc && row.accessExpiresAt && new Date(row.accessExpiresAt).getTime() - REFRESH_MARGIN_MS > now().getTime();
          if (fresh && !force) return { accessToken: box.decrypt(row.accessTokenEnc, "access_token"), tenantId: row.tenantId };
          const tokens = await client().refresh(box.decrypt(row.refreshTokenEnc, "refresh_token"));
          const at = now();
          await tx.update(xeroConnections).set({
            accessTokenEnc: box.encrypt(tokens.accessToken, "access_token"),
            refreshTokenEnc: box.encrypt(tokens.refreshToken, "refresh_token"),
            accessExpiresAt: new Date(at.getTime() + tokens.expiresInSeconds * 1000),
            refreshIssuedAt: at,
            keyFingerprint: box.fingerprint,
            updatedAt: at,
          }).where(eq(xeroConnections.orgUid, scope.orgUid));
          return { accessToken: tokens.accessToken, tenantId: row.tenantId };
        });
      } catch (error) {
        if (error?.reconnect || error instanceof TokenCryptoError) {
          const code = reconnectCode(error);
          if (code !== "XERO_NOT_CONNECTED") await markNeedsReconnect(code);
          if (error instanceof XeroError) throw error;
          throw new XeroError(code, RECONNECT_MESSAGES[code] || RECONNECT_MESSAGES.TOKEN_DECRYPT_FAILED, { reconnect: true });
        }
        throw error;
      }
    },

    /** An API call Xero refused for the organisation (403, a missing scope): the owner connects again. */
    markNeedsReconnect: (code) => markNeedsReconnect(code),

    /** Called with { type: "connected" | "disconnected" } (the invoice sync resumes on connect). */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
