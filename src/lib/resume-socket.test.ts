import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import http from "node:http";
import { Server, type Socket as ServerSocket } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { attachResumeSocket } from "./resume-socket";
import { ResumeBindings } from "./resume-bindings";
import { ResumeMemberships } from "./resume-membership";
import { ResumeCapacity } from "./resume-capacity";
import { resumeJoinPublication, resumeResyncPublication } from "./resume-join-publication";
import type { ResumeIdentity } from "./resume-store";

const authenticatedJoin = { roomId: "candy986", username: "Alice", authVersion: 1 };

async function resyncFixture(t: TestContext,
  read: (binding: import("./resume-bindings").ResumeBinding) => Promise<readonly unknown[] | null>,
  extra: { timeoutMs?: number; capacity?: ResumeCapacity; onCleanupError?: (error: unknown) => void } = {}) {
  const f = await fixture(t), transport = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings), events: [string, unknown][] = [];
  let calls = 0;
  transport.socket.onAnyOutgoing((event, payload) => { events.push([event, payload]); });
  const owner = attachResumeSocket(transport.socket, { ...opts, ...extra, memberships: members,
    store: { advanceGeneration: async () => { calls++; return identity(); } },
    publishResume: resumeResyncPublication(members, read) });
  t.after(() => owner.close());
  return { ...f, ...transport, opts, members, events, owner, calls: () => calls };
}

test("resume resync shares CAS/read/publication and never announces a new join", async t => {
  const gate = deferred<readonly unknown[]>(), entered = deferred<void>(); let reads = 0;
  const f = await resyncFixture(t, async () => { reads++; entered.resolve(); return gate.promise; });
  const peer = await f.connect(), peerEvents: string[] = [];
  const other = attachResumeSocket(peer.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => ({ ...identity(), sessionId: "peer" }) } });
  const req = request(); req.credential.sessionId = "peer"; assert.ok(await other.admit(req));
  t.after(() => other.close()); peer.socket.onAnyOutgoing(event => { peerEvents.push(event); });
  const flight = f.owner.admit(request()); await entered.promise;
  assert.equal(f.owner.admit(request()), flight); assert.equal(await f.owner.admit(request(1)), null);
  assert.deepEqual(f.events, []); gate.resolve([{ id: 3 }]); assert.ok(await flight);
  assert.equal(f.owner.admit(request()), flight); assert.equal(f.calls(), 1); assert.equal(reads, 1);
  assert.deepEqual(f.events, [["chat-history", [{ id: 3 }]], ["user-list", ["Alice", "Alice"]], ["user-count", 2]]);
  assert.deepEqual(peerEvents, ["user-list", "user-count"]);
});

test("replacement during resync drops old history without redirecting to successor", async t => {
  const gate = deferred<readonly unknown[]>(), entered = deferred<void>();
  const f = await resyncFixture(t, async () => { entered.resolve(); return gate.promise; });
  const flight = f.owner.admit(request()); await entered.promise;
  const next = await f.connect(), events: string[] = [];
  next.socket.onAnyOutgoing(event => { events.push(event); });
  const owner = attachResumeSocket(next.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => identity(2) } });
  assert.ok(await owner.admit(request(1))); t.after(() => owner.close());
  gate.resolve([]); assert.equal(await flight, null);
  assert.deepEqual(events, []); assert.deepEqual(f.events, []); assert.equal(f.members.presence("candy986").count, 1);
});

test("close and transport disconnect during resync prevent late handoff", async t => {
  for (const physical of [false, true]) {
    const gate = deferred<readonly unknown[]>(), entered = deferred<void>();
    const f = await resyncFixture(t, async () => { entered.resolve(); return gate.promise; });
    const flight = f.owner.admit(request()); await entered.promise;
    if (physical) f.socket.disconnect(true);
    const closing = f.owner.close();
    assert.equal(f.members.presence("candy986").count, 0);
    gate.resolve([]); await closing; assert.equal(await flight, null);
    assert.deepEqual(f.events, []); assert.equal(await f.owner.admit(request()), null);
  }
});

