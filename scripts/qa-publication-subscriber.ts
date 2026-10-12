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
import { ResumePublication, reconcilePublication, type PublicationBatch, type PublicationSnapshot } from "../src/lib/resume-publication";
import { publishBrowserPublicationSnapshot, createBrowserPublicationExchange, reconcileBrowserPublication } from "../src/lib/resume-browser-snapshot";
import { createBrowserResumeController } from "../src/lib/browser-resume-controller";

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
async function snapshotCut() {
  await db.query("INSERT INTO rooms(id) VALUES ('snap123')");
  const physical = await fixture("snap123");
  const empty = await journal.snapshot(physical.binding);
  check(empty?.cut === "full-bounded-statement" && empty.messages.length === 0);
  check(await journal.snapshot({...physical.binding}) === null);
  await db.query("INSERT INTO messages(room_id,username,content) SELECT 'snap123','peer','old '||i FROM generate_series(1,101) i");
  const lowTx = await db.connect();
  try {
    await lowTx.query("BEGIN");
    const low = (await lowTx.query("INSERT INTO messages(room_id,username,content) VALUES ('snap123','peer','late lower snapshot') RETURNING id")).rows[0].id;
    const high = await writer.save(physical.binding,"higher snapshot"); assert.ok(high.authorized);
    const cut = await journal.snapshot(physical.binding); assert.ok(cut);
    check(cut.messages.length === 102 && cut.messages.some(row=>row.id===high.value.id));
    check(!cut.messages.some(row=>row.id===low) && low < high.value.id);
    // EMPTY claim while the snapshot is leased is NOT a drained/READY receipt.
    check((await journal.claim(physical.binding))?.messages.length === 0);
    check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE session_id=$1 AND NOT acked",[physical.binding.sessionId])).rows[0].n === 102);
    await lowTx.query("COMMIT");
    const later = await journal.claim(physical.binding); assert.ok(later);
    check(later.messages.length === 1 && later.messages[0].id === low);
    const seen = new Set<number>();
    physical.client.on("snapshot-cut",(batch:PublicationBatch,ack:(value:unknown)=>void)=>{
      batch.messages.forEach(row=>seen.add(row.id));
      ack({deliveryTry:batch.deliveryTry,ids:batch.messages.map(row=>row.id)});
    });
    const reply = await physical.socket.timeout(4000).emitWithAck("snapshot-cut",cut);
    check(seen.size === 102);
    check(await journal.acknowledge(physical.binding,cut,reply));
    check(await journal.acknowledge(physical.binding,later,{deliveryTry:later.deliveryTry,ids:[low]}));
    let refreshed!: PublicationSnapshot;
    // The actual SQL cut crosses the exact-owner request boundary, not newest100.
    // Withhold persistence of this client ACK to retain the lease-loss test below.
    let normalizedReply!: Promise<unknown>;
    const controller = createBrowserResumeController(undefined, Date.now, 32, "publication-cut");
    const join = controller.beginJoin("snap123", "Reader", physical.client);
    const sync = controller.accept(join, physical.client, { ...physical.credential, username: "Reader",
      generation: physical.binding.generation, expiresAt: physical.binding.expiresAt });
    const adapter = controller.publicationSnapshot(physical.client, sync);
    physical.client.on("normalized-cut", (value, ack) => {
      check(value.cut === "full-bounded-statement" && value.window === undefined && value.ready === undefined);
      check(value.history.length === 103 && value.history.some((row: {id:number}) => row.id === low));
      check(value.history.every((row: {message:unknown;ts:unknown;content:unknown}) =>
        typeof row.message === "string" && typeof row.ts === "number" && row.content === undefined));
      check(value.requestId === adapter.request.requestId && value.sessionId === physical.binding.sessionId);
      const staged = controller.stagePublication(physical.client, sync, adapter.accept(value));
      check(staged.snapshot.history.length === 103 && staged.snapshot.history.some(row => row.id === low));
      check(controller.status().phase === "syncing");
      assert.throws(() => controller.beginOperation("message", "a".repeat(64)), /synchronized/); checks++;
      ack(staged.ack);
    });
    check(await publishBrowserPublicationSnapshot(physical.socket, physical.owner, physical.binding, members,
      { snapshot: async binding => {
        check(binding === physical.binding);
        const snapshot = await journal.snapshot(binding); assert.ok(snapshot);
        refreshed = snapshot; return snapshot;
      } },
      adapter.request, value => {
        normalizedReply = physical.socket.timeout(4000).emitWithAck("normalized-cut", value);
      }));
    const normalizedACK = await normalizedReply as {deliveryTry:string;ids:number[]};
    check(refreshed.messages.length === 103 && refreshed.deliveryTry !== cut.deliveryTry);
    check(normalizedACK.deliveryTry === refreshed.deliveryTry && normalizedACK.ids.length === 103);
    await assert.rejects(journal.acknowledge(physical.binding,cut,reply),/lease lost/); checks++;
    // Snapshot ACK loss is recoverable as ordinary leased journal batches.
    await db.query("UPDATE publication_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE session_id=$1",[physical.binding.sessionId]);
    const retry = await journal.claim(physical.binding); assert.ok(retry);
    check(retry.messages.length === 16 && retry.deliveryTry !== refreshed.deliveryTry);
    // Corrupt TEST journal only: no silent truncated snapshot or receipt mutation.
    await db.query("DELETE FROM message_publication_pending WHERE message_id=$1",[low]);
    await assert.rejects(journal.snapshot(physical.binding),/journal gap/); checks++;
    check((await db.query("SELECT delivery_try FROM publication_deliveries WHERE session_id=$1 AND message_id=$2",[physical.binding.sessionId,retry.messages[0].id])).rows[0].delivery_try === retry.deliveryTry);
    console.log(JSON.stringify({phase:"subscriber-full-snapshot",rows:103,cutRows:102,
      lateLowerCommit:true,emptyClaimNotReady:true,physicalClientACK:true,
      snapshotACKLossRedelivers:true,normalizedPhysicalHandoff:true,actualControllerStagesFullCut:true,
      scope:"private normalized bounded SQL cut; no controller READY, retained browser dedup or public wiring"}));
  } finally {
    await lowTx.query("ROLLBACK"); lowTx.release();
    await physical.owner.close(); physical.client.disconnect();
    await db.query("DELETE FROM messages WHERE room_id='snap123'");
    await db.query("DELETE FROM room_resume_sessions WHERE room_id='snap123'");
    await db.query("DELETE FROM rooms WHERE id='snap123'");
  }
}

