import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { io, type Socket } from "socket.io-client";
import { Pool } from "pg";

// Actual server.ts, real Socket.IO and disposable PostgreSQL. No live services.
async function main() {
  const url = process.env.RESUME_TEST_DATABASE_URL!;
  assert.ok(url && new URL(url).hostname === "127.0.0.1");
  const port = process.env.OWNED_APP_PORT!;
  assert.match(port, /^\d+$/);
  const base = "http://127.0.0.1:" + port;
  const db = new Pool({ connectionString: url });
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    env: { ...process.env, DATABASE_URL: url, PORT: port, NODE_ENV: "production",
      ALFRED_API_KEY: "", DIMLE_AGENT_API_KEYS_JSON: "", UPLOAD_DIR: process.env.OWNED_UPLOAD_DIR! },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = ""; child.stdout.on("data", x => logs += x); child.stderr.on("data", x => logs += x);
  const clients: Socket[] = [];
  const connect = async () => {
    const socket = io(base, { transports: ["websocket"], reconnection: false, forceNew: true });
    clients.push(socket);
    await Promise.race([new Promise<void>(resolve => socket.once("connect", () => resolve())), new Promise((_, reject) => setTimeout(() => reject(Error("connect timeout")), 5000).unref())]);
    return socket;
  };
  const event = (s: Socket, name: string) => Promise.race([
    new Promise<any>(resolve => s.once(name, resolve)),
    new Promise<never>((_, reject) => setTimeout(() => reject(Error(name + " timeout")), 5000).unref()),
  ]);
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw Error("server exited: " + logs);
      try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, logs);
    const created = await (await fetch(base + "/api/rooms", { method: "POST" })).json();
    assert.ok(created.roomId && created.creationToken);
    const a = await connect();
    const anonymous = await a.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId });
    assert.match(anonymous.error, /Rejoin/);
    let snapshots = 0; const packets: unknown[] = [];
    a.onAny((name, ...args) => { packets.push([name, args]); if (name === "room-snapshot") snapshots++; });
    const joined = event(a, "room-snapshot");
    const join = { ...created, username: "Alice", password: "test-only-password" };
    a.emit("join-room", join);
    assert.deepEqual((await joined).users, ["Alice"]);
    const sessions = await db.query("SELECT id, generation, token_hash, username FROM room_resume_sessions WHERE room_id=$1", [created.roomId]);
    assert.equal(sessions.rowCount, 1); assert.equal(sessions.rows[0].generation, 1);
    const first = sessions.rows[0];
    a.emit("join-room", join);
    const synced = await a.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId });
    assert.deepEqual(synced.users, ["Alice"]);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(snapshots, 1, "exact join retry cannot republish snapshot");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM room_resume_sessions")).rows[0].n, 1);
    assert.deepEqual(await a.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId, probeOnly: true }), { ok: true });
    const bad = await connect(); const denied = event(bad, "join-error");
    bad.emit("join-room", { roomId: created.roomId, username: "Intruder", password: "wrong" });
    assert.equal(await denied, "Wrong password");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM room_resume_sessions")).rows[0].n, 1);
    const b = await connect(); const other = event(b, "room-snapshot");
    b.emit("join-room", { roomId: created.roomId, username: "Bob", password: join.password });
    assert.deepEqual((await other).users.sort(), ["Alice", "Bob"]);
    const message = event(b, "chat-message");
    const sent = await a.timeout(3000).emitWithAck("send-message", { roomId: created.roomId, message: "compatibility" });
    assert.ok(sent.message.id); assert.equal((await message).message, "compatibility");
    const history = await b.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId });
    assert.equal(history.history.length, 1);
    assert.ok(!JSON.stringify(packets).includes(first.token_hash));
    assert.ok(!JSON.stringify(packets).includes(first.id), "no public credential/session envelope yet");
    const left = event(b, "user-list"); a.disconnect();
    assert.deepEqual(await left, ["Bob"]);
    // Hold the actual history SELECT in PostgreSQL, then lose the physical
    // transport. Releasing the query must not create a late ghost membership.
    const lock = await db.connect();
    const pending = await connect();
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE messages IN ACCESS EXCLUSIVE MODE");
      pending.emit("join-room", { roomId: created.roomId, username: "Late", password: join.password });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id, type, username, content, ts%'");
        if (waiting.rowCount) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(blocked, "actual join history was waiting on database lock");
      pending.disconnect();
      // A separate Socket.IO round trip lets the server process the disconnect.
      await b.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId, probeOnly: true });
    } finally {
      await lock.query("ROLLBACK"); lock.release();
    }
    const afterLoss = await b.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId });
    assert.deepEqual(afterLoss.users, ["Bob"], "late history cannot resurrect disconnected membership");
    await db.query("UPDATE rooms SET auth_version=auth_version+1 WHERE id=$1", [created.roomId]);
    const revoked = await b.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId });
    assert.ok(revoked.error); assert.equal(revoked.history, undefined);
    console.log("PUBLIC_SESSION_PASS: real authenticated join, one issuance/generation/snapshot on retry, wrong-password denial, no credential leak, two-user presence, legacy send compatibility, authorized sync, disconnect cleanup, blocked-history disconnect fencing, policy-change history denial");
  } finally {
    clients.forEach(s => s.disconnect());
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await db.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
