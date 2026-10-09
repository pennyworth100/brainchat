import assert from "node:assert/strict";
import { preflightResumeUpload } from "./resume-upload-preflight";
import { ResumeUploadAdmissions } from "./resume-upload-admission";

test("upload preflight rejects wrong room/session/token and forged physical owner before DB/body", async t => {
  const f = await syncFixture(t), other = await f.connect();
  const uploads = new ResumeUploadAdmissions(f.opts.bindings);
  let lookups = 0, bodies = 0;
  const store = { lookup: async () => { lookups++; return identity(); } };
  const run = async (payload: Parameters<typeof preflightResumeUpload>[5], socket = f.socket, owner = f.owner) => {
    const grant = await preflightResumeUpload(socket, owner, f.members, store, uploads, payload);
    if (grant) bodies++;
    return grant;
  };
  for (const payload of [null, { ...request().credential, roomId: "other123" },
    { ...request().credential, sessionId: "forged" }, { ...request().credential, token: "bad" }]) {
    assert.equal(await run(payload), null);
  }
  assert.equal(await run(request().credential, other.socket), null);
  assert.equal(await run(request().credential, f.socket, { ...f.owner }), null);
  assert.equal(lookups, 0); assert.equal(bodies, 0);
  assert.equal(await preflightResumeUpload(f.socket, f.owner, new ResumeMemberships(f.opts.bindings),
    store, uploads, request().credential), null);
  assert.equal(lookups, 0);
});

test("upload preflight authenticates bearer; DB denial/errors never grant or consume body", async t => {
  const f = await syncFixture(t), uploads = new ResumeUploadAdmissions(f.opts.bindings);
  const run = (lookup: Parameters<typeof preflightResumeUpload>[3]["lookup"]) =>
    preflightResumeUpload(f.socket, f.owner, f.members, { lookup }, uploads, request().credential);
  assert.equal(await run(async () => null), null);
  await assert.rejects(run(async () => { throw Error("database unavailable"); }), /database unavailable/);
  const grant = await run(async () => identity()); assert.ok(grant);
  assert.equal(grant.binding, f.binding); assert.ok(Object.isFrozen(grant));
  assert.equal(await run(async () => identity()), null); // unresolved upload admission
  uploads.release(grant);
});

test("upload preflight snapshots credentials and rejects mismatched durable identity", async t => {
  const f = await syncFixture(t), uploads = new ResumeUploadAdmissions(f.opts.bindings);
  for (const mismatch of [{ sessionId: "other" }, { roomId: "other123" }, { username: "Mallory" },
    { authVersion: 2 }, { generation: 2 }, { expiresAt: new Date(999) }]) {
    assert.equal(await preflightResumeUpload(f.socket, f.owner, f.members,
      { lookup: async () => ({ ...identity(), ...mismatch }) }, uploads, request().credential), null);
  }
  const gate = deferred<void>(), payload = request().credential;
  const flight = preflightResumeUpload(f.socket, f.owner, f.members, { lookup: async credential => {
    assert.ok(Object.isFrozen(credential)); await gate.promise;
    assert.deepEqual(credential, request().credential); return identity();
  } }, uploads, payload);
  payload.roomId = "other123"; payload.token = "forged"; payload.sessionId = "other";
  gate.resolve(); const grant = await flight; assert.ok(grant); uploads.release(grant);
});

test("upload preflight rechecks close/disconnect/expiry after durable lookup before body", async t => {
  for (const loss of ["close", "disconnect", "expiry"]) {
    const f = await syncFixture(t), gate = deferred<void>(), uploads = new ResumeUploadAdmissions(f.opts.bindings);
    const pending = preflightResumeUpload(f.socket, f.owner, f.members,
      { lookup: async () => { await gate.promise; return identity(); } }, uploads, request().credential);
    if (loss === "close") await f.owner.close();
    if (loss === "disconnect") f.socket.disconnect(true);
    if (loss === "expiry") f.expire();
    gate.resolve(); assert.equal(await pending, null);
  }
});

test("upload preflight does not redirect an old lookup to a successor owner", async t => {
  const f = await syncFixture(t), gate = deferred<void>(), uploads = new ResumeUploadAdmissions(f.opts.bindings);
  const pending = preflightResumeUpload(f.socket, f.owner, f.members,
    { lookup: async () => { await gate.promise; return identity(); } }, uploads, request().credential);
  const next = await f.connect(), owner = attachResumeSocket(next.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => identity(2) } });
  t.after(() => owner.close()); const binding = await owner.admit(request(1)); assert.ok(binding);
  gate.resolve(); assert.equal(await pending, null);
  const grant = await preflightResumeUpload(next.socket, owner, f.members,
    { lookup: async () => identity(2) }, uploads, request().credential);
  assert.ok(grant); assert.equal(grant.binding, binding); uploads.release(grant);
});

test("upload preflight retains per-socket and aggregate capacity until expired lookup settles", async t => {
  const f = await syncFixture(t), other = await syncFixture(t), gate = deferred<void>();
  const cap = new ResumeCapacity(1), uploads = new ResumeUploadAdmissions(f.opts.bindings);
  let now = 0, lookups = 0, settled = false;
  const store = { lookup: async () => { lookups++; await gate.promise; return identity(); } };
  const first = preflightResumeUpload(f.socket, f.owner, f.members, store, uploads,
    request().credential, { capacity: cap, timeoutMs: 10, now: () => now });
  void first.then(() => { settled = true; });
  now = 10;
  assert.equal(await preflightResumeUpload(f.socket, f.owner, f.members, store, uploads,
    request().credential, { capacity: new ResumeCapacity(1) }), null);
  assert.equal(await preflightResumeUpload(other.socket, other.owner, other.members, store,
    new ResumeUploadAdmissions(other.opts.bindings), request().credential, { capacity: cap }), null);
  await f.owner.close(); assert.equal(cap.acquire(), null); assert.equal(settled, false);
  assert.equal(lookups, 1); gate.resolve(); assert.equal(await first, null);
  const release = cap.acquire(); assert.ok(release); release();
});

