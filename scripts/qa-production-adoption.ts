import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Pool, Client } from 'pg';
import { migrateDatabase } from '../src/lib/db/startup-migrations';

async function main() {
  const url = new URL(process.env.RESUME_TEST_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, process.env.OWNED_PG_PORT);
  assert.equal(url.search, '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE ROLE adoption_owner LOGIN NOINHERIT;
    CREATE ROLE adoption_runtime LOGIN NOINHERIT VALID UNTIL '2099-01-01';
    CREATE ROLE adoption_maintenance LOGIN NOINHERIT VALID UNTIL '2099-01-01';
    REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC`);
  await admin.query('CREATE DATABASE adoption OWNER adoption_owner');
  url.pathname='/adoption';
  const root = new Pool({connectionString:url.href});
  url.username='adoption_owner';
  const owner = new Pool({connectionString:url.href});
  let connection;
  try {
    await root.query('REVOKE ALL ON DATABASE adoption FROM PUBLIC; REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO adoption_owner');
    await migrateDatabase(owner);
    await owner.query(await fs.readFile('scripts/production/install-publication-closed.sql','utf8'));
    await owner.query('GRANT CONNECT ON DATABASE adoption TO adoption_runtime,adoption_maintenance');
    await owner.query('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
    connection=await owner.connect();
    await connection.query("SELECT set_config('dimle.cutover_runtime','adoption_runtime',false),set_config('dimle.cutover_maintenance','adoption_maintenance',false)");
    await connection.query(await fs.readFile('scripts/production/grant-publication-roles.sql','utf8'));
    const sql=await fs.readFile('scripts/production/adopt-publication-roles.sql','utf8');
    const preserved=async()=> (await root.query(`SELECT jsonb_build_object('budget',(SELECT to_jsonb(b) FROM message_write_budget b),
      'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM drizzle.__drizzle_migrations h),
      'acls',(SELECT jsonb_agg(jsonb_build_array(oid,relacl) ORDER BY oid) FROM pg_class)) AS state`)).rows[0].state;
    const before=await preserved();
    await connection.query(sql);
    await connection.query(sql);
    assert.deepEqual(await preserved(),before);
    const cases=[
      ['public-delete','GRANT DELETE ON messages TO PUBLIC','REVOKE DELETE ON messages FROM PUBLIC'],
      ['column-escalation','GRANT UPDATE(content) ON messages TO adoption_runtime','REVOKE UPDATE(content) ON messages FROM adoption_runtime'],
      ['missing-grant','REVOKE INSERT ON messages FROM adoption_runtime','GRANT INSERT ON messages TO adoption_runtime'],
      ['grant-option','GRANT SELECT ON messages TO adoption_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR SELECT ON messages FROM adoption_runtime'],
      ['sequence-escalation','GRANT SELECT ON messages_id_seq TO adoption_runtime','REVOKE SELECT ON messages_id_seq FROM adoption_runtime'],
      ['sequence-grant-option','GRANT USAGE ON messages_id_seq TO adoption_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR USAGE ON messages_id_seq FROM adoption_runtime'],
      ['function-public','GRANT EXECUTE ON FUNCTION admit_message_write() TO PUBLIC','REVOKE EXECUTE ON FUNCTION admit_message_write() FROM PUBLIC'],
      ['schema-create','GRANT CREATE ON SCHEMA public TO adoption_runtime','REVOKE CREATE ON SCHEMA public FROM adoption_runtime'],
      ['schema-grant-option','GRANT USAGE ON SCHEMA public TO adoption_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR USAGE ON SCHEMA public FROM adoption_runtime'],
      ['foreign-connect','GRANT CONNECT ON DATABASE postgres TO adoption_runtime','REVOKE CONNECT ON DATABASE postgres FROM adoption_runtime'],
      ['connect-grant-option','GRANT CONNECT ON DATABASE adoption TO adoption_runtime WITH GRANT OPTION','REVOKE GRANT OPTION FOR CONNECT ON DATABASE adoption FROM adoption_runtime'],
      ['inherited-role','ALTER ROLE adoption_runtime INHERIT','ALTER ROLE adoption_runtime NOINHERIT'],
      ['expired-role',"ALTER ROLE adoption_runtime VALID UNTIL '2000-01-01'","ALTER ROLE adoption_runtime VALID UNTIL '2099-01-01'"],
      ['inbound-membership','GRANT adoption_runtime TO adoption_maintenance','REVOKE adoption_runtime FROM adoption_maintenance'],
      ['default-grant','ALTER DEFAULT PRIVILEGES FOR ROLE adoption_owner GRANT SELECT ON TABLES TO adoption_runtime','ALTER DEFAULT PRIVILEGES FOR ROLE adoption_owner REVOKE SELECT ON TABLES FROM adoption_runtime'],
      ['unexpected-namespace','CREATE SCHEMA unrelated; CREATE TABLE unrelated.secret(id int); GRANT SELECT ON unrelated.secret TO adoption_runtime','DROP SCHEMA unrelated CASCADE'],
    ];
    if(Number((await root.query('SHOW server_version_num')).rows[0].server_version_num)>=170000)
      cases.push(['maintain-privilege','GRANT MAINTAIN ON messages TO adoption_runtime','REVOKE MAINTAIN ON messages FROM adoption_runtime']);
    for(const [name,change,restore] of cases) {
      await root.query(change);
      try { await assert.rejects(connection.query(sql), /Adoption/, name); }
      finally { await connection.query('ROLLBACK'); await root.query(restore); }
      await connection.query(sql);
    }
    assert.deepEqual(await preserved(),before);
    // Force an attempted write into the actual audit transaction: SQL READ ONLY
    // must reject it, independently of the validator's implementation.
    await assert.rejects(connection.query(sql.replace('COMMIT;', 'UPDATE public.message_write_budget SET max_rows=max_rows+1; COMMIT;')),e=>(e as {code:string}).code==='25006');
    await connection.query('ROLLBACK');
    assert.deepEqual(await preserved(),before);
    // Compose the real fence and exact adoption audit on one operator session.
    // No reconnection as owner and no temporary LOGIN escape hatch.
    const {acquireAndAuditWriterFence} = await import('./production/acquire-and-audit-writer-fence.mjs');
    const expiry=new Date(Date.now()+3600000).toISOString();
    for(const role of ['adoption_owner','adoption_runtime','adoption_maintenance'])
      await root.query('ALTER ROLE "'+role+'" VALID UNTIL '+"'"+expiry+"'");
    const manifest:any={database:'adoption',operator:'dimle',systemIdentifier:(await root.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier};
    for(const [key,name] of [['owner','adoption_owner'],['runtime','adoption_runtime'],['maintenance','adoption_maintenance']])
      manifest[key]={name,oid:(await root.query('SELECT oid::int FROM pg_roles WHERE rolname=$1',[name])).rows[0].oid};
    connection.release(true);connection=undefined;
    await owner.end();await root.end();
    url.username='dimle';
    const operator=new Client({connectionString:url.href});await operator.connect();
    let fencedChecks=0;
    try {
      const result=await acquireAndAuditWriterFence(operator,manifest);
      assert.equal(result.adoption,'PASS');assert.equal(result.activationAuthorized,false);fencedChecks++;
      await result.assertHeld();fencedChecks++;
      assert.equal(result.backend.pid,(await operator.query('SELECT pg_backend_pid() pid')).rows[0].pid);fencedChecks++;
      assert.equal((await operator.query('SELECT current_user,session_user')).rows[0].session_user,'dimle');fencedChecks++;
      assert.equal((await operator.query("SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1) AND rolcanlogin",[[manifest.owner.name,manifest.runtime.name,manifest.maintenance.name]])).rows[0].n,0);fencedChecks++;
      const state=await operator.query(`SELECT jsonb_build_object('budget',(SELECT to_jsonb(b) FROM message_write_budget b),
        'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM drizzle.__drizzle_migrations h),
        'acls',(SELECT jsonb_agg(jsonb_build_array(oid,relacl) ORDER BY oid) FROM pg_class)) AS state`);
      assert.deepEqual(state.rows[0].state,before);fencedChecks++;
      // Failure after durable fence must restore operator identity but NOT LOGIN.
      await operator.query('GRANT DELETE ON messages TO PUBLIC');
      await assert.rejects(acquireAndAuditWriterFence(operator,manifest),/Adoption/);fencedChecks++;
      assert.equal((await operator.query('SELECT current_user')).rows[0].current_user,'dimle');fencedChecks++;
      assert.equal((await operator.query("SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1) AND rolcanlogin",[[manifest.owner.name,manifest.runtime.name,manifest.maintenance.name]])).rows[0].n,0);fencedChecks++;
      await operator.query('REVOKE DELETE ON messages FROM PUBLIC');
      await acquireAndAuditWriterFence(operator,manifest);fencedChecks++;
      async function auditAsOwner(mode:string,body=sql) {
        try {
          await operator.query('SET SESSION AUTHORIZATION adoption_owner');
          await operator.query("SELECT set_config('dimle.cutover_runtime','adoption_runtime',false),set_config('dimle.cutover_maintenance','adoption_maintenance',false),set_config('dimle.cutover_state',$1,false)",[mode]);
          await operator.query(body);
        } finally {await operator.query('ROLLBACK; RESET SESSION AUTHORIZATION');}
      }
      await assert.rejects(auditAsOwner('ACTIVATING'),/Adoption state invalid/);fencedChecks++;
      await assert.rejects(auditAsOwner('LOGIN'),/Adoption role isolation/);fencedChecks++;
      await operator.query('ALTER ROLE adoption_runtime LOGIN');
      await assert.rejects(auditAsOwner('FENCED'),/Adoption role isolation/);fencedChecks++;
      await operator.query('ALTER ROLE adoption_runtime NOLOGIN');
      await assert.rejects(auditAsOwner('FENCED',sql.replace('COMMIT;', 'UPDATE public.message_write_budget SET max_rows=max_rows+1; COMMIT;')),e=>(e as {code:string}).code==='25006');fencedChecks++;
      await auditAsOwner('FENCED');fencedChecks++;
      // FENCED is not a string-only bypass: require the same operator lock.
      await operator.query('SELECT pg_advisory_unlock_all()');
      await assert.rejects(result.assertHeld(),/session lock lost/);fencedChecks++;
      await operator.query('SET SESSION AUTHORIZATION adoption_owner');
      await operator.query("SELECT set_config('dimle.cutover_runtime','adoption_runtime',false),set_config('dimle.cutover_maintenance','adoption_maintenance',false),set_config('dimle.cutover_state','FENCED',false)");
      await assert.rejects(operator.query(sql),/session lock required/);fencedChecks++;
      await operator.query('ROLLBACK; RESET SESSION AUTHORIZATION');
    } finally {await operator.end();}
    const denied=new Client({connectionString:url.href.replace('dimle@','adoption_runtime@')});
    try {await assert.rejects(denied.connect(),e=>(e as {code:string}).code==='28000');fencedChecks++;}
    finally {await denied.end();}
    console.log(JSON.stringify({fencedAdoption:'PASS',fencedChecks,automaticReopen:false}));
    console.log(JSON.stringify({status:'PASS',readOnlyEnforced:true,repeatable:true,preservation:true,rejected:cases.map(c=>c[0]),productionApplied:false}));
  } finally {
    connection?.release(true);
    await Promise.all([root.ended ? undefined : root.end(),owner.ended ? undefined : owner.end(),admin.end()]);
  }
}
void main().catch(e=>{console.error(e);process.exitCode=1});
