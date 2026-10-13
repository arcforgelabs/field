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
 * Drizzle toolchain proof only.
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
// Durable file storage. With FIELD_STORAGE=postgres the server mirrors
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
// Tenancy (docs/PRICING_ENGINE.md "Tenancy"). One database serves many
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
// Field users. With FIELD_AUTH=clerk, people sign in with Clerk and
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

// Price catalogue. PostgreSQL is the catalogue's source of truth; the
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
 * Legacy item codes (code retirement step 2). An item's identity is its uid; a code is
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
// Quote snapshots. One row per delivery attempt of a quote, invoice or
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
// Issued documents (phase 3 step 2; docs/PRICING_ENGINE.md
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
 * (INV-2026-10-N has period 2026-10). The invoice issue service (step 4b,
 * server/invoices/issue.js) advances the `invoice` counter inside the issue
 * transaction, so a number is used only by an invoice that was issued.
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
// Quotes as rows (#6, pricing engine phase 3; docs/PRICING_ENGINE.md "Quotes and
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
// the one totals function; decided 2026-10-12).
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
    /** The issued document this version was sent as. */
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
    // Display (#10, migration 0011), as on quote_lines.
    isExcluded: boolean("is_excluded").notNull().default(false),
    amountBlank: boolean("amount_blank").notNull().default(false),
    isCollapsed: boolean("is_collapsed").notNull().default(false),
    rowStyle: text("row_style"),
    notes: text("notes"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("quote_sections_org_uid_key").on(t.orgUid, t.uid),
    check("quote_sections_row_style_check", sql`${t.rowStyle} is null or ${t.rowStyle} in ('branded','bold','normal')`),
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
    // Display (#10, migration 0011): what the customer documents print, so
    // a quote renders from its rows exactly as it did from its files.
    /** Excluded from the price: not printed and never counted (kept for the editor). */
    isExcluded: boolean("is_excluded").notNull().default(false),
    /** false: the amount is hidden ("Included", or blank with `amount_blank`). */
    showAmount: boolean("show_amount").notNull().default(true),
    amountBlank: boolean("amount_blank").notNull().default(false),
    /** The rows under it are not printed. */
    isCollapsed: boolean("is_collapsed").notNull().default(false),
    /** `branded`, `bold` or `normal`; null for the default by depth. */
    rowStyle: text("row_style"),
    /** Internal notes on the row; never printed. */
    notes: text("notes"),
    /** How documents style it: `row`, `group` (a heading or a group's total) or `generated` (an engine breakdown). */
    rowKind: text("row_kind").notNull().default("row"),
    /** The rate a document prints beside the amount when it is not `unit_sell` (a fixed price); null otherwise. */
    displayUnitSell: numeric("display_unit_sell", { precision: 12, scale: 4 }),
    /** The cost behind the line's amount, ex GST; internal, never printed. */
    lineCost: numeric("line_cost", { precision: 12, scale: 2 }),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("quote_lines_org_uid_key").on(t.orgUid, t.uid),
    check("quote_lines_row_style_check", sql`${t.rowStyle} is null or ${t.rowStyle} in ('branded','bold','normal')`),
    check("quote_lines_row_kind_check", sql`${t.rowKind} in ('row','group','generated')`),
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

// The R2 replica of issued document bytes (#12; docs/REPLIT.md "Issued
// documents in R2"). PostgreSQL stays the store of record: document_blobs is
// written in the issue transaction as before, and after it commits the bytes
// are copied to a locked R2 bucket at `<org_uid>/<sha256>`. One row per blob
// that replication has tried: when it landed (`r2_replicated_at`), how many
// attempts it took, when the next one is due, and the last error as a short
// code (never a message, so no credential can end up here). A blob with no
// row, or a row with no `r2_replicated_at`, is pending. Written only by
// server/documents/replicator.js. Migration 0012 refuses DELETE, TRUNCATE
// and any UPDATE of a row already replicated.

export const documentBlobReplicas = pgTable(
  "document_blob_replicas",
  {
    orgUid: orgUid(),
    sha256: text("sha256").notNull(),
    r2ReplicatedAt: timestamp("r2_replicated_at", { withTimezone: true, mode: "date" }),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    /** A short code (R2_UNREACHABLE, R2_OBJECT_MISMATCH, ...), never a message. */
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgUid, t.sha256] }),
    foreignKey({
      name: "document_blob_replicas_blob_fk",
      columns: [t.orgUid, t.sha256],
      foreignColumns: [documentBlobs.orgUid, documentBlobs.sha256],
    }),
    index("document_blob_replicas_pending_idx").on(t.orgUid, t.nextAttemptAt).where(sql`${t.r2ReplicatedAt} is null`),
    check("document_blob_replicas_attempts_check", sql`${t.attempts} >= 0`),
    check("document_blob_replicas_last_error_check", sql`${t.lastError} is null or ${t.lastError} ~ '^[A-Z0-9_]{1,64}$'`),
    tenantIsolation("document_blob_replicas"),
  ],
);