test("upload preflight rejects delayed/invalid clock and invalid timeout without admission", async t => {
  for (const finished of [10, -1, NaN, Infinity]) {
    const f = await syncFixture(t), uploads = new ResumeUploadAdmissions(f.opts.bindings);
    let now = 0;
    assert.equal(await preflightResumeUpload(f.socket, f.owner, f.members,
      { lookup: async () => { now = finished; return identity(); } }, uploads, request().credential,
      { timeoutMs: 10, now: () => now }), null);
  }
  const f = await syncFixture(t), uploads = new ResumeUploadAdmissions(f.opts.bindings);
  for (const timeoutMs of [0, -1, 0.5, 10_001, Infinity]) {
    await assert.rejects(preflightResumeUpload(f.socket, f.owner, f.members,
      { lookup: async () => assert.fail("invalid limit DB") }, uploads, request().credential, { timeoutMs }), /deadline/);
  }
});

test("upload preflight grants admitted HTTP lifetime but disconnect cannot admit another body", async t => {
  const f = await syncFixture(t), uploads = new ResumeUploadAdmissions(f.opts.bindings);
  const run = () => preflightResumeUpload(f.socket, f.owner, f.members,
    { lookup: async () => identity() }, uploads, request().credential);
  const grant = await run(); assert.ok(grant);
  f.socket.disconnect(true);
  assert.equal(uploads.acceptChunk(grant, 1), true);
  assert.equal(await run(), null);
  assert.equal(f.members.bindingFor(f.socket, f.owner, "candy986"), null);
  uploads.release(grant);
});
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
import { syncResumeSocket } from "./resume-sync";
import { sendResumeText, sendResumeImage } from "./resume-send";
import { canonicalResumeImage, MAX_RESUME_IMAGE_DATA_URL_LENGTH, type ResumeImageWrite } from "./resume-image";
import type { ResumeTextWrite } from "./resume-message";
import type { OperationResult } from "./resume-operation";

const imagePayload = () => ({ roomId: "candy986", clientMessageId: "image_1", dataUrl: "data:image/png;base64,AA==" });
const savedImage = (inserted = true): OperationResult<ResumeImageWrite> => ({ authorized: true,
  value: { inserted, message: { id: 72, type: "image", username: "Alice", dataUrl: imagePayload().dataUrl, ts: 123 } } });
let imageSession = 0;
const imageFixture = (t: TestContext) => syncFixture(t, `image-send-${++imageSession}`);

test("image and text share socket exclusion in both directions and aggregate capacity", async t => {
  for (const firstType of ["image", "text"]) {
    const f = await imageFixture(t), other = await imageFixture(t), gate = deferred<void>();
    const cap = new ResumeCapacity(1); let writes = 0;
    const image = (x = f, capacity = cap) => sendResumeImage(x.socket, x.owner, x.binding, x.members,
      { saveOnceWithOutcome: async () => { writes++; await gate.promise; return savedImage(); } },
      imagePayload(), () => {}, { capacity });
    const text = (x = f, capacity = cap) => sendResumeText(x.socket, x.owner, x.binding, x.members,
      { saveOnceWithOutcome: async () => { writes++; await gate.promise; return savedText(); } },
      textPayload(), () => {}, { capacity });
    const first = firstType === "image" ? image : text, second = firstType === "image" ? text : image;
    const pending = first();
    assert.deepEqual(await second(f, new ResumeCapacity(1)), { committed: false });
    assert.deepEqual(await second(other), { committed: false }); assert.equal(writes, 1);
    gate.resolve(); assert.ok((await pending).committed);
    assert.ok((await second(other)).committed); assert.equal(writes, 2);
  }
});

test("image adapter rejects primitive/identity/owner violations before writer dispatch", async t => {
  const f = await imageFixture(t), other = await f.connect(); let writes = 0;
  const writer = { saveOnceWithOutcome: async () => { writes++; return savedImage(); } };
  const ack = () => assert.fail("unauthorized ACK");
  for (const payload of [null, { ...imagePayload(), roomId: "other123" },
    { ...imagePayload(), clientMessageId: "bad key" }, { ...imagePayload(), dataUrl: 3 },
    { ...imagePayload(), dataUrl: "" }, { ...imagePayload(), dataUrl: "x".repeat(MAX_RESUME_IMAGE_DATA_URL_LENGTH + 1) }]) {
    assert.deepEqual(await sendResumeImage(f.socket, f.owner, f.binding, f.members, writer, payload, ack), { committed: false });
  }
  for (const [socket, owner, binding] of [[other.socket, f.owner, f.binding],
    [f.socket, { ...f.owner }, f.binding], [f.socket, f.owner, { ...f.binding }]] as const) {
    assert.deepEqual(await sendResumeImage(socket, owner, binding, f.members, writer, imagePayload(), ack), { committed: false });
  }
  assert.equal(writes, 0);
});

test("image immutable snapshot and authoritative receipt; exact-key retry is ACK-only", async t => {
  const f = await imageFixture(t), gate = deferred<void>(), seen: unknown[] = [];
  const payload = { ...imagePayload(), username: "spoof", sessionId: "spoof" };
  let writes = 0;
  const fanout = t.mock.method(f.members, "broadcastExcept", () => 0);
  const writer = { saveOnceWithOutcome: async (...args: unknown[]) => {
    seen.push(args); await gate.promise; return savedImage(++writes === 1);
  } };
  const ack = (reply: unknown) => { assert.ok(Object.isFrozen(reply)); };
  const pending = sendResumeImage(f.socket, f.owner, f.binding, f.members, writer, payload, ack);
  payload.dataUrl = "mutated"; payload.clientMessageId = "changed"; payload.roomId = "other123";
  gate.resolve(); const first = await pending;
  const retry = await sendResumeImage(f.socket, f.owner, f.binding, f.members, writer, imagePayload(), ack);
  assert.ok(first.committed && retry.committed);
  assert.deepEqual(seen[0], [f.binding, "image_1", imagePayload().dataUrl]);
  assert.ok(Object.isFrozen(first.receipt.message));
  assert.equal(first.receipt.message.username, "Alice"); assert.equal(retry.fanout, "skipped");
  assert.equal(fanout.mock.callCount(), 1); assert.equal(fanout.mock.calls[0].arguments[2], "chat-image");
});

