import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export type AppDatabase = PostgresJsDatabase<typeof schema>;
export type DatabaseClient = Sql;

export interface DatabaseConnection {
  db: AppDatabase;
  client: DatabaseClient;
}

/**
 * Create an explicit database connection for a caller that has opted into
 * PostgreSQL. The plain-JS server does not call this during normal boot.
 */
export function createDatabase(connectionString: string): DatabaseConnection {
  if (!connectionString.trim()) {
    throw new Error("A PostgreSQL connection string is required");
  }

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client, { schema });
  return { db, client };
}
