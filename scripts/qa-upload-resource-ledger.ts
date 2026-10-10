/** Owned-isolated PostgreSQL evidence. Actual migration/callback/transaction/lease,
 * synthetic provider binding (NO TLS/provider/physical-fencing proof).
 * Creates and drops ONE random database on the explicitly opted-in loopback server.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { UploadLedgerLease } from "../src/lib/upload-ledger-lease";
import { runUploadLedgerTransaction } from "../src/lib/upload-ledger-transaction";
import { pinUploadResourcePolicy } from "../src/lib/upload-resource-policy-pin";
import { createUploadResourceSqlWork } from "../src/lib/upload-resource-sql";

async function main() {
  const url = new URL(process.env.RESOURCE_TEST_ADMIN_URL || "");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55439");
  assert.equal(url.pathname, "/postgres");
  const databaseName = "resource_qa_" + randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString: url.href, max: 1 });
  let pool: Pool | undefined, created = false, checks = 0;
  const check = (value: unknown) => { assert.ok(value); checks++; };
  try {
    await admin.query('CREATE DATABASE "' + databaseName + '"'); created = true;
    url.pathname = "/" + databaseName;
    pool = new Pool({ connectionString: url.href, max: 16, connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=10000 -c lock_timeout=5000" });
    const db = pool;
    const postgresVersion = (await db.query("SHOW server_version")).rows[0].server_version;
    await db.query(readFileSync(new URL("../drizzle/0009_upload_resource_ledger.sql", import.meta.url), "utf8"));
    const identity = (namespace = "a", generation = "g1") => ({
      database: "owned-fixture/" + databaseName, schema: "public", quotaDomain: "volume",
      namespace, policyVersion: "v1", writerGeneration: generation,
    });
    const policy = (namespace = "a", generation = "g1") => ({
      identity: identity(namespace, generation), adapter: "multer-crossing-byte-v1",
      layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
      stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 6,
      allocationUnitBytes: 1, allocationCopies: 1, directoryAndParentBytes: 3,
      metadataBytes: 0, temporaryBytes: 0, additionalObjects: 0,
    });
    const database = identity().database;
    const binding = { database, schema: "public", tables: {
      domains: '"public"."upload_resource_domains"', policies: '"public"."upload_resource_policies"',
      attempts: '"public"."upload_resource_attempts"',
    } };
    type Fault = "update" | "insert" | "ack";
    async function reserve(namespace = "a", generation = "g1", operationId = randomUUID() as string,
      fault?: Fault, onPid?: (pid: number) => void) {
      const p = policy(namespace, generation);
      const pin = pinUploadResourcePolicy(p, p.identity)!;
      const work = createUploadResourceSqlWork(pin, p, { auditId: "cut1", operationId, writerId: "writer1" })!;
      const calls: string[] = [];
      let finalized = 0, destroyed = false;
      // Explicit fixture seam: actual PG queries and actual lease/tx/callback,
      // not a substitute for the separately gated TLS authority provider.
      const provider = {
        binding,
        checkout: async () => {
          const client = await db.connect();
          if (onPid) onPid((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          const lease = new UploadLedgerLease({
            query: (async (sql: string, values?: unknown[]) => {
              calls.push(sql);
              if (fault === "update" && sql.startsWith("UPDATE")) {
                return await client.query("UPDATE public.upload_resource_domains SET outstanding_bytes=-1");
              }
              if (fault === "insert" && sql.startsWith("INSERT")) {
                const invalid = [...values!]; invalid[8] = ""; // DB provenance CHECK fails AFTER UPDATE.
                return await client.query(sql, invalid);
              }
              const result = await client.query(sql, values);
              if (fault === "ack" && sql === "COMMIT") throw Error("controlled lost COMMIT acknowledgement");
              return result;
            }) as PoolClient["query"],
            release: (broken?: boolean) => { finalized++; destroyed = !!broken; client.release(broken); },
          });
          return { status: "acquired" as const, lease, binding, pin };
        },
      } as unknown as Parameters<typeof runUploadLedgerTransaction>[0];
      const result = await runUploadLedgerTransaction(provider, pin, work);
      check(finalized === 1);
      return { ...result, calls, destroyed };
    }
    const state = async () => ({
      domains: (await db.query("SELECT * FROM public.upload_resource_domains ORDER BY quota_domain")).rows,
      attempts: (await db.query("SELECT * FROM public.upload_resource_attempts ORDER BY attempt_id")).rows,
    });
    const deniedUnchanged = async (action: () => Promise<{ status: string }>) => {
      const before = await state(); check((await action()).status === "not-committed");
      assert.deepEqual(await state(), before); checks++;
    };
    const rejects = async (sql: string, args?: unknown[], code = "23514") => {
      await assert.rejects(db.query(sql, args), (error: { code?: string }) => error.code === code); checks++;
    };
    for (const table of ["domains", "policies", "attempts"])
      check((await db.query("SELECT count(*)::int AS n FROM public.upload_resource_" + table)).rows[0].n === 0);
    await deniedUnchanged(() => reserve());
    await db.query(`INSERT INTO public.upload_resource_domains VALUES
      ($1,'public','volume','g1',false,'cut1',120,10,10,0,24,2,2,0)`, [database]);
    const insertPolicy = async (ns: string, gen = "g1") => db.query(
      "INSERT INTO public.upload_resource_policies VALUES ($1,'public','volume',$2,'v1',$3,$4::jsonb)",
      [database, ns, gen, JSON.stringify(policy(ns, gen))]);
    await insertPolicy("a"); await insertPolicy("b");
    await deniedUnchanged(() => reserve()); // inactive domain
    await db.query("UPDATE public.upload_resource_domains SET active=true");
    await deniedUnchanged(() => reserve("missing"));
    await deniedUnchanged(() => reserve("a", "g2"));
    for (const column of ["capacity_bytes", "capacity_objects"]) {
      await rejects("UPDATE public.upload_resource_domains SET " + column + "=0");
      await rejects("UPDATE public.upload_resource_domains SET " + column + "=9007199254740992");
    }
    for (const column of ["outstanding_bytes", "outstanding_objects", "baseline_bytes", "headroom_objects"])
      await rejects("UPDATE public.upload_resource_domains SET " + column + "=-1");
    await rejects("UPDATE public.upload_resource_domains SET outstanding_bytes=101");
    await rejects("UPDATE public.upload_resource_domains SET outstanding_objects=21");
    await rejects("UPDATE public.upload_resource_domains SET audit_id=''");
    for (const value of [null, {}, { ...policy(), maxFileBytes: null },
      { ...policy(), allocationCopies: 0 }, { ...policy(), metadataBytes: 0.5 },
      { ...policy(), additionalObjects: 9007199254740992 },
      { ...policy(), identity: identity("wrong") }])
      await rejects("UPDATE public.upload_resource_policies SET policy_snapshot=$1::jsonb WHERE namespace='a'", [JSON.stringify(value)]);
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => reserve(i % 2 ? "a" : "b")));
    check(results.filter(x => x.status === "committed").length === 10);
    check(results.filter(x => x.status === "not-committed").length === 22);
    let s = await state();
    check(s.domains[0].outstanding_bytes === "100" && s.domains[0].outstanding_objects === "20");
    check(s.attempts.length === 10 && new Set(s.attempts.map(a => a.namespace)).size === 2);
    for (const attempt of s.attempts) {
      assert.deepEqual(attempt.policy_snapshot, policy(attempt.namespace)); checks++;
      check(attempt.allocated_bytes === "10" && attempt.objects === "2");
    }
    for (const [bytes, objects] of [[220,24],[120,44]]) {
      await db.query("UPDATE public.upload_resource_domains SET capacity_bytes=$1, capacity_objects=$2", [bytes, objects]);
      await deniedUnchanged(() => reserve());
    }
    await db.query("UPDATE public.upload_resource_domains SET capacity_bytes=320, capacity_objects=64");
    for (const fault of ["update", "insert"] as const)
      await deniedUnchanged(() => reserve("a", "g1", randomUUID(), fault));
    const op = randomUUID();
    check((await reserve("a", "g1", op)).status === "committed");
    await deniedUnchanged(() => reserve("b", "g1", op)); // same domain, different namespace
    const unknown = await reserve("b", "g1", randomUUID(), "ack");
    check(unknown.status === "unknown" && unknown.commitDispatched && unknown.destroyed);
    check(!unknown.calls.includes("ROLLBACK"));
    check((await db.query("SELECT count(*)::int AS n FROM public.upload_resource_attempts WHERE attempt_id=$1",
      [unknown.attemptId])).rows[0].n === 1);
    s = await state(); check(s.domains[0].outstanding_bytes === "120" && s.domains[0].outstanding_objects === "24");
    const blocker = await db.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM public.upload_resource_domains FOR UPDATE");
      let waiterPid = 0;
      const waiter = reserve("a", "g1", randomUUID(), undefined, pid => { waiterPid = pid; });
      let observedLock = false;
      for (let tries = 0; tries < 100; tries++) {
        if (waiterPid) observedLock = (await db.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [waiterPid])).rows[0]?.wait_event_type === "Lock";
        if (observedLock) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      check(observedLock);
      await blocker.query("UPDATE public.upload_resource_domains SET writer_generation='g2'");
      await blocker.query("COMMIT");
      check((await waiter).status === "not-committed");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    await insertPolicy("a", "g2");
    await deniedUnchanged(() => reserve("a", "g2", op)); // operation uniqueness survives generation change
    check((await reserve("a", "g2")).status === "committed");
    s = await state(); check(s.domains[0].outstanding_bytes === "130" && s.domains[0].outstanding_objects === "26");
    // PG16 reports foreign_key_violation (23503); PG18 reports
    // restrict_violation (23001). Require the specific FK and actual preservation,
    // not just any rejected DELETE (e.g. permissions or missing relation).
    const restrictiveDeletes: { constraint: string; code: string }[] = [];
    for (const [sql, constraint, table] of [
      ["DELETE FROM public.upload_resource_policies WHERE namespace='a' AND writer_generation='g1'",
        "resource_attempt_policy_fk", "upload_resource_attempts"],
      ["DELETE FROM public.upload_resource_domains",
        "resource_policy_domain_fk", "upload_resource_policies"],
    ]) {
      const fk = await db.query(`SELECT confdeltype, confupdtype FROM pg_catalog.pg_constraint
        WHERE conrelid=$1::regclass AND conname=$2`, ["public." + table, constraint]);
      assert.deepEqual(fk.rows, [{ confdeltype: "r", confupdtype: "r" }]); checks++;
      const before = await state();
      const policiesBefore = (await db.query("SELECT * FROM public.upload_resource_policies ORDER BY namespace, writer_generation")).rows;
      await assert.rejects(db.query(sql), (error: { code?: string; constraint?: string }) => {
        if (error.constraint !== constraint || !["23503", "23001"].includes(error.code || "")) return false;
        restrictiveDeletes.push({ constraint, code: error.code! });
        return true;
      }); checks++;
      assert.deepEqual(await state(), before); checks++;
      assert.deepEqual((await db.query("SELECT * FROM public.upload_resource_policies ORDER BY namespace, writer_generation")).rows,
        policiesBefore); checks++;
    }
    console.log(JSON.stringify({ status: "PASS", checks, concurrent: { requests: 32, committed: 10, denied: 22 },
      postgresVersion, restrictiveDeletes,
      finalLiability: { bytes: 130, objects: 26 }, observedGenerationWaiter: true,
      actual: ["migration0009", "SQL callback", "transaction", "lease", "PostgreSQL"],
      excluded: ["TLS provider", "physical fencing", "live migration", "storage authority"] }));
  } finally {
    if (pool) await pool.end();
    if (created) await admin.query('DROP DATABASE "' + databaseName + '"');
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
