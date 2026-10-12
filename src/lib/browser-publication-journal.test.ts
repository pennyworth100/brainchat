import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserPublicationJournal } from "./browser-publication-journal";
import { createBrowserResumeController } from "./browser-resume-controller";
const request = { roomId: "candy986", sessionId: "11111111-1111-4111-8111-111111111111",
  generation: 1, requestId: "publication_request_001" };
const row = (id: number) => ({ id, type: "message" as const, username: "alice", ts: 1000, message: "hello" });
const deliveryTry = "22222222-2222-4222-8222-222222222222";
const batch = (history: unknown[] = [row(1)]) => ({ ...request, cut: "journal-batch", deliveryTry, history });

test("later lower ID is retained; duplicate lease retry ACKs exact set without duplicating projection", () => {
  const j = createBrowserPublicationJournal(request, [row(20)]);
  const a = j.receive(batch([row(2), row(30)]));
  assert.deepEqual(a.history.map(r => r.id), [2, 20, 30]);
  assert.deepEqual(a.ack.ids, [2, 30]);
  const b = j.receive({ ...batch([row(2), row(30)]), deliveryTry: "33333333-3333-4333-8333-333333333333" });
  assert.deepEqual(b.history, a.history);
  assert.equal(b.ack.deliveryTry, "33333333-3333-4333-8333-333333333333");
  assert.ok(Object.isFrozen(b) && Object.isFrozen(b.history) && Object.isFrozen(b.ack.ids));
});
test("snapshot seeds all 256 IDs; duplicate is allowed but the 257th fails without eviction", () => {
  const j = createBrowserPublicationJournal(request, Array.from({length:256}, (_,i) => row(i+1)));
  assert.equal(j.receive(batch([row(1)])).history.length, 256);
  assert.throws(() => j.receive(batch([row(257)])), /count capacity/);
  assert.throws(() => j.receive(batch([row(1)])), /closed/);
});
test("retained UTF8 budget applies cumulatively across individually valid image batches", () => {
  const j = createBrowserPublicationJournal(request, []);
  const image = (id: number) => ({ ...row(id), type:"image", dataUrl:"data:image/png;base64,"+"YWFh".repeat(150000) });
  assert.equal(j.receive(batch([image(1)])).history.length, 1);
  assert.throws(() => j.receive(batch([image(2)])), /byte capacity/);
  assert.throws(() => j.receive(batch()), /closed/);
});
test("conflicting IDs fail closed even when earlier entries in a batch are new", () => {
  const j = createBrowserPublicationJournal(request, [row(20)]);
  assert.throws(() => j.receive(batch([row(2), {...row(20), message:"changed"}])), /Conflicting/);
  assert.throws(() => j.receive(batch([row(20)])), /closed/);
});
for (const change of [{ roomId:"apple123" }, {sessionId:"bad"}, {generation:2},
  {requestId:"other_request_001"}, {deliveryTry:"bad"}, {cut:"full-bounded-statement"},
  {history:[]}, {history:[row(2),row(1)]}, {history:[row(1),row(1)]},
  {history:Array.from({length:17},(_,i)=>row(i+1))},
  {history:[{...row(1),ts:-1}]}, {history:[{...row(1),type:"system"}]}]) {
  test("journal envelope fails closed: "+JSON.stringify(change).slice(0,90), () => {
    const j = createBrowserPublicationJournal(request, []);
    assert.throws(() => j.receive({...batch(),...change}));
    assert.throws(() => j.receive(batch()), /closed/);
  });
}
test("text, image and file normalization preserves digest; caller mutations do not affect retained rows", () => {
  const j = createBrowserPublicationJournal(request, []);
  const value = batch([row(1),{...row(2),type:"image",dataUrl:"data:image/png;base64,YQ=="},
    {...row(3),type:"file",url:"/uploads/fixture/blob",name:"a.txt",size:1,mime:"text/plain",sha256:"a".repeat(64)}]);
  const a = j.receive(value);
  value.history.splice(0);
  assert.equal(a.history.length, 3);
  assert.equal(a.history[2].sha256, "a".repeat(64));
  assert.equal(j.receive(batch([row(1)])).history.length, 3);
  j.cancel();
  assert.throws(() => j.receive(batch()), /closed/);
});
function fixture() {
  let key=0, time=1000;
  const c = createBrowserResumeController(() => "operation_key_"+(++key).toString().padStart(4,"0"),
    () => time, 32, "publication-cut");
  const physical = {}, lease = {...request,username:"alice",token:"A".repeat(43),expiresAt:10000};
  const ticket = c.accept(c.beginJoin("candy986","alice",physical),physical,lease);
  const adapter = c.publicationSnapshot(physical,ticket), identity = adapter.request;
  c.stagePublication(physical,ticket,adapter.accept({...identity,cut:"full-bounded-statement",deliveryTry,history:[row(20)],users:["alice"]}));
  const confirm = () => c.confirmPublication(physical,ticket,{...identity,cut:"full-bounded-statement",deliveryTry,settled:true});
  return {c,physical,ticket,identity,lease,confirm,expire:()=>{time=10000;}};
}
test("journal is unavailable before snapshot confirmation", () => {
  const f = fixture();
  assert.throws(() => f.c.receivePublication(f.physical,f.ticket,{...batch(),...f.identity}), /Missing confirmed/);
  assert.equal(f.c.status().phase,"blocked");
});
test("confirmed controller receives later rows but retains SYNCING and denies operation authority", () => {
  const f = fixture(); f.confirm();
  const result = f.c.receivePublication(f.physical,f.ticket,{...batch(),...f.identity});
  assert.deepEqual(result.history.map(r=>r.id),[1,20]);
  assert.equal(f.c.status().phase,"syncing");
  assert.throws(() => f.c.beginOperation("message","a".repeat(64)),/synchronized/);
  assert.throws(() => f.c.uploadAuthority(f.physical,"socket"),/synchronized/);
});
test("stale physical or copied ticket does not poison active journal; expiry blocks current delivery", () => {
  const f = fixture(); f.confirm();
  assert.throws(() => f.c.receivePublication({},f.ticket,batch()),/Stale/);
  assert.throws(() => f.c.receivePublication(f.physical,{...f.ticket},batch()),/Stale/);
  assert.equal(f.c.receivePublication(f.physical,f.ticket,{...batch(),...f.identity}).history.length,2);
  f.expire();
  assert.throws(() => f.c.receivePublication(f.physical,f.ticket,{...batch(),...f.identity}),/expired/);
});
test("disconnect and resumed generation cancel old journal until a new confirmed cut", () => {
  const f = fixture(); f.confirm();
  f.c.disconnect(f.physical);
  assert.throws(() => f.c.receivePublication(f.physical,f.ticket,batch()),/Stale/);
  const physical = {}, ticket = f.c.accept(f.c.beginResume(physical),physical,{...f.lease,generation:2});
  assert.throws(() => f.c.receivePublication(physical,ticket,{...batch(),...ticket}),/Missing confirmed/);
});
