import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createBrowserResumeController } from "../src/lib/browser-resume-controller";
import { createBrowserInlineReceiptAdapter } from "../src/lib/browser-inline-receipt";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeBindings, type ResumeBinding } from "../src/lib/resume-bindings";
import { ResumeOperationGate, ResumeUploadOperationGate } from "../src/lib/resume-operation";
import { ResumeHistoryReader } from "../src/lib/resume-history";
import { ResumeMessageWriter } from "../src/lib/resume-message";
import { ResumeImageWriter } from "../src/lib/resume-image";
import { ResumeFileWriter } from "../src/lib/resume-file";
import { ResumeUploadAdmissions } from "../src/lib/resume-upload-admission";

// Called ONLY by the explicit isolated-DB fixture after its migrations.
// Real database CAS/receipts, not public browser/Socket.IO/storage acceptance.
export async function checkBrowserResumeCore(database: PoolClient, operationPool: Pool) {
  await database.query("INSERT INTO rooms (id) VALUES ('core333')");
  const store = new ResumeStore(database), bindings = new ResumeBindings();
  const gate = new ResumeOperationGate(operationPool, bindings);
  const admissions = new ResumeUploadAdmissions(bindings);
  const files = new ResumeFileWriter(new ResumeUploadOperationGate(operationPool, admissions));
  const text = "browser resume database proof", image = "data:image/png;base64,YQ==";
  const file = { storageKey: "a".repeat(64), sha256: "b".repeat(64), name: "proof.txt", size: 1, mime: "text/plain" };
  let checks = 0;
  const check = (value: unknown) => { assert.ok(value); checks++; };
  for (const kind of ["message", "image", "file"] as const) {
    const c = createBrowserResumeController();
    const first = {}, join = c.beginJoin("core333", "browser-core", first);
    const issued = await store.issueAfterAuthenticatedJoin("core333", "browser-core", 1);
    assert(issued);
    const credential = { roomId: issued.roomId, sessionId: issued.sessionId, token: issued.token };
    const transport1 = randomUUID();
    const identity = await store.advanceGeneration(credential, 0, join.operationId, transport1);
    assert(identity);
    const initial = await bindings.activate(identity, transport1, async () => {}, () => true);
    assert(initial);
    const envelope = { ...credential, username: identity.username,
      generation: identity.generation, expiresAt: identity.expiresAt.getTime() };
    const joinSync = c.accept(join, first, envelope);
    check(Array.isArray(await new ResumeHistoryReader(gate).read(initial)));
    c.finishSync(first, 1, joinSync);
    const payload = kind === "message" ? [text] : kind === "image" ? [image] :
      [file.name, file.size, file.mime, file.sha256];
    const payloadHash = createHash("sha256").update(JSON.stringify(["core333", "browser-core", kind, ...payload])).digest("hex");
    const operation = c.beginOperation(kind, payloadHash);
    c.dispatch(operation, first);
    const save = async (binding: ResumeBinding) => {
      if (kind === "message") {
        const result = await new ResumeMessageWriter(gate).saveOnceWithOutcome(binding, operation.clientMessageId, text);
        assert(result.authorized); return result.value;
      }
      if (kind === "image") {
        const result = await new ResumeImageWriter(gate).saveOnceWithOutcome(binding, operation.clientMessageId, image);
        assert(result.authorized); return result.value;
      }
      const grant = admissions.admit(binding); assert(grant);
      try {
        const result = await files.saveOnceWithOutcome(grant, operation.clientMessageId, file);
        assert(result.completed && result.result.authorized); return result.result.value;
      } finally { admissions.release(grant); }
    };
    const saved = await save(initial);
    check(saved.inserted);
    // Deliberately withhold receipt from controller; database has committed.
    c.disconnect(first); bindings.detach(initial);
    const second = {}, resume = c.beginResume(second), transport2 = randomUUID();
    const successor = await store.advanceGeneration(credential, resume.expectedGeneration, resume.operationId, transport2);
    assert(successor);
    const binding = await bindings.activate(successor, transport2, async () => {}, () => true);
    assert(binding);
    const resumeSync = c.accept(resume, second, { ...envelope, generation: successor.generation });
    const history = await new ResumeHistoryReader(gate).read(binding);
    check(history?.some(value => (value as { id: number }).id === saved.message.id));
    c.finishSync(second, 2, resumeSync);
    check(c.dispatch(operation, second).clientMessageId === operation.clientMessageId);
    const retried = await save(binding);
    check(!retried.inserted && retried.message.id === saved.message.id);
    const rows = await database.query("SELECT payload_hash, message_id FROM resume_message_receipts WHERE session_id=$1 AND client_message_id=$2",
      [credential.sessionId, operation.clientMessageId]);
    check(rows.rows.length === 1 && rows.rows[0].payload_hash === payloadHash);
    if (kind === "file") {
      // DB-only file proof: current HTTP projection omits the persisted byte hash.
      check(c.reconcile(operation, second, { ...operation, sessionId: credential.sessionId,
        payloadHash: rows.rows[0].payload_hash, messageId: rows.rows[0].message_id }) === saved.message.id);
    } else {
      const adapter = createBrowserInlineReceiptAdapter(c, operation, second, kind === "message" ? text : image);
      // Exact ResumeSendReply shape with actual DB-returned content, no invented
      // session/hash fields. Network authentication remains a separate gate.
      check(await adapter.accept({ clientMessageId: operation.clientMessageId, message: retried.message }) === saved.message.id);
    }
    check(c.status().pending === 0);
    // A CAS did commit but its ACK was lost on a DIFFERENT physical transport.
    c.disconnect(second); bindings.detach(binding);
    const third = {}, uncertain = c.beginResume(third);
    const advanced = await store.advanceGeneration(credential, 2, uncertain.operationId, randomUUID());
    check(advanced?.generation === 3);
    c.disconnect(third);
    assert.throws(() => c.beginResume({}), /reconciliation/); checks++;
    check((await store.lookup(credential))?.generation === 3);
  }
  console.log(JSON.stringify({ suite: "browser-resume-core-postgresql", checks, result: "PASS",
    scope: "real CAS/history/text-image-file DB receipts after withheld ACK; no public protocol, actual file bytes or reload durability" }));
  return checks;
}
