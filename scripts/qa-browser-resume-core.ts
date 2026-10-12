import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import http from "node:http";
import { Server, type Socket as ServerSocket } from "socket.io";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { ResumeMemberships } from "../src/lib/resume-membership";
import { attachResumeSocket, type ResumeSocketOwner } from "../src/lib/resume-socket";
import { publishBrowserJoin, publishBrowserResume } from "../src/lib/resume-browser-handshake";
import type { BrowserLease } from "../src/lib/browser-resume-controller";
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
// Private Socket.IO credential handoff + real DB CAS; NOT public login/UI/storage acceptance.
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
  const server = http.createServer(), ioServer = new Server(server);
  const clients: ClientSocket[] = [], owners: ResumeSocketOwner[] = [];
  const members = new ResumeMemberships(bindings);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const connect = async () => {
    const accepted = new Promise<ServerSocket>(resolve => ioServer.once("connection", resolve));
    const client = io("http://127.0.0.1:" + (server.address() as { port: number }).port,
      { transports: ["websocket"], reconnection: false });
    clients.push(client);
    const socket = await accepted;
    const owner = attachResumeSocket(socket, { store, bindings, memberships: members,
      prepare: async () => async () => {}, issue: store.issueAfterAuthenticatedJoin.bind(store),
      onCleanupError: error => { throw error; } });
    owners.push(owner);
    return { client, socket, owner };
  };
  try {
  for (const kind of ["message", "image", "file"] as const) {
    const c = createBrowserResumeController();
    const one = await connect(), first = one.client;
    const join = c.beginJoin("core333", "browser-core", first);
    const joinedWire = new Promise<BrowserLease>(resolve => first.once("fixture-lease", resolve));
    check(await publishBrowserJoin(one.socket, one.owner, members,
      { roomId: "core333", username: "browser-core", authVersion: 1 },
      value => one.socket.emit("fixture-lease", value)));
    const envelope = await joinedWire;
    const credential = { roomId: envelope.roomId, sessionId: envelope.sessionId, token: envelope.token };
    const initial = members.currentBindingFor(one.socket, one.owner); assert(initial);
    check(members.legacyUploadBindingFor(one.socket, one.owner, "core333") === null);
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
    c.disconnect(first); await one.owner.close(); first.disconnect();
    const two = await connect(), second = two.client, resume = c.beginResume(second);
    const resumedWire = new Promise<BrowserLease>(resolve => second.once("fixture-lease", resolve));
    check(await publishBrowserResume(two.socket, two.owner, members,
      { credential, expectedGeneration: resume.expectedGeneration, operationId: resume.operationId },
      value => two.socket.emit("fixture-lease", value)));
    const binding = members.currentBindingFor(two.socket, two.owner); assert(binding);
    const resumeSync = c.accept(resume, second, await resumedWire);
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
    c.disconnect(second); await two.owner.close(); second.disconnect();
    const third = {}, uncertain = c.beginResume(third);
    const advanced = await store.advanceGeneration(credential, 2, uncertain.operationId, randomUUID());
    check(advanced?.generation === 3);
    c.disconnect(third);
    assert.throws(() => c.beginResume({}), /reconciliation/); checks++;
    check((await store.lookup(credential))?.generation === 3);
  }
  } finally {
    await Promise.all(owners.map(owner => owner.close()));
    clients.forEach(client => client.disconnect());
    await new Promise<void>(resolve => ioServer.close(() => resolve()));
  }
  console.log(JSON.stringify({ suite: "browser-resume-core-postgresql", checks, result: "PASS",
    scope: "private Socket.IO owner credential handoff, real CAS/history/DB retries; no public password login, rendered UI, file bytes or reload durability" }));
  return checks;
}
