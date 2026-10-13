import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserPublicationPump, type PublicationClock } from "./browser-publication-pump";

function fixture(poll: (signal: AbortSignal) => Promise<boolean>, expiresAt = 10000) {
  let time = 1000, ready = 0, failed = 0, id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: PublicationClock = { now: () => time,
    schedule: (callback, delay) => { const key = ++id; timers.set(key, {at: time + delay, callback}); return key; },
    cancel: key => { timers.delete(key as number); } };
  const pump = createBrowserPublicationPump({ poll, expiresAt, clock,
    synchronized: () => { ready++; }, failed: () => { failed++; } });
  return { pump, timers, counts: () => ({ready, failed}), setTime: (value: number) => {time = value;},
    async next() {
      const [key, item] = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
      time = item.at; timers.delete(key); item.callback();
      await Promise.resolve(); await Promise.resolve();
    } };
}
test("polls only after installation, then one second after settlement", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return true; });
  assert.equal(calls, 0);
  await f.next(); assert.equal(calls, 1); assert.deepEqual(f.counts(), {ready:1,failed:0});
  await f.next(); assert.equal(calls, 2);
  f.pump.cancel(); assert.equal(f.timers.size, 0); assert.equal(f.pump.live(), false);
});
test("hung poll aborts at deadline, never overlaps or retries, and late settlement cannot revive it", async () => {
  let resolve!: (value: boolean) => void, signal!: AbortSignal, calls=0;
  const f = fixture(s => { signal=s; calls++; return new Promise(r => {resolve=r;}); });
  await f.next(); await f.next();
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  assert.deepEqual(f.counts(), {ready:0,failed:1});
  resolve(true); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.counts(), {ready:0,failed:1}); assert.equal(f.timers.size, 0);
});
for (const kind of ["false", "reject", "throw"]) test("failure closes lifetime: "+kind, async () => {
  const f = fixture(() => {
    if (kind === "throw") throw Error("transport");
    return kind === "false" ? Promise.resolve(false) : Promise.reject(Error("transport"));
  });
  await f.next(); assert.deepEqual(f.counts(), {ready:0,failed:1});
  assert.equal(f.pump.live(), false); assert.equal(f.timers.size, 0);
});
test("cancellation during await aborts signal and suppresses rejected result", async () => {
  let reject!: (value: Error) => void, signal!: AbortSignal;
  const f = fixture(s => {signal=s; return new Promise((_r,j) => {reject=j;});});
  await f.next(); f.pump.cancel(); f.pump.cancel(); reject(Error("late"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(signal.aborted, true); assert.deepEqual(f.counts(), {ready:0,failed:0});
});
test("expiry while idle revokes lifetime without another network poll", async () => {
  let calls=0; const f=fixture(async () => {calls++; return true;}, 1500);
  await f.next(); await f.next(); assert.equal(calls,1);
  assert.deepEqual(f.counts(), {ready:1,failed:1});
});
test("operation-time liveness check fences suspended event loop before timers dispatch", async () => {
  const f=fixture(async () => true); await f.next();
  f.setTime(6000); assert.equal(f.pump.live(),false);
  assert.deepEqual(f.counts(),{ready:1,failed:1}); assert.equal(f.timers.size,0);
});
