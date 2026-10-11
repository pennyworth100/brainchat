import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { createUploadLedgerProvider } from "./upload-ledger-provider";
import { runUploadLedgerTransaction } from "./upload-ledger-transaction";

function setup(t: TestContext, options: {
  fail?: string; badTag?: string; releaseThrows?: boolean; checkoutFails?: boolean;
  hold?: () => Promise<void>;
} = {}) {
  const sql: string[] = [], releases: boolean[] = [];
  let durableAttempt: string | undefined;
  const client = Object.assign(new EventEmitter(), {
    async query(statement: string, values?: unknown[]) {
      sql.push(statement);
      if (statement.includes("pg_control_system")) return { command: "SELECT", rowCount: 1,
        rows: [{ database: "ledger", system_identifier: "123" }] };
      const command = statement.split(" ")[0];
      if (command === "INSERT") { durableAttempt = values![0] as string; await options.hold?.(); }
      if (command === options.fail) throw Error("controlled failure");
      return { command: command === options.badTag ? "ROLLBACK" : command, rowCount: 1, rows: [] };
    },
    release(broken: boolean) { releases.push(broken); if (options.releaseThrows) throw Error("release failure"); },
  }) as unknown as PoolClient;
  t.mock.method(Pool.prototype, "connect", async function(this: Pool) {
    if (options.checkoutFails) throw Error("checkout failed");
    this.emit("connect", client); return client;
  });
  t.mock.method(Pool.prototype, "end", async () => {});
  const provider = createUploadLedgerProvider({ host: "ledger.invalid", port: 5432, user: "fixture",
    password: "fixture", database: "ledger", clusterIdentity: "fixture", systemIdentifier: "123" });
  const pin = provider.pin({ identity: { database: provider.binding.database, schema: "public",
    namespace: "/fixture", quotaDomain: "volume", policyVersion: "v1", writerGeneration: "g1" },
    adapter: "multer-crossing-byte-v1", layout: "provisioned-root-one-directory-one-file-v1",
    allocationModel: "audited-rounded-copies-v1", stableExclusiveNamespace: true,
    allAllocationCostsBounded: true, maxFileBytes: 6, allocationUnitBytes: 4, allocationCopies: 1,
    directoryAndParentBytes: 10, metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 })!;
  assert.ok(pin);
  t.after(() => provider.close());
  const work: Parameters<typeof runUploadLedgerTransaction>[2] = async c => {
    await c.query("INSERT fixture", [c.attemptId]); return "prepared";
  };
  return { provider, pin, work, sql, releases, get durableAttempt() { return durableAttempt; } };
}

test("acknowledged commit and release retain the exact generated attempt; no grant", async t => {
  const f = setup(t), result = await runUploadLedgerTransaction(f.provider, f.pin, f.work);
  assert.equal(result.status, "committed"); assert.equal(result.commitDispatched, true);
  assert.equal(result.attemptId, f.durableAttempt);
  assert.match(result.attemptId, /^[0-9a-f-]{36}$/);
  assert.ok(Object.isFrozen(result));
  assert.equal(result.kind, "upload-ledger-transaction-only");
  assert.deepEqual(f.sql.slice(1), ["BEGIN ISOLATION LEVEL READ COMMITTED", "INSERT fixture", "COMMIT"]);
  assert.deepEqual(f.releases, [false]);
});

test("checkout failure never invokes work or dispatches commit", async t => {
  const f = setup(t, { checkoutFails: true });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, async () => { assert.fail("work called"); });
  assert.equal(r.status, "not-committed"); assert.equal(r.commitDispatched, false);
  assert.deepEqual(f.sql, []); assert.deepEqual(f.releases, []);
});

test("foreign pin fails provider validation before BEGIN", async t => {
  const f = setup(t);
  const r = await runUploadLedgerTransaction(f.provider, { ...f.pin }, f.work);
  assert.equal(r.status, "not-committed"); assert.deepEqual(f.sql, []);
});

test("BEGIN failure destroys once and never invokes work", async t => {
  const f = setup(t, { fail: "BEGIN" });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, f.work);
  assert.equal(r.status, "not-committed"); assert.equal(r.commitDispatched, false);
  assert.equal(f.sql.length, 2); assert.deepEqual(f.releases, [true]);
});

