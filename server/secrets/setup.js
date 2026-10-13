// An integration's Connect wizard, per organisation (Settings, Integrations,
// Xero; docs/INTEGRATIONS.md "Setting up the key in the browser").
//
// The step an owner reached is kept in integration_setup, so the wizard
// resumes after a republish. When FIELD_SECRETS_KEY is not usable yet, the
// browser generates the key and encrypts the app's credentials with it
// (shared/secrets-web.js). The server stores only those `fs1` values and the
// key's id as pending credentials: never the key, never a plain value. Once
// the deployment has the key, `promote` reads them with box.js, stores them
// as the integration's credentials (encrypted again, with the current key)
// and writes an audit event. Every step writes an audit event without a
// value.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { KEY_ID, isWellFormedSealed } from "../../shared/secrets-web.js";
import { createSecretBox, sealedKeyId } from "./box.js";

const { integrationSetup, integrationCredentials, integrationAuditEvents } = schema;

/** The keyring problems under which the browser may store credentials encrypted with a key it made. */
const PENDING_ALLOWED = new Set(["SECRETS_KEY_MISSING", "SECRETS_KEY_INVALID"]);

/** Steps the browser may record. `done` ends the wizard. */
export const SETUP_STEPS = Object.freeze(["app", "credentials", "done"]);

export class SetupError extends Error {
  constructor(message, { code = "SETUP_INVALID", statusCode = 400 } = {}) {
    super(message);
    this.name = "SetupError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * `fields` is what the integration's pending credentials hold (for Xero,
 * client_id and client_secret), `valid(values)` checks the plain values once
 * they can be read.
 */
export function createIntegrationSetup({ db, orgUid = undefined, keyring, integration, fields, valid = () => true, now = () => new Date(), logger = console }) {
  if (!db || !keyring || !integration || !Array.isArray(fields) || !fields.length) throw new Error("the integration setup needs a database, the keyring, the integration and its fields");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);
  const box = createSecretBox({ keyring, orgUid: scope.orgUid, integration });

  async function read(tx) {
    const [row] = await tx.select().from(integrationSetup).where(eq(integrationSetup.integration, integration));
    return row || null;
  }

  async function audit(tx, action, actor, details = {}) {
    await tx.insert(integrationAuditEvents).values({ uid: `iae_${randomUUID()}`, integration, action, actor, at: now(), details });
  }

  async function save(tx, values) {
    const at = now();
    await tx.insert(integrationSetup).values({ integration, ...values, updatedAt: at })
      .onConflictDoUpdate({ target: [integrationSetup.orgUid, integrationSetup.integration], set: { ...values, updatedAt: at } });
  }

  // Read every pending value with the key that wrote it. Throws when the key
  // is not on the keyring or a value does not open.
  function openPending(row) {
    const out = {};
    for (const field of fields) out[field] = box.open(row.pendingValues?.[field], field);
    return out;
  }

