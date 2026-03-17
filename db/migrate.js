const { migrate } = require("drizzle-orm/node-postgres/migrator");
const { db, pool } = require("./index");

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