test("explicit denial rolls back and finalizes once, without COMMIT", async t => {
  const f = setup(t);
  const r = await runUploadLedgerTransaction(f.provider, f.pin, async () => "denied");
  assert.equal(r.status, "not-committed"); assert.equal(r.commitDispatched, false);
  assert.equal(f.sql.at(-1), "ROLLBACK"); assert.deepEqual(f.releases, [false]);
});

test("query error, including a swallowed error, cannot commit", async t => {
  const f = setup(t, { fail: "INSERT" });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, async c => {
    try { await c.query("INSERT fixture", [c.attemptId]); } catch {}
    return "prepared";
  });
  assert.equal(r.status, "not-committed"); assert.equal(r.commitDispatched, false);
  assert.equal(f.sql.at(-1), "ROLLBACK"); assert.deepEqual(f.releases, [false]);
});

test("work exception rolls back", async t => {
  const f = setup(t);
  const r = await runUploadLedgerTransaction(f.provider, f.pin, async () => { throw Error("work failed"); });
  assert.equal(r.status, "not-committed"); assert.equal(f.sql.at(-1), "ROLLBACK");
});

test("failed rollback retains unknown identity, destroys, and never retries", async t => {
  const f = setup(t, { fail: "ROLLBACK" });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, async () => "denied");
  assert.equal(r.status, "unknown"); assert.equal(r.commitDispatched, false);
  assert.deepEqual(f.releases, [true]); assert.equal(f.sql.length, 3);
});

test("lost COMMIT ACK retains attempt with UNKNOWN; no rollback or replay", async t => {
  const f = setup(t, { fail: "COMMIT" });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, f.work);
  assert.equal(r.status, "unknown"); assert.equal(r.commitDispatched, true);
  assert.equal(r.attemptId, f.durableAttempt);
  assert.equal(f.sql.at(-1), "COMMIT"); assert.equal(f.sql.length, 4);
  assert.deepEqual(f.releases, [true]);
});

test("COMMIT returning ROLLBACK is never accepted as committed", async t => {
  const f = setup(t, { badTag: "COMMIT" });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, f.work);
  assert.equal(r.status, "unknown"); assert.equal(r.commitDispatched, true);
  assert.deepEqual(f.releases, [true]);
});

test("successful COMMIT plus release failure is UNKNOWN; disposal is never retried", async t => {
  const f = setup(t, { releaseThrows: true });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, f.work);
  assert.equal(r.status, "unknown"); assert.equal(r.commitDispatched, true);
  assert.equal(r.attemptId, f.durableAttempt); assert.deepEqual(f.releases, [false]);
});

test("destruction failure after lost COMMIT ACK stays UNKNOWN with one attempt", async t => {
  const f = setup(t, { fail: "COMMIT", releaseThrows: true });
  const r = await runUploadLedgerTransaction(f.provider, f.pin, f.work);
  assert.equal(r.status, "unknown"); assert.deepEqual(f.releases, [true]);
});

test("unawaited pending query is drained then rolled back, never released early", async t => {
  let release!: () => void;
  const f = setup(t, { hold: () => new Promise<void>(resolve => { release = resolve; }) });
  const running = runUploadLedgerTransaction(f.provider, f.pin, async c => {
    void c.query("INSERT fixture", [c.attemptId]); return "prepared";
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.releases, []); assert.equal(f.sql.at(-1), "INSERT fixture");
  release();
  const r = await running;
  assert.equal(r.status, "not-committed"); assert.equal(f.sql.at(-1), "ROLLBACK");
  assert.deepEqual(f.releases, [false]);
});

test("retained query function is revoked after callback completion", async t => {
  const f = setup(t);
  let query!: Parameters<Parameters<typeof runUploadLedgerTransaction>[2]>[0]["query"];
  const r = await runUploadLedgerTransaction(f.provider, f.pin, async c => { query = c.query; return "denied"; });
  assert.equal(r.status, "not-committed");
  const count = f.sql.length;
  await assert.rejects(query("INSERT late"), /scope closed/);
  assert.equal(f.sql.length, count); assert.deepEqual(f.releases, [false]);
});
