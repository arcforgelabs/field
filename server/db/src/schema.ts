import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * DEL-75 toolchain proof only.
 *
 * This table is deliberately not a product entity. It proves that a typed
 * PostgreSQL schema can be generated and queried without creating accidental
 * quote, document, outbox, or customer state. Those entities belong to later
 * approved work.
 */
export const toolchainProbe = pgTable("drizzle_toolchain_probe", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  probeKey: text("probe_key").notNull(),
  payload: jsonb("payload")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
});

export type ToolchainProbe = typeof toolchainProbe.$inferSelect;
export type NewToolchainProbe = typeof toolchainProbe.$inferInsert;

// ---------------------------------------------------------------------------
// Durable file storage (#139). With FIELD_STORAGE=postgres the server mirrors
// its data directory here (server/storage/durable-store.js): file contents are
// content-addressed blobs, each mirrored path points at one, and SQLite
// databases are kept as whole-database images. Boot rebuilds the data
// directory from these tables. Nothing reads them when FIELD_STORAGE is unset.

// bytea: postgres.js returns a Buffer, PGlite a Uint8Array; always a Buffer here.
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  },
});

/** File contents, keyed by their SHA-256 (hex). Shared by every path with the same bytes. */
export const fieldBlobs = pgTable("field_blobs", {
  sha256: text("sha256").primaryKey(),
  bytes: bytea("bytes").notNull(),
});

/** One row per mirrored file: its path relative to the data directory and what it holds. */
export const fieldFiles = pgTable(
  "field_files",
  {
    path: text("path").primaryKey(),
    sha256: text("sha256")
      .notNull()
      .references(() => fieldBlobs.sha256),
    size: bigint("size", { mode: "number" }).notNull(),
    /** Permission bits (st_mode & 0o7777). */
    mode: integer("mode").notNull(),
    mtime: timestamp("mtime", { withTimezone: true, mode: "date", precision: 3 }).notNull(),
  },
  (table) => [index("field_files_sha256_idx").on(table.sha256)],
);

/** Whole-database images of SQLite files (db.serialize()); the newest version is restored at boot. */
export const fieldSqliteImages = pgTable(
  "field_sqlite_images",
  {
    /** The database's path relative to the data directory, e.g. "field.db". */
    name: text("name").notNull(),
    version: integer("version").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.name, table.version] })],
);

export type FieldFile = typeof fieldFiles.$inferSelect;
export type FieldSqliteImage = typeof fieldSqliteImages.$inferSelect;

// ---------------------------------------------------------------------------
// Tenancy (#178, docs/PRICING_ENGINE.md "Tenancy"). One database serves many
// organisations. Every tenant-owned table carries `org_uid` and a row-level
// security policy that admits only rows of the organisation named by the
// transaction's `field.org_uid` setting (server/db-runtime/tenancy.js sets it
// with SET LOCAL). `field_org_uid()` (migration 0005) returns that setting and
// raises when it is unset, so a query that forgot its organisation fails
// loudly instead of seeing nothing. It is also the column default, so inserts
// inside an organisation's transaction need not name it.

/** The organisation every pre-tenancy row belongs to: the default organisation. */
export const DEFAULT_ORG_UID = "org_01M4NF6NV3HW3CCZB7NVB9B157";

