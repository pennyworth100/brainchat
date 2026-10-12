import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerLifecycle } from "./server-lifecycle";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
test("permanent admission fence retains handlers, rejected owners and expiry before activity", async () => {
  const sql = deferred(), cleanup = deferred(), expiry = deferred();
  const order: string[] = [];
  const lifecycle = new ServerLifecycle({ stopAndSettle: () => { order.push("expiry-stop"); return expiry.promise; } },
    { settle: async () => { order.push("activity"); } });
  const owner = { close: () => cleanup.promise.then(() => { throw Error("cleanup failure"); }) };
  lifecycle.own(owner);
  const work = lifecycle.run(async () => { await sql.promise; order.push("late-activity-enqueue"); });
  let finished = false;
  const stop = lifecycle.stopAndSettle(); void stop.then(() => { finished = true; });
  assert.equal(lifecycle.stopAndSettle(), stop);
  assert.equal(lifecycle.run(() => assert.fail("closed handler executed")), null);
  cleanup.resolve(); expiry.resolve();
  await new Promise(r => setImmediate(r));
  assert.equal(finished, false); assert.equal(lifecycle.retainedOwners, 0);
  sql.resolve(); await work;
  const report = await stop as { ownerFailures: number };
  assert.equal(report.ownerFailures, 1);
  assert.deepEqual(order, ["expiry-stop", "late-activity-enqueue", "activity"]);
});
test("disconnected owner remains enumerable until actual cleanup; no permanent registry leak", async () => {
  const cleanup = deferred();
  const lifecycle = new ServerLifecycle({ stopAndSettle: async () => {} }, { settle: async () => {} });
  let calls = 0;
  const owner = { close: () => { calls++; return cleanup.promise; } };
  lifecycle.own(owner);
  const closed = lifecycle.closeOwner(owner);
  assert.equal(lifecycle.closeOwner(owner), closed);
  const stop = lifecycle.stopAndSettle();
  assert.equal(lifecycle.retainedOwners, 1); assert.equal(calls, 1);
  cleanup.resolve(); await stop;
  assert.equal(lifecycle.retainedOwners, 0);
});
test("synchronous handler failure is retained and reported without early settlement", async () => {
  const lifecycle = new ServerLifecycle({ stopAndSettle: async () => {} }, { settle: async () => {} });
  const error = Error("original");
  const work = lifecycle.run(() => { throw error; })!;
  const stop = lifecycle.stopAndSettle();
  await assert.rejects(work, e => e === error);
  assert.equal((await stop as { handlerFailures: number }).handlerFailures, 1);
});
