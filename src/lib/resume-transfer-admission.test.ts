import assert from "node:assert/strict";
import test from "node:test";
import { ResumeAdmission } from "./resume-admission";
import { ResumeBindings } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";
import type { ResumeIdentity } from "./resume-store";

const request = () => ({ credential: { sessionId: "session-a", roomId: "candy986",
  token: Buffer.alloc(32, 1).toString("base64url") }, expectedGeneration: 0,
  originalOperationId: "original_operation_1", transferOperationId: "transfer_operation_1" });
const identity = (generation = 2): ResumeIdentity => ({ sessionId: "session-a", roomId: "candy986",
  username: "Alice", authVersion: 1, generation, issuedAt: new Date(0), expiresAt: new Date(1000) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const noCas = async () => assert.fail("transfer must never invoke fresh CAS");

test("transfer reserves same admission flight, snapshots provenance and finalizes only exact +2", async () => {
  const gate = deferred<ResumeIdentity | null>(), bindings = new ResumeBindings(10, () => 0);
  let calls = 0, preparations = 0, finalizations = 0, cleanups = 0;
  const a = new ResumeAdmission({ advanceGeneration: noCas,
    transferAppliedGeneration: async (credential, expected, original, transfer, transport) => {
      calls++; assert.deepEqual(credential, request().credential); assert.equal(expected, 0);
      assert.equal(original, request().originalOperationId);
      assert.equal(transfer, request().transferOperationId); assert.equal(transport, "physical_server_1");
      return gate.promise;
    } }, bindings, "physical_server_1", () => true,
    async () => { preparations++; return async () => { cleanups++; }; }, undefined,
    async (binding, live) => { finalizations++; assert.equal(binding.generation, 2); return live(); });
  const input = request(), flight = a.transfer(input);
  input.originalOperationId = "mutated_original_1"; input.credential.roomId = "other123";
  assert.equal(a.transfer(request()), flight);
  assert.equal(await a.admit({ ...request(), operationId: request().originalOperationId }), null);
  assert.equal(await a.transfer({ ...request(), transferOperationId: "different_transfer_1" }), null);
  gate.resolve(identity()); const binding = await flight; assert.ok(binding && bindings.isCurrent(binding));
  assert.equal(calls, 1); assert.equal(preparations, 1); assert.equal(finalizations, 1);
  assert.equal(a.transfer(request()), flight);
  await a.close(); assert.equal(cleanups, 1); assert.equal(bindings.isCurrent(binding), false);
});

test("invalid or unavailable transfer never downgrades and does not reserve fresh CAS", async () => {
  const store = { advanceGeneration: noCas, transferAppliedGeneration: noCas };
  const make = (s = store) => new ResumeAdmission(s, new ResumeBindings(), "physical_server_1",
    () => true, async () => assert.fail("no preparation"));
  const a = make();
  for (const transferOperationId of [undefined, null, "", "short", request().originalOperationId]) {
    assert.equal(await a.transfer({ ...request(), transferOperationId } as never), null);
  }
  assert.equal(await a.transfer({ ...request(), originalOperationId: undefined } as never), null);
  const unavailable = new ResumeAdmission({ advanceGeneration: noCas }, new ResumeBindings(),
    "physical_server_1", () => true, async () => assert.fail("no preparation"));
  assert.equal(await unavailable.transfer(request()), null); await a.close(); await unavailable.close();
});

test("transfer rejects +1, +3, wrong session/room, null and uncertain persistence without replay", async () => {
  for (const value of [identity(1), identity(3), { ...identity(), sessionId: "foreign" },
    { ...identity(), roomId: "other123" }, null, Error("uncertain transfer")]) {
    let calls = 0;
    const a = new ResumeAdmission({ advanceGeneration: noCas,
      transferAppliedGeneration: async () => { calls++; if (value instanceof Error) throw value; return value; } },
    new ResumeBindings(10, () => 0), "physical_server_1", () => true,
    async () => assert.fail("must not prepare"));
    const flight = a.transfer(request());
    if (value instanceof Error) await assert.rejects(flight, /uncertain/); else assert.equal(await flight, null);
    assert.equal(a.transfer(request()), flight);
    assert.equal(await a.admit({ ...request(), operationId: "fresh_operation_1" }), null);
    assert.equal(calls, 1); await a.close();
  }
});

test("timed-out transfer retains capacity until actual DB settlement and cannot activate late", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred<ResumeIdentity>(), capacity = new ResumeCapacity(1);
  const a = new ResumeAdmission({ advanceGeneration: noCas, transferAppliedGeneration: async () => gate.promise },
    new ResumeBindings(10, () => 0), "physical_server_1", () => true,
    async () => assert.fail("late transfer preparation"),
    { capacity, timeoutMs: 100, onLateError: e => assert.fail(String(e)) });
  const flight = a.transfer(request()); await Promise.resolve(); t.mock.timers.tick(100);
  assert.equal(await flight, null); assert.equal(capacity.acquire(), null);
  const closing = a.close(); gate.resolve(identity()); await closing;
  const release = capacity.acquire(); assert.ok(release); release();
  assert.equal(await a.transfer(request()), null);
});

test("transfer shares original finalizer deadline and exact cleanup after disconnect in preparation", async () => {
  const entered = deferred<void>(), release = deferred<void>(), capacity = new ResumeCapacity(1);
  let cleanups = 0, finalized = 0;
  const a = new ResumeAdmission({ advanceGeneration: noCas, transferAppliedGeneration: async () => identity() },
    new ResumeBindings(10, () => 0), "physical_server_1", () => true,
    async () => { entered.resolve(); await release.promise; return async () => { cleanups++; }; },
    { capacity, timeoutMs: 1000, onLateError: e => assert.fail(String(e)) },
    async () => { finalized++; return true; });
  const flight = a.transfer(request()); await entered.promise;
  const closing = a.close(); assert.equal(capacity.acquire(), null);
  release.resolve(); assert.equal(await flight, null); await closing;
  assert.equal(cleanups, 1); assert.equal(finalized, 0);
  const permit = capacity.acquire(); assert.ok(permit); permit();
});
