import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";

for (const mode of ["success", "copied", "checkout", "begin", "work", "rollback-fails",
  "disconnect", "commit", "commit-sync", "release"] as const) {
  test(`settled operation outcome: ${mode}`, async () => {
    const bindings = new ResumeBindings();
    const binding = await bindings.activate({
      sessionId: "fixture", roomId: "candy986", username: "Guest", authVersion: 1,
      generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    }, "transport_A_123456", async () => {}, () => true);
    assert.ok(binding);
    const failure = new Error(mode);
    const commands: string[] = [];
    let connects = 0, callbacks = 0, released: boolean | undefined;
    const client = {
      query: (sql: string) => {
        commands.push(sql);
        if (mode === "commit-sync" && sql === "COMMIT") throw failure;
        if ((mode === "begin" && sql.startsWith("BEGIN")) ||
            (mode === "commit" && sql === "COMMIT") ||
            (mode === "rollback-fails" && sql === "ROLLBACK")) return Promise.reject(failure);
        return Promise.resolve({ rowCount: 1, rows: [{ id: "fixture" }] });
      },
      release: (destroy: boolean) => { released = destroy; if (mode === "release") throw failure; },
    } as unknown as PoolClient;
    const gate = new ResumeOperationGate({ connect: async () => {
      connects++; if (mode === "checkout") throw failure; return client;
    } }, bindings);
    const result = await gate.runWithOutcome(mode === "copied" ? { ...binding } : binding, async tx => {
      callbacks++;
      await tx.query("INSERT fixture");
      if (mode === "work" || mode === "rollback-fails") throw failure;
      if (mode === "disconnect") bindings.detach(binding);
      return "receipt";
    });
    if (mode === "success") {
      assert.deepEqual(result, { completed: true, result: { authorized: true, value: "receipt" } });
      assert.equal(released, false);
    } else if (mode === "copied" || mode === "disconnect") {
      assert.deepEqual(result, { completed: true, result: { authorized: false } });
      assert.equal(commands.includes("COMMIT"), false);
      if (mode === "copied") assert.equal(connects, 0);
    } else {
      assert.equal(result.completed, false);
      assert.ok(!result.completed);
      assert.equal(result.error, failure);
      const uncertain = ["commit", "commit-sync", "release"].includes(mode);
      assert.equal(result.commit, uncertain ? "unknown" : "not-dispatched");
      assert.equal(commands.filter(sql => sql === "COMMIT").length, uncertain ? 1 : 0);
      if (mode !== "checkout" && mode !== "release") assert.equal(released, true);
    }
    assert.equal(callbacks, ["copied", "checkout", "begin"].includes(mode) ? 0 : 1);
  });
}

test("pending COMMIT cannot yield a no-commit outcome on disconnect", async () => {
  const bindings = new ResumeBindings();
  const binding = await bindings.activate({ sessionId: "pending", roomId: "candy986", username: "Guest",
    authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  }, "transport_pending_1", async () => {}, () => true);
  assert.ok(binding);
  let finish!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const commit = new Promise<void>(resolve => { finish = resolve; });
  const client = { query: async (sql: string) => {
    if (sql === "COMMIT") { started(); await commit; }
    return { rowCount: 1 };
  }, release: () => {} } as unknown as PoolClient;
  let settled = false;
  const pending = new ResumeOperationGate({ connect: async () => client }, bindings)
    .runWithOutcome(binding, async () => "receipt").then(result => { settled = true; return result; });
  await entered;
  bindings.detach(binding);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  assert.deepEqual(await pending, { completed: true, result: { authorized: true, value: "receipt" } });
  // The result is database-only, not permission for a detached owner to publish.
});
