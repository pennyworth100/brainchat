import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Pool, type PoolClient } from "pg";
import { ResumeUploadReservations, type ReservationOutcome } from "../src/lib/resume-upload-reservation";

async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  if (!connectionString) throw Error("RESUME_TEST_DATABASE_URL required (isolated DB only)");
  const schema = process.argv[2] || "reservation_qa_" + randomBytes(8).toString("hex");
  if (!/^reservation_qa_[0-9a-f]{16}$/.test(schema)) throw Error("Invalid fixture schema");
  const pool = new Pool({ connectionString, options: "-c search_path=" + schema, max: 16 });
  const input = { sessionId: randomUUID(), roomId: "candy986", clientMessageId: "same_logical_key", reservedBytes: 10 };
  if (process.argv[2]) {
    const outcome = await new ResumeUploadReservations(pool).reserve(input);
    process.send!(outcome);
    // Parent kills this real worker only after it has received a COMMIT result.
    setInterval(() => {}, 1000);
    return;
  }
  const admin = new Pool({ connectionString });
  let checks = 0;
  const check = (value: unknown) => { assert.ok(value); checks++; };
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"');
    await pool.query(await readFile("drizzle/0008_dark_grim_reaper.sql", "utf8"));
    const ledger = new ResumeUploadReservations(pool);
    check((await ledger.reserve(input)).status === "denied");
    await pool.query("INSERT INTO resume_upload_budget VALUES (1, 100, 0)");
    const results = await Promise.all(Array.from({ length: 32 }, () => ledger.reserve(input)));
    check(results.filter(r => r.status === "reserved").length === 10);
    check(results.filter(r => r.status === "denied").length === 22);
    check((await pool.query("SELECT reserved_bytes FROM resume_upload_budget")).rows[0].reserved_bytes === "100");
    check((await pool.query("SELECT count(*) FROM resume_upload_attempts")).rows[0].count === "10");
    // Retrying the same logical message is a distinct charged attempt, never a
    // replay of storage authority. Existing provenance must remain unchanged.
    await pool.query("UPDATE resume_upload_budget SET capacity_bytes = 150");
    const lost = new ResumeUploadReservations({ connect: async () => {
      const real = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await real.query(sql, values);
        if (sql === "COMMIT") throw Error("controlled lost COMMIT acknowledgement");
        return result;
      }, on: real.on.bind(real), removeListener: real.removeListener.bind(real), release: real.release.bind(real) } as unknown as PoolClient;
    } });
    const uncertain = await lost.reserve(input);
    check(uncertain.status === "failed" && uncertain.commit === "unknown");
    assert.ok(uncertain.status === "failed");
    check((await pool.query("SELECT count(*) FROM resume_upload_attempts WHERE storage_key=$1", [uncertain.attempt.storageKey])).rows[0].count === "1");
    check((await pool.query("SELECT reserved_bytes FROM resume_upload_budget")).rows[0].reserved_bytes === "110");
    // Actual SQL constraint failure occurs AFTER the counter UPDATE: rollback
    // must undo the counter and must not leave orphan attempt provenance.
    await pool.query("ALTER TABLE resume_upload_attempts ADD CONSTRAINT fixture_reject CHECK (client_message_id <> 'reject')");
    const failed = await ledger.reserve({ ...input, clientMessageId: "reject" });
    check(failed.status === "failed" && failed.commit === "not-dispatched");
    check((await pool.query("SELECT reserved_bytes FROM resume_upload_budget")).rows[0].reserved_bytes === "110");
    const child = fork(process.argv[1], [schema], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    try {
      const received = once(child, "message", { signal: AbortSignal.timeout(10000) });
      const [message] = await received as [ReservationOutcome];
      check(message.status === "reserved");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      const [, signal] = await exited;
      check(signal === "SIGKILL");
      assert.ok(message.status === "reserved");
      const restarted = new Pool({ connectionString, options: "-c search_path=" + schema });
      try {
        check((await restarted.query("SELECT reserved_bytes FROM resume_upload_budget")).rows[0].reserved_bytes === "120");
        check((await restarted.query("SELECT count(*) FROM resume_upload_attempts WHERE storage_key=$1", [message.attempt.storageKey])).rows[0].count === "1");
        check((await new ResumeUploadReservations(restarted).reserve({ ...input, reservedBytes: 31 })).status === "denied");
      } finally { await restarted.end(); }
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    // There is deliberately no FK to a session/room or any expiry/refund path.
    check((await pool.query("SELECT count(*) FROM pg_constraint WHERE conrelid='resume_upload_attempts'::regclass AND contype='f'")).rows[0].count === "0");
    console.log(JSON.stringify({ passed: checks, concurrentAttempts: 32, accepted: 10, rejected: 22, lostCommitAck: true, workerSIGKILL: true }));
  } finally {
    await pool.end();
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