test("resync deadline retains original capacity until late read actually settles", async t => {
  const gate = deferred<readonly unknown[]>(), entered = deferred<void>(), capacity = new ResumeCapacity(1);
  const f = await resyncFixture(t, async () => { entered.resolve(); return gate.promise; }, { timeoutMs: 30, capacity });
  const flight = f.owner.admit(request()); await entered.promise;
  assert.equal(capacity.acquire(), null); assert.equal(await flight, null);
  assert.equal(f.socket.connected, false); assert.equal(capacity.acquire(), null);
  gate.resolve([]); await f.owner.close(); await new Promise<void>(resolve => setImmediate(resolve));
  const release = capacity.acquire(); assert.ok(release); release(); assert.deepEqual(f.events, []);
});

test("denied/rejected resync is terminal with no CAS or publication replay", async t => {
  for (const reject of [false, true]) {
    let reads = 0;
    const f = await resyncFixture(t, async () => { reads++; if (reject) throw Error("resync denied"); return null; });
    const flight = f.owner.admit(request());
    if (reject) await assert.rejects(flight, /resync denied/); else assert.equal(await flight, null);
    assert.equal(await f.owner.admit(request()), null); assert.equal(f.calls(), 1);
    assert.equal(reads, 1); assert.deepEqual(f.events, []); assert.equal(f.socket.connected, false);
  }
});

test("reentrant close and partial resync failure never replay handed-off history", async t => {
  for (const fail of [false, true]) {
    const f = await resyncFixture(t, async () => []);
    f.socket.onAnyOutgoing(event => {
      if (event === (fail ? "user-list" : "chat-history")) {
        if (fail) throw Error("resync handoff");
        void f.owner.close();
      }
    });
    const flight = f.owner.admit(request());
    if (fail) await assert.rejects(flight, /resync handoff/); else assert.equal(await flight, null);
    assert.equal(await f.owner.admit(request()), null);
    assert.deepEqual(f.events.map(([event]) => event), fail ? ["chat-history", "user-list"] : ["chat-history"]);
    assert.equal(f.members.presence("candy986").count, 0);
  }
});

test("late resync failure reports once and join does not invoke resume publication", async t => {
  const gate = deferred<void>(), entered = deferred<void>(), errors: unknown[] = [];
  const f = await resyncFixture(t, async () => { entered.resolve(); await gate.promise; throw Error("late read"); },
    { timeoutMs: 30, onCleanupError: error => { errors.push(error); } });
  const flight = f.owner.admit(request()); await entered.promise; assert.equal(await flight, null);
  gate.resolve(); await f.owner.close(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1); assert.match(String(errors[0]), /late read/);
  const transport = await f.connect(), opts = options(); let resumes = 0;
  const owner = attachResumeSocket(transport.socket, { ...opts, memberships: new ResumeMemberships(opts.bindings),
    issue: async () => issuedJoin(), publishResume: async () => { resumes++; return true; } });
  assert.ok(await owner.join(authenticatedJoin)); assert.equal(resumes, 0); await owner.close();
});


async function publicationFixture(t: TestContext,
  read: (binding: import("./resume-bindings").ResumeBinding) => Promise<readonly unknown[] | null>,
  extra: { timeoutMs?: number; issueCapacity?: ResumeCapacity } = {}) {
  const f = await fixture(t), transport = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings);
  const events: [string, unknown][] = [];
  transport.socket.onAnyOutgoing((event, payload) => { events.push([event, payload]); });
  const owner = attachResumeSocket(transport.socket, { ...opts, ...extra, memberships: members,
    issue: async () => issuedJoin(), publishJoin: resumeJoinPublication(members, read) });
  t.after(() => owner.close());
  return { ...f, ...transport, opts, members, events, owner };
}

test("join publication retries share one read, history and presence sequence", async t => {
  const gate = deferred<readonly unknown[]>(), entered = deferred<void>(); let reads = 0;
  const f = await publicationFixture(t, async () => { reads++; entered.resolve(); return gate.promise; });
  const peer = await f.connect(), peerEvents: [string, unknown][] = [];
  const peerOwner = attachResumeSocket(peer.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => ({ ...identity(), sessionId: "peer" }) } });
  const req = request(); req.credential.sessionId = "peer";
  assert.ok(await peerOwner.admit(req)); t.after(() => peerOwner.close());
  peer.socket.onAnyOutgoing((event, payload) => { peerEvents.push([event, payload]); });
  const flight = f.owner.join(authenticatedJoin); await entered.promise;
  assert.equal(f.owner.join(authenticatedJoin), flight); assert.deepEqual(f.events, []);
  assert.equal(await f.owner.join({ ...authenticatedJoin, username: "Other" }), null);
  gate.resolve([{ id: 1 }]); assert.ok(await flight);
  assert.equal(f.owner.join(authenticatedJoin), flight); assert.equal(reads, 1);
  assert.deepEqual(f.events, [["chat-history", [{ id: 1 }]], ["user-list", ["Alice", "Alice"]], ["user-count", 2]]);
  assert.deepEqual(peerEvents, [["system-message", "Alice joined"], ["user-list", ["Alice", "Alice"]], ["user-count", 2]]);
});

