import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { uploadAuthorityHeaders, type UploadAuthority } from "./upload-authority";
import { uploadRoomFile } from "./upload-client";

const file = () => new File(["hello"], "file.txt", { type: "text/plain" });
const credential = () => ({ kind: "resume" as const, roomId: "files123", socketId: "socket-a",
  sessionId: "12345678-1234-4123-8123-123456789abc", token: "A".repeat(43) });
const session = (auth: unknown = credential()) => ({
  operationGuard: () => () => {},
  sync: async () => "socket-a",
  reconnect: async () => assert.fail("strict upload must not password-rejoin"),
  uploadAuthority: () => auth as UploadAuthority,
});
const receipt = (key: string) => ({ clientMessageId: key, message: {
  id: 1, type: "file", username: "Guest", ts: 1, name: "file.txt",
  size: 5, mime: "text/plain", url: "/uploads/" + "a".repeat(64) + "/blob",
} });

test("strict browser upload transmits the complete credential and correlates the receipt", async () => {
  let calls = 0;
  await uploadRoomFile(file(), "files123", session(), async (_url, options) => {
    calls++;
    const h = options!.headers as Record<string, string>;
    assert.equal(h["x-resume-session-id"], credential().sessionId);
    assert.equal(h["x-resume-token"], credential().token);
    assert.match(h["x-client-message-id"], /^[a-f0-9-]{36}$/);
    assert.equal(h["x-socket-id"], "socket-a");
    assert.deepEqual([...((options!.body as FormData).keys())], ["file"]);
    return Response.json(receipt(h["x-client-message-id"]));
  });
  assert.equal(calls, 1);
});

test("missing partial malformed or cross-room credentials fail before HTTP with no legacy fallback", async () => {
  const good = credential();
  for (const auth of [null, {}, { ...good, roomId: "other123" }, { ...good, socketId: "stale" },
    { ...good, token: undefined }, { ...good, sessionId: undefined },
    { ...good, token: "A".repeat(42) + "B" }, { ...good, sessionId: "not-a-session" },
    { ...good, kind: "legacy" }, { ...good, kind: "other" }]) {
    await assert.rejects(uploadRoomFile(file(), "files123", session(auth),
      async () => assert.fail("unauthorized HTTP")), /authority|credential/);
  }
});

test("strict auth rejection and unknown outcome never reconnect or retry the body", async () => {
  for (const status of [200, 401, 403, 500, 503]) {
    let calls = 0;
    await assert.rejects(uploadRoomFile(file(), "files123", session(), async () => {
      calls++; return Response.json({ code: status === 401 ? "UPLOAD_AUTH_REQUIRED" : "UPLOAD_OUTCOME_UNKNOWN" }, { status });
    }));
    assert.equal(calls, 1);
  }
});

test("a success response needs matching operation key metadata and local strict URL", async () => {
  for (const mutate of [
    (r: any) => { delete r.clientMessageId; },
    (r: any) => { r.clientMessageId = "other-key"; },
    (r: any) => { r.message.size++; },
    (r: any) => { r.message.name = "other.txt"; },
    (r: any) => { r.message.mime = "text/html"; },
    (r: any) => { r.message.url = "https://other.example/file"; },
    (r: any) => { r.message.id = 0; },
    (r: any) => { r.message.type = "message"; },
  ]) {
    let calls = 0;
    await assert.rejects(uploadRoomFile(file(), "files123", session(), async (_url, options) => {
      calls++;
      const r = receipt((options!.headers as Record<string, string>)["x-client-message-id"]);
      mutate(r); return Response.json(r);
    }), /receipt could not be verified/);
    assert.equal(calls, 1);
  }
});

test("explicit legacy auth retry rechecks room ownership and cannot change credential modes", async () => {
  for (const next of [null, credential(),
    { kind: "legacy", roomId: "other123", socketId: "socket-b" }]) {
    let calls = 0, authCalls = 0;
    const s = { operationGuard: () => () => {}, sync: async () => "socket-a", reconnect: async () => "socket-b",
      uploadAuthority: () => (++authCalls === 1
        ? { kind: "legacy", roomId: "files123", socketId: "socket-a" } : next) as UploadAuthority };
    await assert.rejects(uploadRoomFile(file(), "files123", s, async () => {
      calls++; return Response.json({ code: "UPLOAD_AUTH_REQUIRED" }, { status: 401 });
    }), /authority changed/);
    assert.equal(calls, 1);
  }
});

test("headers are an immutable snapshot without retaining mutable credential input", () => {
  const auth = credential();
  const headers = uploadAuthorityHeaders(auth, "files123", "socket-a", "operation-1");
  auth.token = "B".repeat(43);
  assert.equal(headers["x-resume-token"], "A".repeat(43));
  assert.equal(Object.isFrozen(headers), true);
});

test("actual HTTP redirect cannot forward strict bearer headers to another endpoint", async t => {
  let targets = 0, requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/target") { targets++; res.end("must not be reached"); return; }
    requests++;
    assert.equal(req.headers["x-resume-token"], credential().token);
    res.writeHead(307, { Location: "/target" }); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(uploadRoomFile(file(), "files123", session(),
    (_path, options) => fetch("http://127.0.0.1:" + port + "/upload", options)), /Network interrupted/);
  assert.equal(requests, 1);
  assert.equal(targets, 0);
});
