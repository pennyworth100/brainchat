import assert from "node:assert/strict";
import test from "node:test";
import { ResumeUploadRate } from "./resume-upload-rate";
import http from "node:http";
import { Server, type Socket } from "socket.io";
import { io } from "socket.io-client";
import { ResumeBindings } from "./resume-bindings";
import { ResumeMemberships } from "./resume-membership";
import { attachResumeSocket } from "./resume-socket";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { preflightResumeUpload } from "./resume-upload-preflight";

test("unowned calls exhaust shared aggregate before lookup without invalidating an admitted upload", async t => {
  const httpServer = http.createServer(), server = new Server(httpServer);
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const accepted = new Promise<Socket>(resolve => server.once("connection", resolve));
  const client = io(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}`,
    { transports: ["websocket"], reconnection: false });
  t.after(async () => { client.disconnect(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const socket = await accepted, bindings = new ResumeBindings(10, () => 0);
  const members = new ResumeMemberships(bindings), uploads = new ResumeUploadAdmissions(bindings);
  const identity = { sessionId: "aggregate-upload", roomId: "candy986", username: "Alice",
    authVersion: 1, generation: 1, issuedAt: new Date(0), expiresAt: new Date(1000) };
  const credential = { roomId: identity.roomId, sessionId: identity.sessionId,
    token: Buffer.alloc(32, 1).toString("base64url") };
  const owner = attachResumeSocket(socket, { bindings, memberships: members,
    store: { advanceGeneration: async () => identity }, prepare: async () => async () => {},
    onCleanupError: error => assert.fail(String(error)) });
  t.after(() => owner.close());
  assert.ok(await owner.admit({ credential, expectedGeneration: 0, operationId: "aggregate_upload_op" }));
  let lookups = 0;
  const store = { lookup: async () => { lookups++; return identity; } };
  const grant = await preflightResumeUpload(socket, owner, members, store, uploads, credential);
  assert.ok(grant);
  // Copied ownership has no valid session rate scope. Every call still costs
  // aggregate quota. Recreated admission/request objects cannot bypass it.
  for (let i = 0; i < 1199; i++) assert.equal(await preflightResumeUpload(socket,
    { ...owner }, members, store, new ResumeUploadAdmissions(bindings), null), null);
  assert.equal(await preflightResumeUpload(socket, owner, members, store,
    new ResumeUploadAdmissions(bindings), { ...credential }), null);
  assert.equal(lookups, 1);
  socket.disconnect(true);
  assert.equal(uploads.acceptChunk(grant, 1), true);
  assert.equal(uploads.release(grant), true);
});

test("upload attempt aggregate and session windows are independent and bounded", () => {
  let now = 0;
  const rate = new ResumeUploadRate(2, 3, 10, 2, () => now);
  assert.ok(rate.consumeAggregate()); assert.ok(rate.consumeSession("a"));
  assert.ok(rate.consumeAggregate()); assert.ok(rate.consumeSession("a"));
  assert.equal(rate.consumeSession("a"), false);
  assert.ok(rate.consumeAggregate()); assert.ok(rate.consumeSession("b"));
  assert.equal(rate.consumeAggregate(), false);
  for (let i = 0; i < 100; i++) assert.equal(rate.consumeSession(`forged-${i}`), false);
  assert.equal(rate.consumeSession("a"), false); // no live-debt eviction
  now = 9; assert.equal(rate.consumeAggregate(), false);
  now = 10; assert.ok(rate.consumeAggregate()); assert.ok(rate.consumeSession("c"));
});

test("upload attempt clock anomalies never forgive debt; refill is fixed, not sliding", () => {
  let now = 10;
  const rate = new ResumeUploadRate(1, 1, 10, 1, () => now);
  assert.ok(rate.consumeAggregate()); assert.ok(rate.consumeSession("a"));
  for (now of [-1, NaN, Infinity]) {
    assert.equal(rate.consumeAggregate(), false); assert.equal(rate.consumeSession("a"), false);
  }
  now = 19; assert.equal(rate.consumeAggregate(), false);
  now = 20; assert.ok(rate.consumeAggregate()); assert.ok(rate.consumeSession("a"));
  assert.equal(rate.consumeAggregate(), false);
});