test("late join history cannot reach replaced owner or redirect to successor", async t => {
  const gate = deferred<readonly unknown[]>(), entered = deferred<void>();
  const f = await publicationFixture(t, async () => { entered.resolve(); return gate.promise; });
  const flight = f.owner.join(authenticatedJoin); await entered.promise;
  const transport = await f.connect(), successorEvents: string[] = [];
  transport.socket.onAnyOutgoing(event => { successorEvents.push(event); });
  const next = attachResumeSocket(transport.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => identity(2) } });
  assert.ok(await next.admit(request(1))); t.after(() => next.close());
  gate.resolve([{ id: 2 }]); assert.equal(await flight, null);
  assert.deepEqual(f.events, []); assert.deepEqual(successorEvents, []);
  assert.equal(f.members.presence("candy986").count, 1);
});

test("explicit close during history read fences publication and exact retries", async t => {
  const gate = deferred<readonly unknown[]>(), entered = deferred<void>();
  const f = await publicationFixture(t, async () => { entered.resolve(); return gate.promise; });
  const flight = f.owner.join(authenticatedJoin); await entered.promise;
  await f.owner.close(); gate.resolve([]); assert.equal(await flight, null);
  assert.equal(await f.owner.join(authenticatedJoin), null); assert.deepEqual(f.events, []);
});

test("join history deadline retains issuance capacity until late read settles", async t => {
  const gate = deferred<readonly unknown[]>(), entered = deferred<void>(), capacity = new ResumeCapacity(1);
  const f = await publicationFixture(t, async () => { entered.resolve(); return gate.promise; },
    { timeoutMs: 20, issueCapacity: capacity });
  const flight = f.owner.join(authenticatedJoin); await entered.promise;
  assert.equal(await flight, null); assert.equal(capacity.acquire(), null);
  gate.resolve([]); await new Promise<void>(resolve => setImmediate(resolve));
  const release = capacity.acquire(); assert.ok(release); release();
  assert.deepEqual(f.events, []); assert.equal(f.socket.connected, false);
});

test("denied or rejected history fails closed without publication or replay", async t => {
  for (const reject of [false, true]) {
    let reads = 0;
    const f = await publicationFixture(t, async () => { reads++; if (reject) throw Error("history unavailable"); return null; });
    const flight = f.owner.join(authenticatedJoin);
    if (reject) await assert.rejects(flight, /history unavailable/);
    else assert.equal(await flight, null);
    assert.equal(await f.owner.join(authenticatedJoin), null);
    assert.equal(reads, 1); assert.deepEqual(f.events, []); assert.equal(f.socket.connected, false);
  }
});

test("reentrant close at history handoff suppresses notices and later presence", async t => {
  const f = await publicationFixture(t, async () => []);
  f.socket.onAnyOutgoing(event => { if (event === "chat-history") void f.owner.close(); });
  assert.equal(await f.owner.join(authenticatedJoin), null);
  assert.deepEqual(f.events, [["chat-history", []]]);
  assert.equal(await f.owner.join(authenticatedJoin), null);
});

test("partial publication exception is terminal and cannot replay history", async t => {
  const f = await publicationFixture(t, async () => []);
  f.socket.onAnyOutgoing(event => { if (event === "user-list") throw Error("handoff failed"); });
  await assert.rejects(f.owner.join(authenticatedJoin), /handoff failed/);
  assert.equal(await f.owner.join(authenticatedJoin), null);
  assert.deepEqual(f.events.map(([event]) => event), ["chat-history", "user-list"]);
  assert.equal(f.members.presence("candy986").count, 0);
});


