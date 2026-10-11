import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { Pool, PoolClient } from "pg";
import { ResumeSessionCleanup } from "./resume-session-cleanup";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(query: (sql: string) => Promise<unknown>) {
  const releases: boolean[] = [];
  let connects = 0;
  const client = Object.assign(new EventEmitter(), { query, release: (destroy: boolean) => releases.push(destroy) });
  const pool = { connect: async () => { connects++; return client as unknown as PoolClient; } } as Pick<Pool, "connect">;
  return { owner: new ResumeSessionCleanup(pool), releases, client, connects: () => connects };
}
test("overlapping requests share one actual transaction and stop waits for commit", async () => {
  const entered = deferred(), commit = deferred();
  const f = fixture(async sql => {
    if (sql === "COMMIT") { entered.resolve(); await commit.promise; }
    return { rows: [], rowCount: 0 };
  });
  const one = f.owner.runOnce();
  assert.equal(f.owner.runOnce(), one);
  await entered.promise;
  let stopped = false;
  const stop = f.owner.stopAndSettle().then(() => { stopped = true; });
  await assert.rejects(f.owner.runOnce(), /stopped/);
  await new Promise(r => setImmediate(r));
  assert.equal(stopped, false); assert.deepEqual(f.releases, []);
  commit.resolve(); await stop;
  assert.deepEqual(await one, { sessions: 0, receipts: 0 });
  assert.equal(f.connects(), 1); assert.deepEqual(f.releases, [false]);
});
test("failure retains client until rollback settles, then destroys it", async () => {
  const entered = deferred(), rollback = deferred();
  const f = fixture(async sql => {
    if (sql.includes("SELECT id")) throw Error("cancelled");
    if (sql === "ROLLBACK") { entered.resolve(); await rollback.promise; }
    return { rows: [], rowCount: 0 };
  });
  const failed = assert.rejects(f.owner.runOnce(), /cancelled/);
  await entered.promise;
  const stop = assert.rejects(f.owner.stopAndSettle(), /cancelled/);
  assert.deepEqual(f.releases, []);
  rollback.resolve(); await failed; await stop;
  assert.deepEqual(f.releases, [true]);
});
test("rollback failure cannot return a poisoned client to pool", async () => {
  const f = fixture(async sql => {
    if (sql.includes("SELECT id") || sql === "ROLLBACK") throw Error("offline");
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(f.owner.runOnce(), /offline/);
  assert.deepEqual(f.releases, [true]);
});
test("stop owns in-flight pool acquisition and permanently rejects new runs", async () => {
  const gate = deferred(); let released = false;
  const client = Object.assign(new EventEmitter(), {
    query: async () => ({ rows: [], rowCount: 0 }), release: () => { released = true; },
  });
  const owner = new ResumeSessionCleanup({ connect: async () => {
    await gate.promise; return client as unknown as PoolClient;
  } } as Pick<Pool, "connect">);
  const run = owner.runOnce();
  let done = false;
  const stop = owner.stopAndSettle().then(() => { done = true; });
  await new Promise(r => setImmediate(r)); assert.equal(done, false);
  gate.resolve(); await run; await stop;
  assert.equal(released, true);
  await assert.rejects(owner.runOnce(), /stopped/);
});
test("pool acquisition failure is observable without inventing release", async () => {
  const owner = new ResumeSessionCleanup({ connect: async () => { throw Error("pool unavailable"); } } as Pick<Pool, "connect">);
  await assert.rejects(owner.runOnce(), /pool unavailable/);
});
test("connection error events remain failures even if commit returns", async () => {
  const f = fixture(async sql => {
    if (sql === "COMMIT") f.client.emit("error", Error("connection lost"));
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(f.owner.runOnce(), /connection lost/);
  assert.deepEqual(f.releases, [true]);
});
