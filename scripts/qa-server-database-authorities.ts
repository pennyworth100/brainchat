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
  for (const file of ["message-publication", "publication-subscribers", "message-write-admission"]) {
    await admin.query(await readFile(`scripts/fixtures/${file}.sql`, "utf8"));
  }
  await admin.query(`CREATE ROLE server_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    CREATE ROLE server_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO server_runtime,server_maintenance;
    GRANT SELECT,INSERT,UPDATE ON rooms,rate_limits,room_resume_sessions,
      publication_subscribers,publication_deliveries,publication_snapshot_attempts TO server_runtime;
    GRANT SELECT,INSERT ON messages,message_publication_pending,resume_message_receipts TO server_runtime;
    GRANT SELECT,UPDATE(id) ON publication_admission TO server_runtime;
    GRANT USAGE ON SEQUENCE messages_id_seq TO server_runtime;
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
  let catalogChecks = 0;
  try {
    await assert.rejects(start({databaseAuthorities:{migrations:admin,maintenance:admin,publicationTables:true}}), /distinct pools/);
    for (const [p, role] of [[pool,"server_runtime"],[maintenance,"server_maintenance"]] as const) {
      const identity = (await p.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(identity.current_user, role); assert.equal(identity.session_user, role); assert.equal(identity.rolsuper, false);
      const catalog = (await p.query(`SELECT current_database() AS db,
        current_setting('search_path') AS path,
        NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS restricted,
        NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS no_memberships,
        NOT EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) AS owns_no_relations,
        NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) AS owns_no_schemas,
        NOT EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid) AS owns_no_functions,
        NOT has_schema_privilege(current_user,'public','CREATE') AS no_schema_create
        FROM pg_roles r WHERE rolname=current_user`)).rows[0];
      assert.equal(catalog.db,'postgres');
      assert.equal(catalog.path,'pg_catalog,public,pg_temp');
      for (const key of ['restricted','no_memberships','owns_no_relations','owns_no_schemas','owns_no_functions','no_schema_create']) {
        assert.equal(catalog[key],true,key); catalogChecks++;
      }
      // Effective checks include PUBLIC and column grants, not only direct ACL entries.
      for (const table of ['message_write_budget','resume_upload_budget','resume_upload_attempts',
        'upload_resource_domains','upload_resource_policies','upload_resource_attempts']) {
        const access = (await p.query(`SELECT
          has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(current_user,$1,'SELECT,INSERT,UPDATE,REFERENCES') AS allowed`,[table])).rows[0];
        assert.equal(access.allowed,false,role+' must not access '+table); catalogChecks++;
      }
      await p.query("RESET ROLE");
      await assert.rejects(p.query("SET ROLE dimle"), e => (e as {code:string}).code === "42501"); denied++;
    }
    // A new owner-created relation must not acquire runtime/maintenance privileges.
    await admin.query('CREATE TABLE public.future_owner_only(id int)');
    for (const p of [pool,maintenance]) {
      await assert.rejects(p.query('SELECT * FROM public.future_owner_only'), e => (e as {code:string}).code === '42501'); denied++;
      for (const sql of ['UPDATE message_write_budget SET max_rows=1000000',
        'UPDATE upload_resource_domains SET capacity_bytes=9007199254740991',
        'UPDATE resume_upload_budget SET capacity_bytes=9007199254740991',
        'SELECT admit_message_write()']) {
        await assert.rejects(p.query(sql),e => (e as {code:string}).code === '42501'); denied++;
      }
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
    // Installation starts CLOSED. Only the trusted provisioner admits this exact fixture load.
    await assert.rejects(pool.query("INSERT INTO messages(room_id,username,content) VALUES ($1,'denied','closed')",[created.roomId]),
      e => (e as {code:string}).code === '53100'); denied++;
    await admin.query('UPDATE message_write_budget SET max_rows=206,max_bytes=1048576');
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
    const budget = (await admin.query(`SELECT used_rows::int,used_bytes::int,max_rows::int,
      used_bytes=(SELECT sum(octet_length(to_jsonb(m)::text)) FROM messages m) AS exact_bytes
      FROM message_write_budget`)).rows[0];
    assert.equal(budget.used_rows,206); assert.equal(budget.max_rows,206); assert.equal(budget.exact_bytes,true);
    await assert.rejects(pool.query("INSERT INTO messages(room_id,username,content) VALUES ($1,'denied','full')",[created.roomId]),
      e => (e as {code:string}).code === '53100'); denied++;
    console.log(JSON.stringify({status:"PASS",denied,catalogChecks,budget,actualFullServer:true,distinctLogins:true,
      keyedWriteRetry:true,expiredDeliveries:205,globalMessagesRetained:206,liveSessionRetained:true,report,
      publicActivation:false,limits:"owned cluster; explicit fixture grants, not deployed grant/TLS attestation, all-producer acceptance or public resume"}));
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