async function presenceFixture(t: TestContext) {
  const f = await fixture(t); let now = 0;
  const opts = { ...options(), bindings: new ResumeBindings(10, () => now) };
  const members = new ResumeMemberships(opts.bindings);
  const owners: ReturnType<typeof attachResumeSocket>[] = [];
  t.after(async () => { await Promise.all(owners.map(owner => owner.close())); });
  async function add(sessionId: string, roomId = "candy986", generation = 1,
    prepare = opts.prepare) {
    const transport = await f.connect();
    const owner = attachResumeSocket(transport.socket, { ...opts, memberships: members, prepare,
      store: { advanceGeneration: async () => ({ ...identity(generation), sessionId, roomId }) } });
    owners.push(owner);
    const req = request(generation - 1);
    req.credential.sessionId = sessionId; req.credential.roomId = roomId;
    return { ...transport, owner, pending: owner.admit(req) };
  }
  return { members, add, expire: () => { now = 1000; } };
}

test("presence is frozen, room-local and counts logical sessions, not equal usernames", async t => {
  const f = await presenceFixture(t);
  for (const [id, room] of [["b", "candy986"], ["a", "candy986"], ["c", "other123"]]) {
    assert.ok(await (await f.add(id, room)).pending);
  }
  const snapshot = f.members.presence("candy986");
  assert.deepEqual(snapshot, { count: 2, users: [{ id: "a", username: "Alice" }, { id: "b", username: "Alice" }] });
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.users));
  assert.ok(snapshot.users.every(Object.isFrozen));
  assert.deepEqual(f.members.presence("missing123"), { count: 0, users: [] });
  assert.equal(f.members.presence("other123").count, 1);
});

test("presence hides fenced preparation and preserves logical ID on replacement", async t => {
  const f = await presenceFixture(t), first = await f.add("a"); assert.ok(await first.pending);
  const before = f.members.presence("candy986");
  const entered = deferred<void>(), ready = deferred<void>();
  const next = await f.add("a", "candy986", 2, async () => {
    entered.resolve(); await ready.promise; return async () => {};
  });
  await entered.promise;
  assert.equal(first.socket.connected, true); assert.equal(f.members.presence("candy986").count, 0);
  ready.resolve(); assert.ok(await next.pending);
  assert.equal(first.socket.connected, false);
  assert.deepEqual(f.members.presence("candy986"), before);
  await first.owner.close(); assert.deepEqual(f.members.presence("candy986"), before);
});

test("presence removes closed, disconnected and expired members without mutating old snapshots", async t => {
  const f = await presenceFixture(t), a = await f.add("a"), b = await f.add("b"), c = await f.add("c");
  await Promise.all([a.pending, b.pending, c.pending]);
  const before = f.members.presence("candy986"); assert.equal(before.count, 3);
  await a.owner.close(); assert.equal(a.socket.connected, true);
  b.socket.disconnect(true);
  assert.deepEqual(f.members.presence("candy986").users, [{ id: "c", username: "Alice" }]);
  f.expire(); assert.equal(c.socket.connected, true);
  assert.equal(f.members.presence("candy986").count, 0); assert.equal(before.count, 3);
});

test("sender exclusion rejects copied, wrong-room and replaced bindings", async t => {
  const f = await presenceFixture(t), a = await f.add("a"), b = await f.add("b"), c = await f.add("c", "other123");
  const sender = await a.pending; assert.ok(sender); await b.pending; await c.pending;
  const emitted = [0, 0, 0];
  [a, b, c].forEach((x, i) => x.socket.onAnyOutgoing(() => { emitted[i]++; }));
  assert.equal(f.members.broadcastExcept({ ...sender }, "candy986", "system-message", "x"), 0);
  assert.equal(f.members.broadcastExcept(sender, "other123", "system-message", "x"), 0);
  assert.equal(f.members.broadcastExcept(sender, "candy986", "system-message", "x"), 1);
  assert.deepEqual(emitted, [0, 1, 0]);
  const replacement = await f.add("a", "candy986", 2); assert.ok(await replacement.pending);
  assert.equal(f.members.broadcastExcept(sender, "candy986", "system-message", "stale"), 0);
  assert.deepEqual(emitted, [0, 1, 0]);
});

test("sender fanout stops on reentrant sender close and drops expired senders", async t => {
  const f = await presenceFixture(t), a = await f.add("a"), b = await f.add("b"), c = await f.add("c");
  const sender = await a.pending; assert.ok(sender); await b.pending; await c.pending;
  let last = 0;
  b.socket.onAnyOutgoing(() => { void a.owner.close(); });
  c.socket.onAnyOutgoing(() => { last++; });
  assert.equal(f.members.broadcastExcept(sender, "candy986", "system-message", "x"), 1);
  assert.equal(last, 0);
  const d = await f.add("d"); const expired = await d.pending; assert.ok(expired);
  f.expire();
  assert.equal(f.members.broadcastExcept(expired, "candy986", "system-message", "x"), 0);
});

