-- The SQLite price catalogue's schema at v21 (server/price-catalog/catalog-schema.js
-- before the move to PostgreSQL), for building synthetic legacy catalog.db files
-- in tests of the importer. Not used at runtime.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  name_key TEXT,
  unit TEXT NOT NULL DEFAULT 'job',
  buy_price REAL,
  sell_price REAL,
  buy_price_mode TEXT NOT NULL DEFAULT 'manual' CHECK (buy_price_mode IN ('manual', 'computed')),
  sell_price_mode TEXT NOT NULL DEFAULT 'manual' CHECK (sell_price_mode IN ('manual', 'computed')),
  price_reference TEXT,
  catalog_type TEXT CHECK (catalog_type IN ('goods_service', 'component', 'product', 'service', 'item')),
  category TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  pricing_basis TEXT CHECK (pricing_basis IN ('per_tonne', 'per_load', 'per_m3')),
  pricing_basis_factor REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_code ON items(code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_uid ON items(uid);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_name_key ON items(name_key);

CREATE TABLE IF NOT EXISTS component_children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_code TEXT NOT NULL REFERENCES items(code) ON DELETE CASCADE,
  child_code TEXT NOT NULL REFERENCES items(code) ON DELETE RESTRICT,
  quantity REAL NOT NULL DEFAULT 1,
  entry_quantity REAL,
  entry_unit TEXT,
  application_mode TEXT NOT NULL DEFAULT 'proportional' CHECK (application_mode IN ('proportional', 'fixed')),
  pricing_contribution TEXT NOT NULL DEFAULT 'included' CHECK (pricing_contribution IN ('included', 'listed_only')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parent_code, child_code)
);

CREATE INDEX IF NOT EXISTS idx_cc_parent ON component_children(parent_code);
CREATE INDEX IF NOT EXISTS idx_cc_child ON component_children(child_code);

CREATE TABLE IF NOT EXISTS legacy_component_items (
  item_code TEXT PRIMARY KEY REFERENCES items(code) ON DELETE CASCADE,
  migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT NOT NULL REFERENCES items(code) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'general')),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'link', 'note')),
  file_path TEXT,
  url TEXT,
  note TEXT,
  supplier TEXT,
  mime_type TEXT,
  original_filename TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_item ON evidence(item_code);
CREATE INDEX IF NOT EXISTS idx_evidence_side ON evidence(item_code, side);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_code TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT NOT NULL DEFAULT 'system',
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_item ON history(item_code);
CREATE INDEX IF NOT EXISTS idx_history_item_field ON history(item_code, field);
CREATE INDEX IF NOT EXISTS idx_history_changed_at ON history(changed_at);

CREATE TABLE IF NOT EXISTS quote_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id TEXT NOT NULL,
  job_id TEXT,
  item_code TEXT NOT NULL,
  buy_price REAL,
  sell_price REAL,
  unit TEXT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qs_quote ON quote_snapshots(quote_id);
CREATE INDEX IF NOT EXISTS idx_qs_item ON quote_snapshots(item_code);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);

