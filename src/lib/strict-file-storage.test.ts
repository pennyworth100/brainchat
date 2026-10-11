import { StrictMultipartUpload } from "./strict-multipart-upload";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { createStrictUploadLedgerProvider } from "./upload-ledger-provider";
import { bindStrictUploadRoot } from "./upload-storage-root";
import { StrictUploadAccounting } from "./strict-upload-accounting";
import { StrictFileStorage } from "./strict-file-storage";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

async function fixture(t: TestContext, onQuery: (sql: string) => Promise<void> = async () => {}, ceiling = 8,
  commitTag = "COMMIT") {
  const rootPath = await fs.mkdtemp(join(tmpdir(), "dimle-strict-storage-"));
  await fs.chmod(rootPath, 0o700);
  const st = await fs.stat(rootPath, { bigint: true });
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  let now = 0, connections = 0;
  const commands: string[] = [], inserts: unknown[][] = [], releases: boolean[] = [];
  const identity = { database: '["cluster","postgres"]', schema: "public", quotaDomain: "volume",
    namespace: rootPath, policyVersion: "v1", writerGeneration: "g1" };
  const policy = { identity, adapter: "resume-strict-writer-v1",
    layout: "provisioned-root-one-directory-one-file-v1", allocationModel: "audited-rounded-copies-v1",
    stableExclusiveNamespace: true, allAllocationCostsBounded: true, maxFileBytes: 8,
    allocationUnitBytes: 4, allocationCopies: 1, directoryAndParentBytes: 10,
    metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 };
  const databasePolicy = structuredClone(policy);
  const domain = { database_identity: identity.database, schema_identity: "public", quota_domain: "volume",
    writer_generation: "g1", active: true, audit_id: "cut1", capacity_bytes: "100",
    headroom_bytes: "10", baseline_bytes: "9", outstanding_bytes: "40", capacity_objects: "20",
    headroom_objects: "2", baseline_objects: "3", outstanding_objects: "10" };
  const client = Object.assign(new EventEmitter(), {
    async query(sql: string, values?: unknown[]) {
      commands.push(sql); await onQuery(sql);
      let rows: unknown[] = [];
      if (sql.includes("pg_control_system")) rows = [{ database: "postgres", system_identifier: "123" }];
      else if (sql.includes("FROM public.upload_resource_domains")) rows = [domain];
      else if (sql.includes("FROM public.upload_resource_policies")) rows = [{ policy_snapshot: databasePolicy }];
      else if (sql.startsWith("UPDATE")) rows = [{ outstanding_bytes: values![3], outstanding_objects: values![4] }];
      else if (sql.startsWith("INSERT")) { inserts.push(values!); rows = [{ attempt_id: values![0] }]; }
      return { command: sql === "COMMIT" ? commitTag : sql.split(" ")[0], rows, rowCount: rows.length };
    },
    release(broken: boolean) { releases.push(broken); },
  }) as unknown as PoolClient;
  t.mock.method(Pool.prototype, "connect", async function(this: Pool) {
    connections++; this.emit("connect", client); return client;
  });
  t.mock.method(Pool.prototype, "end", async () => {});
  const provider = createStrictUploadLedgerProvider({ host: "fixture.invalid", port: 5432,
    user: "fixture", password: "fixture", database: "postgres", clusterIdentity: "cluster", systemIdentifier: "123" });
  t.after(() => provider.close());
  const pin = provider.pin(policy)!;
  // Actual disposable root identity; synthetic accounting costs are NOT physical authority.
  const root = bindStrictUploadRoot(pin, policy, { path: identity.namespace, device: st.dev.toString(), inode: st.ino.toString(),
    uid: process.geteuid!(), gid: process.getegid!() })!;
  const bindings = new ResumeBindings();
  const binding = await bindings.activate({ sessionId: "session", roomId: "files123", username: "Guest",
    authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) },
  "transport_upload_fixture", async () => {}, () => true);
  assert.ok(binding);
  const admissions = new ResumeUploadAdmissions(bindings, new ResumeCapacity(1), ceiling, 100, () => now);
  const grant = admissions.admit(binding)!;
  t.after(() => { admissions.release(grant); });
  const provenance = { auditId: "cut1", writerId: "writer1" };
  const make = () => new StrictUploadAccounting(admissions, provider, pin, policy, root, provenance);
  const bridge = make();
  return { rootPath, bridge, make, grant, admissions, binding, policy, provenance, commands, inserts, releases, provider, pin, root,
    expire: () => { now = 100; }, connections: () => connections };
}



