import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { ResumeUploadOperationGate } from "./resume-operation";
import { ResumeFileStorage } from "./resume-file-storage";
import { ResumeFileWriter } from "./resume-file";
import { ResumeFileUpload } from "./resume-file-upload";

async function fixture(t: TestContext, mode = "ok") {
  const root = await mkdtemp(join(tmpdir(), "dimle-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 0, connects = 0, inserts = 0, commits = 0;
  const bindings = new ResumeBindings(10, () => 0);
  const binding = (await bindings.activate({ sessionId: "s", generation: 1,
    roomId: "candy986", username: "Alice", authVersion: 1,
    issuedAt: new Date(0), expiresAt: new Date(1000) }, "upload-transport-01", async () => {}, () => true))!;
  const admissions = new ResumeUploadAdmissions(bindings, undefined, 10, 100, () => now);
  const grant = admissions.admit(binding)!;
  let unblock!: () => void;
  const blocked = new Promise<void>(r => { unblock = r; });
  let enteredCommit!: () => void;
  const commitEntered = new Promise<void>(r => { enteredCommit = r; });
  const writer = new ResumeFileWriter(new ResumeUploadOperationGate({ connect: async () => {
    connects++;
    return { query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes("SELECT r.payload_hash")) return { rows: [] };
      if (sql.startsWith("INSERT INTO messages")) {
        inserts++;
        const stored = JSON.parse(args[2] as string);
        assert.equal((await readFile(join(root, stored.url.split("/")[2], "blob"))).toString(), "abc");
        return { rows: [{ id: 1, room_id: args[0], username: args[1], type: "file", content: args[2], ts: new Date(1) }] };
      }
      if (sql.startsWith("INSERT INTO resume_message_receipts")) {
        assert.equal(args[1], "key");
        if (mode === "rollback") throw Error("receipt write failed");
      }
      if (sql === "COMMIT") {
        commits++;
        enteredCommit();
        if (mode === "delayed") await blocked;
        if (mode === "unknown") throw Error("lost ACK");
      }
      return { rows: [], rowCount: mode === "denied" ? 0 : 1 };
    }, release() {} } as unknown as PoolClient;
  } }, admissions));
  const storage = new ResumeFileStorage(root, admissions);
  const upload = new ResumeFileUpload(storage, writer);
  return { root, grant, binding, admissions, bindings, storage, writer, upload,
    stats: () => ({ connects, inserts, commits }), time: (n: number) => { now = n; }, unblock, commitEntered };
}
const metadata = { name: "report.txt", mime: "text/plain" };
async function* bytes() { yield Buffer.from("abc"); }

for (const mode of ["ok", "rollback", "unknown", "denied"]) {
  test(`real staged bytes compose with transaction gate: ${mode}; no repeat dispatch`, async t => {
    const f = await fixture(t, mode);
    const result = await f.upload.saveWithOutcome(f.grant, "key", metadata, bytes());
    if (mode === "ok") assert.ok(result.completed && result.result.authorized && result.result.value.inserted);
    if (mode === "denied") assert.deepEqual(result, { completed: true, result: { authorized: false } });
    if (mode === "rollback" || mode === "unknown") assert.ok(!result.completed && result.commit === (mode === "unknown" ? "unknown" : "not-dispatched"));
    const before = f.stats();
    for (const key of ["key", "another", "bad\n"]) {
      assert.deepEqual(await f.upload.saveWithOutcome(f.grant, key, metadata, bytes()),
        { completed: true, result: { authorized: false } });
    }
    assert.deepEqual(f.stats(), before);
    assert.equal((await readdir(f.root)).length, 1);
    assert.equal(f.admissions.admit(f.binding), null);
  });
}

