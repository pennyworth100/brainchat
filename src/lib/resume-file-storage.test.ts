import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, type FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import crypto from "node:crypto";
import { ResumeBindings } from "./resume-bindings";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { ResumeFileStorage, writeResumeChunk } from "./resume-file-storage";

const metadata = { name: "report.txt", mime: "text/plain", clientMessageId: "key" };
const reservations: Pick<import("./resume-upload-reservation").ResumeUploadReservations, "reserve"> = {
  reserve: async input => ({ status: "reserved", attempt: Object.freeze({
    ...input, storageKey: crypto.randomBytes(32).toString("hex") }) }),
};
async function fixture(t: TestContext, maxBytes = 10) {
  const root = await mkdtemp(join(tmpdir(), "dimle-file-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 0;
  const bindings = new ResumeBindings(10, () => 0);
  const binding = (await bindings.activate({ sessionId: "s", generation: 1,
    roomId: "candy986", username: "Alice", authVersion: 1,
    issuedAt: new Date(0), expiresAt: new Date(1000) }, "storage-transport-01", async () => {}, () => true))!;
  const admissions = new ResumeUploadAdmissions(bindings, undefined, maxBytes, 100, () => now);
  const grant = admissions.admit(binding)!;
  const storage = new ResumeFileStorage(root, admissions, reservations);
  return { root, bindings, binding, admissions, grant, storage, time: (v: number) => { now = v; } };
}
async function* bytes(...chunks: string[]) { for (const c of chunks) yield Buffer.from(c); }

test("exclusive storage derives bytes/digest, restrictive modes and exact grant capability", async t => {
  const f = await fixture(t);
  const result = await f.storage.stage(f.grant, metadata, bytes("hello", "world"));
  assert.equal(result.file.size, 10);
  assert.equal(result.file.sha256, createHash("sha256").update("helloworld").digest("hex"));
  const path = join(f.root, result.file.storageKey);
  assert.equal((await readFile(join(path, "blob"))).toString(), "helloworld");
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(join(path, "blob"))).mode & 0o777, 0o600);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.file));
  assert.equal(f.storage.resolve(f.grant, result), result.file);
  assert.equal(f.storage.resolve({ ...f.grant }, result), null);
  assert.equal(f.storage.resolve(f.grant, { ...result }), null);
  assert.equal(new ResumeFileStorage(f.root, f.admissions, reservations).resolve(f.grant, result), null);
  await assert.rejects(f.storage.stage(f.grant, metadata, bytes("again")), /denied/);
  assert.equal(f.admissions.admit(f.binding), null); // storage never releases
  f.admissions.release(f.grant);
  assert.equal(f.storage.resolve(f.grant, result), null);
});

test("zero-byte stream yields actual empty digest; ordinary disconnect is allowed", async t => {
  const f = await fixture(t); f.bindings.detach(f.binding);
  const r = await f.storage.stage(f.grant, metadata, bytes());
  assert.equal(r.file.size, 0);
  assert.equal(r.file.sha256, createHash("sha256").digest("hex"));
});

test("oversize denied before disk write; iterator settles and lease remains held", async t => {
  const f = await fixture(t, 4); let settled = false;
  async function* input() { try { yield Buffer.from("abcd"); yield Buffer.from("e"); }
    finally { await Promise.resolve(); settled = true; } }
  await assert.rejects(f.storage.stage(f.grant, metadata, input()), /denied/);
  assert.equal(settled, true);
  const dirs = await readdir(f.root); assert.equal(dirs.length, 1);
  assert.equal((await readFile(join(f.root, dirs[0], "blob"))).toString(), "abcd");
  assert.equal(f.admissions.admit(f.binding), null);
});

test("invalid metadata and forged grant have no filesystem or source effects", async t => {
  const f = await fixture(t); let consumed = false;
  async function* input() { consumed = true; yield Buffer.from("a"); }
  await assert.rejects(f.storage.stage(f.grant, { ...metadata, name: "../bad" }, input()), /metadata/);
  await assert.rejects(f.storage.stage({ ...f.grant }, metadata, input()), /denied/);
  assert.equal(consumed, false); assert.deepEqual(await readdir(f.root), []);
});

test("deadline after settled bytes prevents receipt and retains owned file", async t => {
  const f = await fixture(t);
  async function* input() { yield Buffer.from("abc"); f.time(100); }
  await assert.rejects(f.storage.stage(f.grant, metadata, input()), /denied/);
  const dirs = await readdir(f.root);
  assert.equal((await readFile(join(f.root, dirs[0], "blob"))).toString(), "abc");
  assert.equal(f.admissions.admit(f.binding), null);
});

