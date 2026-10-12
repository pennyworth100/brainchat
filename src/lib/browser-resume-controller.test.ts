import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserResumeController, type BrowserLease } from "./browser-resume-controller";
test("old history cannot activate a replacement join on the same physical connection and generation", () => {
  const { controller: c, first } = fixture();
  const oldJoin = c.beginJoin("candy986", "alice", first);
  const oldSync = c.accept(oldJoin, first, lease);
  const newJoin = c.beginJoin("candy986", "alice", first);
  const newSync = c.accept(newJoin, first, { ...lease, sessionId: "22222222-2222-4222-8222-222222222222" });
  assert.throws(() => c.finishSync(first, 1, oldSync), /Stale/);
  assert.throws(() => c.finishSync(first, 1, { ...newSync }), /Stale/);
  assert.equal(c.status().phase, "syncing");
  c.finishSync(first, 1, newSync);
  assert.equal(c.status().phase, "ready");
});
const lease: BrowserLease = { roomId: "candy986", username: "alice",
  sessionId: "11111111-1111-4111-8111-111111111111", token: "A".repeat(43),
  generation: 1, expiresAt: 5000 };
function fixture(limit = 32) {
  let key = 0, time = 1000;
  const controller = createBrowserResumeController(() => "operation_key_" + (++key).toString().padStart(4, "0"), () => time, limit);
  const first = {};
  const ticket = controller.beginJoin("candy986", "alice", first);
  const sync = controller.accept(ticket, first, lease);
  controller.finishSync(first, 1, sync);
  return { controller, first, expire: () => { time = 5000; } };
}
test("join and resume require exact physical CAS then matching history synchronization", () => {
  const { controller: c, first } = fixture();
  c.disconnect(first);
  assert.throws(() => c.uploadAuthority(first, "socket"), /synchronized/);
  const second = {};
  const ticket = c.beginResume(second);
  assert.equal(c.beginResume(second), ticket);
  assert.equal(ticket.expectedGeneration, 1);
  assert.throws(() => c.accept({ ...ticket }, second, { ...lease, generation: 2 }), /Stale/);
  const sync = c.accept(ticket, second, { ...lease, generation: 2 });
  assert.throws(() => c.finishSync(first, 2, sync), /Stale/);
  assert.throws(() => c.finishSync(second, 1, sync), /Stale/);
  assert.throws(() => c.beginOperation("message", "a".repeat(64)), /synchronized/);
  c.finishSync(second, 2, sync);
  c.disconnect(first);
  assert.equal(c.uploadAuthority(second, "socket-2").kind, "resume");
});
for (const kind of ["message", "image", "file"] as const) {
  test(kind + ": unknown delivery retains key across same-session resume; exact receipt settles once", () => {
    const { controller: c, first } = fixture();
    const operation = c.beginOperation(kind, "a".repeat(64));
    const sent = c.dispatch(operation, first);
    c.disconnect(first);
    const second = {}, ticket = c.beginResume(second);
    const sync = c.accept(ticket, second, { ...lease, generation: 2 });
    c.finishSync(second, 2, sync);
    const retry = c.dispatch(operation, second);
    assert.equal(retry.clientMessageId, sent.clientMessageId);
    assert.equal(retry.sessionId, sent.sessionId);
    const receipt = { ...operation, sessionId: lease.sessionId, messageId: 42 };
    assert.throws(() => c.reconcile(operation, first, receipt), /mismatch/);
    assert.throws(() => c.reconcile(operation, second, { ...receipt, payloadHash: "b".repeat(64) }), /mismatch/);
    assert.equal(c.status().pending, 1);
    assert.equal(c.reconcile(operation, second, receipt), 42);
    assert.throws(() => c.reconcile(operation, second, receipt), /owner/);
  });
  test(kind + ": explicit same-room rejoin cannot transfer old operation or accept late receipt", () => {
    const { controller: c, first } = fixture();
    const operation = c.beginOperation(kind, "a".repeat(64));
    c.dispatch(operation, first);
    const ticket = c.beginJoin("candy986", "alice", first);
    const sync = c.accept(ticket, first, { ...lease, sessionId: "22222222-2222-4222-8222-222222222222" });
    c.finishSync(first, 1, sync);
    assert.throws(() => c.dispatch(operation, first), /owner/);
    assert.throws(() => c.dispatch({ ...operation }, first), /owner/);
  });
}
test("lost CAS ACK never guesses generation or automatically steals the winner", () => {
  const { controller: c, first } = fixture();
  c.disconnect(first);
  const second = {}, ticket = c.beginResume(second);
  c.disconnect(second);
  assert.equal(c.status().phase, "uncertain");
  assert.throws(() => c.beginResume({}), /reconciliation/);
  assert.throws(() => c.accept(ticket, second, { ...lease, generation: 2 }), /Stale/);
});
test("CAS denial blocks automatic retry; stale denial cannot poison successor", () => {
  const { controller: c, first } = fixture();
  c.disconnect(first);
  const second = {}, ticket = c.beginResume(second);
  c.reject({ ...ticket }, second);
  assert.equal(c.status().phase, "syncing");
  c.reject(ticket, second);
  c.disconnect(second);
  assert.equal(c.status().phase, "blocked");
  assert.throws(() => c.beginResume({}), /reconciliation/);
});
test("expiry fences dispatch and receipts; uncertain work occupies bounded capacity", () => {
  const { controller: c, first, expire } = fixture(1);
  const operation = c.beginOperation("file", "a".repeat(64));
  c.dispatch(operation, first);
  assert.throws(() => c.beginOperation("image", "b".repeat(64)), /capacity/);
  expire();
  assert.throws(() => c.dispatch(operation, first), /expired/);
  assert.throws(() => c.reconcile(operation, first, { ...operation, sessionId: lease.sessionId, messageId: 1 }), /expired/);
  assert.equal(c.status().pending, 1);
});
test("malformed or changed credential and wrong CAS generation fail closed", () => {
  for (const change of [{ generation: 3 }, { token: "bad" }, { expiresAt: 6000 },
    { sessionId: "22222222-2222-4222-8222-222222222222" }, { username: "mallory" }]) {
    const { controller: c, first } = fixture();
    c.disconnect(first);
    const second = {}, ticket = c.beginResume(second);
    assert.throws(() => c.accept(ticket, second, { ...lease, generation: 2, ...change }), /Invalid/);
    assert.equal(c.status().phase, "blocked");
  }
});
