import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Pool } from "pg";
import { RateLimitCleanup } from "../src/lib/rate-limit-cleanup";

// Owned random schema only; verifies this producer, NOT a global writer fence.
async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  assert.ok(connectionString, "isolated RESUME_TEST_DATABASE_URL required");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname));
  const schema = "expiry_qa_" + crypto.randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString });
  const writer = new Pool({ connectionString, options: "-c search_path=" + schema,
    application_name: schema });
  const lock = await admin.connect();
  let created = false;
  let locked = false;
  let owner: RateLimitCleanup | undefined;
  const now = 10_000_000, threshold = now - 3_600_000;
  const timers = new Set<{ callback(): void; unref(): void }>();
  const clock = {
    now: () => now,
    set(callback: () => void, delay: number) {
      assert.equal(delay, 300_000);
      const timer = { callback, unref() {} }; timers.add(timer); return timer;
    },
    clear(timer: { unref(): unknown }) {
      for (const item of timers) if (item === timer) timers.delete(item);
    },
  };
  function fire() {
    assert.equal(timers.size, 1);
    const timer = [...timers][0]; timers.delete(timer); timer.callback();
  }
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true;
    await writer.query('CREATE TABLE rate_limits (key text PRIMARY KEY, points int NOT NULL DEFAULT 0, expire bigint)');
    for (const prefix of ["create-room", "join-ip", "join-room", "upload"]) {
      await writer.query("INSERT INTO rate_limits(key,expire) VALUES($1,$2)", [prefix + ":old", threshold - 1]);
    }
    await writer.query("INSERT INTO rate_limits(key,expire) VALUES('boundary',$1),('future',$2),('permanent',NULL)", [threshold, now + 1]);
    await lock.query("BEGIN"); locked = true;
    await lock.query('LOCK TABLE "' + schema + '".rate_limits IN ACCESS EXCLUSIVE MODE');
    owner = new RateLimitCleanup(writer, clock);
    fire();
    const deadline = Date.now() + 5000;
    for (;;) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'DELETE FROM%'", [schema]);
      if (result.rowCount === 1) break;
      assert.ok(Date.now() < deadline, "expiry DELETE did not enter PostgreSQL lock wait");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    let settled = false;
    const stop = owner.stopAndSettle().then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, "stop must retain the actual locked query");
    assert.equal(timers.size, 0);
    await lock.query("COMMIT"); locked = false;
    assert.deepEqual(await stop, { completedRuns: 1, failedRuns: 0 });
    const rows = await writer.query("SELECT key FROM rate_limits ORDER BY key");
    assert.deepEqual(rows.rows.map(row => row.key), ["boundary", "future", "permanent"]);
    assert.equal(timers.size, 0, "no post-stop rearm");
    // A real PG rejection (missing table) must not count as successful DELETE.
    await writer.query("DROP TABLE rate_limits");
    owner = new RateLimitCleanup(writer, clock);
    fire();
    assert.deepEqual(await owner.stopAndSettle(), { completedRuns: 0, failedRuns: 1 });
    assert.equal(timers.size, 0);
    console.log(JSON.stringify({ result: "EXPIRY_PG_PASS", lockedQueryWaited: true,
      allFourPrefixesExpired: true, boundaryFutureNullPreserved: true,
      rejectedDeleteObservable: true, futureTimers: 0,
      scope: "owned schema, actual PG DELETE and lock; not whole-server drain" }));
  } finally {
    if (locked) await lock.query("ROLLBACK");
    await owner?.stopAndSettle();
    lock.release();
    await writer.end();
    if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