test("source error retains only this attempt and never creates a receipt", async t => {
  const f = await fixture(t);
  async function* input() { yield Buffer.from("abc"); throw Error("source failed"); }
  await assert.rejects(f.storage.stage(f.grant, metadata, input()), /source failed/);
  assert.equal((await readdir(f.root)).length, 1);
  await assert.rejects(f.storage.stage(f.grant, metadata, bytes("retry")), /denied/);
});

test("root symlink is rejected without writing through it", async t => {
  const f = await fixture(t), parent = await mkdtemp(join(tmpdir(), "dimle-link-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const link = join(parent, "link"); await symlink(f.root, link);
  await assert.rejects(new ResumeFileStorage(link, f.admissions, reservations).stage(f.grant, metadata, bytes("abc")));
  assert.deepEqual(await readdir(f.root), []);
});

test("short writes advance offsets, respect backpressure and fence remaining bytes", async () => {
  const offsets: number[] = []; let active = 0;
  await writeResumeChunk(async (_, offset) => { assert.equal(active++, 0);
    await Promise.resolve(); active--; offsets.push(offset); return 1; }, Buffer.from("abc"), () => true);
  assert.deepEqual(offsets, [0, 1, 2]);
  let current = true, calls = 0;
  await assert.rejects(writeResumeChunk(async () => { calls++; current = false; return 1; },
    Buffer.from("abc"), () => current), /denied/);
  assert.equal(calls, 1);
  for (const bad of [0, -1, 4, NaN, 0.5]) {
    await assert.rejects(writeResumeChunk(async () => bad, Buffer.from("abc"), () => true), /progress/);
  }
});

for (const operation of ["sync", "close"] as const) {
  for (const failAt of [1, 2, 3]) {
    test(`${operation} failure at durability step ${failAt} fails closed and closes every handle`, async t => {
      const f = await fixture(t), originalOpen = fs.open;
      let calls = 0;
      const handles = new Set<FileHandle>();
      t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await originalOpen(...args), original = handle[operation];
        handles.add(handle);
        t.mock.method(handle, operation, async () => {
          if (++calls === failAt) throw Error("injected durability failure");
          return original.call(handle);
        });
        return handle;
      });
      await assert.rejects(f.storage.stage(f.grant, metadata, bytes("abc")), /injected durability/);
      for (const handle of handles) assert.equal(handle.fd, -1);
      assert.equal(f.admissions.admit(f.binding), null);
      assert.equal((await readdir(f.root)).length, 1);
    });
  }
}

test("chunk snapshot survives caller buffer mutation during pending disk write", async t => {
  const f = await fixture(t), probe = await open(f.root, "r");
  const prototype = Object.getPrototypeOf(probe); await probe.close();
  const original = prototype.write, buffer = Buffer.from("abc");
  t.mock.method(prototype, "write", async function(this: FileHandle, ...args: unknown[]) {
    buffer.fill(120); await Promise.resolve(); return original.apply(this, args);
  });
  async function* input() { yield buffer; }
  const result = await f.storage.stage(f.grant, metadata, input());
  assert.equal((await readFile(join(f.root, result.file.storageKey, "blob"))).toString(), "abc");
  assert.equal(result.file.sha256, createHash("sha256").update("abc").digest("hex"));
});

test("concurrent reuse of one grant starts only one filesystem attempt", async t => {
  const f = await fixture(t);
  const pending = f.storage.stage(f.grant, metadata, bytes("abc"));
  await assert.rejects(f.storage.stage(f.grant, metadata, bytes("def")), /denied/);
  const result = await pending;
  assert.equal((await readFile(join(f.root, result.file.storageKey, "blob"))).toString(), "abc");
  assert.equal((await readdir(f.root)).length, 1);
});

test("random path collision never overwrites an existing attachment", async t => {
  const f = await fixture(t);
  const result = await f.storage.stage(f.grant, metadata, bytes("original"));
  f.admissions.release(f.grant);
  const next = f.admissions.admit(f.binding)!;
  t.mock.method(crypto, "randomBytes", () => Buffer.from(result.file.storageKey, "hex"));
  await assert.rejects(f.storage.stage(next, metadata, bytes("new")), { code: "EEXIST" });
  assert.equal((await readFile(join(f.root, result.file.storageKey, "blob"))).toString(), "original");
  assert.equal((await readdir(f.root)).length, 1);
});

