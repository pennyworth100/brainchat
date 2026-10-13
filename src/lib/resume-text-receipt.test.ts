import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";
import { ResumeTextReceiptReader } from "./resume-text-receipt";

for (const scenario of ["confirmed", "missing", "deleted", "wrong-hash", "wrong-room", "wrong-user",
  "wrong-type", "wrong-content", "bad-time", "wrong-owner", "copied-binding", "denied", "detach", "commit-error"]) {
  test("read-only text receipt: " + scenario, async () => {
    const bindings = new ResumeBindings();
    const binding = await bindings.activate({ sessionId: "original-owner", roomId: "candy986",
      username: "Guest", authVersion: 1, generation: 2, issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000) }, "physical_original_123", async () => {}, () => true);
    assert.ok(binding);
    const calls: string[] = [];
    const row: Record<string, unknown> = { id: 9, room_id: "candy986", type: "message", username: "Guest",
      content: "saved text", ts: new Date(1234),
      payload_hash: createHash("sha256").update(JSON.stringify(["candy986","Guest","message","saved text"])).digest("hex") };
    if (scenario === "deleted") row.id = null;
    if (scenario === "wrong-hash") row.payload_hash = "a".repeat(64);
    if (scenario === "wrong-room") row.room_id = "other123";
    if (scenario === "wrong-user") row.username = "other";
    if (scenario === "wrong-type") row.type = "image";
    if (scenario === "wrong-content") row.content = "changed";
    if (scenario === "bad-time") row.ts = new Date(NaN);
    const client = Object.assign(new EventEmitter(), {
      query: async (sql: string, args?: unknown[]) => {
        calls.push(sql);
        assert.ok(!/\b(INSERT|DELETE|UPDATE\s+\w+|TRUNCATE)\b/i.test(sql), "no data mutations");
        if (sql.startsWith("SELECT r.payload_hash")) {
          assert.deepEqual(args, ["original-owner", "original-key"]);
          if (scenario === "detach") bindings.detach(binding);
          return { rows: scenario === "missing" ? [] : [row], rowCount: 1 };
        }
        if (sql === "COMMIT" && scenario === "commit-error") throw Error("read connection lost");
        return { rows: [], rowCount: scenario === "denied" ? 0 : 1 };
      }, release() {},
    }) as unknown as PoolClient;
    const reader = new ResumeTextReceiptReader(new ResumeOperationGate({ connect: async () => client }, bindings));
    const result = reader.read(scenario === "copied-binding" ? { ...binding } : binding,
      { roomId: "candy986", sessionId: scenario === "wrong-owner" ? "new-password-owner" : binding.sessionId,
        type: "message", clientMessageId: "original-key", message: "saved text" });
    if (scenario === "commit-error") await assert.rejects(result, /read connection lost/);
    else if (scenario === "confirmed") assert.deepEqual(await result,
      { id: 9, type: "message", username: "Guest", message: "saved text", ts: 1234 });
    else assert.equal(await result, null);
    if (["wrong-owner", "copied-binding", "denied"].includes(scenario))
      assert.ok(!calls.some(sql => sql.startsWith("SELECT r.payload_hash")));
  });
}

