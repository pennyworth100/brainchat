import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { migrateDatabase } from "../src/lib/db/startup-migrations";
import { productionConfiguration } from "../src/lib/db/production-configuration";
import { verifyProductionDatabaseIdentities } from "../src/lib/db/production-identity";

async function main() {
  const dir = process.env.LEDGER_TLS_FIXTURE!;
  const manifest = JSON.parse(await readFile(dir+"/fixture.json","utf8"));
  assert.equal(manifest.kind,"owned-disposable-tls-v1");
  const ca = await readFile(dir+"/server.crt","utf8");
  const config = {host:"127.0.0.1",port:manifest.port,user:"dimle",database:"postgres",ssl:{ca,rejectUnauthorized:true}};
  const admin = new Pool(config);
  let child: ChildProcess | undefined;
  let lastChildOutput = () => "";
  try {
    await admin.query(`SET password_encryption='scram-sha-256';
      CREATE ROLE candidate_migrator LOGIN NOINHERIT PASSWORD 'fixture-only';
      CREATE ROLE candidate_runtime LOGIN NOINHERIT PASSWORD 'fixture-only';
      CREATE ROLE candidate_maintenance LOGIN NOINHERIT PASSWORD 'fixture-only';
      REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC;`);
    await admin.query("CREATE DATABASE candidate OWNER candidate_migrator");
    await admin.query("REVOKE ALL ON DATABASE candidate FROM PUBLIC");
    await admin.query("GRANT CONNECT ON DATABASE candidate TO candidate_runtime,candidate_maintenance");
    const migratorPool = new Pool({...config,database:"candidate",user:"candidate_migrator",password:"fixture-only"});
    const migrator = await migratorPool.connect();
    try {
      await migrateDatabase(migratorPool);
      await migrator.query(await readFile("scripts/production/install-publication-closed.sql","utf8"));
      await migrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await migrator.query("SELECT set_config($1,$2,false),set_config($3,$4,false)",
        ["dimle.cutover_runtime","candidate_runtime","dimle.cutover_maintenance","candidate_maintenance"]);
      const grantSql = await readFile("scripts/production/grant-publication-roles.sql","utf8");
      const first = (await migrator.query("SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1")).rows[0];
      for (const column of ["hash","created_at"] as const) {
        await migrator.query(`UPDATE drizzle.__drizzle_migrations SET ${column}=$1 WHERE id=$2`,
          [column === "hash" ? "wrong" : String(BigInt(first.created_at)+1n),first.id]);
        await assert.rejects(migrator.query(grantSql), /Exact release migration history required/);
        await migrator.query("ROLLBACK");
        assert.equal((await migrator.query("SELECT has_table_privilege($1,$2,$3) AS allowed",
          ["candidate_runtime","messages","INSERT"])).rows[0].allowed,false);
        await migrator.query(`UPDATE drizzle.__drizzle_migrations SET ${column}=$1 WHERE id=$2`,[first[column],first.id]);
      }
      // One dirty column grant must reject the entire plan without partial grants.
      await migrator.query("GRANT SELECT(used_rows) ON message_write_budget TO candidate_runtime");
      await assert.rejects(migrator.query(grantSql), /preexisting application privileges/);
      await migrator.query("ROLLBACK");
      assert.equal((await migrator.query("SELECT has_table_privilege($1,$2,$3) AS allowed",
        ["candidate_maintenance","room_resume_sessions","DELETE"])).rows[0].allowed,false);
      await migrator.query("REVOKE SELECT(used_rows) ON message_write_budget FROM candidate_runtime");
      await migrator.query("GRANT SELECT ON messages TO PUBLIC");
      await assert.rejects(migrator.query(grantSql), /preexisting application privileges/);
      await migrator.query("ROLLBACK; REVOKE SELECT ON messages FROM PUBLIC");
      await admin.query("ALTER ROLE candidate_maintenance INHERIT");
      await assert.rejects(migrator.query(grantSql), /not isolated/);
      await migrator.query("ROLLBACK");
      await admin.query("ALTER ROLE candidate_maintenance NOINHERIT");
      await migrator.query(grantSql);
      // Replaying is a fail-closed error, never privilege/budget normalization.
      await assert.rejects(migrator.query(grantSql), /preexisting application privileges/);
      await migrator.query("ROLLBACK");
      const closed = (await migrator.query("SELECT used_rows=max_rows AND used_bytes=max_bytes AS closed FROM message_write_budget")).rows[0];
      assert.equal(closed.closed,true);
      for (const role of ["candidate_runtime","candidate_maintenance"]) {
        const scoped = new Pool({...config,database:"candidate",user:role,password:"fixture-only"});
        try {
          if (role === "candidate_runtime") {
            await scoped.query("INSERT INTO rooms(id) VALUES ($1)",["grant-proof"]);
            await assert.rejects(scoped.query("INSERT INTO messages(room_id,username,content) VALUES ($1,$2,$3)",
              ["grant-proof","runtime","closed"]),e=>(e as {code:string}).code==="53100");
          }
          await assert.rejects(scoped.query("UPDATE message_write_budget SET max_rows=max_rows+1"),e=>(e as {code:string}).code==="42501");
          await assert.rejects(scoped.query("DELETE FROM messages"),e=>(e as {code:string}).code==="42501");
          await assert.rejects(scoped.query("CREATE TABLE public.forbidden(id int)"),e=>(e as {code:string}).code==="42501");
        } finally { await scoped.end(); }
      }
    } finally { migrator.release(true); await migratorPool.end(); }
    const probe = createServer(); await new Promise<void>(resolve=>probe.listen(0,"127.0.0.1",resolve));
    const port = (probe.address() as {port:number}).port; await new Promise<void>(resolve=>probe.close(()=>resolve()));
    const env: NodeJS.ProcessEnv = {...process.env,NODE_ENV:"production",PORT:String(port),UPLOAD_DIR:dir+"/uploads",
      DIMLE_CANDIDATE_CA_FILE:dir+"/server.crt",DATABASE_URL:"postgresql://invalid:secret@invalid/production"};
    for (const [key,role] of [["MIGRATION","migrator"],["RUNTIME","runtime"],["MAINTENANCE","maintenance"]])
      Object.assign(env,{["DIMLE_CANDIDATE_"+key+"_URL"]:`postgresql://candidate_${role}:fixture-only@127.0.0.1:${manifest.port}/candidate`});
    const launch = (overrides: Record<string,string> = {}, entry = "candidate-server.ts") => {
      let output = "";
      child = spawn(process.execPath,["--import","tsx",entry],{env:{...env,...overrides},stdio:["ignore","pipe","pipe","ipc"]});
      child!.stdout!.on("data",chunk=>{output+=chunk;}); child!.stderr!.on("data",chunk=>{output+=chunk;});
      const exited = new Promise<number|null>(resolve=>child!.once("exit",resolve));
      lastChildOutput = () => output;
      return {output:()=>output,exited};
    };
    const until = async (fn:()=>boolean|Promise<boolean>) => {
      const deadline=Date.now()+15000;
      while (!await fn()) {assert.ok(Date.now()<deadline,"candidate condition timeout"); await new Promise(r=>setTimeout(r,30));}
    };
    await writeFile(dir+"/wrong-ca.crt",rootCertificates.join("\n"));
    const untrusted = launch({DIMLE_CANDIDATE_CA_FILE:dir+"/wrong-ca.crt"});
    assert.equal(await untrusted.exited,1); assert.ok(!untrusted.output().includes("Running database migrations"));
    assert.ok(!untrusted.output().includes("fixture-only"));
    const badPassword = launch({DIMLE_CANDIDATE_RUNTIME_URL:`postgresql://candidate_runtime:incorrect@127.0.0.1:${manifest.port}/candidate`});
    assert.equal(await badPassword.exited,1); assert.ok(!badPassword.output().includes("Running database migrations"));
    const elevated = launch({DIMLE_CANDIDATE_MIGRATION_URL:`postgresql://dimle:fixture-only@127.0.0.1:${manifest.port}/candidate`});
    assert.equal(await elevated.exited,1); assert.ok(!elevated.output().includes("Running database migrations"));
    await admin.query("GRANT CONNECT ON DATABASE postgres TO candidate_runtime");
    const foreign = launch();
    assert.equal(await foreign.exited,1); assert.ok(!foreign.output().includes("Running database migrations"));
    await admin.query("REVOKE CONNECT ON DATABASE postgres FROM candidate_runtime");
    const owner = new Pool({...config,database:"candidate"});
    try {
      await owner.query("GRANT SELECT(used_rows) ON message_write_budget TO candidate_runtime");
      const budget = launch();
      assert.equal(await budget.exited,1); assert.ok(!budget.output().includes("Running database migrations"));
      await owner.query("REVOKE SELECT(used_rows) ON message_write_budget FROM candidate_runtime");
    } finally { await owner.end(); }
    const valid = launch();
    await until(()=>valid.output().includes("Dimle running"));
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`,{method:"POST"});
    assert.equal(response.status,201);
    const roles = (await admin.query(`SELECT DISTINCT usename,s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid
      WHERE datname='candidate'`)).rows;
    assert.ok(roles.some(row=>row.usename==='candidate_runtime' && row.ssl));
    child!.kill("SIGTERM"); child!.kill("SIGTERM");
    assert.equal(await valid.exited,0);
    assert.equal((valid.output().match(/candidate shutdown settled/g)||[]).length,1);
    await until(async()=>!(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname='candidate'")).rowCount);
    const audit = new Pool({...config,database:"candidate"});
    try {
      const history = (await audit.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
      const budget = (await audit.query("SELECT * FROM message_write_budget")).rows;
      await admin.query("ALTER ROLE candidate_runtime VALID UNTIL '2099-01-01'; ALTER ROLE candidate_maintenance VALID UNTIL '2099-01-01'");
      const production = productionConfiguration({
        DIMLE_PRODUCTION_RUNTIME_URL: env.DIMLE_CANDIDATE_RUNTIME_URL,
        DIMLE_PRODUCTION_MAINTENANCE_URL: env.DIMLE_CANDIDATE_MAINTENANCE_URL,
      },ca);
      const identityPools = production.configs.map(c => new Pool(c));
      const verifyIdentity = () => verifyProductionDatabaseIdentities(identityPools,production.roles,production.database);
      try {
        await verifyIdentity();
        await assert.rejects(verifyProductionDatabaseIdentities(identityPools,[...production.roles].reverse(),production.database));
        await assert.rejects(verifyProductionDatabaseIdentities(identityPools,production.roles,"wrong_database"));
        const badLogin = new URL(production.configs[0].connectionString!);
        badLogin.password = "wrong-production-fixture-password";
        for (const overrides of [
          {ssl: false}, {ssl: {ca, rejectUnauthorized: false}},
          {ssl: {ca: rootCertificates.join("\n"), rejectUnauthorized: true}},
          {connectionString: badLogin.href},
        ]) {
          const badPool = new Pool({...production.configs[0],...overrides});
          try {
            await assert.rejects(verifyProductionDatabaseIdentities([badPool,identityPools[1]],production.roles,production.database),
              (e: Error) => e.message === "Production database identity preflight rejected");
          } finally { await badPool.end(); }
        }
        for (const [change, restore] of [
          ["ALTER ROLE candidate_runtime VALID UNTIL '2000-01-01'", "ALTER ROLE candidate_runtime VALID UNTIL '2099-01-01'"],
          ["ALTER ROLE candidate_runtime VALID UNTIL 'infinity'", "ALTER ROLE candidate_runtime VALID UNTIL '2099-01-01'"],
          ["ALTER ROLE candidate_maintenance INHERIT", "ALTER ROLE candidate_maintenance NOINHERIT"],
          ["GRANT candidate_runtime TO candidate_maintenance", "REVOKE candidate_runtime FROM candidate_maintenance"],
          ["GRANT CONNECT ON DATABASE postgres TO candidate_runtime", "REVOKE CONNECT ON DATABASE postgres FROM candidate_runtime"],
          ["GRANT USAGE ON SCHEMA drizzle TO candidate_runtime", "REVOKE USAGE ON SCHEMA drizzle FROM candidate_runtime"],
          ["GRANT SELECT(used_rows) ON message_write_budget TO candidate_runtime", "REVOKE SELECT(used_rows) ON message_write_budget FROM candidate_runtime"],
        ]) {
          await audit.query(change);
          try { await assert.rejects(verifyIdentity(), /Production database identity preflight rejected/); }
          finally { await audit.query(restore); }
          await verifyIdentity();
        }
      } finally { await Promise.all(identityPools.map(p => p.end())); }
      const runtimeEnv = { UPLOAD_DIR: dir+"/preinstalled-uploads",
        DIMLE_CANDIDATE_MIGRATION_URL: "invalid://unavailable-owner-credentials" };
      const rejected = launch(runtimeEnv, "scripts/qa-preinstalled-entry.ts");
      await until(() => rejected.output().includes("Fixture preflight pending"));
      await assert.rejects(access(runtimeEnv.UPLOAD_DIR));
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/browser-session-mode`));
      child!.send("reject");
      assert.equal(await rejected.exited, 1);
      await assert.rejects(access(runtimeEnv.UPLOAD_DIR));
      assert.ok(!rejected.output().includes("Running database migrations"));
      // A successful controller callback cannot substitute for the actual
      // production launcher identity check. Reject a privilege change made
      // while that callback is pending, before creating files or listening.
      const drifted = launch(runtimeEnv, "scripts/qa-preinstalled-entry.ts");
      await until(() => drifted.output().includes("Fixture preflight pending"));
      await audit.query("GRANT USAGE ON SCHEMA drizzle TO candidate_runtime");
      try {
        child!.send("verify");
        assert.equal(await drifted.exited, 1);
        await assert.rejects(access(runtimeEnv.UPLOAD_DIR));
        await assert.rejects(fetch(`http://127.0.0.1:${port}/api/browser-session-mode`));
        assert.ok(!drifted.output().includes("Running database migrations"));
      } finally { await audit.query("REVOKE USAGE ON SCHEMA drizzle FROM candidate_runtime"); }
      const leaseLost = launch(runtimeEnv, "scripts/qa-preinstalled-entry.ts");
      await until(() => leaseLost.output().includes("Fixture preflight pending"));
      child!.send("lose-lease");
      assert.equal(await leaseLost.exited, 1);
      await assert.rejects(access(runtimeEnv.UPLOAD_DIR));
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/browser-session-mode`));
      assert.ok(!leaseLost.output().includes("Running database migrations"));
      const preinstalled = launch(runtimeEnv, "scripts/qa-preinstalled-entry.ts");
      await until(() => preinstalled.output().includes("Fixture preflight pending"));
      await assert.rejects(access(runtimeEnv.UPLOAD_DIR));
      child!.send("verify");
      await until(() => preinstalled.output().includes("Dimle running"));
      assert.ok(!preinstalled.output().includes("Running database migrations"));
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/rooms`, {method:"POST"})).status, 201);
      const active = (await audit.query("SELECT DISTINCT usename FROM pg_stat_activity WHERE datname='candidate'")).rows;
      assert.ok(!active.some(row => row.usename === "candidate_migrator"));
      assert.deepEqual((await audit.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows, history);
      assert.deepEqual((await audit.query("SELECT * FROM message_write_budget")).rows, budget);
      child!.kill("SIGTERM");
      assert.equal(await preinstalled.exited, 0);
      assert.equal((preinstalled.output().match(/Preinstalled fixture shutdown settled/g)||[]).length, 1);
    } finally { await audit.end(); }
    await until(async()=>!(await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname='candidate'")).rowCount);
    console.log(JSON.stringify({status:"PASS",productionConfigurationAndIdentity:true,identityEscalationsRejected:9,
      productionTransportFailuresRejected:4,
      preinstalledRuntime:true,actualProductionRuntimeModule:true,noMigratorCredentials:true,
      productionIdentityDriftAfterGateRejected:true,productionStopPromiseRetained:true,
      activationLeaseLossAfterIdentityBlocksFilesystemAndListener:true,
      pendingVerifierBlocksFilesystemAndListener:true,rejectedVerifierBlocksStartup:true,
      runtimeHasNoHistoryOrDDLPrivileges:true,historyAndClosedBudgetUnchanged:true,
      actualCandidateCli:true,verifiedTLS:true,threeRoles:true,
      invalidCARejectedBeforeMigration:true,badPasswordRejectedBeforeMigration:true,elevatedRoleRejectedBeforeMigration:true,
      foreignDatabaseRejectedBeforeMigration:true,budgetColumnGrantRejectedBeforeMigration:true,
      exactGrantHistory:true,wrongHashAndTimestampRefusedBeforeGrants:true,
      roomCreated:true,oneSettledShutdown:true,noRemainingCandidateBackends:true,
      scramAuthentication:true,offlineProductionInstaller:true,offlineRoleGrants:true,dirtyColumnGrantRefused:true,publicGrantRefused:true,inheritingRoleRefused:true,runtimeMessageClosed:true,grantReplayRefused:true,closedBudgetPreserved:true,limitations:"owned TLS+SCRAM cluster; not managed-provider ACL/TLS attestation"}));
  } catch (error) {
    console.error("Last owned fixture child output:", lastChildOutput());
    throw error;
  } finally { if (child && child.exitCode===null) child.kill("SIGKILL"); await admin.end(); }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
