import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeAdmission } from "../src/lib/resume-admission";
import { ResumeOperationGate } from "../src/lib/resume-operation";
import { ResumeHistoryReader } from "../src/lib/resume-history";
import { insertResumeTextMessage, ResumeMessageWriter } from "../src/lib/resume-message";
import { claimRoomPolicy } from "../src/lib/room-policy";

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
  await a.query((await readFile("drizzle/0000_thin_stardust.sql", "utf8"))
    .replaceAll('"public"."rooms"', '"' + schema + '"."rooms"'));
  await a.query("ALTER TABLE rooms ADD COLUMN creation_token_hash text");
  await a.query(await readFile("drizzle/0003_spotty_zombie.sql", "utf8"));
  // Apply the actual generated additive migration, scoped to our private fixture.
  const sql = (await readFile("drizzle/0004_long_nighthawk.sql", "utf8"))
    .replaceAll('"public"."rooms"', '"' + schema + '"."rooms"');
  await a.query(sql);
  await a.query(await readFile("drizzle/0005_free_blazing_skull.sql", "utf8"));
  await a.query(await readFile("drizzle/0007_motionless_wolfpack.sql", "utf8"));
  await a.query((await readFile("drizzle/0006_cold_zuras.sql", "utf8"))
    .replaceAll('"public".', '"' + schema + '".'));
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
  const probeClient = await operationPool.connect();
  const operationPid = (await probeClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  probeClient.release();
  const bindings = new ResumeBindings();
  const gate = new ResumeOperationGate(operationPool, bindings);
  const makeBinding = async () => {
    const session = await first.issueAfterAuthenticatedJoin("candy986", "Writer", 3);
    assert.ok(session);
    const credential = { roomId: session.roomId, sessionId: session.sessionId, token: session.token };
    const transportId = "transport_" + session.sessionId;
    const identity = await first.advanceGeneration(credential, 0, opA, transportId);
    assert.ok(identity);
    const binding = await bindings.activate(identity, transportId, async () => {}, () => true);
    assert.ok(binding);
    return { credential, binding };
  };
  const count = async () => Number((await a.query("SELECT count(*) FROM messages")).rows[0].count);
  let calls = 0;
  const write = async (tx: Pick<typeof a, "query">, binding = happy.binding) => {
    calls++;
    await insertResumeTextMessage(tx, binding, "committed");
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
    await write(tx, winnerWrite.binding); entered(); await release; return "serialized";
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
    await write(tx, disconnected.binding); bindings.detach(disconnected.binding);
  })).authorized);
  check(await count() === 2); // mutation rolled back after local disconnect
  const failed = await makeBinding();
  await assert.rejects(gate.run(failed.binding, async tx => {
    await write(tx, failed.binding); throw new Error("controlled callback failure");
  }));
  checks++;
  check(await count() === 2);
  const failingSql = await makeBinding();
  await assert.rejects(gate.run(failingSql.binding, async tx => {
    await write(tx, failingSql.binding); await tx.query("SELECT 1 / 0");
  }));
  checks++;
  check(await count() === 2);
  const expiresDuringWork = await makeBinding();
  check(!(await gate.run(expiresDuringWork.binding, async tx => {
    await write(tx, expiresDuringWork.binding);
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
  // Actual writer uses the same gate and exact binding identity, not caller room/name.
  const currentSession = await first.issueAfterAuthenticatedJoin("candy986", "Writer", 4);
  assert.ok(currentSession);
  const currentIdentity = await first.advanceGeneration({ roomId: currentSession.roomId,
    sessionId: currentSession.sessionId, token: currentSession.token }, 0, opA, "transport_" + currentSession.sessionId);
  assert.ok(currentIdentity);
  const currentBinding = await bindings.activate(currentIdentity, "transport_" + currentIdentity.sessionId, async () => {}, () => true);
  assert.ok(currentBinding);
  const writer = new ResumeMessageWriter(gate);
  const saved = await writer.save(currentBinding, "  literal ' $1 text  ");
  check(saved.authorized && saved.value.username === "Writer" &&
    saved.value.message === "  literal ' $1 text  " && Number.isFinite(saved.value.ts));
  check(await count() === 3);
  const stored = (await a.query("SELECT * FROM messages ORDER BY id DESC LIMIT 1")).rows[0];
  check(saved.authorized && stored.id === saved.value.id && stored.room_id === "candy986" &&
    stored.username === "Writer" && stored.client_message_id === null);
  check(!(await writer.save({ ...currentBinding }, "forged")).authorized);
  await assert.rejects(writer.save(currentBinding, " ")); checks++;
  await assert.rejects(writer.save(currentBinding, "x".repeat(10001))); checks++;
  check(await count() === 3);
  // Same-username sessions do not accidentally collide with the agent unique key.
  const agent = await a.query("INSERT INTO messages (room_id, username, content, client_message_id) VALUES ('candy986', 'Writer', 'agent', 'key') RETURNING id");
  const secondSaved = await writer.save(currentBinding, "agent");
  check(secondSaved.authorized && secondSaved.value.id !== agent.rows[0].id);
  check(await count() === 5); // no durable retry/deduplication claim
  const sibling = await first.issueAfterAuthenticatedJoin("candy986", "Writer", 4);
  assert.ok(sibling);
  const siblingIdentity = await first.advanceGeneration({ roomId: sibling.roomId,
    sessionId: sibling.sessionId, token: sibling.token }, 0, opA, "transport_" + sibling.sessionId);
  assert.ok(siblingIdentity);
  let conflictingPrepare = false;
  check(await bindings.activate(siblingIdentity, currentBinding.transportId,
    async () => { conflictingPrepare = true; }, () => true) === null);
  check(!conflictingPrepare && bindings.isCurrent(currentBinding));
  const siblingBinding = await bindings.activate(siblingIdentity, "transport_" + siblingIdentity.sessionId, async () => {}, () => true);
  assert.ok(siblingBinding);
  const siblingSaved = await writer.save(siblingBinding, "agent");
  check(siblingSaved.authorized && secondSaved.authorized &&
    siblingSaved.value.id !== secondSaved.value.id);
  check(await count() === 6);
  check((await writer.save(siblingBinding, "x".repeat(10000))).authorized);
  check(await count() === 7);
  // Write wins first: real room-policy mutation waits until message COMMIT.
  let messageEntered!: () => void, messageFinish!: () => void;
  const messageReady = new Promise<void>(r => { messageEntered = r; });
  const messageRelease = new Promise<void>(r => { messageFinish = r; });
  const beforePolicy = gate.run(currentBinding, async tx => {
    const receipt = await insertResumeTextMessage(tx, currentBinding, "before policy");
    messageEntered(); await messageRelease; return receipt;
  });
  await messageReady;
  const pendingPolicy = b.query("UPDATE rooms SET auth_version = 5 WHERE id = 'candy986'");
  await waitForBlockedSecond();
  messageFinish();
  check((await beforePolicy).authorized);
  await pendingPolicy;
  check(await count() === 8);
  check(!(await writer.save(currentBinding, "after policy")).authorized);
  check(!(await writer.save(siblingBinding, "after policy")).authorized);
  check(await count() === 8);
  await a.query("DELETE FROM messages WHERE room_id = 'candy986'");
  await a.query("DELETE FROM rooms WHERE id = 'candy986'");
  check(Number((await a.query("SELECT count(*) FROM room_resume_sessions")).rows[0].count) === 0);
  // A claim consumes the token and increments policy in ONE write. A second
  // claimant actually waits on the first updater, then loses without mutation.
  await a.query("INSERT INTO rooms (id, creation_token_hash) VALUES ('claim123', 'claim-token')");
  check(await first.issueAfterAuthenticatedJoin("claim123", "Guest", 1) === null);
  check(await claimRoomPolicy(a, "claim123", "wrong-token", "wrong-password") === null);
  await a.query("BEGIN");
  const claim = await claimRoomPolicy(a, "claim123", "claim-token", "password-A");
  check(claim?.authVersion === 2 && claim.passwordHash === "password-A" && claim.creationTokenHash === null);
  const losingClaim = claimRoomPolicy(b, "claim123", "claim-token", "password-B");
  await waitForBlockedSecond();
  await a.query("COMMIT");
  check(await losingClaim === null);
  const claimedRow = (await a.query("SELECT * FROM rooms WHERE id = 'claim123'")).rows[0];
  check(claimedRow.auth_version === 2 && claimedRow.password_hash === "password-A" && claimedRow.creation_token_hash === null);
  check(await second.issueAfterAuthenticatedJoin("claim123", "Guest", 1) === null);
  check((await second.issueAfterAuthenticatedJoin("claim123", "x".repeat(64), 2))?.username.length === 64);
  await assert.rejects(first.issueAfterAuthenticatedJoin("claim123", "x".repeat(65), 2)); checks++;

  // Policy wins first: issuance blocks on the real row lock and rechecks the
  // version after commit; its older statement snapshot cannot mint a token.
  const beforePolicyIssue = Number((await a.query("SELECT count(*) FROM room_resume_sessions")).rows[0].count);
  await a.query("BEGIN");
  await a.query("UPDATE rooms SET auth_version = auth_version + 1 WHERE id = 'claim123'");
  const pendingIssue = second.issueAfterAuthenticatedJoin("claim123", "Stale auth", 2);
  await waitForBlockedSecond();
  await a.query("COMMIT");
  check(await pendingIssue === null);
  check(Number((await a.query("SELECT count(*) FROM room_resume_sessions")).rows[0].count) === beforePolicyIssue);

  // Issuance wins first: its SHARE lock holds the policy updater until commit.
  await a.query("BEGIN");
  const issuedBeforePolicy = await first.issueAfterAuthenticatedJoin("claim123", "Fresh auth", 3);
  assert.ok(issuedBeforePolicy);
  const waitingPolicy = b.query("UPDATE rooms SET auth_version = auth_version + 1 WHERE id = 'claim123'");
  await waitForBlockedSecond();
  await a.query("COMMIT");
  await waitingPolicy;
  const oldCredential = { roomId: "claim123", sessionId: issuedBeforePolicy.sessionId, token: issuedBeforePolicy.token };
  check(await first.lookup(oldCredential) === null);
  check(await first.advanceGeneration(oldCredential, 0, opA, socketA) === null);
  check((await first.issueAfterAuthenticatedJoin("claim123", "Current auth", 4))?.authVersion === 4);
  // Retry receipts use a separate room so earlier exact row-count assertions stay useful.
  await a.query("INSERT INTO rooms (id) VALUES ('retry123')");
  const retrySession = await first.issueAfterAuthenticatedJoin("retry123", "Writer", 1);
  assert.ok(retrySession);
  const retryCredential = { roomId: "retry123", sessionId: retrySession.sessionId, token: retrySession.token };
  const retryIdentity = await first.advanceGeneration(retryCredential, 0, opA, "transport_" + retrySession.sessionId);
  assert.ok(retryIdentity);
  const retryBinding = await bindings.activate(retryIdentity, "transport_" + retryIdentity.sessionId, async () => {}, () => true);
  assert.ok(retryBinding);
  const retryCount = async () => Number((await a.query("SELECT count(*) FROM messages WHERE room_id = 'retry123'")).rows[0].count);
  const parallelPool = new Pool({ connectionString: process.env.RESUME_TEST_DATABASE_URL,
    options: "-c search_path=" + schema, max: 1 });
  try {
    const parallelWriter = new ResumeMessageWriter(new ResumeOperationGate(parallelPool, bindings));
    const sameKey = await Promise.all([writer.saveOnce(retryBinding, "same-key", "text"),
      parallelWriter.saveOnce(retryBinding, "same-key", "text")]);
    check(sameKey.every(r => r.authorized));
    check(sameKey[0].authorized && sameKey[1].authorized && sameKey[0].value.id === sameKey[1].value.id);
    check(await retryCount() === 1);
    await assert.rejects(writer.saveOnce(retryBinding, "same-key", "changed"), /identity conflict/); checks++;
    check(await retryCount() === 1);
    for (const invalid of ["", "x".repeat(129), "white space", "key\n"]) {
      await assert.rejects(writer.saveOnce(retryBinding, invalid, "text")); checks++;
    }
    check(!(await writer.saveOnce({ ...retryBinding }, "same-key", "text")).authorized);
    check((await writer.saveOnce(retryBinding, "other-key", "text")).authorized);
    const peer = await first.issueAfterAuthenticatedJoin("retry123", "Writer", 1);
    assert.ok(peer);
    const peerIdentity = await first.advanceGeneration({ roomId: peer.roomId, sessionId: peer.sessionId, token: peer.token }, 0, opA, "transport_" + peer.sessionId);
    assert.ok(peerIdentity);
    const peerBinding = await bindings.activate(peerIdentity, "transport_" + peerIdentity.sessionId, async () => {}, () => true);
    assert.ok(peerBinding);
    check((await writer.saveOnce(peerBinding, "same-key", "text")).authorized);
    await a.query("INSERT INTO messages (room_id, username, content, client_message_id) VALUES ('retry123', 'Writer', 'text', 'same-key')");
    check(await retryCount() === 4);
    // Real database COMMIT succeeds; only its acknowledgment is lost.
    let commitAttempts = 0;
    const lostAckPool = { connect: async () => {
      const real = await parallelPool.connect();
      return { query: async (...args: unknown[]) => {
        const result = await (real.query as Function).apply(real, args);
        if (args[0] === "COMMIT") { commitAttempts++; throw new Error("lost COMMIT ack"); }
        return result;
      }, release: real.release.bind(real) } as unknown as import("pg").PoolClient;
    } };
    const lostAckWriter = new ResumeMessageWriter(new ResumeOperationGate(lostAckPool, bindings));
    await assert.rejects(lostAckWriter.saveOnce(retryBinding, "lost-ack", "durable"), /lost COMMIT ack/); checks++;
    check(commitAttempts === 1 && await retryCount() === 5);
    const successorIdentity = await first.advanceGeneration(retryCredential, 1, opB, "transport_" + retrySession.sessionId + "_successor");
    assert.ok(successorIdentity);
    const successor = await bindings.activate(successorIdentity, "transport_" + successorIdentity.sessionId + "_successor", async () => {}, () => true);
    assert.ok(successor);
    check(!(await writer.saveOnce(retryBinding, "lost-ack", "durable")).authorized);
    const resolved = await writer.saveOnce(successor, "lost-ack", "durable");
    check(resolved.authorized && resolved.value.message === "durable");
    check(await retryCount() === 5);
    // Receipt insertion failure rolls back its preceding message INSERT.
    await a.query("ALTER TABLE resume_message_receipts ADD CONSTRAINT qa_reject CHECK (client_message_id <> 'rollback-key')");
    await assert.rejects(writer.saveOnce(successor, "rollback-key", "rollback")); checks++;
    await a.query("ALTER TABLE resume_message_receipts DROP CONSTRAINT qa_reject");
    check(await retryCount() === 5);
    check(Number((await a.query("SELECT count(*) FROM resume_message_receipts WHERE client_message_id = 'rollback-key'")).rows[0].count) === 0);
    assert.ok(resolved.authorized);
    await a.query("DELETE FROM messages WHERE id = $1", [resolved.value.id]);
    await assert.rejects(writer.saveOnce(successor, "lost-ack", "durable"), /no longer available/); checks++;
    check(await retryCount() === 4);
    check(await first.revoke(retryCredential, 2));
    check(!(await writer.saveOnce(successor, "same-key", "text")).authorized);
    await a.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() WHERE id = $1", [peer.sessionId]);
    check(!(await writer.saveOnce(peerBinding, "same-key", "text")).authorized);
    // Policy denial must hold even when the requested receipt already exists.
    await a.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [peer.sessionId]);
    await a.query("UPDATE rooms SET auth_version = 2 WHERE id = 'retry123'");
    check(!(await writer.saveOnce(peerBinding, "same-key", "text")).authorized);
    await a.query("DELETE FROM room_resume_sessions WHERE room_id = 'retry123'");
    check(Number((await a.query("SELECT count(*) FROM resume_message_receipts WHERE session_id = ANY($1)", [[retrySession.sessionId, peer.sessionId]])).rows[0].count) === 0);
    check(await retryCount() === 4); // session cleanup does not delete room history
  } finally { await parallelPool.end(); }
  // History uses the same dedicated transaction gate, never the global DB.
  await a.query("INSERT INTO rooms (id) VALUES ('histo123'), ('alien123')");
  await a.query(`INSERT INTO messages (room_id, username, content)
    SELECT 'histo123', 'History', n::text FROM generate_series(1, 105) n`);
  await a.query("INSERT INTO messages (room_id, username, content) VALUES ('alien123', 'Foreign', 'must not leak')");
  const historySession = await first.issueAfterAuthenticatedJoin("histo123", "History", 1);
  assert.ok(historySession);
  const historyCredential = { roomId: historySession.roomId, sessionId: historySession.sessionId, token: historySession.token };
  const historyIdentity = await first.advanceGeneration(historyCredential, 0, opA, socketA);
  assert.ok(historyIdentity);
  const historyBindings = new ResumeBindings();
  const historyBinding = await historyBindings.activate(historyIdentity, socketA, async () => {}, () => true);
  assert.ok(historyBinding);
  const reader = new ResumeHistoryReader(new ResumeOperationGate(operationPool, historyBindings));
  const historyRows = await reader.read(historyBinding) as { id: number; message: string; username: string }[] | null;
  check(historyRows?.length === 100);
  check(historyRows?.[0].message === "6" && historyRows.at(-1)?.message === "105");
  check(historyRows?.every((row, i) => row.username === "History" && (!i || row.id > historyRows[i - 1].id)));
  check(!JSON.stringify(historyRows).includes(historySession.token));
  check(await reader.read({ ...historyBinding, roomId: "alien123" }) === null);
  // A remote generation change is denied even before local ownership catches up.
  const nextHistory = await first.advanceGeneration(historyCredential, 1, opB, socketB);
  assert.ok(nextHistory);
  check(await reader.read(historyBinding) === null);
  const nextHistoryBinding = await historyBindings.activate(nextHistory, socketB, async () => {}, () => true);
  assert.ok(nextHistoryBinding);
  check((await reader.read(nextHistoryBinding))?.length === 100);
  await a.query("UPDATE room_resume_sessions SET revoked_at = clock_timestamp() WHERE id = $1", [historySession.sessionId]);
  check(await reader.read(nextHistoryBinding) === null);
  await a.query("UPDATE room_resume_sessions SET revoked_at = NULL, expires_at = clock_timestamp() WHERE id = $1", [historySession.sessionId]);
  check(await reader.read(nextHistoryBinding) === null);
  await a.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [historySession.sessionId]);
  // Policy wins under a real lock wait; no history escapes the new version.
  const historyPid = (await operationPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await a.query("BEGIN");
  await a.query("UPDATE rooms SET auth_version = 2 WHERE id = 'histo123'");
  const blockedHistory = reader.read(nextHistoryBinding);
  await waitForBlockedSecond(historyPid);
  await a.query("COMMIT");
  check(await blockedHistory === null);
  // Cleanup is opt-in and uses database time; fixtures never touch a live room.
  while (await first.cleanupExpired(100)) { /* remove earlier expired fixtures */ }
  await a.query("INSERT INTO rooms (id) VALUES ('clean123')");
  const fixtures = [];
  for (let i = 0; i < 5; i++) {
    const session = await first.issueAfterAuthenticatedJoin("clean123", "Cleanup " + i, 1);
    assert.ok(session); fixtures.push(session);
  }
  const ids = fixtures.map(s => s.sessionId);
  const history = (await a.query("INSERT INTO messages (room_id, username, content) VALUES ('clean123', 'Cleanup', 'retained') RETURNING id")).rows[0].id;
  for (const id of ids) {
    await a.query("INSERT INTO resume_message_receipts (session_id, client_message_id, payload_hash, message_id) VALUES ($1, 'saved', $2, $3), ($1, 'tombstone', $2, NULL)", [id, "a".repeat(64), history]);
  }
  await a.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() - interval '1 hour' WHERE id = ANY($1)", [ids.slice(0, 3)]);
  await a.query("UPDATE room_resume_sessions SET revoked_at = clock_timestamp() WHERE id = $1", [ids[4]]);
  const remaining = async () => (await a.query("SELECT id FROM room_resume_sessions WHERE room_id = 'clean123'")).rowCount;
  const receiptCount = async () => Number((await a.query("SELECT count(*) FROM resume_message_receipts WHERE session_id = ANY($1)", [ids])).rows[0].count);
  check(await first.cleanupExpired(1) === 1);
  check(await remaining() === 4 && await receiptCount() === 8);
  // Hold every remaining expired row: SKIP LOCKED must return without waiting.
  await a.query("BEGIN");
  await a.query("SELECT id FROM room_resume_sessions WHERE room_id = 'clean123' AND expires_at <= clock_timestamp() FOR UPDATE");
  await b.query("SET statement_timeout = '2s'");
  check(await second.cleanupExpired(100) === 0);
  await a.query("COMMIT");
  check(await second.cleanupExpired(100) === 2);
  check(await remaining() === 2 && await receiptCount() === 4);
  check(await first.cleanupExpired(100) === 0);
  check((await a.query("SELECT id FROM messages WHERE id = $1", [history])).rowCount === 1);
  // Expired-row deletion holds a lock: pending CAS rechecks after COMMIT and
  // cannot resurrect the deleted session, even with a valid bearer.
  const target = fixtures[3];
  const targetCredential = { roomId: target.roomId, sessionId: target.sessionId, token: target.token };
  const targetIdentity = await first.advanceGeneration(targetCredential, 0, opA, "transport_" + target.sessionId);
  assert.ok(targetIdentity);
  const targetBinding = await bindings.activate(targetIdentity, "transport_" + targetIdentity.sessionId, async () => {}, () => true);
  assert.ok(targetBinding);
  await a.query("BEGIN");
  await a.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() WHERE id = $1", [target.sessionId]);
  check(await first.cleanupExpired(100) === 1);
  const afterCleanupCas = second.advanceGeneration(targetCredential, 1, opB, socketB);
  await waitForBlockedSecond();
  const gatePid = (await operationPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  let ranAfterCleanup = false;
  const afterCleanupGate = gate.run(targetBinding, async () => { ranAfterCleanup = true; });
  await waitForBlockedSecond(gatePid);
  await a.query("COMMIT");
  check(await afterCleanupCas === null);
  check(!(await afterCleanupGate).authorized);
  check(!ranAfterCleanup);
  check(await remaining() === 1 && await receiptCount() === 2); // unexpired revoked receipts retained too
  check((await a.query("SELECT id FROM messages WHERE id = $1", [history])).rowCount === 1);
  // Two independent workers partition the expired rows; no double deletion.
  await a.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() WHERE id = $1", [ids[4]]);
  const cleaned = await Promise.all([first.cleanupExpired(1), second.cleanupExpired(1)]);
  check(cleaned[0] + cleaned[1] === 1);
  check(await remaining() === 0 && await receiptCount() === 0);
  check((await a.query("SELECT id FROM messages WHERE id = $1", [history])).rowCount === 1);
  // A gate that owns the row can cross its TTL while doing work. Cleanup skips
  // it, then the gate itself rejects and rolls back before publication.
  const busy = await first.issueAfterAuthenticatedJoin("clean123", "Busy", 1);
  assert.ok(busy);
  const busyIdentity = await first.advanceGeneration({ roomId: busy.roomId, sessionId: busy.sessionId, token: busy.token }, 0, opA, "transport_" + busy.sessionId);
  assert.ok(busyIdentity);
  const busyBinding = await bindings.activate(busyIdentity, "transport_" + busyIdentity.sessionId, async () => {}, () => true);
  assert.ok(busyBinding);
  const busyResult = await gate.run(busyBinding, async transaction => {
    // Change the fixture expiry within the owning transaction. Another worker
    // still sees the old expiry, so also assert skip using a separate already-
    // expired row lock above. This proves the pre-COMMIT fence and safe cleanup.
    await transaction.query("UPDATE room_resume_sessions SET expires_at = clock_timestamp() WHERE id = $1", [busy.sessionId]);
    await transaction.query("INSERT INTO messages (room_id, username, content) VALUES ('clean123', 'Busy', 'must rollback')");
    check(await second.cleanupExpired(100) === 0);
  });
  check(!busyResult.authorized);
  check((await a.query("SELECT id FROM messages WHERE room_id = 'clean123'")).rowCount === 1);
  check((await first.lookup({ roomId: busy.roomId, sessionId: busy.sessionId, token: busy.token })) !== null); // expiry mutation rolled back too
  // Default cap is exercised on more than a full batch, not inferred from SQL.
  await a.query(`INSERT INTO room_resume_sessions (id, token_hash, room_id, username, auth_version, expires_at)
    SELECT 'cleanup-fixture-' || n, 'cleanup-hash-' || n, 'clean123', 'Batch', 1,
      clock_timestamp() - interval '1 hour' FROM generate_series(1, 101) n`);
  check(await first.cleanupExpired() === 100);
  check(await first.cleanupExpired() === 1);
  check(await first.cleanupExpired() === 0);
  await b.query("RESET statement_timeout");
  // Real CAS blocked inside PostgreSQL: conflicting admission must not reach DB,
  // and disconnect must fence activation without pretending to cancel the CAS.
  await a.query("INSERT INTO rooms (id) VALUES ('admit123')");
  const admissionSession = await first.issueAfterAuthenticatedJoin("admit123", "Admission", 1);
  const otherSession = await first.issueAfterAuthenticatedJoin("admit123", "Other", 1);
  assert.ok(admissionSession && otherSession);
  const admissionCredential = { roomId: admissionSession.roomId, sessionId: admissionSession.sessionId, token: admissionSession.token };
  const otherCredential = { roomId: otherSession.roomId, sessionId: otherSession.sessionId, token: otherSession.token };
  const request = { credential: admissionCredential, expectedGeneration: 0, operationId: opA };
  const admissionBindings = new ResumeBindings();
  let admissionCalls = 0, admissionPrepares = 0;
  const admission = new ResumeAdmission({ advanceGeneration: async (...args) => {
    admissionCalls++; return second.advanceGeneration(...args);
  } }, admissionBindings, "admission_transport_1", () => true, async () => {
    admissionPrepares++; return async () => {};
  });
  await a.query("BEGIN");
  await a.query("SELECT id FROM room_resume_sessions WHERE id = $1 FOR UPDATE", [admissionSession.sessionId]);
  const pendingAdmission = admission.admit(request);
  await waitForBlockedSecond();
  check(admission.admit(request) === pendingAdmission);
  check(await admission.admit({ ...request, credential: otherCredential }) === null);
  check(await admission.admit({ ...request, operationId: opB }) === null);
  check((await first.lookup(otherCredential))?.generation === 0);
  check(admissionCalls === 1);
  const admissionClosing = admission.close();
  await a.query("COMMIT");
  check(await pendingAdmission === null);
  await admissionClosing;
  check(admissionPrepares === 0);
  check((await first.lookup(admissionCredential))?.generation === 1);
  check(await admission.admit(request) === null);
  const replacement = new ResumeAdmission(second, admissionBindings, "admission_transport_2", () => true,
    async () => async () => {});
  const recoveredBinding = await replacement.admit({ ...request, expectedGeneration: 1, operationId: opB });
  check(recoveredBinding?.generation === 2 && admissionBindings.isCurrent(recoveredBinding));
  check(await replacement.admit({ ...request, expectedGeneration: 1, operationId: opB }) === recoveredBinding);
  check((await first.lookup(admissionCredential))?.generation === 2);
  await replacement.close();
  check(!admissionBindings.isCurrent(recoveredBinding!));
  // A real successful autocommit with a lost response remains terminal locally.
  let uncertainCalls = 0;
  const uncertainAdmission = new ResumeAdmission({ advanceGeneration: async (...args) => {
    uncertainCalls++; assert.ok(await second.advanceGeneration(...args));
    throw Error("simulated lost CAS acknowledgment");
  } }, admissionBindings, "admission_transport_3", () => true, async () => {
    throw Error("must not prepare after uncertain CAS");
  });
  const uncertainRequest = { ...request, credential: otherCredential };
  await assert.rejects(uncertainAdmission.admit(uncertainRequest), /lost CAS/);
  await assert.rejects(uncertainAdmission.admit(uncertainRequest), /lost CAS/);
  check(uncertainCalls === 1);
  check((await first.lookup(otherCredential))?.generation === 1);
  await uncertainAdmission.close();
  console.log(JSON.stringify({ suite: "resume-store-postgresql", checks, result: "PASS", scope: "isolated migrations, policy/CAS locks, durable retry receipts and bounded expiry cleanup; not socket resume" }));
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
