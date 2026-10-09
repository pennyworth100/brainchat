import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";
import { ResumeMessageWriter } from "./resume-message";

for (const durable of [false, true]) for (const uncertain of [false, true]) {
  test((durable ? "durable: " : "plain: ") + (uncertain ? "message writer rejects uncertain COMMIT without retry" :
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
    const pending = durable ? writer.saveOnce(binding, "key", "literal ' text") :
      writer.save(binding, "literal ' text");
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await committing;
    assert.equal(settled, false);
    finishCommit();
    if (uncertain) await assert.rejects(pending, /uncertain commit/);
    else assert.deepEqual(await pending, { authorized: true, value: {
      id: 7, type: "message", username: "Guest", message: "literal ' text", ts: 1234,
    } });
    assert.equal(inserts, 1);
    assert.equal(destroyed, uncertain);
  });
}