test("image deadline retains original ID and shared leases until late commit or error settles", async t => {
  for (const reject of [false, true]) {
    const f = await imageFixture(t), gate = deferred<void>(), cap = new ResumeCapacity(1), errors: unknown[] = [];
    t.mock.method(f.members, "broadcastExcept", () => assert.fail("late fanout"));
    const pending = sendResumeImage(f.socket, f.owner, f.binding, f.members,
      { saveOnceWithOutcome: async () => { await gate.promise; if (reject) throw Error("uncertain"); return savedImage(); } },
      imagePayload(), () => assert.fail("late ACK"), { capacity: cap, timeoutMs: 10, onLateError: e => { errors.push(e); } });
    assert.deepEqual(await pending, { committed: null, reason: "deadline", clientMessageId: "image_1" });
    assert.equal(cap.acquire(), null);
    assert.deepEqual(await sendResumeText(f.socket, f.owner, f.binding, f.members,
      { saveOnceWithOutcome: async () => assert.fail("overlap") }, textPayload(), () => {}), { committed: false });
    await f.owner.close(); assert.equal(cap.acquire(), null);
    gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(errors.length, reject ? 1 : 0);
    const release = cap.acquire(); assert.ok(release); release();
  }
});

test("image owner loss after commit fences ACK and publication", async t => {
  for (const kind of ["close", "disconnect", "expiry"]) {
    const f = await imageFixture(t), gate = deferred<void>();
    t.mock.method(f.members, "broadcastExcept", () => assert.fail("stale fanout"));
    const pending = sendResumeImage(f.socket, f.owner, f.binding, f.members,
      { saveOnceWithOutcome: async () => { await gate.promise; return savedImage(); } },
      imagePayload(), () => assert.fail("stale ACK"));
    if (kind === "close") await f.owner.close();
    if (kind === "disconnect") f.socket.disconnect(true);
    if (kind === "expiry") f.expire();
    gate.resolve(); const result = await pending;
    assert.ok(result.committed); assert.equal(result.ack, "skipped"); assert.equal(result.fanout, "skipped");
  }
});

test("image quota precedes validation, survives retry and reconnect, and ignores spoofed session", async t => {
  const f = await imageFixture(t); let writes = 0;
  const writer = { saveOnceWithOutcome: async (_binding: unknown, _key: string, content: string) => {
    writes++; canonicalResumeImage(content); return savedImage(false);
  } };
  const malformed = { ...imagePayload(), dataUrl: "invalid", sessionId: "forged" };
  for (let i = 0; i < 12; i++) {
    await assert.rejects(sendResumeImage(f.socket, f.owner, f.binding, f.members, writer, malformed, () => {}), /Invalid resume image/);
  }
  const cap = new ResumeCapacity(1);
  assert.deepEqual(await sendResumeImage(f.socket, f.owner, f.binding, f.members, writer, imagePayload(), () => {}, { capacity: cap }), { committed: false });
  const release = cap.acquire(); assert.ok(release); release();
  await f.owner.close();
  const next = await f.connect(), owner = attachResumeSocket(next.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => ({ ...identity(2), sessionId: f.binding.sessionId }) } });
  t.after(() => owner.close()); const req = request(1); req.credential.sessionId = f.binding.sessionId;
  const binding = await owner.admit(req); assert.ok(binding);
  assert.deepEqual(await sendResumeImage(next.socket, owner, binding, f.members, { ...writer }, imagePayload(), () => {}), { committed: false });
  assert.equal(writes, 12);
});

test("image adapter counts UTF8 bytes before writer even for malformed bounded Unicode", async t => {
  const f = await imageFixture(t); let writes = 0;
  const writer = { saveOnceWithOutcome: async () => { writes++; return { authorized: false } as const; } };
  const payload = { ...imagePayload(), dataUrl: "€".repeat(8 * 1024 * 1024) };
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await sendResumeImage(f.socket, f.owner, f.binding, f.members, writer, payload, () => {}), { committed: false });
  }
  assert.equal(writes, 2); // 2 * 24 MiB = exact 48 MiB budget; third denied before dispatch
});

test("image partial fanout/ACK failures stay committed and cannot replay on retry", async t => {
  const f = await imageFixture(t); let delivered = 0, writes = 0;
  for (const sessionId of ["image-peer-a", "image-peer-b"]) {
    const peer = await f.connect(), owner = attachResumeSocket(peer.socket, { ...f.opts, memberships: f.members,
      store: { advanceGeneration: async () => ({ ...identity(), sessionId }) } });
    t.after(() => owner.close()); const req = request(); req.credential.sessionId = sessionId;
    assert.ok(await owner.admit(req));
    t.mock.method(peer.socket, "emit", (event: string) => {
      assert.equal(event, "chat-image"); if (sessionId === "image-peer-b") throw Error("partial"); delivered++; return true;
    });
  }
  const run = () => sendResumeImage(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => savedImage(++writes === 1) }, imagePayload(), () => { throw Error("ACK"); });
  const first = await run(); assert.ok(first.committed);
  assert.equal(first.ack, "failed"); assert.equal(first.fanout, "failed");
  assert.deepEqual(first.errors.map(e => e.stage), ["ack", "fanout"]); assert.equal(delivered, 1);
  const retry = await run(); assert.ok(retry.committed); assert.equal(retry.fanout, "skipped"); assert.equal(delivered, 1);
});

const savedText = (inserted = true): OperationResult<ResumeTextWrite> => ({ authorized: true,
  value: { inserted, message: { id: 71, type: "message", username: "Alice", message: "hello", ts: 123 } } });
const textPayload = () => ({ roomId: "candy986", clientMessageId: "request_1", message: "hello" });

