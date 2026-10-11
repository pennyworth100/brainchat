import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { createStrictUploadLedgerProvider } from "./upload-ledger-provider";
import { bindStrictUploadRoot } from "./upload-storage-root";
import { StrictUploadAccounting } from "./strict-upload-accounting";

async function fixture(t: TestContext, onQuery: (sql: string) => Promise<void> = async () => {}, ceiling = 8,
  commitTag = "COMMIT") {
  let now = 0, connections = 0;
  const commands: string[] = [], inserts: unknown[][] = [], releases: boolean[] = [];
  const identity = { database: '["cluster","postgres"]', schema: "public", quotaDomain: "volume",
    namespace: "/synthetic-root-never-opened", policyVersion: "v1", writerGeneration: "g1" };
  const policy = { identity, adapter: "resume-strict-writer-v1",
    layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
    stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 8,
    allocationUnitBytes: 4, allocationCopies: 1, directoryAndParentBytes: 10,
    metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 };
  const databasePolicy = structuredClone(policy);
  const domain = { database_identity: identity.database, schema_identity: "public", quota_domain: "volume",
    writer_generation: "g1", active: true, audit_id: "cut1", capacity_bytes: "100",
    headroom_bytes: "10", baseline_bytes: "9", outstanding_bytes: "40", capacity_objects: "20",
    headroom_objects: "2", baseline_objects: "3", outstanding_objects: "10" };
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string, values?: unknown[]) {
      commands.push(sql); await onQuery(sql);
      let rows: unknown[] = [];
      if (sql.includes("pg_control_system")) rows = [{ database: "postgres", system_identifier: "123" }];
      else if (sql.includes("FROM public.upload_resource_domains")) rows = [domain];
      else if (sql.includes("FROM public.upload_resource_policies")) rows = [{ policy_snapshot: databasePolicy }];
      else if (sql.startsWith("UPDATE")) rows = [{ outstanding_bytes: values![3], outstanding_objects: values![4] }];
      else if (sql.startsWith("INSERT")) { inserts.push(values!); rows = [{ attempt_id: values![0] }]; }
      return { command: sql === "COMMIT" ? commitTag : sql.split(" ")[0], rows, rowCount: rows.length };
    },
    release(broken: boolean) { releases.push(broken); },
  }) as unknown as PoolClient;
  t.mock.method(Pool.prototype, "connect", async function(this: Pool) {
    connections++; this.emit("connect", client); return client;
  });
  t.mock.method(Pool.prototype, "end", async () => {});
  for (const method of ["open", "mkdir", "writeFile"] as const) {
    t.mock.method(fs, method, async () => { assert.fail("accounting must never perform filesystem IO"); });
  }
  const provider = createStrictUploadLedgerProvider({ host: "fixture.invalid", port: 5432,
    user: "fixture", password: "fixture", database: "postgres", clusterIdentity: "cluster", systemIdentifier: "123" });
  t.after(() => provider.close());
  const pin = provider.pin(policy)!;
  // Synthetic expected identity, never a real physical assertion or root open.
  const root = bindStrictUploadRoot(pin, policy, { path: identity.namespace, device: "1", inode: "2",
    uid: process.geteuid!(), gid: process.getegid!() })!;
  const bindings = new ResumeBindings();
  const binding = await bindings.activate({ sessionId: "session", roomId: "files123", username: "Guest",
    authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
  "transport_upload_fixture", async () => {}, () => true);
  assert.ok(binding);
  const admissions = new ResumeUploadAdmissions(bindings, new ResumeCapacity(1), ceiling, 100, () => now);
  const grant = admissions.admit(binding)!;
  t.after(() => { admissions.release(grant); });
  const provenance = { auditId: "cut1", writerId: "writer1" };
  const make = () => new StrictUploadAccounting(admissions, provider, pin, policy, root, provenance);
  const bridge = make();
  return { bridge, make, grant, admissions, binding, policy, provenance, commands, inserts, releases, provider, pin, root,
    expire: () => { now = 100; }, connections: () => connections };
}

test("committed receipt binds exact grant/root/pin/limit/operation/attempt; copies cannot resolve", async t => {
  const f = await fixture(t);
  const result = await f.bridge.reserve(f.grant, "message_1");
  assert.ok(result.status === "settled" && result.receipt);
  assert.equal(result.outcome.status, "committed");
  const record = f.bridge.resolve(f.grant, result.receipt)!;
  assert.equal(record.attemptId, f.inserts[0][0]); assert.equal(record.operationId, f.inserts[0][8]);
  assert.equal(record.clientMessageId, "message_1"); assert.equal(record.limit, 8);
  assert.equal(record.grant, f.grant); assert.ok(Object.isFrozen(record));
  assert.equal(f.bridge.resolve({ ...f.grant }, result.receipt), null);
  assert.equal(f.bridge.resolve(f.grant, { ...result.receipt }), null);
  assert.equal(f.make().resolve(f.grant, result.receipt), null);
  assert.deepEqual(await f.make().reserve(f.grant, "message_2"), { status: "denied" });
  assert.equal(f.connections(), 1); assert.equal(f.admissions.admit(f.binding), null);
  f.expire(); assert.equal(f.bridge.resolve(f.grant, result.receipt), null);
});

test("admission ceiling mismatch denies before checkout", async t => {
  const f = await fixture(t, undefined, 9);
  assert.deepEqual(await f.bridge.reserve(f.grant, "key"), { status: "denied" });
  assert.equal(f.connections(), 0); assert.equal(f.admissions.admit(f.binding), null);
});

