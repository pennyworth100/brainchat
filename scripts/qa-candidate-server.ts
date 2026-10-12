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
    const migrator = new Pool({...config,database:"candidate",user:"candidate_migrator",password:"fixture-only"});
    try {
      await migrateDatabase(migrator);
      for (const name of ["message-publication","publication-subscribers","message-write-admission"])
        await migrator.query(await readFile(`scripts/fixtures/${name}.sql`,"utf8"));
      await migrator.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO candidate_runtime,candidate_maintenance;
        GRANT SELECT,INSERT,UPDATE ON rooms,rate_limits,room_resume_sessions,
          publication_subscribers,publication_deliveries,publication_snapshot_attempts TO candidate_runtime;
        GRANT SELECT,INSERT ON messages,message_publication_pending,resume_message_receipts TO candidate_runtime;
        GRANT SELECT,UPDATE(id) ON publication_admission TO candidate_runtime;
        GRANT USAGE ON SEQUENCE messages_id_seq TO candidate_runtime;
        GRANT SELECT,DELETE ON room_resume_sessions,resume_message_receipts,publication_deliveries,rate_limits TO candidate_maintenance;
        GRANT UPDATE(id) ON room_resume_sessions TO candidate_maintenance;
        GRANT UPDATE(client_message_id) ON resume_message_receipts TO candidate_maintenance;
        GRANT UPDATE(message_id) ON publication_deliveries TO candidate_maintenance;
        GRANT SELECT,UPDATE(session_id) ON publication_subscribers TO candidate_maintenance;`);
    } finally { await migrator.end(); }
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
      scramAuthentication:true,limitations:"owned TLS+SCRAM cluster; not managed-provider ACL/TLS attestation"}));
  } finally { if (child && child.exitCode===null) child.kill("SIGKILL"); await admin.end(); }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
