import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installProcessShutdown } from "./process-shutdown";

test("SIGTERM closes admission synchronously and repeated signals cannot bypass pending writes", async () => {
  const signals = new EventEmitter();
  let release!: () => void, calls = 0;
  const events: string[] = [];
  const pending = new Promise<void>(resolve => { release = resolve; });
  const dispose = installProcessShutdown(signals, () => { calls++; return pending; }, e => events.push(e));
  signals.emit("SIGTERM"); signals.emit("SIGTERM");
  assert.equal(calls, 1); assert.deepEqual(events, ["started"]);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(events, ["started"]);
  release(); await new Promise(r => setImmediate(r));
  assert.deepEqual(events, ["started", "settled"]);
  signals.emit("SIGTERM"); assert.equal(calls, 1);
  dispose(); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

for (const sync of [true, false]) test("shutdown failure is reported once, never success or retried: sync=" + sync, async () => {
  const signals = new EventEmitter(), original = Error("unsettled");
  const events: [string, unknown][] = []; let calls = 0;
  installProcessShutdown(signals, () => {
    calls++; if (sync) throw original; return Promise.reject(original);
  }, (e, d) => events.push([e, d]));
  signals.emit("SIGTERM"); await new Promise(r => setImmediate(r)); signals.emit("SIGTERM");
  assert.equal(calls, 1); assert.deepEqual(events, [["started", undefined], ["failed", original]]);
});
