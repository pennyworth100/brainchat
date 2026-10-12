import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitCleanup } from "./rate-limit-cleanup";

function fixture(query: (sql: string, values: number[]) => PromiseLike<unknown>) {
  let now = 10_000_000;
  const timers = new Set<{ callback: () => void; unref(): void }>();
  let unrefs = 0;
  const cleanup = new RateLimitCleanup({ query }, {
    now: () => now,
    set(callback, delay) {
      assert.equal(delay, 300_000);
      const timer = { callback, unref() { unrefs++; } };
      timers.add(timer);
      return timer;
    },
    clear(timer) { timers.delete(timer as typeof timers extends Set<infer T> ? T : never); },
  });
  return { cleanup, timers, unrefs: () => unrefs, fire() {
    assert.equal(timers.size, 1);
    const timer = [...timers][0];
    timers.delete(timer);
    now += 300_000;
    timer.callback();
  } };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("one unref timer; shared-table SQL preserves one-hour grace at execution", async () => {
  const calls: unknown[] = [];
  const f = fixture(async (...args) => { calls.push(args); });
  assert.equal(calls.length, 0);
  assert.equal(f.unrefs(), 1);
  f.fire();
  await tick();
  assert.deepEqual(calls, [['DELETE FROM "rate_limits" WHERE expire < $1', [6_700_000]]]);
  assert.equal(f.timers.size, 1);
  assert.equal(f.unrefs(), 2);
  assert.deepEqual(await f.cleanup.stopAndSettle(), { completedRuns: 1, failedRuns: 0 });
  assert.equal(f.timers.size, 0);
});

test("stop before timer prevents writes and is idempotent", async () => {
  let writes = 0;
  const f = fixture(async () => { writes++; });
  await Promise.all([f.cleanup.stopAndSettle(), f.cleanup.stopAndSettle()]);
  assert.equal(f.timers.size, 0);
  assert.equal(writes, 0);
});

test("slow query cannot overlap; all stop callers wait and no timer is rearmed", async () => {
  let finish!: () => void;
  const f = fixture(() => new Promise<void>((resolve) => { finish = resolve; }));
  f.fire();
  await tick();
  assert.equal(f.timers.size, 0);
  let settled = 0;
  const stops = [f.cleanup.stopAndSettle(), f.cleanup.stopAndSettle()];
  for (const stop of stops) void stop.then(() => settled++);
  await tick();
  assert.equal(settled, 0);
  finish();
  assert.deepEqual(await Promise.all(stops), Array(2).fill({ completedRuns: 1, failedRuns: 0 }));
  assert.equal(f.timers.size, 0);
});

for (const synchronous of [true, false]) {
  test(`failure stays observable after retry (synchronous=${synchronous})`, async () => {
    let calls = 0;
    const f = fixture(() => {
      if (++calls === 1) {
        if (synchronous) throw new Error("driver failure");
        return Promise.reject(new Error("driver failure"));
      }
      return Promise.resolve();
    });
    f.fire();
    await tick();
    f.fire();
    await tick();
    assert.deepEqual(await f.cleanup.stopAndSettle(), { completedRuns: 1, failedRuns: 1 });
  });
}

test("stop between timer callback and driver call retains the registered write", async () => {
  let finish!: () => void;
  let calls = 0;
  const f = fixture(() => { calls++; return new Promise<void>((resolve) => { finish = resolve; }); });
  f.fire();
  const stop = f.cleanup.stopAndSettle();
  assert.equal(calls, 0);
  await tick();
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await stop, { completedRuns: 1, failedRuns: 0 });
  assert.equal(f.timers.size, 0);
});

test("query rejection during stop is not reported as completed deletion", async () => {
  let fail!: (reason: Error) => void;
  const f = fixture(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  f.fire();
  await tick();
  const stop = f.cleanup.stopAndSettle();
  fail(new Error("connection lost"));
  assert.deepEqual(await stop, { completedRuns: 0, failedRuns: 1 });
  assert.equal(f.timers.size, 0);
});
