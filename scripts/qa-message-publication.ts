import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

// Only the owned loopback fixture may call this. This is NOT a public endpoint.
const url = process.env.RESUME_TEST_DATABASE_URL!;
const parsed = new URL(url);
assert.equal(parsed.hostname, "127.0.0.1");
assert.equal(parsed.port, process.env.OWNED_PG_PORT);
assert.equal(parsed.search, "");
const db = new Pool({connectionString:url});
let checks = 0;
const check = (v: unknown) => { assert.ok(v); checks++; };
async function pending() {
  return (await db.query("SELECT message_id FROM message_publication_pending ORDER BY message_id")).rows.map(r=>r.message_id);
}
async function main() {
try {
  if (process.argv[2] === "recover") {
    // A NEW Node process, after an actual immediate PostgreSQL stop/start.
    const rows = (await db.query("SELECT m.content,m.type FROM message_publication_pending p JOIN messages m ON m.id=p.message_id")).rows;
    check(rows.some(r=>r.content==="lower committed last"));
    check(rows.some(r=>r.content==="committed, fanout threw"));
    check(rows.some(r=>r.content==="old before journal"));
    check(rows.some(r=>r.type==="image") && rows.some(r=>r.type==="file"));
    check(!rows.some(r=>r.content==="rolled back"));
    const missing = await db.query("SELECT id FROM messages EXCEPT SELECT message_id FROM message_publication_pending");
    check(missing.rowCount === 0);
    console.log(JSON.stringify({status:"PASS",phase:"after-database-restart",checks,pending:rows.length,deliveryProven:false}));
  } else {
    for (const name of ["0000_thin_stardust","0003_spotty_zombie"]) {
      await db.query(await readFile("drizzle/"+name+".sql","utf8"));
    }
    await db.query("INSERT INTO rooms(id) VALUES ('publication'),('other')");
    await db.query("INSERT INTO messages(room_id,username,content) VALUES ('publication','peer','old before journal')");
    await db.query(await readFile("scripts/fixtures/message-publication.sql","utf8"));
    check((await pending()).length === 1); // atomic legacy backfill
    const insert = async (content:string,type="message",key:string|null=null) =>
      (await db.query("INSERT INTO messages(room_id,username,type,content,client_message_id) VALUES ('publication','peer',$1,$2,$3) ON CONFLICT (room_id,username,client_message_id) DO NOTHING RETURNING id",[type,content,key])).rows;
    // SQL persistence families: unkeyed, keyed conflict, transactional text/media.
    await insert("unkeyed"); await insert("keyed","message","key1");
    const before = (await pending()).length;
    check((await insert("keyed","message","key1")).length === 0);
    check((await pending()).length === before); // retry never creates another event
    const a = await db.connect(), b = await db.connect();
    try {
      await a.query("BEGIN");
      const low = (await a.query("INSERT INTO messages(room_id,username,content) VALUES ('publication','peer','lower committed last') RETURNING id")).rows[0].id;
      const high = (await insert("higher committed first"))[0].id;
      check(low < high);
      check(!(await pending()).includes(low) && (await pending()).includes(high));
      await a.query("COMMIT");
      check((await pending()).includes(low)); // NO afterId/MAX filter
      await b.query("BEGIN");
      const rollback = (await b.query("INSERT INTO messages(room_id,username,content) VALUES ('publication','peer','rolled back') RETURNING id")).rows[0].id;
      await b.query("ROLLBACK");
      check(!(await pending()).includes(rollback));
      await insert(JSON.stringify({dataUrl:"data:image/png;base64,YQ=="}),"image");
      await insert(JSON.stringify({url:"/uploads/fixture/a",name:"a.txt",size:1,mime:"text/plain"}),"file");
      const committed = (await insert("committed, fanout threw"))[0].id;
      assert.throws(()=>{throw Error("injected fanout failure");}); checks++;
      check((await pending()).includes(committed));
      // A reader failure/rollback also cannot consume pending work.
      await b.query("BEGIN");
      await b.query("SELECT message_id FROM message_publication_pending FOR UPDATE SKIP LOCKED LIMIT 2");
      await b.query("ROLLBACK");
      check((await pending()).includes(committed));
      // Outbox failure must roll back the message, not silently lose its event.
      await b.query("BEGIN");
      await b.query("ALTER TABLE message_publication_pending ADD CONSTRAINT fixture_deny CHECK (room_id <> 'other')");
      await assert.rejects(b.query("INSERT INTO messages(room_id,username,content) VALUES ('other','peer','must fail closed')"),e=>(e as {code:string}).code==="23514"); checks++;
      await b.query("ROLLBACK");
      check((await db.query("SELECT id FROM messages WHERE room_id='other'")).rowCount===0);
      // More than newest100: pending records preserve the older unsent event.
      await db.query("INSERT INTO messages(room_id,username,content) SELECT 'publication','peer','later '||n FROM generate_series(1,105) n");
      check((await db.query("SELECT id FROM (SELECT id FROM messages ORDER BY id DESC LIMIT 100) recent WHERE id=$1",[committed])).rowCount===0);
      check((await pending()).includes(committed));
      check((await db.query("SELECT id FROM messages EXCEPT SELECT message_id FROM message_publication_pending")).rowCount===0);
    } finally { a.release(true); b.release(true); }
    console.log(JSON.stringify({status:"PASS",phase:"before-database-restart",checks,pending:(await pending()).length,deliveryProven:false}));
  }
} finally { await db.end(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
