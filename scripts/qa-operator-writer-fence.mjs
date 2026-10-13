import assert from "node:assert/strict";
import {Client} from "pg";
import {acquireWriterFence} from "./production/acquire-writer-fence.mjs";
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
 await op.end();
 await assert.rejects(connect("fence_owner"),e=>e.code==="28000");checks++;
 console.log(JSON.stringify({status:"PASS",checks,fixtureOnly:true,automaticReopen:false}));
} finally {await Promise.allSettled(clients.map(c=>c.end()));}
