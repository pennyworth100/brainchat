/** Executable transaction experiment ONLY. No application imports, live DDL,
 * provisioning, storage capability, physical fence, refunds or migration.
 * Identity/audit/costs below are synthetic fixture assertions, not observations.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

function exact(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw Error("Invalid bigint encoding");
  const n = BigInt(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("Unsafe bigint");
  return n;
}

async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  if (!connectionString) throw Error("RESUME_TEST_DATABASE_URL required (owned isolated DB only)");
  const schema = "vector_qa_" + randomBytes(8).toString("hex");
  const q = '"' + schema + '"'; // generated identifier, never request input
  const pool = new Pool({ connectionString, max: 16, connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=10000 -c lock_timeout=5000" });
  let checks = 0;
  const check = (value: unknown) => { assert.ok(value); checks++; };
  type Outcome = { status: "reserved" | "denied" | "failed"; key: string; commit?: "unknown" | "not-dispatched" };
  // Fixed trusted fixture DB/schema and qualified tables; a production connection
  // authority, opaque grant and audited quote recomputation are NOT implemented.
  const databaseIdentity = "owned-fixture-cluster/postgres";
  async function reserve(namespace: string, version = "v1", generation = "g1",
    fault?: "insert" | "ack", beforeLock?: (pid: number) => void): Promise<Outcome> {
    const key = randomBytes(32).toString("hex");
    const client = await pool.connect();
    let dispatched = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      if (beforeLock) beforeLock((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const domains = await client.query(`SELECT * FROM ${q}.domains WHERE quota_domain=$1 FOR UPDATE`, ["physical-volume"]);
      const d = domains.rows[0];
      const deny = async (): Promise<Outcome> => { await client.query("ROLLBACK"); return { status: "denied", key }; };
      if (domains.rowCount !== 1 || d.active !== true || d.audit !== "fixture-cut-1" ||
          d.database_identity !== databaseIdentity || d.schema_identity !== schema || d.generation !== generation) return await deny();
      const policies = await client.query(`SELECT * FROM ${q}.policies WHERE quota_domain=$1 AND namespace=$2`, [d.quota_domain, namespace]);
      const p = policies.rows[0];
      if (policies.rowCount !== 1 || p.version !== version || p.generation !== generation ||
          p.database_identity !== databaseIdentity || p.schema_identity !== schema ||
          p.adapter !== "synthetic-one-directory-one-file") return await deny();
      const bytes = exact(p.bytes), objects = exact(p.objects);
      if (bytes < 1n || objects < 2n) return await deny();
      for (const [dimension, cost] of [["bytes", bytes], ["objects", objects]] as const) {
        const capacity = exact(d["capacity_" + dimension]);
        const headroom = exact(d["headroom_" + dimension]);
        const baseline = exact(d["baseline_" + dimension]);
        const outstanding = exact(d["outstanding_" + dimension]);
        if (capacity < 1n || cost > capacity - headroom - baseline - outstanding) return await deny();
      }
      const updated = await client.query(`UPDATE ${q}.domains SET outstanding_bytes=outstanding_bytes+$1,
        outstanding_objects=outstanding_objects+$2 WHERE quota_domain=$3`, [bytes.toString(), objects.toString(), d.quota_domain]);
      if (updated.rowCount !== 1) throw Error("Unexpected update count");
      const inserted = await client.query(`INSERT INTO ${q}.attempts
        (key, quota_domain, database_identity, schema_identity, namespace, version, generation, adapter, bytes, objects)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [fault === "insert" ? "reject" : key,
        d.quota_domain, databaseIdentity, schema, namespace, version, generation, p.adapter, bytes.toString(), objects.toString()]);
      if (inserted.rowCount !== 1) throw Error("Unexpected insert count");
      dispatched = true;
      await client.query("COMMIT");
      if (fault === "ack") throw Error("Controlled lost COMMIT acknowledgement");
      return { status: "reserved", key };
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      return { status: "failed", key, commit: dispatched ? "unknown" : "not-dispatched" };
    } finally { client.release(); }
  }
  const snapshot = async () => ({
    domains: (await pool.query(`SELECT * FROM ${q}.domains ORDER BY quota_domain`)).rows,
    attempts: (await pool.query(`SELECT * FROM ${q}.attempts ORDER BY key`)).rows,
  });
  try {
    await pool.query(`CREATE SCHEMA ${q}`);
    // Deliberately fixture-local DDL, not an application migration or seed.
    await pool.query(`CREATE TABLE ${q}.domains (
      quota_domain text PRIMARY KEY, database_identity text NOT NULL, schema_identity text NOT NULL,
      generation text NOT NULL, active boolean NOT NULL, audit text NOT NULL,
      capacity_bytes bigint NOT NULL, capacity_objects bigint NOT NULL,
      headroom_bytes bigint NOT NULL, headroom_objects bigint NOT NULL,
      baseline_bytes bigint NOT NULL, baseline_objects bigint NOT NULL,
      outstanding_bytes bigint NOT NULL, outstanding_objects bigint NOT NULL);
      CREATE TABLE ${q}.policies (
      quota_domain text NOT NULL, namespace text NOT NULL, version text NOT NULL, generation text NOT NULL,
      database_identity text NOT NULL, schema_identity text NOT NULL, adapter text NOT NULL,
      bytes bigint NOT NULL, objects bigint NOT NULL, PRIMARY KEY(quota_domain,namespace));
      CREATE TABLE ${q}.attempts (
      key text PRIMARY KEY CHECK(key <> 'reject'), quota_domain text NOT NULL,
      database_identity text NOT NULL, schema_identity text NOT NULL, namespace text NOT NULL,
      version text NOT NULL, generation text NOT NULL, adapter text NOT NULL,
      bytes bigint NOT NULL, objects bigint NOT NULL)`);
    check((await reserve("a")).status === "denied");
    // 120 - 10 baseline - 10 headroom = 100 bytes; 24 - 2 - 2 = 20 objects.
    await pool.query(`INSERT INTO ${q}.domains VALUES ('physical-volume',$1,$2,'g1',false,'fixture-cut-1',120,24,10,2,10,2,0,0)`, [databaseIdentity, schema]);
    for (const namespace of ["a", "b"]) await pool.query(`INSERT INTO ${q}.policies VALUES
      ('physical-volume',$1,'v1','g1',$2,$3,'synthetic-one-directory-one-file',10,2)`, [namespace, databaseIdentity, schema]);
    check((await reserve("a")).status === "denied");
    await pool.query(`UPDATE ${q}.domains SET active=true`);
    const initial = await snapshot();
    for (const [ns, version, generation] of [["missing","v1","g1"],["a","wrong","g1"],["a","v1","wrong"]]) {
      check((await reserve(ns, version, generation)).status === "denied");
      assert.deepEqual(await snapshot(), initial); checks++;
    }
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => reserve(i % 2 ? "a" : "b")));
    check(results.filter(r => r.status === "reserved").length === 10);
    check(results.filter(r => r.status === "denied").length === 22);
    let state = await snapshot();
    check(state.domains[0].outstanding_bytes === "100" && state.domains[0].outstanding_objects === "20");
    check(state.attempts.length === 10 && new Set(state.attempts.map(a => a.namespace)).size === 2);
    check(state.attempts.reduce((n, a) => n + exact(a.bytes), 0n) === 100n);
    check(state.attempts.reduce((n, a) => n + exact(a.objects), 0n) === 20n);
    // Increase one dimension only; the other must still deny without mutation.
    for (const [bytes, objects] of [[220,24],[120,44]]) {
      await pool.query(`UPDATE ${q}.domains SET capacity_bytes=$1,capacity_objects=$2`, [bytes,objects]);
      const before = await snapshot();
      check((await reserve("a")).status === "denied");
      assert.deepEqual(await snapshot(), before); checks++;
    }
    await pool.query(`UPDATE ${q}.domains SET capacity_bytes=220,capacity_objects=44`);
    const beforeFailure = await snapshot();
    const rejected = await reserve("a", "v1", "g1", "insert");
    check(rejected.status === "failed" && rejected.commit === "not-dispatched");
    assert.deepEqual(await snapshot(), beforeFailure); checks++;
    const unknown = await reserve("b", "v1", "g1", "ack");
    check(unknown.status === "failed" && unknown.commit === "unknown");
    state = await snapshot();
    check(state.domains[0].outstanding_bytes === "110" && state.domains[0].outstanding_objects === "22");
    check(state.attempts.some(a => a.key === unknown.key));
    // Lock-holder changes generation while another connection reaches FOR UPDATE.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT * FROM ${q}.domains FOR UPDATE`);
      let entered!: (pid: number) => void;
      const entering = new Promise<number>(resolve => { entered = resolve; });
      const waiting = reserve("a", "v1", "g1", undefined, entered);
      const pid = await entering;
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (!blocked && Date.now() < deadline) {
        blocked = (await holder.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type === "Lock";
        // Clear PostgreSQL's per-transaction statistics snapshot before recheck.
        if (!blocked) {
          await holder.query("SELECT pg_stat_clear_snapshot()");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      check(blocked);
      await holder.query(`UPDATE ${q}.domains SET generation='g2'`);
      await holder.query(`UPDATE ${q}.policies SET generation='g2',version='v2'`);
      await holder.query("COMMIT");
      check((await waiting).status === "denied");
    } finally { await holder.query("ROLLBACK").catch(() => {}); holder.release(); }
    check((await reserve("a", "v2", "g2")).status === "reserved");
    state = await snapshot();
    check(state.domains[0].outstanding_bytes === "120" && state.domains[0].outstanding_objects === "24");
    check(state.attempts.filter(a => a.generation === "g1").length === 11);
    // Missing audit, wrong DB/schema/adapter and unsafe SQL bigint all fail closed.
    for (const [table, field, value] of [["domains","audit","unknown"], ["domains","database_identity","other-cluster"],
      ["policies","schema_identity","other-schema"], ["policies","adapter","other"],
      ["domains","capacity_bytes","9007199254740992"]]) {
      const old = (await pool.query(`SELECT ${field} FROM ${q}.${table} LIMIT 1`)).rows[0][field];
      await pool.query(`UPDATE ${q}.${table} SET ${field}=$1`, [value]);
      const before = await snapshot();
      check((await reserve("a", "v2", "g2")).status !== "reserved");
      assert.deepEqual(await snapshot(), before); checks++;
      await pool.query(`UPDATE ${q}.${table} SET ${field}=$1`, [old]);
    }
    for (const bad of [1, -1, null, "01", "-1", "1.0", "1e3", "9007199254740992"]) {
      assert.throws(() => exact(bad)); checks++;
    }
    check(exact("9007199254740991") === 9007199254740991n);
    console.log(JSON.stringify({ passed: checks, concurrentAttempts: 32, accepted: 10, denied: 22,
      dimensions: ["bytes","objects"], namespaces: 2, insertRollback: true, lostCommitAck: true,
      generationRecheck: true, monotonicLiabilities: true, fixtureOnly: true, physicalFence: false }));
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`);
    await pool.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
