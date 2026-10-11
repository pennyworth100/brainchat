import assert from "node:assert/strict";
import test from "node:test";
import { ResumeBindings } from "./resume-bindings";
import type { ResumeIdentity } from "./resume-store";

test("pending and active transport ownership rejects another session before prepare", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  let calls = 0;
  const prepare = async () => { calls++; };
  const pending = c.activate(identity(), transport(1), () => g.promise, connected);
  assert.equal(await c.activate(identity(1, "session-b"), transport(1), prepare, connected), null);
  g.resolve();
  const a = (await pending)!;
  assert.equal(await c.activate(identity(1, "session-b"), transport(1), prepare, connected), null);
  assert.equal(calls, 0);
  assert.ok(c.isCurrent(a));
  assert.equal(await c.activate(identity(), transport(1), prepare, connected), a);
  assert.equal(calls, 0);
  c.detach(a);
  assert.ok(await c.activate(identity(1, "session-b"), transport(1), prepare, connected));
  assert.equal(calls, 1);
});

test("conflicting replacement does not fence either existing session", async () => {
  const c = new ResumeBindings(10, () => 0);
  const a = (await c.activate(identity(), transport(1), ready, connected))!;
  const b = (await c.activate(identity(1, "session-b"), transport(2), ready, connected))!;
  assert.equal(await c.activate(identity(2), transport(2), ready, connected), null);
  assert.ok(c.isCurrent(a));
  assert.ok(c.isCurrent(b));
  c.detach(b);
  const next = (await c.activate(identity(2), transport(2), ready, connected))!;
  assert.ok(c.isCurrent(next));
  assert.equal(c.isCurrent(a), false);
  assert.ok(await c.activate(identity(1, "session-c"), transport(1), ready, connected));
});

test("late failed prepare and old disconnect cannot release a different session owner", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  const pending = c.activate(identity(), transport(1), async () => {
    await g.promise; throw Error("late failure");
  }, connected);
  const rejected = assert.rejects(pending, /late failure/);
  assert.ok(c.disconnect("session-a", transport(1)));
  const b = (await c.activate(identity(1, "session-b"), transport(1), ready, connected))!;
  g.resolve(); await rejected;
  assert.ok(c.disconnect("session-a", transport(1)));
  assert.ok(c.isCurrent(b));
  assert.equal(await c.activate(identity(1, "session-c"), transport(1), ready, connected), null);
});

test("late success after same-transport generation replacement preserves reservation", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  const pending = c.activate(identity(), transport(1), () => g.promise, connected);
  const next = (await c.activate(identity(2), transport(1), ready, connected))!;
  g.resolve();
  assert.equal(await pending, null);
  assert.ok(c.isCurrent(next));
  assert.equal(await c.activate(identity(1, "session-b"), transport(1), ready, connected), null);
});

test("expiry sweep and late pending completion cannot erase a new transport owner", async () => {
  let now = 0;
  const c = new ResumeBindings(10, () => now), g = gate();
  const pending = c.activate(identity(), transport(1), () => g.promise, connected);
  now = 1000;
  const fresh = { ...identity(1, "session-b"), expiresAt: new Date(2000) };
  const b = (await c.activate(fresh, transport(1), ready, connected))!;
  g.resolve();
  assert.equal(await pending, null);
  c.sweep();
  assert.ok(c.isCurrent(b));
  assert.equal(await c.activate({ ...fresh, sessionId: "session-c" }, transport(1), ready, connected), null);
});

test("failed, disconnected and expired activations release transport but retain fences", async () => {
  for (const mode of ["throw", "disconnect", "expire"]) {
    let now = 0;
    const c = new ResumeBindings(10, () => now);
    const result = c.activate(identity(), transport(1), async () => {
      if (mode === "throw") throw Error("prepare");
      if (mode === "expire") now = 1000;
    }, () => mode !== "disconnect");
    if (mode === "throw") await assert.rejects(result, /prepare/);
    else assert.equal(await result, null);
    assert.equal(await c.activate(identity(), transport(1), ready, connected), null);
    const b = await c.activate({ ...identity(1, "session-b"), expiresAt: new Date(2000) },
      transport(1), ready, connected);
    assert.ok(b && c.isCurrent(b));
  }
});


const identity = (generation = 1, sessionId = "session-a"): ResumeIdentity => ({
  sessionId, generation, roomId: "candy986", username: "Alice", authVersion: 1,
  issuedAt: new Date(0), expiresAt: new Date(1000),
});
const transport = (n: number) => `server-transport-${n}`;
const ready = async () => {};
const connected = () => true;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("binding is server-owned, immutable, current only after preparation", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  const pending = c.activate(identity(), transport(1), () => g.promise, connected);
  assert.equal(await c.activate(identity(), transport(1), ready, connected), null);
  g.resolve();
  const b = (await pending)!;
  assert.ok(c.isCurrent(b));
  assert.ok(Object.isFrozen(b));
  assert.equal(c.isCurrent({ ...b }), false);
  assert.equal(c.detach({ ...b }), false);
  assert.equal(await c.activate(identity(), transport(1), async () => { throw Error("duplicate prepare"); }, connected), b);
});

