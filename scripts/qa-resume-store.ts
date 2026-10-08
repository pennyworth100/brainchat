import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeOperationGate } from "../src/lib/resume-operation";

// Explicit opt-in only. Never infer a live DATABASE_URL as permission to test.
async function main() {
if (!process.env.RESUME_TEST_DATABASE_URL) throw new Error("RESUME_TEST_DATABASE_URL required (isolated DB only)");
const pool = new Pool({ connectionString: process.env.RESUME_TEST_DATABASE_URL });
const schema = "resume_qa_" + randomBytes(8).toString("hex");
const operationPool = new Pool({ connectionString: process.env.RESUME_TEST_DATABASE_URL,
  options: "-c search_path=" + schema, max: 1 });
const a = await pool.connect();
const b = await pool.connect();
let checks = 0;
const check = (value: unknown) => { assert.ok(value); checks++; };
try {
  await a.query('CREATE SCHEMA "' + schema + '"');
  for (const client of [a, b]) await client.query('SET search_path TO "' + schema + '"');
  await a.query("CREATE TABLE rooms (id text PRIMARY KEY)");
  // Apply the actual generated additive migration, scoped to our private fixture.
  const sql = (await readFile("drizzle/0004_long_nighthawk.sql", "utf8"))
    .replaceAll('"public"."rooms"', '"' + schema + '"."rooms"');
  await a.query(sql);
  await a.query(await readFile("drizzle/0005_free_blazing_skull.sql", "utf8"));
  await a.query("INSERT INTO rooms (id) VALUES ('candy986'), ('spoon651')");
  const first = new ResumeStore(a);
  const second = new ResumeStore(b);
  const secondPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const waitForBlockedSecond = async (pid = secondPid) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await a.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
      if (waiting.rows[0]?.wait_event_type === "Lock") return;
      // Refresh statistics within the controlling transaction.
      await a.query("SELECT pg_stat_clear_snapshot()");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Expected a real competing database lock wait");
  };
  const issued = await first.issueAfterAuthenticatedJoin("candy986", "Guest", 1);
  assert.ok(issued);
  const credential = { roomId: issued.roomId, sessionId: issued.sessionId, token: issued.token };
  check(issued.expiresAt.getTime() - issued.issuedAt.getTime() === 86_400_000);
  const persisted = await a.query("SELECT * FROM room_resume_sessions");
  check(!JSON.stringify(persisted.rows).includes(issued.token));
  check(persisted.rows[0].token_hash.length === 64);
  const recovered = await second.lookup(credential);
  check(recovered?.username === "Guest" && recovered.generation === 0);
  check(recovered?.expiresAt.getTime() === issued.expiresAt.getTime());
  check(!("tokenHash" in recovered!) && !("token" in recovered!));
  check(await second.lookup({ ...credential, roomId: "spoon651" }) === null);
  check(await second.lookup({ ...credential, token: randomBytes(32).toString("base64url") }) === null);
  check(await second.revoke(credential, 1) === false);
  check(await second.lookup(credential) !== null);
  await a.query("UPDATE rooms SET auth_version = 2 WHERE id = 'candy986'");
  check(await second.lookup(credential) === null);
  check(await first.issueAfterAuthenticatedJoin("candy986", "Guest", 1) === null);
  const current = await first.issueAfterAuthenticatedJoin("candy986", "Guest", 2);
  assert.ok(current);
  const currentCredential = { roomId: current.roomId, sessionId: current.sessionId, token: current.token };
  check(await second.lookup(currentCredential) !== null);
  check(await second.revoke(currentCredential, 0) === true);
  check(await first.lookup(currentCredential) === null);
  check(await second.revoke(currentCredential, 0) === false);
  const expired = await first.issueAfterAuthenticatedJoin("candy986", "Guest", 2);
  assert.ok(expired);
  await a.query("UPDATE room_resume_sessions SET expires_at = statement_timestamp() WHERE id = $1", [expired.sessionId]);
  check(await second.lookup({ roomId: expired.roomId, sessionId: expired.sessionId, token: expired.token }) === null);
  check(await first.issueAfterAuthenticatedJoin("other123", "Guest", 1) === null);
  const cas = await first.issueAfterAuthenticatedJoin("candy986", "CAS Guest", 2);
  assert.ok(cas);
  const cc = { roomId: cas.roomId, sessionId: cas.sessionId, token: cas.token };
  const opA = "operation_A_123456", opB = "operation_B_123456";
  const socketA = "transport_A_123456", socketB = "transport_B_123456";
  const race = await Promise.all([
    first.advanceGeneration(cc, 0, opA, socketA),
    second.advanceGeneration(cc, 0, opB, socketB),
  ]);
  check(race.filter(Boolean).length === 1);
  const winner = race[0] ? { op: opA, socket: socketA } : { op: opB, socket: socketB };
  check(race.find(Boolean)?.generation === 1);
  check((await second.advanceGeneration(cc, 0, winner.op, winner.socket))?.generation === 1);
  check(await second.advanceGeneration(cc, 0, winner.op, "different_socket_123") === null);
  check(await second.advanceGeneration(cc, 1, winner.op, winner.socket) === null);
  check((await first.lookup(cc))?.generation === 1);
  check((await first.lookup(cc))?.expiresAt.getTime() === cas.expiresAt.getTime());
  check(await first.revoke(cc, 0) === false);
  check(await first.advanceGeneration({ ...cc, roomId: "spoon651" }, 1, "operation_C_123456", socketA) === null);
  check(await first.advanceGeneration({ ...cc, token: randomBytes(32).toString("base64url") }, 1, "operation_C_123456", socketA) === null);
  // New transport explicitly recovers generation through read-only lookup, then
  // makes a new operation. The data layer never retries a losing CAS itself.
  check((await second.advanceGeneration(cc, 1, "operation_C_123456", socketB))?.generation === 2);
  check(await first.advanceGeneration(cc, 0, winner.op, winner.socket) === null);
  const retries = await Promise.all([
    first.advanceGeneration(cc, 2, "operation_D_123456", socketB),
    second.advanceGeneration(cc, 2, "operation_D_123456", socketB),
  ]);
  check(retries.every(result => result?.generation === 3));
  check((await first.lookup(cc))?.generation === 3);
  check(await second.revoke(cc, 3) === true);
  check(await first.advanceGeneration(cc, 2, "operation_D_123456", socketB) === null);
  check(await first.advanceGeneration(cc, 3, "operation_E_123456", socketB) === null);
  check(await first.advanceGeneration(credential, 0, opA, socketA) === null); // stale authVersion
  check(await first.advanceGeneration({ roomId: expired.roomId, sessionId: expired.sessionId, token: expired.token }, 0, opA, socketA) === null);
  const unchanged = (await a.query("SELECT generation FROM room_resume_sessions WHERE id = $1", [cas.sessionId])).rows[0];
  check(unchanged.generation === 3);
  // Force a session-row lock wait, then revoke before the pending CAS can run.
  const locked = await first.issueAfterAuthenticatedJoin("candy986", "Locked Guest", 2);
  assert.ok(locked);
  const lc = { roomId: locked.roomId, sessionId: locked.sessionId, token: locked.token };
  await a.query("BEGIN");
  await a.query("SELECT id FROM room_resume_sessions WHERE id = $1 FOR UPDATE", [locked.sessionId]);
  const pending = second.advanceGeneration(lc, 0, opA, socketA);
  await waitForBlockedSecond();
  await a.query("UPDATE room_resume_sessions SET revoked_at = clock_timestamp() WHERE id = $1", [locked.sessionId]);
  await a.query("COMMIT");
  check(await pending === null);
  check((await a.query("SELECT generation FROM room_resume_sessions WHERE id = $1", [locked.sessionId])).rows[0].generation === 0);
  const policy = await first.issueAfterAuthenticatedJoin("candy986", "Policy Guest", 2);
  assert.ok(policy);
  await a.query("BEGIN");
  await a.query("UPDATE rooms SET auth_version = 3 WHERE id = 'candy986'");
  const policyPending = second.advanceGeneration({ roomId: policy.roomId, sessionId: policy.sessionId, token: policy.token }, 0, opA, socketA);
  await waitForBlockedSecond();
  await a.query("COMMIT");
  check(await policyPending === null);
  check((await a.query("SELECT generation FROM room_resume_sessions WHERE id = $1", [policy.sessionId])).rows[0].generation === 0);
  // Durable operation gate: real competing clients, actual writes and rollback.
  await a.query("CREATE TABLE operation_probe (label text NOT NULL)");
  const probeClient = await operationPool.connect();
  const operationPid = (await probeClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  probeClient.release();
  const bindings = new ResumeBindings();
  const gate = new ResumeOperationGate(operationPool, bindings);
  const makeBinding = async () => {
    const session = await first.issueAfterAuthenticatedJoin("candy986", "Writer", 3);
    assert.ok(session);
    const credential = { roomId: session.roomId, sessionId: session.sessionId, token: session.token };
    const identity = await first.advanceGeneration(credential, 0, opA, socketA);
    assert.ok(identity);
    const binding = await bindings.activate(identity, socketA, async () => {}, () => true);
    assert.ok(binding);
    return { credential, binding };
  };
  const count = async () => Number((await a.query("SELECT count(*) FROM operation_probe")).rows[0].count);
  let calls = 0;
  const write = async (tx: Pick<typeof a, "query">) => {
    calls++;
    await tx.query("INSERT INTO operation_probe VALUES ('committed')");
    return "receipt";
  };
  const happy = await makeBinding();
  const result = await gate.run(happy.binding, write);
  check(result.authorized && result.value === "receipt");
  check(await count() === 1);
  check(!(await gate.run({ ...happy.binding }, write)).authorized);
  check(calls === 1); // copied object never reaches database work

  // CAS commits first while operation is blocked: old local binding still looks
  // current, but the durable generation wins and the callback is never invoked.
  const superseded = await makeBinding();
  await a.query("BEGIN");
  await first.advanceGeneration(superseded.credential, 1, opB, socketB);
  const oldWrite = gate.run(superseded.binding, write);
  await waitForBlockedSecond(operationPid);
  await a.query("COMMIT");
  check(!(await oldWrite).authorized);
  check(calls === 1 && await count() === 1);

  // Conversely, an authorized write holds the session lock until commit; CAS
  // must wait, so this write cannot be persisted after a successor wins.
  const winnerWrite = await makeBinding();
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const heldWrite = gate.run(winnerWrite.binding, async tx => {
    await write(tx); entered(); await release; return "serialized";
  });
  await ready;
  const waitingCas = second.advanceGeneration(winnerWrite.credential, 1, opB, socketB);
  await waitForBlockedSecond();
  finish();
  check((await heldWrite).authorized);
  check((await waitingCas)?.generation === 2);
  check(await count() === 2);
  check(!(await gate.run(winnerWrite.binding, write)).authorized);

  const revokedWrite = await makeBinding();
  await a.query("BEGIN");
  await first.revoke(revokedWrite.credential, 1);
  const afterRevoke = gate.run(revokedWrite.binding, write);
  await waitForBlockedSecond(operationPid);
  await a.query("COMMIT");
  check(!(await afterRevoke).authorized);
  check(calls === 2);

  const expiryWrite = await makeBinding();
  await a.query("BEGIN");
  await a.query("SELECT id FROM room_resume_sessions WHERE id = $1 FOR UPDATE", [expiryWrite.binding.sessionId]);
  const afterExpiry = gate.run(expiryWrite.binding, write);
  await waitForBlockedSecond(operationPid);
  await a.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() WHERE id = $1", [expiryWrite.binding.sessionId]);
  await a.query("COMMIT");
  check(!(await afterExpiry).authorized);
  check(calls === 2); // DB expiry overrides still-unexpired local binding

  const disconnected = await makeBinding();
  check(!(await gate.run(disconnected.binding, async tx => {
    await write(tx); bindings.detach(disconnected.binding);
  })).authorized);
  check(await count() === 2); // mutation rolled back after local disconnect
  const failed = await makeBinding();
  await assert.rejects(gate.run(failed.binding, async tx => {
    await write(tx); throw new Error("controlled callback failure");
  }));
  checks++;
  check(await count() === 2);
  const failingSql = await makeBinding();
  await assert.rejects(gate.run(failingSql.binding, async tx => {
    await write(tx); await tx.query("SELECT 1 / 0");
  }));
  checks++;
  check(await count() === 2);
  const expiresDuringWork = await makeBinding();
  check(!(await gate.run(expiresDuringWork.binding, async tx => {
    await write(tx);
    await tx.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() WHERE id = $1",
      [expiresDuringWork.binding.sessionId]);
  })).authorized);
  check(await count() === 2);

  const policyWrite = await makeBinding();
  const currentOperationClient = await operationPool.connect();
  const currentOperationPid = (await currentOperationClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  currentOperationClient.release();
  await a.query("BEGIN");
  await a.query("UPDATE rooms SET auth_version = 4 WHERE id = 'candy986'");
  const afterPolicy = gate.run(policyWrite.binding, write);
  // Failed operations discard their checkouts; observe the replacement PID.
  await waitForBlockedSecond(currentOperationPid);
  await a.query("COMMIT");
  check(!(await afterPolicy).authorized);
  check(await count() === 2);
  await a.query("DELETE FROM rooms WHERE id = 'candy986'");
  check(Number((await a.query("SELECT count(*) FROM room_resume_sessions")).rows[0].count) === 0);
  console.log(JSON.stringify({ suite: "resume-store-postgresql", checks, result: "PASS", scope: "isolated generated migrations + independent DB clients, CAS and durable-operation lock races; not socket resume" }));
} finally {
  await a.query("ROLLBACK");
  await a.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
  a.release();
  b.release();
  await operationPool.end();
  await pool.end();
}
}

main().catch(() => {
  // Do not dump database errors/parameters or bearer values into CI logs.
  console.error("Resume persistence PostgreSQL checks FAILED");
  process.exitCode = 1;
});
