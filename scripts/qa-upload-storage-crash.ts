import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { ResumeStore } from "../src/lib/resume-store";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeUploadAdmissions } from "../src/lib/resume-upload-admission";
import { ResumeUploadReservations } from "../src/lib/resume-upload-reservation";
import { ResumeFileStorage } from "../src/lib/resume-file-storage";
import { ResumeFileWriter } from "../src/lib/resume-file";
import { ResumeFileUpload } from "../src/lib/resume-file-upload";
import { ResumeUploadOperationGate } from "../src/lib/resume-operation";

// Isolated fixture only: kills application workers, NEVER PostgreSQL.
// Recovery is read-only inventory, NOT replay, deletion, refund or activation.
const bytes = Buffer.from("durable bytes before worker crash");
const ceiling = 1024;
async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  if (!connectionString) throw Error("RESUME_TEST_DATABASE_URL required (isolated DB only)");
  const schema = process.argv[2] || "storage_crash_qa_" + randomBytes(8).toString("hex");
  assert.match(schema, /^storage_crash_qa_[0-9a-f]{16}$/);
  const pool = new Pool({ connectionString, options: "-c search_path=" + schema });
  if (process.argv[2]) {
    const root = process.argv[3], mode = process.argv[4];
    assert.ok(mode === "staged" || mode === "lost-ack");
    const store = new ResumeStore(pool);
    const session = await store.issueAfterAuthenticatedJoin("files123", "Uploader", 1);
    assert.ok(session);
    const sessionId = session.sessionId;
    const transport = "crash_" + session.sessionId;
    const identity = await store.advanceGeneration({ roomId: session.roomId, sessionId: session.sessionId,
      token: session.token }, 0, "crash_operation_12345", transport);
    assert.ok(identity);
    const bindings = new ResumeBindings();
    const binding = await bindings.activate(identity, transport, async () => {}, () => true);
    assert.ok(binding);
    const admissions = new ResumeUploadAdmissions(bindings, undefined, ceiling);
    const grant = admissions.admit(binding); assert.ok(grant);
    const clientMessageId = "crash_" + mode;
    let storageKey = "";
    class ObservedStorage extends ResumeFileStorage {
      override async stage(...args: Parameters<ResumeFileStorage["stage"]>) {
        const staged = await super.stage(...args);
        storageKey = staged.file.storageKey;
        if (mode === "staged") {
          process.send!({ mode, storageKey, sessionId, clientMessageId });
          // All file/directory/root fsyncs and closes have succeeded. The
          // composition has not reached the file receipt writer.
          await new Promise<never>(() => {});
        }
        return staged;
      }
    }
    const gate = new ResumeUploadOperationGate({ connect: async () => {
      const real = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        const result = await real.query(sql, values);
        if (sql === "COMMIT") throw Error("controlled file COMMIT acknowledgement loss");
        return result;
      }, release: real.release.bind(real) } as unknown as PoolClient;
    } }, admissions);
    const upload = new ResumeFileUpload(new ObservedStorage(root, admissions,
      new ResumeUploadReservations(pool)), new ResumeFileWriter(gate));
    async function* source() { yield bytes; }
    const result = await upload.saveWithOutcome(grant, clientMessageId,
      { name: "crash.txt", mime: "text/plain" }, source());
    assert.ok(mode === "lost-ack" && !result.completed && result.commit === "unknown");
    process.send!({ mode, storageKey, sessionId: session.sessionId, clientMessageId, commit: "unknown" });
    setInterval(() => {}, 1000);
    return;
  }
  const admin = new Pool({ connectionString });
  const root = await mkdtemp(join(tmpdir(), "dimle-storage-crash-"));
  let checks = 0;
  const check = (value: unknown) => { assert.ok(value); checks++; };
  const evidence: unknown[] = [];
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"');
    await pool.query((await readFile("drizzle/0000_thin_stardust.sql", "utf8"))
      .replaceAll('"public"."rooms"', '"' + schema + '"."rooms"'));
    await pool.query("ALTER TABLE rooms ADD COLUMN creation_token_hash text");
    for (const file of ["0003_spotty_zombie", "0004_long_nighthawk", "0005_free_blazing_skull",
      "0006_cold_zuras", "0007_motionless_wolfpack", "0008_dark_grim_reaper"]) {
      await pool.query((await readFile("drizzle/" + file + ".sql", "utf8"))
        .replaceAll('"public".', '"' + schema + '".'));
    }
    await pool.query("INSERT INTO rooms (id) VALUES ('files123')");
    await pool.query("INSERT INTO resume_upload_budget VALUES (1, $1, 0)", [ceiling * 2]);
    let expectedCharge = 0;
    for (const mode of ["staged", "lost-ack"]) {
      const child = fork(process.argv[1], [schema, root, mode],
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
      try {
        const [message] = await once(child, "message", { signal: AbortSignal.timeout(15000) });
        check(message.mode === mode && /^[0-9a-f]{64}$/.test(message.storageKey));
        const exited = once(child, "exit");
        check(child.kill("SIGKILL"));
        const [, signal] = await exited;
        check(signal === "SIGKILL");
        expectedCharge += ceiling;
        // Entirely fresh DB pool and filesystem reads after the worker is dead.
        const restarted = new Pool({ connectionString, options: "-c search_path=" + schema });
        try {
          await restarted.query("BEGIN READ ONLY");
          const charge = (await restarted.query("SELECT * FROM resume_upload_budget")).rows[0];
          check(Number(charge.reserved_bytes) === expectedCharge && Number(charge.capacity_bytes) === ceiling * 2);
          const attempts = (await restarted.query("SELECT * FROM resume_upload_attempts ORDER BY storage_key")).rows;
          const attempt = attempts.find(a => a.storage_key === message.storageKey);
          check(attempt?.session_id === message.sessionId && attempt.room_id === "files123");
          check(attempt.client_message_id === message.clientMessageId && Number(attempt.reserved_bytes) === ceiling);
          const names = (await readdir(root)).sort();
          check(JSON.stringify(names) === JSON.stringify(attempts.map(a => a.storage_key)));
          for (const name of names) {
            const data = await readFile(join(root, name, "blob"));
            check(data.equals(bytes));
            check((await stat(join(root, name, "blob"))).size <= ceiling);
            check((await readdir(join(root, name))).join() === "blob");
          }
          const receipts = (await restarted.query(`SELECT r.client_message_id, r.session_id, m.content
            FROM resume_message_receipts r JOIN messages m ON m.id=r.message_id`)).rows;
          check(receipts.length === (mode === "staged" ? 0 : 1));
          check(Number((await restarted.query("SELECT count(*) FROM messages")).rows[0].count) === receipts.length);
          const referenced = new Set(receipts.map(r => JSON.parse(r.content).url.split("/")[2]));
          const orphans = attempts.filter(a => !referenced.has(a.storage_key));
          check(orphans.length === 1 && orphans[0].client_message_id === "crash_staged");
          if (mode === "lost-ack") {
            const receipt = receipts[0], file = JSON.parse(receipt.content);
            check(message.commit === "unknown" && receipt.session_id === message.sessionId &&
              receipt.client_message_id === message.clientMessageId);
            check(file.url === "/uploads/" + message.storageKey + "/blob" && file.size === bytes.length);
            check(file.sha256 === createHash("sha256").update(bytes).digest("hex"));
          }
          // Inventory itself cannot refund, reclaim or modify provenance.
          check(Number((await restarted.query("SELECT reserved_bytes FROM resume_upload_budget")).rows[0].reserved_bytes) === expectedCharge);
          await restarted.query("COMMIT");
          evidence.push({ mode, signal, reservedBytes: expectedCharge, files: names.length,
            receipts: receipts.length, orphanAttempts: orphans.length, readOnlyRecovery: true });
        } finally { await restarted.end(); }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
        }
      }
    }
    console.log(JSON.stringify({ passed: checks, evidence,
      limitations: "Worker crash only; no PostgreSQL/power-loss, disk-quota, public HTTP or backup proof" }));
  } finally {
    await pool.end();
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE');
    await admin.end();
    await rm(root, { recursive: true, force: true }); // This harness owns this fixture only.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
