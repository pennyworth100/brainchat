import test from "node:test";
import assert from "node:assert/strict";
import { advanceLeaseCheckpoint as advance, browserLeaseJournal } from "./browser-lease-journal";
import type { BrowserLease } from "./browser-resume-controller";
const id = () => crypto.randomUUID();
const now = 1000;
const lease: BrowserLease = { roomId: "proof123", username: "Owner", sessionId: id(),
  token: "A".repeat(43), generation: 1, expiresAt: 100000 };
const joining = () => advance(undefined, null, { kind: "join", roomId: lease.roomId,
  username: lease.username, operationId: id() }, id(), now);
const settled = () => { const row = joining(); return advance(row, row.revision, { kind: "accept", lease }, id(), now); };
test("join provenance exists before credentials, lost join ACK cannot resume or overwrite", () => {
  const row = joining();
  assert.equal(row.lease, null);
  for (const change of [{ kind: "resume", operationId: id() }, { kind: "transfer", operationId: id() },
    { kind: "join", roomId: lease.roomId, username: lease.username, operationId: id() }] as const) {
    assert.throws(() => advance(row, row.revision, change, id(), now));
  }
});
test("acknowledgement must match exact journal revision and original owner", () => {
  const row = joining();
  assert.throws(() => advance(row, id(), { kind: "accept", lease }, id(), now), /ownership/);
  for (const changed of [{ roomId: "other123" }, { username: "Other" }, { generation: 2 },
    { token: "bad" }, { sessionId: "bad" }, { expiresAt: now }]) {
    assert.throws(() => advance(row, row.revision, { kind: "accept", lease: { ...lease, ...changed } }, id(), now));
  }
});
test("crash after resume intent retains exact original CAS and forbids blind retry", () => {
  const ready = settled(), op = id();
  const row = advance(ready, ready.revision, { kind: "resume", operationId: op }, id(), now);
  const loaded = structuredClone(row);
  assert.equal(loaded.attempt?.operationId, op);
  assert.equal(loaded.lease?.sessionId, lease.sessionId);
  assert.throws(() => advance(loaded, loaded.revision, { kind: "resume", operationId: id() }, id(), now));
  const transferred = advance(loaded, loaded.revision, { kind: "transfer", operationId: id() }, id(), now);
  assert.equal(transferred.attempt?.originalOperationId, op);
  assert.throws(() => advance(transferred, transferred.revision, { kind: "transfer", operationId: id() }, id(), now));
  assert.throws(() => advance(transferred, transferred.revision, { kind: "accept", lease: { ...lease, generation: 2 } }, id(), now));
  const final = advance(transferred, transferred.revision, { kind: "accept", lease: { ...lease, generation: 3 } }, id(), now);
  assert.equal(final.lease?.generation, 3);
});
test("resume cannot replace token/session, extend expiry or accept stale generation", () => {
  const ready = settled();
  const row = advance(ready, ready.revision, { kind: "resume", operationId: id() }, id(), now);
  for (const change of [{ token: "B".repeat(42) + "A" }, { sessionId: id() },
    { expiresAt: lease.expiresAt + 1 }, { generation: 1 }, { generation: 3 }]) {
    assert.throws(() => advance(row, row.revision,
      { kind: "accept", lease: { ...lease, generation: 2, ...change } }, id(), now));
  }
  assert.equal(advance(row, row.revision, { kind: "accept", lease: { ...lease, generation: 2 } }, id(), now).lease?.generation, 2);
});
test("expiry fails closed without changing saved authority or unresolved provenance", () => {
  const ready = settled(), before = structuredClone(ready);
  assert.throws(() => advance(ready, ready.revision, { kind: "resume", operationId: id() }, id(), lease.expiresAt), /expired/);
  assert.deepEqual(ready, before);
});
test("foreign revision, malformed disk provenance and generation exhaustion fail closed", () => {
  const ready = settled();
  assert.throws(() => advance(ready, null, { kind: "resume", operationId: id() }, id(), now));
  assert.throws(() => advance({ ...ready, attempt: { kind: "resume", operationId: id(), expectedGeneration: 2 } },
    ready.revision, { kind: "transfer", operationId: id() }, id(), now), /provenance/);
  assert.throws(() => advance({ ...ready, lease: { ...lease, generation: 2_147_483_647 } },
    ready.revision, { kind: "resume", operationId: id() }, id(), now));
});
test("unavailable IndexedDB cannot return a transport-admission checkpoint", async () => {
  const denied = { open() { throw Error("Denied"); } } as unknown as IDBFactory;
  await assert.rejects(browserLeaseJournal("scope", { expectedRevision: null,
    change: { kind: "join", roomId: lease.roomId, username: lease.username, operationId: id() } }, denied), /Denied/);
});
