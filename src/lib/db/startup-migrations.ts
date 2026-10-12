import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

// Database-local, session-scoped namespace reserved for Dimle schema startup.
// This coordinates participating migration entrypoints, NOT running writers,
// old images, external SQL, filesystem durability, or a recovery/cutover fence.
export const STARTUP_MIGRATION_LOCK = [1145654604, 1] as const;

export async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Pin the lock, migration-history read, and all migration transactions to
    // one backend. Locking a separate pool query cannot protect this sequence.
    await client.query("SELECT pg_advisory_lock($1, $2)", [...STARTUP_MIGRATION_LOCK]);
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    // Destroy instead of returning a session with a potentially held lock or
    // aborted transaction to the pool. Backend exit also releases it on crash.
    client.release(true);
  }
}
