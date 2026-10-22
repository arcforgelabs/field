// Tenancy (pricing engine phase 0b, docs/PRICING_ENGINE.md "Tenancy").
//
// Every tenant table has a row-level security policy that admits only rows of
// the organisation named by the transaction's `field.org_uid` setting
// (migration 0005_tenancy). Nothing here filters by organisation: the
// database does. This module only opens the transaction the policy reads:
//
//   withOrg(db, orgUid, fn)         one transaction inside an organisation
//   orgScope(db, orgUid)            a handle whose transaction() is withOrg
//   withRequestOrg(db, req, fn)     withOrg for the request's organisation
//
// Each organisation transaction starts with one statement,
//
//   SELECT set_config('role', 'field_app', true),      -- SET LOCAL ROLE, when the login role may
//          set_config('field.org_uid', $1, true)       -- SET LOCAL, parameterised
//
// `field_app` is a NOLOGIN role without BYPASSRLS that can read and write rows
// but not change the schema, so RLS holds even when the login role is a
// superuser (PGlite) or has BYPASSRLS. When the login role cannot switch to
// it, RLS still holds as long as the login role does not bypass it: every
// tenant table has FORCE ROW LEVEL SECURITY, which applies it to the table
// owner too. A login role that bypasses RLS and cannot switch is refused at
// boot (assertRowSecurity).
//
// Outside an organisation transaction a tenant table raises
// "field.org_uid is not set" rather than returning nothing.
import { sql } from "drizzle-orm";
import { queryRows, schema } from "./index.js";

export const APP_ROLE = "field_app";
export const { DEFAULT_ORG_UID } = schema;

const ORG_UID = /^org_[0-9A-Za-z]{1,64}$/;

