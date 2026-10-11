import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeSessionCleanup } from "../src/lib/resume-session-cleanup";

async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname));
  const schema = "session_cleanup_" + randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: "-c search_path=" + schema, max: 1 });
  const lock = await admin.connect();
  const owner = new ResumeSessionCleanup(pool);
  let created = false, locked = false;
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true;
    await pool.query((await readFile("drizzle/0000_thin_stardust.sql", "utf8")).replaceAll('"public".', '"' + schema + '".'));
    await pool.query("ALTER TABLE rooms ADD COLUMN creation_token_hash text");
    await pool.query(await readFile("drizzle/0003_spotty_zombie.sql", "utf8"));
    await pool.query((await readFile("drizzle/0004_long_nighthawk.sql", "utf8")).replaceAll('"public".', '"' + schema + '".'));
    await pool.query((await readFile("drizzle/0006_cold_zuras.sql", "utf8")).replaceAll('"public".', '"' + schema + '".'));
    await pool.query("INSERT INTO rooms(id) VALUES('candy986')");
    const store = new ResumeStore(pool);
    const old = await store.issueAfterAuthenticatedJoin("candy986", "old", 1);
    const live = await store.issueAfterAuthenticatedJoin("candy986", "live", 1);
    assert.ok(old && live);
    for (const id of [old.sessionId, live.sessionId]) {
      await pool.query("INSERT INTO resume_message_receipts(session_id,client_message_id,payload_hash,message_id) SELECT $1, lpad(n::text,4,'0'),repeat('a',64),NULL FROM generate_series(1,257) n", [id]);
    }
    await pool.query("UPDATE room_resume_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [old.sessionId]);
    const count = async (id: string) => Number((await pool.query("SELECT count(*) FROM resume_message_receipts WHERE session_id=$1", [id])).rows[0].count);
    await lock.query("BEGIN"); locked = true;
    await lock.query('SELECT id FROM "' + schema + '".room_resume_sessions WHERE id=$1 FOR UPDATE', [old.sessionId]);
    assert.deepEqual(await owner.runOnce(), { sessions: 0, receipts: 0 });
    await lock.query("COMMIT"); locked = false;
    assert.deepEqual(await owner.runOnce(), { sessions: 0, receipts: 100 });
    assert.equal(await count(old.sessionId), 157);
    assert.equal(await count(live.sessionId), 257);
    // Real receipt lock forces lock_timeout, with rollback preserving all 157.
    await lock.query("BEGIN"); locked = true;
    await lock.query('SELECT * FROM "' + schema + '".resume_message_receipts WHERE session_id=$1 ORDER BY client_message_id LIMIT 1 FOR UPDATE', [old.sessionId]);
    await assert.rejects(owner.runOnce(), (error: unknown) => (error as { code: string }).code === "55P03");
    await lock.query("COMMIT"); locked = false;
    assert.equal(await count(old.sessionId), 157);
    assert.deepEqual(await owner.runOnce(), { sessions: 0, receipts: 100 });
    assert.deepEqual(await owner.runOnce(), { sessions: 1, receipts: 57 });
    assert.equal(await count(old.sessionId), 0);
    assert.equal(await count(live.sessionId), 257);
    assert.deepEqual(await owner.runOnce(), { sessions: 0, receipts: 0 });
    // Preserve revoked but unexpired receipts too, including an actual message.
    await pool.query("UPDATE room_resume_sessions SET revoked_at=now() WHERE id=$1", [live.sessionId]);
    const message = await pool.query("INSERT INTO messages(room_id,username,content) VALUES('candy986','live','retained') RETURNING id");
    await pool.query("UPDATE resume_message_receipts SET message_id=$1 WHERE session_id=$2 AND client_message_id='0001'", [message.rows[0].id, live.sessionId]);
    assert.deepEqual(await owner.runOnce(), { sessions: 0, receipts: 0 });
    assert.equal(await count(live.sessionId), 257);
    assert.equal((await pool.query("SELECT count(*) FROM messages")).rows[0].count, "1");

    // A genuine server statement_timeout after partial row work must undo it.
    const slow = await store.issueAfterAuthenticatedJoin("candy986", "slow", 1);
    assert.ok(slow);
    await pool.query("UPDATE room_resume_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [slow.sessionId]);
    await pool.query("INSERT INTO resume_message_receipts(session_id,client_message_id,payload_hash) SELECT $1,n::text,repeat('b',64) FROM generate_series(1,100) n", [slow.sessionId]);
    await pool.query("CREATE FUNCTION slow_receipt_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.02); RETURN OLD; END $$");
    await pool.query("CREATE TRIGGER slow_receipt BEFORE DELETE ON resume_message_receipts FOR EACH ROW EXECUTE FUNCTION slow_receipt_delete()");
    const stoppingOwner = new ResumeSessionCleanup(pool);
    const execution = stoppingOwner.runOnce();
    const rejected = assert.rejects(execution, (error: unknown) => (error as { code: string }).code === "57014");
    const deadline = Date.now() + 5000;
    for (;;) {
      const activity = await admin.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%WITH batch AS MATERIALIZED%'");
      if (activity.rowCount) break;
      assert.ok(Date.now() < deadline, "cleanup did not enter slow trigger");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    let settled = false;
    const stopping = assert.rejects(stoppingOwner.stopAndSettle(), (error: unknown) => (error as { code: string }).code === "57014").then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await rejected; await stopping;
    assert.equal(await count(slow.sessionId), 100);
    await pool.query("DROP TRIGGER slow_receipt ON resume_message_receipts");
    assert.deepEqual(await owner.runOnce(), { sessions: 1, receipts: 100 });
    await owner.stopAndSettle();
    console.log(JSON.stringify({ result: "SESSION_CLEANUP_PG_PASS", receiptBatches: [100,100,57],
      liveReceiptsRetained: 257, revokedUnexpiredRetained: true, lockedSessionSkipped: true,
      receiptLockTimeoutRolledBack: true, statementTimeoutRolledBack: true, stopWaitedForCancellation: true,
      scope: "private primitive; no scheduler, physical WAL bound or public activation" }));
  } finally {
    if (locked) await lock.query("ROLLBACK");
    await owner.stopAndSettle().catch(() => {});
    lock.release(); await pool.end();
    if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
