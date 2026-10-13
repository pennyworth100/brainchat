import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

async function main() {
 const url = process.env.RESUME_TEST_DATABASE_URL!;
 assert.equal(new URL(url).hostname, "127.0.0.1");
 const fixed = process.env.EXPECT_SERIALIZED !== "0";
 const killLeader = process.env.KILL_STARTUP_LEADER === "1";
 const readOnly = process.env.READONLY_STARTUP === "1";
 const cliFollower = process.env.CLI_STARTUP_FOLLOWER === "1";
 const root = process.env.OWNED_UPLOAD_DIR!;
 const pool = new Pool({connectionString:url});
 const db = drizzle(pool);
 // Fixture only: real 0000–0009, leaving the exact current 0010 pending.
 const seed = path.join(root,"fixture-migrations");
 const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json","utf8"));
 assert.equal(journal.entries.length,11);
 journal.entries = journal.entries.slice(0,10);
 fs.mkdirSync(path.join(seed,"meta"),{recursive:true});
 for(const entry of journal.entries)fs.copyFileSync(path.join("drizzle",entry.tag+".sql"),path.join(seed,entry.tag+".sql"));
 fs.writeFileSync(path.join(seed,"meta","_journal.json"),JSON.stringify(journal));
 await migrate(db,{migrationsFolder:seed});
 const lock = await pool.connect();
 const children: ReturnType<typeof spawn>[] = [];
 const logs: string[] = [];
 const exits: (number | null)[] = [];
 const until = async (check:()=>Promise<boolean>, label:string) => {
  for(let i=0;i<400;i++){if(await check())return;await new Promise(r=>setTimeout(r,25));}
  throw Error("Timeout "+label+" "+JSON.stringify(logs));
 };
 const port = () => new Promise<number>(resolve=>{
  const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=(s.address() as net.AddressInfo).port;s.close(()=>resolve(p));});
 });
 const launch = async (id:number) => {
  logs[id]="";
  const child=spawn(process.execPath,["--import","tsx",cliFollower&&id===1?"src/lib/db/migrate.ts":"server.ts"],{cwd:process.cwd(),env:{
   ...process.env,DATABASE_URL:url+"?application_name=startup-"+id+(readOnly?"&options=-c%20default_transaction_read_only%3Don":""),NODE_ENV:"production",
   PORT:String(await port()),UPLOAD_DIR:path.join(root,"process-"+id),ALFRED_API_KEY:"local-only-startup",
   DIMLE_AGENT_API_KEYS_JSON:""
  },stdio:["ignore","pipe","pipe"]});
  children.push(child);
  child.stdout!.on("data",d=>logs[id]+=d);child.stderr!.on("data",d=>logs[id]+=d);
  child.on("exit",code=>exits[id]=code);
 };
 let locked=false;
 try{
  if(readOnly){
   await launch(0);
   await until(async()=>exits[0]!==undefined,"failed migration process exit");
   assert.equal(exits[0],1);
   assert.match(logs[0],/read-only transaction/);
   assert.equal(fs.existsSync(path.join(root,"process-0")),false);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n,10);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='startup-0'")).rows[0].n,0);
   console.log(JSON.stringify({result:"PASS",readOnly,noUploadMutation:true,noReceipt:true,logs},null,2));
   return;
  }
  await lock.query("BEGIN");await lock.query("LOCK TABLE upload_resource_policies IN ACCESS SHARE MODE");locked=true;
  await launch(0);
  await until(async()=>Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name='startup-0' AND wait_event_type='Lock'")).rows[0].n)===1,"leader blocked in real 0010");
  await launch(1);
  await until(async()=>Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE application_name LIKE 'startup-%' AND wait_event_type='Lock'")).rows[0].n)===2,"two blocked starts");
  const blocked=(await pool.query("SELECT application_name,wait_event_type,wait_event,query FROM pg_stat_activity WHERE application_name LIKE 'startup-%' ORDER BY application_name")).rows;
  const dirs=[0,1].map(id=>fs.existsSync(path.join(root,"process-"+id)));
  assert.deepEqual(dirs, fixed ? [false,false] : [true,true]);
  assert.equal(logs.some(x=>x.includes("Dimle running")),false);
  if(fixed)assert.equal(blocked.filter(x=>x.wait_event==="advisory").length,1);
  else assert.equal(blocked.filter(x=>x.query.includes('ALTER TABLE "upload_resource_policies"')).length,2);
  if(killLeader){
   assert.ok(fixed);children[0].kill("SIGKILL");
   await until(async()=>children[0].signalCode==="SIGKILL","leader process killed");
   // Client death is not backend settlement. A backend blocked in SQL can
   // retain its session lock until that SQL unblocks and disconnect is seen.
   // Do not terminate it administratively or let the successor overtake it.
  }
  await lock.query("ROLLBACK");locked=false;
  await until(async()=>(cliFollower?exits[1]===0:logs[1].includes("Dimle running"))&&(killLeader||logs[0].includes("Dimle running")),"actual entrypoints complete");
  const receipts=(await pool.query("SELECT created_at,count(*)::int AS n FROM drizzle.__drizzle_migrations GROUP BY created_at ORDER BY created_at")).rows;
  assert.equal(receipts.length,11);
  assert.equal(receipts[10].n,fixed?1:2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'startup-%')")).rows[0].n,0);
  console.log(JSON.stringify({result:fixed?"PASS":"REPRODUCED",fixed,killLeader,cliFollower,dirsBeforeMigration:dirs,blocked,receipts,logs},null,2));
 }finally{
  if(locked)await lock.query("ROLLBACK");lock.release();
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
  await Promise.all(children.map(c=>c.exitCode!==null||c.signalCode!==null?Promise.resolve():new Promise(r=>c.once("exit",r))));
  await pool.end();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