const metadata = { name: "file.txt", mime: "text/plain", clientMessageId: "msg_1" };
async function* bytes() { yield Buffer.from("abc"); }
function physicalFixture() {
  const permits = new WeakMap<object, import("./strict-file-storage").StrictStorageRequest>();
  let calls = 0, live = true;
  const requests: import("./strict-file-storage").StrictStorageRequest[] = [];
  return {
    provider: {
      async authorize(request: import("./strict-file-storage").StrictStorageRequest) {
        calls++; requests.push(request);
        const receipt = Object.freeze({ syntheticTestOnly: true });
        permits.set(receipt, request); return receipt;
      },
      isCurrent(receipt: object, request: import("./strict-file-storage").StrictStorageRequest) {
        return live && permits.get(receipt) === request;
      },
    },
    requests, calls: () => calls, revoke: () => { live = false; },
  };
}
test("missing physical provider denies before accounting, body or filesystem entry", async t => {
  const f = await fixture(t);
  const storage = new StrictFileStorage(f.admissions, f.bridge, null);
  let reads = 0;
  async function* source() { reads++; yield Buffer.from("abc"); }
  await assert.rejects(storage.stage(f.grant, metadata, source()), /denied/);
  assert.equal(reads, 0); assert.equal(f.connections(), 0);
  assert.deepEqual(await fs.readdir(f.rootPath), []);
  assert.equal(f.admissions.admit(f.binding), null);
});
test("strict accounting/root/physical receipt produce one durable file and opaque staged receipt", async t => {
  const f = await fixture(t), p = physicalFixture();
  const storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const result = await storage.stage(f.grant, metadata, bytes());
  assert.equal((await fs.readFile(join(f.rootPath, result.file.storageKey, "blob"))).toString(), "abc");
  assert.equal(result.file.size, 3);
  assert.equal(result.file.sha256, createHash("sha256").update("abc").digest("hex"));
  const request = p.requests[0];
  assert.equal(request.grant, f.grant); assert.equal(request.root, f.root);
  assert.equal(request.pin, f.pin); assert.equal(request.limit, 8); assert.equal(request.clientMessageId, "msg_1");
  assert.equal(request.attemptId, f.inserts[0][0]); assert.equal(request.operationId, f.inserts[0][8]);
  assert.equal(request.storageKey, result.file.storageKey); assert.ok(Object.isFrozen(request));
  assert.equal(storage.resolve(f.grant, result), result.file);
  assert.equal(storage.resolve({ ...f.grant }, result), null);
  assert.equal(storage.resolve(f.grant, { ...result }), null);
  await assert.rejects(new StrictFileStorage(f.admissions, f.bridge, p.provider).stage(f.grant, metadata, bytes()));
  assert.equal(f.connections(), 1); assert.equal(p.calls(), 1);
  assert.equal(f.admissions.admit(f.binding), null);
  p.revoke(); assert.equal(storage.resolve(f.grant, result), null);
  assert.equal((await fs.readdir(f.rootPath)).length, 1); // no refund or deletion
});
for (const commitTag of ["ROLLBACK", "lost"]) test("uncertain accounting " + commitTag + " never asks physical authority or reads body", async t => {
  const f = await fixture(t, async sql => { if (sql === "COMMIT" && commitTag === "lost") throw Error("lost ACK"); }, 8, commitTag);
  const p = physicalFixture(), storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  let reads = 0; async function* source() { reads++; yield Buffer.from("abc"); }
  await assert.rejects(storage.stage(f.grant, metadata, source()), /uncertain/);
  assert.equal(p.calls(), 0); assert.equal(reads, 0); assert.deepEqual(await fs.readdir(f.rootPath), []);
  assert.equal(f.admissions.admit(f.binding), null);
  await assert.rejects(storage.stage(f.grant, metadata, source()));
  assert.equal(f.connections(), 1);
});
test("forged physical receipt denies before body/root open", async t => {
  const f = await fixture(t), p = physicalFixture();
  const storage = new StrictFileStorage(f.admissions, f.bridge, {
    ...p.provider, authorize: async () => ({ syntheticTestOnly: true }),
  });
  let opened = 0, reads = 0;
  t.mock.method(fs, "open", async () => { opened++; throw Error("must not open"); });
  async function* source() { reads++; yield Buffer.from("abc"); }
  await assert.rejects(storage.stage(f.grant, metadata, source()), /physical/);
  assert.equal(opened, 0); assert.equal(reads, 0);
});
test("changed root inode denies before creation or body read", async t => {
  const f = await fixture(t), p = physicalFixture();
  const original = f.rootPath + "-original";
  await fs.rename(f.rootPath, original);
  t.after(() => fs.rm(original, { recursive: true, force: true }));
  await fs.mkdir(f.rootPath, { mode: 0o700 });
  let reads = 0; async function* source() { reads++; yield Buffer.from("abc"); }
  await assert.rejects(new StrictFileStorage(f.admissions, f.bridge, p.provider).stage(f.grant, metadata, source()), /root denied/);
  assert.equal(reads, 0); assert.deepEqual(await fs.readdir(f.rootPath), []);
});
test("pending physical decision retains admission; expiry denies later ACK with zero IO", async t => {
  const f = await fixture(t), p = physicalFixture();
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const pause = new Promise<void>(r => { release = r; }); t.after(() => release());
  const storage = new StrictFileStorage(f.admissions, f.bridge, {
    ...p.provider, authorize: async request => { enter(); await pause; return p.provider.authorize(request); },
  });
  let reads = 0, settled = false;
  async function* source() { reads++; yield Buffer.from("abc"); }
  const task = storage.stage(f.grant, metadata, source()).finally(() => { settled = true; });
  await entered; f.expire(); await new Promise(r => setImmediate(r));
  assert.equal(settled, false); assert.equal(f.admissions.admit(f.binding), null);
  assert.deepEqual(await fs.readdir(f.rootPath), []); release();
  await assert.rejects(task, /physical/); assert.equal(reads, 0);
  assert.deepEqual(await fs.readdir(f.rootPath), []);
});
test("metadata snapshot survives delayed authority and exact grant blocks parallel coordinator", async t => {
  const f = await fixture(t), p = physicalFixture(), mutable = { ...metadata };
  let release!: () => void, enter!: () => void;
  const pause = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { enter = r; }); t.after(() => release());
  const storage = new StrictFileStorage(f.admissions, f.bridge, {
    ...p.provider, authorize: async request => { enter(); await pause; return p.provider.authorize(request); },
  });
  const pending = storage.stage(f.grant, mutable, bytes());
  await entered; mutable.name = "changed"; mutable.clientMessageId = "changed";
  await assert.rejects(new StrictFileStorage(f.admissions, f.bridge, p.provider).stage(f.grant, metadata, bytes()));
  release(); const result = await pending;
  assert.equal(result.file.name, "file.txt"); assert.equal(p.requests[0].clientMessageId, "msg_1");
  assert.equal(f.connections(), 1);
});
test("physical revocation during pending file write waits for IO and keeps orphan liability", async t => {
  const f = await fixture(t), p = physicalFixture(), originalOpen = fs.open;
  let release!: () => void, enter!: () => void;
  const pause = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { enter = r; }); t.after(() => release());
  const handles: import("node:fs/promises").FileHandle[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const h = await originalOpen(...args); handles.push(h);
    if (handles.length === 3) {
      const write = h.write;
      t.mock.method(h, "write", async (...params: unknown[]) => {
        enter(); await pause; return Reflect.apply(write, h, params);
      });
    }
    return h;
  });
  let done = false, bodyReads = 0;
  async function* source() {
    bodyReads++; yield Buffer.from("abc");
    bodyReads++; yield Buffer.from("def");
  }
  const pending = new StrictFileStorage(f.admissions, f.bridge, p.provider)
    .stage(f.grant, metadata, source()).finally(() => { done = true; });
  await entered; p.revoke(); await new Promise(r => setImmediate(r));
  assert.equal(done, false); assert.equal(f.admissions.admit(f.binding), null);
  release(); await assert.rejects(pending, /physical/);
  assert.equal(bodyReads, 1, "revoked pending write must not pull another body chunk");
  assert.ok(handles.every(h => h.fd === -1));
  const dirs = await fs.readdir(f.rootPath); assert.equal(dirs.length, 1);
  assert.equal((await fs.readFile(join(f.rootPath, dirs[0], "blob"))).toString(), "abc");
});
test("oversize chunk never writes rejected bytes and never yields staged authority", async t => {
  const f = await fixture(t), p = physicalFixture();
  async function* tooLarge() { yield Buffer.alloc(9); }
  await assert.rejects(new StrictFileStorage(f.admissions, f.bridge, p.provider).stage(f.grant, metadata, tooLarge()), /denied/);
  const dirs = await fs.readdir(f.rootPath); assert.equal(dirs.length, 1);
  assert.equal((await fs.stat(join(f.rootPath, dirs[0], "blob"))).size, 0);
  assert.equal(f.admissions.admit(f.binding), null);
});