test("text rate debt survives physical reconnect and wrapper changes; rejection is before DB", async t => {
  const f = await fixture(t), opts = options(), members = new ResumeMemberships(opts.bindings);
  const sessionId = "rate-integration-session";
  async function connect(generation: number) {
    const transport = await f.connect();
    const owner = attachResumeSocket(transport.socket, { ...opts, memberships: members,
      store: { advanceGeneration: async () => ({ ...identity(generation), sessionId }) } });
    t.after(() => owner.close());
    const req = request(generation - 1); req.credential.sessionId = sessionId;
    const binding = await owner.admit(req); assert.ok(binding);
    return { ...transport, owner, binding };
  }
  let writes = 0;
  const writer = { saveOnceWithOutcome: async (): Promise<OperationResult<ResumeTextWrite>> => {
    writes++;
    if (writes === 1) throw Error("uncertain COMMIT");
    if (writes === 2) return { authorized: false };
    return savedText(false); // already-stored retries still cost an attempt
  } };
  const run = (x: Awaited<ReturnType<typeof connect>>, i: number, cap = new ResumeCapacity(1)) =>
    sendResumeText(x.socket, x.owner, x.binding, members, { ...writer },
      { ...textPayload(), clientMessageId: `rate-${i}`, sessionId: `spoof-${i}` } as ReturnType<typeof textPayload>,
      () => {}, { capacity: cap });
  const first = await connect(1);
  await assert.rejects(run(first, 0), /uncertain COMMIT/);
  assert.deepEqual(await run(first, 1), { committed: false });
  for (let i = 2; i < 120; i++) assert.equal((await run(first, i)).committed, true);
  const cap = new ResumeCapacity(1);
  assert.deepEqual(await run(first, 120, cap), { committed: false });
  const release = cap.acquire(); assert.ok(release); release();
  await first.owner.close();
  const next = await connect(2);
  assert.deepEqual(await run(next, 121), { committed: false });
  assert.equal(writes, 120);
});

test("text deadline returns uncertain identity, retains both leases and suppresses late commit publication", async t => {
  const first = await syncFixture(t), second = await syncFixture(t);
  const cap = new ResumeCapacity(1), gate = deferred<OperationResult<ResumeTextWrite>>();
  let writes = 0, acks = 0;
  const fanout = t.mock.method(first.members, "broadcastExcept", () => assert.fail("late fanout"));
  const run = (f: typeof first, capacity = cap) => sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => { writes++; return gate.promise; } }, textPayload(),
    () => { acks++; }, { capacity, timeoutMs: 15 });
  assert.deepEqual(await run(first), { committed: null, reason: "deadline", clientMessageId: "request_1" });
  assert.deepEqual(await run(first, new ResumeCapacity(1)), { committed: false });
  assert.deepEqual(await run(second), { committed: false });
  assert.deepEqual([writes, acks], [1, 0]);
  gate.resolve(savedText()); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(acks, 0); assert.equal(fanout.mock.callCount(), 0);
  assert.equal((await run(second)).committed, true); assert.equal(writes, 2);
});

test("text timeout observes late COMMIT rejection once even if reporter fails, without retry", async t => {
  const f = await syncFixture(t), cap = new ResumeCapacity(1), gate = deferred<void>();
  const error = Error("unknown COMMIT"), reports: unknown[] = [];
  const failures = t.mock.method(console, "error", () => {});
  let writes = 0;
  const pending = sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => { writes++; await gate.promise; throw error; } }, textPayload(),
    () => assert.fail("late ACK"), { capacity: cap, timeoutMs: 15,
      onLateError: error => { reports.push(error); throw Error("reporter failed"); } });
  assert.equal((await pending).committed, null); assert.equal(cap.acquire(), null);
  await f.owner.close(); assert.equal(cap.acquire(), null);
  gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(reports, [error]); assert.equal(writes, 1); assert.equal(failures.mock.callCount(), 1);
  const release = cap.acquire(); assert.ok(release); release();
});

test("text monotonic deadline handles success, denial and rejection before delayed timer delivery", async t => {
  for (const outcome of ["success", "denial", "error"]) {
    const f = await syncFixture(t), reports: unknown[] = [], error = Error("late COMMIT");
    const fanout = t.mock.method(f.members, "broadcastExcept", () => assert.fail("late fanout"));
    const result = await sendResumeText(f.socket, f.owner, f.binding, f.members, {
      saveOnceWithOutcome: async () => {
        const until = performance.now() + 20;
        while (performance.now() < until) { /* block timer delivery deliberately */ }
        if (outcome === "error") throw error;
        return outcome === "denial" ? { authorized: false } : savedText();
      },
    }, textPayload(), () => assert.fail("late ACK"), { timeoutMs: 5, onLateError: e => { reports.push(e); } });
    assert.deepEqual(result, { committed: null, reason: "deadline", clientMessageId: "request_1" });
    assert.deepEqual(reports, outcome === "error" ? [error] : []); assert.equal(fanout.mock.callCount(), 0);
  }
});

test("text invalid deadlines fail before dispatch and early COMMIT errors remain explicit", async t => {
  const f = await syncFixture(t), cap = new ResumeCapacity(1); let writes = 0, reports = 0;
  const run = (timeoutMs: number) => sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => { writes++; throw Error("uncertain COMMIT"); } }, textPayload(),
    () => assert.fail("ACK"), { capacity: cap, timeoutMs, onLateError: () => { reports++; } });
  for (const value of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(run(value), /Invalid send deadline/);
  }
  assert.equal(writes, 0);
  await assert.rejects(run(10_000), /uncertain COMMIT/);
  await assert.rejects(run(10_000), /uncertain COMMIT/);
  assert.deepEqual([writes, reports], [2, 0]);
  const release = cap.acquire(); assert.ok(release); release();
});

test("text slow synchronous ACK preserves committed result but deadline fences subsequent fanout", async t => {
  const f = await syncFixture(t);
  t.mock.method(f.members, "broadcastExcept", () => assert.fail("overdue fanout"));
  const result = await sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => savedText() }, textPayload(), () => {
      const until = performance.now() + 20;
      while (performance.now() < until) { /* ACK already started before deadline */ }
      void f.owner.close();
      throw Error("slow ACK failure");
    }, { timeoutMs: 5 });
  assert.ok(result.committed); assert.equal(result.ack, "failed"); assert.equal(result.fanout, "skipped");
  assert.equal(result.errors[0].stage, "ack");
});


