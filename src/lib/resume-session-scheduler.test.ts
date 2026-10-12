import assert from "node:assert/strict";
import { test } from "node:test";
import { ResumeSessionScheduler } from "./resume-session-scheduler";
import { ServerLifecycle } from "./server-lifecycle";
const flush = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fakeClock() {
  let current: (() => void) | undefined;
  const delays: number[] = [];
  return { delays, pending: () => !!current,
    tick() { assert.ok(current); const f = current; current = undefined; f(); },
    time: {
      set(f: () => void, delay: number) {
        assert.equal(current, undefined, "must never overlap timers");
        current = f; delays.push(delay); return { unref() {} };
      },
      clear() { current = undefined; },
    },
  };
}
test("explicit start; one batch and idle gap after actual settlement, not a blind interval", async () => {
  const c = fakeClock(), batch = deferred<{sessions: number; receipts: number}>();
  let calls = 0, closed = false;
  const s = new ResumeSessionScheduler({
    runOnce: () => { calls++; return batch.promise; },
    stopAndSettle: async () => { closed = true; },
  }, c.time);
  assert.equal(c.pending(), false);
  s.start(); s.start(); assert.deepEqual(c.delays, [1000]);
  c.tick(); await flush(); assert.equal(calls, 1); assert.equal(c.pending(), false);
  batch.resolve({sessions: 1, receipts: 100}); await flush();
  assert.deepEqual(c.delays, [1000, 1000]);
  assert.deepEqual(await s.stopAndSettle(), {completedRuns: 1, failedRuns: 0, sessions: 1, receipts: 100});
  assert.equal(closed, true); assert.equal(c.pending(), false);
  s.start(); assert.equal(c.pending(), false);
});
test("sync and async failures back off to cap; success does not erase cumulative failures", async () => {
  const c = fakeClock(); let calls = 0;
  const s = new ResumeSessionScheduler({
    runOnce: () => {
      calls++;
      if (calls === 1) throw Error("sync");
      if (calls <= 8) return Promise.reject(Error("driver"));
      return Promise.resolve({sessions: 1, receipts: 3});
    }, stopAndSettle: async () => {},
  }, c.time);
  s.start();
  for (let i = 0; i < 9; i++) { c.tick(); await flush(); }
  assert.deepEqual(c.delays, [1000,2000,4000,8000,16000,32000,60000,60000,60000,1000]);
  assert.deepEqual(await s.stopAndSettle(), {completedRuns: 1, failedRuns: 8, sessions: 1, receipts: 3});
});
test("server lifecycle shutdown waits for in-flight cleanup and primitive close", async () => {
  const c = fakeClock(), batch = deferred<{sessions: number; receipts: number}>(), close = deferred<void>();
  let closed = false, settled = false;
  const s = new ResumeSessionScheduler({
    runOnce: () => batch.promise,
    stopAndSettle: async () => { await close.promise; closed = true; },
  }, c.time);
  const lifecycle = new ServerLifecycle(s, {settle: async () => { assert.equal(closed, true); }});
  s.start(); c.tick(); await flush();
  const stopping = lifecycle.stopAndSettle().then(() => { settled = true; });
  assert.equal(lifecycle.accepting, false);
  assert.equal(s.stopAndSettle(), s.stopAndSettle());
  await flush(); assert.equal(settled, false);
  batch.resolve({sessions: 0, receipts: 0}); await flush();
  assert.equal(settled, false); assert.equal(c.pending(), false);
  close.resolve(); await stopping; assert.equal(settled, true);
});
test("stop before start permanently closes producer, and close failure remains visible", async () => {
  const c = fakeClock();
  const s = new ResumeSessionScheduler({
    runOnce: async () => { throw Error("must not execute"); },
    stopAndSettle: async () => { throw Error("close failure"); },
  }, c.time);
  await assert.rejects(s.stopAndSettle(), /close failure/);
  s.start(); assert.equal(c.pending(), false);
});