test("pre-parser session binds accounting and physical identity without touching filesystem", async t => {
  const f = await fixture(t), p = physicalFixture();
  const storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  let opened = 0;
  const original = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    opened++; return original(...args);
  });
  const session = await storage.authorize(f.grant, "before_headers");
  assert.ok(Object.isFrozen(session));
  assert.equal(storage.isAuthorized(f.grant, session), true);
  assert.equal(opened, 0); assert.deepEqual(await fs.readdir(f.rootPath), []);
  const request = p.requests[0];
  assert.equal(request.clientMessageId, "before_headers");
  assert.equal(request.grant, f.grant); assert.equal(request.root, f.root); assert.equal(request.pin, f.pin);
  assert.equal(request.limit, 8); assert.equal(request.attemptId, f.inserts[0][0]);
  assert.equal(request.operationId, f.inserts[0][8]);
  assert.equal(storage.resolve(f.grant, session as never), null, "authorization is not durable file proof");
  const result = await storage.stageAuthorized(f.grant, session, metadata, bytes());
  assert.equal(storage.resolve(f.grant, result), result.file);
  assert.equal(result.file.name, "file.txt");
  assert.equal(storage.isAuthorized(f.grant, session), false);
  await assert.rejects(storage.stageAuthorized(f.grant, session, metadata, bytes()), /session denied/);
  assert.equal(f.connections(), 1); assert.equal(p.calls(), 1);
});
test("pre-parser authorization without physical provider denies before accounting", async t => {
  const f = await fixture(t);
  const storage = new StrictFileStorage(f.admissions, f.bridge, null);
  await assert.rejects(storage.authorize(f.grant, "msg_1"), /denied/);
  assert.equal(f.connections(), 0);
  assert.deepEqual(await fs.readdir(f.rootPath), []);
});
test("copied session, foreign storage and foreign grant cannot consume authentic session", async t => {
  const f = await fixture(t), p = physicalFixture();
  const storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const foreign = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const session = await storage.authorize(f.grant, "msg_1");
  let reads = 0;
  async function* source() { reads++; yield Buffer.from("abc"); }
  await assert.rejects(storage.stageAuthorized(f.grant, { ...session }, metadata, source()));
  await assert.rejects(foreign.stageAuthorized(f.grant, session, metadata, source()));
  await assert.rejects(storage.stageAuthorized({ ...f.grant }, session, metadata, source()));
  assert.equal(reads, 0); assert.deepEqual(await fs.readdir(f.rootPath), []);
  assert.equal(storage.isAuthorized(f.grant, session), true);
  await storage.stageAuthorized(f.grant, session, metadata, source());
  assert.equal(reads, 1);
});
for (const reason of ["expiry", "physical revocation"]) test("session " + reason + " before metadata denies without IO", async t => {
  const f = await fixture(t), p = physicalFixture();
  const storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const session = await storage.authorize(f.grant, "msg_1");
  if (reason === "expiry") f.expire(); else p.revoke();
  let metadataReads = 0, reads = 0;
  const meta = { get name() { metadataReads++; return "file.txt"; }, mime: "text/plain" };
  async function* source() { reads++; yield Buffer.from("abc"); }
  assert.equal(storage.isAuthorized(f.grant, session), false);
  await assert.rejects(storage.stageAuthorized(f.grant, session, meta, source()), /session denied/);
  assert.equal(metadataReads, 0); assert.equal(reads, 0);
  assert.deepEqual(await fs.readdir(f.rootPath), []);
  assert.equal(f.admissions.admit(f.binding), null, "failure never releases admission");
});
test("invalid metadata burns session and cannot trigger reauthorization or filesystem effects", async t => {
  const f = await fixture(t), p = physicalFixture();
  const storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const session = await storage.authorize(f.grant, "msg_1");
  await assert.rejects(storage.stageAuthorized(f.grant, session, { name: "", mime: "" }, bytes()));
  assert.equal(storage.isAuthorized(f.grant, session), false);
  await assert.rejects(storage.stageAuthorized(f.grant, session, metadata, bytes()));
  await assert.rejects(new StrictFileStorage(f.admissions, f.bridge, p.provider).authorize(f.grant, "other"));
  assert.equal(f.connections(), 1); assert.equal(p.calls(), 1);
  assert.deepEqual(await fs.readdir(f.rootPath), []);
});
test("session is consumed synchronously before pending IO and rejects overlapping stage", async t => {
  const f = await fixture(t), p = physicalFixture();
  const storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const session = await storage.authorize(f.grant, "msg_1");
  let release!: () => void, enter!: () => void;
  const pause = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { enter = r; });
  t.after(() => release());
  async function* source() { enter(); await pause; yield Buffer.from("abc"); }
  const first = storage.stageAuthorized(f.grant, session, metadata, source());
  await entered;
  await assert.rejects(storage.stageAuthorized(f.grant, session, metadata, bytes()));
  assert.equal(f.admissions.admit(f.binding), null);
  release(); const result = await first;
  assert.equal(storage.resolve(f.grant, result), result.file);
  assert.equal((await fs.readdir(f.rootPath)).length, 1);
});