export const ORGANIZATION_STATUSES = ["active", "archived"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** Not tenant-scoped itself: the directory the runtime resolves an organisation from. */
export const organizations = pgTable(
  "organizations",
  {
    uid: text("uid").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Clerk Organizations map one-to-one onto organisations; null until linked. */
    clerkOrgId: text("clerk_org_id").unique(),
    status: text("status").$type<OrganizationStatus>().notNull().default("active"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("organizations_slug_key").on(t.slug),
    check("organizations_status_check", sql`${t.status} in ('active', 'archived')`),
    check("organizations_slug_check", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export type Organization = typeof organizations.$inferSelect;

/** `org_uid` on a tenant table: the transaction's organisation unless given. */
const orgUid = () =>
  text("org_uid")
    .notNull()
    .default(sql`field_org_uid()`)
    .references(() => organizations.uid);

/** The one policy every tenant table has: reads and writes only inside the transaction's organisation. */
const tenantIsolation = (table: string) =>
  pgPolicy(`${table}_tenant_isolation`, {
    as: "permissive",
    for: "all",
    using: sql`org_uid = (select field_org_uid())`,
    withCheck: sql`org_uid = (select field_org_uid())`,
  });

// ---------------------------------------------------------------------------
// Field users (#149). With FIELD_AUTH=clerk, people sign in with Clerk and
// these tables decide who they are in Field. `users` is the person (one row
// per email, linked to a Clerk user on first sign-in by verified primary
// email); `org_memberships` is their place in an organisation: role and
// whether they may use it at all. An unknown Clerk user gets a `pending`
// membership and no access until an owner approves it. Roles live here, never
// only in Clerk metadata. Machine credentials (CLI/API tokens, MCP OAuth
// grants) stay Field-issued and are not stored here. Nothing reads these
// tables when FIELD_AUTH is unset.

export const FIELD_USER_ROLES = ["owner", "staff"] as const;
export const FIELD_USER_STATUSES = ["active", "pending", "disabled"] as const;
export type FieldUserRole = (typeof FIELD_USER_ROLES)[number];
export type FieldUserStatus = (typeof FIELD_USER_STATUSES)[number];

/** A person. Not tenant-scoped: one person can belong to several organisations. */
export const fieldUsers = pgTable(
  "users",
  {
    /** Field's user id. Imported users keep their users.json id, so tokens and MCP grants still point at them. */
    id: text("id").primaryKey(),
    /** Set on first Clerk sign-in; null until then (imported or invited users). */
    clerkUserId: text("clerk_user_id").unique(),
    /** Always lowercase; the link key for first sign-in. */
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("users_email_lowercase_check", sql`${table.email} = lower(${table.email})`),
  ],
);

export type FieldUser = typeof fieldUsers.$inferSelect;
export type NewFieldUser = typeof fieldUsers.$inferInsert;

/** A person's role and access in one organisation. */
export const orgMemberships = pgTable(
  "org_memberships",
  {
    orgUid: orgUid(),
    // Restrict: a person is deleted only once no organisation holds them.
    userUid: text("user_uid")
      .notNull()
      .references(() => fieldUsers.id, { onDelete: "restrict" }),
    role: text("role").$type<FieldUserRole>().notNull().default("staff"),
    status: text("status").$type<FieldUserStatus>().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgUid, t.userUid] }),
    index("org_memberships_user_idx").on(t.userUid),
    check("org_memberships_role_check", sql`${t.role} in ('owner', 'staff')`),
    check("org_memberships_status_check", sql`${t.status} in ('active', 'pending', 'disabled')`),
    tenantIsolation("org_memberships"),
  ],
);

export type OrgMembership = typeof orgMemberships.$inferSelect;

// Price catalogue (#148). PostgreSQL is the catalogue's source of truth; the
// legacy SQLite catalog.db is import-only (server/catalog/legacy-import.js).
//
// Identity is `items.uid`: every link (kit components, prices, suppliers,
// conversions, evidence, quote lines) keys on it, so `items.code` can be
// edited. Money and quantities are `numeric` (returned as strings by both
// drivers; server/catalog converts them to numbers at the edge). Timestamps
// are written from the JavaScript clock, never `now()`, so the frozen clock
// of the verification harness also freezes catalogue writes.
//
// Every catalogue table except `units` and `unit_aliases` (shared reference
// data) belongs to an organisation. Child tables carry `org_uid` and point at
// their parent through (org_uid, key), so a link can never cross from one
// organisation into another, even though foreign-key checks ignore row-level
// security. Codes and category names are unique per organisation.
// ---------------------------------------------------------------------------

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull();

/** Canonical units. `toBase` converts to the dimension's base unit; null means not convertible. */
export const units = pgTable(
  "units",
  {
    code: text("code").primaryKey(),
    label: text("label").notNull(),
    dimension: text("dimension").notNull(),
    toBase: numeric("to_base"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    check(
      "units_dimension_check",
      sql`${t.dimension} in ('count','length','area','volume','mass','time','lot','other')`,
    ),
  ],
);

export const unitAliases = pgTable("unit_aliases", {
  alias: text("alias").primaryKey(),
  unitCode: text("unit_code")
    .notNull()
    .references(() => units.code, { onDelete: "cascade" }),
});

/** Per organisation: tax depends on the country. */
export const taxCodes = pgTable(
  "tax_codes",
  {
    orgUid: orgUid(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    rate: numeric("rate").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgUid, t.code] }), tenantIsolation("tax_codes")],
);

export const categories = pgTable(
  "categories",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    name: text("name").notNull(),
    parentId: integer("parent_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("categories_org_name_lower_key").on(t.orgUid, sql`lower(${t.name})`),
    uniqueIndex("categories_org_id_key").on(t.orgUid, t.id),
    // ON DELETE SET NULL ("parent_id") in the migration: only the parent link is cleared.
    foreignKey({
      name: "categories_parent_fk",
      columns: [t.orgUid, t.parentId],
      foreignColumns: [t.orgUid, t.id],
    }).onDelete("set null"),
    tenantIsolation("categories"),
  ],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    uid: text("uid").notNull().unique(),
    name: text("name").notNull(),
    accountNumber: text("account_number"),
    emailInbox: text("email_inbox"),
    defaultMarkupPct: numeric("default_markup_pct"),
    importProfile: jsonb("import_profile").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("suppliers_org_id_key").on(t.orgUid, t.id),
    check("suppliers_status_check", sql`${t.status} in ('active','archived')`),
    tenantIsolation("suppliers"),
  ],
);

/**
 * One row per thing Field prices. `costMode`/`sellMode` say where the current
 * cost and sell come from: the latest `item_prices` row (`manual`, `fixed`),
 * cost plus the row's markup (`markup`), or the kit roll-up of its components
 * (`rollup`, server/catalog/rollup.js).
 */
