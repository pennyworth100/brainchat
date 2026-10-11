import { migrateDatabase } from "./startup-migrations";
import { pool } from "./index";

async function runMigrations() {
  console.log("Running database migrations...");
  try {
    await migrateDatabase(pool);
    console.log("Migrations complete.");
  } finally {
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
