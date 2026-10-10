import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { createUploadLedgerProvider } from "./upload-ledger-provider";
import { pinUploadResourcePolicy } from "./upload-resource-policy-pin";

const config = () => ({ host: "ledger.invalid", port: 5432, user: "ledger",
  password: "fixture-only", database: "ledger", clusterIdentity: "fixture-cluster", systemIdentifier: "123456789" });
const policy = () => ({ identity: { database: JSON.stringify(["fixture-cluster", "ledger"]), schema: "public",
  namespace: "/fixture/a", quotaDomain: "volume", policyVersion: "v1", writerGeneration: "g1" },
  adapter: "multer-crossing-byte-v1", layout: "provisioned-root-one-directory-one-file-v1",
  allocationModel: "audited-rounded-copies-v1", stableExclusiveNamespace: true,
  allAllocationCostsBounded: true, maxFileBytes: 6, allocationUnitBytes: 4, allocationCopies: 1,
  directoryAndParentBytes: 10, metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 });

function setup(t: TestContext, probe?: () => Promise<unknown>, releaseThrows = false) {
  const queries: string[] = [], releases: boolean[] = [];
  let connects = 0, ends = 0, pool: Pool | undefined;
  const client = Object.assign(new EventEmitter(), { async query(sql: string) {
    queries.push(sql);
    return probe ? await probe() : { rowCount: 1, rows: [{ database: "ledger", system_identifier: "123456789" }] };
  }, release(broken: boolean) { releases.push(broken); if (releaseThrows) throw Error("disposal failed"); } }) as unknown as PoolClient;
  const seen = new WeakSet<Pool>();
  t.mock.method(Pool.prototype, "connect", async function(this: Pool) {
    connects++; pool = this;
    if (!seen.has(this)) { seen.add(this); this.emit("connect", client); }
    return client;
  });
  t.mock.method(Pool.prototype, "end", async () => { ends++; });
  return { client, queries, releases, get connects() { return connects; }, get ends() { return ends; }, get pool() { return pool!; } };
}

test("owned provider verifies cluster and DB on the same leased client; exposes only frozen fixed binding", async t => {
  const f = setup(t), provider = createUploadLedgerProvider(config());
  const pin = provider.pin(policy())!;
  assert.ok(pin);
  const checked = await provider.checkout(pin);
  assert.equal(checked.status, "acquired");
  if (checked.status !== "acquired") throw Error("not acquired");
  assert.match(f.queries[0], /pg_catalog\.pg_control_system\(\)/);
  assert.equal(f.queries.length, 1);
  assert.equal(f.connects, 1);
  assert.equal(checked.pin, pin);
  assert.ok(Object.isFrozen(checked.binding));
  assert.ok(Object.isFrozen(checked.binding.tables));
  assert.deepEqual(Object.keys(provider).sort(), ["binding", "checkout", "close", "pin"]);
  assert.equal(checked.binding.tables.domains, '"public"."upload_resource_domains"');
  assert.equal(checked.lease.finalize(false), "released");
  assert.deepEqual(f.releases, [false]);
  await provider.close();
});

test("foreign, standalone, forged and copied pins fail before checkout", async t => {
  const f = setup(t), a = createUploadLedgerProvider(config()), b = createUploadLedgerProvider(config());
  const pin = a.pin(policy())!;
  const standalone = pinUploadResourcePolicy(policy(), policy().identity)!;
  for (const bad of [b.pin(policy())!, standalone, { ...pin }, JSON.parse(JSON.stringify(pin)), null]) {
    assert.deepEqual(await a.checkout(bad), { status: "failed" });
  }
  assert.equal(f.connects, 0);
  await a.close(); await b.close();
});

test("policy database and schema must match trusted provider, without getter execution", async t => {
  const f = setup(t), provider = createUploadLedgerProvider(config());
  for (const key of ["database", "schema"] as const) {
    const p = policy(); p.identity[key] = "other";
    assert.equal(provider.pin(p), null);
  }
  let reads = 0;
  const p = policy();
  Object.defineProperty(p.identity, "namespace", { get() { reads++; return "x"; } });
  assert.equal(provider.pin(p), null);
  assert.equal(reads, 0); assert.equal(f.connects, 0);
  await provider.close();
});