function multipart(body = "abc") {
  const wire = Buffer.from('--bound\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\nContent-Type: text/plain\r\n\r\n' + body + '\r\n--bound--\r\n');
  return { wire, framing: { boundary: "bound", contentLength: wire.length } };
}
test("multipart authorization denial touches neither framing getters nor request source", async t => {
  const f = await fixture(t), storage = new StrictFileStorage(f.admissions, f.bridge, null);
  const framing = { get boundary(): string { throw Error("framing touched"); }, contentLength: 100 };
  let reads = 0;
  await assert.rejects(storage.stageMultipart(f.grant, "msg_1",
    { chunks: { [Symbol.asyncIterator]() { reads++; throw Error("read"); } }, abort: async () => {} }, framing), /denied/);
  assert.equal(reads, 0); assert.equal(f.connections(), 0);
  assert.deepEqual(await fs.readdir(f.rootPath), []);
});
test("multipart serial storage yields exact durable file only after EOF and iterator closure", async t => {
  const f = await fixture(t), p = physicalFixture(), storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const { wire, framing } = multipart();
  let closed = false, index = 0;
  const result = await storage.stageMultipart(f.grant, "msg_1", {
    chunks: { [Symbol.asyncIterator]() { return {
      async next() { return index < wire.length ? { done: false as const, value: wire.subarray(index, ++index) } : { done: true as const, value: undefined }; },
      async return() { closed = true; return { done: true as const, value: undefined }; },
    }; } }, abort: async () => {},
  }, framing);
  assert.ok(closed); assert.equal(result.file.size, 3);
  assert.equal((await fs.readFile(join(f.rootPath, result.file.storageKey, "blob"))).toString(), "abc");
  assert.equal(storage.resolve(f.grant, result), result.file);
  assert.equal(f.admissions.admit(f.binding), null);
});
test("multipart session is consumed before first header read across concurrent callers", async t => {
  const f = await fixture(t), p = physicalFixture(), storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const session = await storage.authorize(f.grant, "msg_1"), { wire, framing } = multipart();
  let release!: () => void, enter!: () => void, reads = 0;
  const pause = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { enter = r; });
  t.after(() => release());
  async function* chunks() { reads++; enter(); await pause; yield wire; }
  const source = { chunks: chunks(), abort: async () => {} };
  const task = storage.stageMultipartAuthorized(f.grant, session, source, framing);
  await entered;
  await assert.rejects(storage.stageMultipartAuthorized(f.grant, session, source, framing), /session denied/);
  await assert.rejects(storage.stageAuthorized(f.grant, session, metadata, bytes()), /session denied/);
  assert.equal(reads, 1); release(); await task;
});
for (const mode of ["bad-trailer", "return-fails", "deadline-after-finish"] as const)
test("multipart " + mode + " never authorizes message dispatch or refunds retained file", async t => {
  const f = await fixture(t), p = physicalFixture(), storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  const { wire, framing } = multipart();
  const data = mode === "bad-trailer" ? Buffer.concat([wire, Buffer.from("x")]) : wire;
  let once = false, aborts = 0, dispatches = 0;
  const upload = new StrictMultipartUpload(storage, { async saveOnceWithOutcome() {
    dispatches++; throw Error("must not dispatch");
  } } as never);
  const outcome = await upload.saveWithOutcome(f.grant, "msg_1", {
    chunks: { [Symbol.asyncIterator]() { return {
      async next() { if (once) return { done: true as const, value: undefined }; once = true; return { done: false as const, value: data }; },
      async return() {
        if (mode === "return-fails") throw Error("closure failed");
        if (mode === "deadline-after-finish") await new Promise(r => setTimeout(r, 40));
        return { done: true as const, value: undefined };
      },
    }; } }, abort: async () => { aborts++; },
  }, { ...framing, contentLength: data.length }, mode === "deadline-after-finish" ? 20 : undefined);
  assert.equal(outcome.completed, false);
  if (!outcome.completed) assert.equal(outcome.commit, "not-dispatched");
  assert.equal(dispatches, 0); assert.equal(aborts, 1);
  assert.equal(f.admissions.admit(f.binding), null);
  assert.equal((await fs.readdir(f.rootPath)).length, 1);
  await assert.rejects(storage.stageMultipart(f.grant, "msg_1", { chunks: bytes(), abort: async () => {} }, framing));
});
test("multipart composition waits for message outcome and never hands out second dispatch result", async t => {
  const f = await fixture(t), p = physicalFixture(), storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  let enter!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(r => { enter = r; }), pause = new Promise<void>(r => { release = r; });
  t.after(() => release());
  const writer = { async saveOnceWithOutcome(grant: unknown, key: string, file: { size: number }) {
    assert.equal(grant, f.grant); assert.equal(key, "msg_1"); assert.equal(file.size, 3);
    calls++; enter(); await pause; throw Error("lost COMMIT ACK");
  } };
  const upload = new StrictMultipartUpload(storage, writer as never), { wire, framing } = multipart();
  async function* chunks() { yield wire; }
  const source = { chunks: chunks(), abort: async () => {} };
  const first = upload.saveWithOutcome(f.grant, "msg_1", source, framing);
  await entered; let secondSettled = false;
  const second = upload.saveWithOutcome(f.grant, "other_key", source, framing).then(r => { secondSettled = true; return r; });
  await new Promise(r => setImmediate(r)); assert.equal(secondSettled, false);
  release(); const outcome = await first;
  assert.equal(outcome.completed, false);
  if (!outcome.completed) assert.equal(outcome.commit, "unknown");
  assert.deepEqual(await second, { completed: true, result: { authorized: false } });
  assert.equal(calls, 1); assert.equal(f.admissions.admit(f.binding), null);
  assert.equal((await fs.readdir(f.rootPath)).length, 1);
});