export const items = pgTable(
  "items",
  {
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Internal notes for estimators; never printed (description is customer-facing). Migration 0007. */
    notes: text("notes"),
    priceReference: text("price_reference"),
    kind: text("kind"),
    /**
     * What the item is (docs/PRICING_ENGINE.md "items"): material, labour,
     * equipment, subcontract, fee or kit. Never a category. Null until set;
     * migration 0007 sets `kit` on every item with components.
     */
    type: text("type"),
    visibility: text("visibility").notNull().default("internal"),
    unitCode: text("unit_code")
      .notNull()
      .references(() => units.code),
    // The unit text as entered when it was an alias of unit_code (e.g. "plant"
    // for each); shown in place of unit_code. Null when it is the code itself.
    unitLabel: text("unit_label"),
    category: text("category"),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    taxCode: text("tax_code").notNull().default("GST"),
    costMode: text("cost_mode").notNull().default("manual"),
    sellMode: text("sell_mode").notNull().default("fixed"),
    pricingBasis: text("pricing_basis"),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    variantOfUid: text("variant_of_uid"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("items_org_code_lower_key").on(t.orgUid, sql`lower(${t.code})`),
    uniqueIndex("items_org_uid_key").on(t.orgUid, t.uid),
    foreignKey({
      name: "items_tax_code_fk",
      columns: [t.orgUid, t.taxCode],
      foreignColumns: [taxCodes.orgUid, taxCodes.code],
    }),
    // ON DELETE SET NULL ("variant_of_uid") in the migration.
    foreignKey({
      name: "items_variant_of_fk",
      columns: [t.orgUid, t.variantOfUid],
      foreignColumns: [t.orgUid, t.uid],
    }).onDelete("set null"),
    index("items_status_idx").on(t.status),
    index("items_category_idx").on(t.category),
    check(
      "items_kind_check",
      sql`${t.kind} is null or ${t.kind} in ('material','labour','plant','subcontract','fee','assembly')`,
    ),
    check(
      "items_type_check",
      sql`${t.type} is null or ${t.type} in ('material','labour','equipment','subcontract','fee','kit')`,
    ),
    check("items_visibility_check", sql`${t.visibility} in ('sellable','internal')`),
    check("items_cost_mode_check", sql`${t.costMode} in ('manual','rollup')`),
    check("items_sell_mode_check", sql`${t.sellMode} in ('fixed','markup','rollup')`),
    check(
      "items_pricing_basis_check",
      sql`${t.pricingBasis} is null or ${t.pricingBasis} in ('per_tonne','per_load','per_m3')`,
    ),
    check("items_status_check", sql`${t.status} in ('active','draft','archived')`),
    check("items_code_not_blank", sql`btrim(${t.code}) <> ''`),
    check("items_not_own_variant", sql`${t.variantOfUid} is null or ${t.variantOfUid} <> ${t.uid}`),
    tenantIsolation("items"),
  ],
);

/** (org_uid, <column>) -> items(org_uid, uid): an item of the same organisation. */
const itemFk = (name: string, t: { orgUid: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({ name, columns: [t.orgUid, column], foreignColumns: [items.orgUid, items.uid] });

/**
 * Legacy item codes (#178 step 2). An item's identity is its uid; a code is
 * only a name something older looks it up by (quote rows' catalogItemCode,
 * json5 recipes and rules, scripts). Every code an item has ever had is a row
 * here, unique per organisation, so it resolves to the same item forever.
 * Migration 0006 backfills every items.code and adds the triggers that keep
 * the table complete: inserting an item records its code here, and
 * items.code can no longer change.
 */
export const itemCodeAliases = pgTable(
  "item_code_aliases",
  {
    orgUid: orgUid(),
    code: text("code").notNull(),
    itemUid: text("item_uid").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("item_code_aliases_org_code_lower_key").on(t.orgUid, sql`lower(${t.code})`),
    index("item_code_aliases_item_idx").on(t.itemUid),
    itemFk("item_code_aliases_item_fk", t, t.itemUid).onDelete("cascade"),
    check("item_code_aliases_code_not_blank", sql`btrim(${t.code}) <> ''`),
    tenantIsolation("item_code_aliases"),
  ],
);

/** Item-specific conversions, e.g. 1 m3 of gravel = 1.6 tonne. */
export const itemUnitConversions = pgTable(
  "item_unit_conversions",
  {
    orgUid: orgUid(),
    itemUid: text("item_uid").notNull(),
    fromUnit: text("from_unit")
      .notNull()
      .references(() => units.code),
    toUnit: text("to_unit")
      .notNull()
      .references(() => units.code),
    factor: numeric("factor").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemUid, t.fromUnit, t.toUnit] }),
    itemFk("item_unit_conversions_item_fk", t, t.itemUid).onDelete("cascade"),
    check("item_unit_conversions_positive", sql`${t.factor} > 0`),
    tenantIsolation("item_unit_conversions"),
  ],
);

export const itemSuppliers = pgTable(
  "item_suppliers",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    itemUid: text("item_uid").notNull(),
    supplierId: integer("supplier_id").notNull(),
    supplierCode: text("supplier_code"),
    supplierDescription: text("supplier_description"),
    packQty: numeric("pack_qty").notNull().default("1"),
    packUnit: text("pack_unit").references(() => units.code),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [
    uniqueIndex("item_suppliers_supplier_code_key").on(t.supplierId, t.supplierCode),
    index("item_suppliers_item_idx").on(t.itemUid),
    itemFk("item_suppliers_item_fk", t, t.itemUid).onDelete("cascade"),
    foreignKey({
      name: "item_suppliers_supplier_fk",
      columns: [t.orgUid, t.supplierId],
      foreignColumns: [suppliers.orgUid, suppliers.id],
    }).onDelete("cascade"),
    tenantIsolation("item_suppliers"),
  ],
);

/**
 * Append-only price history. The current price of an item is its latest row
 * with effective_from <= now (ties: highest id); its id is the `priceId`
 * quote lines record. Rows are never updated or deleted by the app.
 */
