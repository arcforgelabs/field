# Price catalogue backup and restore

The price catalogue is PostgreSQL data (`server/catalog/README.md`). The
SQLite `catalog.db`, its scheduled `.db` backups, pre-migration snapshots,
leases and the `catalog-backup` restore CLI are gone with the file they
protected.

- **Restore:** use the database's point-in-time restore (Replit PostgreSQL).
  Catalogue writes are transactional and append-only for prices, so a restore
  to a moment before a bad edit or import is exact.
- **Manual copy:** `npm run catalog:export -- --out catalogue.json` (or
  `GET /api/price-catalog/export`) writes every catalogue table, read in one
  transaction, as one JSON document (mode 0600) to keep, diff or hand over.
- **Undoing a price change** needs no restore: prices are append-only
  `item_prices` rows (`GET /api/price-catalog/items/<code>/prices`); set the
  old price again and a new row records it, with history.
- **Moving a SQLite catalogue in** (cutover, or an old backup `.db`):
  `npm run catalog:import-legacy -- <catalog.db> --dry-run`, then without
  `--dry-run`. It is verified and all-or-nothing.
