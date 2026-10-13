import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Pool } from "pg";
import { migrateDatabase } from "../src/lib/db/startup-migrations";

async function main() {
const url = new URL(process.env.RESUME_TEST_DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, process.env.OWNED_PG_PORT);
assert.equal(url.search, "");
const pool = new Pool({ connectionString: url.href });
const sql = await fs.readFile("scripts/production/install-publication-closed.sql", "utf8");
const tables = ["message_write_budget", "message_publication_pending", "publication_subscribers",
  "publication_deliveries", "publication_admission", "publication_snapshot_attempts"];
const installer = await pool.connect();
const writer = await pool.connect();
async function rejected(code?: string) {
  await assert.rejects(installer.query(sql), e => !code || (e as {code: string}).code === code);
  await installer.query("ROLLBACK");
}
try {
  await migrateDatabase(pool);
  await pool.query("INSERT INTO rooms(id) VALUES ('cutover')");
  await pool.query("INSERT INTO messages(room_id,username,content) VALUES ('cutover','old','before')");
  // A partial/preexisting installation must not reset budgets or leave half a schema.
  await pool.query("CREATE TABLE publication_admission(id integer PRIMARY KEY); INSERT INTO publication_admission VALUES (77)");
  await rejected("42P07");
  assert.equal((await pool.query("SELECT to_regclass('public.message_write_budget') AS n")).rows[0].n, null);
  assert.deepEqual((await pool.query("SELECT * FROM publication_admission")).rows, [{id:77}]);
  await pool.query("DROP TABLE publication_admission");
  // Even a role with DML rights on legacy tables is not an installation owner.
  await pool.query("CREATE ROLE fixture_runtime; GRANT USAGE, CREATE ON SCHEMA public TO fixture_runtime; GRANT ALL ON rooms,messages,room_resume_sessions TO fixture_runtime");
  await installer.query("SET ROLE fixture_runtime");
  await assert.rejects(installer.query(sql), /requires the existing table owner/);
  await installer.query("ROLLBACK; RESET ROLE");
  assert.equal((await pool.query("SELECT to_regclass('public.message_write_budget') AS n")).rows[0].n, null);
  await pool.query("REVOKE CREATE ON SCHEMA public FROM fixture_runtime");
  await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO fixture_runtime");
  await assert.rejects(installer.query(sql), /refuses inherited non-owner grants/);
  await installer.query("ROLLBACK");
  assert.equal((await pool.query("SELECT to_regclass('public.message_write_budget') AS n")).rows[0].n, null);
  await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM fixture_runtime");
  // A real old writer already in-flight must settle before snapshot/backfill.
  await installer.query("SET default_transaction_isolation = 'repeatable read'");
  await writer.query("BEGIN");
  await writer.query("INSERT INTO messages(room_id,username,content) VALUES ('cutover','old','inflight')");
  const pid = (await installer.query("SELECT pg_backend_pid() AS id")).rows[0].id;
  let done = false;
  const installing = installer.query(sql).finally(() => { done = true; });
  let blocked = false;
  for (let i=0; i<100; i++) {
    const row = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === "Lock") { blocked = true; break; }
    await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(blocked && !done, "installer must wait for old message writer");
  await writer.query("COMMIT");
  await installing;
  const budget = (await pool.query("SELECT * FROM message_write_budget")).rows[0];
  assert.equal(budget.used_rows, "2");
  assert.equal(budget.used_rows, budget.max_rows);
  assert.equal(budget.used_bytes, budget.max_bytes);
  assert.equal((await pool.query("SELECT id FROM messages EXCEPT SELECT message_id FROM message_publication_pending")).rowCount,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM message_publication_pending")).rows[0].n,2);
  for (const t of tables) assert.ok((await pool.query("SELECT to_regclass($1) AS n", ["public."+t])).rows[0].n);
  // No writer (including owner) gets capacity from installation.
  await assert.rejects(pool.query("INSERT INTO messages(room_id,username,content) VALUES ('cutover','old','closed')"), e=>(e as {code:string}).code==="53100");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM messages")).rows[0].n,2);
  await rejected("42P07");
  assert.deepEqual((await pool.query("SELECT * FROM message_write_budget")).rows[0],budget);
  // Runtime cannot open the budget or rewrite its accounting.
  await installer.query("SET ROLE fixture_runtime");
  await assert.rejects(installer.query("UPDATE message_write_budget SET max_rows=max_rows+1"),e=>(e as {code:string}).code==="42501");
  await installer.query("RESET ROLE");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n,11);
  console.log(JSON.stringify({status:"PASS",tables:6,backfilled:2,closed:true,oldWriterWait:true,
    partialRollback:true,nonOwnerRefused:true,ambientGrantsRefused:true,replayRefused:true,runtimeQuotaDenied:true,
    startupMigrationsUnchanged:11,productionApplied:false}));
} finally {
  await writer.query("ROLLBACK").catch(()=>{});
  writer.release(true); installer.release(true); await pool.end();
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