test("timed out issuance retains capacity until actual settlement", async t => {
  const f = await fixture(t), opts = options(), issueCapacity = new ResumeCapacity(1);
  const gate = deferred<void>(), entered = deferred<void>(); let issues = 0;
  const config = { ...opts, timeoutMs: 10, issueCapacity, memberships: new ResumeMemberships(opts.bindings),
    issue: async () => { issues++; entered.resolve(); await gate.promise; return issuedJoin(); } };
  const first = attachResumeSocket((await f.connect()).socket, config);
  const pending = first.join(authenticatedJoin); await entered.promise; assert.equal(await pending, null);
  const second = attachResumeSocket((await f.connect()).socket, config);
  assert.equal(await second.join(authenticatedJoin), null); assert.equal(issues, 1);
  gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  const third = attachResumeSocket((await f.connect()).socket, config);
  assert.ok(await third.join(authenticatedJoin)); assert.equal(issues, 2);
  await Promise.all([first.close(), second.close(), third.close()]);
});

test("join deadline during preparation releases late membership without publishing credential", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const gate = deferred<void>(), entered = deferred<void>(); let cleanups = 0;
  const members = new ResumeMemberships(opts.bindings);
  const owner = attachResumeSocket(socket, { ...opts, timeoutMs: 10, memberships: members,
    issue: async () => issuedJoin(),
    prepare: async () => { entered.resolve(); await gate.promise; return async () => { cleanups++; }; } });
  const flight = owner.join(authenticatedJoin); await entered.promise;
  assert.equal(await flight, null); assert.equal(socket.connected, false);
  gate.resolve(); await owner.close();
  assert.equal(cleanups, 1); assert.equal(members.broadcast("candy986", "room-info", {}), 0);
});
const issuedJoin = () => ({ ...identity(0), token: request().credential.token });

test("authenticated join reserves before issuance and shares one credential/membership", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings), gate = deferred<void>();
  let issues = 0, advances = 0, installs = 0;
  const owner = attachResumeSocket(socket, { ...opts,
    issue: async (...args) => { assert.deepEqual(args, ["candy986", "Alice", 1]); issues++; await gate.promise; return issuedJoin(); },
    store: { advanceGeneration: async () => { advances++; return identity(); } },
    memberships: { install: (...args) => { installs++; return members.install(...args); } } });
  const input = { ...authenticatedJoin };
  const flight = owner.join(input); input.username = "Changed";
  assert.equal(owner.join(authenticatedJoin), flight);
  assert.equal(await owner.join({ ...authenticatedJoin, username: "Other" }), null);
  assert.equal(await owner.admit(request()), null);
  gate.resolve(); const result = await flight; assert.ok(result);
  assert.equal(owner.join(authenticatedJoin), flight);
  assert.equal(result.binding.username, "Alice"); assert.equal(result.credential.token, issuedJoin().token);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.credential));
  assert.deepEqual([issues, advances, installs], [1, 1, 1]);
  assert.equal(members.send(result.binding, "candy986", "room-info", {}), true);
  await owner.close(); assert.equal(await owner.join(authenticatedJoin), null);
});

test("resume reservation rejects join without issuing; malformed resume does not reserve", async t => {
  const f = await fixture(t), opts = options(), members = new ResumeMemberships(opts.bindings);
  let issues = 0;
  const config = { ...opts, memberships: members, issue: async () => { issues++; return issuedJoin(); } };
  const first = attachResumeSocket((await f.connect()).socket, config);
  assert.ok(await first.admit(request()));
  assert.equal(await first.join(authenticatedJoin), null); assert.equal(issues, 0);
  await first.close();
  const second = attachResumeSocket((await f.connect()).socket, { ...config, bindings: new ResumeBindings(10, () => 0),
    memberships: { install: () => null } });
  const invalid = request(); invalid.credential.token = "invalid";
  assert.equal(await second.admit(invalid), null);
  assert.equal(await second.join(authenticatedJoin), null); assert.equal(issues, 1);
  await second.close();
});

