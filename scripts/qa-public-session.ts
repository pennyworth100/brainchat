import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { io, type Socket } from "socket.io-client";
import { Pool } from "pg";
import fs from "node:fs/promises";

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
    // Real writer idempotency: one row/fanout; conflicting payload is not replayed.
    let fanouts = 0; b.on("chat-message", () => fanouts++);
    const keyed = { roomId: created.roomId, message: "keyed", clientMessageId: "wire-text-1" };
    const firstSend = await a.timeout(3000).emitWithAck("send-message", keyed);
    const repeat = await a.timeout(3000).emitWithAck("send-message", keyed);
    assert.equal(repeat.message.id, firstSend.message.id);
    const conflict = await a.timeout(3000).emitWithAck("send-message", { ...keyed, message: "conflict" });
    assert.ok(conflict.error);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(fanouts, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE content='keyed'")).rows[0].n, 1);
    const imagePayload = { roomId: created.roomId, dataUrl: "data:image/png;base64,YQ==", clientMessageId: "wire-image-1" };
    let imageFanouts = 0; b.on("chat-image", () => imageFanouts++);
    const image = event(b, "chat-image");
    const imageSend = await a.timeout(3000).emitWithAck("send-image", imagePayload);
    assert.equal((await image).id, imageSend.message.id);
    assert.equal((await a.timeout(3000).emitWithAck("send-image", imagePayload)).message.id, imageSend.message.id);
    assert.ok((await a.timeout(3000).emitWithAck("send-image", { ...imagePayload, clientMessageId: "wire-text-1" })).error);
    assert.ok((await a.timeout(3000).emitWithAck("send-message", { ...keyed, roomId: "wrong123" })).error);
    assert.ok((await bad.timeout(3000).emitWithAck("send-image", imagePayload)).error);
    assert.ok((await a.timeout(3000).emitWithAck("send-message", null)).error);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(imageFanouts, 1, "image retry never repeats peer publication");
    assert.ok((await a.timeout(3000).emitWithAck("send-image", {
      ...imagePayload, clientMessageId: "malformed-image", dataUrl: "data:image/png;base64,!"
    })).error);
    const legacyEcho = event(a, "chat-image");
    a.emit("send-image", { roomId: created.roomId, dataUrl: imagePayload.dataUrl });
    assert.equal((await legacyEcho).dataUrl, imagePayload.dataUrl);
    // Actual DM handler + PostgreSQL: BOTH endpoint policies, before emission
    // and after receiver ACK. Revocation during ACK must not report delivery.
    const dmPayload = { roomId: created.roomId, toUsername: "Bob", message: "private-wire" };
    let dmDeliveries = 0, dmSent = 0;
    a.on("private-message-sent", () => dmSent++);
    b.on("private-message", () => dmDeliveries++);
    for (const username of ["Alice", "Bob"]) {
      await db.query("UPDATE room_resume_sessions SET revoked_at=now() WHERE room_id=$1 AND username=$2", [created.roomId, username]);
      const denied = await a.timeout(3000).emitWithAck("private-message", dmPayload);
      assert.match(denied.error, /Rejoin/);
      assert.equal(dmDeliveries, 0, "revoked endpoint cannot receive payload");
      await db.query("UPDATE room_resume_sessions SET revoked_at=NULL WHERE room_id=$1 AND username=$2", [created.roomId, username]);
    }
    for (const username of ["Alice", "Bob"]) {
      const incoming = new Promise<(value: unknown) => void>(resolve =>
        b.once("private-message", (_data, ack) => resolve(ack)));
      const pendingDM = a.timeout(3000).emitWithAck("private-message", dmPayload);
      const recipientAck = await incoming;
      const overlap = await a.timeout(3000).emitWithAck("private-message", dmPayload);
      assert.match(overlap.error, /pending/);
      // This UPDATE completing before ACK also proves no DB lock is retained
      // across the network wait (would deadlock/time out otherwise).
      await db.query("UPDATE room_resume_sessions SET revoked_at=now() WHERE room_id=$1 AND username=$2", [created.roomId, username]);
      recipientAck({ received: true });
      assert.match((await pendingDM).error, /Delivery not confirmed/);
      assert.equal(dmSent, 0);
      await db.query("UPDATE room_resume_sessions SET revoked_at=NULL WHERE room_id=$1 AND username=$2", [created.roomId, username]);
    }
    assert.equal(dmDeliveries, 2, "no replay for unconfirmed DM");
    a.once("private-message", (_data, ack) => ack({ received: true }));
    b.once("private-message", (_data, ack) => ack({ received: true }));
    const reciprocal = await Promise.all([
      a.timeout(3000).emitWithAck("private-message", dmPayload),
      b.timeout(3000).emitWithAck("private-message", { ...dmPayload, toUsername: "Alice" }),
    ]);
    assert.deepEqual(reciprocal, [{ delivered: true }, { delivered: true }]);
    assert.equal(dmSent, 1, "reciprocal DM completes without deadlock");
    console.log("PUBLIC_DM_PASS: real PostgreSQL dual endpoint revocation before send/after ACK, no false success/replay, no locks over ACK, one in-flight request, reciprocal lock ordering");
    // Actual HTTP pre-body authority: valid socket IDs cannot bypass durable
    // revocation, wrong-room or expired/generation-mismatched session checks.
    const upload = (socketId: string, roomId = created.roomId) => {
      const body = new FormData(); body.append("file", new Blob(["wire-upload"]), "proof.txt");
      return fetch(base + "/api/upload", { method: "POST", body,
        headers: { "x-room-id": roomId, "x-socket-id": socketId }, signal: AbortSignal.timeout(5000) });
    };
    const filesBefore = await fs.readdir(process.env.OWNED_UPLOAD_DIR!);
    assert.equal((await upload(a.id!, "wrong123")).status, 401);
    assert.equal((await upload(bad.id!)).status, 401);
    for (const mutation of ["revoked_at=now()", "generation=generation+1", "expires_at=now()-interval '1 second'"]) {
      const prior = (await db.query("SELECT expires_at, generation FROM room_resume_sessions WHERE id=$1", [first.id])).rows[0];
      await db.query("UPDATE room_resume_sessions SET " + mutation + " WHERE id=$1", [first.id]);
      assert.equal((await upload(a.id!)).status, 401);
      await db.query("UPDATE room_resume_sessions SET revoked_at=NULL, generation=$2, expires_at=$3 WHERE id=$1", [first.id, prior.generation, prior.expires_at]);
    }
    assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), filesBefore, "denial never starts parser or creates token directories");
    const validUpload = await upload(a.id!);
    assert.equal(validUpload.status, 200);
    assert.equal((await validUpload.json()).message.username, "Alice");
    // Hold the real admission's durable lock, disconnect while it waits, then
    // release: a late successful database result must not start the parser.
    const uploading = await connect(); const uploadingJoined = event(uploading, "room-snapshot");
    uploading.emit("join-room", { roomId: created.roomId, username: "Uploader", password: join.password });
    await uploadingJoined;
    const admissionLock = await db.connect();
    const beforePending = await fs.readdir(process.env.OWNED_UPLOAD_DIR!);
    let pendingUpload: Promise<Response>;
    try {
      await admissionLock.query("BEGIN");
      await admissionLock.query("SELECT id FROM room_resume_sessions WHERE room_id=$1 AND username='Uploader' FOR UPDATE", [created.roomId]);
      pendingUpload = upload(uploading.id!);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM room_resume_sessions WHERE id = $1%'");
        if (waiting.rowCount) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(blocked, "actual HTTP admission waits for session authority");
      // One unresolved admission per physical socket, not another DB waiter.
      assert.equal((await upload(uploading.id!)).status, 401);
      const uploadLeft = event(b, "user-list"); uploading.disconnect(); await uploadLeft;
    } finally { await admissionLock.query("ROLLBACK"); admissionLock.release(); }
    assert.equal((await pendingUpload!).status, 401);
    assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), beforePending);
    console.log("PUBLIC_UPLOAD_ADMISSION_PASS: durable revocation/generation/expiry/wrong-room denial before parser/FS, valid identity, blocked admission disconnect, one in-flight admission");
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
    // Hold a real INSERT after authorization, then disconnect the writer.
    const writer = await connect(); const writerJoined = event(writer, "room-snapshot");
    writer.emit("join-room", { roomId: created.roomId, username: "Writer", password: join.password });
    await writerJoined;
    const writeLock = await db.connect();
    try {
      await writeLock.query("BEGIN");
      await writeLock.query("LOCK TABLE messages IN SHARE MODE");
      writer.emit("send-message", { roomId: created.roomId, message: "must-rollback", clientMessageId: "lost-write" });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'INSERT INTO messages%'");
        if (waiting.rowCount) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(blocked, "actual writer INSERT blocked on database lock");
      assert.ok((await writer.timeout(3000).emitWithAck("send-message", {
        roomId: created.roomId, message: "overlapping", clientMessageId: "overlap-text"
      })).error);
      assert.ok((await writer.timeout(3000).emitWithAck("send-image", imagePayload)).error);
      const writerLeft = event(b, "user-list"); writer.disconnect(); await writerLeft;
    } finally { await writeLock.query("ROLLBACK"); writeLock.release(); }
    // Acquiring the same session lock proves the pending write settled.
    await db.query("SELECT id FROM room_resume_sessions WHERE room_id=$1 AND username='Writer' FOR UPDATE", [created.roomId]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE content='must-rollback'")).rows[0].n, 0);
    await db.query("UPDATE rooms SET auth_version=auth_version+1 WHERE id=$1", [created.roomId]);
    assert.equal((await upload(b.id!)).status, 401, "room policy change denies HTTP upload");
    const countBefore = (await db.query("SELECT count(*)::int AS n FROM messages")).rows[0].n;
    assert.ok((await b.timeout(3000).emitWithAck("send-message", { roomId: created.roomId, message: "revoked" })).error);
    assert.ok((await b.timeout(3000).emitWithAck("send-image", imagePayload)).error);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages")).rows[0].n, countBefore);
    const revoked = await b.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId });
    assert.ok(revoked.error); assert.equal(revoked.history, undefined);
    console.log("PUBLIC_SESSION_PASS: real authenticated join, one issuance/generation/snapshot on retry, wrong-password denial, no credential leak, two-user presence, legacy send compatibility, authorized sync, disconnect cleanup, blocked-history disconnect fencing, policy-change history/text/image denial, text/image same-key retry and conflict, legacy image echo, actual blocked INSERT disconnect rollback");
  } finally {
    clients.forEach(s => s.disconnect());
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await db.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
