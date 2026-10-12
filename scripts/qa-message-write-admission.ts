import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool, PoolClient } from "pg";

const url = new URL(process.env.RESUME_TEST_DATABASE_URL!);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.port, process.env.OWNED_PG_PORT);
assert.equal(url.search, "");
const schema = "write_admission_qa", role = "write_admission_runtime_qa";
const admin = new Pool({connectionString:url.href, options:`-c search_path=${schema}`});
url.username = role; url.password = "";
const runtime = new Pool({connectionString:url.href, options:`-c search_path=pg_catalog,${schema},pg_temp -c statement_timeout=5000`});
let checks = 0;
const check = (v:unknown) => { assert.ok(v); checks++; };
const state = async () => (await admin.query(`SELECT used_rows::int,used_bytes::int,max_rows::int,max_bytes::int,
  (SELECT count(*)::int FROM messages) messages,
  (SELECT count(*)::int FROM message_publication_pending) journal FROM message_write_budget`)).rows[0];
const insert = (db:Pool|PoolClient, content:string, key:string|null=null) => db.query(
  "INSERT INTO messages(room_id,username,content,client_message_id) VALUES ('budget123','writer',$1,$2) ON CONFLICT DO NOTHING RETURNING id", [content,key]);
async function rejected(work:Promise<unknown>, code:string) {
  await assert.rejects(work,e => (e as {code:string}).code === code); checks++;
}
async function main() {
try {
  if (process.argv[2] === "recover") {
    const s = await state();
    check(s.used_rows === 3 && s.messages === 3 && s.journal === 3);
    check(s.used_bytes === (await admin.query("SELECT sum(octet_length(to_jsonb(m)::text))::int n FROM messages m")).rows[0].n);
    await rejected(insert(runtime,"still closed after restart"),"53100");
    check((await insert(runtime,"retry after restart","key1")).rowCount === 0);
    console.log(JSON.stringify({status:"PASS",phase:"admission-recovery",checks,state:await state()}));
    return;
  }
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const name of ["0000_thin_stardust","0003_spotty_zombie"]) {
    await admin.query((await readFile(`drizzle/${name}.sql`,"utf8")).replaceAll('"public".',`"${schema}".`));
  }
  await admin.query("INSERT INTO rooms(id) VALUES ('budget123')");
  await insert(admin,"existing before installation","key1");
  await admin.query(await readFile("scripts/fixtures/message-publication.sql","utf8"));
  await admin.query(await readFile("scripts/fixtures/message-write-admission.sql","utf8"));
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin.query(`GRANT INSERT,SELECT ON messages,message_publication_pending TO ${role}`);
  await admin.query(`GRANT USAGE ON SEQUENCE messages_id_seq TO ${role}`);
  check((await runtime.query("SELECT current_user,session_user")).rows.every(r=>r.current_user===role && r.session_user===role));
  let s = await state();
  check(s.used_rows===1 && s.messages===1 && s.journal===1 && s.max_bytes===s.used_bytes);
  await rejected(insert(runtime,"closed"),"53100");
  check((await insert(runtime,"same key","key1")).rowCount===0);
  check(JSON.stringify(await state())===JSON.stringify(s));
  for (const sql of ["UPDATE message_write_budget SET max_rows=1000", "DELETE FROM message_write_budget", "TRUNCATE message_write_budget", "ALTER TABLE messages DISABLE TRIGGER ALL", "UPDATE messages SET content='bypass'", "DELETE FROM messages", "SELECT admit_message_write()"])
    await rejected(runtime.query(sql),"42501");
  await runtime.query("CREATE TEMP TABLE message_write_budget(id boolean,used_rows bigint,used_bytes bigint,max_rows bigint,max_bytes bigint)");
  await rejected(insert(runtime,"temp cannot shadow"),"53100");
  // Byte bound independently of row count; UTF8 multibyte payload is charged.
  await admin.query("UPDATE message_write_budget SET max_rows=10,max_bytes=used_bytes+1");
  s=await state();
  await rejected(insert(runtime,"żółw 🐢"),"53100");
  check(JSON.stringify(await state())===JSON.stringify(s));
  await admin.query("UPDATE message_write_budget SET max_rows=10,max_bytes=100000");
  const a=await runtime.connect(), b=await runtime.connect();
  try {
    s=await state();
    await a.query("BEGIN"); await insert(a,"rolled back"); await a.query("ROLLBACK");
    check(JSON.stringify(await state())===JSON.stringify(s));
    // Later journal failure must refund the charge and roll back the message.
    await admin.query("ALTER TABLE message_publication_pending ADD CONSTRAINT deny_new CHECK (message_id < 0) NOT VALID");
    await rejected(insert(runtime,"journal rejects"),"23514");
    check(JSON.stringify(await state())===JSON.stringify(s));
    await admin.query("ALTER TABLE message_publication_pending DROP CONSTRAINT deny_new");
    await admin.query("UPDATE message_write_budget SET max_rows=used_rows+1");
    await a.query("BEGIN"); await insert(a,"last available slot");
    const pid=(await b.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const loser=rejected(insert(b,"concurrent overflow"),"53100");
    let blocked=false;
    for (let i=0;i<200 && !blocked;i++) blocked=(await admin.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked;
    check(blocked); await a.query("COMMIT"); await loser;
    s=await state(); check(s.used_rows===2 && s.messages===2 && s.journal===2);
    // Failed multi-row statements cannot retain the first charge/row/journal.
    await admin.query("UPDATE message_write_budget SET max_rows=used_rows+1"); s=await state();
    await rejected(runtime.query("INSERT INTO messages(room_id,username,content) VALUES ('budget123','writer','multi1'),('budget123','writer','multi2')"),"53100");
    check(JSON.stringify(await state())===JSON.stringify(s));
    await insert(runtime,"żółw 🐢");
    s=await state();
    check(s.used_rows===3 && s.messages===3 && s.journal===3);
    check(s.used_bytes===(await admin.query("SELECT sum(octet_length(to_jsonb(m)::text))::int n FROM messages m")).rows[0].n);
    // Missing singleton is fail-closed, restored by rollback; no runtime repair.
    const c=await admin.connect();
    try { await c.query("BEGIN"); await c.query("DELETE FROM message_write_budget"); await rejected(insert(c,"missing singleton"),"53100"); }
    finally { await c.query("ROLLBACK"); c.release(); }
    check(JSON.stringify(await state())===JSON.stringify(s));
  } finally { a.release(true); b.release(true); }
  console.log(JSON.stringify({status:"PASS",phase:"admission-seed",checks,state:await state(),physicalAllocationBound:false}));
} finally { await runtime.end(); await admin.end(); }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
