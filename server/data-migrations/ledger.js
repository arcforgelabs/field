// The data-migration ledger row, written by a migration that records itself
// inside its own organisation transaction (index.js `recordDataMigration`).
import { sql } from "drizzle-orm";

export async function recordDataMigrationLedger(tx, { id, summary, appliedAt }) {
  await tx.execute(sql`
    insert into data_migrations (id, applied_at, summary)
    values (${id}, ${appliedAt.toISOString()}::timestamptz, ${JSON.stringify(summary || {})}::jsonb)`);
}