export const itemPrices = pgTable(
  "item_prices",
  {
    id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    itemUid: text("item_uid").notNull(),
    supplierId: integer("supplier_id"),
    costPerUnit: numeric("cost_per_unit"),
    markupPct: numeric("markup_pct"),
    sellPrice: numeric("sell_price"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    changedBy: text("changed_by").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("item_prices_item_effective_idx").on(t.itemUid, t.effectiveFrom, t.id),
    itemFk("item_prices_item_fk", t, t.itemUid).onDelete("cascade"),
    // ON DELETE SET NULL ("supplier_id") in the migration.
    foreignKey({
      name: "item_prices_supplier_fk",
      columns: [t.orgUid, t.supplierId],
      foreignColumns: [suppliers.orgUid, suppliers.id],
    }).onDelete("set null"),
    tenantIsolation("item_prices"),
    check(
      "item_prices_source_check",
      sql`${t.source} in ('manual','import','bulk','migration','assembly_rollup')`,
    ),
  ],
);

export const priceImports = pgTable(
  "price_imports",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    uid: text("uid").notNull().unique(),
    supplierId: integer("supplier_id"),
    fileName: text("file_name"),
    fileSha256: text("file_sha256"),
    columnMap: jsonb("column_map").$type<Record<string, unknown>>(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }),
    status: text("status").notNull().default("staged"),
    summary: jsonb("summary").$type<Record<string, unknown>>(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("price_imports_org_id_key").on(t.orgUid, t.id),
    // ON DELETE SET NULL ("supplier_id") in the migration.
    foreignKey({
      name: "price_imports_supplier_fk",
      columns: [t.orgUid, t.supplierId],
      foreignColumns: [suppliers.orgUid, suppliers.id],
    }).onDelete("set null"),
    check("price_imports_status_check", sql`${t.status} in ('staged','applied','discarded')`),
    tenantIsolation("price_imports"),
  ],
);

export const priceImportRows = pgTable(
  "price_import_rows",
  {
    orgUid: orgUid(),
    importId: integer("import_id").notNull(),
    rowNo: integer("row_no").notNull(),
    supplierCode: text("supplier_code"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    match: text("match").notNull(),
    itemUid: text("item_uid"),
    oldCost: numeric("old_cost"),
    newCost: numeric("new_cost"),
    oldSell: numeric("old_sell"),
    newSell: numeric("new_sell"),
    deltaPct: numeric("delta_pct"),
    decision: text("decision"),
  },
  (t) => [
    primaryKey({ columns: [t.importId, t.rowNo] }),
    foreignKey({
      name: "price_import_rows_import_fk",
      columns: [t.orgUid, t.importId],
      foreignColumns: [priceImports.orgUid, priceImports.id],
    }).onDelete("cascade"),
    // ON DELETE SET NULL ("item_uid") in the migration.
    itemFk("price_import_rows_item_fk", t, t.itemUid).onDelete("set null"),
    tenantIsolation("price_import_rows"),
    check(
      "price_import_rows_match_check",
      sql`${t.match} in ('changed','unchanged','new','missing','ambiguous','invalid')`,
    ),
    check(
      "price_import_rows_decision_check",
      sql`${t.decision} is null or ${t.decision} in ('apply','skip','create','archive')`,
    ),
  ],
);

/**
 * Kit components (docs/PRICING_ENGINE.md "kit_components"): what one unit of
 * a kit is made of, with literal quantities. Was `item_components` (the
 * SQLite catalogue's component_children); migration 0007 renamed it and its
 * keys to kit_uid / component_uid. The TypeScript names (`itemComponents`,
 * `parentUid`, `childUid`) are kept so the code that reads it did not move.
 */
export const itemComponents = pgTable(
  "kit_components",
  {
    id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    parentUid: text("kit_uid").notNull(),
    childUid: text("component_uid").notNull(),
    quantity: numeric("quantity").notNull(),
    entryQuantity: numeric("entry_quantity"),
    entryUnit: text("entry_unit").references(() => units.code),
    applicationMode: text("application_mode").notNull().default("proportional"),
    pricingContribution: text("pricing_contribution").notNull().default("included"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("kit_components_kit_component_key").on(t.parentUid, t.childUid),
    index("kit_components_component_idx").on(t.childUid),
    itemFk("kit_components_kit_fk", t, t.parentUid).onDelete("cascade"),
    itemFk("kit_components_component_fk", t, t.childUid).onDelete("restrict"),
    tenantIsolation("kit_components"),
    check("kit_components_application_mode_check", sql`${t.applicationMode} in ('proportional','fixed')`),
    check(
      "kit_components_pricing_contribution_check",
      sql`${t.pricingContribution} in ('included','listed_only')`,
    ),
    check("kit_components_not_self", sql`${t.parentUid} <> ${t.childUid}`),
  ],
);

/** The design's name for the same table. */
export const kitComponents = itemComponents;

// The measured-assembly tables (assembly_params, _vars, _components, _tests,
// _versions) were never written; migration 0007 dropped them. Measured
// formulas are deferred (docs/PRICING_ENGINE.md, decision 4); the recipes
// that need them stay in the quote catalog until phase 4.

/**
 * Field-level audit log for the catalogue. Not a foreign key: history
 * outlives a deleted item. `itemCode` is the code at the time of the change.
 */
export const catalogHistory = pgTable(
  "catalog_history",
  {
    id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    itemUid: text("item_uid"),
    itemCode: text("item_code"),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changedBy: text("changed_by").notNull(),
    reason: text("reason"),
    changedAt: timestamp("changed_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    index("catalog_history_item_idx").on(t.itemUid, t.changedAt),
    index("catalog_history_changed_at_idx").on(t.changedAt),
    tenantIsolation("catalog_history"),
  ],
);

/** Supplier quotes, links and notes behind an item's cost or sell price. */
export const catalogEvidence = pgTable(
  "catalog_evidence",
  {
    id: integer("id").generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    itemUid: text("item_uid").notNull(),
    side: text("side").notNull(),
    kind: text("kind").notNull(),
    filePath: text("file_path"),
    url: text("url"),
    note: text("note"),
    supplier: text("supplier"),
    mimeType: text("mime_type"),
    originalFilename: text("original_filename"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_evidence_item_idx").on(t.itemUid),
    itemFk("catalog_evidence_item_fk", t, t.itemUid).onDelete("cascade"),
    tenantIsolation("catalog_evidence"),
    check("catalog_evidence_side_check", sql`${t.side} in ('buy','sell','general')`),
    check("catalog_evidence_kind_check", sql`${t.kind} in ('file','link','note')`),
  ],
);

/**
 * One row per organisation (id = 1). `version` increases in the same transaction as every
 * catalogue write; it is the catalogue's ETag and the cache key for readers.
 */
export const catalogMeta = pgTable(
  "catalog_meta",
  {
    orgUid: orgUid(),
    id: integer("id").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgUid, t.id] }),
    check("catalog_meta_singleton", sql`${t.id} = 1`),
    tenantIsolation("catalog_meta"),
  ],
);

/**
 * Data migrations that ran (server/data-migrations/): changes to existing
 * records, as opposed to the schema, which run once at boot after the schema
 * migrations, verify themselves and record here what they changed. A
 * migration recorded here never runs again, so a later edit by an operator is
 * never undone by a reboot.
 */
export const dataMigrations = pgTable(
  "data_migrations",
  {
    orgUid: orgUid(),
    id: text("id").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }).notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [primaryKey({ columns: [t.orgUid, t.id] }), tenantIsolation("data_migrations")],
);

