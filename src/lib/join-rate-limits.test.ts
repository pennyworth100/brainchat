import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeJoinLimits } from "./join-rate-limits";

for (const failing of [0, 1]) {
  test(`join limiter ${failing} failure retains its pending sibling`, async () => {
    const error = { msBeforeNext: 1234 };
    let release!: () => void, finished = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const keys: string[] = [];
    const limiters = [0, 1].map(index => ({ consume: async (key: string) => {
      keys.push(key); if (index === failing) throw error; await pending;
    } }));
    const flight = consumeJoinLimits(limiters[0], limiters[1], "ip", "room");
    const rejection = assert.rejects(flight, value => value === error);
    void rejection.then(() => { finished = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(keys, ["ip", "ip:room"]); assert.equal(finished, false);
    release(); await rejection;
  });
}

test("synchronous limiter throw still starts and settles sibling; first configured error wins", async () => {
  const first = Error("sync failure"), second = Error("async failure"); let calls = 0;
  await assert.rejects(consumeJoinLimits({ consume() { calls++; throw first; } },
    { async consume() { calls++; throw second; } }, "ip", "room"), error => error === first);
  assert.equal(calls, 2);
});

test("successful join charges each limiter once without replay", async () => {
  const keys: string[] = [];
  const limiter = { async consume(key: string) { keys.push(key); return {}; } };
  await consumeJoinLimits(limiter, limiter, "ip", "room");
  assert.deepEqual(keys, ["ip", "ip:room"]);
});
