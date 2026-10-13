// The Xero connection of one organisation (#93, phase 1; #112).
//
// Credentials: the Xero app's client id and client secret are entered by an
// owner in Settings, Integrations, and stored encrypted for the organisation
// (server/secrets). XERO_CLIENT_ID and XERO_CLIENT_SECRET, when both are set
// in the deployment environment, override them; the screen says so.
//
// The owner presses Connect: Field records a sign-in in progress (a random
// state, kept only as its SHA-256) and sends the owner to Xero. A web app
// uses Xero's standard authorization code flow with its client secret; Xero
// documents PKCE for apps that cannot keep a secret (docs/XERO.md). Xero
// sends them back to this installation's redirect address with a code; Field
// checks the state, exchanges the code for tokens, lists the organisations
// the tokens reach (GET /connections) and stores the tokens encrypted with
// the same secrets module, under FIELD_SECRETS_KEY. With one organisation it
// is connected; with several the owner chooses one in Settings.
//
// Access tokens are short-lived and refreshed before they expire. Xero
// rotates the refresh token on every refresh, so the new one is stored in the
// same database transaction that read the old one, under a row lock: two
// servers never spend the same refresh token. A refresh Xero rejects, or a
// key that cannot read the stored tokens (FIELD_SECRETS_KEY missing, wrong,
// or rotated without the previous key), marks the connection
// `needs_reconnect` with a code: it fails closed, and invoices wait.
// Disconnect revokes the tokens at Xero (best effort) and clears them here;
// the settings stay. Connect, disconnect and every credential change write
// an audit event (who and when, never a value).
//
// Nothing here logs a token, a code, a credential or a key. The status the
// browser gets says only whether each credential is set, when and by whom.
import { eq } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { createSecretBox, isSealed } from "../secrets/box.js";
import { MESSAGES as KEY_MESSAGES, SecretsKeyError } from "../secrets/keyring.js";
import { XeroError, hashState, newAuthorizationRequest } from "./client.js";
import { XERO_SCOPES } from "./config.js";
import { createTokenCipher } from "./token-crypto.js";

const { xeroConnections, XERO_CREATE_MODES } = schema;

export const XERO_INTEGRATION = "xero";
const CREDENTIAL_FIELDS = ["client_id", "client_secret"];

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
  XERO_CLIENT_REJECTED: "Xero did not accept the app's client id and client secret. Check them, then connect again.",
  XERO_APP_CHANGED: "The Xero app's credentials were replaced, so the sign-in made with the earlier app no longer applies. Connect again.",
  XERO_CREDENTIALS_MISSING: "The Xero app's client id and client secret are not set. Enter them, then connect again.",
  CLIENT_SECRET_CHANGED: "The key that encrypted the stored sign-in changed. Connect again.",
  LEGACY_TOKENS_UNREADABLE: "Field could not move the sign-in stored by an earlier release to FIELD_SECRETS_KEY (the old XERO_CLIENT_SECRET is not set). Connect again.",
  XERO_FORBIDDEN: "Xero refused access to the organisation. Connect again.",
  XERO_SCOPE_MISSING: "Field's Xero sign-in lacks a permission it needs. Connect again.",
  XERO_TOKEN_INVALID: "Xero's sign-in answer was incomplete. Connect again.",
  XERO_TOKEN_REFUSED: "Xero refused Field's sign-in. Connect again.",
  XERO_SECRETS_MISSING: "The Xero app's client id and client secret are not set.",
  TOKEN_DECRYPT_FAILED: "The stored Xero sign-in could not be read. Connect again.",
  SECRETS_KEY_MISSING: `${KEY_MESSAGES.SECRETS_KEY_MISSING} Set it, then connect again.`,
  SECRETS_KEY_INVALID: `${KEY_MESSAGES.SECRETS_KEY_INVALID} Fix it, then connect again.`,
  SECRETS_KEY_PREVIOUS_INVALID: KEY_MESSAGES.SECRETS_KEY_PREVIOUS_INVALID,
  SECRETS_KEY_UNKNOWN: KEY_MESSAGES.SECRETS_KEY_UNKNOWN,
  SECRET_UNREADABLE: `${KEY_MESSAGES.SECRET_UNREADABLE} Connect again.`,
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
  const code = String(error?.code || "");
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "XERO_REFRESH_REJECTED";
}

