import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "./storage/fs.js";
import { readdir, readFile } from "./storage/fs-promises.js";
import { basename, join } from "node:path";
import { readJobMeta } from "./job-meta-store.js";

let _db = null;

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  date_dir TEXT NOT NULL,
  dir TEXT NOT NULL,
  title TEXT,
  site_address TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  quote_number TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(date_dir);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS evidence_files (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  category TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,
  ingested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_job ON evidence_files(job_id);
CREATE INDEX IF NOT EXISTS idx_evidence_category ON evidence_files(category);
CREATE INDEX IF NOT EXISTS idx_evidence_mime ON evidence_files(mime_type);

CREATE TABLE IF NOT EXISTS notes_ledger (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  surface TEXT NOT NULL DEFAULT 'general',
  layer TEXT,
  item_code TEXT,
  item_label TEXT,
  item_snapshot TEXT,
  version TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_job ON notes_ledger(job_id);
CREATE INDEX IF NOT EXISTS idx_notes_surface ON notes_ledger(surface);
CREATE INDEX IF NOT EXISTS idx_notes_item ON notes_ledger(job_id, item_code);
`;

export function getFieldDb(dataDir) {
  if (_db) return _db;
  const dbPath = join(dataDir, "field.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  ensureSchema(_db);
  return _db;
}

export function getFieldDbHandle() {
  return _db;
}

export function closeFieldDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function ensureSchema(db) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get();
  if (!row) {
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
  } else {
    const current = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    if (!current || current.v < SCHEMA_VERSION) {
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    }
  }
  // Idempotent column additions — silently ignored if column already exists
  try { db.exec("ALTER TABLE notes_ledger ADD COLUMN title TEXT"); } catch {}
  ensureJobLog(db);
}

// ─── Job log ───────────────────────────────────────────────────
// What Field's engine did to a job (quote rebuilds and their checks). It is
// for inspecting a job, never shown as a note.

const JOB_LOG_SQL = `
CREATE TABLE IF NOT EXISTS job_log (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  version TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_log_job ON job_log(job_id, at);
`;

const SYSTEM_NOTE_AUTHORS = ["Field System", "system"];

function ensureJobLog(db) {
  db.exec(JOB_LOG_SQL);
  // System notes written before the log existed move into it, once.
  const placeholders = SYSTEM_NOTE_AUTHORS.map(() => "?").join(", ");
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO job_log (id, job_id, at, kind, title, text, version)
      SELECT id, job_id, created_at, 'quote.rebuilt', title, text, version
      FROM notes_ledger WHERE LOWER(COALESCE(author, '')) IN (${placeholders})
    `).run(...SYSTEM_NOTE_AUTHORS.map((author) => author.toLowerCase()));
    db.prepare(`DELETE FROM notes_ledger WHERE LOWER(COALESCE(author, '')) IN (${placeholders})`)
      .run(...SYSTEM_NOTE_AUTHORS.map((author) => author.toLowerCase()));
  })();
}

/** `latestOnly` keeps one entry per job, kind and version: quotes rebuild on every save. */
export function appendJobLog(db, { jobId, kind, title = null, text, version = null, at = null, latestOnly = false }) {
  const id = randomUUID();
  if (latestOnly) {
    db.prepare("DELETE FROM job_log WHERE job_id = ? AND kind = ? AND COALESCE(version, '') = COALESCE(?, '')")
      .run(jobId, kind, version == null ? null : String(version));
  }
  db.prepare(`
    INSERT INTO job_log (id, job_id, at, kind, title, text, version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, jobId, at || new Date().toISOString(), kind, title || null, String(text || ""), version == null ? null : String(version));
  return id;
}

export function getJobLog(db, jobId) {
  return db.prepare("SELECT id, at, kind, title, text, version FROM job_log WHERE job_id = ? ORDER BY at DESC").all(jobId);
}

// ─── Job operations ────────────────────────────────────────────

export function upsertJob(db, { id, dateDir, dir, title, siteAddress, status, quoteNumber, createdAt, updatedAt }) {
  const now = updatedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO jobs (id, date_dir, dir, title, site_address, status, quote_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      date_dir = excluded.date_dir,
      dir = excluded.dir,
      title = excluded.title,
      site_address = excluded.site_address,
      status = COALESCE(excluded.status, jobs.status),
      quote_number = COALESCE(excluded.quote_number, jobs.quote_number),
      updated_at = excluded.updated_at
  `).run(id, dateDir, dir, title || null, siteAddress || null, status || "active", quoteNumber || null, createdAt || now, now);
}

export function findJobInDb(db, id) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id)
    || db.prepare("SELECT * FROM jobs WHERE id LIKE ? || '%'").get(id.slice(0, 8))
    || null;
}

// Removes a deleted job's row and everything indexed under it, so the job list
// never keeps a row pointing at a folder that is gone.
export function deleteJob(db, id) {
  const jobId = String(id || "").trim();
  if (!jobId) return { jobs: 0, notes: 0, log: 0, evidence: 0 };
  return db.transaction(() => ({
    notes: db.prepare("DELETE FROM notes_ledger WHERE job_id = ?").run(jobId).changes,
    log: db.prepare("DELETE FROM job_log WHERE job_id = ?").run(jobId).changes,
    evidence: db.prepare("DELETE FROM evidence_files WHERE job_id = ?").run(jobId).changes,
    jobs: db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId).changes,
  }))();
}

