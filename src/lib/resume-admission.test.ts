import assert from "node:assert/strict";
import test from "node:test";
import { ResumeAdmission } from "./resume-admission";
import { ResumeBindings } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";
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

test("hung CAS times out without freeing capacity; exact retries share one permit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capacity = new ResumeCapacity(1), db = deferred<ResumeIdentity>();
  let calls = 0, prepared = 0;
  const limits = { capacity, timeoutMs: 100, onLateError: (e: unknown) => assert.fail(String(e)) };
  const make = (id: string) => new ResumeAdmission({ advanceGeneration: async () => { calls++; return db.promise; } },
    new ResumeBindings(10, () => 0), id, () => true, async () => { prepared++; return async () => {}; }, limits);
  const a = make("server-transport-1"), p = a.admit(request());
  assert.equal(a.admit(request()), p); await Promise.resolve();
  const overloaded = make("server-transport-2");
  assert.equal(await overloaded.admit(request()), null); assert.equal(calls, 1);
  t.mock.timers.tick(100); assert.equal(await p, null);
  assert.equal(capacity.acquire(), null); assert.equal(await a.admit(request()), null);
  let closed = false; const closing = a.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  db.resolve(identity()); await closing; assert.equal(prepared, 0);
  const permit = capacity.acquire(); assert.ok(permit); permit(); permit();
  assert.equal(await overloaded.admit(request()), null); // overload never reopens
  const successor = make("server-transport-3"); assert.ok(await successor.admit(request()));
  assert.equal(calls, 2); await successor.close();
});

test("hung preparation times out; late failing cleanup is reported and permit retained until settlement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capacity = new ResumeCapacity(1), entered = deferred<void>(), ready = deferred<void>();
  const cleanup = deferred<void>(), cleanupEntered = deferred<void>(), reported = deferred<unknown>();
  let reports = 0, cleanups = 0;
  const failure = Error("late exact lease failed");
  const a = new ResumeAdmission({ advanceGeneration: async () => identity() }, new ResumeBindings(10, () => 0),
    "server-transport-1", () => true, async () => {
      entered.resolve(); await ready.promise;
      return async () => { cleanups++; cleanupEntered.resolve(); await cleanup.promise; };
    }, { capacity, timeoutMs: 100, onLateError: e => { reports++; reported.resolve(e); } });
  const p = a.admit(request()); await entered.promise;
  t.mock.timers.tick(100); assert.equal(await p, null); assert.equal(capacity.acquire(), null);
  ready.resolve(); await cleanupEntered.promise; assert.equal(capacity.acquire(), null);
  cleanup.reject(failure); assert.equal(await reported.promise, failure); await a.close();
  assert.equal(cleanups, 1); assert.equal(reports, 1);
  const permit = capacity.acquire(); assert.ok(permit); permit();
});

test("disconnected pending work retains shared budget and never activates", async () => {
  const capacity = new ResumeCapacity(1), db = deferred<ResumeIdentity>();
  const a = new ResumeAdmission({ advanceGeneration: async () => db.promise }, new ResumeBindings(10, () => 0),
    "server-transport-1", () => true, async () => assert.fail("no preparation"),
    { capacity, timeoutMs: 1000, onLateError: e => assert.fail(String(e)) });
  const p = a.admit(request()); await Promise.resolve(); const closing = a.close();
  assert.equal(capacity.acquire(), null); db.resolve(identity());
  assert.equal(await p, null); await closing;
  const release = capacity.acquire(); assert.ok(release); release();
});

test("completed admission clears deadline and releases permit, not active authority", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capacity = new ResumeCapacity(1), bindings = new ResumeBindings(10, () => 0);
  const a = new ResumeAdmission({ advanceGeneration: async () => identity() }, bindings,
    "server-transport-1", () => true, async () => async () => {},
    { capacity, timeoutMs: 100, onLateError: e => assert.fail(String(e)) });
  const p = a.admit(request()), binding = await p; assert.ok(binding);
  t.mock.timers.tick(1000); assert.ok(bindings.isCurrent(binding)); assert.equal(a.admit(request()), p);
  const release = capacity.acquire(); assert.ok(release); release(); await a.close();
});

test("invalid limits reject construction before side effects", () => {
  for (const n of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new ResumeCapacity(n), /capacity/);
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(() => new ResumeAdmission({ advanceGeneration: async () => identity() }, new ResumeBindings(),
      "server-transport-1", () => true, async () => async () => {},
      { capacity: new ResumeCapacity(), timeoutMs, onLateError: () => {} }), /deadline/);
  }
});

test("monotonic deadline fences late CAS even before the timer callback runs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0, prepared = 0;
  t.mock.method(performance, "now", () => now);
  const db = deferred<ResumeIdentity>(), capacity = new ResumeCapacity(1);
  const a = new ResumeAdmission({ advanceGeneration: async () => db.promise }, new ResumeBindings(10, () => 0),
    "server-transport-1", () => true, async () => { prepared++; return async () => {}; },
    { capacity, timeoutMs: 100, onLateError: e => assert.fail(String(e)) });
  const p = a.admit(request()); await Promise.resolve();
  now = 100; db.resolve(identity()); // timers deliberately not advanced
  assert.equal(await p, null); assert.equal(prepared, 0);
  assert.equal(await a.admit(request()), null); await a.close();
  const release = capacity.acquire(); assert.ok(release); release();
});

test("late uncertain CAS rejection is observed once and never replayed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = deferred<ResumeIdentity>(), reported = deferred<unknown>(), capacity = new ResumeCapacity(1);
  let calls = 0, reports = 0;
  const failure = Error("commit acknowledgment lost");
  const a = new ResumeAdmission({ advanceGeneration: async () => { calls++; return db.promise; } },
    new ResumeBindings(10, () => 0), "server-transport-1", () => true,
    async () => assert.fail("must not prepare"), { capacity, timeoutMs: 100,
      onLateError: e => { reports++; reported.resolve(e); } });
  const p = a.admit(request()); await Promise.resolve(); t.mock.timers.tick(100);
  assert.equal(await p, null); db.reject(failure);
  assert.equal(await reported.promise, failure); await a.close();
  assert.equal(await a.admit(request()), null); assert.equal(calls, 1); assert.equal(reports, 1);
  const release = capacity.acquire(); assert.ok(release); release();
});

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
