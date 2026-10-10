import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { createUploadResourceSqlWork } from "./upload-resource-sql";
import { pinUploadResourcePolicy } from "./upload-resource-policy-pin";
import { runUploadLedgerTransaction } from "./upload-ledger-transaction";
import { createUploadLedgerProvider } from "./upload-ledger-provider";

type Context = Parameters<Parameters<typeof runUploadLedgerTransaction>[2]>[0];
function fixture() {
  const identity = { database: '["cluster","postgres"]', schema: "public", quotaDomain: "volume",
    namespace: "a", policyVersion: "v1", writerGeneration: "g1" };
  const policy = { identity, adapter: "multer-crossing-byte-v1",
    layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
    stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 6,
    allocationUnitBytes: 4, allocationCopies: 1, directoryAndParentBytes: 10,
    metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 };
  const pin = pinUploadResourcePolicy(policy, identity)!;
  const domain = { database_identity: identity.database, schema_identity: "public", quota_domain: "volume",
    writer_generation: "g1", active: true, audit_id: "cut1", capacity_bytes: "100",
    headroom_bytes: "10", baseline_bytes: "9", outstanding_bytes: "40", capacity_objects: "20",
    headroom_objects: "2", baseline_objects: "3", outstanding_objects: "10" };
  const provenance = { auditId: "cut1", operationId: "operation1", writerId: "writer1" };
  const attemptId = "eb346dc1-a14d-4e15-a2b5-d5f511fcbca8";
  const result = (command: string, rows: Record<string, unknown>[]) => ({ command, rows, rowCount: rows.length, oid: 0, fields: [] });
  const replies = [result("SELECT", [domain]), result("SELECT", [{ policy_snapshot: structuredClone(policy) }]),
    result("UPDATE", [{ outstanding_bytes: "81", outstanding_objects: "15" }]), result("INSERT", [{ attempt_id: attemptId }])];
  const calls: { sql: string; values?: unknown[] }[] = [];
  let failAt = -1;
  const query: Context["query"] = async (sql, values) => {
    calls.push({ sql, values });
    if (calls.length - 1 === failAt) throw Error("controlled DB failure");
    return replies[calls.length - 1];
  };
  const context: Context = { pin, attemptId, query, binding: { database: identity.database, schema: "public",
    tables: { domains: '"public"."upload_resource_domains"', policies: '"public"."upload_resource_policies"',
      attempts: '"public"."upload_resource_attempts"' } } };
  const work = createUploadResourceSqlWork(pin, policy, provenance)!;
  return { policy, pin, domain, provenance, replies, calls, context, work, fail: (index: number) => { failAt = index; } };
}

test("fixed-table callback locks canonical domain then policy, charges both and inserts exact UUID/snapshot", async () => {
  const f = fixture();
  assert.equal(await f.work(f.context), "prepared");
  assert.equal(f.calls.length, 4);
  assert.match(f.calls[0].sql, /FOR UPDATE$/);
  assert.deepEqual(f.calls[0].values, [f.policy.identity.database, "public", "volume"]);
  for (const dim of ["bytes", "objects"]) for (const prefix of ["capacity", "headroom", "baseline", "outstanding"])
    assert.ok(f.calls[0].sql.includes(prefix + "_" + dim + "::text"));
  assert.match(f.calls[1].sql, /FOR SHARE$/);
  assert.deepEqual(f.calls[2].values?.slice(3), ["81", "15"]);
  assert.deepEqual(f.calls[3].values?.slice(0, 12), [f.context.attemptId, f.policy.identity.database, "public", "volume",
    "a", "v1", "g1", "cut1", "operation1", "writer1", "41", "5"]);
  assert.deepEqual(JSON.parse(f.calls[3].values?.[12] as string), f.policy);
  assert.ok(f.calls.every(c => !/BEGIN|COMMIT|ROLLBACK|ON CONFLICT/.test(c.sql)));
});

test("callback snapshots trusted input before await, no caller charges or SQL interpolation", async () => {
  const f = fixture();
  f.policy.metadataBytes = 0; f.policy.identity.namespace = "evil'; DROP TABLE x;--";
  f.provenance.operationId = "changed"; f.provenance.auditId = "changed";
  assert.equal(await f.work(f.context), "prepared");
  assert.equal(f.calls[3].values?.[8], "operation1");
  assert.equal(f.calls[1].values?.[3], "a");
  assert.ok(!f.calls.some(c => c.sql.includes("evil")));
});

test("wrong pin, provider binding or attempt UUID deny before SQL", async () => {
  for (const patch of [{ pin: {} }, { binding: { database: "other", schema: "public" } }, { attemptId: "request-id" }]) {
    const f = fixture();
    assert.equal(await f.work({ ...f.context, ...patch } as Context), "denied");
    assert.equal(f.calls.length, 0);
  }
});

test("invalid provenance/policy rejected before constructing work", () => {
  const f = fixture();
  for (const key of ["auditId", "operationId", "writerId"]) for (const value of ["", " bad", "a\n", "x".repeat(513)])
    assert.equal(createUploadResourceSqlWork(f.pin, f.policy, { ...f.provenance, [key]: value }), null);
  assert.equal(createUploadResourceSqlWork(f.pin, { ...f.policy, metadataBytes: 0 }, f.provenance), null);
});

test("missing, duplicate or inconsistent row counts deny at each query boundary", async () => {
  for (let index = 0; index < 4; index++) for (const count of [0, 2, null]) {
    const f = fixture(); f.replies[index].rowCount = count as number;
    assert.equal(await f.work(f.context), "denied"); assert.equal(f.calls.length, index + 1);
  }
  for (let index = 0; index < 4; index++) {
    const f = fixture(); f.replies[index].rows.push(f.replies[index].rows[0]);
    assert.equal(await f.work(f.context), "denied"); assert.equal(f.calls.length, index + 1);
  }
});

