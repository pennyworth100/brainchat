import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserDurableResume as create, type LeaseStorage } from "./browser-durable-resume";
import { advanceLeaseCheckpoint as advance, type LeaseCheckpoint } from "./browser-lease-journal";
import { createBrowserResumeController } from "./browser-resume-controller";
const id = () => crypto.randomUUID();
const lease = { roomId: "proof123", username: "Owner", sessionId: id(),
  token: "A".repeat(43), generation: 1, expiresAt: 100000 };
function disk() {
  let row: LeaseCheckpoint | undefined, fail = false;
  let gate: Promise<void> | undefined;
  const storage: LeaseStorage = async (_scope, mutation) => {
    if (mutation) {
      await gate;
      if (fail) throw Error("Disk unavailable");
      row = advance(row, mutation.expectedRevision, mutation.change, id(), 1000);
    }
    return structuredClone(row);
  };
  return { storage, row: () => structuredClone(row), fail: () => { fail = true; },
    gate: (value: Promise<void> | undefined) => { gate = value; },
    open: () => create("owner", storage, id, () => 1000) };
}
async function joined(d: ReturnType<typeof disk>) {
  const c = await d.open(), physical = {};
  const ticket = await c.beginJoin(lease.roomId, lease.username, physical);
  const sync = await c.accept(ticket, physical, lease);
  return { c, physical, ticket, sync };
}
test("composed reload retains original grant but requires fresh CAS and fullsync", async () => {
  const d = disk(); await joined(d);
  const c = await d.open(), physical = {};
  assert.equal(c.status().phase, "offline");
  const result = await c.beginResume(physical);
  assert.deepEqual(result.lease, lease);
  assert.equal(d.row()?.attempt?.operationId, result.ticket.kind === "resume" ? result.ticket.operationId : "");
  await c.accept(result.ticket, physical, { ...lease, generation: 2 });
  assert.equal(c.status().phase, "syncing");
  assert.equal(d.row()?.lease?.generation, 2);
  assert.equal(d.row()?.attempt, null);
});
test("intent commit is awaited before any admission result and concurrent admission is refused", async () => {
  const d = disk(), c = await d.open(); let release!: () => void, effects = 0;
  d.gate(new Promise<void>(resolve => { release = resolve; }));
  const pending = c.beginJoin(lease.roomId, lease.username, {}).then(() => effects++);
  await Promise.resolve();
  assert.equal(effects, 0); assert.equal(d.row(), undefined);
  await assert.rejects(c.beginJoin(lease.roomId, lease.username, {}), /busy/);
  release(); await pending;
  assert.equal(effects, 1); assert.equal(d.row()?.attempt?.kind, "join");
});
test("lost initial grant cannot fabricate credential, overwrite owner or start resume", async () => {
  const d = disk(), c = await d.open();
  await c.beginJoin(lease.roomId, lease.username, {});
  const before = d.row();
  for (const action of ["beginResume", "beginTransfer"] as const) {
    const loaded = await d.open(); await assert.rejects(loaded[action]({}));
  }
  const loaded = await d.open();
  await assert.rejects(loaded.beginJoin(lease.roomId, "Other", {}), /cannot be replaced/);
  assert.deepEqual(d.row(), before);
});
test("reload of original pending CAS allows only exact one-time transfer, then separate sync", async () => {
  const d = disk(); await joined(d);
  const c = await d.open(), physical = {}, original = await c.beginResume(physical);
  const loaded = await d.open(), next = {}, transfer = await loaded.beginTransfer(next);
  assert.equal(transfer.ticket.kind, "transfer");
  if (transfer.ticket.kind !== "transfer" || original.ticket.kind !== "resume") throw Error("ticket");
  assert.equal(transfer.ticket.originalOperationId, original.ticket.operationId);
  assert.equal(transfer.ticket.expectedGeneration, 1);
  await loaded.accept(transfer.ticket, next, { ...lease, generation: 3 });
  assert.equal(loaded.status().phase, "syncing");
  assert.equal(d.row()?.lease?.sessionId, lease.sessionId);
});
test("reload after lost transfer acknowledgement cannot chain or blindly resume", async () => {
  const d = disk(); await joined(d);
  await (await d.open()).beginResume({});
  await (await d.open()).beginTransfer({});
  const before = d.row();
  await assert.rejects((await d.open()).beginTransfer({}), /provenance/);
  await assert.rejects((await d.open()).beginResume({}), /reconciliation/);
  assert.deepEqual(d.row(), before);
});
test("abort on accepting grant leaves original durable uncertainty and exposes no sync", async () => {
  const d = disk(), c = await d.open(), p = {};
  const ticket = await c.beginJoin(lease.roomId, lease.username, p);
  d.fail();
  await assert.rejects(c.accept(ticket, p, lease), /Disk/);
  assert.equal(d.row()?.lease, null); assert.equal(c.status().persistenceFailed, true);
  await assert.rejects(c.beginResume({}), /unavailable/);
});
test("physical disconnect during committed acceptance cannot release stale fullsync ticket", async () => {
  const d = disk(), c = await d.open(), p = {};
  const ticket = await c.beginJoin(lease.roomId, lease.username, p);
  let release!: () => void;
  d.gate(new Promise<void>(resolve => { release = resolve; }));
  const pending = c.accept(ticket, p, lease);
  c.disconnect(p); release();
  await assert.rejects(pending, /Physical connection changed/);
  assert.deepEqual(d.row()?.lease, lease);
  const reloaded = await d.open(); assert.equal(reloaded.status().phase, "offline");
});
test("stale physical response and wrong grant owner cannot mutate journal", async () => {
  for (const stale of [true, false]) {
    const d = disk(), c = await d.open(), p = {};
    const ticket = await c.beginJoin(lease.roomId, lease.username, p), before = d.row();
    await assert.rejects(c.accept(ticket, stale ? {} : p, stale ? lease : { ...lease, username: "Other" }));
    assert.deepEqual(d.row(), before);
    assert.notEqual(c.status().phase, "ready");
  }
});
test("two restored controllers cannot both admit same durable revision", async () => {
  const d = disk(); await joined(d);
  const [a, b] = await Promise.all([d.open(), d.open()]);
  const r = await Promise.allSettled([a.beginResume({}), b.beginResume({})]);
  assert.equal(r.filter(x => x.status === "fulfilled").length, 1);
});
test("restore validates disk provenance, clones input and cannot replace live controller", async () => {
  const d = disk(); await joined(d); const row = d.row()!;
  const c = createBrowserResumeController(id, () => 1000);
  c.restore(row);
  (row.lease as { token: string }).token = "bad";
  const p = {}, ticket = c.beginResume(p);
  assert.doesNotThrow(() => c.accept(ticket, p, { ...lease, generation: 2 }));
  assert.throws(() => c.restore(d.row()!), /owned/);
  const bad = createBrowserResumeController();
  assert.throws(() => bad.restore({ ...d.row()!, attempt: { kind: "resume", operationId: id(), expectedGeneration: 9 } }), /provenance/);
});
test("expired persisted lease cannot admit resume or transfer", async () => {
  const d = disk(); await joined(d);
  const c = await create("owner", d.storage, id, () => lease.expiresAt);
  assert.equal(c.status().phase, "blocked");
  await assert.rejects(c.beginResume({}), /expired/);
});