export function listJobsFromDb(db) {
  return db.prepare("SELECT * FROM jobs ORDER BY date_dir DESC, created_at DESC").all();
}

// ─── Evidence file operations ──────────────────────────────────

export function insertEvidenceFile(db, { id, jobId, filePath, fileName, mimeType, sizeBytes, category, uploadedBy, uploadedAt }) {
  db.prepare(`
    INSERT INTO evidence_files (id, job_id, file_path, file_name, mime_type, size_bytes, category, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      file_name = excluded.file_name,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      category = excluded.category,
      ingested = evidence_files.ingested
  `).run(id, jobId, filePath, fileName, mimeType || null, sizeBytes || null, category || null, uploadedBy || null, uploadedAt || new Date().toISOString());
}

export function markEvidenceIngested(db, fileId) {
  db.prepare("UPDATE evidence_files SET ingested = 1 WHERE id = ?").run(fileId);
}

export function getEvidenceForJob(db, jobId) {
  return db.prepare("SELECT * FROM evidence_files WHERE job_id = ? ORDER BY uploaded_at ASC").all(jobId);
}

export function getEvidenceByCategory(db, jobId, category) {
  return db.prepare("SELECT * FROM evidence_files WHERE job_id = ? AND category = ? ORDER BY uploaded_at ASC").all(jobId, category);
}

export function countEvidenceByJob(db) {
  return db.prepare("SELECT job_id, COUNT(*) as count FROM evidence_files GROUP BY job_id").all();
}

// ─── Notes ledger operations ───────────────────────────────────

