import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import { Server, type Socket as ServerSocket } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { attachResumeSocket } from "./resume-socket";
import { ResumeBindings } from "./resume-bindings";
import { ResumeMemberships } from "./resume-membership";
import type { ResumeIdentity } from "./resume-store";

const request = (generation = 0) => ({ credential: { sessionId: "session-a", roomId: "candy986",
  token: Buffer.alloc(32, 1).toString("base64url") }, expectedGeneration: generation,
  operationId: `operation-${generation.toString().padStart(16, "0")}` });
const identity = (generation = 1): ResumeIdentity => ({ sessionId: "session-a", roomId: "candy986",
  username: "Alice", authVersion: 1, generation, issuedAt: new Date(0), expiresAt: new Date(1000) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const httpServer = http.createServer(), server = new Server(httpServer);
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const clients: Socket[] = [];
  t.after(async () => { clients.forEach(s => s.disconnect());
    await new Promise<void>(resolve => server.close(() => resolve())); });
  async function connect() {
    const accepted = new Promise<ServerSocket>(resolve => server.once("connection", resolve));
    const client = io(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}`,
      { transports: ["websocket"], reconnection: false, auth: { incarnation: "client-controlled" } });
    clients.push(client);
    await new Promise<void>(resolve => client.once("connect", resolve));
    return { client, socket: await accepted };
  }
  return { connect };
}
function options() {
  return { store: { advanceGeneration: async () => identity() },
    bindings: new ResumeBindings(10, () => 0),
    prepare: async () => async () => {}, onCleanupError: (error: unknown): void => { assert.fail(String(error)); } };
}

test("membership successor physically evicts old socket without deleting successor", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings);
  const old = attachResumeSocket(first.socket, opts), before = await old.admit(request());
  assert.ok(before);
  const lease = members.install(first.socket, old, before); assert.ok(lease);
  assert.equal(members.install(first.socket, old, before), lease);
  // Test-only room proves actual eviction removes broadcast membership.
  await first.socket.join("test-only-private-room");
  let disconnects = 0;
  first.socket.on("disconnect", () => { disconnects++; lease.release(); });
  const next = attachResumeSocket(second.socket, { ...opts,
    store: { advanceGeneration: async () => identity(2) } });
  const binding = await next.admit(request(1)); assert.ok(binding);
  const successor = members.install(second.socket, next, binding); assert.ok(successor);
  assert.equal(first.socket.connected, false); assert.equal(first.socket.rooms.size, 0);
  assert.equal(disconnects, 1); assert.equal(lease.isCurrent(), false);
  assert.equal(lease.release(), false); await old.close();
  assert.equal(successor.isCurrent(), true); assert.equal(opts.bindings.isCurrent(binding), true);
  assert.equal(members.install(first.socket, old, before), null);
  assert.equal(second.socket.rooms.has("candy986"), false);
  second.socket.disconnect(true); await next.close();
  assert.equal(successor.isCurrent(), false); assert.equal(successor.release(), false);
});

test("membership rejects copied owners, wrong physical socket and stale bindings", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings), owner = attachResumeSocket(first.socket, opts);
  const binding = await owner.admit(request()); assert.ok(binding);
  assert.equal(members.install(second.socket, owner, binding), null);
  assert.equal(members.install(first.socket, { ...owner }, binding), null);
  assert.equal(members.install(first.socket, owner, { ...binding }), null);
  const lease = members.install(first.socket, owner, binding); assert.ok(lease);
  assert.equal(lease.release(), true); assert.equal(lease.release(), false);
  assert.equal(opts.bindings.isCurrent(binding), false);
  assert.equal(members.install(first.socket, owner, binding), null);
  await owner.close();
});

test("membership capacity rejects unrelated sessions but permits exact replacement", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  assert.throws(() => new ResumeMemberships(opts.bindings, 0), /capacity/);
  const members = new ResumeMemberships(opts.bindings, 1), old = attachResumeSocket(first.socket, opts);
  const before = await old.admit(request()); assert.ok(before);
  const lease = members.install(first.socket, old, before); assert.ok(lease);
  const unrelated = attachResumeSocket(second.socket, { ...opts,
    store: { advanceGeneration: async () => ({ ...identity(), sessionId: "session-b" }) } });
  const otherRequest = request(); otherRequest.credential.sessionId = "session-b";
  const other = await unrelated.admit(otherRequest); assert.ok(other);
  assert.equal(members.install(second.socket, unrelated, other), null);
  assert.equal(lease.isCurrent(), true); assert.equal(first.socket.connected, true);
  const third = await f.connect();
  const next = attachResumeSocket(third.socket, { ...opts,
    store: { advanceGeneration: async () => identity(2) } });
  const binding = await next.admit(request(1)); assert.ok(binding);
  const successor = members.install(third.socket, next, binding); assert.ok(successor);
  assert.equal(first.socket.connected, false); assert.equal(successor.release(), true);
  assert.ok(members.install(second.socket, unrelated, other));
  await old.close(); await next.close(); await unrelated.close();
});

test("membership rechecks successor after reentrant old disconnect closes it", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings), old = attachResumeSocket(first.socket, opts);
  const before = await old.admit(request()); assert.ok(before);
  assert.ok(members.install(first.socket, old, before));
  const next = attachResumeSocket(second.socket, { ...opts,
    store: { advanceGeneration: async () => identity(2) } });
  const binding = await next.admit(request(1)); assert.ok(binding);
  first.socket.once("disconnect", () => second.socket.disconnect(true));
  assert.equal(members.install(second.socket, next, binding), null);
  assert.equal(opts.bindings.isCurrent(binding), false);
  await old.close(); await next.close();
});

test("failed physical eviction fences candidate without reviving old authority", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings), old = attachResumeSocket(first.socket, opts);
  const before = await old.admit(request()); assert.ok(before);
  const lease = members.install(first.socket, old, before); assert.ok(lease);
  const next = attachResumeSocket(second.socket, { ...opts,
    store: { advanceGeneration: async () => identity(2) } });
  const binding = await next.admit(request(1)); assert.ok(binding);
  const disconnect = first.socket.disconnect;
  first.socket.disconnect = () => { throw Error("eviction failed"); };
  try { assert.throws(() => members.install(second.socket, next, binding), /eviction failed/); }
  finally { first.socket.disconnect = disconnect; }
  assert.equal(lease.isCurrent(), false); assert.equal(opts.bindings.isCurrent(binding), false);
  assert.equal(opts.bindings.isCurrent(before), false);
  assert.equal(members.install(second.socket, next, binding), null);
  await old.close(); await next.close();
});


test("owner close releases membership capacity before pending cleanup settles", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const cleanup = deferred<void>(); let cleanups = 0;
  opts.prepare = async () => async () => { cleanups++; await cleanup.promise; };
  const members = new ResumeMemberships(opts.bindings, 1);
  const owner = attachResumeSocket(first.socket, opts);
  const binding = await owner.admit(request()); assert.ok(binding);
  const lease = members.install(first.socket, owner, binding); assert.ok(lease);
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  assert.equal(first.socket.connected, true);
  assert.equal(lease.isCurrent(), false);
  assert.equal(lease.release(), false); // already released synchronously
  assert.equal(first.socket.listenerCount("disconnecting"), 0);
  const next = attachResumeSocket(second.socket, { ...opts,
    store: { advanceGeneration: async () => ({ ...identity(), sessionId: "session-b" }) },
    prepare: async () => async () => {} });
  const otherRequest = request(); otherRequest.credential.sessionId = "session-b";
  const other = await next.admit(otherRequest); assert.ok(other);
  const successor = members.install(second.socket, next, other); assert.ok(successor);
  cleanup.resolve(); await closing;
  assert.equal(cleanups, 1); assert.equal(successor.isCurrent(), true);
  first.socket.disconnect(true);
  assert.equal(successor.isCurrent(), true); await next.close();
});

test("close between admission and installation cannot acquire membership", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings, 1);
  const owner = attachResumeSocket(socket, opts);
  const binding = await owner.admit(request()); assert.ok(binding);
  const closing = owner.close();
  assert.equal(members.install(socket, owner, binding), null);
  assert.equal(socket.listenerCount("disconnecting"), 0); await closing;
});

test("reentrant owner close during replacement frees candidate capacity", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings, 1), old = attachResumeSocket(first.socket, opts);
  const before = await old.admit(request()); assert.ok(before);
  assert.ok(members.install(first.socket, old, before));
  const next = attachResumeSocket(second.socket, { ...opts,
    store: { advanceGeneration: async () => identity(2) } });
  const binding = await next.admit(request(1)); assert.ok(binding);
  first.socket.once("disconnect", () => { void next.close(); });
  assert.equal(members.install(second.socket, next, binding), null);
  assert.equal(second.socket.connected, true);
  assert.equal(second.socket.listenerCount("disconnecting"), 0);
  const third = await f.connect();
  const otherOwner = attachResumeSocket(third.socket, { ...opts,
    store: { advanceGeneration: async () => ({ ...identity(), sessionId: "session-b" }) } });
  const otherRequest = request(); otherRequest.credential.sessionId = "session-b";
  const other = await otherOwner.admit(otherRequest); assert.ok(other);
  assert.ok(members.install(third.socket, otherOwner, other));
  await old.close(); await next.close(); await otherOwner.close();
});

test("real socket has one immutable owner, server incarnation and no public resume handler", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const owner = attachResumeSocket(socket, opts);
  assert.equal(attachResumeSocket(socket, opts), owner);
  assert.throws(() => attachResumeSocket(socket, options()), /already has/);
  assert.equal(socket.listenerCount("disconnecting"), 1);
  assert.match(owner.incarnation, /^[0-9a-f-]{36}$/);
  assert.notEqual(owner.incarnation, socket.id);
  assert.notEqual(owner.incarnation, socket.handshake.auth.incarnation);
  assert.equal(Object.isFrozen(owner), true);
  assert.equal(socket.listenerCount("resume-room"), 0);
  const binding = await owner.admit(request()); assert.ok(binding);
  assert.equal(binding.transportId, owner.incarnation);
  assert.equal(socket.rooms.has("candy986"), false);
  const closing = owner.close(); assert.equal(owner.close(), closing); await closing;
  assert.equal(socket.listenerCount("disconnecting"), 0);
  assert.equal(attachResumeSocket(socket, opts), owner);
  assert.equal(await owner.admit(request()), null); // socket is still connected
});

test("client disconnect fences a pending CAS before any preparation", async t => {
  const f = await fixture(t), { socket, client } = await f.connect(), opts = options();
  const db = deferred<ResumeIdentity>(); let prepared = 0, calls = 0;
  opts.store.advanceGeneration = async () => { calls++; return db.promise; };
  opts.prepare = async () => { prepared++; return async () => {}; };
  const owner = attachResumeSocket(socket, opts), pending = owner.admit(request());
  await Promise.resolve();
  const disconnected = new Promise<void>(resolve => socket.once("disconnect", () => resolve()));
  client.disconnect(); await disconnected;
  db.resolve(identity()); assert.equal(await pending, null); await owner.close();
  assert.equal(calls, 1); assert.equal(prepared, 0);
  assert.equal(await owner.admit(request()), null);
});

test("server disconnect during preparation disposes the late exact lease only once", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const entered = deferred<void>(), ready = deferred<void>(); let cleanups = 0;
  opts.prepare = async () => { entered.resolve(); await ready.promise;
    return async () => { cleanups++; }; };
  const owner = attachResumeSocket(socket, opts), pending = owner.admit(request());
  await entered.promise; socket.disconnect(true);
  assert.equal(await owner.admit(request()), null);
  ready.resolve(); assert.equal(await pending, null);
  await owner.close(); await owner.close(); assert.equal(cleanups, 1);
});

test("old physical socket disconnect cannot detach successor on a new socket", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const old = attachResumeSocket(first.socket, opts), before = await old.admit(request());
  assert.ok(before);
  const next = attachResumeSocket(second.socket, { ...opts,
    store: { advanceGeneration: async () => identity(2) } });
  assert.notEqual(old.incarnation, next.incarnation);
  const binding = await next.admit(request(1)); assert.ok(binding);
  assert.equal(opts.bindings.isCurrent(before), false);
  first.socket.disconnect(true); await old.close();
  assert.equal(opts.bindings.isCurrent(binding), true);
  assert.equal(second.socket.connected, true);
  second.socket.disconnect(true); await next.close();
  assert.equal(opts.bindings.isCurrent(binding), false);
});

test("cleanup rejection is reported once and remains awaitable; closed socket cannot reattach", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const failure = Error("lease cleanup failed"), reported = deferred<unknown>(); let reports = 0;
  opts.prepare = async () => async () => { throw failure; };
  opts.onCleanupError = error => { reports++; reported.resolve(error); };
  const owner = attachResumeSocket(socket, opts); assert.ok(await owner.admit(request()));
  socket.disconnect(true); assert.equal(await reported.promise, failure);
  await assert.rejects(owner.close(), /lease cleanup failed/);
  await assert.rejects(owner.close(), /lease cleanup failed/);
  assert.equal(reports, 1); assert.equal(attachResumeSocket(socket, opts), owner);
  assert.equal(await owner.admit(request()), null);
  const other = await f.connect(); other.socket.disconnect(true);
  const closedOwner = attachResumeSocket(other.socket, options());
  assert.equal(await closedOwner.admit(request()), null); await closedOwner.close();
  assert.equal(other.socket.listenerCount("disconnecting"), 0);
});