// ---------------------------------------------------------------------------
// Quote snapshots (#151). One row per delivery attempt of a quote, invoice or
// receipt: exactly what the customer was sent (line items with their
// catalogue item uids and price ids, totals, recipients) so Field keeps an
// attributable record even after the catalogue or the draft changes. The row
// is written before the email is dispatched (status `prepared`; the send is
// refused if it cannot be written) and marked `sent` with the message id once
// the delivery is recorded. Written only by server/quote-snapshots.js;
// timestamps come from the JavaScript clock.

export const QUOTE_SNAPSHOT_DOCUMENT_TYPES = ["quote", "invoice", "receipt"] as const;
export const QUOTE_SNAPSHOT_STATUSES = ["prepared", "sent"] as const;

export const quoteSnapshots = pgTable(
  "quote_snapshots",
  {
    id: bigint("id", { mode: "number" }).generatedByDefaultAsIdentity().primaryKey(),
    orgUid: orgUid(),
    /** The delivery attempt (quote-delivery outbox) this snapshot belongs to. */
    attemptId: text("attempt_id").notNull(),
    jobId: text("job_id").notNull(),
    documentType: text("document_type").notNull(),
    status: text("status").notNull(),
    quoteVersion: integer("quote_version"),
    documentNumber: text("document_number"),
    milestoneIndex: integer("milestone_index"),
    currency: text("currency"),
    subtotal: numeric("subtotal"),
    tax: numeric("tax"),
    total: numeric("total"),
    /** Customer-facing lines with item uid, price id and frozen values. */
    lines: jsonb("lines").$type<unknown[]>().notNull(),
    /** Totals, catalogue version and pricing-attestation digest. */
    pricing: jsonb("pricing").$type<Record<string, unknown>>().notNull(),
    /** { to, cc, bcc } as addressed. */
    recipients: jsonb("recipients").$type<Record<string, unknown>>().notNull(),
    sentBy: jsonb("sent_by").$type<Record<string, unknown> | null>(),
    pdfSha256: text("pdf_sha256"),
    preparedAt: timestamp("prepared_at", { withTimezone: true, mode: "date" }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    issuanceId: text("issuance_id"),
  },
  (t) => [
    uniqueIndex("quote_snapshots_org_attempt_key").on(t.orgUid, t.attemptId),
    index("quote_snapshots_job_idx").on(t.jobId, t.preparedAt),
    check("quote_snapshots_document_type_check", sql`${t.documentType} in ('quote','invoice','receipt')`),
    check("quote_snapshots_status_check", sql`${t.status} in ('prepared','sent')`),
    tenantIsolation("quote_snapshots"),
  ],
);

// ---------------------------------------------------------------------------
// Issued documents (#223, #178 step 2; docs/PRICING_ENGINE.md
// "document_events and issued_documents"). Every quote, invoice and receipt
// PDF a customer was sent, stored once by SHA-256 and addressable by its own
// uid, with an append-only history of what happened to it. Written only by
// server/documents/. In this step the job files stay the source of truth:
// these tables are filled alongside them (dual-write and backfill) and read
// only by the by-uid routes.
//
// Immutability is enforced in the database (migration 0009): triggers refuse
// UPDATE and DELETE on document_blobs and document_events, and on every
// issued_documents column except `details`; field_app is granted no more
// than that either. Timestamps come from the JavaScript clock.

export const ISSUED_DOCUMENT_TYPES = ["quote", "invoice", "receipt", "credit_note"] as const;
export type IssuedDocumentType = (typeof ISSUED_DOCUMENT_TYPES)[number];
/** Where an issued_documents row came from. */
export const ISSUED_DOCUMENT_SOURCES = [
  "live",
  "ledger-backfill",
  "invoice-revision-backfill",
  "legacy-sent-attachment",
  "legacy-stored-version",
] as const;
export type IssuedDocumentSource = (typeof ISSUED_DOCUMENT_SOURCES)[number];
export const DOCUMENT_EVENTS = ["created", "issued", "emailed", "email_failed", "paid", "voided", "credited"] as const;
export type DocumentEvent = (typeof DOCUMENT_EVENTS)[number];

/**
 * Document bytes, once per organisation per SHA-256. The database checks the
 * hash (`sha256 = encode(sha256(bytes), 'hex')`). Separate from durable
 * storage's field_blobs, which mirrors the data directory and is retired in
 * phase 3b. server/documents/blob-store.js is the only reader and writer,
 * behind put(bytes) -> sha256 and get(sha256) -> bytes, so object storage can
 * replace this table later.
 */
export const documentBlobs = pgTable(
  "document_blobs",
  {
    orgUid: orgUid(),
    sha256: text("sha256").notNull(),
    byteLength: bigint("byte_length", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgUid, t.sha256] }),
    check("document_blobs_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$' and ${t.sha256} = encode(sha256(${t.bytes}), 'hex')`),
    check("document_blobs_byte_length_check", sql`${t.byteLength} = octet_length(${t.bytes})`),
    tenantIsolation("document_blobs"),
  ],
);