test("policy swap, generation/audit mismatch or either exhausted dimension deny before mutation", async () => {
  for (const patch of [{ writer_generation: "g2" }, { audit_id: "other" }, { active: false },
    { capacity_bytes: "99" }, { capacity_objects: "19" }, { outstanding_bytes: 40 }]) {
    const f = fixture(); Object.assign(f.domain, patch);
    assert.equal(await f.work(f.context), "denied"); assert.equal(f.calls.length, 2);
  }
  const f = fixture();
  f.replies[1].rows[0].policy_snapshot = { ...f.policy, metadataBytes: 10, temporaryBytes: 13 };
  assert.equal(await f.work(f.context), "denied"); assert.equal(f.calls.length, 2);
});

test("write command tags, returned charges and attempt UUID must match", async () => {
  for (const index of [2, 3]) {
    const f = fixture(); f.replies[index].command = "SELECT";
    assert.equal(await f.work(f.context), "denied");
  }
  for (const key of ["outstanding_bytes", "outstanding_objects"]) {
    const f = fixture(); f.replies[2].rows[0][key] = "0";
    assert.equal(await f.work(f.context), "denied"); assert.equal(f.calls.length, 3);
  }
  const f = fixture(); f.replies[3].rows[0].attempt_id = "other";
  assert.equal(await f.work(f.context), "denied");
});

test("query errors propagate to outer rollback without retry or local transaction control", async () => {
  for (let index = 0; index < 4; index++) {
    const f = fixture(); f.fail(index);
    await assert.rejects(f.work(f.context), /controlled DB failure/);
    assert.equal(f.calls.length, index + 1);
    assert.equal(await f.work(f.context), "denied"); assert.equal(f.calls.length, index + 1);
  }
});

test("one callback cannot prepare a second attempt after success or denial", async () => {
  for (const denied of [false, true]) {
    const f = fixture(); if (denied) f.domain.active = false;
    assert.equal(await f.work(f.context), denied ? "denied" : "prepared");
    const count = f.calls.length;
    assert.equal(await f.work({ ...f.context, attemptId: "8aa6051f-b334-4f2d-a8c3-cd4055bf3456" }), "denied");
    assert.equal(f.calls.length, count);
  }
});

function composed(t: TestContext, mode: "success" | "deny" | "insert-error" | "lost-commit") {
  const f = fixture(), commands: string[] = [], releases: boolean[] = [];
  let index = 0, insertedId: unknown;
  if (mode === "deny") f.domain.capacity_objects = "19";
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string, values?: unknown[]) {
      commands.push(sql);
      if (sql.includes("pg_control_system")) return { command: "SELECT", rowCount: 1,
        rows: [{ database: "postgres", system_identifier: "123" }] };
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) {
        if (sql === "COMMIT" && mode === "lost-commit") throw Error("lost COMMIT acknowledgement");
        return { command: sql.split(" ")[0], rowCount: null, rows: [] };
      }
      if (sql.startsWith("INSERT")) {
        if (mode === "insert-error") throw Error("constraint failure");
        insertedId = values![0]; f.replies[3].rows[0].attempt_id = insertedId;
      }
      return f.replies[index++];
    },
    release(broken: boolean) { releases.push(broken); },
  }) as unknown as PoolClient;
  t.mock.method(Pool.prototype, "connect", async function(this: Pool) { this.emit("connect", client); return client; });
  t.mock.method(Pool.prototype, "end", async () => {});
  const provider = createUploadLedgerProvider({ host: "fixture.invalid", port: 5432, user: "fixture",
    password: "fixture", database: "postgres", clusterIdentity: "cluster", systemIdentifier: "123" });
  t.after(() => provider.close());
  const pin = provider.pin(f.policy)!;
  const work = createUploadResourceSqlWork(pin, f.policy, f.provenance)!;
  return { run: () => runUploadLedgerTransaction(provider, pin, work), commands, releases, get insertedId() { return insertedId; } };
}

test("composed provider/transaction/callback commits exactly the generated attempt then releases", async t => {
  const f = composed(t, "success"), result = await f.run();
  assert.equal(result.status, "committed"); assert.equal(result.attemptId, f.insertedId);
  assert.equal(f.commands.at(-1), "COMMIT"); assert.deepEqual(f.releases, [false]);
});

for (const mode of ["deny", "insert-error"] as const) {
  test("composed " + mode + " rolls back without dispatching COMMIT", async t => {
    const f = composed(t, mode), result = await f.run();
    assert.equal(result.status, "not-committed"); assert.equal(result.commitDispatched, false);
    assert.equal(f.commands.at(-1), "ROLLBACK"); assert.ok(!f.commands.includes("COMMIT"));
    assert.equal(f.commands.filter(c => c.startsWith("UPDATE")).length, mode === "deny" ? 0 : 1);
    assert.deepEqual(f.releases, [false]);
  });
}

test("composed lost COMMIT ACK preserves exact inserted identity and never rolls back/retries", async t => {
  const f = composed(t, "lost-commit"), result = await f.run();
  assert.equal(result.status, "unknown"); assert.equal(result.commitDispatched, true);
  assert.equal(result.attemptId, f.insertedId);
  assert.equal(f.commands.filter(c => c.startsWith("INSERT")).length, 1);
  assert.equal(f.commands.filter(c => c === "COMMIT").length, 1);
  assert.ok(!f.commands.includes("ROLLBACK")); assert.deepEqual(f.releases, [true]);
});
