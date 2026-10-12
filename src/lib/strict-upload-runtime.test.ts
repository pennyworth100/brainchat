import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { ResumeBindings } from "./resume-bindings";
import { ResumeCapacity } from "./resume-capacity";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { ResumeFileWriter } from "./resume-file";
import { ResumeUploadOperationGate } from "./resume-operation";
import { StrictFileStorage } from "./strict-file-storage";
import { StrictMultipartUpload } from "./strict-multipart-upload";
import { StrictUploadRuntime } from "./strict-upload-runtime";
import { ServerLifecycle } from "./server-lifecycle";

async function fixture(storage: StrictFileStorage | null = null) {
  const bindings = new ResumeBindings();
  const binding = await bindings.activate({ sessionId: "runtime", roomId: "files123", username: "Guest",
    authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
    "runtime_transport", async () => {}, () => true);
  assert.ok(binding);
  const admissions = new ResumeUploadAdmissions(bindings, new ResumeCapacity(1));
  const grant = admissions.admit(binding)!;
  const writer = new ResumeFileWriter(new ResumeUploadOperationGate({
    connect: async () => { throw Error("Unexpected DB checkout"); },
  }, admissions));
  return { admissions, binding, grant, runtime: new StrictUploadRuntime(admissions, storage, writer) };
}
const poison = new Proxy({}, { get() { throw Error("Request accessed"); } }) as IncomingMessage;
const request = () => ({ method: "POST", httpVersion: "1.1",
  headers: { "x-client-message-id": "key" },
  rawHeaders: ["Content-Type", "multipart/form-data; boundary=bound", "Content-Length", "123"],
}) as unknown as IncomingMessage;

test("unconfigured runtime denies with zero request access and releases only its exact grant", async () => {
  const f = await fixture();
  assert.deepEqual(await f.runtime.run(f.grant, poison), { status: "unavailable" });
  const successor = f.admissions.admit(f.binding); assert.ok(successor);
  assert.deepEqual(await f.runtime.run(f.grant, poison), { status: "denied" });
  assert.equal(f.admissions.isCurrent(successor), true);
  f.admissions.release(successor); await f.runtime.close();
});

test("invalid header/framing and copied grants never enter multipart composition", async t => {
  let calls = 0;
  t.mock.method(StrictMultipartUpload.prototype, "saveWithOutcome", async () => { calls++; throw Error("Unexpected parser"); });
  for (const mode of ["key", "framing", "copied"] as const) {
    const f = await fixture({} as StrictFileStorage), req = request();
    if (mode === "key") req.headers["x-client-message-id"] = "bad\n";
    if (mode === "framing") req.rawHeaders.push("Content-Length", "123");
    const g = mode === "copied" ? { ...f.grant } : f.grant;
    assert.equal((await f.runtime.run(g, mode === "copied" ? poison : req)).status,
      mode === "copied" ? "denied" : "invalid");
    if (mode === "copied") assert.equal(f.admissions.isCurrent(f.grant), true);
    f.admissions.release(f.grant); await f.runtime.close();
  }
  assert.equal(calls, 0);
});

test("shutdown and concurrent invocation retain actual pending persistence, not transport state", async t => {
  let finish!: () => void, enter!: () => void, calls = 0;
  const entered = new Promise<void>(r => { enter = r; });
  const blocked = new Promise<void>(r => { finish = r; });
  t.mock.method(StrictMultipartUpload.prototype, "saveWithOutcome", async () => {
    calls++; enter(); await blocked;
    return { completed: false, commit: "unknown", error: Error("lost COMMIT acknowledgement") };
  });
  const f = await fixture({} as StrictFileStorage);
  const lifecycle = new ServerLifecycle({ stopAndSettle: async () => {} }, { settle: async () => {} });
  lifecycle.own(f.runtime);
  const attempt = f.runtime.run(f.grant, request()); await entered;
  const duplicate = f.runtime.run(f.grant, poison);
  let settled = false;
  const stop = lifecycle.stopAndSettle().then(() => { settled = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false); assert.equal(f.admissions.admit(f.binding), null);
  finish();
  assert.equal((await attempt).status, "failed");
  assert.deepEqual(await duplicate, { status: "denied" }); await stop;
  assert.equal(calls, 1);
  const next = f.admissions.admit(f.binding); assert.ok(next);
  assert.deepEqual(await f.runtime.run(next, poison), { status: "unavailable" });
  assert.equal(f.admissions.isCurrent(next), false);
});

test("runtime preserves durable insert/replay and ambiguous outcome distinctions", async t => {
  for (const mode of ["insert", "replay", "denied", "precommit", "unknown", "throw"] as const) {
    const value = { inserted: mode === "insert", message: { id: 1, type: "file" as const,
      username: "Guest", ts: 1, url: "/uploads/" + "a".repeat(64) + "/blob",
      name: "file.txt", size: 3, mime: "text/plain" } };
    const mock = t.mock.method(StrictMultipartUpload.prototype, "saveWithOutcome", async () => {
      if (mode === "throw") throw Error("unexpected");
      if (mode === "unknown" || mode === "precommit") return {
        completed: false, commit: mode === "unknown" ? "unknown" : "not-dispatched", error: Error(mode) };
      return { completed: true, result: mode === "denied" ? { authorized: false } :
        { authorized: true, value } };
    });
    const f = await fixture({} as StrictFileStorage);
    const result = await f.runtime.run(f.grant, request());
    if (mode === "insert" || mode === "replay") assert.deepEqual(result, { status: "saved", clientMessageId: "key", value });
    else if (mode === "denied") assert.deepEqual(result, { status: "denied" });
    else assert.ok(result.status === "failed" && result.commit === (mode === "precommit" ? "not-dispatched" : "unknown"));
    assert.equal(f.admissions.isCurrent(f.grant), false);
    assert.deepEqual(await f.runtime.run(f.grant, poison), { status: "denied" },
      "the same admitted attempt cannot hand a second publisher a successful insert receipt");
    await f.runtime.close(); mock.mock.restore();
  }
});

test("strict saved receipt retains the operation key captured before asynchronous persistence", async t => {
  const req = request();
  const value = { inserted: true, message: { id: 1, type: "file" as const,
    username: "Guest", ts: 1, url: "/uploads/" + "a".repeat(64) + "/blob",
    name: "file.txt", size: 3, mime: "text/plain" } };
  t.mock.method(StrictMultipartUpload.prototype, "saveWithOutcome", async (_grant: Parameters<StrictMultipartUpload["saveWithOutcome"]>[0], key: string) => {
    assert.equal(key, "key");
    req.headers["x-client-message-id"] = "changed";
    await new Promise(r => setImmediate(r));
    return { completed: true, result: { authorized: true, value } };
  });
  const f = await fixture({} as StrictFileStorage);
  assert.deepEqual(await f.runtime.run(f.grant, req), { status: "saved", clientMessageId: "key", value });
  await f.runtime.close();
});