test("invalid identity and copied grant cannot consume bytes, write files or dispatch DB", async t => {
  const f = await fixture(t); let consumed = false;
  async function* source() { consumed = true; yield Buffer.from("abc"); }
  for (const key of ["", "bad\n", "a".repeat(129)]) {
    const result = await f.upload.saveWithOutcome(f.grant, key, metadata, source());
    assert.ok(!result.completed && result.commit === "not-dispatched");
  }
  await f.upload.saveWithOutcome({ ...f.grant }, "key", metadata, source());
  assert.equal(consumed, false); assert.deepEqual(await readdir(f.root), []);
  assert.equal(f.stats().connects, 0);
});

test("metadata is captured before asynchronous staging; caller cannot inject stored fields", async t => {
  const f = await fixture(t), input = { ...metadata, storageKey: "evil", sha256: "fake", size: 9000 };
  const pending = f.upload.saveWithOutcome(f.grant, "key", input, bytes());
  input.name = "changed.txt";
  const result = await pending;
  assert.ok(result.completed && result.result.authorized);
  assert.equal(result.result.value.message.name, "report.txt");
  assert.equal(result.result.value.message.size, 3);
});

test("source failure awaits iterator finalization and cannot enter database", async t => {
  const f = await fixture(t); let finalized = false;
  async function* source() { try { yield Buffer.from("a"); throw Error("source failed"); }
    finally { await Promise.resolve(); finalized = true; } }
  const result = await f.upload.saveWithOutcome(f.grant, "key", metadata, source());
  assert.ok(!result.completed && result.commit === "not-dispatched");
  assert.equal(finalized, true); assert.equal(f.stats().connects, 0);
  assert.equal(f.admissions.admit(f.binding), null);
});

test("pending COMMIT and duplicate remain pending through expiry; capacity is not released", async t => {
  const f = await fixture(t, "delayed");
  const first = f.upload.saveWithOutcome(f.grant, "key", metadata, bytes());
  let duplicateDone = false;
  const duplicate = f.upload.saveWithOutcome(f.grant, "another", metadata, bytes()).then(r => { duplicateDone = true; return r; });
  await f.commitEntered;
  assert.equal(f.stats().commits, 1);
  f.time(100); await new Promise(r => setImmediate(r));
  assert.equal(duplicateDone, false); assert.equal(f.admissions.admit(f.binding), null);
  f.unblock();
  const result = await first;
  assert.ok(result.completed && result.result.authorized); // dispatched COMMIT is not cancelled
  assert.deepEqual(await duplicate, { completed: true, result: { authorized: false } });
  assert.equal(f.stats().commits, 1);
});

for (const mode of ["copied", "cross-registry", "cross-grant"]) {
  test(`composition rejects ${mode} staged capability before DB checkout`, async t => {
    const f = await fixture(t), other = await fixture(t);
    const staged = mode === "cross-registry" ? await other.storage.stage(other.grant, metadata, bytes()) :
      await f.storage.stage(f.grant, metadata, bytes());
    t.mock.method(f.storage, "stage", async () => mode === "copied" ? { ...staged } : staged);
    const result = await f.upload.saveWithOutcome(mode === "cross-grant" ? other.grant : f.grant,
      "key", metadata, bytes());
    assert.deepEqual(result, { completed: true, result: { authorized: false } });
    assert.equal(f.stats().connects, 0);
  });
}

test("expiry during pending source read waits for actual settlement without DB or release", async t => {
  const f = await fixture(t); let unblock!: () => void, started!: () => void, done = false;
  const blocked = new Promise<void>(r => { unblock = r; });
  const entered = new Promise<void>(r => { started = r; });
  async function* source() { started(); await blocked; yield Buffer.from("abc"); }
  const pending = f.upload.saveWithOutcome(f.grant, "key", metadata, source()).then(r => { done = true; return r; });
  await entered; f.time(100); await new Promise(r => setImmediate(r));
  assert.equal(done, false); assert.equal(f.admissions.admit(f.binding), null);
  unblock(); const result = await pending;
  assert.ok(!result.completed && result.commit === "not-dispatched");
  assert.equal(f.stats().connects, 0); assert.equal(f.admissions.admit(f.binding), null);
});
