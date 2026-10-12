import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeOperationGate } from "../src/lib/resume-operation";
import { ResumeMessageWriter } from "../src/lib/resume-message";
import { ResumePublication } from "../src/lib/resume-publication";

// Only the disposable cluster owner invokes this. No live grants/migrations.
const url = new URL(process.env.RESUME_TEST_DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, process.env.OWNED_PG_PORT);
assert.equal(url.search, "");
const schema = "publication_role_qa", role = "publication_runtime_qa";
const admin = new Pool({ connectionString: url.href, options: `-c search_path=${schema}` });
url.username = role; url.password = "";
// Explicit temp-last is necessary for unqualified subscriber SQL, not just the trigger.
const runtime = new Pool({ connectionString: url.href,
  options: `-c search_path=pg_catalog,${schema},pg_temp`, max: 1 });
const cleanupRole = "publication_cleanup_qa";
url.username = cleanupRole;
const maintenance = new Pool({ connectionString: url.href,
  options: `-c search_path=pg_catalog,${schema},pg_temp`, max: 1 });
let checks = 0;
const check = (value: unknown) => { assert.ok(value); checks++; };
async function denied(sql: string) {
  await assert.rejects(runtime.query(sql), e => (e as {code:string}).code === "42501");
  checks++;
}
async function main() {
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0000_thin_stardust", "0001_white_zarda", "0003_spotty_zombie", "0004_long_nighthawk", "0005_free_blazing_skull", "0006_cold_zuras"]) {
      await admin.query((await readFile(`drizzle/${name}.sql`, "utf8")).replaceAll('"public".', `"${schema}".`));
    }
    await admin.query(await readFile("scripts/fixtures/message-publication.sql", "utf8"));
    await admin.query(await readFile("scripts/fixtures/publication-subscribers.sql", "utf8"));
    await admin.query("INSERT INTO rooms(id) VALUES ('role123'),('other123')");
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT INSERT ON messages,message_publication_pending,resume_message_receipts TO ${role}`);
    await admin.query(`GRANT USAGE ON SEQUENCE messages_id_seq TO ${role}`);
    await admin.query(`GRANT INSERT,UPDATE ON room_resume_sessions,publication_subscribers,publication_deliveries,publication_snapshot_attempts TO ${role}`);
    // PostgreSQL row locks need UPDATE on at least one column. Do not grant room policy mutation.
    await admin.query(`GRANT UPDATE(last_active_at) ON rooms TO ${role}`);
    await admin.query(`GRANT UPDATE(id) ON publication_admission TO ${role}`);
    const identity = (await runtime.query("SELECT current_user,session_user,rolsuper,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    check(identity.current_user === role && identity.session_user === role);
    check(!identity.rolsuper && !identity.rolcreaterole && !identity.rolbypassrls);
    check(!(await runtime.query("SELECT has_schema_privilege(current_user,$1,'CREATE') allowed", [schema])).rows[0].allowed);
    // A real login, not SET ROLE on an administrator connection; RESET cannot elevate it.
    await runtime.query("RESET ROLE");
    check((await runtime.query("SELECT current_user")).rows[0].current_user === role);
    await denied("SET ROLE dimle");
    await denied(`CREATE TABLE ${schema}.unauthorized(id integer)`);
    await denied("UPDATE rooms SET auth_version=2 WHERE id='role123'");
    await runtime.query("CREATE TEMP TABLE message_publication_pending(message_id integer,room_id text)");
    await runtime.query("CREATE TEMP TABLE publication_deliveries(session_id text)");
    const store = new ResumeStore(runtime), bindings = new ResumeBindings();
    const gate = new ResumeOperationGate(runtime, bindings), writer = new ResumeMessageWriter(gate);
    const journal = new ResumePublication(gate);
    const issued = await store.issueAfterAuthenticatedJoin("role123", "Reader", 1); assert.ok(issued);
    const credential = { roomId: issued.roomId, sessionId: issued.sessionId, token: issued.token };
    const transport = "role_transport_123456";
    const advanced = await store.advanceGeneration(credential, 0, "role_operation_123456", transport); assert.ok(advanced);
    const binding = await bindings.activate(advanced, transport, async () => {}, () => true); assert.ok(binding);
    const first = await writer.saveOnce(binding, "role_message_1", "immutable first"); assert.ok(first.authorized);
    const cut = await journal.snapshot(binding); assert.ok(cut);
    check(cut.messages.length === 1 && cut.messages[0].id === first.value.id);
    check(await journal.acknowledgeSnapshot(binding, cut, {deliveryTry: cut.deliveryTry, ids: [first.value.id]}));
    check((await journal.claim(binding))?.messages.length === 0);
    const second = await writer.saveOnce(binding, "role_message_2", "later committed"); assert.ok(second.authorized);
    const retry = await writer.saveOnceWithOutcome(binding, "role_message_2", "later committed");
    check(retry.authorized && !retry.value.inserted && retry.value.message.id === second.value.id);
    const batch = await journal.claim(binding); assert.ok(batch);
    check(batch.messages.length === 1 && batch.messages[0].id === second.value.id);
    check(await journal.acknowledge(binding, batch, {deliveryTry: batch.deliveryTry, ids: [second.value.id]}));
    check((await runtime.query("SELECT count(*)::int n FROM pg_temp.message_publication_pending")).rows[0].n === 0);
    check((await runtime.query("SELECT count(*)::int n FROM pg_temp.publication_deliveries")).rows[0].n === 0);
    for (const sql of [
      "UPDATE messages SET content='changed'", "UPDATE messages SET room_id='other123'",
      "DELETE FROM messages", "TRUNCATE messages CASCADE",
      "UPDATE message_publication_pending SET room_id='other123'", "DELETE FROM message_publication_pending",
      "TRUNCATE message_publication_pending CASCADE", "ALTER TABLE messages DISABLE TRIGGER ALL",
      "DELETE FROM rooms", "DELETE FROM publication_deliveries",
    ]) await denied(sql);
    check((await journal.claim(binding))?.messages.length === 0);
    check((await runtime.query("SELECT content FROM messages WHERE id=$1", [first.value.id])).rows[0].content === "immutable first");
    // Demonstrate WHY privileged UPDATE/DELETE remain forbidden before tombstones exist.
    const probe = await admin.connect();
    try {
      await probe.query("BEGIN");
      await probe.query("UPDATE messages SET content='privileged invisible edit' WHERE id=$1", [first.value.id]);
      check((await probe.query(`SELECT count(*)::int n FROM message_publication_pending p
        JOIN publication_deliveries d ON d.message_id=p.message_id WHERE p.message_id=$1 AND NOT d.acked`, [first.value.id])).rows[0].n === 0);
      await probe.query("DELETE FROM messages WHERE id=$1", [first.value.id]);
      check((await probe.query("SELECT 1 FROM message_publication_pending WHERE message_id=$1", [first.value.id])).rowCount === 0);
      check((await probe.query("SELECT 1 FROM publication_deliveries WHERE message_id=$1", [first.value.id])).rowCount === 0);
      check((await probe.query("SELECT message_id FROM resume_message_receipts WHERE client_message_id='role_message_1'")).rows[0].message_id === null);
    } finally { await probe.query("ROLLBACK"); probe.release(); }
    check((await runtime.query("SELECT content FROM messages WHERE id=$1", [first.value.id])).rows[0].content === "immutable first");
    // Prove the existing expiry primitive actually recovers subscriber capacity.
    // Cleanup has a separate real LOGIN; runtime must not inherit DELETE.
    await admin.query(`CREATE ROLE ${cleanupRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${cleanupRole}`);
    await admin.query(`GRANT SELECT,DELETE ON room_resume_sessions TO ${cleanupRole}`);
    await admin.query(`GRANT UPDATE(id) ON room_resume_sessions TO ${cleanupRole}`);
    check((await maintenance.query("SELECT current_user,session_user")).rows[0].session_user === cleanupRole);
    const cleaner = new ResumeStore(maintenance);
    await assert.rejects(store.cleanupExpired(1), e => (e as {code:string}).code === "42501"); checks++;
    for (const sql of ["DELETE FROM messages", "DELETE FROM message_publication_pending",
      "DELETE FROM publication_deliveries", "UPDATE room_resume_sessions SET expires_at=clock_timestamp()",
      "TRUNCATE room_resume_sessions CASCADE"]) {
      await assert.rejects(maintenance.query(sql), e => (e as {code:string}).code === "42501"); checks++;
    }
    const expiring: string[] = [];
    for (let i = 0; i < 99; i++) {
      const session = await store.issueAfterAuthenticatedJoin("role123", "Reader", 1); assert.ok(session);
      expiring.push(session.sessionId);
      await admin.query("INSERT INTO publication_subscribers VALUES ($1,$2)", [session.sessionId, session.expiresAt]);
    }
    const next = await store.issueAfterAuthenticatedJoin("role123", "Reader", 1); assert.ok(next);
    const nextCredential = {roomId:next.roomId, sessionId:next.sessionId, token:next.token};
    const nextIdentity = await store.advanceGeneration(nextCredential, 0, "next_operation_123456", "next_transport_123456"); assert.ok(nextIdentity);
    const nextBinding = await bindings.activate(nextIdentity, "next_transport_123456", async () => {}, () => true); assert.ok(nextBinding);
    await assert.rejects(journal.snapshot(nextBinding), /subscriber capacity/); checks++;
    // Expired subscriber metadata ALONE is not authority to erase a live session.
    await admin.query("UPDATE publication_subscribers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1", [expiring[0]]);
    check(await cleaner.cleanupExpired(100) === 0);
    await assert.rejects(journal.snapshot(nextBinding), /subscriber capacity/); checks++;
    // Populate cascading ACK/snapshot/write receipts for two truly expired parents.
    await admin.query(`INSERT INTO publication_deliveries
      SELECT id,$2,1,'expired_transport','00000000-0000-4000-8000-000000000001',clock_timestamp(),true
      FROM room_resume_sessions WHERE id=ANY($1::text[])`, [expiring.slice(0,2),first.value.id]);
    await admin.query(`INSERT INTO publication_snapshot_attempts
      SELECT id,1,'expired_transport','00000000-0000-4000-8000-000000000001',ARRAY[$2::integer],clock_timestamp(),true
      FROM room_resume_sessions WHERE id=ANY($1::text[])`, [expiring.slice(0,2),first.value.id]);
    await admin.query(`INSERT INTO resume_message_receipts
      SELECT id,'expired_key',repeat('a',64),$2 FROM room_resume_sessions WHERE id=ANY($1::text[])`, [expiring.slice(0,2),first.value.id]);
    await admin.query("UPDATE room_resume_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::text[])", [expiring.slice(0,2)]);
    const held = await admin.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT id FROM room_resume_sessions WHERE id=$1 FOR UPDATE", [expiring[0]]);
      await maintenance.query("SET statement_timeout='2s'");
      check(await cleaner.cleanupExpired(1) === 1); // skip locked parent, delete other
      check(await cleaner.cleanupExpired(1) === 0);
      check((await admin.query("SELECT 1 FROM room_resume_sessions WHERE id=$1", [expiring[0]])).rowCount === 1);
      check((await journal.snapshot(nextBinding))?.messages.length === 2); // slot reclaimed
    } finally { await held.query("ROLLBACK"); held.release(); }
    check(await cleaner.cleanupExpired(1) === 1);
    for (const table of ["publication_subscribers", "publication_deliveries", "publication_snapshot_attempts", "resume_message_receipts"]) {
      check((await admin.query(`SELECT 1 FROM ${table} WHERE session_id=ANY($1::text[])`, [expiring.slice(0,2)])).rowCount === 0);
    }
    check((await admin.query("SELECT count(*)::int n FROM publication_subscribers")).rows[0].n === 99);
    check((await journal.claim(binding))?.messages.length === 0); // original ACK provenance retained
    const retainedRetry = await writer.saveOnceWithOutcome(binding, "role_message_2", "later committed");
    check(retainedRetry.authorized && !retainedRetry.value.inserted && retainedRetry.value.message.id === second.value.id);
    check((await admin.query("SELECT count(*)::int n FROM messages")).rows[0].n === 2);
    check((await admin.query("SELECT count(*)::int n FROM message_publication_pending")).rows[0].n === 2);
    check(await cleaner.cleanupExpired(100) === 0);
    console.log(JSON.stringify({status:"PASS", checks, actualRestrictedLogin:true,
      insertSnapshotClaimACK:true, tempShadowResistant:true, appendOnlyRuntime:true,
      privilegedMutationNeedsTombstones:true, expiredSubscriberCapacityRecovered:true,
      separateCleanupLogin:true, boundedSkipLockedCleanup:true, liveACKAndRetryPreserved:true,
      publicActivation:false,
      scope:"private role feasibility; not deployed grants, row-level tenant isolation or full server acceptance"}));
  } finally {
    await maintenance.end();
    await runtime.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${cleanupRole}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