export function insertNote(db, { id, jobId, text, title, author, surface, layer, itemCode, itemLabel, itemSnapshot, version }) {
  db.prepare(`
    INSERT INTO notes_ledger (id, job_id, text, title, author, surface, layer, item_code, item_label, item_snapshot, version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(id, jobId, text, title || null, author || null, surface || "general", layer || null, itemCode || null, itemLabel || null, itemSnapshot ? JSON.stringify(itemSnapshot) : null, version || null);
}

export function replaceNote(db, { jobId, text, title, author, surface, layer, itemCode, itemLabel, itemSnapshot, version }) {
  const transaction = db.transaction((payload) => {
    db.prepare(`
      DELETE FROM notes_ledger
      WHERE job_id = ?
        AND COALESCE(title, '') = COALESCE(?, '')
        AND COALESCE(author, '') = COALESCE(?, '')
        AND COALESCE(surface, '') = COALESCE(?, '')
        AND COALESCE(layer, '') = COALESCE(?, '')
        AND COALESCE(item_code, '') = COALESCE(?, '')
        AND COALESCE(version, '') = COALESCE(?, '')
    `).run(
      payload.jobId,
      payload.title || null,
      payload.author || null,
      payload.surface || "general",
      payload.layer || null,
      payload.itemCode || null,
      payload.version || null,
    );
    const id = randomUUID();
    insertNote(db, {
      id,
      ...payload,
    });
    return id;
  });

  return transaction({
    jobId,
    text,
    title,
    author,
    surface,
    layer,
    itemCode,
    itemLabel,
    itemSnapshot,
    version,
  });
}

export function getNotesForJob(db, jobId) {
  const rows = db.prepare("SELECT * FROM notes_ledger WHERE job_id = ? ORDER BY created_at DESC").all(jobId);
  return rows.map((r) => ({
    ...r,
    title: r.title || null,
    itemSnapshot: r.item_snapshot ? JSON.parse(r.item_snapshot) : null,
    itemCode: r.item_code,
    itemLabel: r.item_label,
    createdAt: r.created_at,
    jobId: r.job_id,
  }));
}

export function deleteNote(db, noteId, jobId) {
  return db.prepare("DELETE FROM notes_ledger WHERE id = ? AND job_id = ?").run(noteId, jobId);
}

// ─── Keeping the job index in step with the data directory ────

// Job rows store an absolute folder path. A data folder that moved (the old
// server's /opt/apps/field/data restored onto Replit) leaves every row pointing
// at a folder that isn't there, so jobs silently drop out of the list. Each job
// lives at <dataDir>/<date_dir>/<folder>, so rebuild the path from that.
export function rebaseJobDirs(db, dataDir) {
  const rows = db.prepare("SELECT id, date_dir, dir FROM jobs").all();
  const update = db.prepare("UPDATE jobs SET dir = ? WHERE id = ?");
  let rebased = 0;
  db.transaction(() => {
    for (const row of rows) {
      const folder = basename(String(row.dir || "").replace(/[\\/]+$/, "")) || row.id;
      const dir = join(dataDir, row.date_dir, folder);
      if (dir === row.dir) continue;
      update.run(dir, row.id);
      rebased += 1;
    }
  })();
  return { rebased, total: rows.length };
}

// Every job folder: <dataDir>/<day>/<folder>. Dot entries are never jobs: a
// generation stage (.field-generation-stage-*) holds a copy of a job's
// meta.json under the job's id, and durable storage's .quarantine-* folders
// hold files it set aside.
async function listJobFolders(dataDir) {
  const folders = [];
  let dayEntries;
  try { dayEntries = await readdir(dataDir, { withFileTypes: true }); } catch { return folders; }
  for (const dayEntry of dayEntries) {
    if (!dayEntry.isDirectory() || dayEntry.name.startsWith(".")) continue;
    let entries;
    try { entries = await readdir(join(dataDir, dayEntry.name), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      folders.push({ dateDir: dayEntry.name, name: entry.name, dir: join(dataDir, dayEntry.name, entry.name) });
    }
  }
  return folders;
}

// Make the job index agree with the data directory. The job list reads this
// index, so a job folder it does not point at never appears on the board,
// although the job still opens by its link (#32).
//
// A folder the index already points at is not read, so on a healthy index this
// costs one directory listing per day folder. Any other folder is read through
// readJobMeta, the reader the API uses: it resolves the job's active
// generation, which is where a job's meta.json lives. A job with no row is
// added. A row whose folder no longer holds its job, while another folder
// does (a job folder renamed after it was indexed), is pointed at that folder.
//
// Rows are never removed here. Deleting a job removes its folder and then its
// row (deleteJob), and a job is added only while its folder still exists, so a
// deleted job never comes back.
export async function reconcileJobIndex(db, dataDir, { readMeta = readJobMeta } = {}) {
  const rows = db.prepare("SELECT id, dir FROM jobs").all();
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const indexedDirs = new Set(rows.map((row) => row.dir));

  // Phase 1: read the folders the index does not point at (async).
  const additions = [];
  const moves = [];
  for (const folder of await listJobFolders(dataDir)) {
    if (indexedDirs.has(folder.dir)) continue;
    const meta = await readMeta(folder.dir).catch(() => null);
    if (!meta || typeof meta !== "object") continue;
    const id = String(meta.id || folder.name);
    const row = rowById.get(id);
    if (row) {
      const current = await readMeta(row.dir).catch(() => null);
      if (current && String(current.id || basename(row.dir)) === id) continue;
      moves.push({ id, ...folder });
      rowById.set(id, { id, dir: folder.dir });
      continue;
    }
    let files = [];
    try {
      const ledger = JSON.parse(await readFile(join(folder.dir, "ingestion-ledger.json"), "utf8"));
      if (Array.isArray(ledger?.files)) files = ledger.files;
    } catch { /* no ingestion ledger */ }
    additions.push({ id, ...folder, meta, files });
    rowById.set(id, { id, dir: folder.dir });
  }

  // Phase 2: write them in one synchronous transaction. A folder deleted since
  // phase 1 read it is skipped, so a job being deleted is never re-added.
  const insertJob = db.prepare(`
    INSERT OR IGNORE INTO jobs (id, date_dir, dir, title, site_address, status, quote_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const moveJob = db.prepare("UPDATE jobs SET dir = ?, date_dir = ? WHERE id = ?");
  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO evidence_files (id, job_id, file_path, file_name, mime_type, size_bytes, category, uploaded_by, uploaded_at, ingested)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  return db.transaction(() => {
    let added = 0;
    let moved = 0;
    for (const r of additions) {
      if (!existsSync(r.dir)) continue;
      const { changes } = insertJob.run(
        r.id, r.dateDir, r.dir,
        r.meta.title || r.meta.siteAddress || null,
        r.meta.siteAddress || null,
        r.meta.archived || r.meta.archivedAt ? "archived" : "active",
        r.meta.quoteNumber || null,
        r.meta.createdAt || now,
        r.meta.updatedAt || r.meta.createdAt || now,
      );
      if (!changes) continue;
      added += 1;
      for (const f of r.files) {
        const fileId = f.fileId || `f-${Date.now().toString(36)}`;
        const category = detectCategory(f.filePath || f.fileName || "");
        insertFile.run(
          fileId, r.id,
          f.filePath || "", f.fileName || "",
          f.mimeType || null, f.sizeBytes || null,
          category, f.uploadedBy || null,
          f.uploadedAt || now,
          f.ingested ? 1 : 0,
        );
      }
    }
    for (const m of moves) {
      if (existsSync(m.dir)) moved += moveJob.run(m.dir, m.dateDir, m.id).changes;
    }
    return { added, moved, total: db.prepare("SELECT COUNT(*) AS c FROM jobs").get().c };
  })();
}

function detectCategory(filePath) {
  const p = String(filePath).toLowerCase();
  if (p.includes("/recording/") || p.includes("audio")) return "recording";
  if (p.includes("/images/")) return "images";
  if (p.includes("/moasure/") || p.endsWith(".csv")) return "moasure";
  if (p.includes("/notes/")) return "notes";
  if (p.includes("/documents/") || p.endsWith(".pdf")) return "documents";
  return null;
}