for (const mode of ["denied", "unknown", "not-dispatched", "throws"] as const) {
  test(`reservation ${mode} prevents all filesystem/source effects and retry`, async t => {
    const f = await fixture(t); let reads = 0, opens = 0, calls = 0;
    t.mock.method(fs, "open", async () => { opens++; throw Error("unexpected open"); });
    t.mock.method(reservations, "reserve", async (input: Omit<import("./resume-upload-reservation").UploadAttempt, "storageKey">) => {
      calls++;
      if (mode === "throws") throw Error("reservation checkout failed");
      return mode === "denied" ? { status: "denied" } :
        { status: "failed", commit: mode, attempt: { ...input, storageKey: "a".repeat(64) } };
    });
    async function* input() { reads++; yield Buffer.from("abc"); }
    await assert.rejects(f.storage.stage(f.grant, metadata, input()));
    await assert.rejects(f.storage.stage(f.grant, metadata, input()), /denied/);
    assert.equal(calls, 1); assert.equal(opens, 0); assert.equal(reads, 0);
    assert.deepEqual(await readdir(f.root), []);
    assert.equal(f.admissions.admit(f.binding), null);
  });
}

for (const fence of ["deadline", "release", "successor"] as const) {
  test(`pending reservation retains attempt; acknowledged charge then ${fence} denies before IO`, async t => {
    const f = await fixture(t); let resume!: () => void, entered!: () => void;
    const pending = new Promise<void>(r => { resume = r; });
    const ready = new Promise<void>(r => { entered = r; });
    let charged = 0, reads = 0, opens = 0, settled = false;
    t.after(() => resume());
    t.mock.method(fs, "open", async () => { opens++; throw Error("unexpected open"); });
    t.mock.method(reservations, "reserve", async (input: Omit<import("./resume-upload-reservation").UploadAttempt, "storageKey">) => {
      charged += input.reservedBytes; entered(); await pending;
      return { status: "reserved", attempt: Object.freeze({ ...input, storageKey: "b".repeat(64) }) };
    });
    async function* input() { reads++; yield Buffer.from("abc"); }
    const work = f.storage.stage(f.grant, metadata, input()).finally(() => { settled = true; });
    await ready;
    await assert.rejects(f.storage.stage(f.grant, metadata, input()), /denied/);
    assert.equal(settled, false); assert.equal(reads, 0); assert.equal(opens, 0);
    assert.equal(f.admissions.admit(f.binding), null);
    if (fence === "deadline") f.time(100);
    if (fence === "release") f.admissions.release(f.grant); // Defensive misuse fence, NOT supported finalization.
    if (fence === "successor") await f.bindings.activate({ ...f.binding, generation: 2,
      issuedAt: new Date(0), expiresAt: new Date(1000) },
      "storage-successor-01", async () => {}, () => true);
    resume();
    await assert.rejects(work, /denied/);
    assert.equal(charged, 10); assert.equal(reads, 0); assert.equal(opens, 0);
    assert.deepEqual(await readdir(f.root), []);
  });
}

test("durable attempt key, exact identity and byte ceiling govern stored bytes", async t => {
  const f = await fixture(t, 4); let captured: unknown;
  t.mock.method(reservations, "reserve", async (input: Omit<import("./resume-upload-reservation").UploadAttempt, "storageKey">) => {
    captured = { ...input };
    return { status: "reserved", attempt: Object.freeze({ ...input, storageKey: "c".repeat(64) }) };
  });
  const file = await f.storage.stage(f.grant, metadata, bytes("ab", "cd"));
  assert.deepEqual(captured, { sessionId: f.binding.sessionId, roomId: f.binding.roomId,
    clientMessageId: "key", reservedBytes: 4 });
  assert.equal(file.file.storageKey, "c".repeat(64));
  assert.equal((await readFile(join(f.root, "c".repeat(64), "blob"))).toString(), "abcd");
});

for (const change of [{ sessionId: "other" }, { roomId: "other123" },
    { clientMessageId: "other" }, { reservedBytes: 9 }, { storageKey: "../escape" }]) {
  test(`reservation identity mismatch ${Object.keys(change)[0]} denies before IO`, async t => {
    const f = await fixture(t); let reads = 0;
    t.mock.method(reservations, "reserve", async (input: Omit<import("./resume-upload-reservation").UploadAttempt, "storageKey">) =>
      ({ status: "reserved", attempt: { ...input, storageKey: "d".repeat(64), ...change } }));
    async function* input() { reads++; yield Buffer.from("abc"); }
    await assert.rejects(f.storage.stage(f.grant, metadata, input()), /identity/);
    assert.equal(reads, 0); assert.deepEqual(await readdir(f.root), []);
  });
}
