import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserSnapshotWindow } from "./browser-resume-snapshot";
import { createBrowserResumeController } from "./browser-resume-controller";

const request = { roomId: "candy986", sessionId: "11111111-1111-4111-8111-111111111111",
  generation: 1, requestId: "snapshot_request_001" };
const text = (id: number) => ({ id, type: "message", username: "alice", ts: 1000, message: "hello" });
const image = (id: number) => ({ id, type: "image", username: "alice", ts: 1000, dataUrl: "data:image/png;base64,YQ==" });
const file = (id: number) => ({ id, type: "file", username: "alice", ts: 1000,
  url: "/uploads/" + "a".repeat(64) + "/blob", name: "hello.txt", size: 1, mime: "text/plain" });
const reply = (history: unknown[] = []) => ({ ...request, window: "newest-100-id-ascending", history, users: ["alice"] });

test("reused request-key source blocks lease acceptance without creating a sync capability", () => {
  const c = createBrowserResumeController(() => "repeated_key_0001", () => 0), physical = {};
  const ticket = c.beginJoin("candy986", "alice", physical);
  assert.throws(() => c.accept(ticket, physical, { ...request, username: "alice", token: "A".repeat(43), expiresAt: 5000 }), /reused/);
  assert.equal(c.status().phase, "blocked");
});

test("all media arriving before snapshot are merged, sorted and exact duplicates deduplicated", () => {
  const f = createBrowserSnapshotWindow(request);
  f.api.receiveLive(file(4)); f.api.receiveLive(image(3)); f.api.receiveLive(text(2)); f.api.receiveLive(text(2));
  const completion = f.api.accept(reply([text(1), text(2)]));
  assert.deepEqual(completion.history.map(row => row.id), [1, 2, 3, 4]);
  assert.equal(f.consume(completion), completion);
  assert.throws(() => f.consume(completion), /closed/);
  assert.ok(Object.isFrozen(completion.history) && Object.isFrozen(completion.history[0]));
});
test("full reconciliation window accepts lower ID committed after a higher ID, not afterId", () => {
  const f = createBrowserSnapshotWindow(request);
  f.api.receiveLive(text(6));
  assert.deepEqual(f.consume(f.api.accept(reply([text(5), text(6)]))).history.map(row => row.id), [5, 6]);
});
test("bounded window does not claim complete offline backlog", () => {
  const f = createBrowserSnapshotWindow(request);
  const result = f.consume(f.api.accept(reply(Array.from({ length: 100 }, (_, i) => text(i + 20)))));
  assert.equal(result.history.length, 100);
  assert.equal(result.history[0].id, 20);
  assert.equal(result.window, "newest-100-id-ascending");
  const g = createBrowserSnapshotWindow(request);
  assert.throws(() => g.api.accept(reply(Array.from({ length: 101 }, (_, i) => text(i + 1)))));
});
for (const [label, change] of Object.entries({ request: { requestId: "other_request_0001" },
  session: { sessionId: "22222222-2222-4222-8222-222222222222" }, room: { roomId: "apple123" },
  generation: { generation: 2 }, window: { window: "complete-backlog" } })) {
  test("wrong " + label + " completion fences subsequent valid ACK", () => {
    const f = createBrowserSnapshotWindow(request);
    assert.throws(() => f.api.accept({ ...reply(), ...change }));
    assert.throws(() => f.api.accept(reply()), /closed/);
  });
}
test("missing, probe, lease and bare handoff cannot complete synchronization", () => {
  for (const v of [undefined, null, true, { ok: true }, request, { ...reply(), history: null }]) {
    const f = createBrowserSnapshotWindow(request);
    assert.throws(() => f.api.accept(v));
    assert.throws(() => f.api.accept(reply()), /closed/);
  }
});
test("copied or foreign completion is not an owned completion capability", () => {
  const f = createBrowserSnapshotWindow(request), g = createBrowserSnapshotWindow(request);
  const completion = f.api.accept(reply());
  assert.throws(() => g.consume(completion), /Unvalidated/);
  assert.throws(() => f.consume({ ...completion }), /Unvalidated/);
  assert.throws(() => f.consume(completion), /closed/);
});
test("duplicate ACK or a post-validation live callback fails closed before READY", () => {
  for (const act of ["ack", "live"]) {
    const f = createBrowserSnapshotWindow(request), completion = f.api.accept(reply());
    assert.throws(() => act === "ack" ? f.api.accept(reply()) : f.api.receiveLive(text(1)));
    assert.throws(() => f.consume(completion), /closed/);
  }
});
test("conflicting duplicate IDs never silently overwrite text, image or file", () => {
  for (const value of [text(1), image(1), file(1)]) {
    const f = createBrowserSnapshotWindow(request); f.api.receiveLive(value);
    assert.throws(() => f.api.accept(reply([{ ...value, username: "bob" }])), /Conflicting/);
    assert.throws(() => f.api.accept(reply()), /closed/);
  }
  const f = createBrowserSnapshotWindow(request); f.api.receiveLive(text(1));
  assert.throws(() => f.api.receiveLive({ ...text(1), message: "changed" }), /Conflicting/);
});
test("malformed row metadata, type, time, image and file URL fail closed", () => {
  for (const v of [null, {}, { ...text(1), id: 0 }, { ...text(1), id: 1.2 },
    { ...text(1), ts: NaN }, { ...text(1), ts: -1 }, { ...text(1), username: "" },
    { ...text(1), type: "system" }, { ...text(1), message: " " },
    { ...image(1), dataUrl: "data:image/svg+xml;base64,YQ==" },
    { ...file(1), url: "https://evil.invalid/blob" }, { ...file(1), url: "/uploads/../secret" },
    { ...file(1), size: -1 }, { ...file(1), name: "../a" }, { ...file(1), sha256: "bad" }]) {
    const f = createBrowserSnapshotWindow(request);
    assert.throws(() => f.api.accept(reply([v])));
    assert.throws(() => f.api.accept(reply()), /closed/);
  }
});
test("window rows must be unique ascending; timestamps do not order IDs", () => {
  for (const history of [[text(2), text(1)], [text(1), text(1)]]) {
    assert.throws(() => createBrowserSnapshotWindow(request).api.accept(reply(history)), /ascending/);
  }
  const f = createBrowserSnapshotWindow(request);
  assert.deepEqual(f.consume(f.api.accept(reply([{ ...text(1), ts: 2000 }, text(2)]))).history.map(r => r.id), [1, 2]);
});
test("count and UTF8 byte overflows fence late acknowledgements", () => {
  for (const limits of [{ liveCount: 1 }, { liveBytes: 1 }]) {
    const f = createBrowserSnapshotWindow(request, Date.now, limits);
    assert.throws(() => { f.api.receiveLive(text(1)); f.api.receiveLive(text(2)); }, /overflow/);
    assert.throws(() => f.api.accept(reply()), /closed/);
  }
  assert.throws(() => createBrowserSnapshotWindow(request, Date.now, { snapshotBytes: 10 }).api.accept(reply([text(1)])), /overflow/);
  const utf = { ...text(1), message: "🌍".repeat(50) };
  const charLength = JSON.stringify(utf).length + JSON.stringify(["alice"]).length;
  assert.throws(() => createBrowserSnapshotWindow(request, Date.now, { snapshotBytes: charLength }).api.accept(reply([utf])), /overflow/);
});
test("timeout, delayed timer and explicit disconnect cancel outstanding completion", () => {
  let now = 1000;
  const f = createBrowserSnapshotWindow(request, () => now, { timeoutMs: 100 });
  const completion = f.api.accept(reply()); now = 1100;
  assert.throws(() => f.consume(completion), /expired/);
  const g = createBrowserSnapshotWindow(request);
  g.cancel();
  assert.throws(() => g.api.accept(reply()), /closed/);
});
test("projected rows are immutable and unknown input fields never enter output", () => {
  const f = createBrowserSnapshotWindow(request), value = { ...text(1), token: "not-output" };
  f.api.receiveLive(value); value.message = "mutated";
  const result = f.consume(f.api.accept(reply()));
  assert.equal(result.history[0].message, "hello");
  assert.equal("token" in result.history[0], false);
});

