import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { inventoryUploadLedger } from "./resume-ledger-inventory";

const attempt = { storage_key: "a".repeat(64), session_id: "11111111-1111-4111-8111-111111111111",
  room_id: "files123", client_message_id: "one", reserved_bytes: "1024", oversized: false };
const limits = { pageSize: 1, maxRows: 2, timeoutMs: 1000 };
function fixture(options: { failPage?: boolean; badAmount?: boolean; deadline?: boolean; releaseError?: boolean } = {}) {
  const sql: string[] = [], released: boolean[] = [];
  let page = 0;
  const client = { query: async (config: { text: string }) => {
    sql.push(config.text);
    if (config.text.includes("FROM resume_upload_budget")) return { rows: [{ capacity_bytes: "2048", reserved_bytes: "1024" }] };
    if (config.text.startsWith("FETCH")) {
      if (options.deadline) throw Error("Query read timeout");
      if (page++ === 0) return { rows: [{ ...attempt, reserved_bytes: options.badAmount ? "9007199254740993" : "1024" }] };
      if (options.failPage) throw Error("sensitive driver details must not reach report");
    }
    return { rows: [] };
  }, release: (destroy: boolean) => { released.push(destroy); if (options.releaseError) throw Error("private"); } } as unknown as PoolClient;
  return { client, sql, released };
}
test("ledger uses one read-only transaction and releases a destroyed connection", async () => {
  const f = fixture(), r = await inventoryUploadLedger(f.client, limits);
  assert.equal(r.complete, true); assert.equal(r.accounting, "consistent");
  assert.equal(f.sql[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(f.sql.at(-1), "ROLLBACK"); assert.deepEqual(f.released, [true]);
  assert.deepEqual(r.unobserved, ["receipts", "messages", "filesystem"]);
  assert.equal(r.crossStoreStability, "unproven");
});
test("failed pagination preserves positive provenance but cannot assert complete accounting", async () => {
  const f = fixture({ failPage: true }), r = await inventoryUploadLedger(f.client, limits);
  assert.equal(r.complete, false); assert.equal(r.accounting, "unknown");
  assert.equal(r.attempts.length, 1); assert.equal(r.observedReservedBytes, "1024");
  assert.deepEqual(r.reasons, ["db-error:attempts"]);
  assert.ok(!JSON.stringify(r).includes("sensitive")); assert.deepEqual(f.released, [true]);
});
test("invalid out-of-range bigint is retained losslessly, not rounded or counted", async () => {
  const r = await inventoryUploadLedger(fixture({ badAmount: true }).client, limits);
  assert.equal(r.attempts[0].reserved_bytes, "9007199254740993");
  assert.equal(r.observedReservedBytes, "0"); assert.equal(r.accounting, "inconsistent");
  assert.deepEqual(r.reasons, ["invalid-attempt"]);
});
test("client deadline is explicit and unread is not empty-consistent", async () => {
  const r = await inventoryUploadLedger(fixture({ deadline: true }).client, limits);
  assert.equal(r.complete, false); assert.equal(r.accounting, "unknown");
  assert.deepEqual(r.reasons, ["deadline"]);
});
test("release failure invalidates otherwise complete observation", async () => {
  const r = await inventoryUploadLedger(fixture({ releaseError: true }).client, limits);
  assert.equal(r.complete, false); assert.equal(r.accounting, "unknown");
  assert.deepEqual(r.reasons, ["release-error"]);
});
test("invalid bounds do not execute SQL and still dispose the owned connection", async () => {
  const f = fixture(), r = await inventoryUploadLedger(f.client, { ...limits, maxRows: Infinity });
  assert.deepEqual(f.sql, []); assert.deepEqual(f.released, [true]);
  assert.equal(r.complete, false); assert.deepEqual(r.reasons, ["invalid-limits"]);
});
