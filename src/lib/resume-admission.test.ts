import assert from "node:assert/strict";
import test from "node:test";
import { ResumeAdmission } from "./resume-admission";
import { ResumeBindings } from "./resume-bindings";
import type { ResumeIdentity } from "./resume-store";

const request = () => ({ credential: { sessionId: "session-a", roomId: "candy986",
  token: Buffer.alloc(32, 1).toString("base64url") }, expectedGeneration: 0, operationId: "operation-00000001" });
const identity = (generation = 1): ResumeIdentity => ({ sessionId: "session-a", roomId: "candy986",
  username: "Alice", authVersion: 1, generation, issuedAt: new Date(0), expiresAt: new Date(1000) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("pre-CAS admission reserves one operation, coalesces exact retry and snapshots input", async () => {
  const db = deferred<ResumeIdentity | null>(), bindings = new ResumeBindings(10, () => 0);
  let calls = 0, prepared = 0;
  const a = new ResumeAdmission({ advanceGeneration: async (c) => {
    calls++; assert.equal(c.roomId, "candy986"); return db.promise;
  } }, bindings, "server-transport-1", () => true, async () => { prepared++; return async () => {}; });
  const original = request(), p = a.admit(original);
  original.credential.roomId = "wrong123";
  assert.equal(a.admit(request()), p);
  assert.equal(await a.admit({ ...request(), operationId: "operation-00000002" }), null);
  assert.equal(await a.admit({ ...request(), credential: { ...request().credential, sessionId: "session-b" } }), null);
  assert.equal(calls, 1);
  db.resolve(identity()); const b = await p;
  assert.ok(b && bindings.isCurrent(b)); assert.equal(prepared, 1);
  assert.equal(await a.admit(request()), b); assert.equal(calls, 1);
  await a.close(); assert.equal(bindings.isCurrent(b), false);
  assert.equal(await a.admit(request()), null);
});

test("disconnect before dispatch prevents DB; disconnect during CAS prevents preparation", async () => {
  for (const dispatched of [false, true]) {
    const db = deferred<ResumeIdentity | null>(); let calls = 0, prepared = 0;
    const a = new ResumeAdmission({ advanceGeneration: async () => { calls++; return db.promise; } },
      new ResumeBindings(10, () => 0), "server-transport-1", () => true,
      async () => { prepared++; return async () => {}; });
    const p = a.admit(request());
    if (dispatched) await Promise.resolve();
    const closing = a.close(); db.resolve(identity());
    assert.equal(await p, null); await closing;
    assert.equal(calls, Number(dispatched)); assert.equal(prepared, 0);
  }
});

test("disconnect during preparation releases exact lease once without activation", async () => {
  const ready = deferred<void>(), entered = deferred<void>(); let cleanups = 0;
  const bindings = new ResumeBindings(10, () => 0);
  const a = new ResumeAdmission({ advanceGeneration: async () => identity() }, bindings,
    "server-transport-1", () => true, async () => {
      entered.resolve(); await ready.promise; return async () => { cleanups++; };
    });
  const p = a.admit(request()); await entered.promise;
  const closing = a.close(); ready.resolve();
  assert.equal(await p, null); await closing; await a.close(); assert.equal(cleanups, 1);
});

test("late preparation success or failure does not erase successor on another connection", async () => {
  for (const fails of [false, true]) {
    const ready = deferred<void>(), entered = deferred<void>(); let cleanups = 0;
    const bindings = new ResumeBindings(10, () => 0);
    const a = new ResumeAdmission({ advanceGeneration: async () => identity() }, bindings,
      "server-transport-1", () => true, async () => {
        entered.resolve(); await ready.promise;
        if (fails) throw Error("partial work cleaned by preparer");
        return async () => { cleanups++; };
      });
    const p = a.admit(request()); await entered.promise;
    const b = new ResumeAdmission({ advanceGeneration: async () => identity(2) }, bindings,
      "server-transport-2", () => true, async () => async () => {});
    const successor = await b.admit({ ...request(), expectedGeneration: 1 });
    assert.ok(successor && bindings.isCurrent(successor));
    const rejected = fails ? assert.rejects(p, /partial work/) : undefined;
    ready.resolve(); if (rejected) await rejected; else assert.equal(await p, null);
    await a.close(); assert.ok(bindings.isCurrent(successor));
    assert.equal(cleanups, fails ? 0 : 1); await b.close();
  }
});

test("uncertain CAS and rejected CAS are never replayed on same incarnation", async () => {
  for (const uncertain of [false, true]) {
    let calls = 0;
    const a = new ResumeAdmission({ advanceGeneration: async () => {
      calls++; if (uncertain) throw Error("lost DB acknowledgment"); return null;
    } }, new ResumeBindings(), "server-transport-1", () => true, async () => {
      assert.fail("must not prepare");
    });
    const p = a.admit(request());
    if (uncertain) await assert.rejects(p, /lost DB/); else assert.equal(await p, null);
    assert.equal(a.admit(request()), p);
    if (uncertain) await assert.rejects(a.admit(request()), /lost DB/);
    assert.equal(await a.admit({ ...request(), operationId: "operation-00000002" }), null);
    await a.close(); assert.equal(calls, 1);
  }
});

test("stale active ACK and uncertain connection never grant authority", async () => {
  const bindings = new ResumeBindings(10, () => 0); let connected = true;
  const a = new ResumeAdmission({ advanceGeneration: async () => identity() }, bindings,
    "server-transport-1", () => { if (!connected) throw Error("unknown"); return true; },
    async () => async () => {});
  const old = (await a.admit(request()))!; assert.ok(bindings.isCurrent(old));
  const next = (await bindings.activate(identity(2), "server-transport-2", async () => {}, () => true))!;
  assert.equal(await a.admit(request()), null); connected = false;
  assert.equal(await a.admit(request()), null); await a.close(); assert.ok(bindings.isCurrent(next));
});
