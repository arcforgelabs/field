// Integration credentials of one organisation (#112): an app's client id and
// client secret, entered by an owner in Settings, Integrations, and stored
// encrypted (box.js) in integration_credentials. Write-only: `status` says
// whether each field is set, when and by whom, and never a value; only the
// integration's own server code reads a value (`read`). Every change writes an
// integration_audit_events row with who and when, never the value.
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { createSecretBox, sealedKeyId } from "./box.js";

const { integrationCredentials, integrationAuditEvents } = schema;

export function createCredentialStore({ db, orgUid = undefined, keyring, now = () => new Date(), logger = console }) {
  if (!db || !keyring) throw new Error("the credential store needs a database and the secrets keyring");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);
  const box = (integration) => createSecretBox({ keyring, orgUid: scope.orgUid, integration });

  async function rows(tx, integration) {
    return tx.select().from(integrationCredentials).where(eq(integrationCredentials.integration, integration));
  }

  async function audit(tx, integration, action, actor, details = {}) {
    await tx.insert(integrationAuditEvents).values({ uid: `iae_${randomUUID()}`, integration, action, actor, at: now(), details });
  }

  return {
    keyring,

    /** For each field: set, when and by whom. Never a value. */
    async status(integration, fields) {
      const found = await scope.transaction((tx) => rows(tx, integration));
      const out = {};
      for (const field of fields) {
        const row = found.find((entry) => entry.field === field);
        out[field] = row ? { set: true, setAt: row.setAt.toISOString(), setBy: row.setBy || null } : { set: false, setAt: null, setBy: null };
      }
      return out;
    },

    /** The values, decrypted: for the integration's own server code only. Throws (fail closed) when the key cannot read them. */
    async read(integration) {
      const found = await scope.transaction((tx) => rows(tx, integration));
      const sealed = box(integration);
      return Object.fromEntries(found.map((row) => [row.field, sealed.open(row.valueEnc, row.field)]));
    },

    /** Set or replace fields, with an audit event. */
    async set(integration, values, { actor = null } = {}) {
      const sealed = box(integration);
      const at = now();
      const entries = Object.entries(values).filter(([, value]) => typeof value === "string" && value);
      const encrypted = entries.map(([field, value]) => {
        const valueEnc = sealed.seal(value, field);
        return { field, valueEnc, keyId: sealedKeyId(valueEnc) };
      });
      await scope.transaction(async (tx) => {
        const before = await rows(tx, integration);
        for (const entry of encrypted) {
          await tx.insert(integrationCredentials).values({ integration, ...entry, setAt: at, setBy: actor })
            .onConflictDoUpdate({ target: [integrationCredentials.orgUid, integrationCredentials.integration, integrationCredentials.field], set: { valueEnc: entry.valueEnc, keyId: entry.keyId, setAt: at, setBy: actor } });
        }
        const fields = encrypted.map((entry) => entry.field);
        await audit(tx, integration, before.some((row) => fields.includes(row.field)) ? "credentials_replaced" : "credentials_set", actor, { fields });
      });
    },

    /** Remove an integration's credentials, with an audit event. */
    async remove(integration, { actor = null } = {}) {
      await scope.transaction(async (tx) => {
        const before = await rows(tx, integration);
        if (!before.length) return;
        await tx.delete(integrationCredentials).where(eq(integrationCredentials.integration, integration));
        await audit(tx, integration, "credentials_removed", actor, { fields: before.map((row) => row.field) });
      });
    },

    /** Write an audit event (connected, disconnected, ...): who and when, never a value. */
    async audit(integration, action, { actor = null, details = {} } = {}) {
      await scope.transaction((tx) => audit(tx, integration, action, actor, details));
    },

    /** The latest audit events, newest first. */
    async history(integration, limit = 10) {
      const found = await scope.transaction((tx) => tx.select().from(integrationAuditEvents)
        .where(eq(integrationAuditEvents.integration, integration))
        .orderBy(desc(integrationAuditEvents.at), desc(integrationAuditEvents.uid))
        .limit(limit));
      return found.map((row) => ({ action: row.action, actor: row.actor || null, at: row.at.toISOString(), details: row.details || {} }));
    },

    /**
     * Rotation: re-encrypt every value an earlier key wrote with the current
     * key (FIELD_SECRETS_KEY_PREVIOUS still holds the earlier one). Returns
     * how many were rewritten. A value no key can read is left, and counted.
     */
    async rewrap() {
      if (!keyring.available) return { rewrapped: 0, unreadable: 0 };
      let rewrapped = 0;
      let unreadable = 0;
      await scope.transaction(async (tx) => {
        for (const row of await tx.select().from(integrationCredentials)) {
          if (row.keyId === keyring.currentId) continue;
          const sealed = box(row.integration);
          try {
            const valueEnc = sealed.seal(sealed.open(row.valueEnc, row.field), row.field);
            await tx.update(integrationCredentials).set({ valueEnc, keyId: keyring.currentId })
              .where(and(eq(integrationCredentials.integration, row.integration), eq(integrationCredentials.field, row.field)));
            rewrapped += 1;
          } catch {
            unreadable += 1;
          }
        }
      });
      if (rewrapped || unreadable) logger.log?.(`[secrets] re-encrypted ${rewrapped} credential(s) with the current key${unreadable ? `; ${unreadable} could not be read with any key` : ""}`);
      return { rewrapped, unreadable };
    },
  };
}
