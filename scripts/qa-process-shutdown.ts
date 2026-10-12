import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { io, type Socket } from "socket.io-client";

async function main() {
  const url = process.env.RESUME_TEST_DATABASE_URL!;
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const env = { ...process.env, DATABASE_URL: url, PORT: process.env.OWNED_APP_PORT!,
    UPLOAD_DIR: process.env.OWNED_UPLOAD_DIR!, NODE_ENV: "production" as const,
    ALFRED_API_KEY: "owned-shutdown-key", DIMLE_AGENT_API_KEYS_JSON: "" };
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", exited = false;
  child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  const db = new Pool({ connectionString: url }), lock = await db.connect();
  let locked = false;
  let socket: Socket | undefined;
  const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    for (let i = 0; i < 400; i++) {
      if (await check()) return;
      if (exited) throw Error("Premature process exit: " + output);
      await delay(25);
    }
    throw Error("Timeout " + label + ": " + output);
  };
  const base = "http://127.0.0.1:" + env.PORT;
  try {
    await until(() => output.includes("Dimle running"), "startup");
    const created = await (await fetch(base + "/api/rooms", { method: "POST" })).json();
    socket = io(base, { transports: ["websocket"], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", resolve); socket!.once("connect_error", reject);
    });
    const joined = new Promise(resolve => socket!.once("room-snapshot", resolve));
    socket.emit("join-room", { ...created, username: "Shutdown fixture" });
    await joined;
    await lock.query("BEGIN"); await lock.query("LOCK TABLE messages IN SHARE MODE"); locked = true;
    const response = fetch(base + "/api/send", { method: "POST", headers: {
      "Content-Type": "application/json", "x-api-key": env.ALFRED_API_KEY,
    }, body: JSON.stringify({ roomId: created.roomId, message: "shutdown-retained", clientMessageId: "shutdown-retained" }) });
    await until(async () => (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND wait_event_type='Lock' AND query ILIKE '%INSERT INTO%messages%'`)).rows[0].n === 1, "real blocked writer");
    child.kill("SIGTERM");
    await until(() => output.includes("Dimle shutdown started"), "signal");
    child.kill("SIGTERM");
    const denied = await fetch(base + "/api/rooms", { method: "POST" });
    assert.equal(denied.status, 503);
    await delay(100); assert.equal(exited, false);
    assert.equal(output.includes("Dimle shutdown settled"), false);
    await lock.query("ROLLBACK"); locked = false;
    assert.equal((await response).status, 200);
    const result = await Promise.race([exit, delay(10000).then(() => { throw Error("Shutdown did not finish: " + output); })]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(socket.connected, false);
    assert.equal((output.match(/Dimle shutdown started/g) || []).length, 1);
    assert.equal((output.match(/Dimle shutdown settled/g) || []).length, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE content='shutdown-retained'")).rows[0].n, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND pid<>$1", [(await lock.query("SELECT pg_backend_pid() AS pid")).rows[0].pid])).rows[0].n, 0);
    console.log(JSON.stringify({ result: "PASS", actualCliProcess: true, signals: 2, shutdowns: 1,
      retainedBlockedSql: true, newAdmissionStatus: 503, durableMessages: 1, processExit: result,
      appDatabaseBackendsAfterExit: 0, output }));
  } finally {
    socket?.disconnect();
    if (locked) await lock.query("ROLLBACK");
    if (!exited) { child.kill("SIGKILL"); await exit; }
    lock.release(); await db.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