async function requestBoundConfirmation() {
  await db.query("INSERT INTO rooms(id) VALUES ('conf123')");
  const physical = await fixture("conf123");
  const lowTx = await db.connect();
  try {
    for (const count of [0, 1]) {
      let low = 0;
      if (count) {
        await lowTx.query("BEGIN");
        low = (await lowTx.query("INSERT INTO messages(room_id,username,content) VALUES ('conf123','peer','late lower browser journal') RETURNING id")).rows[0].id;
      }
      if (count) check((await writer.save(physical.binding, "before confirmed cut")).authorized);
      const controller = createBrowserResumeController(undefined, Date.now, 32, "publication-cut");
      const join = controller.beginJoin("conf123", "Reader", physical.client);
      const sync = controller.accept(join, physical.client, { ...physical.credential, username: "Reader",
        generation: physical.binding.generation, expiresAt: physical.binding.expiresAt });
      const adapter = controller.publicationSnapshot(physical.client, sync);
      const request = adapter.request;
      const exchange = createBrowserPublicationExchange(physical.socket, physical.owner,
        physical.binding, members, journal, request); assert.ok(exchange);
      physical.client.once("request-cut", (value, ack) => {
        check(value.history.length === count);
        controller.stagePublication(physical.client, sync, adapter.accept(value));
        ack(controller.publicationAck(physical.client, sync));
      });
      let clientACK!: Promise<unknown>;
      check(await exchange.publish(value => {
        clientACK = physical.socket.timeout(4000).emitWithAck("request-cut", value);
      }));
      const reply = await clientACK;
      let attempted = 0;
      check(await exchange.acknowledge(reply, () => { attempted++; /* deliberately lose network confirmation */ }));
      check(attempted === 1);
      check(controller.status().phase === "syncing");
      assert.deepEqual(controller.publicationAck(physical.client, sync), reply); checks++;
      check((await db.query("SELECT acked FROM publication_snapshot_attempts WHERE session_id=$1",
        [physical.binding.sessionId])).rows[0].acked === true);
      check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE session_id=$1 AND NOT acked",
        [physical.binding.sessionId])).rows[0].n === 0);
      let delivered!: Promise<unknown>;
      physical.client.once("cut-confirmed", (value, ack) => {
        check(value.settled === true && value.requestId === request.requestId &&
          value.sessionId === request.sessionId && value.generation === request.generation &&
          value.roomId === request.roomId && value.deliveryTry === (reply as any).deliveryTry);
        const confirmed = controller.confirmPublication(physical.client, sync, value);
        check(confirmed.history.length === count);
        check(controller.status().phase === "syncing");
        assert.throws(() => controller.beginOperation("message", "a".repeat(64)), /synchronized/); checks++;
        ack({ received: true });
      });
      check(await exchange.acknowledge(reply, value => {
        delivered = physical.socket.timeout(4000).emitWithAck("cut-confirmed", value);
      }));
      check((await delivered as {received:boolean}).received === true);
      if (count) {
        await lowTx.query("COMMIT");
        const later = await writer.save(physical.binding, "after confirmed cut"); assert.ok(later.authorized);
        check(low < later.value.id);
        const media = await db.query("INSERT INTO messages(room_id,username,type,content) VALUES ('conf123','peer','image',$1),('conf123','peer','file',$2) RETURNING id", [
          JSON.stringify({dataUrl:"data:image/png;base64,YQ=="}),
          JSON.stringify({url:"/uploads/fixture/blob",name:"a.txt",size:1,mime:"text/plain",sha256:"a".repeat(64)})]);
        let packets = 0, priorTry = "", retainedIDs: number[] = [];
        physical.client.on("publication-batch", (value, ack) => {
          const result = controller.receivePublication(physical.client, sync, value);
          check(result.history.length === 5);
          check(result.history[0].id === low);
          check(result.history.find(row => row.id === media.rows[1].id)?.sha256 === "a".repeat(64));
          assert.deepEqual(result.ack.ids, [low, later.value.id, ...media.rows.map(row => row.id)]); checks++;
          if (++packets === 1) {
            priorTry = value.deliveryTry; retainedIDs = result.history.map(row => row.id);
            return; // Lose ACK AFTER browser retained all rows.
          }
          check(value.deliveryTry !== priorTry);
          assert.deepEqual(result.history.map(row => row.id), retainedIDs); checks++;
          ack(result.ack);
        });
        check(!await reconcileBrowserPublication(physical.socket, physical.owner, physical.binding, members, journal, request));
        check(packets === 1 && controller.status().phase === "syncing");
        // Owned test SQL expires only this fixture's delivery lease deterministically.
        await db.query("UPDATE publication_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE session_id=$1 AND NOT acked", [physical.binding.sessionId]);
        check(await reconcileBrowserPublication(physical.socket, physical.owner, physical.binding, members, journal, request));
        check(packets === 2 && controller.status().phase === "syncing");
        check((await journal.claim(physical.binding))?.messages.length === 0);
        physical.client.removeAllListeners("publication-batch");
      }
    }
    console.log(JSON.stringify({phase:"request-bound-confirmation",fullAndEmpty:true,
      actualSocketDelivery:true,lostConfirmationRetry:true,durableBeforeConfirmation:true,
      laterCommitRetained:true,actualControllerConfirmation:true,controllerRemainsSyncing:true,
      continuingJournal:true,lateLowerCommit:true,lostBatchACKDeduplicated:true,allMediaProjection:true,
      scope:"private request-bound journal/controller; no READY, browser reload or public file-byte proof"}));
  } finally {
    await lowTx.query("ROLLBACK"); lowTx.release();
    await physical.owner.close(); physical.client.disconnect();
    await db.query("DELETE FROM messages WHERE room_id='conf123'");
    await db.query("DELETE FROM room_resume_sessions WHERE room_id='conf123'");
    await db.query("DELETE FROM rooms WHERE id='conf123'");
  }
}