// ---------------------------------------------------------------------------
// Invoices, payments and receipts as rows (#27, pricing engine phase 3 step
// 4a; docs/PRICING_ENGINE.md "Invoices and payments"). In this step the job
// files (milestone-invoices/state.json) stay the source of truth: the rows
// are written alongside them after every committed milestone change and by a
// verified backfill (server/invoices/), and nothing reads them yet.
//
// Numbers stay exactly as issued (EI-…-M1, EI-…-M1-R2, ER-…-M1). An invoice
// revision superseded in place is its own row, `credited`; step 4b (#28) adds
// the credit note that corrects it and stops revising in place.
// `credit_notes` and `credit_note_lines` are created now for that step and
// have no writer yet.
//
// Money follows "Numbers, money and rounding" as quote rows do. An issued
// invoice keeps the totals it was issued with: its GST is `printed` (with the
// reason) where a milestone's GST, allocated from the quote's, differs from
// GST worked out on its own subtotal.
//
// Issued never changes (migration 0013): once an invoice or credit note has
// an issue time, triggers refuse any change to its number, money, lines or
// issue time, and deleting it, for the table owner as well as field_app. Its
// status may still move on (issued -> paid, credited, void), its amount paid
// and due date follow payments and terms, and links that were missing may be
// filled once. Payments are never deleted: a payment is voided. Receipts are
// issued when written and may only be voided.

