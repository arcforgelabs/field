// Settings, Team, Access (#133): the audit trail of command-line tokens
// revoked and connected agents (MCP installations) disconnected. Each event
// says who did it, which token or installation (id and name), whose it was,
// and when. It never holds a token value or hash: callers pass metadata only,
// and `record` copies named fields, never a whole object.
import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";

const { accessAuditEvents } = schema;

export const ACCESS_AUDIT_ACTIONS = Object.freeze(["token_revoked", "mcp_installation_disconnected"]);

function text(value, max = 200) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out.slice(0, max) : null;
}

export function createAccessAuditStore({ db, orgUid = undefined, now = () => new Date() }) {
  if (!db) throw new Error("the access audit store needs a database");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);

  return {
    /**
     * Write one event. `actor` is the caller ({ id, name, email }); `target`
     * is { id, name } of the token or installation; `holder` is { id, name }
     * of the person or service account it belonged to.
     */
    async record(action, { actor = null, target, holder = null }) {
      if (!ACCESS_AUDIT_ACTIONS.includes(action)) throw new Error(`unknown access audit action: ${action}`);
      if (!target?.id) throw new Error("an access audit event needs the target's id");
      const row = {
        uid: `aae_${randomUUID()}`,
        action,
        actorId: text(actor?.id),
        actorName: text(actor?.name || actor?.email),
        targetId: text(target.id),
        targetName: text(target.name),
        holderId: text(holder?.id),
        holderName: text(holder?.name || holder?.email),
        at: now(),
      };
      await scope.transaction((tx) => tx.insert(accessAuditEvents).values(row));
      return publicEvent(row);
    },

    /** The latest events, newest first. */
    async recent(limit = 20) {
      const rows = await scope.transaction((tx) => tx.select().from(accessAuditEvents)
        .orderBy(desc(accessAuditEvents.at), desc(accessAuditEvents.uid))
        .limit(Math.max(1, Math.min(100, Number(limit) || 20))));
      return rows.map(publicEvent);
    },
  };
}

function publicEvent(row) {
  return {
    id: row.uid,
    action: row.action,
    actor: { id: row.actorId ?? null, name: row.actorName ?? null },
    target: { id: row.targetId, name: row.targetName ?? null },
    holder: { id: row.holderId ?? null, name: row.holderName ?? null },
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
  };
}
