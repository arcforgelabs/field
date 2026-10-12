import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./server/db/src/schema.ts",
  out: "./server/db/drizzle",
  dialect: "postgresql",
  migrations: {
    prefix: "index",
  },
  dbCredentials: {
    // Generate and check do not connect. Applying migrations requires an
    // explicit DATABASE_URL so the application never invents credentials or
    // connects to a database during normal boot.
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
});