for (const operation of ["write", "close"] as const)
test("multipart deadline during pending file " + operation + " retains admission and awaits IO", async t => {
  const f = await fixture(t), p = physicalFixture(), originalOpen = fs.open;
  const storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  let release!: () => void, enter!: () => void, aborted!: () => void;
  const pause = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { enter = r; });
  const abortSeen = new Promise<void>(r => { aborted = r; });
  t.after(() => release());
  const handles: import("node:fs/promises").FileHandle[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const h = await originalOpen(...args); handles.push(h);
    if (handles.length === 3) {
      const method = h[operation];
      t.mock.method(h, operation, async (...params: unknown[]) => {
        enter(); await pause; return Reflect.apply(method, h, params);
      });
    }
    return h;
  });
  const { wire, framing } = multipart();
  async function* chunks() { yield wire; }
  let settled = false;
  const task = storage.stageMultipart(f.grant, "msg_1",
    { chunks: chunks(), abort: async () => { aborted(); } }, framing, 100)
    .finally(() => { settled = true; });
  // Attach rejection handler before waiting for the deadline.
  const rejected = assert.rejects(task, /deadline/);
  await entered; await abortSeen;
  assert.equal(settled, false); assert.equal(f.admissions.admit(f.binding), null);
  release(); await rejected;
  assert.ok(handles.every(h => h.fd === -1));
  assert.equal((await fs.readdir(f.rootPath)).length, 1);
});
test("multipart completed insert is returned once, even across another upload coordinator", async t => {
  const f = await fixture(t), p = physicalFixture(), storage = new StrictFileStorage(f.admissions, f.bridge, p.provider);
  let calls = 0;
  const expected = { completed: true, result: { authorized: true, inserted: true, message: { id: 7 } } };
  const writer = { async saveOnceWithOutcome() { calls++; return expected; } } as never;
  const upload = new StrictMultipartUpload(storage, writer), { wire, framing } = multipart();
  async function* chunks() { yield wire; }
  const source = () => ({ chunks: chunks(), abort: async () => {} });
  assert.equal(await upload.saveWithOutcome(f.grant, "msg_1", source(), framing), expected);
  assert.deepEqual(await upload.saveWithOutcome(f.grant, "msg_1", source(), framing),
    { completed: true, result: { authorized: false } });
  const other = await new StrictMultipartUpload(storage, writer).saveWithOutcome(f.grant, "msg_1", source(), framing);
  assert.equal(other.completed, false); assert.equal(calls, 1);
});
