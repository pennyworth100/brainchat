/** Local-only integration regression. Start this branch against an isolated DB,
 * then: QA_BASE_URL=http://127.0.0.1:3302 node --import tsx scripts/qa-reconnect-upload.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { io, type Socket } from "socket.io-client";
import { createRoomSession, mergeMessages, type ChatMessage } from "../src/lib/room-session";
import { uploadRoomFile } from "../src/lib/upload-client";

function once<T>(socket: Socket, event: string): Promise<[T]> {
  return new Promise((resolve, reject) => {
    const handler = (payload: T) => { clearTimeout(timer); resolve([payload]); };
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`Timed out: ${event}`)); }, 5000);
    socket.once(event, handler);
  });
}

function expectNoEvent(socket: Socket, event: string, waitMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (payload: unknown) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected ${event}: ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, waitMs);
    socket.once(event, handler);
  });
}

async function main() {
  const base = process.env.QA_BASE_URL || "http://127.0.0.1:3302";
  assert.equal(new URL(base).hostname, "127.0.0.1", "Never run this mutating regression against production");
  const request: typeof fetch = (url, options) => fetch(`${base}${url}`, options);
  const create = await fetch(`${base}/api/rooms`, { method: "POST" });
  assert.equal(create.status, 201);
  const { roomId, creationToken } = await create.json();
  assert.match(roomId, /^[a-z]{3,5}\d{3}$/);
  const mobile = io(base);
  const desktop = io(base);
  const outsider = io(base);
  const wrongPassword = io(base);
  let history: ChatMessage[] = [];
  let users: string[] = [];
  const session = createRoomSession(mobile, {
    onState: () => {},
    onSnapshot: (snapshot) => { history = mergeMessages(history, snapshot.history); users = snapshot.users; },
    onJoined: () => {}, onError: (error) => { throw new Error(error); },
  }, 2000);
  mobile.on("chat-message", (m) => { history = mergeMessages(history, [m]); });
  mobile.on("chat-file", (m) => { history = mergeMessages(history, [m]); });
  try {
    session.join({ roomId, username: "mobile", password: "local-qa", creationToken });
    await session.sync();
    const legacyHistory = once(desktop, "chat-history");
    desktop.emit("join-room", { roomId, username: "legacy-desktop", password: "local-qa" });
    await legacyHistory;

    const wrongPasswordError = once<string>(wrongPassword, "join-error");
    wrongPassword.emit("join-room", { roomId, username: "wrong-password", password: "incorrect" });
    assert.equal((await wrongPasswordError)[0], "Wrong password");
    console.log("PASS room creation/claim, correct password join and wrong password rejection");
    const sent = await desktop.timeout(2000).emitWithAck("send-message", { roomId, message: "before interruption" });
    assert.ok(sent.message.id);
    await session.sync();
    const oldId = mobile.id;
    mobile.disconnect();
    const missed = await desktop.timeout(2000).emitWithAck("send-message", { roomId, message: "sent while mobile offline" });
    await session.reconnect();
    assert.notEqual(mobile.id, oldId);
    assert.equal(history.filter((m) => m.id === missed.message.id).length, 1);
    assert.deepEqual(users.sort(), ["legacy-desktop", "mobile"]);
    for (let i = 0; i < 10; i++) await session.sync();
    assert.equal(history.filter((m) => m.id === missed.message.id).length, 1);
    console.log("PASS rejoin + backfill + dedup + fresh presence + repeated sync");

    const unauthorized = await outsider.timeout(2000).emitWithAck("sync-room", { roomId });
    assert.ok(unauthorized.error);
    assert.equal((await fetch(`${base}/api/upload`, { method: "POST", headers: { "x-room-id": roomId, "x-socket-id": oldId! } })).status, 401);
    assert.equal((await fetch(`${base}/api/upload`, { method: "POST" })).status, 401);
    console.log("PASS unauthorized history and upload rejected (including stale socket ID)");

    const outsiderHistory = once(outsider, "chat-history");
    outsider.emit("join-room", { roomId, username: "outsider", password: "local-qa" });
    await outsiderHistory;
    const recipientDm = once<{ fromUsername: string; message: string; ts: number }>(desktop, "private-message");
    const senderAck = once<{ toUsername: string; message: string }>(mobile, "private-message-sent");
    const outsiderIsolation = expectNoEvent(outsider, "private-message");
    mobile.emit("private-message", { roomId, toUsername: "legacy-desktop", message: "private-only" });
    const [received] = await recipientDm;
    assert.equal(received.fromUsername, "mobile");
    assert.equal(received.message, "private-only");
    assert.equal(typeof received.ts, "number");
    const [ack] = await senderAck;
    assert.equal(ack.toUsername, "legacy-desktop");
    assert.equal(ack.message, "private-only");
    await outsiderIsolation;
    console.log("PASS private message reaches recipient and sender acknowledgement, not third session");

    const oversized = await mobile.timeout(2000).emitWithAck("send-message", {
      roomId,
      message: "x".repeat(10_001),
    });
    assert.equal(oversized.error, "Invalid message");
    console.log("PASS message length limit rejected without disconnecting the room");

    const bytes = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2 * 1024 * 1024, 32), Buffer.from("\n%%EOF")]);
    const result = await uploadRoomFile(new File([bytes], "synthetic-report.pdf", { type: "application/pdf" }), roomId, session, request);
    assert.equal(result.message.type, "file");
    const downloaded = await fetch(`${base}${result.message.url}`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
    await session.sync();
    assert.equal(history.filter((m) => m.id === result.message.id).length, 1);
    console.log("PASS PDF upload/download byte match; HTTP response/live/history produce one message");

    // A rejected upload must not close the room socket.
    const broken = await fetch(`${base}/api/upload`, { method: "POST", headers: { "x-room-id": roomId, "x-socket-id": mobile.id! }, body: new FormData() });
    assert.equal(broken.status, 400);
    const idBeforeFailure = mobile.id;
    const afterError = await mobile.timeout(2000).emitWithAck("send-message", { roomId, message: "text after failed upload" });
    assert.ok(afterError.message.id);
    assert.equal(mobile.id, idBeforeFailure);
    console.log("PASS rejected upload does not disconnect chat; subsequent text persists");

    // Let authentication and the first body chunk finish, then disconnect the
    // socket while the upload stream remains open. This used to orphan files.
    const boundary = "dimle302-test-boundary";
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="during-disconnect.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`);
    const suffix = Buffer.from(`stream completed\n%%EOF\r\n--${boundary}--\r\n`);
    const fileEvent = once<ChatMessage>(desktop, "chat-file");
    const slowResponse = new Promise<{ status: number; data: { message: ChatMessage } }>((resolve, reject) => {
      const req = http.request(`${base}/api/upload`, { method: "POST", headers: {
        "x-room-id": roomId, "x-socket-id": mobile.id!,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": prefix.length + suffix.length,
      } }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, data: JSON.parse(data) }));
      });
      req.on("error", reject);
      req.write(prefix);
      setTimeout(() => { mobile.disconnect(); req.end(suffix); }, 300);
    });
    const completed = await slowResponse;
    assert.equal(completed.status, 200);
    const [broadcast] = await fileEvent;
    assert.equal(broadcast.id, completed.data.message.id);
    await session.reconnect();
    assert.equal(history.filter((m) => m.id === broadcast.id).length, 1);
    console.log("PASS upload accepted before socket loss persists + broadcasts + reappears after rejoin");

    // v3.0.1 posts HTTP, optimistically renders, then emits send-file.
    const form = new FormData();
    form.append("file", new File(["old client"], "legacy.txt"));
    const legacyResponse = await fetch(`${base}/api/upload`, { method: "POST", headers: { "x-room-id": roomId, "x-socket-id": desktop.id! }, body: form });
    assert.equal(legacyResponse.status, 200);
    const legacy = await legacyResponse.json();
    desktop.emit("send-file", { roomId, url: legacy.url, name: legacy.name, size: legacy.size, mime: legacy.mime });
    await session.sync();
    assert.equal(history.filter((m) => m.url === legacy.url).length, 1);
    console.log("PASS v3.0.1 upload response and send-file compatibility (no duplicate)");

    let rateLimited = false;
    for (let attempt = 0; attempt < 10 && !rateLimited; attempt++) {
      const failure = new Promise<{ message: string; details?: { code: string; retryAfterMs: number } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Join limiter response timed out")), 5000);
        wrongPassword.once("join-error", (message, details) => { clearTimeout(timer); resolve({ message, details }); });
      });
      wrongPassword.emit("join-room", { roomId, username: "wrong-password", password: "incorrect" });
      const result = await failure;
      if (result.message === "Too many attempts. Try again later.") {
        assert.equal(result.details?.code, "RATE_LIMITED");
        assert.ok(result.details!.retryAfterMs > 0);
        assert.ok(result.details!.retryAfterMs <= 60_000);
        rateLimited = true;
      } else assert.equal(result.message, "Wrong password");
    }
    assert.equal(rateLimited, true);
    console.log("PASS real PostgreSQL join limiter retains legacy message plus typed retryAfter");

    const roomCreationStatuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      roomCreationStatuses.push((await fetch(`${base}/api/rooms`, { method: "POST" })).status);
    }
    assert.ok(roomCreationStatuses.includes(429), `Expected room creation rate limit, got ${roomCreationStatuses.join(",")}`);
    console.log("PASS room creation rate limiting returns 429");
    console.log(JSON.stringify({ result: "PASS", roomId, base, messages: history.length }));
  } finally {
    session.dispose(); mobile.disconnect(); desktop.disconnect(); outsider.disconnect(); wrongPassword.disconnect();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