test("text send shares per-socket exclusion even with distinct capacity objects", async t => {
  const f = await syncFixture(t), gate = deferred<OperationResult<ResumeTextWrite>>();
  let writes = 0, acks = 0;
  const writer = { saveOnceWithOutcome: async () => { writes++; return gate.promise; } };
  const run = () => sendResumeText(f.socket, f.owner, f.binding, f.members, writer,
    textPayload(), () => { acks++; }, { capacity: new ResumeCapacity(1) });
  const first = run();
  assert.deepEqual(await run(), { committed: false }); assert.equal(writes, 1);
  gate.resolve(savedText()); assert.ok((await first).committed);
  assert.ok((await run()).committed); assert.equal(writes, 2); assert.equal(acks, 2);
});

test("text send aggregate capacity rejects before DB and releases on actual settlement", async t => {
  const first = await syncFixture(t), second = await syncFixture(t);
  const cap = new ResumeCapacity(1), gate = deferred<OperationResult<ResumeTextWrite>>();
  let writes = 0;
  const run = (f: typeof first) => sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => { writes++; return gate.promise; } }, textPayload(), () => {}, { capacity: cap });
  const pending = run(first);
  assert.deepEqual(await run(second), { committed: false }); assert.equal(writes, 1);
  gate.resolve(savedText()); assert.ok((await pending).committed);
  assert.ok((await run(second)).committed); assert.equal(writes, 2);
});

test("text send owner close and replacement cannot free unresolved COMMIT capacity", async t => {
  const f = await syncFixture(t), cap = new ResumeCapacity(1), gate = deferred<OperationResult<ResumeTextWrite>>();
  let writes = 0;
  const writer = { saveOnceWithOutcome: async () => { writes++; return gate.promise; } };
  const pending = sendResumeText(f.socket, f.owner, f.binding, f.members, writer,
    textPayload(), () => assert.fail("stale ACK"), { capacity: cap });
  await f.owner.close(); assert.equal(cap.acquire(), null);
  const next = await f.connect(), owner = attachResumeSocket(next.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => identity(2) } });
  t.after(() => owner.close()); const binding = await owner.admit(request(1)); assert.ok(binding);
  const run = () => sendResumeText(next.socket, owner, binding, f.members, writer,
    textPayload(), () => {}, { capacity: cap });
  assert.deepEqual(await run(), { committed: false }); assert.equal(writes, 1);
  gate.resolve(savedText()); const result = await pending; assert.ok(result.committed);
  assert.equal(result.ack, "skipped"); assert.equal(result.fanout, "skipped");
  assert.ok((await run()).committed); assert.equal(writes, 2);
});

test("text send denial and uncertain COMMIT errors release leases without automatic retry", async t => {
  const f = await syncFixture(t), cap = new ResumeCapacity(1); let writes = 0;
  const run = (fail: boolean) => sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => { writes++; if (fail) throw Error("uncertain COMMIT"); return { authorized: false }; } },
    textPayload(), () => assert.fail("denied ACK"), { capacity: cap });
  assert.deepEqual(await run(false), { committed: false });
  await assert.rejects(run(true), /uncertain COMMIT/);
  assert.deepEqual(await run(false), { committed: false }); assert.equal(writes, 3);
  const release = cap.acquire(); assert.ok(release); release();
});

test("text send reentrant ACK cannot start another write before first handoff settles", async t => {
  const f = await syncFixture(t), cap = new ResumeCapacity(1); let writes = 0;
  let nested: Promise<unknown> | undefined;
  const writer = { saveOnceWithOutcome: async () => { writes++; return savedText(); } };
  const run = () => sendResumeText(f.socket, f.owner, f.binding, f.members, writer, textPayload(), () => {
    nested = sendResumeText(f.socket, f.owner, f.binding, f.members, writer, textPayload(), () => {}, { capacity: cap });
    throw Error("ACK failed");
  }, { capacity: cap });
  const result = await run(); assert.ok(result.committed); assert.equal(result.ack, "failed");
  assert.deepEqual(await nested, { committed: false }); assert.equal(writes, 1);
  assert.ok((await run()).committed); assert.equal(writes, 2);
});

test("text adapter rejects invalid payload and copied/wrong physical authority before DB", async t => {
  const f = await syncFixture(t), other = await f.connect(); let writes = 0;
  const writer = { saveOnceWithOutcome: async () => { writes++; return savedText(); } };
  const ack = () => assert.fail("unauthorized ACK");
  for (const payload of [null, { ...textPayload(), roomId: "other123" },
    { ...textPayload(), clientMessageId: "bad key" }, { ...textPayload(), message: " " },
    { ...textPayload(), message: "a".repeat(10_001) }]) {
    assert.deepEqual(await sendResumeText(f.socket, f.owner, f.binding, f.members, writer, payload, ack), { committed: false });
  }
  for (const [socket, owner, binding] of [[other.socket, f.owner, f.binding],
    [f.socket, { ...f.owner }, f.binding], [f.socket, f.owner, { ...f.binding }]] as const) {
    assert.deepEqual(await sendResumeText(socket, owner, binding, f.members, writer, textPayload(), ack), { committed: false });
  }
  assert.equal(writes, 0);
});

test("text adapter snapshots client fields and hands off only committed authoritative receipt", async t => {
  const f = await syncFixture(t), gate = deferred<OperationResult<ResumeTextWrite>>();
  const payload = { ...textPayload(), username: "spoof", sessionId: "spoof" }; const calls: unknown[] = [];
  const fanout = t.mock.method(f.members, "broadcastExcept", (...args: unknown[]) => { calls.push(args); return 0; });
  const pending = sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async (...args) => { assert.deepEqual(args, [f.binding, "request_1", "hello"]); return gate.promise; } },
    payload, reply => { calls.push(reply); assert.ok(Object.isFrozen(reply)); assert.ok(Object.isFrozen(reply.message)); });
  payload.roomId = "other123"; payload.message = "mutated"; payload.clientMessageId = "changed";
  assert.equal(calls.length, 0); gate.resolve(savedText()); const result = await pending;
  assert.ok(result.committed); assert.equal(result.ack, "handed-off"); assert.equal(result.fanout, "attempted");
  assert.equal(result.receipt.clientMessageId, "request_1"); assert.equal(result.receipt.message.username, "Alice");
  assert.equal(fanout.mock.calls[0].arguments[1], "candy986"); assert.equal(calls.length, 2);
});

