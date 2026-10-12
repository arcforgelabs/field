import { asc } from "drizzle-orm";

import type { AppDatabase } from "./database.js";
import {
  type NewToolchainProbe,
  toolchainProbe,
} from "./schema.js";

export async function insertToolchainProbe(
  db: AppDatabase,
  value: NewToolchainProbe,
) {
  const [row] = await db.insert(toolchainProbe).values(value).returning();
  if (!row) {
    throw new Error("The PostgreSQL probe insert returned no row");
  }
  return row;
}

export function listToolchainProbes(db: AppDatabase) {
  return db
    .select()
    .from(toolchainProbe)
    .orderBy(asc(toolchainProbe.id));
}