/** One row per document a customer was issued, exactly as issued. */
export const issuedDocuments = pgTable(
  "issued_documents",
  {
    /** `doc_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    /** The job (jobs stay in the job store until phase 3b). */
    jobId: text("job_id").notNull(),
    documentType: text("document_type").$type<IssuedDocumentType>().notNull(),
    /** As printed, with the version for a quote: EQ-2501-01 v1, EI-2501-01-M1-R2, ER-2501-01-M1. */
    number: text("number").notNull(),
    quoteVersion: integer("quote_version"),
    /** Invoice revision (1 is the original number, k is -Rk). Null for quotes and receipts. */
    revision: integer("revision"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Who issued it, when known: a user id, else an email or label. */
    issuedBy: text("issued_by"),
    pdfSha256: text("pdf_sha256").notNull(),
    source: text("source").$type<IssuedDocumentSource>().notNull(),
    /** Frozen business, customer and money details where they were available. */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("issued_documents_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("issued_documents_org_type_number_key").on(t.orgUid, t.documentType, t.number),
    index("issued_documents_job_idx").on(t.orgUid, t.jobId, t.issuedAt),
    foreignKey({
      name: "issued_documents_blob_fk",
      columns: [t.orgUid, t.pdfSha256],
      foreignColumns: [documentBlobs.orgUid, documentBlobs.sha256],
    }),
    check("issued_documents_uid_check", sql`${t.uid} ~ '^doc_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("issued_documents_document_type_check", sql`${t.documentType} in ('quote','invoice','receipt','credit_note')`),
    check("issued_documents_source_check", sql`${t.source} in ('live','ledger-backfill','invoice-revision-backfill','legacy-sent-attachment','legacy-stored-version')`),
    check("issued_documents_number_check", sql`btrim(${t.number}) <> ''`),
    check("issued_documents_quote_version_check", sql`${t.quoteVersion} is null or ${t.quoteVersion} > 0`),
    check("issued_documents_revision_check", sql`${t.revision} is null or ${t.revision} > 0`),
    tenantIsolation("issued_documents"),
  ],
);

/**
 * What happened to a document, append-only. `issued_document_uid` is null for
 * an event with no issued document (an email that failed before its document
 * was issued). `idempotency_key` makes a retried write a no-op.
 */
export const documentEvents = pgTable(
  "document_events",
  {
    /** `dev_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    issuedDocumentUid: text("issued_document_uid"),
    jobId: text("job_id").notNull(),
    documentType: text("document_type").$type<IssuedDocumentType>().notNull(),
    event: text("event").$type<DocumentEvent>().notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
    by: text("by"),
    /** Recipients, Gmail message and thread ids, the hash of the bytes sent, the delivery attempt. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("document_events_org_idempotency_key").on(t.orgUid, t.idempotencyKey),
    index("document_events_document_idx").on(t.orgUid, t.issuedDocumentUid, t.at),
    index("document_events_job_idx").on(t.orgUid, t.jobId, t.at),
    foreignKey({
      name: "document_events_issued_document_fk",
      columns: [t.orgUid, t.issuedDocumentUid],
      foreignColumns: [issuedDocuments.orgUid, issuedDocuments.uid],
    }),
    check("document_events_uid_check", sql`${t.uid} ~ '^dev_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("document_events_document_type_check", sql`${t.documentType} in ('quote','invoice','receipt','credit_note')`),
    check("document_events_event_check", sql`${t.event} in ('created','issued','emailed','email_failed','paid','voided','credited')`),
    tenantIsolation("document_events"),
  ],
);

/**
 * The last number allocated per organisation, document type and period
 * (EQ-2501-NN has period 2501). Created now for phase 3, when numbering moves
 * into the database; nothing reads or writes it yet.
 */
export const documentNumberCounters = pgTable(
  "document_number_counters",
  {
    orgUid: orgUid(),
    documentType: text("document_type").$type<IssuedDocumentType>().notNull(),
    period: text("period").notNull(),
    lastValue: integer("last_value").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgUid, t.documentType, t.period] }),
    check("document_number_counters_document_type_check", sql`${t.documentType} in ('quote','invoice','receipt','credit_note')`),
    check("document_number_counters_last_value_check", sql`${t.lastValue} >= 0`),
    tenantIsolation("document_number_counters"),
  ],
);

// ---------------------------------------------------------------------------
// Quotes as rows (#241, #178 phase 3; docs/PRICING_ENGINE.md "Quotes and
// invoices"). One `quotes` row per quote version, its customer-facing
// sections and its lines, each line holding the values it prints. In this
// step the job files stay the source of truth: the rows are written alongside
// them (dual-write after every committed quote change, and a verified
// backfill; server/quotes/) and nothing reads them yet.
//
// Money follows "Numbers, money and rounding": amounts exclude GST; every
// total is whole cents; unit sell, unit cost and quantity have four decimals.
// A line's total is its official amount: round(quantity x unit sell, 2) when
// `line_total_source` is `computed` (the database checks it), or the amount a
// document already issued printed, with the reason, when it is `printed`. GST
// is worked out once on the subtotal per tax rate (server/quotes/totals.js,
// the one totals function; decided 2026-10-12, #178).
//
// A sent quote never changes (migration 0010): once a quote is sent,
// accepted or declined, or has a send time, triggers refuse any insert,
// update or delete of its sections and lines, any change to its money,
// customer or wording, and deleting it, for the table owner as well as
// field_app. Its status may still move on (sent -> accepted, superseded,
// void) and it may gain the issued document it was sent as.
//
// Catalogue links (`item_uid`, `price_uid`, `price_key`) are evidence, not
// foreign keys: the catalogue can still delete an item a quote used, and a
// sent line must keep naming it.

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "superseded", "void"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_LINE_TYPES = ["item", "custom", "component", "note"] as const;
export type QuoteLineType = (typeof QUOTE_LINE_TYPES)[number];
export const LINE_TOTAL_SOURCES = ["computed", "printed"] as const;
export type LineTotalSource = (typeof LINE_TOTAL_SOURCES)[number];

export const quotes = pgTable(
  "quotes",
  {
    /** `qte_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    /** The job (jobs stay in the job store until phase 3b). */
    jobId: text("job_id").notNull(),
    /** As printed: EQ-2501-03. Every version of a quote shares it. */
    number: text("number").notNull(),
    version: integer("version").notNull(),
    status: text("status").$type<QuoteStatus>().notNull().default("draft"),
    title: text("title"),
    scopeText: text("scope_text"),
    termsText: text("terms_text"),
    /** Name, email, phone and site address; frozen once sent. */
    customer: jsonb("customer").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    currency: text("currency").notNull().default("AUD"),
    validUntilOn: date("valid_until_on", { mode: "string" }),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
    taxTotal: numeric("tax_total", { precision: 12, scale: 2 }).notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    /**
     * `computed`: round(subtotal x rate, 2) per rate. `printed`: the GST a
     * document already printed a cent apart, when the tax fell exactly on
     * half a cent and the old renderer rounded it the other way; with the
     * reason in `tax_total_reason`.
     */
    taxTotalSource: text("tax_total_source").$type<LineTotalSource>().notNull().default("computed"),
    taxTotalReason: text("tax_total_reason"),
    /** The catalogue version the lines were last priced against; null when not known (rows mapped from files). */
    catalogVersion: bigint("catalog_version", { mode: "number" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    /** The issued document (#230) this version was sent as. */
    issuedDocumentUid: text("issued_document_uid"),
    /** Hash of what the rows were mapped from, so an unchanged version is not rewritten. */
    sourceDigest: text("source_digest"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
    /** Optimistic concurrency (named so it does not clash with `version`). */
    versionLock: integer("version_lock").notNull().default(1),
  },
  (t) => [
    uniqueIndex("quotes_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("quotes_org_job_version_key").on(t.orgUid, t.jobId, t.version),
    index("quotes_org_number_idx").on(t.orgUid, t.number, t.version),
    foreignKey({
      name: "quotes_issued_document_fk",
      columns: [t.orgUid, t.issuedDocumentUid],
      foreignColumns: [issuedDocuments.orgUid, issuedDocuments.uid],
    }),
    check("quotes_uid_check", sql`${t.uid} ~ '^qte_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("quotes_status_check", sql`${t.status} in ('draft','sent','accepted','declined','superseded','void')`),
    check("quotes_version_check", sql`${t.version} > 0`),
    check("quotes_number_check", sql`btrim(${t.number}) <> ''`),
    check("quotes_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("quotes_total_check", sql`${t.total} = ${t.subtotal} + ${t.taxTotal}`),
    check("quotes_tax_total_source_check", sql`${t.taxTotalSource} in ('computed','printed') and (${t.taxTotalSource} = 'computed' or ${t.taxTotalReason} is not null)`),
    check("quotes_version_lock_check", sql`${t.versionLock} > 0`),
    tenantIsolation("quotes"),
  ],
);

/** The groups the customer sees, flat and ordered. */
export const quoteSections = pgTable(
  "quote_sections",
  {
    /** `qsc_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    quoteUid: text("quote_uid").notNull(),
    title: text("title").notNull(),
    sortOrder: integer("sort_order").notNull(),
    showSubtotal: boolean("show_subtotal").notNull().default(true),
    /** The organizer node it was mapped from, while the files are the source of truth. */
    sourceNodeId: text("source_node_id"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("quote_sections_org_uid_key").on(t.orgUid, t.uid),
    index("quote_sections_quote_idx").on(t.orgUid, t.quoteUid, t.sortOrder),
    foreignKey({
      name: "quote_sections_quote_fk",
      columns: [t.orgUid, t.quoteUid],
      foreignColumns: [quotes.orgUid, quotes.uid],
    }).onDelete("cascade"),
    check("quote_sections_uid_check", sql`${t.uid} ~ '^qsc_[0-9A-HJKMNP-TV-Z]{26}$'`),
    tenantIsolation("quote_sections"),
  ],
);

/** Every line stores the values it prints, whether or not it came from the catalogue. */
export const quoteLines = pgTable(
  "quote_lines",
  {
    /** `qln_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    quoteUid: text("quote_uid").notNull(),
    /** Null for a line outside any section. */
    sectionUid: text("section_uid"),
    /** The line this one is shown under: a kit's component, or a row under a heading. */
    parentLineUid: text("parent_line_uid"),
    sortOrder: integer("sort_order").notNull(),
    /** item (catalogue), custom (typed in, or from the engine), component (shown under a priced line, never counted), note (a heading, no money). */
    lineType: text("line_type").$type<QuoteLineType>().notNull(),
    itemUid: text("item_uid"),
    /** The item_prices row the line was priced from (its id). Null for a rollup kit (see price_key). */
    priceUid: text("price_uid"),
    priceKey: text("price_key"),
    code: text("code"),
    name: text("name").notNull(),
    description: text("description"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitCode: text("unit_code").notNull(),
    unitCost: numeric("unit_cost", { precision: 12, scale: 4 }),
    /**
     * The rate, to four decimals (a historical line keeps the rate it was
     * priced at). A line added from now on takes it rounded to cents. Null
     * for a note, and for an unpriced line (which never counts as zero).
     */
    unitSell: numeric("unit_sell", { precision: 12, scale: 4 }),
    isPriceOverride: boolean("is_price_override").notNull().default(false),
    overrideReason: text("override_reason"),
    taxCode: text("tax_code").notNull(),
    /** Percent: 10 means 10 %. */
    taxRate: numeric("tax_rate", { precision: 7, scale: 3 }).notNull(),
    /** The line's official amount, ex GST. */
    lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
    /**
     * `computed`: round(quantity x unit sell, 2), checked by the database.
     * `printed`: the amount a document already issued printed, where
     * quantity x rate does not give it; why is in `line_total_reason`.
     */
    lineTotalSource: text("line_total_source").$type<LineTotalSource>().notNull().default("computed"),
    lineTotalReason: text("line_total_reason"),
    /** Listed with its price but not in the total (today's "listed only" rows). */
    isOptional: boolean("is_optional").notNull().default(false),
    isSelected: boolean("is_selected").notNull().default(true),
    /** The organizer node it was mapped from, while the files are the source of truth. */
    sourceNodeId: text("source_node_id"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("quote_lines_org_uid_key").on(t.orgUid, t.uid),
    index("quote_lines_quote_idx").on(t.orgUid, t.quoteUid, t.sortOrder),
    index("quote_lines_item_idx").on(t.orgUid, t.itemUid),
    foreignKey({
      name: "quote_lines_quote_fk",
      columns: [t.orgUid, t.quoteUid],
      foreignColumns: [quotes.orgUid, quotes.uid],
    }).onDelete("cascade"),
    foreignKey({
      name: "quote_lines_section_fk",
      columns: [t.orgUid, t.sectionUid],
      foreignColumns: [quoteSections.orgUid, quoteSections.uid],
    }).onDelete("cascade"),
    foreignKey({
      name: "quote_lines_parent_fk",
      columns: [t.orgUid, t.parentLineUid],
      foreignColumns: [t.orgUid, t.uid],
    }).onDelete("cascade"),
    check("quote_lines_uid_check", sql`${t.uid} ~ '^qln_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("quote_lines_line_type_check", sql`${t.lineType} in ('item','custom','component','note')`),
    check("quote_lines_item_check", sql`${t.lineType} <> 'item' or ${t.itemUid} is not null`),
    check("quote_lines_note_check", sql`${t.lineType} <> 'note' or (${t.unitSell} is null and ${t.lineTotal} = 0)`),
    check("quote_lines_line_total_check", sql`case ${t.lineTotalSource}
      when 'computed' then (${t.unitSell} is null and ${t.lineTotal} = 0) or ${t.lineTotal} = round(${t.quantity} * ${t.unitSell}, 2)
      when 'printed' then ${t.lineTotalReason} is not null
      else false end`),
    check("quote_lines_quantity_check", sql`${t.quantity} >= 0`),
    check("quote_lines_selected_check", sql`${t.isOptional} or ${t.isSelected}`),
    check("quote_lines_parent_check", sql`${t.parentLineUid} is null or ${t.parentLineUid} <> ${t.uid}`),
    tenantIsolation("quote_lines"),
  ],
);

export type Quote = typeof quotes.$inferSelect;
export type QuoteSection = typeof quoteSections.$inferSelect;
export type QuoteLine = typeof quoteLines.$inferSelect;
