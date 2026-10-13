import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { Pool } from "pg";
import { migrateDatabase } from "../src/lib/db/startup-migrations";

async function main() {
  const dir = process.env.LEDGER_TLS_FIXTURE!;
  const manifest = JSON.parse(await readFile(dir+"/fixture.json","utf8"));
  assert.equal(manifest.kind,"owned-disposable-tls-v1");
  const ca = await readFile(dir+"/server.crt","utf8");
  const config = {host:"127.0.0.1",port:manifest.port,user:"dimle",database:"postgres",ssl:{ca,rejectUnauthorized:true}};
  const admin = new Pool(config);
  let child: ChildProcess | undefined;
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
    const launch = (overrides: Record<string,string> = {}) => {
      let output = "";
      child = spawn(process.execPath,["--import","tsx","candidate-server.ts"],{env:{...env,...overrides},stdio:["ignore","pipe","pipe"]});
      child!.stdout!.on("data",chunk=>{output+=chunk;}); child!.stderr!.on("data",chunk=>{output+=chunk;});
      const exited = new Promise<number|null>(resolve=>child!.once("exit",resolve));
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
    console.log(JSON.stringify({status:"PASS",actualCandidateCli:true,verifiedTLS:true,threeRoles:true,
      invalidCARejectedBeforeMigration:true,badPasswordRejectedBeforeMigration:true,elevatedRoleRejectedBeforeMigration:true,
      foreignDatabaseRejectedBeforeMigration:true,budgetColumnGrantRejectedBeforeMigration:true,
      roomCreated:true,oneSettledShutdown:true,noRemainingCandidateBackends:true,
      scramAuthentication:true,offlineProductionInstaller:true,offlineRoleGrants:true,dirtyColumnGrantRefused:true,publicGrantRefused:true,inheritingRoleRefused:true,runtimeMessageClosed:true,grantReplayRefused:true,closedBudgetPreserved:true,limitations:"owned TLS+SCRAM cluster; not managed-provider ACL/TLS attestation"}));
  } finally { if (child && child.exitCode===null) child.kill("SIGKILL"); await admin.end(); }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
