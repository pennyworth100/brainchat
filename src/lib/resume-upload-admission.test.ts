import assert from "node:assert/strict";
import test from "node:test";
import { ResumeBindings } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";
import { ResumeUploadAdmissions } from "./resume-upload-admission";

async function fixture(capacity = new ResumeCapacity(2)) {
  let wall = 0, monotonic = 0;
  const bindings = new ResumeBindings(10, () => wall);
  const identity = (generation = 1, sessionId = "session-a") => ({
    sessionId, generation, roomId: "candy986", username: "Alice", authVersion: 1,
    issuedAt: new Date(0), expiresAt: new Date(1000),
  });
  const activate = (generation = 1, sessionId = "session-a", prepare = async () => {}) =>
    bindings.activate(identity(generation, sessionId), `transport-${sessionId}-${generation}`,
      prepare, () => true);
  const binding = (await activate())!;
  const uploads = new ResumeUploadAdmissions(bindings, capacity, 10, 100, () => monotonic);
  return { bindings, binding, uploads, activate,
    wall: (value: number) => { wall = value; }, time: (value: number) => { monotonic = value; } };
}

test("upload admits only live exact bindings and rejects copied/foreign grants", async () => {
  const f = await fixture();
  assert.equal(f.uploads.admit({ ...f.binding }), null);
  const grant = f.uploads.admit(f.binding)!;
  assert.ok(Object.isFrozen(grant));
  assert.equal(grant.binding, f.binding);
  assert.equal(f.uploads.acceptChunk({ ...grant }, 1), false);
  assert.equal(f.uploads.release({ ...grant }), false);
  assert.equal(new ResumeUploadAdmissions(f.bindings).isCurrent(grant), false);
  assert.equal(f.uploads.isCurrent(grant), true);
  assert.equal(f.uploads.release(grant), true);
  assert.equal(f.uploads.release(grant), false);
  assert.equal(f.uploads.acceptChunk(grant, 1), false);
});

test("admitted HTTP survives disconnect without restoring live socket authority", async () => {
  const f = await fixture(), grant = f.uploads.admit(f.binding)!;
  f.bindings.detach(f.binding);
  assert.equal(f.bindings.isCurrent(f.binding), false);
  assert.equal(f.uploads.acceptChunk(grant, 10), true);
  f.uploads.release(grant);
  assert.equal(f.uploads.admit(f.binding), null);
  assert.equal(f.bindings.captureUploadGeneration(f.binding), null);
});

test("pending then failed successor permanently fences admitted old generation", async () => {
  const f = await fixture(), grant = f.uploads.admit(f.binding)!;
  let fail!: (error: Error) => void;
  const pending = f.activate(2, "session-a", () => new Promise<void>((_, reject) => { fail = reject; }));
  const rejected = assert.rejects(pending, /prepare/);
  assert.equal(f.uploads.acceptChunk(grant, 1), false);
  fail(Error("prepare")); await rejected;
  assert.equal(f.uploads.isCurrent(grant), false);
  assert.equal(f.uploads.admit(f.binding), null);
  f.uploads.release(grant);
});

test("successor waits for unresolved old lease; stale release cannot remove new lease", async () => {
  const f = await fixture(), grant = f.uploads.admit(f.binding)!;
  const next = (await f.activate(2))!;
  assert.equal(f.uploads.isCurrent(grant), false);
  assert.equal(f.uploads.admit(next), null);
  f.uploads.release(grant);
  const fresh = f.uploads.admit(next)!;
  assert.ok(fresh);
  assert.equal(f.uploads.release(grant), false);
  f.bindings.detach(f.binding);
  assert.equal(f.uploads.isCurrent(fresh), true);
  assert.equal(f.uploads.admit(next), null);
  f.uploads.release(fresh);
});

test("cumulative bytes accept exact boundary; excess latches denial without refund", async () => {
  const f = await fixture(), grant = f.uploads.admit(f.binding)!;
  assert.equal(f.uploads.acceptChunk(grant, 4), true);
  assert.equal(f.uploads.acceptChunk(grant, 6), true);
  assert.equal(f.uploads.acceptChunk(grant, 1), false);
  assert.equal(f.uploads.acceptChunk(grant, 0), false);
  assert.equal(f.uploads.admit(f.binding), null);
  f.uploads.release(grant);
});

test("invalid chunk counts fail closed before accounting", async () => {
  for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const f = await fixture(), grant = f.uploads.admit(f.binding)!;
    assert.equal(f.uploads.acceptChunk(grant, size), false);
    assert.equal(f.uploads.acceptChunk(grant, 1), false);
    f.uploads.release(grant);
  }
});

test("deadline does not release global capacity or claim cancellation", async () => {
  const capacity = new ResumeCapacity(1), f = await fixture(capacity), g = await fixture(capacity);
  const grant = f.uploads.admit(f.binding)!;
  assert.equal(g.uploads.admit(g.binding), null);
  f.time(99); assert.equal(f.uploads.isCurrent(grant), true);
  f.time(100); assert.equal(f.uploads.isCurrent(grant), false);
  assert.equal(g.uploads.admit(g.binding), null);
  f.time(0); assert.equal(f.uploads.isCurrent(grant), false);
  f.uploads.release(grant);
  const fresh = g.uploads.admit(g.binding)!;
  assert.ok(fresh); g.uploads.release(fresh);
});

test("absolute session expiry fences disconnected grant even without timer delivery", async () => {
  const f = await fixture(), grant = f.uploads.admit(f.binding)!;
  f.bindings.detach(f.binding); f.wall(1000);
  assert.equal(f.uploads.isCurrent(grant), false);
  f.bindings.sweep();
  assert.equal(f.uploads.acceptChunk(grant, 1), false);
  f.uploads.release(grant);
});

test("upload limits cannot exceed server hard bounds", () => {
  const bindings = new ResumeBindings();
  for (const bytes of [0, -1, 0.5, Infinity, 100 * 1024 * 1024 + 1]) {
    assert.throws(() => new ResumeUploadAdmissions(bindings, undefined, bytes), /limits/);
  }
  for (const ms of [0, -1, 0.5, Infinity, 120_001]) {
    assert.throws(() => new ResumeUploadAdmissions(bindings, undefined, 10, ms), /limits/);
  }
});
