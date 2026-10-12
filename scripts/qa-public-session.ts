import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { io, type Socket } from "socket.io-client";
import { Pool } from "pg";
import fs from "node:fs/promises";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { uploadRoomFile } from "../src/lib/upload-client";
import { hashResumeToken } from "../src/lib/resume-store";
import { createTextSender } from "../src/lib/text-message-client";

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
    const initialSnapshot = await joined;
    assert.deepEqual(initialSnapshot.users, ["Alice"]);
    assert.equal(initialSnapshot.capabilities.textOperationKeys, true);
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
    // The actual browser sender loses its first receipt AFTER the real server
    // committed. A manual same-transport retry must reuse that durable row.
    let dropReceipt = true, browserFanouts = 0;
    b.on("chat-message", m => { if (m.message === "browser-uncertain") browserFanouts++; });
    const browserWire = {
      get id() { return a.id; }, get connected() { return a.connected; },
      get volatile() { return this; }, timeout() { return this; },
      async emitWithAck(name: string, payload: unknown) {
        const receipt = await a.volatile.timeout(3000).emitWithAck(name, payload);
        if (dropReceipt) { dropReceipt = false; throw Error("simulated lost browser receipt"); }
        return receipt;
      },
    } as unknown as Socket;
    const browserSession = {
      sync: async () => {
        const result = await a.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId });
        assert.ok(!result.error); return a.id!;
      },
      isReady: () => a.connected,
      canRetryText: () => initialSnapshot.capabilities.textOperationKeys === true,
    };
    const browserSender = createTextSender();
    await assert.rejects(browserSender.send(browserWire, browserSession, created.roomId, "browser-uncertain"), /lost browser receipt/);
    const reconciled = await browserSender.send(browserWire, browserSession, created.roomId, "browser-uncertain");
    assert.ok(reconciled.id);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(browserFanouts, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE content='browser-uncertain'")).rows[0].n, 1);
    const intentionalRepeat = await browserSender.send(browserWire, browserSession, created.roomId, "browser-uncertain");
    assert.notEqual(intentionalRepeat.id, reconciled.id);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages WHERE content='browser-uncertain'")).rows[0].n, 2);
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
    const upload = (socketId: string, roomId = created.roomId, headers: Record<string, string> = {}) => {
      const body = new FormData(); body.append("file", new Blob(["wire-upload"]), "proof.txt");
      return fetch(base + "/api/upload", { method: "POST", body,
        headers: { "x-room-id": roomId, "x-socket-id": socketId, ...headers }, signal: AbortSignal.timeout(5000) });
    };
    const deniedBeforeBody = async (response: Response) => {
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "UPLOAD_AUTH_REQUIRED");
    };
    const filesBefore = await fs.readdir(process.env.OWNED_UPLOAD_DIR!);
    await deniedBeforeBody(await upload(a.id!, "wrong123"));
    await deniedBeforeBody(await upload(bad.id!));
    for (const mutation of ["revoked_at=now()", "generation=generation+1", "expires_at=now()-interval '1 second'"]) {
      const prior = (await db.query("SELECT expires_at, generation FROM room_resume_sessions WHERE id=$1", [first.id])).rows[0];
      await db.query("UPDATE room_resume_sessions SET " + mutation + " WHERE id=$1", [first.id]);
      await deniedBeforeBody(await upload(a.id!));
      await db.query("UPDATE room_resume_sessions SET revoked_at=NULL, generation=$2, expires_at=$3 WHERE id=$1", [first.id, prior.generation, prior.expires_at]);
    }
    assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), filesBefore, "denial never starts parser or creates token directories");
    // Real client retries exactly once only after the actual pre-body marker.
    let retryRequests = 0, retryReconnects = 0;
    const retryResult = await uploadRoomFile(new File(["retry-proof"], "retry.txt"), created.roomId, {
      uploadAuthority: (roomId, socketId) => ({ kind: "legacy", roomId, socketId }),
      sync: async () => "stale-socket",
      reconnect: async () => { retryReconnects++; return a.id!; },
    }, async (url, options) => { retryRequests++; return fetch(base + url, options); });
    assert.equal(retryRequests, 2); assert.equal(retryReconnects, 1);
    const retryRows = await db.query("SELECT id FROM messages WHERE room_id=$1 AND type=$2 AND content::jsonb->>$3=$4",
      [created.roomId, "file", "name", "retry.txt"]);
    assert.equal(retryRows.rowCount, 1);
    assert.equal(Number(retryRows.rows[0].id), retryResult.message.id);
    assert.equal((await fs.readdir(process.env.OWNED_UPLOAD_DIR!)).length, filesBefore.length + 1);
    console.log("PUBLIC_UPLOAD_RETRY_PASS: explicit pre-body rejection, one reconnect, two requests, exactly one durable file/message");
    const validUpload = await upload(a.id!);
    assert.equal(validUpload.status, 200);
    assert.equal((await validUpload.json()).message.username, "Alice");
    // Fixture controls only the disposable DB's token hash. No public issuance
    // seam or test-only endpoint is added to the real server.
    const token = randomBytes(32).toString("base64url");
    await db.query("UPDATE room_resume_sessions SET token_hash=$2 WHERE id=$1", [first.id, hashResumeToken(token)]);
    const credentialHeaders = { "x-resume-session-id": first.id, "x-resume-token": token };
    const credentialBefore = await fs.readdir(process.env.OWNED_UPLOAD_DIR!);
    // Send only headers: generic JSON parsing must not start/wait for the body.
    const invalidFraming = http.request(base + "/api/upload", { method: "POST", headers: {
      "x-room-id": created.roomId, "x-socket-id": a.id!, ...credentialHeaders,
      "content-type": "application/json", "content-length": "1000",
    } });
    const invalidFramingStatus = new Promise<number>((resolve, reject) => {
      invalidFraming.once("error", reject);
      invalidFraming.setTimeout(3000, () => invalidFraming.destroy(Error("prebody rejection timeout")));
      invalidFraming.once("response", res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    });
    invalidFraming.flushHeaders();
    try { assert.equal(await invalidFramingStatus, 400); } finally { invalidFraming.destroy(); }
    for (const headers of [
      { "x-resume-token": token }, { "x-resume-session-id": first.id },
      { "x-resume-token": "" }, { "x-resume-session-id": "" },
      { "x-resume-token": "", "x-resume-session-id": "" },
      { ...credentialHeaders, "x-resume-token": "" },
      { ...credentialHeaders, "x-resume-session-id": "" },
      { ...credentialHeaders, "x-resume-token": token + ", " + token },
      { ...credentialHeaders, "x-resume-session-id": first.id + ", " + first.id },
      { ...credentialHeaders, "x-resume-token": randomBytes(32).toString("base64url") },
      { ...credentialHeaders, "x-resume-session-id": "00000000-0000-4000-8000-000000000000" },
    ]) {
      assert.equal((await upload(a.id!, created.roomId, headers as Record<string, string>)).status, 403,
        "credential denial must never downgrade to otherwise-valid legacy socket authority");
    }
    assert.equal((await upload(b.id!, created.roomId, credentialHeaders)).status, 403,
      "a valid credential is bound to its exact server-owned session, not another room member");
    assert.equal((await upload(a.id!, created.roomId, { ...credentialHeaders, "content-encoding": "gzip" })).status, 400);
    assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), credentialBefore);
    // The real browser uploader sends the complete bearer/key envelope, but
    // actual server composition is still unavailable. No downgrade or replay.
    let strictBrowserRequests = 0;
    await assert.rejects(uploadRoomFile(new File(["private-browser"], "private.txt", { type: "text/plain" }),
      created.roomId, {
        sync: async () => a.id!,
        reconnect: async () => assert.fail("strict browser must not password-rejoin"),
        uploadAuthority: (roomId, socketId) => ({ kind: "resume", roomId, socketId,
          sessionId: first.id, token }),
      }, async (path, options) => {
        strictBrowserRequests++;
        const headers = options!.headers as Record<string, string>;
        assert.equal(headers["x-resume-session-id"], first.id);
        assert.equal(headers["x-resume-token"], token);
        assert.match(headers["x-client-message-id"], /^[a-f0-9-]{36}$/);
        return fetch(base + path, options);
      }), /not available yet/);
    assert.equal(strictBrowserRequests, 1);
    assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), credentialBefore);
    console.log("PUBLIC_BROWSER_UPLOAD_AUTHORITY_PASS: real fetch bearer/key envelope; unavailable composition denies once; no reconnect, downgrade or filesystem mutation");
    const messageCountBefore = (await db.query("SELECT count(*)::int AS n FROM messages")).rows[0].n;
    // A valid credential must not admit the legacy writer when the physical
    // resource pipeline is unprovisioned. Headers only: no body to parse.
    for (let attempt = 0; attempt < 4; attempt++) {
      const request = http.request(base + "/api/upload", { method: "POST", headers: {
        "x-room-id": created.roomId, "x-socket-id": a.id!, ...(attempt < 2 ? credentialHeaders : {}),
        "content-type": attempt === 3 ? "application/json" : "multipart/form-data; boundary=resourceproof", "content-length": "1000",
      } });
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
        request.once("error", reject);
        request.setTimeout(3000, () => request.destroy(Error("resource gate waited for body")));
        request.once("response", res => {
          let body = ""; res.on("data", chunk => body += chunk);
          res.once("end", () => resolve({ status: res.statusCode!, body }));
        });
      });
      request.flushHeaders();
      try {
        const result = await response;
        assert.equal(result.status, attempt < 2 ? 503 : 403, "strict denial must not wait for a body or downgrade");
        if (attempt < 2) assert.equal(JSON.parse(result.body).code, "UPLOAD_RESOURCE_UNAVAILABLE");
      } finally { request.destroy(); }
    }
    const authenticatedUpload = await upload(a.id!, created.roomId, credentialHeaders);
    assert.equal(authenticatedUpload.status, 503);
    assert.equal((await authenticatedUpload.json()).code, "UPLOAD_RESOURCE_UNAVAILABLE");
    assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), credentialBefore);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages")).rows[0].n, messageCountBefore);
    for (const table of ["upload_resource_domains", "upload_resource_policies", "upload_resource_attempts",
      "resume_upload_budget", "resume_upload_attempts"]) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0,
        "denial cannot provision policy, reserve or refund guessed resources");
    }
    for (const mutation of ["revoked_at=now()", "generation=generation+1", "expires_at=now()-interval '1 second'"]) {
      const prior = (await db.query("SELECT expires_at, generation FROM room_resume_sessions WHERE id=$1", [first.id])).rows[0];
      const before = await fs.readdir(process.env.OWNED_UPLOAD_DIR!);
      await db.query("UPDATE room_resume_sessions SET " + mutation + " WHERE id=$1", [first.id]);
      assert.equal((await upload(a.id!, created.roomId, credentialHeaders)).status, 403);
      assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), before);
      await db.query("UPDATE room_resume_sessions SET revoked_at=NULL, generation=$2, expires_at=$3 WHERE id=$1", [first.id, prior.generation, prior.expires_at]);
    }
    console.log("PUBLIC_UPLOAD_CREDENTIAL_PASS: real HTTP bearer lookup; partial/forged/wrong-owner denial; valid credentials fail closed before body/FS/file-ledger mutation without resource composition; repeated denial releases grant");
    // Server-owned strict classification survives omission of both headers.
    // Prove separate normal-join compatibility and persisted bytes independently.
    const omittedHeaders = await upload(a.id!);
    assert.equal(omittedHeaders.status, 403, "authenticated strict owner cannot downgrade by omitting headers");
    assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), credentialBefore);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM messages")).rows[0].n, messageCountBefore);
    const compatibleLegacy = await upload(b.id!);
    assert.equal(compatibleLegacy.status, 200, "untouched normal join retains legacy compatibility");
    const omittedMessage = (await compatibleLegacy.json()).message;
    assert.ok(omittedMessage.id);
    const omittedRow = await db.query("SELECT content FROM messages WHERE id=$1 AND type='file'", [omittedMessage.id]);
    assert.equal(omittedRow.rowCount, 1);
    const omittedFile = JSON.parse(omittedRow.rows[0].content);
    assert.equal(await (await fetch(base + omittedFile.url)).text(), "wire-upload");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM upload_resource_attempts")).rows[0].n, 0,
      "legacy compatibility is NOT strict physical accounting");
    assert.ok(!JSON.stringify(packets).includes(token), "fixture bearer is never publicly published");
    console.log("PUBLIC_UPLOAD_ACTIVATION_GATE_PASS: authenticated strict owner cannot omit headers to downgrade; separate normal join retains compatibility; public resume remains disabled");
    // Pause actual multipart AFTER storage allocation, then change authority.
    // Disconnect alone must not revoke the already admitted HTTP lifetime.
    for (const scenario of ["revoke", "generation", "expiry", "policy", "disconnect"]) {
      // Separate rooms preserve the real eight-joins/minute limiter baseline.
      const lifetimeRoom = await (await fetch(base + "/api/rooms", { method: "POST" })).json();
      const uploader = await connect(), ready = event(uploader, "room-snapshot");
      const username = "Lifetime-" + scenario;
      uploader.emit("join-room", { ...lifetimeRoom, username, password: join.password });
      await ready;
      const before = await fs.readdir(process.env.OWNED_UPLOAD_DIR!);
      const head = '--proofboundary\r\nContent-Disposition: form-data; name="file"; filename="lifetime.txt"\r\nContent-Type: text/plain\r\n\r\nfirst';
      const tail = 'last\r\n--proofboundary--\r\n';
      const request = http.request(base + "/api/upload", { method: "POST", headers: {
        "x-room-id": lifetimeRoom.roomId, "x-socket-id": uploader.id!,
        "content-type": "multipart/form-data; boundary=proofboundary",
        "content-length": Buffer.byteLength(head + tail),
      } });
      const response = new Promise<number>((resolve, reject) => {
        request.once("error", reject);
        request.once("response", res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
      });
      request.write(head);
      let allocated = false;
      for (let i = 0; i < 100; i++) {
        if ((await fs.readdir(process.env.OWNED_UPLOAD_DIR!)).length > before.length) { allocated = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      assert.ok(allocated, "real parser began before authority changed");
      if (scenario === "revoke") {
        const inventory = await fs.readdir(process.env.OWNED_UPLOAD_DIR!);
        assert.equal((await upload(uploader.id!, lifetimeRoom.roomId)).status, 429);
        assert.deepEqual(await fs.readdir(process.env.OWNED_UPLOAD_DIR!), inventory,
          "one admitted body per session; rejection cannot allocate another file");
      }
      if (scenario === "policy") {
        await db.query("UPDATE rooms SET auth_version=auth_version+1 WHERE id=$1", [lifetimeRoom.roomId]);
      } else if (scenario !== "disconnect") {
        const mutation = { revoke: "revoked_at=now()", generation: "generation=generation+1",
          expiry: "expires_at=now()-interval '1 second'" }[scenario];
        assert.ok(mutation);
        await db.query("UPDATE room_resume_sessions SET " + mutation + " WHERE room_id=$1 AND username=$2", [lifetimeRoom.roomId, username]);
      } else {
        uploader.disconnect();
        await b.timeout(3000).emitWithAck("sync-room", { roomId: created.roomId, probeOnly: true });
      }
      request.end(tail);
      assert.equal(await response, scenario === "disconnect" ? 200 : 403);
      const rows = await db.query("SELECT id FROM messages WHERE room_id=$1 AND username=$2 AND type='file'", [lifetimeRoom.roomId, username]);
      assert.equal(rows.rowCount, scenario === "disconnect" ? 1 : 0);
      if (scenario === "revoke") {
        await db.query("UPDATE room_resume_sessions SET revoked_at=NULL WHERE room_id=$1", [lifetimeRoom.roomId]);
        assert.equal((await upload(uploader.id!, lifetimeRoom.roomId)).status, 200,
          "settled denial releases the lifetime permit");
      }
      uploader.disconnect();
    }
    console.log("PUBLIC_UPLOAD_LIFETIME_PASS: legacy actual paused multipart revocation/generation/expiry/policy deny INSERT; admitted disconnect persists once; strict credential branch remains unavailable");
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
