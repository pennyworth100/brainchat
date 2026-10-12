import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Pool } from "pg";
import { Server, type Socket } from "socket.io";
import { io, type Socket as Client } from "socket.io-client";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeOperationGate } from "../src/lib/resume-operation";
import { ResumeMessageWriter } from "../src/lib/resume-message";
import { ResumeMemberships } from "../src/lib/resume-membership";
import { attachResumeSocket, type ResumeSocketOwner } from "../src/lib/resume-socket";
import { ResumePublication, reconcilePublication, type PublicationBatch } from "../src/lib/resume-publication";

// Owned loopback database only. Raw SQL authority manipulation is TEST INPUT,
// never a public authorization/transfer path.
const url = process.env.RESUME_TEST_DATABASE_URL!;
const parsed = new URL(url);
assert.equal(parsed.hostname,"127.0.0.1");
assert.equal(parsed.port,process.env.OWNED_PG_PORT);
const db = new Pool({connectionString:url,options:"-c search_path=subscriber_qa"});
const admin = new Pool({connectionString:url});
const bindings = new ResumeBindings(), members = new ResumeMemberships(bindings);
const gate = new ResumeOperationGate(db,bindings), journal = new ResumePublication(gate);
const store = new ResumeStore(db), writer = new ResumeMessageWriter(gate);
const http = createServer(), sockets = new Server(http);
const clients:Client[]=[], owners:ResumeSocketOwner[]=[];
let checks=0;
const check=(value:unknown)=>{assert.ok(value);checks++;};
async function connect() {
  const address=http.address(); assert.ok(address && typeof address!=="string");
  const accepted=new Promise<Socket>(resolve=>sockets.once("connection",resolve));
  const client=io(`http://127.0.0.1:${address.port}`,{transports:["websocket"],reconnection:false});
  clients.push(client);
  const ready=new Promise<void>((resolve,reject)=>{client.once("connect",resolve);client.once("connect_error",reject);});
  const socket=await accepted;await ready;
  const owner=attachResumeSocket(socket,{store,bindings,memberships:members,prepare:async()=>async()=>{},
    onCleanupError:error=>{throw error;}});
  owners.push(owner);return {client,socket,owner};
}
async function fixture(room="candy986") {
  const issued=await store.issueAfterAuthenticatedJoin(room,"Reader",1); assert.ok(issued);
  const credential={roomId:room,sessionId:issued.sessionId,token:issued.token};
  const physical=await connect();
  const binding=await physical.owner.admit({credential,expectedGeneration:0,operationId:"admit_"+issued.sessionId});
  assert.ok(binding);return {...physical,binding,credential};
}
async function seed() {
  await admin.query("CREATE SCHEMA subscriber_qa");
  for (const name of ["0000_thin_stardust","0003_spotty_zombie","0004_long_nighthawk","0005_free_blazing_skull","0006_cold_zuras"]) {
    await db.query((await readFile("drizzle/"+name+".sql","utf8")).replaceAll('"public".','"subscriber_qa".'));
  }
  await db.query("ALTER TABLE rooms ADD COLUMN creation_token_hash text");
  await db.query("INSERT INTO rooms(id) VALUES ('candy986'),('other123'),('limit123'),('large123')");
  await db.query(await readFile("scripts/fixtures/message-publication.sql","utf8"));
  await db.query(await readFile("scripts/fixtures/publication-subscribers.sql","utf8"));
  await db.query("CREATE TABLE fixture_recovery (credential jsonb NOT NULL, generation integer NOT NULL)");
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const first=await fixture(), second=await fixture(), foreign=await fixture("other123");
  const write=await writer.saveOnce(first.binding,"first_message","committed with no fanout");
  assert.ok(write.authorized);check(write.value.id>0);
  // Real private writer -> durable journal -> exact physical subscriber -> ACK.
  const seen=new Set<number>();let deliveries=0;let loseAck=true;
  first.client.on("publication-batch",(batch:PublicationBatch,ack:(value:unknown)=>void)=>{
    deliveries++;
    for (const m of batch.messages) seen.add(m.id); // explicit identity dedup
    if (!loseAck) ack({deliveryTry:batch.deliveryTry,ids:batch.messages.map(m=>m.id)});
  });
  check(!await reconcilePublication(first.socket,{...first.owner},members,journal));
  check(!await reconcilePublication(foreign.socket,first.owner,members,journal));
  const flight=reconcilePublication(first.socket,first.owner,members,journal);
  check(!await reconcilePublication(first.socket,first.owner,members,journal)); // backpressure
  check(!await flight); // actual 4s client ACK loss
  check(deliveries===1 && seen.size===1);
  check((await db.query("SELECT acked FROM publication_deliveries WHERE session_id=$1",[first.binding.sessionId])).rows[0].acked===false);
  // Other subscriber remains independent and receives the same committed ID.
  second.client.on("publication-batch",(batch:PublicationBatch,ack:(value:unknown)=>void)=>
    ack({deliveryTry:batch.deliveryTry,ids:batch.messages.map(m=>m.id)}));
  check(await reconcilePublication(second.socket,second.owner,members,journal));
  check((await journal.claim(foreign.binding))?.messages.length===0);
  await db.query("UPDATE publication_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE session_id=$1",[first.binding.sessionId]);
  loseAck=false;
  check(await reconcilePublication(first.socket,first.owner,members,journal));
  check(deliveries===2 && seen.size===1); // at least once, dedup not exactly once
  check((await journal.claim(first.binding))?.messages.length===0);
  check((await db.query("SELECT count(*)::int n FROM message_publication_pending")).rows[0].n===1);

  // Late lower ID commit across the first batch cannot be hidden by a watermark.
  const lowTx=await db.connect();
  await lowTx.query("BEGIN");
  const low=(await lowTx.query("INSERT INTO messages(room_id,username,content) VALUES ('candy986','peer','late lower') RETURNING id")).rows[0].id;
  const high=await writer.save(first.binding,"higher first");assert.ok(high.authorized);
  check(low<high.value.id);
  check(await reconcilePublication(first.socket,first.owner,members,journal));
  check(!seen.has(low) && seen.has(high.value.id));
  await lowTx.query("COMMIT");lowTx.release();
  check(await reconcilePublication(first.socket,first.owner,members,journal));
  check(seen.has(low));

  await writer.save(first.binding,"lease-token test");
  const old=await journal.claim(first.binding);assert.ok(old?.messages.length);
  check((await journal.claim(first.binding))?.messages.length===0); // no competing claim
  check(!await journal.acknowledge(first.binding,old,{deliveryTry:old.deliveryTry,ids:[]}));
  check(!await journal.acknowledge(second.binding,old,{deliveryTry:old.deliveryTry,ids:old.messages.map(m=>m.id)}));
  check(await journal.claim({...first.binding})===null);
  await db.query("UPDATE publication_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE session_id=$1 AND NOT acked",[first.binding.sessionId]);
  const retry=await journal.claim(first.binding);assert.ok(retry?.messages.length);
  check(retry.deliveryTry!==old.deliveryTry);
  await assert.rejects(journal.acknowledge(first.binding,old,{deliveryTry:old.deliveryTry,ids:old.messages.map(m=>m.id)}),/lease lost/);checks++;
  check(await journal.acknowledge(first.binding,retry,{deliveryTry:retry.deliveryTry,ids:retry.messages.map(m=>m.id)}));

  // Disconnect after packet, before ACK, cannot consume the pending delivery.
  await writer.save(first.binding,"disconnect before ACK");
  first.client.removeAllListeners("publication-batch");
  first.client.on("publication-batch",()=>first.client.disconnect());
  check(!await reconcilePublication(first.socket,first.owner,members,journal));
  check(await journal.claim(first.binding)===null);
  const next=await connect();
  const successor=await next.owner.admit({credential:first.credential,expectedGeneration:first.binding.generation,
    operationId:"successor_operation_123"});
  assert.ok(successor);
  next.client.on("publication-batch",(batch:PublicationBatch,ack:(value:unknown)=>void)=>
    ack({deliveryTry:batch.deliveryTry,ids:batch.messages.map(m=>m.id)}));
  check(await reconcilePublication(next.socket,next.owner,members,journal));
  check(!await journal.acknowledge(first.binding,retry,{deliveryTry:retry.deliveryTry,ids:retry.messages.map(m=>m.id)}));
  await db.query("UPDATE rooms SET auth_version=2 WHERE id='other123'");
  check(await journal.claim(foreign.binding)===null); // durable policy, not merely local liveness
  await db.query("UPDATE rooms SET auth_version=1 WHERE id='other123'");
  // Absolute subscription expiry cannot be extended by re-registration.
  await db.query("UPDATE publication_subscribers SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",[foreign.binding.sessionId]);
  await assert.rejects(journal.claim(foreign.binding),/expired/);checks++;

  const limited=await fixture("limit123");
  await db.query("INSERT INTO messages(room_id,username,content) SELECT 'limit123','peer','bounded '||i FROM generate_series(1,257) i");
  for(let i=0;i<16;i++){
    const batch=await journal.claim(limited.binding);assert.ok(batch && batch.messages.length===16);
    check(await journal.acknowledge(limited.binding,batch,{deliveryTry:batch.deliveryTry,ids:batch.messages.map(m=>m.id)}));
  }
  await assert.rejects(journal.claim(limited.binding),/receipt capacity/);checks++;
  check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE session_id=$1",[limited.binding.sessionId])).rows[0].n===256);
  const large=await fixture("large123");
  await db.query("INSERT INTO messages(room_id,username,content) VALUES ('large123','peer',repeat('x',1048576))");
  await assert.rejects(journal.claim(large.binding),/byte capacity/);checks++;
  check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE session_id=$1",[large.binding.sessionId])).rows[0].n===0);
  // Test-only credential stays inside this disposable DB, never logs/artifacts.
  await db.query("INSERT INTO fixture_recovery VALUES ($1,$2)",[JSON.stringify(first.credential),successor.generation]);
  // Leave an actually emitted but unACKed durable delivery for crash inspection.
  await writer.save(successor,"crash pending");
  next.client.removeAllListeners("publication-batch");
  let crashPackets=0;
  next.client.on("publication-batch",()=>{crashPackets++;});
  check(!await reconcilePublication(next.socket,next.owner,members,journal));
  check(crashPackets===1);
  // Two actual sessions race for the last subscriber slot. Raw fixture rows
  // fill capacity without spending 99 socket handshakes; admission uses real SQL.
  const capA=await fixture("other123"), capB=await fixture("other123");
  const remaining=99-(await db.query("SELECT count(*)::int n FROM publication_subscribers")).rows[0].n;
  await db.query(`WITH seeded AS (
    INSERT INTO room_resume_sessions(id,token_hash,room_id,username,auth_version,expires_at)
    SELECT 'capacity_'||n,'fixture_hash_'||n,'other123','fixture',1,clock_timestamp()+interval '1 hour'
    FROM generate_series(1,$1) n RETURNING id,expires_at)
    INSERT INTO publication_subscribers SELECT id,expires_at FROM seeded`,[remaining]);
  const race=await Promise.allSettled([journal.claim(capA.binding),journal.claim(capB.binding)]);
  check(race.filter(r=>r.status==="fulfilled" && r.value!==null).length===1);
  check(race.filter(r=>r.status==="rejected" && /subscriber capacity/.test(String(r.reason))).length===1);
  check((await db.query("SELECT count(*)::int n FROM publication_subscribers")).rows[0].n===100);
  console.log(JSON.stringify({phase:"subscriber-seed",checks,deliveries,deduplicated:seen.size,
    scope:"private real SocketIO and actual ResumeMessageWriter; not public browser acceptance"}));
}
async function recover() {
  check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE acked")).rows[0].n>=260);
  check((await db.query(`SELECT count(*)::int n FROM publication_deliveries d JOIN messages m ON m.id=d.message_id
    WHERE NOT d.acked AND m.content='crash pending'`)).rows[0].n===1);
  check((await db.query("SELECT count(*)::int n FROM message_publication_pending")).rows[0].n===264);
  check((await db.query("SELECT id FROM messages EXCEPT SELECT message_id FROM message_publication_pending")).rowCount===0);
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  const saved=(await db.query("SELECT credential,generation FROM fixture_recovery")).rows[0];
  const physical=await connect();
  const binding=await physical.owner.admit({credential:saved.credential,expectedGeneration:saved.generation,
    operationId:"after_restart_operation_123"});
  assert.ok(binding);
  let packets=0;
  physical.client.on("publication-batch",(batch:PublicationBatch,ack:(value:unknown)=>void)=>{
    packets++;
    check(batch.messages.length===1 && batch.messages[0].content==="crash pending");
    ack({deliveryTry:batch.deliveryTry,ids:batch.messages.map(m=>m.id)});
  });
  // New durable generation fences/reclaims the old lease without waiting.
  check(await reconcilePublication(physical.socket,physical.owner,members,journal));
  check(packets===1);
  check((await journal.claim(binding))?.messages.length===0);
  console.log(JSON.stringify({phase:"subscriber-after-database-restart",checks,
    scope:"new Node, real bearer CAS/SocketIO owner, old ACK set retained and unACKed message redelivered; no rendered browser"}));
}
async function main() {
  try { if(process.argv[2]==="recover") await recover(); else await seed(); }
  finally {
    await Promise.all(owners.map(o=>o.close()));
    clients.forEach(c=>c.disconnect());
    await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    await db.end();await admin.end();
  }
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
