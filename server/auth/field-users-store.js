// Field users in PostgreSQL (#149): who a signed-in person is in Field, their
// role (owner | staff) and whether they may use Field (active | pending |
// disabled). Used only when FIELD_AUTH=clerk.
//
// A person is a `users` row; their role and access are their membership of an
// organisation (`org_memberships`, #178). Every function takes an organisation
// scope (server/db-runtime/tenancy.js orgScope) and sees only the people with
// a membership in that organisation; a plain Drizzle instance means the
// default organisation. The rows returned combine both: { id, clerkUserId, email, name,
// role, status, orgUid, createdAt, updatedAt }.
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, orgScope } from "../db-runtime/tenancy.js";

const { fieldUsers, orgMemberships } = schema;

export const FIELD_USER_ROLES = ["owner", "staff"];
export const FIELD_USER_STATUSES = ["active", "pending", "disabled"];

export class FieldUserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "FieldUserError";
    this.code = code;
    this.status = status;
  }
}

export function normaliseEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

// Field emails are plain printable ASCII. Lowercasing and comparing non-ASCII
// addresses is locale- and normalisation-dependent (look-alike characters,
// Unicode case folding), and emails are how people are linked, so anything
// else is refused rather than guessed at.
export function assertAsciiEmail(email) {
  const normalised = normaliseEmail(email);
  if (!/^[\x21-\x7e]+$/.test(normalised)) {
    throw new FieldUserError(
      "email_not_ascii",
      "Email addresses in Field must be plain ASCII (no accented or non-Latin characters, no spaces).",
    );
  }
  return normalised;
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function publicFieldUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    linked: Boolean(row.clerkUserId),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function assertRole(role) {
  if (!FIELD_USER_ROLES.includes(role)) {
    throw new FieldUserError("invalid_role", `role must be one of: ${FIELD_USER_ROLES.join(", ")}`);
  }
}

function assertStatus(status) {
  if (!FIELD_USER_STATUSES.includes(status)) {
    throw new FieldUserError("invalid_status", `status must be one of: ${FIELD_USER_STATUSES.join(", ")}`);
  }
}

// 23001 restrict_violation (ON DELETE RESTRICT), 23503 foreign_key_violation.
function isForeignKeyViolation(error) {
  for (let inner = error; inner; inner = inner.cause) {
    if (inner.code === "23001" || inner.code === "23503") return true;
  }
  return false;
}

async function first(query) {
  const rows = await query;
  return rows[0] ?? null;
}

function scoped(db) {
  return db?.isOrgScope ? db : orgScope(db, DEFAULT_ORG_UID);
}

const memberColumns = {
  id: fieldUsers.id,
  clerkUserId: fieldUsers.clerkUserId,
  email: fieldUsers.email,
  name: fieldUsers.name,
  role: orgMemberships.role,
  status: orgMemberships.status,
  orgUid: orgMemberships.orgUid,
  createdAt: orgMemberships.createdAt,
  updatedAt: sql`greatest(${fieldUsers.updatedAt}, ${orgMemberships.updatedAt})`.mapWith(fieldUsers.updatedAt),
};

// People with a membership in the transaction's organisation (RLS admits no other).
function members(tx) {
  return tx.select(memberColumns).from(fieldUsers).innerJoin(orgMemberships, eq(orgMemberships.userUid, fieldUsers.id));
}

function memberById(tx, id) {
  return first(members(tx).where(eq(fieldUsers.id, String(id))).limit(1));
}

export async function countFieldUsers(db) {
  return scoped(db).transaction(async (tx) => {
    const [row] = await tx.select({ count: sql`count(*)::int` }).from(orgMemberships);
    return Number(row.count);
  });
}

export function findFieldUserById(db, id) {
  if (!id) return Promise.resolve(null);
  return scoped(db).transaction((tx) => memberById(tx, id));
}

export function findFieldUserByClerkId(db, clerkUserId) {
  if (!clerkUserId) return Promise.resolve(null);
  return scoped(db).transaction((tx) => first(members(tx).where(eq(fieldUsers.clerkUserId, String(clerkUserId))).limit(1)));
}

export function findFieldUserByEmail(db, email) {
  const normalised = normaliseEmail(email);
  if (!normalised) return Promise.resolve(null);
  return scoped(db).transaction((tx) => first(members(tx).where(eq(fieldUsers.email, normalised)).limit(1)));
}

export async function listFieldUsers(db) {
  return scoped(db).transaction((tx) => members(tx).orderBy(
    // Pending first: they are what an owner needs to act on.
    sql`case ${orgMemberships.status} when 'pending' then 0 when 'active' then 1 else 2 end`,
    asc(orgMemberships.createdAt),
    asc(fieldUsers.email),
  ));
}

// One-time import of today's users.json humans, so the people who use Field
// now keep their access and their ids (tokens and MCP grants refer to
// those ids). Runs only while the organisation has no members: once anyone
// exists here, PostgreSQL is the authority and an owner's removals are never
// undone by a restart. Legacy `admin` becomes `owner`, legacy `user` becomes
// `staff`. Service accounts are machine identities and stay in users.json only.
export async function importLegacyUsers(db, legacyUsers) {
  if ((await countFieldUsers(db)) > 0) return { imported: 0, skipped: "users table already populated" };
  const seen = new Set();
  const rows = [];
  for (const user of Array.isArray(legacyUsers) ? legacyUsers : []) {
    if (!user || (user.kind && user.kind !== "human")) continue;
    const email = normaliseEmail(user.email);
    if (!email || !user.id || seen.has(email)) continue;
    seen.add(email);
    const createdAt = user.createdAt ? new Date(user.createdAt) : new Date();
    const validCreated = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
    rows.push({
      id: String(user.id),
      email,
      name: String(user.name || "").trim() || email.split("@")[0],
      role: user.role === "user" ? "staff" : "owner",
      createdAt: validCreated,
    });
  }
  if (!rows.length) return { imported: 0, skipped: "no human users in users.json" };
  return scoped(db).transaction(async (tx) => {
    const now = new Date();
    await tx.insert(fieldUsers)
      .values(rows.map(({ id, email, name, createdAt }) => ({ id, email, name, createdAt, updatedAt: now })))
      .onConflictDoNothing();
    // Only rows that are this person under this id: never adopt someone else's row.
    const present = await tx.select({ id: fieldUsers.id, email: fieldUsers.email }).from(fieldUsers)
      .where(or(...rows.map((row) => and(eq(fieldUsers.id, row.id), eq(fieldUsers.email, row.email)))));
    const ids = new Set(present.map((row) => row.id));
    const memberships = rows.filter((row) => ids.has(row.id)).map((row) => ({
      userUid: row.id,
      role: row.role,
      status: "active",
      createdAt: row.createdAt,
      updatedAt: now,
    }));
    const inserted = memberships.length
      ? await tx.insert(orgMemberships).values(memberships).onConflictDoNothing().returning({ id: orgMemberships.userUid })
      : [];
    return { imported: inserted.length, skipped: null };
  });
}

// Link a Clerk user to an existing, not-yet-linked member. Returns the updated
// row, or null when the member is gone or was linked meanwhile.
export async function linkClerkUser(db, { id, clerkUserId }) {
  return scoped(db).transaction(async (tx) => {
    if (!(await memberById(tx, id))) return null;
    const updated = await first(
      tx.update(fieldUsers)
        .set({ clerkUserId: String(clerkUserId), updatedAt: new Date() })
        .where(and(eq(fieldUsers.id, id), isNull(fieldUsers.clerkUserId)))
        .returning({ id: fieldUsers.id }),
    );
    return updated ? memberById(tx, id) : null;
  });
}

// The person with this Clerk id or email, members or not. Concurrent first
// requests insert once and both find the winner.
async function personFor(tx, { clerkUserId = null, email }) {
  const conditions = [eq(fieldUsers.email, email)];
  if (clerkUserId) conditions.unshift(eq(fieldUsers.clerkUserId, String(clerkUserId)));
  const rows = await tx.select().from(fieldUsers).where(or(...conditions));
  return rows.find((row) => clerkUserId && row.clerkUserId === String(clerkUserId)) ?? rows[0] ?? null;
}

// A Clerk user Field does not know yet: recorded as pending (no access) so an
// owner can approve them. A person who was removed comes back the same way.
export async function createPendingUser(db, { clerkUserId, email, name }) {
  const normalised = normaliseEmail(email);
  return scoped(db).transaction(async (tx) => {
    await tx.insert(fieldUsers).values({
      id: randomUUID(),
      clerkUserId: String(clerkUserId),
      email: normalised,
      name: String(name || "").trim() || normalised.split("@")[0],
    }).onConflictDoNothing();
    const person = await personFor(tx, { clerkUserId, email: normalised });
    if (!person) return null;
    // That email belongs to someone signed in with another Clerk account: no
    // membership for this one (the caller refuses it as email_linked_elsewhere).
    if (person.clerkUserId && person.clerkUserId !== String(clerkUserId)) return person;
    // A person this organisation does not hold yet (removed earlier, or in
    // another organisation) is linked by their verified email.
    if (!person.clerkUserId) {
      await tx.update(fieldUsers).set({ clerkUserId: String(clerkUserId), updatedAt: new Date() })
        .where(and(eq(fieldUsers.id, person.id), isNull(fieldUsers.clerkUserId)));
    }
    await tx.insert(orgMemberships).values({ userUid: person.id, role: "staff", status: "pending" }).onConflictDoNothing();
    return memberById(tx, person.id);
  });
}

// An owner adds someone ahead of their first sign-in: active, unlinked. They
// link on first sign-in with this email, once Clerk has verified it. Someone
// who already exists as a person (removed earlier, or in another
// organisation) joins with the same identity.
export async function createInvitedUser(db, { email, name, role = "staff" }) {
  const normalised = normaliseEmail(email);
  if (!normalised || !normalised.includes("@")) throw new FieldUserError("invalid_email", "a valid email is required");
  assertAsciiEmail(normalised);
  assertRole(role);
  return scoped(db).transaction(async (tx) => {
    await tx.insert(fieldUsers).values({
      id: randomUUID(),
      email: normalised,
      name: String(name || "").trim() || normalised.split("@")[0],
    }).onConflictDoNothing();
    const person = await personFor(tx, { email: normalised });
    const joined = await tx.insert(orgMemberships)
      .values({ userUid: person.id, role, status: "active" })
      .onConflictDoNothing()
      .returning({ id: orgMemberships.userUid });
    if (!joined.length) throw new FieldUserError("exists", "a user with that email already exists", 409);
    return memberById(tx, person.id);
  });
}

async function activeOwnerCount(tx, { excludingId } = {}) {
  const conditions = [eq(orgMemberships.role, "owner"), eq(orgMemberships.status, "active")];
  if (excludingId) conditions.push(ne(orgMemberships.userUid, excludingId));
  const [row] = await tx.select({ count: sql`count(*)::int` }).from(orgMemberships).where(and(...conditions));
  return Number(row.count);
}

function wouldRemoveOwner(current, next) {
  const wasOwner = current.role === "owner" && current.status === "active";
  const staysOwner = next.role === "owner" && next.status === "active";
  return wasOwner && !staysOwner;
}

async function lockMember(tx, id) {
  const locked = await tx.select({ userUid: orgMemberships.userUid }).from(orgMemberships)
    .where(eq(orgMemberships.userUid, String(id))).limit(1).for("update");
  return locked.length ? memberById(tx, id) : null;
}

// Owner edits: name, role, status. Each organisation always keeps at least one active owner.
export async function updateFieldUser(db, id, patch = {}) {
  return scoped(db).transaction(async (tx) => {
    const current = await lockMember(tx, id);
    if (!current) return null;
    const next = { role: current.role, status: current.status, name: current.name };
    if (patch.role !== undefined) {
      assertRole(patch.role);
      next.role = patch.role;
    }
    if (patch.status !== undefined) {
      assertStatus(patch.status);
      next.status = patch.status;
    }
    if (patch.name !== undefined) {
      next.name = String(patch.name).trim() || current.name;
    }
    if (wouldRemoveOwner(current, next) && (await activeOwnerCount(tx, { excludingId: id })) === 0) {
      throw new FieldUserError("last_owner", "Field needs at least one active owner", 409);
    }
    const now = new Date();
    if (next.name !== current.name) {
      await tx.update(fieldUsers).set({ name: next.name, updatedAt: now }).where(eq(fieldUsers.id, id));
    }
    await tx.update(orgMemberships).set({ role: next.role, status: next.status, updatedAt: now })
      .where(eq(orgMemberships.userUid, id));
    return memberById(tx, id);
  });
}

// Removes the person from the organisation and returns their row, or null
// when they were not a member. The person row goes too unless another
// organisation still holds them, so someone who comes back later is a new
// row with a new id and nothing keyed to the old one (tokens, MCP grants)
// can return. This organisation cannot see the others' memberships; the
// RESTRICT foreign key can, and refuses the delete without saying where.
export async function deleteFieldUser(db, id) {
  return scoped(db).transaction(async (tx) => {
    const current = await lockMember(tx, id);
    if (!current) return null;
    if (wouldRemoveOwner(current, { role: null, status: null }) && (await activeOwnerCount(tx, { excludingId: id })) === 0) {
      throw new FieldUserError("last_owner", "Field needs at least one active owner", 409);
    }
    await tx.delete(orgMemberships).where(eq(orgMemberships.userUid, id));
    try {
      await tx.transaction((savepoint) => savepoint.delete(fieldUsers).where(eq(fieldUsers.id, id)));
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
    }
    return current;
  });
}
