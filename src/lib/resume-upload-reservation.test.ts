import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ResumeUploadReservations } from "./resume-upload-reservation";

const input = () => ({ sessionId: randomUUID(), roomId: "candy986", clientMessageId: "key", reservedBytes: 10 });
for (const mode of ["checkout", "begin", "insert", "commit", "release"] as const) {
  test(`reservation ${mode} failure preserves conservative outcome`, async () => {
    let commits = 0;
    const client = { query: async (sql: string) => {
      if (sql === "COMMIT") commits++;
      if ((mode === "begin" && sql.startsWith("BEGIN")) ||
          (mode === "insert" && sql.startsWith("INSERT")) ||
          (mode === "commit" && sql === "COMMIT")) throw Error("controlled failure");
      return { rowCount: 1 };
    }, release: () => { if (mode === "release") throw Error("controlled release failure"); } } as unknown as PoolClient;
    const ledger = new ResumeUploadReservations({ connect: async () => {
      if (mode === "checkout") throw Error("controlled checkout failure");
      return client;
    } });
    const result = await ledger.reserve(input());
    assert.ok(result.status === "failed");
    assert.equal(result.commit, mode === "commit" || mode === "release" ? "unknown" : "not-dispatched");
    assert.equal(commits, mode === "commit" || mode === "release" ? 1 : 0);
    assert.match(result.attempt.storageKey, /^[0-9a-f]{64}$/);
  });
}

test("invalid ceilings fail before checkout", async () => {
  const ledger = new ResumeUploadReservations({ connect: async () => { throw Error("must not checkout"); } });
  for (const reservedBytes of [0, -1, 1.5, NaN, Infinity, 104857601]) {
    await assert.rejects(ledger.reserve({ ...input(), reservedBytes }), /Invalid upload reservation/);
  }
});

test("pending commit never grants or refunds; caller mutation cannot change provenance", async () => {
  let finish!: () => void, entered!: () => void;
  const pending = new Promise<void>(r => { finish = r; });
  const atCommit = new Promise<void>(r => { entered = r; });
  const original = input();
  const ledger = new ResumeUploadReservations({ connect: async () => ({
    query: async (sql: string) => {
      if (sql === "COMMIT") { entered(); await pending; }
      return { rowCount: 1 };
    }, release: () => {},
  }) as unknown as PoolClient });
  let settled = false;
  const result = ledger.reserve(original).then(r => { settled = true; return r; });
  await atCommit;
  original.reservedBytes = 99;
  original.clientMessageId = "mutated";
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false);
  finish();
  const done = await result;
  assert.ok(done.status === "reserved");
  assert.equal(done.attempt.reservedBytes, 10);
  assert.equal(done.attempt.clientMessageId, "key");
  assert.ok(Object.isFrozen(done.attempt));
});