test("disconnect during issuance prevents CAS, membership and credential exposure", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const entered = deferred<void>(), gate = deferred<void>(); let advances = 0;
  const owner = attachResumeSocket(socket, { ...opts, memberships: new ResumeMemberships(opts.bindings),
    issue: async () => { entered.resolve(); await gate.promise; return issuedJoin(); },
    store: { advanceGeneration: async () => { advances++; return identity(); } } });
  const flight = owner.join(authenticatedJoin); await entered.promise;
  socket.disconnect(true); gate.resolve();
  assert.equal(await flight, null); assert.equal(advances, 0);
  assert.equal(await owner.join(authenticatedJoin), null); await owner.close();
});

test("uncertain issuance is terminal and never automatically retried", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  let issues = 0;
  const owner = attachResumeSocket(socket, { ...opts, memberships: new ResumeMemberships(opts.bindings),
    issue: async () => { issues++; throw Error("ambiguous insert"); } });
  const flight = owner.join(authenticatedJoin);
  assert.equal(owner.join(authenticatedJoin), flight);
  await assert.rejects(flight, /ambiguous insert/);
  assert.equal(socket.connected, false); assert.equal(await owner.join(authenticatedJoin), null);
  assert.equal(issues, 1); await owner.close();
});

test("join timeout fences late issuance and reports late rejection once", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const gate = deferred<void>(), done = deferred<void>(); let advances = 0;
  const errors: unknown[] = [];
  const owner = attachResumeSocket(socket, { ...opts, timeoutMs: 10,
    memberships: new ResumeMemberships(opts.bindings),
    issue: async () => { await gate.promise; throw Error("late insert failure"); },
    store: { advanceGeneration: async () => { advances++; return identity(); } },
    onCleanupError: error => { errors.push(error); done.resolve(); } });
  assert.equal(await owner.join(authenticatedJoin), null); assert.equal(socket.connected, false);
  gate.resolve(); await done.promise;
  assert.equal(errors.length, 1); assert.equal(advances, 0); await owner.close();
});

test("issuance policy mismatch fails closed before CAS", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options(); let advances = 0;
  const owner = attachResumeSocket(socket, { ...opts, memberships: new ResumeMemberships(opts.bindings),
    issue: async () => ({ ...issuedJoin(), authVersion: 2 }),
    store: { advanceGeneration: async () => { advances++; return identity(); } } });
  assert.equal(await owner.join(authenticatedJoin), null); assert.equal(advances, 0);
  assert.equal(socket.connected, false); await owner.close();
});


test("private outbound delivers exact current binding only, never copies or wrong rooms", async t => {
  const f = await fixture(t), { socket, client } = await f.connect(), opts = options();
  const memberships = new ResumeMemberships(opts.bindings);
  const owner = attachResumeSocket(socket, { ...opts, memberships });
  const binding = await owner.admit(request()); assert.ok(binding);
  let emitted = 0; socket.onAnyOutgoing(() => { emitted++; });
  assert.equal(memberships.send({ ...binding }, "candy986", "chat-history", []), false);
  assert.equal(memberships.send(binding, "other123", "chat-history", []), false);
  assert.equal(memberships.send(binding, "candy986", "disconnect" as "chat-history", []), false);
  assert.equal(emitted, 0);
  const received = new Promise(resolve => client.once("chat-history", resolve));
  assert.equal(memberships.send(binding, "candy986", "chat-history", [{ id: 1 }]), true);
  assert.deepEqual(await received, [{ id: 1 }]); assert.equal(emitted, 1);
  await owner.close();
  assert.equal(socket.connected, true);
  assert.equal(memberships.send(binding, "candy986", "chat-history", []), false);
  assert.equal(emitted, 1);
});

test("outbound fences old socket during successor preparation, before physical eviction", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const memberships = new ResumeMemberships(opts.bindings);
  const old = attachResumeSocket(first.socket, { ...opts, memberships });
  const before = await old.admit(request()); assert.ok(before);
  const entered = deferred<void>(), ready = deferred<void>();
  const next = attachResumeSocket(second.socket, { ...opts, memberships,
    store: { advanceGeneration: async () => identity(2) },
    prepare: async () => { entered.resolve(); await ready.promise; return async () => {}; } });
  const pending = next.admit(request(1)); await entered.promise;
  assert.equal(first.socket.connected, true);
  assert.equal(memberships.send(before, "candy986", "chat-history", ["old"]), false);
  assert.equal(memberships.broadcast("candy986", "chat-message", "pending"), 0);
  ready.resolve(); const binding = await pending; assert.ok(binding);
  assert.equal(memberships.send(before, "candy986", "chat-history", ["delayed"]), false);
  const received = new Promise(resolve => second.client.once("chat-message", resolve));
  assert.equal(memberships.broadcast("candy986", "chat-message", "new"), 1);
  assert.equal(await received, "new");
  await old.close(); await next.close();
});