test("wrong cluster, same-name DB on another cluster, wrong DB and malformed probes destroy and deny", async t => {
  let result: unknown;
  const f = setup(t, async () => result), provider = createUploadLedgerProvider(config());
  for (const value of [
    { rowCount: 1, rows: [{ database: "ledger", system_identifier: "987654321" }] },
    { rowCount: 1, rows: [{ database: "other", system_identifier: "123456789" }] },
    { rowCount: 1, rows: [{ database: "ledger", system_identifier: 123456789 }] },
    { rowCount: 0, rows: [] }, { rowCount: 1, rows: [] }, null,
  ]) {
    result = value;
    assert.deepEqual(await provider.checkout(provider.pin(policy())!), { status: "failed" });
  }
  assert.equal(f.connects, 6);
  assert.deepEqual(f.releases, Array(6).fill(true));
  assert.equal(f.queries.length, 6); // identity probe ONLY, never BEGIN/mutation
  await provider.close();
});

test("permission/probe error and disposal failure stay denied with one disposal attempt", async t => {
  const f = setup(t, async () => { throw Error("permission denied"); }, true);
  const provider = createUploadLedgerProvider(config());
  assert.deepEqual(await provider.checkout(provider.pin(policy())!), { status: "failed" });
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.queries.length, 1);
  await provider.close();
});

test("config mutation across await cannot redirect owned pool or rewrite canonical identity", async t => {
  const f = setup(t), c = config(), provider = createUploadLedgerProvider(c);
  const pin = provider.pin(policy())!;
  c.host = "other.invalid"; c.database = "other"; c.clusterIdentity = "other"; c.systemIdentifier = "9"; c.password = "changed";
  const checked = await provider.checkout(pin);
  assert.equal(checked.status, "acquired");
  if (checked.status !== "acquired") throw Error("not acquired");
  assert.equal(f.pool.options.host, "ledger.invalid");
  assert.equal(f.pool.options.database, "ledger");
  assert.deepEqual(f.pool.options.ssl, { rejectUnauthorized: true });
  assert.equal(f.pool.options.max, 4);
  assert.equal(f.pool.options.options, "-c search_path=pg_catalog");
  assert.equal(await (f.pool.options.password as () => Promise<string>)(), "fixture-only");
  checked.lease.finalize(false); await provider.close();
});

test("closing during identity probe denies pending result and destroys once; close is idempotent", async t => {
  let complete!: (value: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  const f = setup(t, () => pending), provider = createUploadLedgerProvider(config());
  const pin = provider.pin(policy())!, checkout = provider.checkout(pin);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.queries.length, 1);
  await provider.close();
  complete({ rowCount: 1, rows: [{ database: "ledger", system_identifier: "123456789" }] });
  assert.deepEqual(await checkout, { status: "failed" });
  assert.deepEqual(f.releases, [true]);
  assert.equal(provider.pin(policy()), null);
  assert.deepEqual(await provider.checkout(pin), { status: "failed" });
  await provider.close(); assert.equal(f.ends, 1);
});

test("idle pool error poisons provider and denies new work without an unhandled error", async t => {
  const f = setup(t), provider = createUploadLedgerProvider(config());
  const pin = provider.pin(policy())!, result = await provider.checkout(pin);
  if (result.status !== "acquired") throw Error("not acquired");
  result.lease.finalize(false);
  f.pool.emit("error", Error("idle connection lost"));
  assert.equal(provider.pin(policy()), null);
  assert.deepEqual(await provider.checkout(pin), { status: "failed" });
  assert.equal(f.connects, 1); await provider.close();
});

test("invalid provisioning config rejects before opening any connection", async t => {
  const f = setup(t);
  for (const invalid of [{ host: "" }, { host: "/tmp/socket" }, { clusterIdentity: "" }, { port: 0 }, { port: 65536 }, { port: 1.5 },
    { database: " bad " }, { systemIdentifier: "01" }, { systemIdentifier: "0" },
    { systemIdentifier: "18446744073709551616" }, { ca: "" }]) {
    assert.throws(() => createUploadLedgerProvider({ ...config(), ...invalid }), /Invalid trusted/);
  }
  assert.equal(f.connects, 0);
});

test("checked-out connection error during identity probing poisons and denies even a late successful probe", async t => {
  let complete!: (value: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  const f = setup(t, () => pending), provider = createUploadLedgerProvider(config());
  const pin = provider.pin(policy())!, checkout = provider.checkout(pin);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.queries.length, 1);
  assert.doesNotThrow(() => f.client.emit("error", Error("active socket lost")));
  complete({ rowCount: 1, rows: [{ database: "ledger", system_identifier: "123456789" }] });
  assert.deepEqual(await checkout, { status: "failed" });
  assert.deepEqual(f.releases, [true]);
  assert.deepEqual(await provider.checkout(pin), { status: "failed" });
  assert.equal(f.connects, 1); await provider.close();
});