export class OrgAccessError extends Error {
  constructor(message, { code = "org_required", status = 403 } = {}) {
    super(message);
    this.name = "OrgAccessError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function assertOrgUid(orgUid) {
  if (typeof orgUid !== "string" || !ORG_UID.test(orgUid)) {
    throw new OrgAccessError(`not an organisation uid: ${JSON.stringify(orgUid)}`, { code: "invalid_org" });
  }
  return orgUid;
}

// How this database connection enforces RLS, decided once per Drizzle instance.
const modes = new WeakMap();

/**
 * { user, superuser, bypassRls, canSetRole, enforced, via } for the login
 * role. `via` is "set-role" (switch to field_app), "force" (the login role is
 * subject to FORCE ROW LEVEL SECURITY) or null (RLS would not hold).
 */
export async function inspectRowSecurity(db) {
  const [row] = await queryRows(sql`
    select current_user as "user",
           r.rolsuper as superuser,
           r.rolbypassrls as bypass_rls,
           -- field_app only counts if it cannot bypass RLS itself (roles are cluster-wide).
           coalesce(a.rolsuper or a.rolbypassrls, false) as app_bypasses,
           case when a.oid is not null then pg_has_role(current_user, a.oid, 'MEMBER') else false end as can_set_role
    from pg_roles r left join pg_roles a on a.rolname = ${APP_ROLE}
    where r.rolname = current_user`, db);
  const superuser = Boolean(row?.superuser);
  const bypassRls = Boolean(row?.bypass_rls);
  const canSetRole = Boolean(row?.can_set_role) && !row?.app_bypasses;
  const via = canSetRole ? "set-role" : !superuser && !bypassRls ? "force" : null;
  // Every table with org_uid must still have RLS, FORCE and its policy: a
  // hand-run statement or a schema push could have removed them.
  const unprotected = await queryRows(sql`
    select c.relname as "table"
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'field'
    where a.attname = 'org_uid' and not a.attisdropped
      and not (c.relrowsecurity and c.relforcerowsecurity
               and exists (select 1 from pg_policies p where p.schemaname = 'field' and p.tablename = c.relname
                                                         and p.policyname = c.relname || '_tenant_isolation'))
    order by 1`, db);
  return {
    user: row?.user ?? null,
    superuser,
    bypassRls,
    canSetRole,
    unprotectedTables: unprotected.map((table) => table.table),
    enforced: via !== null && unprotected.length === 0,
    via,
    // In set-role mode only organisation transactions are filtered: a query
    // outside one runs as the login role, which bypasses RLS if it may.
    loginBypasses: superuser || bypassRls,
  };
}

function rowSecurity(db) {
  let mode = modes.get(db);
  if (!mode) {
    mode = inspectRowSecurity(db).catch((error) => {
      modes.delete(db);
      throw error;
    });
    modes.set(db, mode);
  }
  return mode;
}

/**
 * Boot check: refuse a connection on which RLS would not hold. Returns the
 * inspection for logging.
 */
export async function assertRowSecurity(db) {
  const mode = await rowSecurity(db);
  if (mode.unprotectedTables.length) {
    throw new Error(`row-level security is off or incomplete on ${mode.unprotectedTables.join(", ")}: each table with org_uid needs ENABLE and FORCE ROW LEVEL SECURITY and its <table>_tenant_isolation policy`);
  }
  if (!mode.via) {
    throw new Error(
      `row-level security cannot hold for database role ${mode.user}: it ${mode.superuser ? "is a superuser" : "has BYPASSRLS"} and cannot SET ROLE ${APP_ROLE}. Run the migrations as a role with CREATEROLE (it creates ${APP_ROLE}), or connect as a role without BYPASSRLS`,
    );
  }
  return mode;
}

/**
 * Run fn(tx) in one transaction inside organisation `orgUid`. `config` is
 * Drizzle's transaction config ({ isolationLevel, accessMode }).
 */
export async function withOrg(db, orgUid, fn, config) {
  assertOrgUid(orgUid);
  const mode = await rowSecurity(db);
  if (!mode.enforced) await assertRowSecurity(db);
  // Inside a caller's transaction this is a savepoint, and SET LOCAL would
  // outlive it until the caller commits: put the caller's role and setting
  // back (the caller may itself be an organisation transaction).
  const nested = typeof db.rollback === "function";
  const [previous] = nested
    ? await queryRows(sql`select current_setting('field.org_uid', true) as org, current_setting('role') as role`, db)
    : [null];
  const result = await db.transaction(async (tx) => {
    // One round trip: set_config('role', ..., true) is SET LOCAL ROLE.
    await tx.execute(mode.via === "set-role"
      ? sql`select set_config('role', ${APP_ROLE}, true), set_config('field.org_uid', ${orgUid}, true)`
      : sql`select set_config('field.org_uid', ${orgUid}, true)`);
    return fn(tx);
  }, config);
  if (nested) {
    await db.execute(sql`select set_config('role', ${previous?.role || "none"}, true), set_config('field.org_uid', ${previous?.org ?? ""}, true)`);
  }
  return result;
}

/**
 * A handle for code that takes a database and opens its own transactions:
 * `transaction(fn, config)` is withOrg. It has no query methods, so a query
 * outside an organisation transaction fails at once rather than seeing
 * nothing.
 */
export function orgScope(db, orgUid) {
  if (db?.isOrgScope) {
    if (db.orgUid !== orgUid) throw new OrgAccessError("an organisation scope cannot be re-scoped to another organisation");
    return db;
  }
  assertOrgUid(orgUid);
  return Object.freeze({
    isOrgScope: true,
    orgUid,
    db,
    transaction: (fn, config) => withOrg(db, orgUid, fn, config),
  });
}

/** The request's organisation: the signed-in caller's membership. Throws 403 without one. */
export function requestOrgUid(req) {
  const orgUid = req?.fieldOrg?.uid;
  if (!orgUid) throw new OrgAccessError("this request has no organisation");
  return orgUid;
}

/** withOrg for the request's organisation. */
export function withRequestOrg(db, req, fn, config) {
  return withOrg(db, requestOrgUid(req), fn, config);
}

/**
 * The organisation a deployment serves: by slug when FIELD_ORG is set,
 * otherwise the default organisation (DEFAULT_ORG_UID, seeded by 0005). By
 * uid, not slug, because its slug depends on when the database was created
 * (0020_neutral_default_org). `organizations` is a directory, not a tenant
 * table, so this needs no organisation transaction. Throws when it does not
 * exist or is archived.
 */
export async function resolveDeploymentOrg(db, { env = process.env } = {}) {
  const slug = String(env.FIELD_ORG || "").trim().toLowerCase();
  const [row] = slug
    ? await queryRows(sql`select uid, name, slug, status from organizations where slug = ${slug}`, db)
    : await queryRows(sql`select uid, name, slug, status from organizations where uid = ${DEFAULT_ORG_UID}`, db);
  const named = slug ? `organisation "${slug}" (FIELD_ORG)` : `the default organisation (${DEFAULT_ORG_UID})`;
  if (!row) throw new Error(`${named} does not exist`);
  if (row.status !== "active") throw new Error(`${named} is ${row.status}`);
  return { uid: row.uid, name: row.name, slug: row.slug };
}
