import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserPublicationSnapshot } from "./browser-publication-snapshot";
import { createBrowserResumeController } from "./browser-resume-controller";
const request = { roomId: "candy986", sessionId: "11111111-1111-4111-8111-111111111111", generation: 1, requestId: "publication_request_001" };
const row = (id: number) => ({ id, type: "message", username: "alice", ts: 1000, message: "hello" });
const reply = (history: unknown[] = []) => ({ ...request, cut: "full-bounded-statement",
  deliveryTry: "22222222-2222-4222-8222-222222222222", history, users: ["alice", "alice"] });

const confirmation = (identity: typeof request, deliveryTry = reply().deliveryTry) =>
  ({ ...identity, deliveryTry, cut: "full-bounded-statement", settled: true });
function stagedFixture(history: unknown[] = []) {
  const f = fixture();
  const completion = f.adapter.accept({ ...reply(history), ...f.adapter.request });
  const staged = f.c.stagePublication(f.physical, f.ticket, completion);
  return { ...f, staged, confirmation: confirmation(f.adapter.request) };
}
for (const history of [[], [row(1), row(3)]]) {
  test("exact full/empty confirmation returns retained cut but never READY", () => {
    const f = stagedFixture(history);
    const ack = f.c.publicationAck(f.physical, f.ticket);
    assert.deepEqual(ack, { ...f.adapter.request, ...f.staged.ack });
    assert.ok(Object.isFrozen(ack) && Object.isFrozen(ack.ids));
    // Lost confirmation: retry the SAME request/attempt/IDs, no fresh cut.
    assert.deepEqual(f.c.publicationAck(f.physical, f.ticket), ack);
    assert.equal(f.c.confirmPublication(f.physical, f.ticket, f.confirmation), f.staged.snapshot);
    assert.equal(f.c.status().phase, "syncing");
    assert.throws(() => f.c.beginOperation("message", "a".repeat(64)), /synchronized/);
    assert.throws(() => f.c.uploadAuthority(f.physical, "socket"), /synchronized/);
    assert.throws(() => f.c.publicationAck(f.physical, f.ticket), /Missing/);
  });
}
for (const change of [{ roomId: "apple123" }, { sessionId: "33333333-3333-4333-8333-333333333333" },
  { generation: 2 }, { requestId: "another_request_0001" },
  { deliveryTry: "33333333-3333-4333-8333-333333333333" },
  { cut: "newest100" }, { settled: false }, { settled: "true" }, { settled: undefined }]) {
  test("confirmation mismatch fails closed: " + JSON.stringify(change), () => {
    const f = stagedFixture([row(1)]);
    assert.throws(() => f.c.confirmPublication(f.physical, f.ticket,
      { ...f.confirmation, ...change }), /Invalid/);
    assert.equal(f.c.status().phase, "blocked");
    assert.throws(() => f.c.confirmPublication(f.physical, f.ticket, f.confirmation), /Stale/);
  });
}
for (const value of [null, true, [], {}, "settled"]) {
  test("confirmation rejects malformed envelope: " + JSON.stringify(value), () => {
    const f = stagedFixture();
    assert.throws(() => f.c.confirmPublication(f.physical, f.ticket, value), /Invalid/);
    assert.equal(f.c.status().phase, "blocked");
  });
}
test("confirmation/ACK cannot precede validated staging", () => {
  const f = fixture();
  assert.throws(() => f.c.confirmPublication(f.physical, f.ticket,
    confirmation(f.adapter.request)), /Invalid/);
  assert.equal(f.c.status().phase, "blocked");
  const g = fixture();
  assert.throws(() => g.c.publicationAck(g.physical, g.ticket), /not staged/);
});
test("copied tickets and foreign physical connections do not poison the retained current cut", () => {
  const f = stagedFixture();
  for (const [physical, ticket] of [[{}, f.ticket], [f.physical, { ...f.ticket }]] as const) {
    assert.throws(() => f.c.confirmPublication(physical, ticket, f.confirmation), /Stale/);
    assert.throws(() => f.c.publicationAck(physical, ticket), /Stale/);
  }
  assert.equal(f.c.confirmPublication(f.physical, f.ticket, f.confirmation), f.staged.snapshot);
});
test("disconnect and resumed generation fence an old staged confirmation and retry", () => {
  const f = stagedFixture();
  f.c.disconnect(f.physical);
  assert.throws(() => f.c.publicationAck(f.physical, f.ticket), /Stale/);
  assert.throws(() => f.c.confirmPublication(f.physical, f.ticket, f.confirmation), /Stale/);
  const next = {}, ticket = f.c.accept(f.c.beginResume(next), next, { ...f.lease, generation: 2 });
  const adapter = f.c.publicationSnapshot(next, ticket);
  const staged = f.c.stagePublication(next, ticket, adapter.accept({ ...reply(), ...adapter.request }));
  assert.throws(() => f.c.confirmPublication(f.physical, f.ticket, f.confirmation), /Stale/);
  assert.equal(f.c.confirmPublication(next, ticket, confirmation(adapter.request)), staged.snapshot);
});
test("same physical rejoin rejects old request; expiry fences current confirmation", () => {
  const f = stagedFixture();
  f.c.beginJoin("candy986", "alice", f.physical);
  assert.throws(() => f.c.confirmPublication(f.physical, f.ticket, f.confirmation), /Stale/);
  const g = stagedFixture();
  g.expire();
  assert.throws(() => g.c.confirmPublication(g.physical, g.ticket, g.confirmation), /expired/);
  assert.equal(g.c.status().phase, "blocked");
});
test("ACK retries never extend the original deadline, even for empty cut", () => {
  let time = 1000;
  const f = createBrowserPublicationSnapshot(request, () => time);
  f.consume(f.api.accept(reply()));
  time = 4999;
  assert.deepEqual(f.retryAck().ids, []);
  time = 5000;
  assert.throws(() => f.confirm(confirmation(request)), /expired/);
  assert.throws(() => f.retryAck(), /closed/);
  const g = createBrowserPublicationSnapshot(request, () => time);
  g.consume(g.api.accept(reply()));
  time = 9000;
  assert.throws(() => g.retryAck(), /expired/);
});
test("retained request/cut ignores mutations of caller input and confirmation is one-shot", () => {
  const identity = { ...request }, envelope = reply([row(1)]);
  const f = createBrowserPublicationSnapshot(identity);
  const completion = f.api.accept(envelope);
  f.consume(completion);
  identity.requestId = "mutated_request_0001";
  envelope.deliveryTry = "33333333-3333-4333-8333-333333333333";
  envelope.history.splice(0);
  assert.deepEqual(f.retryAck(), { ...request, deliveryTry: reply().deliveryTry, ids: [1] });
  assert.equal(f.confirm(confirmation(request)), completion);
  assert.throws(() => f.confirm(confirmation(request)), /closed/);
  assert.throws(() => f.retryAck(), /closed/);
});