test("outbound checks absolute expiry at delivery, not at snapshot/read time", async t => {
  const f = await fixture(t), { socket } = await f.connect(); let now = 0;
  const opts = { ...options(), bindings: new ResumeBindings(10, () => now) };
  const memberships = new ResumeMemberships(opts.bindings);
  const owner = attachResumeSocket(socket, { ...opts, memberships });
  const binding = await owner.admit(request()); assert.ok(binding);
  let emitted = 0; socket.onAnyOutgoing(() => { emitted++; });
  now = 1000;
  assert.equal(memberships.send(binding, "candy986", "room-snapshot", {}), false);
  assert.equal(memberships.broadcast("candy986", "chat-message", {}), 0);
  assert.equal(socket.connected, true); assert.equal(emitted, 0); await owner.close();
});

test("broadcast filters rooms and rechecks each recipient after reentrant close", async t => {
  const f = await fixture(t), opts = options(), memberships = new ResumeMemberships(opts.bindings);
  const owners: { owner: ReturnType<typeof attachResumeSocket>; socket: ServerSocket }[] = [];
  for (const [sessionId, roomId] of [["a", "candy986"], ["b", "candy986"], ["c", "other123"]]) {
    const { socket } = await f.connect();
    const owner = attachResumeSocket(socket, { ...opts, memberships,
      store: { advanceGeneration: async () => ({ ...identity(), sessionId, roomId }) } });
    const req = request(); req.credential.sessionId = sessionId; req.credential.roomId = roomId;
    assert.ok(await owner.admit(req)); owners.push({ owner, socket });
  }
  const emitted = [0, 0, 0];
  owners.forEach(({ socket }, index) => socket.onAnyOutgoing(() => {
    emitted[index]++;
    if (index === 0) void owners[1].owner.close();
  }));
  assert.equal(memberships.broadcast("candy986", "chat-message", "hello"), 1);
  assert.deepEqual(emitted, [1, 0, 0]);
  assert.equal(memberships.broadcast("missing123", "chat-message", "hello"), 0);
  await Promise.all(owners.map(({ owner }) => owner.close()));
});

test("admission without installed membership cannot send or receive a broadcast", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const memberships = new ResumeMemberships(opts.bindings);
  const owner = attachResumeSocket(socket, opts);
  const binding = await owner.admit(request()); assert.ok(binding);
  assert.equal(opts.bindings.isCurrent(binding), true);
  assert.equal(memberships.send(binding, "candy986", "chat-history", []), false);
  assert.equal(memberships.broadcast("candy986", "chat-message", {}), 0);
  await owner.close();
});


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

test("composed admission installs once and conflicts cannot close a valid owner", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings); let installs = 0, calls = 0;
  const owner = attachResumeSocket(socket, { ...opts,
    store: { advanceGeneration: async () => { calls++; return identity(); } },
    memberships: { install: (...args) => { installs++; return members.install(...args); } } });
  const invalid = request(); invalid.credential.token = "invalid";
  assert.equal(await owner.admit(invalid), null); assert.equal(socket.connected, true);
  const flight = owner.admit(request());
  assert.equal(owner.admit(request()), flight);
  assert.equal(await owner.admit(request(1)), null);
  const binding = await flight; assert.ok(binding);
  assert.equal(owner.admit(request()), flight);
  assert.equal(await owner.admit(request(1)), null);
  assert.equal(calls, 1); assert.equal(installs, 1); assert.equal(socket.connected, true);
  assert.equal(opts.bindings.isCurrent(binding), true); await owner.close();
});

test("composed membership rejection disconnects before stalled cleanup", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const cleanup = deferred<void>(); let cleanups = 0;
  const owner = attachResumeSocket(socket, { ...opts,
    prepare: async () => async () => { cleanups++; await cleanup.promise; },
    memberships: { install: () => null } });
  assert.equal(await owner.admit(request()), null);
  assert.equal(socket.connected, false); assert.equal(socket.listenerCount("disconnecting"), 0);
  assert.equal(await owner.admit(request()), null);
  cleanup.resolve(); await owner.close(); assert.equal(cleanups, 1);
});