test("text adapter reports durable commit but suppresses old-owner ACK/fanout after async owner loss", async t => {
  for (const kind of ["close", "disconnect", "expiry", "replacement"]) {
    const f = await syncFixture(t), gate = deferred<OperationResult<ResumeTextWrite>>();
    const fanout = t.mock.method(f.members, "broadcastExcept", () => assert.fail("stale fanout"));
    const pending = sendResumeText(f.socket, f.owner, f.binding, f.members,
      { saveOnceWithOutcome: async () => gate.promise }, textPayload(), () => assert.fail("stale ACK"));
    if (kind === "close") await f.owner.close();
    if (kind === "disconnect") f.socket.disconnect(true);
    if (kind === "expiry") f.expire();
    if (kind === "replacement") {
      const next = await f.connect(), owner = attachResumeSocket(next.socket, { ...f.opts, memberships: f.members,
        store: { advanceGeneration: async () => identity(2) } });
      t.after(() => owner.close()); assert.ok(await owner.admit(request(1)));
    }
    gate.resolve(savedText()); const result = await pending;
    assert.ok(result.committed); assert.equal(result.ack, "skipped"); assert.equal(result.fanout, "skipped");
    assert.equal(fanout.mock.callCount(), 0);
  }
});

test("text adapter DB denial/error cannot ACK or publish and uncertain commit is not retried", async t => {
  const f = await syncFixture(t); let writes = 0;
  t.mock.method(f.members, "broadcastExcept", () => assert.fail("denied fanout"));
  const run = (fail: boolean) => sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => { writes++; if (fail) throw Error("uncertain COMMIT"); return { authorized: false }; } },
    textPayload(), () => assert.fail("denied ACK"));
  assert.deepEqual(await run(false), { committed: false }); await assert.rejects(run(true), /uncertain COMMIT/);
  assert.equal(writes, 2);
});

test("text adapter same-key existing receipt ACKs without replaying fanout", async t => {
  const f = await syncFixture(t); let writes = 0, acks = 0;
  const fanout = t.mock.method(f.members, "broadcastExcept", () => 0);
  const run = () => sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => savedText(++writes === 1) }, textPayload(), () => { acks++; });
  const first = await run(), retry = await run(); assert.ok(first.committed && retry.committed);
  assert.equal(first.inserted, true); assert.equal(retry.inserted, false);
  assert.equal(retry.fanout, "skipped"); assert.deepEqual(first.receipt, retry.receipt);
  assert.equal(acks, 2); assert.equal(fanout.mock.callCount(), 1);
});

test("text adapter ACK failure remains committed and cannot authorize a retry fanout", async t => {
  const f = await syncFixture(t); let acks = 0;
  const fanout = t.mock.method(f.members, "broadcastExcept", () => 0);
  const result = await sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => savedText() }, textPayload(), () => { acks++; throw Error("ACK broken"); });
  assert.ok(result.committed); assert.equal(result.ack, "failed"); assert.equal(result.fanout, "attempted");
  assert.equal(result.errors[0].stage, "ack"); assert.equal(acks, 1); assert.equal(fanout.mock.callCount(), 1);
});

test("text adapter reentrant ACK close suppresses remaining publication", async t => {
  const f = await syncFixture(t);
  t.mock.method(f.members, "broadcastExcept", () => assert.fail("closed sender fanout"));
  const result = await sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => savedText() }, textPayload(), () => { void f.owner.close(); });
  assert.ok(result.committed); assert.equal(result.ack, "handed-off"); assert.equal(result.fanout, "skipped");
});

test("text adapter partial real recipient handoff failure remains committed; retry is ACK-only", async t => {
  const f = await syncFixture(t); let delivered = 0, writes = 0;
  for (const sessionId of ["peer_a", "peer_b", "peer_c"]) {
    const peer = await f.connect(), owner = attachResumeSocket(peer.socket, { ...f.opts, memberships: f.members,
      store: { advanceGeneration: async () => ({ ...identity(), sessionId }) } });
    t.after(() => owner.close()); const req = request(); req.credential.sessionId = sessionId;
    assert.ok(await owner.admit(req));
    t.mock.method(peer.socket, "emit", () => { if (sessionId === "peer_b") throw Error("partial outbound"); delivered++; return true; });
  }
  const run = () => sendResumeText(f.socket, f.owner, f.binding, f.members,
    { saveOnceWithOutcome: async () => savedText(++writes === 1) }, textPayload(), () => {});
  const first = await run(); assert.ok(first.committed); assert.equal(first.fanout, "failed");
  assert.equal(first.errors[0].stage, "fanout"); assert.equal(delivered, 1);
  const retry = await run(); assert.ok(retry.committed); assert.equal(retry.fanout, "skipped"); assert.equal(delivered, 1);
});

async function syncFixture(t: TestContext, sessionId?: string) {
  const f = await fixture(t), transport = await f.connect(), opts = options();
  let now = 0;
  opts.bindings = new ResumeBindings(10, () => now);
  const members = new ResumeMemberships(opts.bindings);
  const owner = attachResumeSocket(transport.socket, { ...opts, memberships: members,
    ...(sessionId ? { store: { advanceGeneration: async () => ({ ...identity(), sessionId }) } } : {}) });
  t.after(() => owner.close());
  const req = request(); if (sessionId) req.credential.sessionId = sessionId;
  const binding = await owner.admit(req); assert.ok(binding);
  return { ...f, ...transport, opts, members, owner, binding, expire: () => { now = binding.expiresAt; } };
}

