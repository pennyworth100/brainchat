import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";
import { ResumeMessageWriter } from "./resume-message";

for (const scenario of ["existing", "corrupt-timestamp", "copied-binding", "policy-denial"]) {
  test("write outcome: " + scenario + " cannot claim a new insertion", async () => {
    const bindings = new ResumeBindings();
    const binding = await bindings.activate({ sessionId: "fixture", roomId: "candy986",
      username: "Guest", authVersion: 1, generation: 1, issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000) }, "transport_A_123456", async () => {}, () => true);
    assert.ok(binding);
    const calls: string[] = [];
    let connections = 0, reachCommit!: () => void, finishCommit!: () => void;
    const reached = new Promise<void>(r => { reachCommit = r; });
    const finish = new Promise<void>(r => { finishCommit = r; });
    const client = { query: async (sql: string) => {
      calls.push(sql);
      assert.ok(!sql.startsWith("INSERT"), "existing receipt must never insert");
      if (sql.startsWith("SELECT r.payload_hash")) return { rows: [{ id: 9, username: "Guest",
        content: "stored", ts: scenario === "corrupt-timestamp" ? new Date(NaN) : new Date(1234),
        payload_hash: createHash("sha256").update(JSON.stringify(["candy986", "Guest", "message", "stored"])).digest("hex") }] };
      if (sql === "COMMIT") { reachCommit(); await finish; }
      return { rowCount: scenario === "policy-denial" ? 0 : 1, rows: [] };
    }, release: () => {} } as unknown as PoolClient;
    const writer = new ResumeMessageWriter(new ResumeOperationGate({ connect: async () => {
      connections++; return client;
    } } as Pick<Pool, "connect">, bindings));
    const pending = writer.saveOnceWithOutcome(scenario === "copied-binding" ? { ...binding } : binding, "key", "stored");
    if (scenario === "existing") {
      let settled = false;
      void pending.then(() => { settled = true; });
      await reached;
      assert.equal(settled, false, "even a duplicate receipt waits for COMMIT");
      finishCommit();
      assert.deepEqual(await pending, { authorized: true, value: { inserted: false,
        message: { id: 9, username: "Guest", message: "stored", type: "message", ts: 1234 } } });
    } else if (scenario === "corrupt-timestamp") {
      await assert.rejects(pending, /no longer available/);
      assert.ok(calls.includes("ROLLBACK"));
      assert.ok(!calls.includes("COMMIT"));
    } else {
      assert.deepEqual(await pending, { authorized: false });
      assert.ok(!calls.some(sql => sql.startsWith("SELECT r.payload_hash")));
      if (scenario === "copied-binding") assert.equal(connections, 0);
    }
  });
}

for (const mode of ["plain", "durable", "outcome"]) for (const uncertain of [false, true]) {
  test(mode + ": " + (uncertain ? "message writer rejects uncertain COMMIT without retry" :
    "message receipt waits for COMMIT, and preserves server identity"), async () => {
    const bindings = new ResumeBindings();
    const binding = await bindings.activate({
      sessionId: "fixture", roomId: "candy986", username: "Guest", authVersion: 1,
      generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    }, "transport_A_123456", async () => {}, () => true);
    assert.ok(binding);
    let reachCommit!: () => void, finishCommit!: () => void;
    const committing = new Promise<void>(r => { reachCommit = r; });
    const finish = new Promise<void>(r => { finishCommit = r; });
    let inserts = 0, destroyed = false;
    const client = {
      query: async (sql: string, args?: unknown[]) => {
        if (sql.startsWith("INSERT INTO messages")) {
          inserts++;
          assert.deepEqual(args, ["candy986", "Guest", "literal ' text"]);
          return { rows: [{ id: 7, username: "Guest", content: args![2], ts: new Date(1234) }] };
        }
        if (sql === "COMMIT") {
          reachCommit(); await finish;
          if (uncertain) throw new Error("uncertain commit");
        }
        return { rowCount: 1, rows: [] };
      },
      release: (error: boolean) => { destroyed = error; },
    } as unknown as PoolClient;
    const writer = new ResumeMessageWriter(new ResumeOperationGate(
      { connect: async () => client } as Pick<Pool, "connect">, bindings));
    let settled = false;
    const pending = mode === "outcome" ? writer.saveOnceWithOutcome(binding, "key", "literal ' text") :
      mode === "durable" ? writer.saveOnce(binding, "key", "literal ' text") :
      writer.save(binding, "literal ' text");
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await committing;
    assert.equal(settled, false);
    finishCommit();
    if (uncertain) await assert.rejects(pending, /uncertain commit/);
    else {
      const message = { id: 7, type: "message", username: "Guest", message: "literal ' text", ts: 1234 };
      assert.deepEqual(await pending, { authorized: true,
        value: mode === "outcome" ? { inserted: true, message } : message });
    }
    assert.equal(inserts, 1);
    assert.equal(destroyed, uncertain);
  });
}