test("composed install throw releases exact lease and preserves failure", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const members = new ResumeMemberships(opts.bindings); let lease: ReturnType<typeof members.install>;
  const failure = Error("installation failed");
  const owner = attachResumeSocket(socket, { ...opts, memberships: { install: (...args) => {
    lease = members.install(...args); throw failure;
  } } });
  await assert.rejects(owner.admit(request()), error => error === failure);
  assert.equal(socket.connected, false); assert.ok(lease!);
  assert.equal(lease!.isCurrent(), false); assert.equal(lease!.release(), false);
  await owner.close();
});

test("composed overload closes only rejected socket without CAS", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const capacity = new ResumeCapacity(1), release = capacity.acquire(); assert.ok(release);
  let calls = 0, installs = 0;
  const owner = attachResumeSocket(socket, { ...opts, capacity,
    store: { advanceGeneration: async () => { calls++; return identity(); } },
    memberships: { install: () => { installs++; return null; } } });
  assert.equal(await owner.admit(request()), null); assert.equal(socket.connected, false);
  assert.equal(calls, 0); assert.equal(installs, 0); assert.equal(capacity.acquire(), null);
  release(); await owner.close();
});

test("composed timeout disconnects without releasing unresolved CAS capacity", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const pending = deferred<ResumeIdentity>(), capacity = new ResumeCapacity(1); let installs = 0;
  const owner = attachResumeSocket(socket, { ...opts, capacity, timeoutMs: 15,
    store: { advanceGeneration: async () => pending.promise },
    memberships: { install: () => { installs++; return null; } } });
  assert.equal(await owner.admit(request()), null); assert.equal(socket.connected, false);
  assert.equal(capacity.acquire(), null); assert.equal(installs, 0);
  pending.resolve(identity()); await owner.close();
  const release = capacity.acquire(); assert.ok(release); release();
  assert.equal(installs, 0);
});

test("composed uncertain CAS rejects once, disconnects and never installs", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const failure = Error("uncertain CAS"); let calls = 0, installs = 0;
  const owner = attachResumeSocket(socket, { ...opts,
    store: { advanceGeneration: async () => { calls++; throw failure; } },
    memberships: { install: () => { installs++; return null; } } });
  const flight = owner.admit(request()); assert.equal(owner.admit(request()), flight);
  await assert.rejects(flight, error => error === failure);
  assert.equal(socket.connected, false); assert.equal(await owner.admit(request()), null);
  assert.equal(calls, 1); assert.equal(installs, 0); await owner.close();
});

test("composed replacement closed reentrantly never exposes candidate binding", async t => {
  const f = await fixture(t), first = await f.connect(), second = await f.connect(), opts = options();
  const memberships = new ResumeMemberships(opts.bindings);
  const old = attachResumeSocket(first.socket, { ...opts, memberships });
  assert.ok(await old.admit(request()));
  const next = attachResumeSocket(second.socket, { ...opts, memberships,
    store: { advanceGeneration: async () => identity(2) } });
  first.socket.once("disconnect", () => { void next.close(); });
  assert.equal(await next.admit(request(1)), null);
  assert.equal(first.socket.connected, false); assert.equal(second.socket.connected, false);
  await old.close(); await next.close();
});

test("composed disconnect before install preserves preparation cleanup failure", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const preparing = deferred<void>(), started = deferred<void>(), errors: unknown[] = [];
  const failure = Error("late cleanup failed"); let installs = 0;
  const owner = attachResumeSocket(socket, { ...opts,
    prepare: async () => { started.resolve(); await preparing.promise; return async () => { throw failure; }; },
    onCleanupError: error => { errors.push(error); },
    memberships: { install: () => { installs++; return null; } } });
  const flight = owner.admit(request()); await started.promise;
  socket.disconnect(true); preparing.resolve();
  await assert.rejects(flight, error => error === failure);
  await owner.close(); // cleanup failure belongs to original work, not a second dispose
  assert.equal(installs, 0); assert.deepEqual(errors, []);
});

test("composed install-time disconnect reports shared close failure once", async t => {
  const f = await fixture(t), { socket } = await f.connect(), opts = options();
  const failure = Error("close cleanup failed"), errors: unknown[] = [];
  const owner = attachResumeSocket(socket, { ...opts,
    prepare: async () => async () => { throw failure; },
    onCleanupError: error => { errors.push(error); },
    memberships: { install: () => { socket.disconnect(true); return null; } } });
  assert.equal(await owner.admit(request()), null);
  await assert.rejects(owner.close(), error => error === failure);
  assert.deepEqual(errors, [failure]);
});

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