async function durableCutSettlement() {
  await db.query("INSERT INTO rooms(id) VALUES ('cut123'),('empty123')");
  const full = await fixture("cut123"), emptyOwner = await fixture("empty123");
  const empty = await journal.snapshot(full.binding); assert.ok(empty);
  const ackOf = (cut: PublicationSnapshot) => ({deliveryTry:cut.deliveryTry,ids:cut.messages.map(row=>row.id)});
  // A real message commits AFTER an empty cut, before its ACK. Settling that cut
  // must not consume the later message or imply that reconciliation is drained.
  const late = await writer.save(full.binding,"after empty cut"); assert.ok(late.authorized);
  full.client.on("settlement-cut", (cut: PublicationSnapshot, ack: (reply:unknown)=>void) => ack(ackOf(cut)));
  const emptyReply = await full.socket.timeout(4000).emitWithAck("settlement-cut",empty);
  check(await journal.acknowledgeSnapshot(full.binding,empty,emptyReply));
  check(await journal.acknowledgeSnapshot(full.binding,empty,emptyReply)); // lost confirmation retry
  const pending = await journal.claim(full.binding); assert.ok(pending);
  check(pending.messages.length === 1 && pending.messages[0].id === late.value.id);
  check((await writer.save(full.binding,"second cut row")).authorized);
  const cut = await journal.snapshot(full.binding); assert.ok(cut);
  check(cut.messages.length === 2 && cut.deliveryTry !== empty.deliveryTry);
  await assert.rejects(journal.acknowledgeSnapshot(full.binding,empty,emptyReply),/snapshot ACK lease lost/); checks++;
  check(!await journal.acknowledgeSnapshot({...full.binding},cut,ackOf(cut)));
  check(!await journal.acknowledgeSnapshot(emptyOwner.binding,cut,ackOf(cut)));
  check(!await journal.acknowledgeSnapshot(full.binding,cut,{deliveryTry:cut.deliveryTry,ids:[]}));
  // A caller forging BOTH batch and reply cannot redefine the persisted set.
  const subset = {...cut,messages:cut.messages.slice(0,1)};
  await assert.rejects(journal.acknowledgeSnapshot(full.binding,subset,ackOf(subset)),/snapshot ACK lease lost/); checks++;
  check((await db.query("SELECT acked FROM publication_snapshot_attempts WHERE session_id=$1",[full.binding.sessionId])).rows[0].acked === false);
  await db.query("UPDATE publication_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE session_id=$1 AND message_id=$2",[full.binding.sessionId,cut.messages[1].id]);
  await assert.rejects(journal.acknowledgeSnapshot(full.binding,cut,ackOf(cut)),/snapshot ACK receipt lost/); checks++;
  // The attempted marker ACK must roll back when any row receipt cannot settle.
  check((await db.query("SELECT acked FROM publication_snapshot_attempts WHERE session_id=$1",[full.binding.sessionId])).rows[0].acked === false);
  check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE session_id=$1 AND acked",[full.binding.sessionId])).rows[0].n === 0);
  const refreshed = await journal.snapshot(full.binding); assert.ok(refreshed);
  await db.query("UPDATE publication_snapshot_attempts SET lease_until=clock_timestamp()-interval '1 second' WHERE session_id=$1",[full.binding.sessionId]);
  await assert.rejects(journal.acknowledgeSnapshot(full.binding,refreshed,ackOf(refreshed)),/snapshot ACK lease lost/); checks++;
  check((await db.query("SELECT acked FROM publication_deliveries WHERE session_id=$1",[full.binding.sessionId])).rows[0].acked === false);
  const finalCut = await journal.snapshot(full.binding); assert.ok(finalCut);
  const reply = await full.socket.timeout(4000).emitWithAck("settlement-cut",finalCut);
  await db.query("UPDATE rooms SET auth_version=2 WHERE id='cut123'");
  check(!await journal.acknowledgeSnapshot(full.binding,finalCut,reply));
  await db.query("UPDATE rooms SET auth_version=1 WHERE id='cut123'");
  const mutable = {...finalCut};
  const settling = journal.acknowledgeSnapshot(full.binding,mutable,reply);
  mutable.deliveryTry = "00000000-0000-4000-8000-000000000000";
  mutable.messages = []; // caller changes cannot retarget an in-flight settlement
  check(await settling);
  check(await journal.acknowledgeSnapshot(full.binding,finalCut,reply));
  const finalEmpty = await journal.snapshot(emptyOwner.binding); assert.ok(finalEmpty);
  emptyOwner.client.on("settlement-cut", (cut: PublicationSnapshot, ack: (reply:unknown)=>void) => ack(ackOf(cut)));
  const finalEmptyReply = await emptyOwner.socket.timeout(4000).emitWithAck("settlement-cut",finalEmpty);
  check(await journal.acknowledgeSnapshot(emptyOwner.binding,finalEmpty,finalEmptyReply));
  await db.query("INSERT INTO fixture_snapshot_recovery VALUES ($1),($2)",[
    JSON.stringify({sessionId:full.binding.sessionId,deliveryTry:finalCut.deliveryTry,ids:ackOf(finalCut).ids}),
    JSON.stringify({sessionId:emptyOwner.binding.sessionId,deliveryTry:finalEmpty.deliveryTry,ids:[]})]);
  await full.owner.close(); full.client.disconnect();
  check(!await journal.acknowledgeSnapshot(full.binding,finalCut,reply));
  await emptyOwner.owner.close(); emptyOwner.client.disconnect();
  console.log(JSON.stringify({phase:"durable-cut-settlement",fullRows:2,emptyRows:0,
    physicalACK:true,confirmationRetry:true,lateCommitRetained:true,subsetRejected:true,
    receiptFailureRollsBackMarker:true,leaseAndAuthorityFenced:true,
    scope:"private SQL settlement only; no request-bound confirmation, controller READY or public activation"}));
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
  await db.query("CREATE TABLE fixture_snapshot_recovery (attempt jsonb NOT NULL)");
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  await durableCutSettlement();
  await requestBoundConfirmation();
  await snapshotCut();
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
  check((await db.query("SELECT count(*)::int n FROM message_publication_pending WHERE room_id='candy986'")).rows[0].n===1);

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
  await assert.rejects(journal.snapshot(limited.binding),/snapshot capacity/); checks++;
  check((await db.query("SELECT session_id FROM publication_subscribers WHERE session_id=$1",[limited.binding.sessionId])).rowCount===0);
  for(let i=0;i<16;i++){
    const batch=await journal.claim(limited.binding);assert.ok(batch && batch.messages.length===16);
    check(await journal.acknowledge(limited.binding,batch,{deliveryTry:batch.deliveryTry,ids:batch.messages.map(m=>m.id)}));
  }
  await assert.rejects(journal.claim(limited.binding),/receipt capacity/);checks++;
  check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE session_id=$1",[limited.binding.sessionId])).rows[0].n===256);
  const large=await fixture("large123");
  await db.query("INSERT INTO messages(room_id,username,content) VALUES ('large123','peer',repeat('x',1048576))");
  await assert.rejects(journal.snapshot(large.binding),/snapshot byte capacity/); checks++;
  check((await db.query("SELECT session_id FROM publication_subscribers WHERE session_id=$1",[large.binding.sessionId])).rowCount===0);
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
  const retained = (await db.query("SELECT attempt FROM fixture_snapshot_recovery")).rows;
  check(retained.length === 2);
  for (const {attempt} of retained) {
    const durable = (await db.query("SELECT delivery_try,message_ids,acked FROM publication_snapshot_attempts WHERE session_id=$1",[attempt.sessionId])).rows[0];
    check(durable.delivery_try === attempt.deliveryTry && durable.acked === true);
    check(JSON.stringify(durable.message_ids) === JSON.stringify(attempt.ids));
    check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE session_id=$1 AND acked",[attempt.sessionId])).rows[0].n === attempt.ids.length);
  }
  console.log(JSON.stringify({phase:"durable-cut-recovery",attempts:2,fullRows:2,emptyRows:0,
    scope:"retained full/empty ACK rows after immediate PostgreSQL restart; not browser reload proof"}));
  check((await db.query("SELECT count(*)::int n FROM publication_deliveries WHERE acked")).rows[0].n>=260);
  check((await db.query(`SELECT count(*)::int n FROM publication_deliveries d JOIN messages m ON m.id=d.message_id
    WHERE NOT d.acked AND m.content='crash pending'`)).rows[0].n===1);
  check((await db.query("SELECT count(*)::int n FROM message_publication_pending")).rows[0].n===266);
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
