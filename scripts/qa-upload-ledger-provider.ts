/** Owned loopback TLS fixture ONLY. No live credentials, grants or storage IO.
 * Requires a dedicated PG instance logging statements and a one-day fixture CA.
 * Positive SQL uses an explicitly limited nonsuperuser role in the random DB.
 * All privilege changes are fixture-only; not a managed-platform readiness claim.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, createConnection, type Socket } from "node:net";
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
  let resultReport: Record<string, unknown> | undefined;
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
    async function reserve(loseAcknowledgement = false, selectedProvider = provider, selectedPin = pin) {
      const work = createUploadResourceSqlWork(selectedPin, policy, { auditId: "cut1", operationId: randomUUID(), writerId: "fixture" })!;
      let pid = 0, finalizations = 0, destroyed = false;
      const calls: string[] = [];
      const observed = { ...selectedProvider, checkout: async (ownedPin: typeof pin) => {
        const r = await selectedProvider.checkout(ownedPin);
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
      const result = await runUploadLedgerTransaction(observed, selectedPin, work);
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

    // Unlike the preceding transaction, SQL is genuinely pending at termination.
    const busy = make({ user: role }), busyPin = busy.pin(policy)!;
    const busyLease = await busy.checkout(busyPin);
    check(busyLease.status === "acquired");
    if (busyLease.status !== "acquired") throw Error("Busy fixture checkout denied");
    const busyPid = (await busyLease.lease.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const sleepSql = "SELECT pg_catalog.pg_sleep(30) /* owned-provider-pending-query */";
    let settled = false, destroyed = false;
    cursor = log().length;
    // Attach BOTH handlers at dispatch; never leave a rejection unobserved.
    const pending = busyLease.lease.query(sleepSql).then(
      () => { settled = true; return { rejected: false, code: "" }; },
      (error: { code?: string }) => { settled = true; return { rejected: true, code: error.code || "" }; },
    );
    let observed: Record<string, unknown> | undefined;
    try {
      const deadline = Date.now() + 2000;
      do {
        const activity = await db.query(
          "SELECT datname,usename,state,query,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1 AND pid<>pg_backend_pid()",
          [busyPid]);
        const row = activity.rows[0];
        if (row?.datname === database && row.usename === role && row.state === "active" &&
            row.query === sleepSql && row.wait_event_type === "Timeout" && row.wait_event === "PgSleep") {
          observed = row; break;
        }
        await delay(10);
      } while (!settled && Date.now() < deadline);
      check(observed !== undefined && !settled);
      check(busyLease.lease.finalize(true) === "query-pending"); // no premature release
      await terminateOwned(busyPid);
      const outcome = await pending;
      check(outcome.rejected && outcome.code === "57P01"); // not statement_timeout
      await waitPoisoned(busy);
    } finally {
      // Even a failed assertion waits for query settlement before destroying once.
      await pending;
      destroyed = busyLease.lease.finalize(true) === "destroyed";
    }
    check(settled && destroyed);
    check(busyLease.lease.finalize(true) === "already-finalized");
    const busyLog = log().slice(cursor).split("\n").filter(line => line.includes("[" + busyPid + "]")).join("\n");
    check(busyLog.includes(sleepSql) && busyLog.includes("terminating connection due to administrator command"));
    check(!/statement: (BEGIN|INSERT|UPDATE|DELETE|COMMIT)/.test(busyLog));
    cursor = log().length;
    check((await busy.checkout(busyPin)).status === "failed");
    check(log().slice(cursor).length === 0); // no reconnect/probe/mutation/replay
    check(JSON.stringify(await state()) === JSON.stringify(baseline));
    failures.push({ mode: "pending-query", pid: busyPid, observed,
      outcome: await pending, pendingFinalize: "query-pending", settledBeforeDestroy: settled,
      destroyedOnce: destroyed, futureCheckout: "failed", pin: null });
    // Explicit trusted replacement, never automatic recovery or UNKNOWN replay.
    // Keep busy OPEN here: denial must be poisoning, not merely close().
    const retainedUnknown = JSON.stringify([unknown.result, terminated]);
    cursor = log().length;
    const replacement = make({ user: role });
    const replacementPin = replacement.pin(policy)!;
    check(replacementPin !== null && replacementPin !== busyPin);
    check((await replacement.checkout(busyPin)).status === "failed");
    check(log().slice(cursor).length === 0); // construction/pinning/foreign pin are inert
    const fresh = await reserve(false, replacement, replacementPin);
    check(fresh.result.status === "committed" && fresh.result.commitDispatched && !fresh.destroyed);
    check(![valid.result.attemptId, unknown.result.attemptId, terminated.attemptId].includes(fresh.result.attemptId));
    check(fresh.calls.filter(sql => sql === "COMMIT").length === 1 && !fresh.calls.includes("ROLLBACK"));
    const replacementLog = log().slice(cursor).split("\n").filter(line => line.includes("[" + fresh.pid + "]")).join("\n");
    const replacementProbe = replacementLog.indexOf("SELECT pg_catalog.current_database()");
    const replacementBegin = replacementLog.indexOf("BEGIN ISOLATION LEVEL READ COMMITTED");
    check(replacementProbe >= 0 && replacementBegin > replacementProbe);
    check((replacementLog.match(/statement: COMMIT/g) || []).length === 1);
    check((replacementLog.match(/INSERT INTO/g) || []).length === 1 && replacementLog.includes(fresh.result.attemptId));
    check(!replacementLog.includes(unknown.result.attemptId) && !replacementLog.includes(terminated.attemptId));
    const replacedState = await state();
    check(replacedState.domain.outstanding_bytes === "30" && replacedState.domain.outstanding_objects === "6");
    check(replacedState.attempts.length === 3 && replacedState.attempts.filter(row => row.attempt_id === fresh.result.attemptId).length === 1);
    check(JSON.stringify(replacedState.attempts.filter(row => row.attempt_id !== fresh.result.attemptId)) === JSON.stringify(baseline.attempts));
    check(!replacedState.attempts.some(row => row.attempt_id === terminated.attemptId));
    check(JSON.stringify([unknown.result, terminated]) === retainedUnknown);
    cursor = log().length;
    check(busy.pin(policy) === null && (await busy.checkout(busyPin)).status === "failed");
    check(log().slice(cursor).length === 0); // replacement never revives poisoned provider
    await busy.close();
    await replacement.close();
    // Opaque TCP forwarding: TLS remains end-to-end to OUR fixture certificate.
    // One provider/one connection only; never target an external endpoint/PID.
    const sockets = new Set<Socket>();
    let connections = 0;
    const cut = () => { for (const socket of sockets) socket.destroy(); };
    const proxy = createServer(client => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.on("error", cut);
      if (++connections !== 1) { client.destroy(); return; }
      const upstream = createConnection({ host: "127.0.0.1", port: manifest.port });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", cut);
      client.pipe(upstream).pipe(client);
    });
    let transport: Record<string, unknown> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      assert.ok(address && typeof address !== "string");
      const network = make({ user: role, port: address.port }), networkPin = network.pin(policy)!;
      const acquiredNetwork = await network.checkout(networkPin);
      check(acquiredNetwork.status === "acquired");
      if (acquiredNetwork.status !== "acquired") throw Error("Proxy fixture checkout denied");
      const lease = acquiredNetwork.lease;
      const identity = (await lease.query("SELECT pg_backend_pid() AS pid, ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
      check(identity.ssl === true && /^TLSv1\.[23]$/.test(identity.version));
      const sql = "SELECT pg_catalog.pg_sleep(30) /* owned-tls-transport-disconnect */";
      let networkSettled = false, networkDestroyed = false;
      cursor = log().length;
      const pendingNetwork = lease.query(sql).then(
        () => { networkSettled = true; return { rejected: false, code: "", message: "" }; },
        (error: { code?: string; message?: string }) => {
          networkSettled = true;
          return { rejected: true, code: error.code || "", message: error.message || "" };
        });
      let activityEvidence: Record<string, unknown> | undefined;
      let cutAt = 0, settledMs = 0;
      try {
        const deadline = Date.now() + 2000;
        do {
          const row = (await db.query("SELECT datname,usename,state,query,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [identity.pid])).rows[0];
          if (row?.datname === database && row.usename === role && row.state === "active" &&
              row.query === sql && row.wait_event_type === "Timeout" && row.wait_event === "PgSleep") {
            activityEvidence = row; break;
          }
          await delay(10);
        } while (!networkSettled && Date.now() < deadline);
        check(activityEvidence !== undefined && !networkSettled && connections === 1 && sockets.size === 2);
        check(lease.finalize(true) === "query-pending");
        cutAt = Date.now(); cut(); // disconnect actual transport, NOT pg_terminate_backend
        const outcome = await pendingNetwork;
        settledMs = Date.now() - cutAt;
        check(outcome.rejected && !["57014", "57P01"].includes(outcome.code) && settledMs < 2000);
        await waitPoisoned(network);
      } finally {
        cut(); // also disconnect on failed observation before awaiting settlement
        await pendingNetwork;
        networkDestroyed = lease.finalize(true) === "destroyed";
      }
      check(networkSettled && networkDestroyed);
      check(lease.finalize(true) === "already-finalized");
      const networkLog = log().slice(cursor).split("\n").filter(line => line.includes("[" + identity.pid + "]")).join("\n");
      check(networkLog.includes(sql));
      check(!/(?:statement:|execute [^:]*:)\s*(BEGIN|INSERT|UPDATE|DELETE|COMMIT)\b/i.test(networkLog));
      check(!networkLog.includes("terminating connection due to administrator command"));
      cursor = log().length;
      check(network.pin(policy) === null && (await network.checkout(networkPin)).status === "failed");
      check(log().slice(cursor).length === 0 && connections === 1);
      check(JSON.stringify(await state()) === JSON.stringify(replacedState));
      transport = { mode: "opaque-loopback-tcp-disconnect", pid: identity.pid, tls: identity.version,
        observed: activityEvidence, outcome: await pendingNetwork, connections, settledMs,
        pendingFinalize: "query-pending", settledBeforeDestroy: networkSettled, destroyedOnce: networkDestroyed,
        futureCheckout: "failed", ledgerUnchanged: true, administrativeTermination: false };
      await network.close();
      // Client rejection is immediate, but PG may still be sleeping until its
      // server statement timeout. Independently await backend disappearance for
      // cleanup; this is NOT the client's network-settlement bound.
      const cleanupStarted = Date.now(), cleanupDeadline = cleanupStarted + 7000;
      let backendGone = false;
      do {
        backendGone = (await db.query("SELECT pid FROM pg_stat_activity WHERE pid=$1", [identity.pid])).rowCount === 0;
        if (backendGone) break;
        await delay(25);
      } while (Date.now() < cleanupDeadline);
      check(backendGone);
      transport.backendGoneBeforeDrop = backendGone;
      transport.backendCleanupMs = Date.now() - cleanupStarted;
    } finally {
      cut();
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    }
    await provider.close(); check((await provider.checkout(pin)).status === "failed");
    resultReport = { status: "PASS", checks, version, tls: ssl.version,
      defaultRoleCanProbe, permissionCode, permissionDeniedAfterFixtureOnlyRevoke: true,
      bootstrapRolePositiveOnly: false, fixtureLimitedRolePositive: true,
      fixtureOnlyExplicitGrants: true, sameLeaseProbeBeforeBegin: true,
      committed: valid.result, lostAcknowledgement: unknown.result,
      finalLiability: { bytes: 30, objects: 6 },
      backendTermination: failures, terminationPreservedLedger: true,
      transportDisconnect: transport,
      explicitReplacement: { pid: fresh.pid, outcome: fresh.result, sameLeaseProbeBeforeBegin: true,
        commitCount: 1, insertCount: 1, originalRowsUnchanged: true, retainedUnknown: [unknown.result, terminated],
        unknownReplay: false, poisonedProviderRevived: false, automaticRecovery: false },
      actual: ["verified TLS", "provider owned pool", "policy pin", "0009", "transaction", "SQL callback", "lease"],
      excluded: ["managed-provider privileges", "clone uniqueness", "physical fencing", "TCP blackhole", "COMMIT packet loss", "live migration", "storage authority"] };
  } finally {
    for (const provider of providers) await provider.close();
    if (db) await db.end();
    if (created) await admin.query('DROP DATABASE "' + database + '"');
    if (roleCreated) await admin.query('DROP ROLE "' + role + '"');
    await admin.end();
  }
  // Never print PASS before database/role cleanup succeeds.
  console.log(JSON.stringify(resultReport));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
