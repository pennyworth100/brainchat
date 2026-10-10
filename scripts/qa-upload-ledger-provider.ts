/** Owned loopback TLS fixture ONLY. No live credentials, grants or storage IO.
 * Requires a dedicated PG instance logging statements and a one-day fixture CA.
 * Positive SQL uses an explicitly limited nonsuperuser role in the random DB.
 * All privilege changes are fixture-only; not a managed-platform readiness claim.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createUploadLedgerProvider } from "../src/lib/upload-ledger-provider";
import { runUploadLedgerTransaction } from "../src/lib/upload-ledger-transaction";
import { createUploadResourceSqlWork } from "../src/lib/upload-resource-sql";

async function main() {
  const fixture = process.env.LEDGER_TLS_FIXTURE || "";
  assert.match(fixture, /^\/(?:private\/)?tmp\/dimle-provider-tls-[a-zA-Z0-9_-]+$/);
  const manifest = JSON.parse(readFileSync(fixture + "/fixture.json", "utf8"));
  assert.equal(manifest.kind, "owned-disposable-tls-v1");
  assert.ok(Number.isInteger(manifest.port) && manifest.port > 1024 && manifest.port < 65536);
  const ca = readFileSync(fixture + "/server.crt", "utf8");
  const log = () => readFileSync(fixture + "/server.log", "utf8");
  const connection = { host: "127.0.0.1", port: manifest.port, user: "dimle", password: "",
    ssl: { rejectUnauthorized: true, ca } };
  const admin = new Pool({ ...connection, database: "postgres", max: 1 });
  const suffix = randomBytes(8).toString("hex");
  const database = "provider_qa_" + suffix, role = "provider_unprivileged_" + suffix;
  let db: Pool | undefined, created = false, roleCreated = false, checks = 0;
  const providers: ReturnType<typeof createUploadLedgerProvider>[] = [];
  const check = (value: unknown) => { assert.ok(value); checks++; };
  try {
    const systemIdentifier = (await admin.query("SELECT system_identifier::text FROM pg_control_system()")).rows[0].system_identifier;
    // The unique per-run TLS trust anchor verifies our cluster before mutation.
    await admin.query('CREATE DATABASE "' + database + '"'); created = true;
    await admin.query('CREATE ROLE "' + role + '" LOGIN'); roleCreated = true;
    db = new Pool({ ...connection, database, max: 1 });
    const version = (await db.query("SHOW server_version")).rows[0].server_version;
    await db.query(readFileSync(new URL("../drizzle/0009_upload_resource_ledger.sql", import.meta.url), "utf8"));
    const config = { ...connection, database, clusterIdentity: "owned-tls-fixture", systemIdentifier, ca };
    const make = (overrides: Partial<typeof config> = {}) => {
      const p = createUploadLedgerProvider({ ...config, ...overrides }); providers.push(p); return p;
    };
    let provider = make();
    const policy = { identity: { database: provider.binding.database, schema: "public", quotaDomain: "volume",
      namespace: "a", policyVersion: "v1", writerGeneration: "g1" }, adapter: "multer-crossing-byte-v1",
      layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
      stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 6,
      allocationUnitBytes: 1, allocationCopies: 1, directoryAndParentBytes: 3,
      metadataBytes: 0, temporaryBytes: 0, additionalObjects: 0 };
    let pin = provider.pin(policy)!; check(pin !== null);
    check(provider.pin({ ...policy, identity: { ...policy.identity, database: "wrong" } }) === null);
    for (const table of ["domains", "policies", "attempts"])
      check((await db.query("SELECT count(*)::int AS n FROM public.upload_resource_" + table)).rows[0].n === 0);
    const foreign = make();
    let cursor = log().length;
    check((await foreign.checkout(pin)).status === "failed");
    check(log().slice(cursor).length === 0); // foreign pin rejected without a connection/probe
    const wrong = make({ systemIdentifier: systemIdentifier === "1" ? "2" : "1" });
    cursor = log().length;
    check((await wrong.checkout(wrong.pin(policy)!)).status === "failed");
    const wrongProbe = log().slice(cursor);
    check(wrongProbe.includes("pg_catalog.pg_control_system()"));
    check(!/statement: (BEGIN|INSERT|UPDATE|DELETE)/.test(wrongProbe));
    const untrusted = make({ ca: undefined });
    check((await untrusted.checkout(untrusted.pin(policy)!)).status === "failed");
    const restricted = new Pool({ ...connection, database, user: role, max: 1 });
    let permissionCode = "", defaultRoleCanProbe = false;
    try {
      const r = (await restricted.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
      check(r.rolsuper === false);
      defaultRoleCanProbe = (await restricted.query("SELECT has_function_privilege(current_user, 'pg_catalog.pg_control_system()', 'EXECUTE') AS allowed")).rows[0].allowed;
      if (defaultRoleCanProbe) {
        check((await restricted.query("SELECT system_identifier::text FROM pg_catalog.pg_control_system()")).rows[0].system_identifier === systemIdentifier);
      }
      // PG18 fixture allows this by default: do NOT invent a live permission failure.
      // Revoke ONLY in our random disposable DB to exercise the actual denial path.
      await db.query("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC");
      await assert.rejects(restricted.query("SELECT * FROM pg_catalog.pg_control_system()"), (e: { code?: string }) => {
        permissionCode = e.code || ""; return permissionCode === "42501";
      }); checks++;
    } finally { await restricted.end(); }
    const deniedRole = make({ user: role });
    cursor = log().length;
    check((await deniedRole.checkout(deniedRole.pin(policy)!)).status === "failed");
    const deniedProbe = log().slice(cursor);
    check(deniedProbe.includes("permission denied for function pg_control_system"));
    check(!/statement: (BEGIN|INSERT|UPDATE|DELETE)/.test(deniedProbe));
    // Explicit fixture-only privileges; no ownership, memberships or broad write grant.
    await db.query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO "' + role + '"');
    await db.query('GRANT USAGE ON SCHEMA public TO "' + role + '"');
    await db.query('GRANT SELECT ON public.upload_resource_domains, public.upload_resource_policies TO "' + role + '"');
    await db.query('GRANT UPDATE (outstanding_bytes, outstanding_objects) ON public.upload_resource_domains TO "' + role + '"');
    // PostgreSQL row locks require UPDATE privilege on at least one column.
    await db.query('GRANT UPDATE (policy_snapshot) ON public.upload_resource_policies TO "' + role + '"');
    await db.query('GRANT INSERT, SELECT (attempt_id) ON public.upload_resource_attempts TO "' + role + '"');
    const limited = new Pool({ ...connection, database, user: role, max: 1 });
    try {
      const attrs = (await limited.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      check(Object.values(attrs).every(value => value === false));
      for (const sql of [
        "UPDATE public.upload_resource_domains SET writer_generation='forbidden' WHERE false",
        "DELETE FROM public.upload_resource_domains WHERE false",
        "UPDATE public.upload_resource_policies SET writer_generation='forbidden' WHERE false",
        "DELETE FROM public.upload_resource_policies WHERE false",
        "UPDATE public.upload_resource_attempts SET writer_id='forbidden' WHERE false",
        "DELETE FROM public.upload_resource_attempts WHERE false",
      ]) {
        await assert.rejects(limited.query(sql), (e: { code?: string }) => e.code === "42501"); checks++;
      }
    } finally { await limited.end(); }
    provider = make({ user: role });
    pin = provider.pin(policy)!; check(pin !== null);
    const acquired = await provider.checkout(pin);
    check(acquired.status === "acquired");
    if (acquired.status !== "acquired") throw Error("Fixture checkout denied");
    const ssl = (await acquired.lease.query("SELECT ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
    check(ssl.ssl === true && /^TLSv1\.[23]$/.test(ssl.version));
    check((await acquired.lease.query("SHOW search_path")).rows[0].search_path === "pg_catalog");
    check(acquired.lease.finalize(false) === "released");
    await db.query(`INSERT INTO public.upload_resource_domains VALUES
      ($1,'public','volume','g1',true,'cut1',120,10,10,0,24,2,2,0)`, [provider.binding.database]);
    await db.query("INSERT INTO public.upload_resource_policies VALUES ($1,'public','volume','a','v1','g1',$2::jsonb)",
      [provider.binding.database, JSON.stringify(policy)]);
    const state = async () => ({
      domain: (await db!.query("SELECT outstanding_bytes,outstanding_objects FROM public.upload_resource_domains")).rows[0],
      attempts: (await db!.query("SELECT * FROM public.upload_resource_attempts ORDER BY attempt_id")).rows,
    });
    async function reserve(loseAcknowledgement = false) {
      const work = createUploadResourceSqlWork(pin, policy, { auditId: "cut1", operationId: randomUUID(), writerId: "fixture" })!;
      let pid = 0, finalizations = 0, destroyed = false;
      const calls: string[] = [];
      const observed = { ...provider, checkout: async (ownedPin: typeof pin) => {
        const r = await provider.checkout(ownedPin);
        if (r.status !== "acquired") return r;
        pid = (await r.lease.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const query = r.lease.query.bind(r.lease), finalize = r.lease.finalize.bind(r.lease);
        r.lease.query = async (sql, values) => {
          calls.push(sql);
          const result = await query(sql, values);
          // Explicit ACK fault seam AFTER the actual provider lease executed real COMMIT.
          if (loseAcknowledgement && sql === "COMMIT") throw Error("fixture lost COMMIT ACK");
          return result;
        };
        r.lease.finalize = broken => { finalizations++; destroyed = broken; return finalize(broken); };
        return r;
      } };
      const result = await runUploadLedgerTransaction(observed, pin, work);
      check(finalizations === 1);
      return { result, pid, calls, destroyed };
    }
    cursor = log().length;
    const valid = await reserve(); check(valid.result.status === "committed" && valid.result.commitDispatched);
    const sessionLog = log().slice(cursor).split("\n").filter(line => line.includes("[" + valid.pid + "]")).join("\n");
    const probeIndex = sessionLog.indexOf("SELECT pg_catalog.current_database()"), beginIndex = sessionLog.indexOf("BEGIN ISOLATION LEVEL READ COMMITTED");
    check(probeIndex >= 0 && beginIndex > probeIndex);
    check(sessionLog.includes("COMMIT"));
    let s = await state();
    check(s.domain.outstanding_bytes === "10" && s.domain.outstanding_objects === "2");
    check(s.attempts.length === 1 && s.attempts[0].attempt_id === valid.result.attemptId);
    const unknown = await reserve(true);
    check(unknown.result.status === "unknown" && unknown.result.commitDispatched && unknown.destroyed);
    check(unknown.calls.filter(sql => sql === "COMMIT").length === 1 && !unknown.calls.includes("ROLLBACK"));
    s = await state();
    check(s.domain.outstanding_bytes === "20" && s.domain.outstanding_objects === "4");
    check(s.attempts.length === 2 && s.attempts.some(row => row.attempt_id === unknown.result.attemptId));
    // Kill only a verified backend in OUR random database, never a supplied PID.
    // No error-event interception: an unhandled pg error fails this child process.
    const baseline = await state();
    const failures: Record<string, unknown>[] = [];
    async function terminateOwned(pid: number) {
      const target = await db!.query("SELECT datname,usename FROM pg_stat_activity WHERE pid=$1 AND pid<>pg_backend_pid()", [pid]);
      check(target.rowCount === 1 && target.rows[0].datname === database && target.rows[0].usename === role);
      check((await db!.query("SELECT pg_terminate_backend($1) AS terminated", [pid])).rows[0].terminated === true);
    }
    async function waitPoisoned(p: typeof provider) {
      const deadline = Date.now() + 5000;
      while (p.pin(policy) !== null && Date.now() < deadline) await delay(10);
      check(p.pin(policy) === null);
    }
    const active = make({ user: role }), activePin = active.pin(policy)!;
    let activePid = 0, activeFinalizations = 0;
    const activeCalls: string[] = [];
    const observedActive = { ...active, checkout: async (ownedPin: typeof pin) => {
      const r = await active.checkout(ownedPin);
      if (r.status !== "acquired") return r;
      const query = r.lease.query.bind(r.lease), finalize = r.lease.finalize.bind(r.lease);
      r.lease.query = (sql, values) => { activeCalls.push(sql); return query(sql, values); };
      r.lease.finalize = broken => { activeFinalizations++; check(broken); return finalize(broken); };
      return r;
    } };
    const activeWork = createUploadResourceSqlWork(activePin, policy,
      { auditId: "cut1", operationId: randomUUID(), writerId: "terminated-fixture" })!;
    cursor = log().length;
    const terminated = await runUploadLedgerTransaction(observedActive, activePin, async context => {
      activePid = (await context.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      check(await activeWork(context) === "prepared"); // real uncommitted charge + attempt
      await terminateOwned(activePid);
      await waitPoisoned(active);
      throw Error("fixture backend terminated before COMMIT");
    });
    check(terminated.status === "unknown" && !terminated.commitDispatched);
    check(activeFinalizations === 1 && activeCalls.filter(sql => sql === "ROLLBACK").length === 1);
    check(!activeCalls.includes("COMMIT"));
    const activeLog = log().slice(cursor).split("\n").filter(line => line.includes("[" + activePid + "]")).join("\n");
    check(activeLog.includes("BEGIN ISOLATION LEVEL READ COMMITTED") && activeLog.includes("INSERT INTO"));
    check(activeLog.includes("terminating connection due to administrator command") && !activeLog.includes("statement: COMMIT"));
    check(JSON.stringify(await state()) === JSON.stringify(baseline));
    check(!baseline.attempts.some(row => row.attempt_id === terminated.attemptId));
    cursor = log().length;
    check((await active.checkout(activePin)).status === "failed");
    const blocked = await runUploadLedgerTransaction(active, activePin, async () => { throw Error("must not execute"); });
    check(blocked.status === "not-committed" && !blocked.commitDispatched);
    check(log().slice(cursor).length === 0); // no reconnect, probe, mutation or replay
    await active.close();
    failures.push({ mode: "checked-out-in-transaction", pid: activePid, outcome: terminated,
      finalizations: activeFinalizations, rollbackAttempted: true, serverCommit: false, futureCheckout: "failed" });

    const idle = make({ user: role }), idlePin = idle.pin(policy)!;
    const idleLease = await idle.checkout(idlePin);
    check(idleLease.status === "acquired");
    if (idleLease.status !== "acquired") throw Error("Idle fixture checkout denied");
    const idlePid = (await idleLease.lease.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    check(idleLease.lease.finalize(false) === "released");
    await terminateOwned(idlePid);
    await waitPoisoned(idle);
    cursor = log().length;
    check((await idle.checkout(idlePin)).status === "failed");
    check(log().slice(cursor).length === 0);
    check(idleLease.lease.finalize(true) === "already-finalized");
    await idle.close();
    check(JSON.stringify(await state()) === JSON.stringify(baseline));
    failures.push({ mode: "idle-in-pool", pid: idlePid, futureCheckout: "failed", pin: null });
    await provider.close(); check((await provider.checkout(pin)).status === "failed");
    console.log(JSON.stringify({ status: "PASS", checks, version, tls: ssl.version,
      defaultRoleCanProbe, permissionCode, permissionDeniedAfterFixtureOnlyRevoke: true,
      bootstrapRolePositiveOnly: false, fixtureLimitedRolePositive: true,
      fixtureOnlyExplicitGrants: true, sameLeaseProbeBeforeBegin: true,
      committed: valid.result, lostAcknowledgement: unknown.result,
      finalLiability: { bytes: 20, objects: 4 },
      backendTermination: failures, terminationPreservedLedger: true,
      actual: ["verified TLS", "provider owned pool", "policy pin", "0009", "transaction", "SQL callback", "lease"],
      excluded: ["managed-provider privileges", "clone uniqueness", "physical fencing", "network fault injection", "live migration", "storage authority"] }));
  } finally {
    for (const provider of providers) await provider.close();
    if (db) await db.end();
    if (created) await admin.query('DROP DATABASE "' + database + '"');
    if (roleCreated) await admin.query('DROP ROLE "' + role + '"');
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
