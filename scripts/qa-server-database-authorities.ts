import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { io, type Socket } from "socket.io-client";
import { migrateDatabase } from "../src/lib/db/startup-migrations";
import { ResumeStore } from "../src/lib/resume-store";

// Actual full server, disposable cluster only; no SET ROLE/admin runtime.
async function main() {
  const url = new URL(process.env.RESUME_TEST_DATABASE_URL!);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, process.env.OWNED_PG_PORT);
  const admin = new Pool({ connectionString: url.href });
  await migrateDatabase(admin);
  for (const file of ["message-publication", "publication-subscribers"]) {
    await admin.query(await readFile(`scripts/fixtures/${file}.sql`, "utf8"));
  }
  await admin.query(`CREATE ROLE server_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    CREATE ROLE server_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO server_runtime,server_maintenance;
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO server_runtime;
    REVOKE UPDATE ON messages,message_publication_pending FROM server_runtime;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO server_runtime;
    GRANT SELECT,DELETE ON room_resume_sessions,resume_message_receipts,publication_deliveries,rate_limits TO server_maintenance;
    GRANT UPDATE(id) ON room_resume_sessions TO server_maintenance;
    GRANT UPDATE(client_message_id) ON resume_message_receipts TO server_maintenance;
    GRANT UPDATE(message_id) ON publication_deliveries TO server_maintenance;
    GRANT SELECT,UPDATE(session_id) ON publication_subscribers TO server_maintenance;`);
  url.username = "server_runtime"; url.password = "";
  url.searchParams.set("options", "-c search_path=pg_catalog,public,pg_temp");
  process.env.DATABASE_URL = url.href;
  process.env.PORT = process.env.OWNED_APP_PORT!;
  process.env.UPLOAD_DIR = process.env.OWNED_UPLOAD_DIR!;
  Object.assign(process.env, {NODE_ENV:"production"});
  process.env.ALFRED_API_KEY = "owned-authorities-test-key";
  process.env.DIMLE_AGENT_API_KEYS_JSON = "";
  url.username = "server_maintenance";
  const maintenance = new Pool({ connectionString: url.href, max: 1 });
  const { main: start } = await import("../server");
  const { pool } = await import("../src/lib/db");
  let runtime: Awaited<ReturnType<typeof start>> | undefined;
  let socket: Socket | undefined;
  let denied = 0;
  try {
    await assert.rejects(start({databaseAuthorities:{migrations:admin,maintenance:admin,publicationTables:true}}), /distinct pools/);
    for (const [p, role] of [[pool,"server_runtime"],[maintenance,"server_maintenance"]] as const) {
      const identity = (await p.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(identity.current_user, role); assert.equal(identity.session_user, role); assert.equal(identity.rolsuper, false);
      await p.query("RESET ROLE");
      await assert.rejects(p.query("SET ROLE dimle"), e => (e as {code:string}).code === "42501"); denied++;
    }
    for (const sql of ["CREATE TABLE public.forbidden(id int)","DELETE FROM room_resume_sessions", "DELETE FROM publication_deliveries", "UPDATE messages SET content='bad'", "DELETE FROM messages", "ALTER TABLE messages DISABLE TRIGGER ALL"]) {
      await assert.rejects(pool.query(sql), e => (e as {code:string}).code === "42501"); denied++;
    }
    for (const sql of ["DELETE FROM messages", "DELETE FROM message_publication_pending", "INSERT INTO rooms(id) VALUES ('bad123')"]) {
      await assert.rejects(maintenance.query(sql), e => (e as {code:string}).code === "42501"); denied++;
    }
    runtime = await start({databaseAuthorities:{migrations:admin,maintenance,publicationTables:true}});
    const base = "http://127.0.0.1:" + process.env.PORT;
    const response = await fetch(base + "/api/rooms", {method:"POST"}); assert.equal(response.status,201);
    const created = await response.json(); assert.ok(created.roomId);
    socket = io(base, {transports:["websocket"],reconnection:false});
    await new Promise<void>((resolve,reject) => { socket!.once("connect",resolve); socket!.once("connect_error",reject); });
    const joined = new Promise(resolve => socket!.once("room-snapshot",resolve));
    socket.emit("join-room", {...created,username:"Role fixture"}); await joined;
    const payload = {roomId:created.roomId,message:"restricted full-server write",clientMessageId:"authority-write-1"};
    const first = await socket.timeout(3000).emitWithAck("send-message",payload);
    const retry = await socket.timeout(3000).emitWithAck("send-message",payload);
    assert.ok(first.message?.id); assert.equal(retry.message.id,first.message.id);
    const store = new ResumeStore(pool);
    const authVersion = (await admin.query("SELECT auth_version FROM rooms WHERE id=$1",[created.roomId])).rows[0].auth_version;
    const expired = await store.issueAfterAuthenticatedJoin(created.roomId,"Expired",authVersion); assert.ok(expired);
    await admin.query("INSERT INTO publication_subscribers VALUES ($1,$2)",[expired.sessionId,expired.expiresAt]);
    await admin.query("INSERT INTO messages(room_id,username,content) SELECT $1,'Fixture','backlog-'||n FROM generate_series(1,205) n",[created.roomId]);
    await admin.query(`INSERT INTO publication_deliveries SELECT $1,id,1,'expired_transport',
      '00000000-0000-4000-8000-000000000001',clock_timestamp(),true FROM messages WHERE content LIKE 'backlog-%'`,[expired.sessionId]);
    await admin.query("UPDATE room_resume_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.sessionId]);
    const deadline = Date.now()+6000;
    while ((await admin.query("SELECT 1 FROM room_resume_sessions WHERE id=$1",[expired.sessionId])).rowCount) {
      assert.ok(Date.now()<deadline,"actual server maintenance did not drain backlog");
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    const report = await runtime.lifecycle.stopAndSettle();
    const expiry = (report as {expiry:PromiseSettledResult<{sessions:PromiseSettledResult<{
      failedRuns:number;sessions:number;deliveries:number}>}>}).expiry;
    assert.equal(expiry.status,"fulfilled");
    if (expiry.status !== "fulfilled") throw Error("Unsettled expiry");
    assert.equal(expiry.value.sessions.status,"fulfilled");
    if (expiry.value.sessions.status !== "fulfilled") throw Error("Unsettled sessions");
    assert.equal(expiry.value.sessions.value.failedRuns,0);
    assert.equal(expiry.value.sessions.value.sessions,1);
    assert.equal(expiry.value.sessions.value.deliveries,205);
    assert.equal((await admin.query("SELECT count(*)::int n FROM messages")).rows[0].n,206);
    assert.equal((await admin.query("SELECT count(*)::int n FROM message_publication_pending")).rows[0].n,206);
    assert.equal((await admin.query("SELECT count(*)::int n FROM room_resume_sessions")).rows[0].n,1);
    console.log(JSON.stringify({status:"PASS",denied,actualFullServer:true,distinctLogins:true,
      keyedWriteRetry:true,expiredDeliveries:205,globalMessagesRetained:206,liveSessionRetained:true,report,
      publicActivation:false,limits:"owned cluster; broad fixture runtime grants, not final deployed grant audit or public resume"}));
  } finally {
    socket?.disconnect();
    if (runtime) {
      await runtime.lifecycle.stopAndSettle();
      await new Promise<void>(resolve=>runtime!.io.close(()=>resolve()));
      await runtime.app.close();
    }
    await pool.end(); await maintenance.end(); await admin.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
