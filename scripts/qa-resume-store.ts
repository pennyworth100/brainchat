import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { ResumeStore } from "../src/lib/resume-store";

// Explicit opt-in only. Never infer a live DATABASE_URL as permission to test.
async function main() {
if (!process.env.RESUME_TEST_DATABASE_URL) throw new Error("RESUME_TEST_DATABASE_URL required (isolated DB only)");
const pool = new Pool({ connectionString: process.env.RESUME_TEST_DATABASE_URL });
const schema = "resume_qa_" + randomBytes(8).toString("hex");
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
  await a.query("INSERT INTO rooms (id) VALUES ('candy986'), ('spoon651')");
  const first = new ResumeStore(a);
  const second = new ResumeStore(b);
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
  await a.query("DELETE FROM rooms WHERE id = 'candy986'");
  check(Number((await a.query("SELECT count(*) FROM room_resume_sessions")).rows[0].count) === 0);
  console.log(JSON.stringify({ suite: "resume-store-postgresql", checks, result: "PASS", scope: "isolated generated migration + two independent DB clients; not socket resume" }));
} finally {
  await a.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
  a.release();
  b.release();
  await pool.end();
}
}

main().catch(() => {
  // Do not dump database errors/parameters or bearer values into CI logs.
  console.error("Resume persistence PostgreSQL checks FAILED");
  process.exitCode = 1;
});
