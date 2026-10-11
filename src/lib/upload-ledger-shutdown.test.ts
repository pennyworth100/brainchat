import assert from "node:assert/strict";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { createUploadLedgerProvider, createStrictUploadLedgerProvider } from "./upload-ledger-provider";

const config = { host: "fixture.invalid", port: 5432, user: "fixture", password: "fixture",
  database: "ledger", clusterIdentity: "fixture", systemIdentifier: "1" };
const policy = (strict: boolean) => ({
  identity: { database: JSON.stringify(["fixture", "ledger"]), schema: "public",
    namespace: "/fixture", quotaDomain: "volume", policyVersion: "v1", writerGeneration: "g1" },
  adapter: strict ? "resume-strict-writer-v1" : "multer-crossing-byte-v1",
  layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
  stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 6,
  allocationUnitBytes: 4, allocationCopies: 1, directoryAndParentBytes: 10, metadataBytes: 11,
  temporaryBytes: 12, additionalObjects: 3,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
for (const strict of [false, true]) {
  const create = () => strict ? createStrictUploadLedgerProvider(config) : createUploadLedgerProvider(config);
  const name = strict ? "strict" : "legacy";
  test(name + ": close retains active lease and SQL; repeated close cannot report early", async t => {
    const sql = deferred<any>(), ending = deferred<void>();
    const events: string[] = [];
    let queries = 0;
    t.mock.method(Pool.prototype, "connect", async () => ({
      async query() {
        if (++queries === 1) return { rowCount: 1, rows: [{ database: "ledger", system_identifier: "1" }] };
        events.push("query"); return sql.promise;
      },
      release() { events.push("release"); },
    }));
    t.mock.method(Pool.prototype, "end", () => { events.push("end"); return ending.promise; });
    const provider = create(), pin = provider.pin(policy(strict))!;
    const acquired = await provider.checkout(pin as never);
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") throw Error("fixture");
    const query = acquired.lease.query("COMMIT");
    const first = provider.close(), second = provider.close();
    assert.equal(first, second);
    let closed = false; void second.then(() => { closed = true; });
    await turn();
    assert.deepEqual(events, ["query"]); assert.equal(closed, false);
    assert.equal(provider.pin(policy(strict)), null);
    assert.deepEqual(await provider.checkout(pin as never), { status: "failed" });
    assert.equal(acquired.lease.finalize(false), "query-pending");
    sql.resolve({ rows: [], rowCount: 0 }); await query;
    assert.equal(closed, false); assert.deepEqual(events, ["query"]);
    acquired.lease.finalize(false); await turn();
    assert.deepEqual(events, ["query", "release", "end"]); assert.equal(closed, false);
    ending.resolve(); await first;
    assert.equal(closed, true); assert.equal(provider.close(), first);
  });

  for (const result of ["client", "rejection"] as const) {
    test(name + ": checkout timeout retains late " + result + " until disposal before pool end", async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const connection = deferred<PoolClient>(), events: string[] = [];
      t.mock.method(Pool.prototype, "connect", () => connection.promise);
      t.mock.method(Pool.prototype, "end", async () => { events.push("end"); });
      const provider = create(), pin = provider.pin(policy(strict))!;
      const checkout = provider.checkout(pin as never);
      await turn();
      t.mock.timers.tick(5000);
      assert.deepEqual(await checkout, { status: "timeout" });
      const close = provider.close();
      let closed = false; void close.then(() => { closed = true; });
      await turn();
      assert.equal(closed, false); assert.equal(events.length, 0);
      if (result === "client") connection.resolve({
        query() { throw Error("late client must never query"); },
        release(broken: boolean) { assert.equal(broken, true); events.push("destroy"); },
      } as unknown as PoolClient);
      else connection.reject(Error("late connection failure"));
      await close;
      assert.deepEqual(events, result === "client" ? ["destroy", "end"] : ["end"]);
      assert.equal(closed, true);
    });
  }

  test(name + ": pool shutdown rejection is retained identically, never retried", async t => {
    let ends = 0;
    t.mock.method(Pool.prototype, "end", async () => { ends++; throw Error("end failed"); });
    const provider = create(), first = provider.close();
    await assert.rejects(first, /end failed/);
    assert.equal(provider.close(), first);
    await assert.rejects(provider.close(), /end failed/);
    assert.equal(ends, 1);
  });

  test(name + ": late disposal failure rejects all close callers without retrying release/end", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const connection = deferred<PoolClient>(); let releases = 0, ends = 0;
    t.mock.method(Pool.prototype, "connect", () => connection.promise);
    t.mock.method(Pool.prototype, "end", async () => { ends++; });
    const provider = create(), checkout = provider.checkout(provider.pin(policy(strict))! as never);
    await turn(); t.mock.timers.tick(5000); await checkout;
    const first = provider.close(), rejected = assert.rejects(first, /disposal unconfirmed/);
    connection.resolve({ query() { throw Error("no query"); },
      release() { releases++; throw Error("driver release failed"); } } as unknown as PoolClient);
    await rejected;
    assert.equal(provider.close(), first);
    await assert.rejects(provider.close(), /disposal unconfirmed/);
    assert.equal(releases, 1); assert.equal(ends, 0);
  });
}
