import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";
import { ResumeHistoryReader } from "./resume-history";

async function fixture() {
  let now = 1000;
  const bindings = new ResumeBindings(10, () => now);
  const binding = await bindings.activate({ sessionId: "session", roomId: "candy986",
    username: "Guest", authVersion: 1, generation: 1, issuedAt: new Date(0), expiresAt: new Date(2000) },
    "transport_A_123456", async () => {}, () => true);
  assert.ok(binding);
  const commands: string[] = [];
  const state = { allowed: true, destroyed: false, releases: 0, reads: 0,
    duringRead: async () => {}, failCommit: false,
    rows: [{ id: 2, type: "image", username: "A", content: '{"url":"/uploads/a.png","id":999,"username":"spoof"}', ts: new Date(500) },
      { id: 1, type: "message", username: "B", content: "hello", ts: new Date(400) }] };
  const events = new EventEmitter();
  const client = { on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    query: async (sql: string, params?: unknown[]) => {
      commands.push(sql);
      if (sql.includes("FROM messages")) {
        state.reads++;
        assert.deepEqual(params, ["candy986"]);
        assert.match(sql, /ORDER BY id DESC LIMIT 100/);
        assert.doesNotMatch(sql, /SELECT \*/);
        await state.duringRead();
        return { rows: state.rows, rowCount: state.rows.length };
      }
      if (sql === "COMMIT" && state.failCommit) throw new Error("lost commit");
      return { rows: [], rowCount: state.allowed ? 1 : 0 };
    },
    release: (destroy: boolean) => { state.destroyed = destroy; state.releases++; },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pick<Pool, "connect">;
  return { reader: new ResumeHistoryReader(new ResumeOperationGate(pool, bindings)),
    state, commands, bindings, binding, expire: () => { now = 2000; } };
}

test("history is bounded, same-room, ordered and projected only after commit", async () => {
  const f = await fixture();
  assert.deepEqual(await f.reader.read(f.binding), [
    { id: 1, type: "message", username: "B", message: "hello", ts: 400 },
    { id: 2, type: "image", username: "A", url: "/uploads/a.png", ts: 500 },
  ]);
  assert.equal(f.commands.at(-1), "COMMIT");
  assert.equal(f.state.releases, 1);
  assert.equal(f.state.destroyed, false);
});

test("history denies stale/copied bindings without checkout and DB denial without read", async () => {
  const f = await fixture();
  assert.equal(await f.reader.read({ ...f.binding }), null);
  assert.equal(f.commands.length, 0);
  f.state.allowed = false;
  assert.equal(await f.reader.read(f.binding), null);
  assert.equal(f.state.reads, 0);
  assert.equal(f.commands.at(-1), "ROLLBACK");
});

test("detach, expiry or DB denial during history query discards rows", async () => {
  for (const event of ["detach", "expiry", "denial"]) {
    const f = await fixture();
    f.state.duringRead = async () => {
      if (event === "detach") f.bindings.detach(f.binding);
      else if (event === "expiry") f.expire();
      else f.state.allowed = false;
    };
    assert.equal(await f.reader.read(f.binding), null);
    assert.equal(f.commands.at(-1), "ROLLBACK");
    assert.equal(f.state.reads, 1);
  }
});

test("history query and uncertain commit errors throw once without result/retry", async () => {
  for (const commit of [false, true]) {
    const f = await fixture();
    if (commit) f.state.failCommit = true;
    else f.state.duringRead = async () => { throw new Error("query failed"); };
    await assert.rejects(f.reader.read(f.binding), /query failed|lost commit/);
    assert.equal(f.state.destroyed, true);
    assert.equal(f.state.releases, 1);
    assert.equal(f.state.reads, 1);
    assert.equal(f.commands.at(-1), "ROLLBACK");
  }
});

test("malformed legacy content falls back; invalid timestamp fails closed", async () => {
  const f = await fixture();
  f.state.rows = [{ id: 1, type: "file", username: "A", content: "legacy", ts: new Date(500) }];
  assert.deepEqual(await f.reader.read(f.binding), [{ id: 1, type: "file", username: "A", message: "legacy", ts: 500 }]);
  f.state.rows[0].ts = new Date(NaN);
  await assert.rejects(f.reader.read(f.binding), /Invalid persisted history timestamp/);
  assert.equal(f.state.destroyed, true);
});

test("empty authorized history is distinct from denied history", async () => {
  const f = await fixture(); f.state.rows = [];
  assert.deepEqual(await f.reader.read(f.binding), []);
  assert.equal(f.commands.at(-1), "COMMIT");
});
