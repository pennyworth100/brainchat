import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { ResumeUploadOperationGate } from "./resume-operation";

for (const mode of ["disconnect", "copied", "released", "deadline", "deadline-during-work",
  "bytes", "successor", "work-fails", "commit-lost", "commit-sync", "durable-denied"] as const) {
  test(`upload durable gate: ${mode}`, async () => {
    const bindings = new ResumeBindings();
    const identity = { sessionId: "upload", roomId: "files123", username: "Guest",
      authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
    const binding = await bindings.activate(identity, "transport_upload_1", async () => {}, () => true);
    assert.ok(binding);
    let now = 0;
    const admissions = new ResumeUploadAdmissions(bindings, undefined, 10, 100, () => now);
    const grant = admissions.admit(binding)!;
    let calls = 0, connects = 0;
    const commands: string[] = [];
    const client = { query: (sql: string) => {
      commands.push(sql);
      if (sql === "COMMIT" && mode === "commit-sync") throw Error("sync");
      if (sql === "COMMIT" && mode === "commit-lost") return Promise.reject(Error("lost ack"));
      return Promise.resolve({ rowCount: mode === "durable-denied" ? 0 : 1 });
    }, release: () => {} } as unknown as PoolClient;
    const gate = new ResumeUploadOperationGate({ connect: async () => { connects++; return client; } }, admissions);
    if (mode === "released") admissions.release(grant);
    if (mode === "deadline") now = 100;
    if (mode === "bytes") admissions.acceptChunk(grant, 11);
    bindings.detach(binding);
    const outcome = await gate.runWithOutcome(mode === "copied" ? { ...grant } : grant, async tx => {
      calls++;
      await tx.query("INSERT fixture");
      if (mode === "deadline-during-work") now = 100;
      if (mode === "successor") {
        await assert.rejects(bindings.activate({ ...identity, generation: 2 },
          "transport_upload_2", async () => { throw Error("prepare failed"); }, () => true));
      }
      if (mode === "work-fails") throw Error("work failed");
      return "receipt";
    });
    if (mode === "disconnect") {
      assert.deepEqual(outcome, { completed: true, result: { authorized: true, value: "receipt" } });
      assert.equal(admissions.isCurrent(grant), true);
    } else if (["work-fails", "commit-lost", "commit-sync"].includes(mode)) {
      assert.ok(!outcome.completed);
      assert.equal(outcome.commit, mode === "work-fails" ? "not-dispatched" : "unknown");
    } else {
      assert.deepEqual(outcome, { completed: true, result: { authorized: false } });
      assert.ok(!commands.includes("COMMIT"));
    }
    if (["copied", "released", "deadline", "bytes"].includes(mode)) {
      assert.equal(connects, 0); assert.equal(calls, 0);
    }
    // Gate never releases the lease, including denial or lost ACK.
    assert.equal(admissions.admit(binding), null);
    assert.equal(admissions.release(grant), mode !== "released");
  });
}


test("pending upload COMMIT stays unsettled and retains capacity past deadline", async () => {
  const bindings = new ResumeBindings();
  const binding = await bindings.activate({ sessionId: "pending", roomId: "files123", username: "Guest",
    authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  }, "transport_upload_pending", async () => {}, () => true);
  assert.ok(binding);
  let now = 0;
  const admissions = new ResumeUploadAdmissions(bindings, undefined, 10, 100, () => now);
  const grant = admissions.admit(binding)!;
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const commit = new Promise<void>(resolve => { finish = resolve; });
  const client = { query: async (sql: string) => {
    if (sql === "COMMIT") { entered(); await commit; }
    return { rowCount: 1 };
  }, release: () => {} } as unknown as PoolClient;
  let settled = false;
  const pending = new ResumeUploadOperationGate({ connect: async () => client }, admissions)
    .runWithOutcome(grant, async () => "receipt").then(value => { settled = true; return value; });
  await started;
  now = 100;
  assert.equal(admissions.isCurrent(grant), false);
  assert.equal(admissions.admit(binding), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish();
  assert.deepEqual(await pending, { completed: true, result: { authorized: true, value: "receipt" } });
  assert.equal(admissions.admit(binding), null);
  assert.equal(admissions.release(grant), true);
});
