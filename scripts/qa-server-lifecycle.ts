import assert from "node:assert/strict";
import { Pool } from "pg";
import { io, type Socket } from "socket.io-client";
import http from "node:http";
import fs from "node:fs/promises";

async function main() {
  const cancelAgent = process.env.OWNED_LIFECYCLE_CANCEL === "1";
  const url = process.env.RESUME_TEST_DATABASE_URL!;
  assert.equal(new URL(url).hostname, "127.0.0.1");
  process.env.DATABASE_URL = url;
  process.env.PORT = process.env.OWNED_APP_PORT!;
  process.env.UPLOAD_DIR = process.env.OWNED_UPLOAD_DIR!;
  Object.assign(process.env, { NODE_ENV: "production" });
  process.env.ALFRED_API_KEY = "local-lifecycle-test-key";
  process.env.DIMLE_AGENT_API_KEYS_JSON = "";
  const { main: start } = await import("../server");
  const runtime = await start();
  const { pool } = await import("../src/lib/db");
  const db = new Pool({ connectionString: url });
  const base = "http://127.0.0.1:" + process.env.PORT;
  const clients: Socket[] = [];
  const partialRequests: http.ClientRequest[] = [];
  const lock = await db.connect();
  let locked = false;
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise(r => setTimeout(r, 25));
    }
    console.error("owned fixture pending SQL:", (await db.query("SELECT state, wait_event_type, wait_event, query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")).rows);
    throw Error("Timeout: " + label);
  };
  const connect = async () => {
    const socket = io(base, { transports: ["websocket"], reconnection: false });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve()); socket.once("connect_error", reject);
    });
    return socket;
  };
  try {
    const created = await (await fetch(base + "/api/rooms", { method: "POST" })).json();
    const a = await connect(), b = await connect(), c = await connect(), d = await connect();
    for (const [socket, username] of [[a, "Alice"], [b, "Bob"], [c, "Carol"], [d, "Dan"]] as const) {
      const joined = new Promise(resolve => socket.once("room-snapshot", resolve));
      socket.emit("join-room", { ...created, username }); await joined;
    }
    await lock.query("BEGIN"); await lock.query("LOCK TABLE messages IN SHARE MODE"); locked = true;
    const agent = fetch(base + "/api/send", { method: "POST", headers: {
      "Content-Type": "application/json", "x-api-key": process.env.ALFRED_API_KEY,
    }, body: JSON.stringify({ roomId: created.roomId, message: "lifecycle-agent", clientMessageId: "lifecycle-agent" }) });
    // An ACK timeout/disconnect must not release this actual SQL producer.
    a.emit("send-message", { roomId: created.roomId, message: "lifecycle-socket", clientMessageId: "lifecycle-socket" });
    const data = new FormData(); data.append("file", new Blob(["lifecycle upload bytes"]), "lifecycle.txt");
    const upload = fetch(base + "/api/upload", { method: "POST", headers: {
      "x-room-id": created.roomId, "x-socket-id": b.id!,
    }, body: data });
    await until(async () => (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND pid <> pg_backend_pid()
      AND wait_event_type='Lock' AND query ILIKE '%INSERT INTO%messages%'`)).rows[0].n >= 3, "three real locked INSERTs");
    assert.ok(runtime.lifecycle.activeHandlers >= 3);
    const slow = (socket: Socket, filename: string) => {
      const boundary = "lifecycle-boundary";
      const start = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\npartial-data`;
      const end = `-finished\r\n--${boundary}--\r\n`;
      let resolve!: (status: number) => void;
      const response = new Promise<number>(r => { resolve = r; });
      const req = http.request(base + "/api/upload", { method: "POST", headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": Buffer.byteLength(start + end),
        "x-room-id": created.roomId, "x-socket-id": socket.id!,
      } }, res => { res.resume(); resolve(res.statusCode!); });
      partialRequests.push(req);
      req.on("error", () => resolve(0));
      req.write(start);
      return { req, end, response };
    };
    const slowComplete = slow(c, "slow.txt"), slowAbort = slow(d, "abort.txt");
    await until(async () => (await fs.readdir(process.env.UPLOAD_DIR!)).length === 3, "both real partial storage writers");
    assert.ok(runtime.lifecycle.activeHandlers >= 5);
    a.disconnect();
    const stop = runtime.lifecycle.stopAndSettle();
    assert.equal(runtime.lifecycle.stopAndSettle(), stop);
    let settled = false; void stop.then(() => { settled = true; });
    // Send incomplete JSON with an announced body. A 503 must arrive without
    // completing that body: admission is ahead of body parsing.
    for (const route of ["/api/rooms", "/api/send", "/api/upload"]) {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(base + route, { method: "POST", headers: {
          "Content-Type": "application/json", "Content-Length": "1000",
        } }, res => {
          assert.equal(res.statusCode, 503); res.resume(); req.destroy(); resolve();
        });
        req.on("error", reject); req.setTimeout(2000, () => req.destroy(Error("body was parsed before rejection")));
        req.flushHeaders(); req.write("{");
      });
    }
    for (const event of ["sync-room", "send-message", "send-image", "private-message"]) {
      const denied = await b.timeout(2000).emitWithAck(event, { roomId: created.roomId, message: "must not write" });
      assert.match(denied.error, /draining/);
    }
    const deniedJoin = new Promise(resolve => b.once("join-error", resolve));
    b.emit("join-room", { ...created, username: "Late join" });
    assert.match(String(await deniedJoin), /draining/);
    const late = io(base, { transports: ["websocket"], reconnection: false, autoConnect: false });
    clients.push(late);
    const lateDisconnected = new Promise(resolve => late.once("disconnect", resolve));
    late.connect(); await lateDisconnected;
    assert.equal(late.connected, false);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM room_resume_sessions")).rows[0].n, 4);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(settled, false, "transport loss must not settle blocked SQL");
    if (cancelAgent) {
      const victim = await db.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type=\'Lock\' AND query ILIKE \'%INSERT INTO%messages%on conflict%\'`);
      assert.equal(victim.rowCount, 1);
      assert.equal((await db.query("SELECT pg_cancel_backend($1) AS cancelled", [victim.rows[0].pid])).rows[0].cancelled, true);
      assert.equal((await agent).status, 500);
      assert.equal(settled, false, "failed SQL cannot hide sibling SQL/storage");
    }
    await lock.query("ROLLBACK"); locked = false;
    const [agentResponse, uploadResponse] = await Promise.all([agent, upload]);
    slowAbort.req.destroy();
    await slowAbort.response;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(settled, false, "active multipart writer retains drain after SQL settlement and sibling abort");
    slowComplete.req.end(slowComplete.end);
    assert.equal(await slowComplete.response, 200, "already-admitted legacy upload finishes after owner close");
    const report = await stop;
    assert.equal(agentResponse.status, cancelAgent ? 500 : 200);
    assert.ok([200, 403].includes(uploadResponse.status));
    assert.equal(runtime.lifecycle.activeHandlers, 0);
    assert.equal(runtime.lifecycle.retainedOwners, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE content='lifecycle-agent'")).rows[0].n, cancelAgent ? 0 : 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE content='must not write'")).rows[0].n, 0);
    const dirs = await fs.readdir(process.env.UPLOAD_DIR!);
    assert.equal(dirs.length, 3, "closed admission creates no extra upload directories");
    assert.equal(runtime.lifecycle.run(() => assert.fail("reopened")), null);
    console.log(JSON.stringify({ result: "PASS", cancelAgent, lockedWriters: 3, rejectedHttpBeforeBody: 3,
      rejectedSocketEvents: 5, rejectedNewConnections: 1, retainedPartialUploads: 2, report }));
  } finally {
    for (const request of partialRequests) request.destroy();
    if (locked) await lock.query("ROLLBACK");
    lock.release();
    for (const client of clients) client.disconnect();
    await runtime.lifecycle.stopAndSettle();
    await new Promise<void>(resolve => runtime.io.close(() => resolve()));
    await runtime.app.close();
    await pool.end(); await db.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