export const INVOICE_KINDS = ["deposit", "progress", "final", "variation"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const INVOICE_STATUSES = ["draft", "issued", "paid", "void", "credited"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const CREDIT_NOTE_STATUSES = ["draft", "issued", "void"] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];
export const RECEIPT_STATUSES = ["issued", "void"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
export const INVOICE_LINE_TYPES = ["claim", "item", "custom", "note"] as const;
export type InvoiceLineType = (typeof INVOICE_LINE_TYPES)[number];

/** A job's payment schedule: one row per milestone, in order. */
export const paymentMilestones = pgTable(
  "payment_milestones",
  {
    /** `pms_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    jobId: text("job_id").notNull(),
    /** The quote version the schedule bills; null while that version has no rows (or a legacy job). */
    quoteUid: text("quote_uid"),
    label: text("label").notNull(),
    /** Percent of the quote total (50 means 50 %); 0 beside a fixed amount. */
    percent: numeric("percent", { precision: 7, scale: 3 }),
    /** A fixed amount inc GST, or null for a percentage. */
    amount: numeric("amount", { precision: 12, scale: 2 }),
    dueDays: integer("due_days"),
    /** The milestone's place in the schedule (today's milestone index). */
    sortOrder: integer("sort_order").notNull(),
    /** From the account's default rules (step 4c, #29); false for a schedule set on the job. */
    isDefaultSchedule: boolean("is_default_schedule").notNull().default(false),
    createdAt: createdAt(),
    createdBy: text("created_by"),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("payment_milestones_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("payment_milestones_org_job_sort_key").on(t.orgUid, t.jobId, t.sortOrder),
    foreignKey({
      name: "payment_milestones_quote_fk",
      columns: [t.orgUid, t.quoteUid],
      foreignColumns: [quotes.orgUid, quotes.uid],
    }),
    check("payment_milestones_uid_check", sql`${t.uid} ~ '^pms_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("payment_milestones_share_check", sql`(${t.percent} is not null and ${t.percent} > 0 and ${t.percent} <= 100) or (${t.amount} is not null and ${t.amount} > 0)`),
    check("payment_milestones_sort_order_check", sql`${t.sortOrder} >= 0`),
    check("payment_milestones_due_days_check", sql`${t.dueDays} is null or ${t.dueDays} > 0`),
    check("payment_milestones_version_check", sql`${t.version} > 0`),
    tenantIsolation("payment_milestones"),
  ],
);

/** One row per invoice as issued (or the draft a milestone will issue). */
export const invoices = pgTable(
  "invoices",
  {
    /** `inv_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    jobId: text("job_id").notNull(),
    /** As printed: INV-2026-10-1 from step 4b; EI-2501-01-M1 and EI-2501-01-M1-R2 before it. */
    number: text("number").notNull(),
    kind: text("kind").$type<InvoiceKind>().notNull(),
    status: text("status").$type<InvoiceStatus>().notNull().default("draft"),
    quoteUid: text("quote_uid"),
    /** The quote version it was issued against; `quote_version_inferred` when that is a best guess (an invoice from before revisions were tracked). */
    quoteVersion: integer("quote_version"),
    quoteVersionInferred: boolean("quote_version_inferred").notNull().default(false),
    milestoneUid: text("milestone_uid"),
    /** 1 for the original number, k for -Rk. */
    revision: integer("revision").notNull().default(1),
    /** The invoice this revision replaced in place (before credit notes). */
    supersedesInvoiceUid: text("supersedes_invoice_uid"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }),
    issuedOn: date("issued_on", { mode: "string" }),
    dueOn: date("due_on", { mode: "string" }),
    currency: text("currency").notNull().default("AUD"),
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
    taxTotal: numeric("tax_total", { precision: 12, scale: 2 }).notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    /** `computed`: GST on the subtotal. `printed`: the GST the invoice was issued with, with the reason. */
    taxTotalSource: text("tax_total_source").$type<LineTotalSource>().notNull().default("computed"),
    taxTotalReason: text("tax_total_reason"),
    /** Sum of the active payments recorded against this invoice. */
    amountPaid: numeric("amount_paid", { precision: 12, scale: 2 }).notNull().default("0"),
    issuedDocumentUid: text("issued_document_uid"),
    /** The job reference: the job number. Required on an invoice issued through the issue service (`issue_key` set). */
    reference: text("reference"),
    /**
     * The issue service's idempotency key (step 4b, server/invoices/issue.js):
     * set on an invoice issued with an INV-YYYY-M-N number from
     * document_number_counters, null on one issued before (EI-…). A retried
     * issue with the same key finds this row and returns it.
     */
    issueKey: text("issue_key"),
    supersededAt: timestamp("superseded_at", { withTimezone: true, mode: "date" }),
    revisionReason: text("revision_reason"),
    revisedBy: text("revised_by"),
    /** Why the status is what it is, where the files say more than the status. */
    note: text("note"),
    /**
     * The matching invoice in the owner's Xero (#93), the organisation it is
     * in, and its Xero status when Field last saw it. The id is set once per
     * organisation; it moves only to another organisation's invoice, after the
     * earlier one is in xero_invoice_links.
     */
    xeroInvoiceId: text("xero_invoice_id"),
    xeroTenantId: text("xero_tenant_id"),
    xeroStatus: text("xero_status"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("invoices_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("invoices_org_xero_invoice_key").on(t.orgUid, t.xeroInvoiceId),
    uniqueIndex("invoices_org_job_number_key").on(t.orgUid, t.jobId, t.number),
    uniqueIndex("invoices_org_issue_key").on(t.orgUid, t.issueKey),
    /** A sequence number is unique in the organisation, not only in its job. */
    uniqueIndex("invoices_org_sequence_number_key").on(t.orgUid, t.number).where(sql`${t.issueKey} is not null`),
    index("invoices_org_number_idx").on(t.orgUid, t.number),
    index("invoices_milestone_idx").on(t.orgUid, t.milestoneUid),
    foreignKey({
      name: "invoices_quote_fk",
      columns: [t.orgUid, t.quoteUid],
      foreignColumns: [quotes.orgUid, quotes.uid],
    }),
    foreignKey({
      name: "invoices_milestone_fk",
      columns: [t.orgUid, t.milestoneUid],
      foreignColumns: [paymentMilestones.orgUid, paymentMilestones.uid],
    }),
    foreignKey({
      name: "invoices_supersedes_fk",
      columns: [t.orgUid, t.supersedesInvoiceUid],
      foreignColumns: [t.orgUid, t.uid],
    }),
    foreignKey({
      name: "invoices_issued_document_fk",
      columns: [t.orgUid, t.issuedDocumentUid],
      foreignColumns: [issuedDocuments.orgUid, issuedDocuments.uid],
    }),
    check("invoices_uid_check", sql`${t.uid} ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("invoices_number_check", sql`btrim(${t.number}) <> ''`),
    check("invoices_kind_check", sql`${t.kind} in ('deposit','progress','final','variation')`),
    check("invoices_status_check", sql`${t.status} in ('draft','issued','paid','void','credited')`),
    check("invoices_issued_check", sql`(${t.status} = 'draft') = (${t.issuedAt} is null)`),
    check("invoices_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("invoices_total_check", sql`${t.total} = ${t.subtotal} + ${t.taxTotal}`),
    check("invoices_tax_total_source_check", sql`${t.taxTotalSource} in ('computed','printed') and (${t.taxTotalSource} = 'computed' or ${t.taxTotalReason} is not null)`),
    check("invoices_amount_paid_check", sql`${t.amountPaid} >= 0`),
    check("invoices_revision_check", sql`${t.revision} > 0`),
    check("invoices_quote_version_check", sql`${t.quoteVersion} is null or ${t.quoteVersion} > 0`),
    check("invoices_version_check", sql`${t.version} > 0`),
    check("invoices_issue_check", sql`${t.issueKey} is null or (${t.issuedAt} is not null and ${t.number} ~ '^INV-[0-9]{4}-([1-9]|1[0-2])-[1-9][0-9]*$' and ${t.reference} is not null and btrim(${t.reference}) <> '')`),
    tenantIsolation("invoices"),
  ],
);

/** An invoice's lines. A milestone invoice has one claim line against its quote. */
export const invoiceLines = pgTable(
  "invoice_lines",
  {
    /** `iln_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    invoiceUid: text("invoice_uid").notNull(),
    sortOrder: integer("sort_order").notNull(),
    /** claim (a share of a quote), item (catalogue), custom (typed in), note (text only). */
    lineType: text("line_type").$type<InvoiceLineType>().notNull(),
    /** The quote a claim line claims against. */
    quoteUid: text("quote_uid"),
    milestoneUid: text("milestone_uid"),
    itemUid: text("item_uid"),
    name: text("name").notNull(),
    description: text("description"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitCode: text("unit_code").notNull(),
    unitSell: numeric("unit_sell", { precision: 12, scale: 4 }),
    taxCode: text("tax_code").notNull(),
    taxRate: numeric("tax_rate", { precision: 7, scale: 3 }).notNull(),
    lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
    lineTotalSource: text("line_total_source").$type<LineTotalSource>().notNull().default("computed"),
    lineTotalReason: text("line_total_reason"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("invoice_lines_org_uid_key").on(t.orgUid, t.uid),
    index("invoice_lines_invoice_idx").on(t.orgUid, t.invoiceUid, t.sortOrder),
    foreignKey({
      name: "invoice_lines_invoice_fk",
      columns: [t.orgUid, t.invoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }).onDelete("cascade"),
    foreignKey({
      name: "invoice_lines_quote_fk",
      columns: [t.orgUid, t.quoteUid],
      foreignColumns: [quotes.orgUid, quotes.uid],
    }),
    foreignKey({
      name: "invoice_lines_milestone_fk",
      columns: [t.orgUid, t.milestoneUid],
      foreignColumns: [paymentMilestones.orgUid, paymentMilestones.uid],
    }),
    check("invoice_lines_uid_check", sql`${t.uid} ~ '^iln_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("invoice_lines_line_type_check", sql`${t.lineType} in ('claim','item','custom','note')`),
    check("invoice_lines_item_check", sql`${t.lineType} <> 'item' or ${t.itemUid} is not null`),
    check("invoice_lines_note_check", sql`${t.lineType} <> 'note' or (${t.unitSell} is null and ${t.lineTotal} = 0)`),
    check("invoice_lines_line_total_check", sql`case ${t.lineTotalSource}
      when 'computed' then (${t.unitSell} is null and ${t.lineTotal} = 0) or ${t.lineTotal} = round(${t.quantity} * ${t.unitSell}, 2)
      when 'printed' then ${t.lineTotalReason} is not null
      else false end`),
    check("invoice_lines_quantity_check", sql`${t.quantity} >= 0`),
    tenantIsolation("invoice_lines"),
  ],
);

/**
 * A credit (adjustment) note against one issued invoice (step 4b, #28). An
 * issued invoice is never revised in place: it is credited in full by a
 * credit note, and replaced by a new invoice (`replacement_invoice_uid`).
 * Numbered CN-YYYY-M-N from document_number_counters, with their own PDF.
 * Credit notes apply from step 4b on: an invoice revised in place before
 * them has none (owner's decision, 2026-10-13).
 */
export const creditNotes = pgTable(
  "credit_notes",
  {
    /** `crn_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    jobId: text("job_id").notNull(),
    number: text("number").notNull(),
    invoiceUid: text("invoice_uid").notNull(),
    status: text("status").$type<CreditNoteStatus>().notNull().default("draft"),
    reason: text("reason").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }),
    issuedOn: date("issued_on", { mode: "string" }),
    currency: text("currency").notNull().default("AUD"),
    /** Amounts credited, positive. */
    subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
    taxTotal: numeric("tax_total", { precision: 12, scale: 2 }).notNull(),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    taxTotalSource: text("tax_total_source").$type<LineTotalSource>().notNull().default("computed"),
    taxTotalReason: text("tax_total_reason"),
    issuedDocumentUid: text("issued_document_uid"),
    reference: text("reference"),
    /** The invoice issued in place of the one credited. */
    replacementInvoiceUid: text("replacement_invoice_uid"),
    /** The issue service's idempotency key. */
    issueKey: text("issue_key"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_notes_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("credit_notes_org_number_key").on(t.orgUid, t.number),
    uniqueIndex("credit_notes_org_issue_key").on(t.orgUid, t.issueKey),
    /** An invoice is credited once. */
    uniqueIndex("credit_notes_org_invoice_key").on(t.orgUid, t.invoiceUid).where(sql`${t.status} = 'issued'`),
    index("credit_notes_invoice_idx").on(t.orgUid, t.invoiceUid),
    foreignKey({
      name: "credit_notes_invoice_fk",
      columns: [t.orgUid, t.invoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    foreignKey({
      name: "credit_notes_replacement_invoice_fk",
      columns: [t.orgUid, t.replacementInvoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    foreignKey({
      name: "credit_notes_issued_document_fk",
      columns: [t.orgUid, t.issuedDocumentUid],
      foreignColumns: [issuedDocuments.orgUid, issuedDocuments.uid],
    }),
    check("credit_notes_uid_check", sql`${t.uid} ~ '^crn_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("credit_notes_number_check", sql`btrim(${t.number}) <> ''`),
    check("credit_notes_status_check", sql`${t.status} in ('draft','issued','void')`),
    check("credit_notes_issued_check", sql`(${t.status} = 'draft') = (${t.issuedAt} is null)`),
    check("credit_notes_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("credit_notes_total_check", sql`${t.total} = ${t.subtotal} + ${t.taxTotal} and ${t.total} >= 0`),
    check("credit_notes_tax_total_source_check", sql`${t.taxTotalSource} in ('computed','printed') and (${t.taxTotalSource} = 'computed' or ${t.taxTotalReason} is not null)`),
    check("credit_notes_version_check", sql`${t.version} > 0`),
    check("credit_notes_issue_check", sql`${t.issueKey} is null or (${t.issuedAt} is not null and ${t.number} ~ '^CN-[0-9]{4}-([1-9]|1[0-2])-[1-9][0-9]*$')`),
    tenantIsolation("credit_notes"),
  ],
);

export const creditNoteLines = pgTable(
  "credit_note_lines",
  {
    /** `cnl_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    creditNoteUid: text("credit_note_uid").notNull(),
    /** The invoice line it credits, when it credits one line. */
    invoiceLineUid: text("invoice_line_uid"),
    sortOrder: integer("sort_order").notNull(),
    lineType: text("line_type").$type<InvoiceLineType>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitCode: text("unit_code").notNull(),
    unitSell: numeric("unit_sell", { precision: 12, scale: 4 }),
    taxCode: text("tax_code").notNull(),
    taxRate: numeric("tax_rate", { precision: 7, scale: 3 }).notNull(),
    lineTotal: numeric("line_total", { precision: 12, scale: 2 }).notNull(),
    lineTotalSource: text("line_total_source").$type<LineTotalSource>().notNull().default("computed"),
    lineTotalReason: text("line_total_reason"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("credit_note_lines_org_uid_key").on(t.orgUid, t.uid),
    index("credit_note_lines_credit_note_idx").on(t.orgUid, t.creditNoteUid, t.sortOrder),
    foreignKey({
      name: "credit_note_lines_credit_note_fk",
      columns: [t.orgUid, t.creditNoteUid],
      foreignColumns: [creditNotes.orgUid, creditNotes.uid],
    }).onDelete("cascade"),
    foreignKey({
      name: "credit_note_lines_invoice_line_fk",
      columns: [t.orgUid, t.invoiceLineUid],
      foreignColumns: [invoiceLines.orgUid, invoiceLines.uid],
    }),
    check("credit_note_lines_uid_check", sql`${t.uid} ~ '^cnl_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("credit_note_lines_line_type_check", sql`${t.lineType} in ('claim','item','custom','note')`),
    check("credit_note_lines_note_check", sql`${t.lineType} <> 'note' or (${t.unitSell} is null and ${t.lineTotal} = 0)`),
    check("credit_note_lines_line_total_check", sql`case ${t.lineTotalSource}
      when 'computed' then (${t.unitSell} is null and ${t.lineTotal} = 0) or ${t.lineTotal} = round(${t.quantity} * ${t.unitSell}, 2)
      when 'printed' then ${t.lineTotalReason} is not null
      else false end`),
    check("credit_note_lines_quantity_check", sql`${t.quantity} >= 0`),
    tenantIsolation("credit_note_lines"),
  ],
);

/** Money received against an invoice. Never deleted: a mistaken payment is voided. */
export const payments = pgTable(
  "payments",
  {
    /** `pay_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    jobId: text("job_id").notNull(),
    /** The invoice it was recorded against. */
    invoiceUid: text("invoice_uid").notNull(),
    milestoneUid: text("milestone_uid"),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    method: text("method"),
    reference: text("reference"),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidReason: text("void_reason"),
    voidedBy: text("voided_by"),
    /** Today's payment id in milestone-invoices/state.json, while the files are the source of truth. */
    sourcePaymentId: text("source_payment_id"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("payments_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("payments_org_job_source_key").on(t.orgUid, t.jobId, t.sourcePaymentId),
    index("payments_invoice_idx").on(t.orgUid, t.invoiceUid),
    foreignKey({
      name: "payments_invoice_fk",
      columns: [t.orgUid, t.invoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    foreignKey({
      name: "payments_milestone_fk",
      columns: [t.orgUid, t.milestoneUid],
      foreignColumns: [paymentMilestones.orgUid, paymentMilestones.uid],
    }),
    check("payments_uid_check", sql`${t.uid} ~ '^pay_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("payments_amount_check", sql`${t.amount} > 0`),
    check("payments_void_check", sql`${t.voidedAt} is not null or (${t.voidReason} is null and ${t.voidedBy} is null)`),
    check("payments_version_check", sql`${t.version} > 0`),
    tenantIsolation("payments"),
  ],
);

/** A receipt, one per payment: today, for the payment that cleared its milestone. */
export const receipts = pgTable(
  "receipts",
  {
    /** `rct_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    jobId: text("job_id").notNull(),
    /** As printed: ER-2501-01-M1. */
    number: text("number").notNull(),
    paymentUid: text("payment_uid").notNull(),
    invoiceUid: text("invoice_uid").notNull(),
    status: text("status").$type<ReceiptStatus>().notNull().default("issued"),
    /** What the receipt acknowledges as paid. */
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("AUD"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    issuedDocumentUid: text("issued_document_uid"),
    createdAt: createdAt(),
    createdBy: text("created_by"),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("receipts_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("receipts_org_payment_key").on(t.orgUid, t.paymentUid),
    uniqueIndex("receipts_org_job_number_issued_key").on(t.orgUid, t.jobId, t.number).where(sql`${t.status} = 'issued'`),
    foreignKey({
      name: "receipts_payment_fk",
      columns: [t.orgUid, t.paymentUid],
      foreignColumns: [payments.orgUid, payments.uid],
    }),
    foreignKey({
      name: "receipts_invoice_fk",
      columns: [t.orgUid, t.invoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    foreignKey({
      name: "receipts_issued_document_fk",
      columns: [t.orgUid, t.issuedDocumentUid],
      foreignColumns: [issuedDocuments.orgUid, issuedDocuments.uid],
    }),
    check("receipts_uid_check", sql`${t.uid} ~ '^rct_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("receipts_number_check", sql`btrim(${t.number}) <> ''`),
    check("receipts_status_check", sql`${t.status} in ('issued','void')`),
    check("receipts_amount_check", sql`${t.amount} > 0`),
    check("receipts_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("receipts_version_check", sql`${t.version} > 0`),
    tenantIsolation("receipts"),
  ],
);

/**
 * A payment moved to the invoice that replaced the one it was recorded
 * against (step 4b): when a credit note credits an invoice, every active
 * payment that invoice holds moves to the replacement. Append-only; the
 * payment itself never changes. The invoice that holds a payment is the
 * `to_invoice_uid` of its latest allocation, else the invoice it was
 * recorded against.
 */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    /** `pal_` + ULID. */
    uid: text("uid").primaryKey(),
    orgUid: orgUid(),
    jobId: text("job_id").notNull(),
    paymentUid: text("payment_uid").notNull(),
    fromInvoiceUid: text("from_invoice_uid").notNull(),
    toInvoiceUid: text("to_invoice_uid").notNull(),
    creditNoteUid: text("credit_note_uid").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    allocatedAt: timestamp("allocated_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("payment_allocations_org_uid_key").on(t.orgUid, t.uid),
    uniqueIndex("payment_allocations_org_payment_credit_key").on(t.orgUid, t.paymentUid, t.creditNoteUid),
    index("payment_allocations_payment_idx").on(t.orgUid, t.paymentUid, t.allocatedAt),
    index("payment_allocations_job_idx").on(t.orgUid, t.jobId),
    foreignKey({
      name: "payment_allocations_payment_fk",
      columns: [t.orgUid, t.paymentUid],
      foreignColumns: [payments.orgUid, payments.uid],
    }),
    foreignKey({
      name: "payment_allocations_from_invoice_fk",
      columns: [t.orgUid, t.fromInvoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    foreignKey({
      name: "payment_allocations_to_invoice_fk",
      columns: [t.orgUid, t.toInvoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    foreignKey({
      name: "payment_allocations_credit_note_fk",
      columns: [t.orgUid, t.creditNoteUid],
      foreignColumns: [creditNotes.orgUid, creditNotes.uid],
    }),
    check("payment_allocations_uid_check", sql`${t.uid} ~ '^pal_[0-9A-HJKMNP-TV-Z]{26}$'`),
    check("payment_allocations_amount_check", sql`${t.amount} > 0`),
    check("payment_allocations_invoices_check", sql`${t.fromInvoiceUid} <> ${t.toInvoiceUid}`),
    tenantIsolation("payment_allocations"),
  ],
);

export type PaymentAllocation = typeof paymentAllocations.$inferSelect;

/**
 * When an invoice returned to draft is issued again with different content,
 * whether the issue service credits the earlier one with a credit note first
 * (step 4b, #28): `when-emailed` (the default) only when Field has evidence it
 * was sent to the customer, `always`, or `never`. "Credit and reissue" always
 * credits, whatever this says.
 */
export const CREDIT_NOTE_ON_REISSUE = ["when-emailed", "always", "never"] as const;
export type CreditNoteOnReissue = (typeof CREDIT_NOTE_ON_REISSUE)[number];

/**
 * The organisation's business settings: one row per organisation (none means
 * every default). Only what Field reads from the database lives here so far;
 * the business profile is still config (docs/PRICING_ENGINE.md "Business
 * settings").
 */
export const businessSettings = pgTable(
  "business_settings",
  {
    orgUid: orgUid().primaryKey(),
    creditNoteOnReissue: text("credit_note_on_reissue").$type<CreditNoteOnReissue>().notNull().default("when-emailed"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    check("business_settings_credit_note_on_reissue_check", sql`${t.creditNoteOnReissue} in ('when-emailed','always','never')`),
    tenantIsolation("business_settings"),
  ],
);

export type BusinessSettings = typeof businessSettings.$inferSelect;
export type PaymentMilestone = typeof paymentMilestones.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type CreditNote = typeof creditNotes.$inferSelect;
export type CreditNoteLine = typeof creditNoteLines.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;

// ---------------------------------------------------------------------------
// Xero (#93): each installation connects to its owner's own Xero organisation
// through a Xero app the owner creates at developer.xero.com. The app's client
// id and secret are deployment secrets (XERO_CLIENT_ID, XERO_CLIENT_SECRET)
// and never stored here. Stored: one row per organisation with the chosen
// Xero organisation (tenant), the OAuth tokens encrypted with AES-256-GCM
// (server/xero/token-crypto.js; the key is derived from the client secret, and
// `key_fingerprint` tells a changed secret apart), the sign-in in progress
// while the owner is at Xero (its state only as a hash), and the owner's
// settings. Disconnect clears the tokens and the tenant and keeps the
// settings.

export const XERO_CONNECTION_STATUSES = ["disconnected", "choose_organisation", "connected", "needs_reconnect"] as const;
export type XeroConnectionStatus = (typeof XERO_CONNECTION_STATUSES)[number];
/** What Field creates in Xero for an issued invoice. */
export const XERO_CREATE_MODES = ["off", "draft", "authorised"] as const;
export type XeroCreateMode = (typeof XERO_CREATE_MODES)[number];
/**
 * Where invoice numbers come from. Only `field` (INV-YYYY-M-N, #39) exists
 * now. `xero` (Xero allocates the number when Field issues) is a later change
 * that widens this check (docs/XERO.md "Invoice numbers").
 */
export const XERO_INVOICE_NUMBERING = ["field"] as const;
export type XeroInvoiceNumbering = (typeof XERO_INVOICE_NUMBERING)[number];

export const xeroConnections = pgTable(
  "xero_connections",
  {
    orgUid: orgUid().primaryKey(),
    status: text("status").$type<XeroConnectionStatus>().notNull().default("disconnected"),
    /** The Xero organisation Field writes to, from GET /connections. */
    tenantId: text("tenant_id"),
    tenantName: text("tenant_name"),
    /** The connection's own id (DELETE /connections/{id} on disconnect). */
    connectionId: text("connection_id"),
    /** The organisations the last sign-in reached, while the owner chooses one: [{ tenantId, tenantName, connectionId }]. */
    availableTenants: jsonb("available_tenants").$type<Array<Record<string, string>>>().notNull().default(sql`'[]'::jsonb`),
    /** AES-256-GCM, `v1.<iv>.<ciphertext>.<tag>` in base64url. Never logged, never sent to the browser. */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true, mode: "date" }),
    /** When the current refresh token was issued (each refresh rotates it). */
    refreshIssuedAt: timestamp("refresh_issued_at", { withTimezone: true, mode: "date" }),
    /** A fingerprint of the key that encrypted the tokens, never the key. */
    keyFingerprint: text("key_fingerprint"),
    /** Why the owner must connect again: a short code (REFRESH_REJECTED, CLIENT_SECRET_CHANGED, ...). */
    reconnectReason: text("reconnect_reason"),
    /** The sign-in in progress: the SHA-256 of its state, who started it and until when. */
    pendingStateHash: text("pending_state_hash"),
    pendingBy: text("pending_by"),
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true, mode: "date" }),
    connectedAt: timestamp("connected_at", { withTimezone: true, mode: "date" }),
    connectedBy: text("connected_by"),
    createMode: text("create_mode").$type<XeroCreateMode>().notNull().default("draft"),
    invoiceNumbering: text("invoice_numbering").$type<XeroInvoiceNumbering>().notNull().default("field"),
    /** The sales account every line is coded to ("Sales" is 200 in Xero's standard Australian chart). */
    salesAccountCode: text("sales_account_code").notNull().default("200"),
    /** The tax type of lines with GST ("GST on Income" is OUTPUT in Australia). */
    taxType: text("tax_type").notNull().default("OUTPUT"),
    /** Invoices issued from this moment go to Xero by themselves; earlier ones only when an owner sends them. */
    autoFrom: timestamp("auto_from", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    check("xero_connections_status_check", sql`${t.status} in ('disconnected','choose_organisation','connected','needs_reconnect')`),
    check("xero_connections_create_mode_check", sql`${t.createMode} in ('off','draft','authorised')`),
    check("xero_connections_invoice_numbering_check", sql`${t.invoiceNumbering} in ('field')`),
    check("xero_connections_connected_check", sql`${t.status} <> 'connected' or (${t.tenantId} is not null and ${t.refreshTokenEnc} is not null)`),
    check("xero_connections_account_code_check", sql`${t.salesAccountCode} ~ '^[A-Za-z0-9._-]{1,10}$'`),
    check("xero_connections_tax_type_check", sql`${t.taxType} ~ '^[A-Z0-9_]{1,40}$'`),
    check("xero_connections_reconnect_reason_check", sql`${t.reconnectReason} is null or ${t.reconnectReason} ~ '^[A-Z0-9_]{1,64}$'`),
    tenantIsolation("xero_connections"),
  ],
);

export type XeroConnection = typeof xeroConnections.$inferSelect;

/**
 * Each issued invoice on its way to Xero (#93, phase 1): one row per invoice
 * from when it is queued, for one Xero organisation (`tenant_id`). The issued
 * invoices are the outbox (server/xero/invoice-sync.js queues every invoice
 * issued since Create in Xero was turned on), so issuing never waits on Xero
 * or writes here.
 *
 *   pending   queued, or waiting to retry (`next_attempt_at`), or waiting
 *             for the owner to connect again
 *   created   in Xero, with its id and status, its PDF attached and its
 *             totals equal to Field's
 *   mismatch  in Xero as a draft, but Xero's totals differ from Field's
 *   failed    Xero refused it, or retries ran out; `last_error_reason` says why
 *   skipped   not sent (credited or voided in Field before it reached Xero)
 *   held      queued for another Xero organisation than the one connected
 *             now: never sent there; an owner sends it again deliberately
 *
 * A worker claims a row with a lease (`lease_owner`, `lease_until`), so two
 * servers (an overlapping republish) never work the same invoice.
 */
export const XERO_SYNC_STATES = ["pending", "created", "mismatch", "failed", "skipped", "held"] as const;
export type XeroSyncState = (typeof XERO_SYNC_STATES)[number];

export const xeroInvoiceSyncs = pgTable(
  "xero_invoice_syncs",
  {
    orgUid: orgUid(),
    invoiceUid: text("invoice_uid").notNull(),
    /** The Xero organisation it was queued for, and is created in. */
    tenantId: text("tenant_id").notNull(),
    state: text("state").$type<XeroSyncState>().notNull().default("pending"),
    /** draft or authorised: what Create in Xero said when it was queued. */
    mode: text("mode").$type<"draft" | "authorised">().notNull(),
    /** auto (issued after Create in Xero was turned on) or owner (sent or retried by an owner). */
    queuedBy: text("queued_by").$type<"auto" | "owner">().notNull(),
    requestedBy: text("requested_by"),
    queuedAt: timestamp("queued_at", { withTimezone: true, mode: "date" }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: "date" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    /** The worker sending it now, and until when its claim holds. */
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
    /** A short code (XERO_VALIDATION, XERO_RATE_LIMITED, ...). */
    lastErrorCode: text("last_error_code"),
    /** The plain reason the owner reads. Never logged. */
    lastErrorReason: text("last_error_reason"),
    xeroInvoiceId: text("xero_invoice_id"),
    xeroStatus: text("xero_status"),
    xeroContactId: text("xero_contact_id"),
    /** Xero's total and Field's, as compared after the invoice was created. */
    xeroTotal: numeric("xero_total", { precision: 12, scale: 2 }),
    fieldTotal: numeric("field_total", { precision: 12, scale: 2 }),
    createdInXeroAt: timestamp("created_in_xero_at", { withTimezone: true, mode: "date" }),
    attachedAt: timestamp("attached_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgUid, t.invoiceUid] }),
    foreignKey({
      name: "xero_invoice_syncs_invoice_fk",
      columns: [t.orgUid, t.invoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    index("xero_invoice_syncs_due_idx").on(t.orgUid, t.nextAttemptAt).where(sql`${t.state} = 'pending'`),
    check("xero_invoice_syncs_state_check", sql`${t.state} in ('pending','created','mismatch','failed','skipped','held')`),
    check("xero_invoice_syncs_mode_check", sql`${t.mode} in ('draft','authorised')`),
    check("xero_invoice_syncs_queued_by_check", sql`${t.queuedBy} in ('auto','owner')`),
    check("xero_invoice_syncs_attempts_check", sql`${t.attempts} >= 0`),
    check("xero_invoice_syncs_last_error_code_check", sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[A-Z0-9_]{1,64}$'`),
    check("xero_invoice_syncs_created_check", sql`${t.state} not in ('created','mismatch') or ${t.xeroInvoiceId} is not null`),
    check("xero_invoice_syncs_tenant_check", sql`btrim(${t.tenantId}) <> ''`),
    tenantIsolation("xero_invoice_syncs"),
  ],
);

export type XeroInvoiceSync = typeof xeroInvoiceSyncs.$inferSelect;

/**
 * Every Xero invoice a Field invoice has had, by Xero organisation (#93).
 * Append-only: invoices.xero_invoice_id holds the current one, and may move
 * to another organisation's id only once the earlier id is recorded here
 * (migration 0018's trigger), so the history is never lost.
 */
export const xeroInvoiceLinks = pgTable(
  "xero_invoice_links",
  {
    orgUid: orgUid(),
    invoiceUid: text("invoice_uid").notNull(),
    tenantId: text("tenant_id").notNull(),
    xeroInvoiceId: text("xero_invoice_id").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgUid, t.tenantId, t.xeroInvoiceId] }),
    foreignKey({
      name: "xero_invoice_links_invoice_fk",
      columns: [t.orgUid, t.invoiceUid],
      foreignColumns: [invoices.orgUid, invoices.uid],
    }),
    index("xero_invoice_links_invoice_idx").on(t.orgUid, t.invoiceUid),
    tenantIsolation("xero_invoice_links"),
  ],
);