test("full cut stages 256 unique rows without newest100 truncation and owns exact immutable ACK set", () => {
  const f = createBrowserPublicationSnapshot(request);
  const result = f.consume(f.api.accept(reply(Array.from({ length: 256 }, (_, i) => row(i + 1)))));
  assert.equal(result.snapshot.history.length, 256);
  assert.deepEqual(result.ack.ids, result.snapshot.history.map(r => r.id));
  assert.deepEqual(result.snapshot.users, ["alice"]);
  assert.ok(Object.isFrozen(result.ack.ids) && Object.isFrozen(result.snapshot.history[0]));
  assert.throws(() => f.consume(result.snapshot), /closed/);
});
test("text image file projection is strict, strips unknown fields and retains file digest", () => {
  const f = createBrowserPublicationSnapshot(request);
  const result = f.consume(f.api.accept(reply([row(1),
    { id: 2, type: "image", username: "alice", ts: 1000, dataUrl: "data:image/png;base64,YQ==" },
    { id: 3, type: "file", username: "alice", ts: 1000, url: "/uploads/fixture/blob",
      name: "a.txt", size: 1, mime: "text/plain", sha256: "a".repeat(64), secret: "strip" }])));
  assert.equal(result.snapshot.history[2].sha256, "a".repeat(64));
  assert.equal("secret" in result.snapshot.history[2], false);
});
for (const change of [{ requestId: "wrong_request_001" }, { roomId: "apple123" },
  { sessionId: "33333333-3333-4333-8333-333333333333" }, { generation: 2 },
  { deliveryTry: "bad" }, { cut: "newest100" }, { window: "newest-100-id-ascending" },
  { history: Array.from({ length: 257 }, (_, i) => row(i + 1)) },
  { history: [row(2), row(1)] }, { history: [row(1), { ...row(1), message: "conflict" }] },
  { history: [{ ...row(1), type: "system" }] }, { users: [""] }]) {
  test("invalid full cut fails closed: " + Object.keys(change)[0] + JSON.stringify(change).slice(0, 70), () => {
    const f = createBrowserPublicationSnapshot(request);
    assert.throws(() => f.api.accept({ ...reply(), ...change }));
    assert.throws(() => f.api.accept(reply()), /closed/);
  });
}
test("normalized UTF8 bytes are bounded, including valid large inline images", () => {
  const f = createBrowserPublicationSnapshot(request);
  const image = { id: 1, type: "image", username: "alice", ts: 1000,
    dataUrl: "data:image/png;base64," + "YWFh".repeat(300_000) };
  assert.throws(() => f.api.accept(reply([image])), /byte capacity/);
  assert.throws(() => f.api.accept(reply()), /closed/);
});
test("copied, foreign, duplicate and delayed completions cannot yield ACK capability", () => {
  const f = createBrowserPublicationSnapshot(request), g = createBrowserPublicationSnapshot(request);
  const value = f.api.accept(reply());
  assert.throws(() => g.consume(value), /Unvalidated/);
  assert.throws(() => f.consume({ ...value }), /Unvalidated/);
  let time = 1000;
  const h = createBrowserPublicationSnapshot(request, () => time), validated = h.api.accept(reply());
  time = 5000;
  assert.throws(() => h.consume(validated), /expired/);
  const j = createBrowserPublicationSnapshot(request), completed = j.api.accept(reply());
  assert.throws(() => j.api.accept(reply()));
  assert.throws(() => j.consume(completed), /closed/);
});
function fixture() {
  let key = 0, time = 1000;
  const c = createBrowserResumeController(() => "operation_key_" + (++key).toString().padStart(4, "0"),
    () => time, 32, "publication-cut");
  const physical = {}, lease = { ...request, username: "alice", token: "A".repeat(43), expiresAt: 10000 };
  const ticket = c.accept(c.beginJoin("candy986", "alice", physical), physical, lease);
  const adapter = c.publicationSnapshot(physical, ticket);
  return { c, physical, lease, ticket, adapter, expire: () => { time = 10000; } };
}
for (const history of [[], [row(1)]]) test("full-cut staging, including empty cut, NEVER grants READY or legacy downgrade", () => {
  const { c, physical, ticket, adapter } = fixture();
  assert.throws(() => c.snapshot(physical, ticket), /Stale/);
  const completion = adapter.accept({ ...reply(history), ...adapter.request });
  const staged = c.stagePublication(physical, ticket, completion);
  assert.deepEqual(staged.ack.ids, history.map(r => r.id));
  assert.equal(c.status().phase, "syncing");
  assert.throws(() => c.beginOperation("message", "a".repeat(64)), /synchronized/);
  assert.throws(() => c.uploadAuthority(physical, "socket"), /synchronized/);
  assert.throws(() => c.finishSync(physical, 1, ticket, completion as never), /Missing/);
  assert.equal(c.status().phase, "blocked");
});
test("physical loss cancels old adapter and successor cannot consume old request", () => {
  const { c, physical, ticket, adapter, lease } = fixture();
  const completion = adapter.accept({ ...reply(), ...adapter.request });
  c.disconnect(physical);
  assert.throws(() => adapter.accept({ ...reply(), ...adapter.request }), /closed/);
  const next = {}, attempt = c.beginResume(next);
  const sync = c.accept(attempt, next, { ...lease, generation: 2 });
  assert.throws(() => c.stagePublication(physical, ticket, completion), /Stale/);
  assert.throws(() => c.stagePublication(next, { ...sync }, completion), /Stale/);
  assert.equal(c.status().phase, "syncing");
  const a = c.publicationSnapshot(next, sync);
  c.stagePublication(next, sync, a.accept({ ...reply(), ...a.request }));
  assert.equal(c.status().phase, "syncing");
});
test("expiry and explicit rejoin fence staged full-cut capability", () => {
  const f = fixture(), completion = f.adapter.accept({ ...reply(), ...f.adapter.request });
  f.expire();
  assert.throws(() => f.c.stagePublication(f.physical, f.ticket, completion), /expired/);
  const g = fixture(), old = g.adapter.accept({ ...reply(), ...g.adapter.request });
  g.c.beginJoin("candy986", "alice", g.physical);
  assert.throws(() => g.c.stagePublication(g.physical, g.ticket, old), /Stale/);
  assert.equal(g.c.status().phase, "joining");
});
