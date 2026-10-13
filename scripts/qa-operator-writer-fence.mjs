import assert from "node:assert/strict";
import {Client} from "pg";
import {acquireWriterFence} from "./production/acquire-writer-fence.mjs";
import {auditCatalogReader} from "./production/audit-catalog-reader.mjs";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
const port=Number(process.env.OWNED_PG_PORT);
assert(port>1024 && process.env.FENCE_OWNED_FIXTURE==="yes");
const clients=[];
async function connect(user="dimle",database="fence_owned") {
 const c=new Client({host:"127.0.0.1",port,user,database,connectionTimeoutMillis:2000,query_timeout:5000});
 c.on("error",()=>{});await c.connect();clients.push(c);return c;
}
let checks=0;
try {
 const setup=await connect("dimle","postgres");
 await setup.query("CREATE ROLE fence_owner LOGIN NOINHERIT; CREATE ROLE fence_runtime LOGIN NOINHERIT; CREATE ROLE fence_maint LOGIN NOINHERIT");
 const expiry=new Date(Date.now()+3600000).toISOString();
 for(const r of ["fence_owner","fence_runtime","fence_maint"]) await setup.query('ALTER ROLE "'+r+'" VALID UNTIL '+ "'"+expiry+"'");
 await setup.query("CREATE DATABASE fence_owned OWNER fence_owner");
 const seed=await connect();
 await seed.query("REVOKE ALL ON DATABASE fence_owned FROM PUBLIC; GRANT CONNECT ON DATABASE fence_owned TO fence_owner,fence_runtime,fence_maint");
 const owner=await connect("fence_owner");
 await owner.query("CREATE TABLE public.messages(id int primary key,body text); GRANT SELECT,INSERT ON public.messages TO fence_runtime,fence_maint");
 const runtime=await connect("fence_runtime");
 const manifest={database:"fence_owned",systemIdentifier:(await seed.query("SELECT system_identifier::text FROM pg_control_system()")).rows[0].system_identifier,operator:"dimle"};
 for(const [key,name] of [["owner","fence_owner"],["runtime","fence_runtime"],["maintenance","fence_maint"]])
   manifest[key]={name,oid:(await seed.query("SELECT oid::int FROM pg_roles WHERE rolname=$1",[name])).rows[0].oid};
 await seed.end();
 async function rejected(m,pattern) {const c=await connect();try{await assert.rejects(acquireWriterFence(c,m),pattern);checks++;}finally{await c.end();}}
 await rejected({...manifest,systemIdentifier:"wrong"},/target/);
 await rejected({...manifest,runtime:{...manifest.runtime,oid:manifest.runtime.oid+9999}},/principal/);
 await rejected(manifest,/foreign database/);
 // Only this disposable cluster: remove default foreign CONNECT, never managed grants.
 await setup.query("REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC");
 const outsider=await connect();
 await outsider.query("CREATE ROLE fence_unknown LOGIN; GRANT CONNECT ON DATABASE fence_owned TO fence_unknown");
 await outsider.end();
 await rejected(manifest,/Uninventoried login/);
 const grantor=await connect();
 await grantor.query("REVOKE CONNECT ON DATABASE fence_owned FROM fence_unknown; ALTER ROLE fence_unknown NOLOGIN; GRANT fence_runtime TO fence_unknown");
 await grantor.end();
 await rejected(manifest,/membership/);
 const revoker=await connect();
 await revoker.query("REVOKE fence_runtime FROM fence_unknown; DROP ROLE fence_unknown");
 await revoker.end();
 const control=await connect();
 assert.equal((await control.query("SELECT count(*)::int n FROM pg_roles WHERE rolname LIKE 'fence_%' AND rolcanlogin")).rows[0].n,3);checks++;
 await runtime.query("BEGIN; INSERT INTO public.messages VALUES(1,'prepared'); PREPARE TRANSACTION 'owned_fence'");
 await control.end();
 await rejected(manifest,/Prepared/);
 const rollback=await connect();await rollback.query("ROLLBACK PREPARED 'owned_fence'");await rollback.end();
 const lockOwner=await connect();await lockOwner.query("SELECT pg_advisory_lock(1145654604,2)");
 await rejected(manifest,/busy/);await lockOwner.end();
 const unknown=await connect();
 await rejected(manifest,/Uninventoried active/);
 assert.equal((await unknown.query("SELECT count(*)::int n FROM pg_roles WHERE rolname LIKE 'fence_%' AND rolcanlogin")).rows[0].n,0);checks++;
 await assert.rejects(connect("fence_runtime"),e=>e.code==="28000");checks++;
 await unknown.end();
 const op=await connect();
 const result=await acquireWriterFence(op,manifest);
 assert.equal(result.state,"FENCED");assert.equal(result.activationAuthorized,false);checks++;
 assert.equal((await op.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows[0].n,0);checks++;
 assert.equal((await op.query("SELECT count(*)::int n FROM public.messages")).rows[0].n,0);checks++;
 await result.assertHeld();checks++;
 assert.equal(result.backend.pid,(await op.query("SELECT pg_backend_pid() pid")).rows[0].pid);checks++;
 await op.query("ALTER ROLE fence_runtime LOGIN");
 await assert.rejects(result.assertHeld(),/verification failed/);checks++;
 await op.query("ALTER ROLE fence_runtime NOLOGIN");
 await assert.rejects(result.assertHeld(),/handle invalid/);checks++;
 const lockHandle=await acquireWriterFence(op,manifest);
 await op.query("SELECT pg_advisory_unlock_all()");
 await assert.rejects(lockHandle.assertHeld(),/session lock lost/);checks++;
 await op.query("SELECT pg_advisory_lock(1145654604,2)");
 await assert.rejects(lockHandle.assertHeld(),/handle invalid/);checks++;
 const expiryHandle=await acquireWriterFence(op,manifest);
 await op.query("ALTER ROLE fence_runtime VALID UNTIL '2000-01-01'");
 await assert.rejects(expiryHandle.assertHeld(),/principal mismatch/);checks++;
 await op.query('ALTER ROLE fence_runtime VALID UNTIL '+"'"+expiry+"'");
 const busyHandle=await acquireWriterFence(op,manifest);
 const extra=await connect();
 await assert.rejects(busyHandle.assertHeld(),/verification failed/);checks++;
 await extra.end();
 const concurrentHandle=await acquireWriterFence(op,manifest);
 const concurrent=await Promise.allSettled([concurrentHandle.assertHeld(),concurrentHandle.assertHeld()]);
 assert.ok(concurrent.every(r=>r.status==='rejected'));checks++;
 const swappedHandle=await acquireWriterFence(op,manifest);
 await op.query("SELECT pg_advisory_unlock_all()");
 const replacement=await connect();
 await replacement.query("SELECT pg_advisory_lock(1145654604,2)");
 // Actual replacement backend owns the same lock; no fake result rows.
 const originalQuery=op.query;
 op.query=replacement.query.bind(replacement);
 try {await assert.rejects(swappedHandle.assertHeld(),/original backend/);checks++;}
 finally {op.query=originalQuery;await replacement.end();}
 const endedHandle=await acquireWriterFence(op,manifest);
 await op.end();
 await assert.rejects(endedHandle.assertHeld(),/handle invalid/);checks++;
 await assert.rejects(connect("fence_owner"),e=>e.code==="28000");checks++;
 const verifier=await connect();
 await verifier.query(`CREATE ROLE fence_reader LOGIN NOINHERIT VALID UNTIL $$${expiry}$$;
   GRANT CONNECT ON DATABASE fence_owned TO fence_reader;
   GRANT USAGE ON SCHEMA public TO fence_reader;
   GRANT SELECT ON public.messages TO fence_reader`);
 const readerRole={name:"fence_reader",oid:(await verifier.query("SELECT oid::int FROM pg_roles WHERE rolname=$1",["fence_reader"])).rows[0].oid};
 await assert.rejects(auditCatalogReader(verifier,readerRole),/unsafe/);checks++;
 // Owned fixture only: eliminate PUBLIC large-object/WAL mutation authority.
 const mutators=(await verifier.query(`SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace=$$pg_catalog$$::regnamespace AND proname IN ($$lo_create$$,$$lo_creat$$,$$lo_from_bytea$$,$$lo_put$$,$$lo_import$$,$$lo_unlink$$,$$lowrite$$,$$lo_truncate$$,$$lo_truncate64$$,$$pg_logical_emit_message$$)`)).rows;
 for(const f of mutators) await verifier.query("REVOKE EXECUTE ON FUNCTION "+f.signature+" FROM PUBLIC");
 const readClient=await connect("fence_reader");
 // Use the ACTUAL release definitions, not a function-free toy schema.
 const installer=readFileSync(new URL("./production/install-publication-closed.sql",import.meta.url),"utf8");
 for (const name of ["admit_message_write","enqueue_message_publication"]) {
   const start=installer.indexOf("CREATE FUNCTION public."+name+"()");
   assert.ok(start>=0,"missing release trigger "+name);
   const end=installer.indexOf("$$;",start);
   assert.ok(end>start);
   await verifier.query(installer.slice(start,end+3));
   await verifier.query("REVOKE ALL ON FUNCTION public."+name+"() FROM PUBLIC");
   await assert.rejects(readClient.query("SELECT public."+name+"()"),e=>e.code==="42501");checks++;
   // PL/pgSQL rejects even an operator's ordinary invocation before the body.
   await assert.rejects(verifier.query("SELECT public."+name+"()"),e=>e.code==="0A000");checks++;
 }
 await verifier.query("CREATE TRIGGER release_admission AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.admit_message_write()");
 await verifier.query("CREATE TRIGGER release_publication AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.enqueue_message_publication()");
 await auditCatalogReader(verifier,readerRole);checks++;
 const readerManifest={...manifest,reader:readerRole};
 async function unsafe(grant,revoke) {
   await verifier.query(grant);
   await assert.rejects(auditCatalogReader(verifier,readerRole),/unsafe/);checks++;
   await verifier.query(revoke);
   await auditCatalogReader(verifier,readerRole);
 }
 await unsafe("GRANT INSERT ON public.messages TO PUBLIC","REVOKE INSERT ON public.messages FROM PUBLIC");
 await unsafe("GRANT UPDATE(body) ON public.messages TO fence_reader","REVOKE UPDATE(body) ON public.messages FROM fence_reader");
 await unsafe("GRANT TEMP ON DATABASE fence_owned TO fence_reader","REVOKE TEMP ON DATABASE fence_owned FROM fence_reader");
 await unsafe("GRANT CREATE ON SCHEMA public TO fence_reader","REVOKE CREATE ON SCHEMA public FROM fence_reader");
 await unsafe("CREATE SEQUENCE public.reader_seq; GRANT USAGE ON public.reader_seq TO fence_reader","DROP SEQUENCE public.reader_seq");
 await unsafe("CREATE FUNCTION public.reader_write() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$INSERT INTO public.messages VALUES(8,NULL)$$","DROP FUNCTION public.reader_write()");
 await unsafe("CREATE FUNCTION public.reader_hidden() RETURNS text LANGUAGE sql AS $$SELECT 'hidden'::text$$; REVOKE ALL ON FUNCTION public.reader_hidden() FROM PUBLIC","DROP FUNCTION public.reader_hidden()");
 await unsafe("GRANT EXECUTE ON FUNCTION public.admit_message_write() TO fence_reader","REVOKE EXECUTE ON FUNCTION public.admit_message_write() FROM fence_reader");
 await unsafe("CREATE FUNCTION public.reader_internal_trigger() RETURNS trigger LANGUAGE internal AS 'suppress_redundant_updates_trigger'; REVOKE ALL ON FUNCTION public.reader_internal_trigger() FROM PUBLIC","DROP FUNCTION public.reader_internal_trigger()");
 await unsafe("CREATE TABLE public.reader_owned(id int); ALTER TABLE public.reader_owned OWNER TO fence_reader","DROP TABLE public.reader_owned");
 await unsafe("CREATE VIEW public.reader_view AS SELECT * FROM public.messages; GRANT SELECT(id) ON public.reader_view TO fence_reader","DROP VIEW public.reader_view");
 await unsafe("CREATE ROLE reader_parent; GRANT reader_parent TO fence_reader","REVOKE reader_parent FROM fence_reader; DROP ROLE reader_parent");
 if(Number((await verifier.query("SHOW server_version_num")).rows[0].server_version_num)>=170000)
   await unsafe("GRANT MAINTAIN ON public.messages TO fence_reader","REVOKE MAINTAIN ON public.messages FROM fence_reader");
 await verifier.end();
 await rejected({...readerManifest,reader:{...readerRole,oid:readerRole.oid+9999}},/reader principal/);
 const readerOp=await connect();
 const withReader=await acquireWriterFence(readerOp,readerManifest);
 assert.equal(withReader.reader.oid,readerRole.oid);assert.equal(withReader.activationAuthorized,false);checks++;
 assert.equal((await readClient.query("SELECT count(*)::int n FROM public.messages")).rows[0].n,0);
 for(const sql of ["INSERT INTO public.messages VALUES(2,NULL)","CREATE TABLE public.forbidden(id int)","SET ROLE fence_owner","SELECT pg_catalog.lo_create(0)"])
   {await assert.rejects(readClient.query(sql),e=>e.code==="42501");checks++;}
 const dump=execFileSync(process.env.CATALOG_PG_BIN+"/pg_dump",["--host=127.0.0.1","--port="+port,"--username=fence_reader","--dbname=fence_owned","--schema-only","--no-owner","--no-privileges","--lock-wait-timeout=2s"],{timeout:10000,encoding:"utf8"});
 assert.match(dump,/CREATE TABLE public.messages/);checks++;
 assert.match(dump,/CREATE FUNCTION public.admit_message_write\(\) RETURNS trigger/);
 assert.match(dump,/CREATE FUNCTION public.enqueue_message_publication\(\) RETURNS trigger/);checks++;
 await readerOp.end();
 await assert.rejects(connect("fence_runtime"),e=>e.code==="28000");checks++;
 // Controlled activation uses the same original operator, not a replacement
 // acquisition or a FENCED assertion weakened by an environment flag.
 async function activationCase(body) {
   const c=await connect();
   try { await body(c,await acquireWriterFence(c,readerManifest)); }
   finally { await c.end(); }
 }
 async function closed(c) {
   assert.equal((await c.query("SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1::text[]) AND rolcanlogin",[["fence_owner","fence_runtime","fence_maint"]])).rows[0].n,0);
 }
 function gates(c,events=[]) {
   // Fixture-only verifiers query this disposable target; they are NOT real
   // release/capacity/recovery acceptance and must not be copied to managed DB.
   return Object.fromEntries(["verifyRelease","verifyCapacity","verifyRecovery"].map(name=>[name,async()=>{
     await closed(c);
     assert.equal((await c.query("SELECT count(*)::int n FROM public.messages")).rows[0].n,0);
     events.push(name);
   }]));
 }
 await activationCase(async(c,f)=>{
   await assert.rejects(f.beginActivation({verifyRelease:true,verifyCapacity:true,verifyRecovery:true}),/live activation gates/);
   await closed(c);checks++;
 });
 for(const name of ["verifyRelease","verifyCapacity","verifyRecovery"]) await activationCase(async(c,f)=>{
   const events=[],g=gates(c,events);g[name]=async()=>{throw Error("fixture rejected "+name);};
   await assert.rejects(f.beginActivation(g),/fixture rejected/);
   await closed(c);await assert.rejects(f.assertHeld(),/invalid/);checks++;
 });
 await activationCase(async(c,f)=>{
   const g=gates(c);g.verifyCapacity=async()=>({status:"PASS"});
   await assert.rejects(f.beginActivation(g),/saved receipt/);await closed(c);checks++;
 });
 await activationCase(async(c,f)=>{
   const g=gates(c);g.verifyCapacity=async()=>{await c.query("SELECT pg_advisory_unlock_all()");};
   await assert.rejects(f.beginActivation(g),/session lock lost/);
   await closed(c);checks++;
 });
 await activationCase(async(c,f)=>{
   const g=gates(c);g.verifyRecovery=async()=>{await c.query("ALTER ROLE fence_maint VALID UNTIL '2000-01-01'");};
   await assert.rejects(f.beginActivation(g),/principal mismatch/);await closed(c);checks++;
   await c.query('ALTER ROLE fence_maint VALID UNTIL '+"'"+expiry+"'");
 });
 await activationCase(async(c,f)=>{
   let release;const waiting=new Promise(resolve=>{release=resolve;});
   let entered;const pending=new Promise(resolve=>{entered=resolve;});
   const g=gates(c);g.verifyCapacity=async()=>{entered();await waiting;};
   const first=f.beginActivation(g);await pending;
   await assert.rejects(f.beginActivation(g),/live activation gates/);
   release();await assert.rejects(first,/invalid/);await closed(c);checks++;
 });
 await activationCase(async(c,f)=>{
   const events=[];const lease=await f.beginActivation(gates(c,events));
   assert.deepEqual(events,["verifyRelease","verifyCapacity","verifyRecovery"]);
   assert.equal(lease.state,"ACTIVATING");assert.equal(f.state,"ACTIVATING");
   assert.deepEqual(lease.backend,f.backend);await lease.assertHeld();checks++;
   await assert.rejects(connect("fence_owner"),e=>e.code==="28000");checks++;
   const r=await connect("fence_runtime"),m=await connect("fence_maint");
   await r.query("SELECT * FROM public.messages");await m.query("SELECT * FROM public.messages");
   await lease.assertHeld();checks++;
   const rogue=await connect();await assert.rejects(lease.assertHeld(),/verification failed/);checks++;
   await rogue.end();
   await lease.closeAdmission();await closed(c);assert.equal(lease.state,"CLOSED");
   await assert.rejects(lease.assertHeld(),/invalid/);
   await assert.rejects(connect("fence_runtime"),e=>e.code==="28000");checks++;
 });
 await activationCase(async(c,f)=>{
   // Real committed LOGIN transaction, simulated lost acknowledgement. The
   // original live session must close/drain it instead of leaving roles open.
   const query=c.query.bind(c);let injected=false;
   c.query=async(...args)=>{const result=await query(...args);if(args[0]==="COMMIT"&&!injected){injected=true;throw Error("fixture commit ACK lost");}return result;};
   await assert.rejects(f.beginActivation(gates(c)),/commit ACK lost/);
   c.query=query;await closed(c);assert.equal(f.state,"CLOSED");checks++;
 });
 await activationCase(async(c,f)=>{
   const query=c.query.bind(c);let injected=false;
   c.query=async(...args)=>{const result=await query(...args);if(args[0]==="COMMIT"&&!injected){
     injected=true;await query("SELECT pg_advisory_unlock_all()");throw Error("fixture post-commit lock lost");
   }return result;};
   await assert.rejects(f.beginActivation(gates(c)),/containment UNCONFIRMED/);
   c.query=query;
   assert.equal((await c.query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('fence_runtime','fence_maint') AND rolcanlogin")).rows[0].n,2);
   await assert.rejects(f.assertHeld(),/invalid/);
   // Explicit new fixture-only acquisition contains the uncertain admission;
   // never pretend that this retains the earlier release evidence.
   const replacement=await acquireWriterFence(c,readerManifest);
   assert.notEqual(replacement,f);await closed(c);checks++;
 });
 console.log(JSON.stringify({status:"PASS",checks,fixtureOnly:true,automaticReopen:false}));
} finally {await Promise.allSettled(clients.map(c=>c.end()));}
