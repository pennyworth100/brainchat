import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient, QueryResult } from "pg";
import { checkoutUploadLedgerClient } from "./upload-ledger-lease";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(releaseThrows = false) {
  const queries: string[] = [], releases: boolean[] = [];
  const client = {
    async query(sql: string) { queries.push(sql); return { rows: [], rowCount: 1 }; },
    release(broken: boolean) { releases.push(broken); if (releaseThrows) throw Error("release failed"); },
  } as unknown as PoolClient;
  return { client, queries, releases };
}

test("checkout rejection and synchronous throw settle failed without retry", async () => {
  for (const sync of [false, true]) {
    let calls = 0;
    const result = await checkoutUploadLedgerClient(() => {
      calls++;
      if (sync) throw Error("checkout failed");
      return Promise.reject(Error("checkout failed"));
    }, 100);
    assert.deepEqual(result, { status: "failed" });
    assert.equal(calls, 1);
  }
});

test("invalid deadlines deny before checkout", async () => {
  let calls = 0;
  for (const deadline of [0, -1, 1.5, NaN, Infinity, 60001]) {
    assert.deepEqual(await checkoutUploadLedgerClient(async () => { calls++; return fixture().client; }, deadline), { status: "failed" });
  }
  assert.equal(calls, 0);
});

test("one leased client owns queries, releases once, and rejects use after finalization", async () => {
  const f = fixture();
  const result = await checkoutUploadLedgerClient(async () => f.client, 100);
  assert.equal(result.status, "acquired");
  if (result.status !== "acquired") throw Error("not acquired");
  await result.lease.query("BEGIN");
  await result.lease.query("ROLLBACK");
  assert.equal(result.lease.finalize(false), "released");
  assert.equal(result.lease.finalize(true), "already-finalized");
  await assert.rejects(result.lease.query("COMMIT"), /already finalized/);
  assert.deepEqual(f.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(f.releases, [false]);
});

test("broken lease destroys once", async () => {
  const f = fixture(), result = await checkoutUploadLedgerClient(async () => f.client, 100);
  if (result.status !== "acquired") throw Error("not acquired");
  assert.equal(result.lease.finalize(true), "destroyed");
  assert.equal(result.lease.finalize(false), "already-finalized");
  assert.deepEqual(f.releases, [true]);
});

test("release throw cannot lead to a second finalization attempt", async () => {
  const f = fixture(true), result = await checkoutUploadLedgerClient(async () => f.client, 100);
  if (result.status !== "acquired") throw Error("not acquired");
  assert.equal(result.lease.finalize(false), "failed");
  assert.equal(result.lease.finalize(true), "already-finalized");
  await assert.rejects(result.lease.query("SELECT 1"), /already finalized/);
  assert.deepEqual(f.releases, [false]);
});

test("timeout stays denied after late success; no query runs and client is destroyed", async () => {
  const f = fixture(), pending = deferred<PoolClient>(), disposed = deferred<string>();
  const result = await checkoutUploadLedgerClient(() => pending.promise, 1, disposed.resolve);
  assert.deepEqual(result, { status: "timeout" });
  assert.deepEqual(f.releases, []);
  pending.resolve(f.client);
  assert.equal(await disposed.promise, "destroyed");
  assert.deepEqual(result, { status: "timeout" });
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.releases, [true]);
});

test("late release failure is observed, never retried or converted to acquisition", async () => {
  const f = fixture(true), pending = deferred<PoolClient>(), disposed = deferred<string>();
  const result = await checkoutUploadLedgerClient(() => pending.promise, 1, disposed.resolve);
  pending.resolve(f.client);
  assert.equal(await disposed.promise, "failed");
  assert.deepEqual(result, { status: "timeout" });
  assert.deepEqual(f.releases, [true]);
});

test("late checkout rejection is consumed without unhandled rejection or retry", async () => {
  const pending = deferred<PoolClient>();
  let calls = 0;
  const result = await checkoutUploadLedgerClient(() => { calls++; return pending.promise; }, 1);
  pending.reject(Error("late checkout rejection"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { status: "timeout" });
  assert.equal(calls, 1);
});

test("throwing late-disposal observer does not leak an unhandled rejection", async () => {
  const f = fixture(), pending = deferred<PoolClient>();
  const result = await checkoutUploadLedgerClient(() => pending.promise, 1, () => { throw Error("observer failed"); });
  pending.resolve(f.client);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { status: "timeout" });
  assert.deepEqual(f.releases, [true]);
});

test("pending query cannot be released to pool or overlapped by another query", async () => {
  const f = fixture(), pending = deferred<QueryResult>();
  f.client.query = (() => pending.promise) as PoolClient["query"];
  const result = await checkoutUploadLedgerClient(async () => f.client, 100);
  if (result.status !== "acquired") throw Error("not acquired");
  const query = result.lease.query("COMMIT");
  assert.equal(result.lease.finalize(false), "query-pending");
  assert.equal(result.lease.finalize(true), "query-pending");
  await assert.rejects(result.lease.query("ROLLBACK"), /already pending/);
  assert.deepEqual(f.releases, []);
  pending.resolve({ rows: [], rowCount: 1, command: "COMMIT", oid: 0, fields: [] });
  await query;
  assert.equal(result.lease.finalize(false), "released");
  assert.deepEqual(f.releases, [false]);
});

test("query rejection unlocks finalization but never retries the query", async () => {
  const f = fixture();
  let calls = 0;
  f.client.query = (() => { calls++; throw Error("lost COMMIT ack"); }) as PoolClient["query"];
  const result = await checkoutUploadLedgerClient(async () => f.client, 100);
  if (result.status !== "acquired") throw Error("not acquired");
  await assert.rejects(result.lease.query("COMMIT"), /lost COMMIT ack/);
  assert.equal(result.lease.finalize(true), "destroyed");
  assert.equal(calls, 1);
  assert.deepEqual(f.releases, [true]);
});