function controller() {
  let key = 0, time = 1000;
  const c = createBrowserResumeController(() => "operation_key_" + (++key).toString().padStart(4, "0"), () => time);
  const physical = {}, lease = { ...request, username: "alice", token: "A".repeat(43), expiresAt: 100_000 };
  const ticket = c.accept(c.beginJoin("candy986", "alice", physical), physical, lease);
  const finish = (p: object, t: typeof ticket) => {
    const a = c.snapshot(p, t);
    return c.finishSync(p, t.generation, t, a.accept({ ...reply(), ...a.request }));
  };
  return { c, physical, lease, ticket, finish, time: (t: number) => { time = t; } };
}
test("controller no longer accepts bare matching ticket before snapshot delivery", () => {
  const f = controller();
  assert.throws(() => f.c.finishSync(f.physical, 1, f.ticket, undefined as never), /Unvalidated/);
  assert.equal(f.c.status().phase, "blocked");
  assert.throws(() => f.c.beginOperation("message", "a".repeat(64)), /synchronized/);
});
test("disconnect cancels saved adapter; copied ticket cannot obtain successor adapter", () => {
  const f = controller(), adapter = f.c.snapshot(f.physical, f.ticket);
  assert.throws(() => f.c.snapshot(f.physical, { ...f.ticket }), /Stale/);
  f.c.disconnect(f.physical);
  assert.throws(() => adapter.accept({ ...reply(), ...adapter.request }), /closed/);
  assert.throws(() => f.c.finishSync(f.physical, 1, f.ticket, {} as never), /Stale/);
});
test("snapshot timeout retains unresolved operations and cannot settle media receipts", () => {
  const f = controller(); f.finish(f.physical, f.ticket);
  for (const kind of ["message", "image", "file"] as const) f.c.dispatch(f.c.beginOperation(kind, "a".repeat(64)), f.physical);
  f.c.disconnect(f.physical);
  const next = {}, ticket = f.c.accept(f.c.beginResume(next), next, { ...f.lease, generation: 2 });
  const adapter = f.c.snapshot(next, ticket), completion = adapter.accept({ ...reply(), ...adapter.request });
  f.time(11_000);
  assert.throws(() => f.c.finishSync(next, 2, ticket, completion), /expired/);
  assert.deepEqual(f.c.status(), { phase: "blocked", pending: 3 });
  assert.throws(() => f.c.beginResume({}), /reconciliation/);
});
test("successful window completion also preserves all pending operation identities", () => {
  const f = controller(); f.finish(f.physical, f.ticket);
  const pending = f.c.beginOperation("file", "a".repeat(64)); f.c.dispatch(pending, f.physical);
  f.c.disconnect(f.physical);
  const next = {}, ticket = f.c.accept(f.c.beginResume(next), next, { ...f.lease, generation: 2 });
  f.finish(next, ticket);
  assert.equal(f.c.dispatch(pending, next).clientMessageId, pending.clientMessageId);
  assert.deepEqual(f.c.status(), { phase: "ready", pending: 1 });
});