  return {
    orgUid: scope.orgUid,

    /**
     * Where the wizard is, for an owner's screen. Promotes pending credentials
     * first when the key has arrived. `problem` is PENDING_KEY_MISMATCH when
     * the deployment has a key but not the one the browser generated, and
     * PENDING_UNREADABLE when a value does not open with it.
     */
    async state() {
      await this.promote();
      const row = await scope.transaction(read);
      let problem = null;
      if (row?.pendingKeyId && keyring.available) {
        if (!keyring.key(row.pendingKeyId)) problem = "PENDING_KEY_MISMATCH";
        else problem = "PENDING_UNREADABLE";
      }
      return {
        orgUid: scope.orgUid,
        step: row?.step || null,
        pending: row?.pendingKeyId
          ? { keyId: row.pendingKeyId, fields: Object.keys(row.pendingValues || {}), storedAt: row.pendingAt?.toISOString() || null, storedBy: row.pendingBy || null }
          : null,
        problem,
      };
    },

    /** Record a step the owner finished (`app`, `credentials`), or end the wizard (`done`). */
    async recordStep(step, { actor = null } = {}) {
      if (!SETUP_STEPS.includes(step)) throw new SetupError("That is not a step of the wizard.", { code: "SETUP_STEP_INVALID" });
      await scope.transaction(async (tx) => {
        const row = await read(tx);
        if (step === "done") {
          if (row?.pendingKeyId) throw new SetupError("Credentials are still waiting for the key. Republish with the key, or start again.", { code: "SETUP_PENDING", statusCode: 409 });
          if (row) await tx.delete(integrationSetup).where(eq(integrationSetup.integration, integration));
        } else if (!row?.pendingKeyId) {
          await save(tx, { step, updatedBy: actor });
        }
        await audit(tx, "setup_step", actor, { step });
      });
      return this.state();
    },

    /**
     * Store credentials the browser encrypted with a key the server does not
     * have. Refused unless every field is a well-formed fs1 value written with
     * `keyId`, and while the deployment already has a usable key (then the
     * server encrypts them itself).
     */
    async storePending({ keyId, values }, { actor = null } = {}) {
      // Only while there is no working key to replace: FIELD_SECRETS_KEY is
      // missing, or its value cannot be used. A wrong previous key, or any
      // other problem, is fixed where it is; the wizard never replaces a key
      // that works.
      if (!PENDING_ALLOWED.has(keyring.problem)) {
        if (keyring.problem === "SECRETS_KEY_PREVIOUS_INVALID") throw new SetupError("Your previous key setting is wrong: fix FIELD_SECRETS_KEY_PREVIOUS.", { code: "SECRETS_KEY_PREVIOUS_INVALID", statusCode: 409 });
        throw new SetupError("FIELD_SECRETS_KEY is already set. Enter the credentials as usual.", { code: "SECRETS_KEY_SET", statusCode: 409 });
      }
      if (typeof keyId !== "string" || !KEY_ID.test(keyId)) throw new SetupError("That is not a key id.", { code: "PENDING_INVALID" });
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new SetupError("Send the encrypted credentials.", { code: "PENDING_INVALID" });
      const names = Object.keys(values);
      if (names.length !== fields.length || !fields.every((field) => isWellFormedSealed(values[field], keyId))) {
        throw new SetupError("Each credential must be encrypted in the browser with the new key.", { code: "PENDING_INVALID" });
      }
      const pendingValues = Object.fromEntries(fields.map((field) => [field, values[field]]));
      await scope.transaction(async (tx) => {
        const at = now();
        await save(tx, { step: "key", pendingValues, pendingKeyId: keyId, pendingAt: at, pendingBy: actor, updatedBy: actor });
        await audit(tx, "pending_credentials_stored", actor, { fields: [...fields], keyId });
      });
      return this.state();
    },

    /** Forget pending credentials, and start the wizard again from step 2. */
    async discardPending({ actor = null } = {}) {
      await scope.transaction(async (tx) => {
        const row = await read(tx);
        if (!row) return;
        await save(tx, { step: "app", pendingValues: null, pendingKeyId: null, pendingAt: null, pendingBy: null, updatedBy: actor });
        if (row.pendingKeyId) await audit(tx, "pending_credentials_discarded", actor, { keyId: row.pendingKeyId });
      });
      return this.state();
    },

    /**
     * Once the deployment has the key: read the pending credentials, store
     * them as the integration's credentials under the current key, and clear
     * them, in one transaction, with audit events. Does nothing without
     * pending credentials or a usable key; a key that cannot read them is left
     * for the screen to explain. Never throws.
     */
    async promote() {
      if (!keyring.available) return { promoted: false };
      try {
        return await scope.transaction(async (tx) => {
          const [row] = await tx.select().from(integrationSetup).where(eq(integrationSetup.integration, integration)).for("update");
          if (!row?.pendingKeyId) return { promoted: false };
          // Credentials stored after these were pending are newer: the pending
          // ones are stale. Forget them, never overwrite.
          const stored = await tx.select({ field: integrationCredentials.field, setAt: integrationCredentials.setAt }).from(integrationCredentials).where(eq(integrationCredentials.integration, integration));
          if (row.pendingAt && stored.some((entry) => fields.includes(entry.field) && entry.setAt > row.pendingAt)) {
            await tx.update(integrationSetup).set({ pendingValues: null, pendingKeyId: null, pendingAt: null, pendingBy: null, updatedAt: now() })
              .where(eq(integrationSetup.integration, integration));
            await audit(tx, "pending_credentials_discarded", null, { reason: "newer_credentials", keyId: row.pendingKeyId });
            return { promoted: false, discarded: true };
          }
          if (!keyring.key(row.pendingKeyId)) return { promoted: false };
          let values;
          try {
            values = openPending(row);
          } catch {
            return { promoted: false, problem: "PENDING_UNREADABLE" };
          }
          if (!valid(values)) return { promoted: false, problem: "PENDING_UNREADABLE" };
          const at = now();
          const actor = row.pendingBy || null;
          const existing = stored;
          for (const field of fields) {
            const valueEnc = box.seal(values[field], field);
            await tx.insert(integrationCredentials).values({ integration, field, valueEnc, keyId: sealedKeyId(valueEnc), setAt: at, setBy: actor })
              .onConflictDoUpdate({ target: [integrationCredentials.orgUid, integrationCredentials.integration, integrationCredentials.field], set: { valueEnc, keyId: sealedKeyId(valueEnc), setAt: at, setBy: actor } });
          }
          await tx.update(integrationSetup).set({ step: "connect", pendingValues: null, pendingKeyId: null, pendingAt: null, pendingBy: null, updatedAt: at })
            .where(eq(integrationSetup.integration, integration));
          await audit(tx, existing.some((entry) => fields.includes(entry.field)) ? "credentials_replaced" : "credentials_set", actor, { fields: [...fields], source: "wizard" });
          await audit(tx, "pending_credentials_promoted", actor, { fields: [...fields], keyId: row.pendingKeyId });
          logger.log?.(`[secrets] ${integration}: credentials entered before FIELD_SECRETS_KEY was set are now stored with it`);
          return { promoted: true };
        });
      } catch (error) {
        logger.warn?.(`[secrets] ${integration}: pending credentials could not be stored (${/^[A-Z0-9_]{1,64}$/.test(String(error?.code || "")) ? error.code : "error"})`);
        return { promoted: false, problem: "PROMOTE_FAILED" };
      }
    },
  };
}