/**
 * `keyring` from server/secrets/keyring.js; `credentialStore` from
 * server/secrets/credentials.js; `environment` the optional override from
 * config.js readXeroSecrets() (`secrets` is its older name); `http(creds)`
 * builds the client (client.js createXeroHttp) for { clientId, clientSecret }.
 */
export function createXeroConnectionService({
  db,
  orgUid = undefined,
  keyring,
  credentialStore = null,
  environment = undefined,
  secrets = undefined,
  http,
  now = () => new Date(),
  scopes = XERO_SCOPES,
  logger = console,
}) {
  if (!db) throw new Error("createXeroConnectionService needs a database");
  if (!keyring || typeof http !== "function") throw new Error("createXeroConnectionService needs the secrets keyring and an HTTP client factory");
  const override = environment || secrets || { configured: false, status: () => ({ clientIdSet: false, clientSecretSet: false }) };
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);
  const box = createSecretBox({ keyring, orgUid: scope.orgUid, integration: XERO_INTEGRATION });
  const listeners = new Set();
  let refreshing = null;

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

  async function audit(action, actor = null, details = {}) {
    try {
      await credentialStore?.audit(XERO_INTEGRATION, action, { actor, details });
    } catch (error) {
      logger.warn?.(`[xero] the audit event could not be written (${reconnectCode(error)})`);
    }
  }

  /**
   * The app's credentials: the environment override when both are set, else
   * the ones entered in Settings. { clientId, clientSecret, source } or
   * { source: null, problem }.
   */
  async function credentials() {
    if (override.configured) return { clientId: override.clientId, clientSecret: override.clientSecret, source: "environment" };
    if (!keyring.available) return { source: null, problem: keyring.problem || "SECRETS_KEY_MISSING" };
    if (!credentialStore) return { source: null, problem: "XERO_CREDENTIALS_MISSING" };
    try {
      const stored = await credentialStore.read(XERO_INTEGRATION);
      if (stored.client_id && stored.client_secret) return { clientId: stored.client_id, clientSecret: stored.client_secret, source: "settings" };
      return { source: null, problem: "XERO_CREDENTIALS_MISSING" };
    } catch (error) {
      return { source: null, problem: reconnectCode(error) };
    }
  }

  // Fail closed: no key, no credentials, nothing starts.
  async function requireReady() {
    if (!keyring.available) {
      const code = keyring.problem || "SECRETS_KEY_MISSING";
      throw new XeroConnectionError(KEY_MESSAGES[code] || KEY_MESSAGES.SECRETS_KEY_MISSING, { code, statusCode: 409 });
    }
    const creds = await credentials();
    if (!creds.source) {
      throw new XeroConnectionError(creds.problem === "XERO_CREDENTIALS_MISSING" || !creds.problem
        ? "Enter the Xero app's client id and client secret first (Settings, Integrations, Xero)."
        : (KEY_MESSAGES[creds.problem] || "The stored Xero credentials could not be read."), { code: creds.problem || "XERO_CREDENTIALS_MISSING", statusCode: 409 });
    }
    return creds;
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

  async function markNeedsReconnect(code, { tx = null } = {}) {
    const write = (inner) => upsert(inner, { status: "needs_reconnect", reconnectReason: code, accessTokenEnc: null, accessExpiresAt: null });
    if (tx) await write(tx);
    else await scope.transaction(write);
    logger.warn?.(`[xero] the connection needs the owner to connect again (${code})`);
  }

  // Problems with FIELD_SECRETS_KEY are never stored: they are worked out on
  // each call, so fixing the key (a mistyped FIELD_SECRETS_KEY_PREVIOUS, a new
  // key set before the old one was kept) recovers the connection by itself.
  // Until then it fails closed: shown as needing reconnect, nothing is sent.
  const KEY_CODES = new Set(["SECRETS_KEY_MISSING", "SECRETS_KEY_INVALID", "SECRETS_KEY_PREVIOUS_INVALID", "SECRETS_KEY_UNKNOWN", "SECRET_UNREADABLE"]);

  function keyProblemFor(row) {
    if (!row || !["connected", "choose_organisation"].includes(row.status)) return null;
    if (!keyring.available) return keyring.problem || "SECRETS_KEY_MISSING";
    for (const [value, field] of [[row.refreshTokenEnc, "refresh_token"], [row.accessTokenEnc, "access_token"]]) {
      if (!value || !isSealed(value)) continue;
      try {
        box.open(value, field);
      } catch (error) {
        return reconnectCode(error);
      }
    }
    return null;
  }

  // The row as the screen and the sync see it: a key problem shows as
  // needing reconnect, with its reason, without being stored.
  function presented(row) {
    const problem = keyProblemFor(row);
    return problem ? { ...row, status: "needs_reconnect", reconnectReason: problem } : row;
  }

  function keyError(code) {
    return new XeroError(code, RECONNECT_MESSAGES[code] || RECONNECT_MESSAGES.TOKEN_DECRYPT_FAILED, { reconnect: true });
  }

  function notify(event) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  function sealTokens(tokens) {
    return { accessTokenEnc: box.seal(tokens.accessToken, "access_token"), refreshTokenEnc: box.seal(tokens.refreshToken, "refresh_token"), keyFingerprint: null };
  }

  return {
    /** The connection, credentials and settings for the Settings screen. Never a token or a credential. */
    async status() {
      const row = presented(await scope.transaction(read));
      const creds = override.configured ? { source: "environment" } : await credentials();
      return {
        secretsKey: keyring.status(),
        credentials: {
          source: creds.source,
          problem: creds.source ? null : creds.problem || null,
          environment: override.status(),
          environmentOverride: Boolean(override.configured),
          settings: credentialStore
            ? (await credentialStore.status(XERO_INTEGRATION, CREDENTIAL_FIELDS).then((fields) => ({ clientId: fields.client_id, clientSecret: fields.client_secret })))
            : { clientId: { set: false, setAt: null, setBy: null }, clientSecret: { set: false, setAt: null, setBy: null } },
        },
        history: credentialStore ? await credentialStore.history(XERO_INTEGRATION, 8) : [],
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
      const row = presented(await scope.transaction(read));
      return {
        status: row?.status || "disconnected",
        tenantId: row?.tenantId || null,
        tenantName: row?.tenantName || null,
        codesProblem: row?.status === "connected" ? row?.codesProblem || null : null,
        codesMessage: codesMessage(row),
        ...settingsOf(row),
      };
    },

    /**
     * Enter or replace the Xero app's client id and client secret (owners).
     * Stored encrypted for the organisation, with an audit event. Replacing
     * them with another app's ends the connection made with the earlier one.
     */
    async setCredentials({ clientId, clientSecret } = {}, { actor = null } = {}) {
      if (!keyring.available) {
        const code = keyring.problem || "SECRETS_KEY_MISSING";
        throw new XeroConnectionError(KEY_MESSAGES[code], { code, statusCode: 409 });
      }
      if (!credentialStore) throw new XeroConnectionError("Credentials cannot be stored on this server.", { code: "XERO_CREDENTIALS_UNAVAILABLE", statusCode: 503 });
      const id = typeof clientId === "string" ? clientId.trim() : "";
      const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
      if (!/^\S{8,200}$/.test(id) || !/^\S{8,200}$/.test(secret)) {
        throw new XeroConnectionError("Enter both the client id and the client secret from your Xero app, as Xero shows them.", { code: "XERO_CREDENTIALS_INVALID" });
      }
      let before = null;
      try {
        before = (await credentialStore.read(XERO_INTEGRATION)).client_id || null;
      } catch {}
      await credentialStore.set(XERO_INTEGRATION, { client_id: id, client_secret: secret }, { actor });
      const row = await scope.transaction(read);
      if (!override.configured && before && before !== id && row && row.status !== "disconnected") {
        await markNeedsReconnect("XERO_APP_CHANGED");
      }
      return { credentials: (await this.status()).credentials };
    },

    /** Remove the stored credentials (owners). Disconnects first when they are the ones in use. */
    async removeCredentials({ actor = null } = {}) {
      if (!credentialStore) return { removed: false };
      const row = await scope.transaction(read);
      if (!override.configured && row && row.status !== "disconnected") await this.disconnect({ actor });
      await credentialStore.remove(XERO_INTEGRATION, { actor });
      return { removed: true };
    },

    /**
     * Tokens stored by an earlier release (#94: `v1.`, under a key derived
     * from XERO_CLIENT_SECRET) are re-encrypted under FIELD_SECRETS_KEY when
     * both are available; else the connection needs reconnecting. Tokens
     * written with a previous FIELD_SECRETS_KEY are re-encrypted with the
     * current one (rotation). Run at boot. Never throws.
     */
    async upgradeStoredTokens() {
      const audits = [];
      try {
        // One transaction, the row locked (FOR UPDATE), as refreshNow does: a
        // refresh on another server waits, and never loses its new token to
        // this rewrite of an older one.
        const result = await scope.transaction(async (tx) => {
          const [row] = await tx.select().from(xeroConnections).for("update");
          if (!row || (!row.refreshTokenEnc && !row.accessTokenEnc) || !keyring.available) return { outcome: "nothing" };
          const legacy = (value) => typeof value === "string" && value.startsWith("v1.");
          if (legacy(row.refreshTokenEnc) || legacy(row.accessTokenEnc)) {
            try {
              if (!override.clientSecret) throw new Error("no legacy key");
              const old = createTokenCipher({ clientSecret: override.clientSecret, orgUid: scope.orgUid });
              await upsert(tx, {
                refreshTokenEnc: row.refreshTokenEnc ? box.seal(old.decrypt(row.refreshTokenEnc, "refresh_token"), "refresh_token") : null,
                accessTokenEnc: row.accessTokenEnc ? box.seal(old.decrypt(row.accessTokenEnc, "access_token"), "access_token") : null,
                keyFingerprint: null,
              });
              audits.push(["tokens_rewrapped", { from: "xero-client-secret" }]);
              return { outcome: "rewrapped" };
            } catch {
              await upsert(tx, { status: row.status === "disconnected" ? "disconnected" : "needs_reconnect", reconnectReason: "LEGACY_TOKENS_UNREADABLE", accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, keyFingerprint: null });
              audits.push(["tokens_unreadable", { code: "LEGACY_TOKENS_UNREADABLE" }]);
              return { outcome: "needs_reconnect" };
            }
          }
          let values;
          try {
            values = {
              refreshTokenEnc: row.refreshTokenEnc && box.isStale(row.refreshTokenEnc) ? box.seal(box.open(row.refreshTokenEnc, "refresh_token"), "refresh_token") : row.refreshTokenEnc,
              accessTokenEnc: row.accessTokenEnc && box.isStale(row.accessTokenEnc) ? box.seal(box.open(row.accessTokenEnc, "access_token"), "access_token") : row.accessTokenEnc,
            };
          } catch (error) {
            // A key problem: nothing is stored; the connection shows it until the key is fixed.
            return { outcome: "key_problem", code: reconnectCode(error) };
          }
          const rewrapped = values.refreshTokenEnc !== row.refreshTokenEnc || values.accessTokenEnc !== row.accessTokenEnc;
          // A connection an earlier release marked for a key problem recovers
          // once its tokens open again.
          const recovered = row.status === "needs_reconnect" && KEY_CODES.has(row.reconnectReason) && row.tenantId && row.refreshTokenEnc;
          if (!rewrapped && !recovered) return { outcome: "current" };
          await upsert(tx, { ...values, ...(recovered ? { status: "connected", reconnectReason: null } : {}) });
          if (rewrapped) audits.push(["tokens_rewrapped", { from: "previous-key" }]);
          return { outcome: rewrapped ? "rewrapped" : "recovered" };
        });
        for (const [action, details] of audits) await audit(action, null, details);
        if (result.outcome === "rewrapped") logger.log?.("[xero] the stored sign-in was re-encrypted with the current FIELD_SECRETS_KEY");
        if (result.outcome === "needs_reconnect") logger.warn?.("[xero] the sign-in stored by an earlier release could not be re-encrypted (LEGACY_TOKENS_UNREADABLE); the owner connects again");
        if (result.outcome === "key_problem") logger.warn?.(`[xero] the stored sign-in cannot be read with the configured keys (${result.code}); Xero waits until the key is fixed`);
        return result.outcome === "key_problem" ? { outcome: "key_problem", code: result.code } : { outcome: result.outcome };
      } catch (error) {
        logger.warn?.(`[xero] the stored sign-in could not be checked (${reconnectCode(error)})`);
        return { outcome: "error" };
      }
    },

    /** Start connecting: record the sign-in in progress and return Xero's sign-in address. */
    async startConnect({ redirectUri, actor = null }) {
      const creds = await requireReady();
      if (!redirectUri) throw new XeroConnectionError("Set publicUrl, this installation's public address, in the configuration first. Field builds the redirect address from it (docs/XERO.md).", { code: "XERO_PUBLIC_URL_MISSING", statusCode: 409 });
      const { state } = newAuthorizationRequest();
      await scope.transaction((tx) => upsert(tx, {
        pendingStateHash: hashState(state),
        pendingBy: actor,
        pendingExpiresAt: new Date(now().getTime() + STATE_TTL_MS),
      }));
      return { url: http(creds).authorizeUrl({ redirectUri, state, scopes }) };
    },

    /**
     * Xero sent the owner back with `code` and `state`. The state must be the
     * one in progress and unexpired. The callback needs no sign-in, so a
     * wrong state changes nothing: only the owner's own state is spent (used
     * or expired), and a guessed request cannot break a sign-in in progress.
     * Returns the new connection status.
     */
    async completeConnect({ code, state, redirectUri }) {
      const creds = await requireReady();
      if (!state || !code) throw new XeroConnectionError("Xero did not return a sign-in code.", { code: "XERO_CALLBACK_INCOMPLETE" });
      const pending = await scope.transaction(async (tx) => {
        const row = await read(tx);
        const ours = Boolean(row?.pendingStateHash) && row.pendingStateHash === hashState(state);
        if (!ours) return null;
        await upsert(tx, { pendingStateHash: null, pendingBy: null, pendingExpiresAt: null });
        return row.pendingExpiresAt && new Date(row.pendingExpiresAt) > now() ? row : null;
      });
      if (!pending) throw new XeroConnectionError("This Xero sign-in was not started here, was used already or took too long. Press Connect again.", { code: "XERO_STATE_INVALID", statusCode: 400 });
      const client = http(creds);
      const tokens = await client.exchangeCode({ code, redirectUri });
      const tenants = (await client.connections(tokens.accessToken))
        .filter((entry) => !entry.tenantType || entry.tenantType === "ORGANISATION")
        .map((entry) => ({ tenantId: String(entry.tenantId), tenantName: String(entry.tenantName || ""), connectionId: String(entry.id || "") }));
      if (!tenants.length) throw new XeroConnectionError("No Xero organisation was connected. Press Connect again and choose one.", { code: "XERO_NO_ORGANISATION", statusCode: 409 });
      const at = now();
      const sealed = {
        ...sealTokens(tokens),
        accessExpiresAt: new Date(at.getTime() + tokens.expiresInSeconds * 1000),
        refreshIssuedAt: at,
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
      await audit("connected", pending.pendingBy, { source: creds.source, status: result });
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
      await audit("connected", actor, { status: "connected", chose: true });
      await this.checkCodes();
      notify({ type: "connected" });
      return { status: result };
    },

    /** Revoke at Xero (best effort) and forget the tokens and organisation. Settings stay. */
    async disconnect({ actor = null } = {}) {
      const row = await scope.transaction(read);
      if (row?.refreshTokenEnc && isSealed(row.refreshTokenEnc) && keyring.available) {
        try {
          const creds = await credentials();
          if (creds.source) await http(creds).revoke(box.open(row.refreshTokenEnc, "refresh_token"));
        } catch (error) {
          logger.warn?.(`[xero] revoking the refresh token at Xero failed (${reconnectCode(error)}); Field forgets it anyway. Remove Field in Xero's Connected apps if it is still listed.`);
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
      await audit("disconnected", actor);
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
            warning = `Saved, but Field could not check these codes with Xero (${codes.code}). Invoices wait until Field can check them; it tries again by itself.`;
            checked = { codesProblem: "XERO_CODES_UNCHECKED", codesCheckedAt: null };
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
     * the organisation's, or could not be checked. Never throws.
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
        logger.warn?.(`[xero] the saved codes could not be checked (${reconnectCode(error)})`);
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
        const creds = await credentials();
        if (!creds.source) throw new XeroError(creds.problem || "XERO_CREDENTIALS_MISSING", "The Xero app's credentials are not available.", { reconnect: true });
        const client = http(creds);
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
        const code = reconnectCode(error);
        logger.warn?.(`[xero] the accounts and tax rates could not be read (${code})`);
        return { available: false, code, accounts: [], taxRates: [] };
      }
    },

    /**
     * Run `fn({ accessToken, tenantId })` with a fresh access token for the
     * connected organisation. Refreshes first when the token is about to
     * expire, and once more when Xero answers 401. A rejected refresh, or a
     * key that cannot read the tokens, marks the connection `needs_reconnect`
     * and throws a XeroError with `reconnect: true`.
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
      const row = await scope.transaction(read);
      if (row?.status === "connected" && !keyring.available) throw keyError(keyring.problem || "SECRETS_KEY_MISSING");
      if (row?.status !== "connected") {
        throw new XeroError("XERO_NOT_CONNECTED", row?.status === "needs_reconnect" ? (RECONNECT_MESSAGES[row.reconnectReason] || RECONNECT_MESSAGES.XERO_REFRESH_REJECTED) : "Xero is not connected.", { reconnect: true });
      }
      if (!isSealed(row.refreshTokenEnc)) {
        // Stored by an earlier release: move it under FIELD_SECRETS_KEY first.
        await this.upgradeStoredTokens();
        const again = await scope.transaction(read);
        if (again?.status === "connected" && !isSealed(again.refreshTokenEnc)) throw keyError("TOKEN_DECRYPT_FAILED");
        return this.accessToken({ force });
      }
      const fresh = row.accessTokenEnc && row.accessExpiresAt && new Date(row.accessExpiresAt).getTime() - REFRESH_MARGIN_MS > now().getTime();
      if (fresh && !force) {
        try {
          return { accessToken: box.open(row.accessTokenEnc, "access_token"), tenantId: row.tenantId };
        } catch (error) {
          // A key problem: fail closed now, store nothing.
          throw keyError(reconnectCode(error));
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
        const creds = await credentials();
        if (!creds.source) throw new XeroError(creds.problem || "XERO_CREDENTIALS_MISSING", RECONNECT_MESSAGES[creds.problem] || RECONNECT_MESSAGES.XERO_CREDENTIALS_MISSING, { reconnect: true });
        return await scope.transaction(async (tx) => {
          const [row] = await tx.select().from(xeroConnections).for("update");
          if (row?.status !== "connected") throw new XeroError("XERO_NOT_CONNECTED", "Xero is not connected.", { reconnect: true });
          // Another process refreshed while we waited for the lock.
          const fresh = row.accessTokenEnc && row.accessExpiresAt && new Date(row.accessExpiresAt).getTime() - REFRESH_MARGIN_MS > now().getTime();
          if (fresh && !force) return { accessToken: box.open(row.accessTokenEnc, "access_token"), tenantId: row.tenantId };
          const tokens = await http(creds).refresh(box.open(row.refreshTokenEnc, "refresh_token"));
          const at = now();
          await tx.update(xeroConnections).set({
            ...sealTokens(tokens),
            accessExpiresAt: new Date(at.getTime() + tokens.expiresInSeconds * 1000),
            refreshIssuedAt: at,
            updatedAt: at,
          }).where(eq(xeroConnections.orgUid, scope.orgUid));
          return { accessToken: tokens.accessToken, tenantId: row.tenantId };
        });
      } catch (error) {
        if (error?.reconnect || error instanceof SecretsKeyError) {
          const code = reconnectCode(error);
          // Xero's refusals are stored; key problems never are (they recover).
          if (code !== "XERO_NOT_CONNECTED" && !KEY_CODES.has(code)) await markNeedsReconnect(code);
          if (error instanceof XeroError) throw error;
          throw new XeroError(code, RECONNECT_MESSAGES[code] || RECONNECT_MESSAGES.TOKEN_DECRYPT_FAILED, { reconnect: true });
        }
        throw error;
      }
    },

    /** An API call Xero refused for the organisation (403, a missing scope): the owner connects again. */
    markNeedsReconnect: (code) => (KEY_CODES.has(code) ? undefined : markNeedsReconnect(code)),

    /** Called with { type: "connected" | "disconnected" | "settings" } (the invoice sync resumes). */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
