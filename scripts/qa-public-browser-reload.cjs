const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const local = createRequire(process.cwd()+"/package.json");
const { Pool } = local("pg"), { chromium, expect } = local("@playwright/test");
async function main() {
 const url=process.env.RESUME_TEST_DATABASE_URL;
 assert.equal(new URL(url).hostname,"127.0.0.1");
 assert.equal(new URL(url).port,process.env.OWNED_PG_PORT);
 const db=new Pool({connectionString:url}), base="http://127.0.0.1:"+process.env.OWNED_APP_PORT;
 const boot='const {Pool}=require("pg"); const fs=require("node:fs"); (async()=>{const m=new Pool({connectionString:process.env.DATABASE_URL}),c=new Pool({connectionString:process.env.DATABASE_URL}); await require("./src/lib/db/startup-migrations.ts").migrateDatabase(m); for(const f of ["message-publication","publication-subscribers"])await m.query(fs.readFileSync("scripts/fixtures/"+f+".sql","utf8"));const r=await require("./server.ts").main({privateBrowserResume:process.env.QA_LEGACY_BROWSER!=="1",databaseAuthorities:{migrations:m,maintenance:c,publicationTables:true}});process.on("SIGTERM",async()=>{await r.lifecycle.stopAndSettle();await r.settleStrictUploads();await new Promise(y=>r.io.close(y));await r.app.close();await require("./src/lib/db/index.ts").pool.end();await m.end();await c.end();process.exit(0)});})().catch(e=>{console.error(e);process.exit(1)})';
 const child=spawn(process.execPath,["--import","tsx","-e",boot],{env:{...process.env,DATABASE_URL:url,PORT:process.env.OWNED_APP_PORT,NODE_ENV:"production",ALFRED_API_KEY:"",DIMLE_AGENT_API_KEYS_JSON:"",UPLOAD_DIR:process.env.OWNED_UPLOAD_DIR},stdio:["ignore","pipe","pipe"]});
 let logs="",browser; child.stdout.on("data",b=>logs+=b); child.stderr.on("data",b=>logs+=b);
 const checks=[],errors=[];let sends=0,dropped=0;
 try{
  let ready=false;
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base)).ok){ready=true;break}}catch{} await new Promise(r=>setTimeout(r,100))}
  assert(ready,logs);
  if(process.env.QA_LEGACY_BROWSER==="1"){
   const legacy=spawn(process.execPath,["scripts/qa-rendered-browser.mjs"],{env:{...process.env,QA_BASE_URL:base},stdio:"inherit"});
   const [code]=await once(legacy,"exit");assert.equal(code,0);return;
  }
  const hash=await local("argon2").hash("private-fixture-password");
  await db.query("INSERT INTO rooms(id,password_hash) VALUES ('wire335',$1)",[hash]);
  browser=await chromium.launch(process.env.QA_CHROMIUM_PATH ? {executablePath:process.env.QA_CHROMIUM_PATH} : {});
  const context=await browser.newContext();
  await context.routeWebSocket("**/*",ws=>{
   const upstream=ws.connectToServer();
   ws.onMessage(data=>{if(String(data).includes('"send-message"'))sends++;upstream.send(data)});
   upstream.onMessage(data=>{
    const s=String(data);
    if(/^43\d*\[/.test(s)&&s.includes("lost-ack-wire335")&&dropped===0){dropped++;return}
    ws.send(data);
   });
  });
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
  await page.goto(base+"/room?id=wire335");
  await page.getByLabel("Username",{exact:true}).fill("OriginalOwner");
  await page.getByLabel("Room password (if any)",{exact:true}).fill("wrong-password");
  await page.getByRole("button",{name:"Join Chat"}).click();
  await expect(page.getByRole("status")).toHaveText("Wrong password",{timeout:10000});
  await expect(page.getByRole("button",{name:"Join Chat"})).toBeVisible();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM room_resume_sessions")).rows[0].n,0);
  const journalCount=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("dimle-browser-lease-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const r=db.transaction("leases").objectStore("leases").count();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}});
  assert.equal(journalCount,0);
  checks.push("wrong password exact non-issuance ACK clears initial intent; zero sessions; corrected-password form restored");
  await page.getByLabel("Username",{exact:true}).fill("OriginalOwner");
  await page.getByLabel("Room password (if any)",{exact:true}).fill("private-fixture-password");
  await page.getByRole("button",{name:"Join Chat"}).click();
  await expect(page.getByRole("status")).toContainText("online",{timeout:15000});
  const original=(await db.query("SELECT id,generation FROM room_resume_sessions")).rows;
  assert.equal(original.length,1);assert.equal(original[0].generation,1);
  checks.push("real password-authenticated negotiated join and confirmed empty cut READY");
  await page.getByLabel("Message",{exact:true}).fill("lost-ack-wire335");
  await page.getByRole("button",{name:"Send",exact:true}).click();
  await page.getByLabel("Message",{exact:true}).fill("newer draft survives");
  await expect.poll(()=>dropped,{timeout:8000}).toBe(1);
  const saved=(await db.query("SELECT id,content FROM messages")).rows;
  assert.equal(saved.length,1);assert.equal(saved[0].content,"lost-ack-wire335");assert.equal(sends,1);
  checks.push("actual downstream message ACK dropped after exactly one PostgreSQL commit");
  await page.reload();
  await page.getByLabel("Username",{exact:true}).fill("OriginalOwner");
  await page.getByRole("button",{name:"Join Chat"}).click();
  await expect(page.getByRole("status")).toContainText("online",{timeout:15000});
  await expect(page.getByRole("alert",{name:"Delivery status"})).toContainText("Delivery is not confirmed");
  await expect(page.getByLabel("Message",{exact:true})).toHaveValue("newer draft survives");
  const resumed=(await db.query("SELECT id,generation FROM room_resume_sessions")).rows;
  assert.equal(resumed.length,1);assert.equal(resumed[0].id,original[0].id);assert.equal(resumed[0].generation,2);assert.equal(sends,1);
  checks.push("actual page reload resumes original durable session; UNKNOWN and newer draft survive with no resend");
  await page.getByRole("button",{name:"Check saved delivery"}).click();
  await expect(page.getByRole("alert",{name:"Delivery status"})).toHaveCount(0,{timeout:8000});
  await expect(page.getByLabel("Message",{exact:true})).toHaveValue("newer draft survives");
  assert.equal(sends,1);
  assert.deepEqual((await db.query("SELECT id,content FROM messages")).rows,saved);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM resume_message_receipts")).rows[0].n,1);
  checks.push("read-only original-owner receipt settles exact ID; no duplicate and newer draft retained");
  // Attachment uncertainty must stay owned by the SAME session after reload.
  let uploads=0;
  page.on("request",r=>{if(r.method()==="POST"&&new URL(r.url()).pathname==="/api/upload")uploads++});
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=","base64");
  await page.getByLabel("Message",{exact:true}).fill("draft alongside attachment");
  const uploadResponse=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/upload");
  await page.locator('input[type="file"]').setInputFiles({name:"public-proof.png",mimeType:"image/png",buffer:png});
  await expect(page.getByRole("alert",{name:"Delivery status"})).toContainText("Attachment status is unknown");
  assert.equal((await uploadResponse).status(),503);
  const savedAttachment=()=>page.evaluate(async()=> {
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("dimle-public-outbox-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try {const rows=await new Promise((resolve,reject)=>{const r=db.transaction("pending").objectStore("pending").getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const row=rows.find(x=>x.kind==="file");return {id:row.clientMessageId,name:row.payload.name,bytes:Array.from(new Uint8Array(await row.payload.arrayBuffer()))};
    }finally{db.close()}
  });
  const beforeAttachment=await savedAttachment();
  assert.deepEqual(beforeAttachment.bytes,Array.from(png));
  await page.reload();
  await page.getByLabel("Username",{exact:true}).fill("OriginalOwner");
  await page.getByRole("button",{name:"Join Chat"}).click();
  await expect(page.getByRole("status")).toContainText("online",{timeout:15000});
  await expect(page.getByRole("alert",{name:"Delivery status"})).toContainText("Attachment status is unknown");
  await expect(page.getByLabel("Message",{exact:true})).toHaveValue("draft alongside attachment");
  assert.deepEqual(await savedAttachment(),beforeAttachment);
  assert.equal(sends,1);assert.equal(uploads,1);
  const fileSession=(await db.query("SELECT id,generation FROM room_resume_sessions")).rows;
  assert.deepEqual(fileSession,[{id:original[0].id,generation:3}]);
  checks.push("public upload UNKNOWN preserves exact file bytes/name/key and draft through reload; same session generation 3, no replay");
  await page.route("**/api/browser-session-mode",r=>r.fulfill({json:{mode:"legacy"}}));
  await page.reload();
  await page.getByLabel("Username",{exact:true}).fill("OriginalOwner");
  await page.getByRole("button",{name:"Join Chat"}).click();
  await expect(page.getByRole("status")).toContainText("Original recovery session is temporarily unavailable",{timeout:10000});
  assert.deepEqual((await db.query("SELECT id,generation FROM room_resume_sessions")).rows,fileSession);
  assert.deepEqual(await savedAttachment(),beforeAttachment);
  assert.equal(sends,1);assert.equal(uploads,1);
  checks.push("server capability downgrade refuses password fallback; original session and UNKNOWN bytes unchanged");
  // Losing a refusal ACK must NOT authorize password retry or erase provenance.
  const uncertain=await browser.newContext(); let refused=0;
  await uncertain.routeWebSocket("**/*",ws=>{
    const upstream=ws.connectToServer(); ws.onMessage(data=>upstream.send(data));
    upstream.onMessage(data=>{if(String(data).includes('"join-not-issued"')){refused++;return}ws.send(data)});
  });
  const uncertainPage=await uncertain.newPage();
  const uncertainJournal=()=>uncertainPage.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open("dimle-browser-lease-v1",1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try{return await new Promise((resolve,reject)=>{const r=db.transaction("leases").objectStore("leases").getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}
  });
  await uncertainPage.goto(base+"/room?id=wire335");
  await uncertainPage.getByLabel("Username",{exact:true}).fill("UncertainOwner");
  await uncertainPage.getByLabel("Room password (if any)",{exact:true}).fill("wrong-password");
  await uncertainPage.getByRole("button",{name:"Join Chat"}).click();
  await expect(uncertainPage.getByRole("button",{name:"Retry",exact:true})).toBeVisible({timeout:10000});
  assert.equal(refused,1);
  const retained=await uncertainJournal(); assert.equal(retained.length,1);assert.equal(retained[0].lease,null);
  await uncertainPage.reload();
  await uncertainPage.getByLabel("Username",{exact:true}).fill("UncertainOwner");
  await uncertainPage.getByLabel("Room password (if any)",{exact:true}).fill("private-fixture-password");
  await uncertainPage.getByRole("button",{name:"Join Chat"}).click();
  await expect(uncertainPage.getByRole("button",{name:"Retry",exact:true})).toBeVisible({timeout:10000});
  assert.deepEqual(await uncertainJournal(),retained);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM room_resume_sessions")).rows[0].n,1);
  assert.equal(refused,1);
  checks.push("lost non-issuance ACK retains exact lease-less journal across reload; corrected password cannot issue replacement");
  await uncertain.close();
  const bad=await browser.newContext(),badpage=await bad.newPage();
  await badpage.addInitScript(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);this.transaction.abort();return result}});
  await badpage.goto(base+"/room?id=wire335");
  await badpage.getByLabel("Username",{exact:true}).fill("StorageFailure");
  await badpage.getByLabel("Room password (if any)",{exact:true}).fill("private-fixture-password");
  await badpage.getByRole("button",{name:"Join Chat"}).click();
  await expect(badpage.getByRole("status")).not.toContainText("online",{timeout:10000});
  await expect(badpage.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
  assert.equal((await db.query("SELECT count(*)::int AS n FROM room_resume_sessions")).rows[0].n,1);
  checks.push("actual IndexedDB abort prevents authenticated join admission");
  const {io}=local("socket.io-client");
  const intruder=io(base,{transports:["websocket"],reconnection:false,auth:{dimleProtocol:"durable-session-v1"}});
  await once(intruder,"connect");
  try {
   const joined=await intruder.timeout(3000).emitWithAck("join-room",{roomId:"wire335",username:"OriginalOwner",password:"private-fixture-password"});
   assert.notEqual(joined.lease.sessionId,original[0].id);
   const key=(await db.query("SELECT client_message_id FROM resume_message_receipts WHERE session_id=$1",[original[0].id])).rows[0].client_message_id;
   const denied=await intruder.timeout(3000).emitWithAck("private-text-receipt",{roomId:"wire335",sessionId:original[0].id,type:"message",clientMessageId:key,message:"lost-ack-wire335"});
   assert.deepEqual(denied,{outcome:"unknown"});
   assert.deepEqual((await db.query("SELECT id,content FROM messages")).rows,saved);
   checks.push("same room/password/name new owner cannot resolve original receipt; DB payload unchanged");
  } finally {intruder.disconnect()}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:"PASS",scope:"PUBLIC room rendered Chrome + actual local PostgreSQL; not managed or physical-device acceptance",checks,wireSends:sends,lostACKs:dropped,preservedMessageId:saved[0].id,browser:browser.version()}));
 }catch(e){console.error(e);console.error("server diagnostics:",logs);throw e}
 finally{await browser?.close();child.kill("SIGTERM");if(child.exitCode===null)await once(child,"exit");await db.end()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
