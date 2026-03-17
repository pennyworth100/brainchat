import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index";

async function runMigrations() {
  console.log("Running database migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete.");
  await pool.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