test("copied root/pin and invalid provenance cannot construct a coordinator", async t => {
  const f = await fixture(t);
  assert.throws(() => new StrictUploadAccounting(f.admissions, f.provider, f.pin,
    f.policy, { ...f.root }, f.provenance), /configuration denied/);
  assert.throws(() => new StrictUploadAccounting(f.admissions, f.provider, { ...f.pin },
    f.policy, f.root, f.provenance), /configuration denied/);
  assert.throws(() => new StrictUploadAccounting(f.admissions, f.provider, f.pin,
    f.policy, f.root, { auditId: "", writerId: "writer" }), /configuration denied/);
  assert.equal(f.connections(), 0);
});

test("effective identity drift after construction denies before checkout", async t => {
  const f = await fixture(t), uid = process.geteuid!();
  t.mock.method(process as { geteuid: () => number }, "geteuid", () => uid + 1);
  assert.deepEqual(await f.bridge.reserve(f.grant, "key"), { status: "denied" });
  assert.equal(f.connections(), 0);
});

test("PostgreSQL ROLLBACK tag on COMMIT produces unknown without receipt or replay", async t => {
  const f = await fixture(t, undefined, 8, "ROLLBACK");
  const result = await f.bridge.reserve(f.grant, "key");
  assert.ok(result.status === "settled"); assert.equal(result.outcome.status, "unknown");
  assert.equal(result.receipt, null); assert.equal(result.outcome.attemptId, f.inserts[0][0]);
  assert.ok(!f.commands.includes("ROLLBACK")); assert.deepEqual(f.releases, [true]);
  assert.deepEqual(await f.make().reserve(f.grant, "retry"), { status: "denied" });
  assert.equal(f.admissions.admit(f.binding), null);
});

test("copied, expired and invalid client identities deny before checkout", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.bridge.reserve({ ...f.grant }, "key"), { status: "denied" });
  for (const key of ["", "a b", "x".repeat(129)])
    assert.deepEqual(await f.bridge.reserve(f.grant, key), { status: "denied" });
  f.expire(); assert.deepEqual(await f.bridge.reserve(f.grant, "key"), { status: "denied" });
  assert.equal(f.connections(), 0); assert.equal(f.admissions.admit(f.binding), null);
});

test("configuration snapshots policy and provenance before asynchronous reservation", async t => {
  const f = await fixture(t);
  f.policy.metadataBytes = 0; f.policy.identity.namespace = "/wrong";
  f.provenance.auditId = "wrong"; f.provenance.writerId = "wrong";
  const result = await f.bridge.reserve(f.grant, "key");
  assert.ok(result.status === "settled" && result.receipt);
  assert.equal(f.inserts[0][4], "/synthetic-root-never-opened");
  assert.equal(f.inserts[0][7], "cut1"); assert.equal(f.inserts[0][9], "writer1");
});

for (const phase of ["INSERT", "COMMIT"]) test(phase + " failure never issues receipt, releases admission or retries", async t => {
  const f = await fixture(t, async sql => { if (sql.startsWith(phase)) throw Error("controlled failure"); });
  const result = await f.bridge.reserve(f.grant, "key");
  assert.ok(result.status === "settled"); assert.equal(result.receipt, null);
  assert.equal(result.outcome.status, phase === "COMMIT" ? "unknown" : "not-committed");
  assert.equal(result.outcome.commitDispatched, phase === "COMMIT");
  if (phase === "COMMIT") {
    assert.equal(result.outcome.attemptId, f.inserts[0][0]);
    assert.ok(!f.commands.includes("ROLLBACK"));
  }
  assert.deepEqual(await f.make().reserve(f.grant, "retry"), { status: "denied" });
  assert.equal(f.connections(), 1); assert.equal(f.admissions.admit(f.binding), null);
});

test("expiry during SQL preparation rolls back without COMMIT", async t => {
  const f = await fixture(t, async sql => { if (sql.startsWith("INSERT")) f.expire(); });
  const result = await f.bridge.reserve(f.grant, "key");
  assert.ok(result.status === "settled"); assert.equal(result.receipt, null);
  assert.equal(result.outcome.status, "not-committed");
  assert.equal(f.commands.at(-1), "ROLLBACK"); assert.ok(!f.commands.includes("COMMIT"));
  assert.equal(f.admissions.admit(f.binding), null);
});

test("pending COMMIT remains pending past deadline; later ACK preserves accounting but no receipt", async t => {
  let finish!: () => void, entered!: () => void;
  const commit = new Promise<void>(r => { finish = r; });
  const atCommit = new Promise<void>(r => { entered = r; });
  const f = await fixture(t, async sql => { if (sql === "COMMIT") { entered(); await commit; } });
  let settled = false;
  const pending = f.bridge.reserve(f.grant, "key").then(r => { settled = true; return r; });
  await atCommit; f.expire(); await new Promise(r => setImmediate(r));
  assert.equal(settled, false); assert.equal(f.admissions.admit(f.binding), null);
  assert.deepEqual(await f.make().reserve(f.grant, "retry"), { status: "denied" });
  finish(); const result = await pending;
  assert.ok(result.status === "settled"); assert.equal(result.outcome.status, "committed");
  assert.equal(result.receipt, null); assert.equal(result.outcome.attemptId, f.inserts[0][0]);
  assert.equal(f.admissions.admit(f.binding), null);
});