test("sync rejects wrong room, copied authority and another physical socket before read", async t => {
  const f = await syncFixture(t), other = await f.connect(); let reads = 0, acks = 0;
  const reader = { read: async () => { reads++; return []; } }, ack = () => { acks++; };
  const payload = { roomId: "candy986" };
  for (const roomId of ["other123", "invalid", 12, undefined]) {
    assert.equal(await syncResumeSocket(f.socket, f.owner, f.binding, f.members, reader, { roomId }, ack), false);
  }
  assert.equal(await syncResumeSocket(f.socket, { ...f.owner }, f.binding, f.members, reader, payload, ack), false);
  assert.equal(await syncResumeSocket(f.socket, f.owner, { ...f.binding }, f.members, reader, payload, ack), false);
  assert.equal(await syncResumeSocket(other.socket, f.owner, f.binding, f.members, reader, payload, ack), false);
  assert.deepEqual([reads, acks], [0, 0]);
});

test("sync probe is local liveness only, including during a pending DB read", async t => {
  const f = await syncFixture(t), gate = deferred<readonly unknown[]>(); let reads = 0;
  const reader = { read: async () => { reads++; return gate.promise; } }, replies: unknown[] = [];
  const run = (probeOnly: boolean) => syncResumeSocket(f.socket, f.owner, f.binding, f.members, reader,
    { roomId: "candy986", probeOnly }, reply => { replies.push(reply); });
  const pending = run(false);
  assert.equal(await run(true), true); assert.equal(reads, 1); assert.deepEqual(replies, [{ ok: true }]);
  await f.owner.close(); assert.equal(await run(true), false);
  gate.resolve([]); assert.equal(await pending, false); assert.equal(replies.length, 1);
});

test("sync rejects overlapping reads and performs fresh reads after settlement", async t => {
  const f = await syncFixture(t), gate = deferred<readonly unknown[]>(); let reads = 0;
  const reader = { read: async () => { reads++; return gate.promise; } }, replies: unknown[] = [];
  const run = () => syncResumeSocket(f.socket, f.owner, f.binding, f.members, reader,
    { roomId: "candy986" }, reply => { replies.push(reply); });
  const pending = run(); assert.equal(await run(), false); assert.equal(reads, 1);
  gate.resolve([{ id: 7 }]); assert.equal(await pending, true); assert.equal(await run(), true);
  assert.equal(reads, 2); assert.equal(replies.length, 2);
});

test("sync drops delayed ACK on owner close, disconnect, expiry and replacement", async t => {
  for (const kind of ["close", "disconnect", "expiry", "replacement"]) {
    const f = await syncFixture(t), gate = deferred<readonly unknown[]>(); let acks = 0;
    const pending = syncResumeSocket(f.socket, f.owner, f.binding, f.members,
      { read: async () => gate.promise }, { roomId: "candy986" }, () => { acks++; });
    if (kind === "close") await f.owner.close();
    if (kind === "disconnect") f.socket.disconnect(true);
    if (kind === "expiry") f.expire();
    if (kind === "replacement") {
      const next = await f.connect();
      const owner = attachResumeSocket(next.socket, { ...f.opts, memberships: f.members,
        store: { advanceGeneration: async () => identity(2) } });
      t.after(() => owner.close()); assert.ok(await owner.admit(request(1)));
    }
    gate.resolve([{ id: 7 }]); assert.equal(await pending, false); assert.equal(acks, 0);
  }
});

test("sync denial and late failure never ACK and release read reservation", async t => {
  const f = await syncFixture(t); let acks = 0;
  const run = (read: () => Promise<readonly unknown[] | null>) => syncResumeSocket(f.socket, f.owner,
    f.binding, f.members, { read }, { roomId: "candy986" }, () => { acks++; });
  assert.equal(await run(async () => null), false);
  const gate = deferred<void>();
  const failed = run(async () => { await gate.promise; throw Error("late DB failure"); });
  gate.resolve(); await assert.rejects(failed, /late DB failure/); assert.equal(acks, 0);
  assert.equal(await run(async () => []), true); assert.equal(acks, 1);
});

test("sync snapshots request and recomputes presence at handoff", async t => {
  const f = await syncFixture(t), gate = deferred<readonly unknown[]>(), replies: unknown[] = [];
  const payload = { roomId: "candy986", probeOnly: false };
  const pending = syncResumeSocket(f.socket, f.owner, f.binding, f.members,
    { read: async binding => { assert.equal(binding, f.binding); return gate.promise; } }, payload,
    reply => { replies.push(reply); });
  payload.roomId = "other123"; payload.probeOnly = true;
  const peer = await f.connect(), owner = attachResumeSocket(peer.socket, { ...f.opts, memberships: f.members,
    store: { advanceGeneration: async () => ({ ...identity(), sessionId: "peer", username: "Bob" }) } });
  t.after(() => owner.close()); const req = request(); req.credential.sessionId = "peer";
  assert.ok(await owner.admit(req)); gate.resolve([{ id: 7 }]); assert.equal(await pending, true);
  assert.equal(replies.length, 1);
  const reply = replies[0] as { history: unknown[]; users: string[] };
  assert.deepEqual(reply.history, [{ id: 7 }]); assert.deepEqual(reply.users.sort(), ["Alice", "Bob"]);
  assert.deepEqual(Object.keys(reply).sort(), ["history", "users"]);
});

test("sync handoff exceptions do not replay ACK and release reservation", async t => {
  const f = await syncFixture(t); let acks = 0, reads = 0;
  const reader = { read: async () => { reads++; return []; } };
  await assert.rejects(syncResumeSocket(f.socket, f.owner, f.binding, f.members, reader,
    { roomId: "candy986" }, () => { acks++; throw Error("ACK handoff"); }), /ACK handoff/);
  assert.deepEqual([reads, acks], [1, 1]);
  assert.equal(await syncResumeSocket(f.socket, f.owner, f.binding, f.members, reader,
    { roomId: "candy986" }, () => { acks++; }), true);
  assert.deepEqual([reads, acks], [2, 2]);
});