test("replacement immediately fences old authority; delayed disconnect is harmless", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  const old = (await c.activate(identity(), transport(1), ready, connected))!;
  const pending = c.activate(identity(2), transport(2), () => g.promise, connected);
  assert.equal(c.isCurrent(old), false);
  assert.equal(c.detach(old), false);
  assert.equal(c.disconnect(old.sessionId, transport(1)), false);
  g.resolve();
  const next = (await pending)!;
  assert.ok(c.isCurrent(next));
  assert.equal(c.detach(old), false);
  assert.ok(c.isCurrent(next));
});

test("out-of-order prepare completion cannot supersede the higher generation", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  const first = c.activate(identity(), transport(1), () => g.promise, connected);
  const second = (await c.activate(identity(2), transport(2), ready, connected))!;
  g.resolve();
  assert.equal(await first, null);
  assert.ok(c.isCurrent(second));
  assert.equal(await c.activate(identity(), transport(1), ready, connected), null);
  assert.equal(await c.activate(identity(2), transport(3), ready, connected), null);
});

test("failed activation retains fence and never resurrects old authority", async () => {
  const c = new ResumeBindings(10, () => 0);
  const old = (await c.activate(identity(), transport(1), ready, connected))!;
  await assert.rejects(c.activate(identity(2), transport(2), async () => { throw Error("uncertain join"); }, connected), /uncertain/);
  assert.equal(c.isCurrent(old), false);
  assert.equal(await c.activate(identity(), transport(1), ready, connected), null);
  assert.equal(await c.activate(identity(2), transport(2), ready, connected), null);
  assert.ok(await c.activate(identity(3), transport(3), ready, connected));
});

test("late failed prepare cannot cancel an already active successor", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  const first = c.activate(identity(), transport(1), async () => { await g.promise; throw Error("late failure"); }, connected);
  const second = (await c.activate(identity(2), transport(2), ready, connected))!;
  const rejected = assert.rejects(first, /late failure/);
  g.resolve();
  await rejected;
  assert.ok(c.isCurrent(second));
});

test("disconnect during preparation prevents activation even if callback reports connected", async () => {
  const c = new ResumeBindings(10, () => 0), g = gate();
  const pending = c.activate(identity(), transport(1), () => g.promise, connected);
  assert.ok(c.disconnect("session-a", transport(1)));
  g.resolve();
  assert.equal(await pending, null);
  assert.equal(await c.activate(identity(), transport(1), ready, connected), null);
});

test("disconnected or uncertain transport never gains or retains authority", async () => {
  const c = new ResumeBindings(10, () => 0);
  assert.equal(await c.activate(identity(), transport(1), ready, () => false), null);
  await assert.rejects(c.activate(identity(2), transport(2), ready, () => { throw Error("unknown"); }));
  const b = (await c.activate(identity(3), transport(3), ready, connected))!;
  assert.equal(await c.activate(identity(3), transport(3), ready, () => false), null);
  assert.equal(c.isCurrent(b), false);
});

test("absolute expiry fences active and pending bindings; sweep permits capacity recovery", async () => {
  let now = 0;
  const c = new ResumeBindings(2, () => now), g = gate();
  const b = (await c.activate(identity(), transport(1), ready, connected))!;
  const pending = c.activate(identity(1, "session-b"), transport(2), () => g.promise, connected);
  now = 1000;
  assert.equal(c.isCurrent(b), false);
  g.resolve();
  assert.equal(await pending, null);
  c.sweep();
  assert.equal(await c.activate(identity(), transport(1), ready, connected), null);
  assert.ok(await c.activate({ ...identity(1, "session-c"), expiresAt: new Date(2000) }, transport(3), ready, connected));
});

test("capacity cannot evict an unexpired tombstone or restore an obsolete generation", async () => {
  const c = new ResumeBindings(1, () => 0);
  const b = (await c.activate(identity(), transport(1), ready, connected))!;
  c.detach(b);
  c.sweep();
  assert.equal(await c.activate(identity(1, "session-b"), transport(2), ready, connected), null);
  assert.equal(await c.activate(identity(), transport(1), ready, connected), null);
  assert.ok(await c.activate(identity(2), transport(2), ready, connected));
});

test("room, policy, username and lifetime changes cannot replace a session binding", async () => {
  const c = new ResumeBindings(10, () => 0);
  const b = (await c.activate(identity(), transport(1), ready, connected))!;
  for (const delta of [{ roomId: "spoon651" }, { authVersion: 2 }, { username: "Bob" }, { expiresAt: new Date(2000) }]) {
    assert.equal(await c.activate({ ...identity(2), ...delta }, transport(2), ready, connected), null);
    assert.ok(c.isCurrent(b));
  }
});
