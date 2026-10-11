import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ResumeBindings } from "./resume-bindings";
import { ResumeUploadAdmissions } from "./resume-upload-admission";
import { ResumeUploadOperationGate } from "./resume-operation";
import { canonicalResumeFile, ResumeFileWriter } from "./resume-file";

const file = { storageKey: "a".repeat(64), name: "report.pdf", size: 5,
  mime: "application/pdf", sha256: createHash("sha256").update("hello").digest("hex") };
test("file metadata is bounded and excludes client paths, malformed digests and headers", () => {
  assert.deepEqual(canonicalResumeFile(file), file);
  assert.ok(Object.isFrozen(canonicalResumeFile(file)));
  for (const change of [{ storageKey: "../x" }, { sha256: "fake" }, { size: -1 }, { size: NaN },
    { size: 0.5 }, { size: 100 * 1024 * 1024 + 1 }, { name: "x/y" }, { name: "x\\y" },
    { name: "\r\n" }, { name: " " }, { name: "x".repeat(256) }, { mime: "text/plain\r\nX: y" },
    { mime: "https://host" }, { mime: "x/" }, { mime: "text/plain\n" },
    { sha256: "c".repeat(64) + "\n" }, { storageKey: "a".repeat(64) + "\n" }]) {
    assert.throws(() => canonicalResumeFile({ ...file, ...change }), /Invalid/);
  }
  assert.equal(canonicalResumeFile({ ...file, size: 0 }).size, 0);
  assert.equal(canonicalResumeFile({ ...file, size: 100 * 1024 * 1024 }).size, 100 * 1024 * 1024);
});

for (const mode of ["insert", "replay-new-path", "lost-ack", "tombstone", "wrong-room", "wrong-user",
  "wrong-type", "bad-id", "bad-ts", "bad-url", "bad-json", "changed-digest", "extra-content",
  "conflict", "copied-grant", "policy-denied", "invalid-key", "invalid-file", "receipt-failure"]) {
  test("file receipt: " + mode, async () => {
    const bindings = new ResumeBindings();
    const binding = await bindings.activate({ sessionId: "fixture", roomId: "files123", username: "Guest",
      authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60000) },
      "transport_A_123456", async () => {}, () => true);
    assert.ok(binding);
    const admissions = new ResumeUploadAdmissions(bindings);
    const grant = admissions.admit(binding); assert.ok(grant);
    bindings.detach(binding); // admitted HTTP lifetime survives ordinary disconnect
    const stored = { url: `/uploads/${file.storageKey}/blob`, name: file.name, size: file.size,
      mime: file.mime, sha256: mode === "changed-digest" ? "b".repeat(64) : file.sha256 };
    if (mode === "bad-url") stored.url = "/uploads/../secret";
    const row = { id: mode === "tombstone" ? null : mode === "bad-id" ? -1 : 9,
      room_id: mode === "wrong-room" ? "other123" : "files123",
      username: mode === "wrong-user" ? "Other" : "Guest", type: mode === "wrong-type" ? "image" : "file",
      content: mode === "bad-json" ? "{broken" : JSON.stringify(mode === "extra-content" ? { ...stored, extra: 1 } : stored),
      ts: mode === "bad-ts" ? new Date(NaN) : new Date(1234),
      payload_hash: mode === "conflict" ? "other" : createHash("sha256").update(JSON.stringify([
        "files123", "Guest", "file", file.name, file.size, file.mime, file.sha256,
      ])).digest("hex") };
    let inserts = 0, lookups = 0, commits = 0, connects = 0;
    const writer = new ResumeFileWriter(new ResumeUploadOperationGate({ connect: async () => {
      connects++;
      const events = new EventEmitter();
      return { on: events.on.bind(events), removeListener: events.removeListener.bind(events), query: async (sql: string) => {
        if (sql.includes("SELECT r.payload_hash")) {
          lookups++; return { rows: ["insert", "lost-ack", "receipt-failure"].includes(mode) ? [] : [row] };
        }
        if (sql.startsWith("INSERT INTO messages")) { inserts++; return { rows: [row] }; }
        if (sql.startsWith("INSERT INTO resume_message_receipts") && mode === "receipt-failure") throw Error("receipt failure");
        if (sql === "COMMIT") { commits++; if (mode === "lost-ack") throw Error("lost ACK"); }
        return { rows: [], rowCount: mode === "policy-denied" ? 0 : 1 };
      }, release: () => {} } as unknown as PoolClient;
    } }, admissions));
    const result = await writer.saveOnceWithOutcome(mode === "copied-grant" ? { ...grant } : grant,
      mode === "invalid-key" ? "key\n" : "key", mode === "invalid-file" ? { ...file, size: -1 } :
        mode === "replay-new-path" ? { ...file, storageKey: "b".repeat(64) } : file);
    if (["insert", "replay-new-path"].includes(mode)) {
      assert.deepEqual(result, { completed: true, result: { authorized: true, value: {
        inserted: mode === "insert", message: { id: 9, type: "file", username: "Guest", ts: 1234,
          url: stored.url, name: file.name, size: file.size, mime: file.mime },
      } } });
      assert.equal(inserts, mode === "insert" ? 1 : 0); assert.equal(commits, 1);
    } else if (["copied-grant", "policy-denied"].includes(mode)) {
      assert.deepEqual(result, { completed: true, result: { authorized: false } });
      assert.equal(lookups, 0); assert.equal(inserts, 0);
      if (mode === "copied-grant") assert.equal(connects, 0);
    } else {
      assert.equal(result.completed, false);
      assert.ok(!result.completed && result.commit === (mode === "lost-ack" ? "unknown" : "not-dispatched"));
      assert.equal(commits, mode === "lost-ack" ? 1 : 0);
      assert.equal(inserts, ["lost-ack", "receipt-failure"].includes(mode) ? 1 : 0);
    }
    assert.equal(admissions.isCurrent(grant), true); // writer never releases lease
    admissions.release(grant);
  });
}