test("sync aggregate budget spans sockets and rejects before DB dispatch; probe stays cheap", async t => {
  const first = await syncFixture(t), second = await syncFixture(t), capacity = new ResumeCapacity(1);
  const gate = deferred<readonly unknown[]>(); let reads = 0, probes = 0;
  const read = async () => { reads++; return gate.promise; };
  const run = (f: typeof first, probeOnly = false) => syncResumeSocket(f.socket, f.owner, f.binding,
    f.members, { read }, { roomId: "candy986", probeOnly }, () => { probes++; }, { capacity });
  const pending = run(first);
  assert.equal(await run(second), false); assert.equal(reads, 1);
  assert.equal(await run(second, true), true); assert.equal(reads, 1);
  gate.resolve([]); assert.equal(await pending, true);
  assert.equal(await run(second), true); assert.equal(reads, 2); assert.equal(probes, 3);
});

test("sync timeout retains socket AND global leases until real settlement then allows fresh request", async t => {
  const first = await syncFixture(t), second = await syncFixture(t), capacity = new ResumeCapacity(1);
  const gate = deferred<readonly unknown[]>(); let reads = 0, acks = 0;
  const run = (f: typeof first, cap = capacity) => syncResumeSocket(f.socket, f.owner, f.binding,
    f.members, { read: async () => { reads++; return gate.promise; } }, { roomId: "candy986" },
    () => { acks++; }, { capacity: cap, timeoutMs: 15 });
  assert.equal(await run(first), false); assert.equal(acks, 0);
  assert.equal(await run(first, new ResumeCapacity(1)), false); // per-socket cap survives timeout
  assert.equal(await run(second), false); assert.equal(reads, 1);
  gate.resolve([{ id: 8 }]); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(acks, 0); assert.equal(await run(first), true);
  assert.deepEqual([reads, acks], [2, 1]);
});

test("sync close/replacement returns promptly but retains shared capacity for unresolved read", async t => {
  for (const replace of [false, true]) {
    const f = await syncFixture(t), capacity = new ResumeCapacity(1), gate = deferred<readonly unknown[]>();
    let acks = 0;
    const pending = syncResumeSocket(f.socket, f.owner, f.binding, f.members,
      { read: async () => gate.promise }, { roomId: "candy986" }, () => { acks++; }, { capacity });
    if (replace) {
      const next = await f.connect();
      const owner = attachResumeSocket(next.socket, { ...f.opts, memberships: f.members,
        store: { advanceGeneration: async () => identity(2) } });
      t.after(() => owner.close()); assert.ok(await owner.admit(request(1)));
    } else await f.owner.close();
    assert.equal(await pending, false); assert.equal(capacity.acquire(), null);
    gate.resolve([]); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(acks, 0); const release = capacity.acquire(); assert.ok(release); release();
  }
});

test("sync observes late rejection once after timeout or close, even when reporter throws", async t => {
  const reporterFailures: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { reporterFailures.push(args); });
  for (const close of [false, true]) {
    const f = await syncFixture(t), capacity = new ResumeCapacity(1), gate = deferred<void>();
    const failure = Error("late read"); const reported: unknown[] = []; let acks = 0, reads = 0;
    const pending = syncResumeSocket(f.socket, f.owner, f.binding, f.members,
      { read: async () => { reads++; await gate.promise; throw failure; } }, { roomId: "candy986" },
      () => { acks++; }, { capacity, timeoutMs: 15,
        onLateError: error => { reported.push(error); throw Error("reporter"); } });
    if (close) await f.owner.close();
    assert.equal(await pending, false); assert.equal(capacity.acquire(), null);
    gate.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(reported, [failure]); assert.deepEqual([reads, acks], [1, 0]);
    const release = capacity.acquire(); assert.ok(release); release();
  }
  assert.equal(reporterFailures.length, 2);
});

test("sync monotonic deadline fences ACK and reports late failure even before timer runs", async t => {
  for (const fail of [false, true]) {
    const f = await syncFixture(t), errors: unknown[] = []; let acks = 0;
    const failure = Error("expired while timer blocked");
    assert.equal(await syncResumeSocket(f.socket, f.owner, f.binding, f.members, {
      read: async () => {
        const until = performance.now() + 20;
        while (performance.now() < until) { /* deliberately block timer delivery */ }
        if (fail) throw failure;
        return [];
      },
    }, { roomId: "candy986" }, () => { acks++; },
    { timeoutMs: 5, onLateError: error => { errors.push(error); } }), false);
    assert.equal(acks, 0); assert.deepEqual(errors, fail ? [failure] : []);
  }
});

test("sync invalid deadlines fail before reserving or dispatching; immediate errors release both leases", async t => {
  const f = await syncFixture(t), capacity = new ResumeCapacity(1); let reads = 0, reports = 0;
  const run = (timeoutMs: number) => syncResumeSocket(f.socket, f.owner, f.binding, f.members,
    { read: async () => { reads++; throw Error("immediate read failure"); } },
    { roomId: "candy986" }, () => assert.fail("unexpected ACK"),
    { capacity, timeoutMs, onLateError: () => { reports++; } });
  for (const value of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(run(value), /Invalid sync deadline/);
  }
  assert.equal(reads, 0);
  await assert.rejects(run(10_000), /immediate read failure/);
  await assert.rejects(run(10_000), /immediate read failure/);
  assert.deepEqual([reads, reports], [2, 0]);
  const release = capacity.acquire(); assert.ok(release); release();
});

test("sync preserves ACK result or exception when ACK reentrantly closes owner", async t => {
  for (const fail of [false, true]) {
    const f = await syncFixture(t), capacity = new ResumeCapacity(1); let acks = 0, reports = 0;
    const pending = syncResumeSocket(f.socket, f.owner, f.binding, f.members,
      { read: async () => [] }, { roomId: "candy986" }, () => {
        acks++; void f.owner.close(); if (fail) throw Error("ACK closed then threw");
      }, { capacity, onLateError: () => { reports++; } });
    if (fail) await assert.rejects(pending, /ACK closed then threw/);
    else assert.equal(await pending, true);
    assert.deepEqual([acks, reports], [1, 0]);
    const release = capacity.acquire(); assert.ok(release); release();
  }
});

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
