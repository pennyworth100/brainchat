import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Server, type Socket as ServerSocket } from "socket.io";
import { io } from "socket.io-client";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeMemberships } from "../src/lib/resume-membership";
import { attachResumeSocket } from "../src/lib/resume-socket";
import { publishBrowserJoin } from "../src/lib/resume-browser-handshake";
import { createBrowserResumeController, type BrowserLease } from "../src/lib/browser-resume-controller";
import { ResumeOperationGate } from "../src/lib/resume-operation";
import { ResumeHistoryReader } from "../src/lib/resume-history";
import { publishBrowserSnapshot } from "../src/lib/resume-browser-snapshot";
import { mergeMessages, type ChatMessage } from "../src/lib/room-session";
function latch() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function main() {
  const url = process.env.RESUME_TEST_DATABASE_URL; assert(url);
  const parsed = new URL(url); assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, process.env.OWNED_PG_PORT); assert.equal(parsed.search, "");
  const schema = "sync_boundary_" + randomBytes(8).toString("hex");
  const db = new Pool({ connectionString: url, options: "-c search_path=" + schema });
  const a = await db.connect(), b = await db.connect();
  const web = http.createServer(), sockets = new Server(web);
  let client: ReturnType<typeof io> | undefined;
  let owner: ReturnType<typeof attachResumeSocket> | undefined;
  const releaseRead = latch();
  let pending: Promise<boolean> | undefined;
  let checks = 0; const check = (v: unknown) => { assert.ok(v); checks++; };
  try {
    await a.query('CREATE SCHEMA "' + schema + '"');
    for (const name of ["0000_thin_stardust","0001_white_zarda","0003_spotty_zombie","0004_long_nighthawk","0005_free_blazing_skull"]) {
      await a.query((await readFile("drizzle/" + name + ".sql", "utf8")).replaceAll('"public"."rooms"', '"' + schema + '"."rooms"'));
    }
    await a.query("INSERT INTO rooms (id) VALUES ('sync333')");
    const store = new ResumeStore(a), bindings = new ResumeBindings(), members = new ResumeMemberships(bindings);
    const reader = new ResumeHistoryReader(new ResumeOperationGate(db, bindings));
    await new Promise<void>(r => web.listen(0, "127.0.0.1", r));
    const accepted = new Promise<ServerSocket>(r => sockets.once("connection", r));
    client = io("http://127.0.0.1:" + (web.address() as {port: number}).port, {transports:["websocket"],reconnection:false});
    const socket = await accepted;
    owner = attachResumeSocket(socket, {store, bindings, memberships: members,
      prepare: async () => async () => {}, issue: store.issueAfterAuthenticatedJoin.bind(store),
      onCleanupError: e => { throw e; }});
    const controller = createBrowserResumeController();
    const ticket = controller.beginJoin("sync333", "reader", client);
    const leaseWire = new Promise<BrowserLease>(r => client!.once("fixture-lease", r));
    check(await publishBrowserJoin(socket, owner, members, {roomId:"sync333",username:"reader",authVersion:1},
      lease => socket.emit("fixture-lease", lease)));
    const syncTicket = controller.accept(ticket, client, await leaseWire);
    const binding = members.currentBindingFor(socket, owner); assert(binding);
    await a.query("INSERT INTO messages(room_id,username,type,content) VALUES ('sync333','peer','message','before snapshot')");
    const readDone = latch();
    const snapshotWire = new Promise<{history:ChatMessage[],users:string[]}>(r => client!.once("fixture-snapshot", r));
    const adapter = controller.snapshot(client, syncTicket);
    pending = publishBrowserSnapshot(socket, owner, binding, members, {
      read: async current => { const snapshot = await reader.read(current); readDone.resolve(); await releaseRead.promise; return snapshot; }
    }, adapter.request, reply => socket.emit("fixture-snapshot",reply));
    await readDone.promise;
    check(controller.status().phase === "syncing");
    const live: ChatMessage[] = [];
    for (const type of ["message","image","file"] as const) {
      const content = type === "message" ? "after snapshot" : JSON.stringify(type === "image" ?
        {dataUrl:"data:image/png;base64,YQ=="} : {name:"a.txt",size:1,mime:"text/plain",url:"/uploads/fixture/blob"});
      const row = (await a.query("INSERT INTO messages(room_id,username,type,content) VALUES ('sync333','peer',$1,$2) RETURNING id,ts",[type,content])).rows[0];
      const message = {id:row.id,ts:row.ts.getTime(),type,username:"peer",...(type==="message"?{message:content}:JSON.parse(content))};
      const delivered = new Promise<ChatMessage>(r => client!.once("fixture-live", r));
      socket.emit("fixture-live",message); const received = await delivered; live.push(received); adapter.receiveLive(received);
    }
    // A lease alone cannot dispatch while the actual snapshot is withheld.
    assert.throws(() => controller.beginOperation("message", "a".repeat(64)), /synchronized/); checks++;
    check(controller.status().phase === "syncing");
    releaseRead.resolve(); check(await pending);
    const snapshot = await snapshotWire;
    const completed = controller.finishSync(client, 1, syncTicket, adapter.accept(snapshot));
    check(controller.status().phase === "ready");
    check(completed.history.length === 4 && live.every(row => completed.history.some(saved => saved.id === row.id)));
    check(snapshot.history.length === 1);
    check(live.every(row => !snapshot.history.some(saved => saved.id === row.id)));
    const merged = mergeMessages(live,snapshot.history);
    check(merged.length === 4 && live.every(row=>merged.some(saved=>saved.id===row.id)));
    check(mergeMessages(merged,live).length === 4); // existing merge helper does not lose/duplicate these events
    // IDs are allocated before commit. Two independent real SQL transactions:
    await b.query("BEGIN");
    const lower = (await b.query("INSERT INTO messages(room_id,username,content) VALUES ('sync333','peer','late lower id') RETURNING id")).rows[0].id;
    const higher = (await a.query("INSERT INTO messages(room_id,username,content) VALUES ('sync333','peer','early higher id') RETURNING id")).rows[0].id;
    check(lower < higher);
    const beforeCommit = await reader.read(binding) as ChatMessage[];
    check(beforeCommit.some(row=>row.id===higher) && !beforeCommit.some(row=>row.id===lower));
    const watermark = Math.max(...beforeCommit.map(row=>row.id));
    await b.query("COMMIT");
    const naiveDelta = (await a.query("SELECT id FROM messages WHERE room_id='sync333' AND id>$1 ORDER BY id",[watermark])).rows;
    const afterCommit = await reader.read(binding) as ChatMessage[];
    check(afterCommit.some(row=>row.id===lower));
    check(!naiveDelta.some(row=>row.id===lower));
    console.log(JSON.stringify({suite:"snapshot333-boundary-validation",checks,result:"PASS",
      physicalSocket:true,realPostgres:true,historyHandoffExcludesConcurrentRows:3,
      existingMergePreservesDeliveredRows:true,privateControllerReadyBeforeSnapshot:false,validatedCompletionRetainsAllMedia:true,
      maxIdCursorMissesLateCommit:true,lower,higher,
      limits:"PRIVATE validated window, not gap-free full-sync; direct SQL peer writers, not all-producer acceptance; file metadata only"}));
  } finally {
    releaseRead.resolve(); await pending;
    await b.query("ROLLBACK"); await owner?.close(); client?.disconnect();
    await new Promise<void>(r=>sockets.close(()=>r()));
    await a.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    a.release(); b.release(); await db.end();
  }
}
const timeout=setTimeout(()=>{console.error("sync boundary watchdog");process.exit(1);},20000);
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(timeout));
