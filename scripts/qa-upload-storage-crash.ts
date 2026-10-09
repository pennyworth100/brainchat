import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, mkdir } from "node:fs/promises";
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
import { inventoryUploadLedger } from "../src/lib/resume-ledger-inventory";

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
        const recoveryPool = new Pool({ connectionString, options: "-c search_path=" + schema });
        const restarted = await recoveryPool.connect();
        try {
          await restarted.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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
          const unreferenced = attempts.filter(a => !referenced.has(a.storage_key));
          check(unreferenced.length === 1 && unreferenced[0].client_message_id === "crash_staged");
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
            receipts: receipts.length, unreferencedAtObservation: unreferenced.length, readOnlyInventory: true });
        } finally { restarted.release(true); await recoveryPool.end(); }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
        }
      }
    }
    // Adversarial FIXTURE mutations below are not reconciliation operations.
    // A future collector must observe these states without repairing them.
    const committed = (await pool.query(`SELECT a.*, r.message_id FROM resume_upload_attempts a
      JOIN resume_message_receipts r USING (session_id, client_message_id)`)).rows[0];
    check(!!committed && committed.message_id !== null);
    const snapshot = async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        check((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on");
        const attempts = (await client.query("SELECT * FROM resume_upload_attempts ORDER BY storage_key")).rows;
        // Preserve tombstones and independently inventory file messages: receipts
        // cascade on session expiry, but messages and attempt provenance survive.
        const receipts = (await client.query(`SELECT r.*, m.content FROM resume_message_receipts r
          LEFT JOIN messages m ON m.id=r.message_id`)).rows;
        const messages = (await client.query("SELECT id, room_id, content FROM messages WHERE type='file'")).rows;
        const budget = (await client.query("SELECT reserved_bytes FROM resume_upload_budget")).rows[0];
        await client.query("COMMIT");
        return { attempts, receipts, messages, charged: Number(budget.reserved_bytes) };
      } finally { client.release(true); }
    };
    const baseline = await snapshot();
    check(baseline.attempts.length === 2 && baseline.receipts.length === 1 && baseline.messages.length === 1);
    const missingPath = join(root, committed.storage_key, "blob");
    await rm(missingPath); // Deliberate corruption of this harness-owned fixture.
    await assert.rejects(stat(missingPath), { code: "ENOENT" }); checks++;
    const missing = await snapshot();
    check(missing.messages[0].id === committed.message_id && missing.receipts.length === 1);
    check(missing.charged === ceiling * 2);
    evidence.push({ case: "missing-blob", classification: "referenced-blob-missing", charged: missing.charged });

    const unknownKey = randomBytes(32).toString("hex");
    await mkdir(join(root, unknownKey)); // Even a syntactically valid key proves no ownership.
    const unknown = await snapshot();
    check((await readdir(root)).includes(unknownKey));
    check(!unknown.attempts.some(a => a.storage_key === unknownKey));
    check(unknown.charged === ceiling * 2);
    evidence.push({ case: "unknown-directory", classification: "unattributed-path", charged: unknown.charged });

    // Conflicting references cannot be hidden by reducing paths to a Set.
    const duplicate = (await pool.query(`INSERT INTO messages (room_id, username, type, content)
      VALUES ('files123', 'Other', 'file', $1) RETURNING id`, [baseline.messages[0].content])).rows[0];
    const ambiguous = await snapshot();
    check(ambiguous.messages.length === 2 && ambiguous.receipts.length === 1);
    check(ambiguous.messages.every(m => JSON.parse(m.content).url === "/uploads/" + committed.storage_key + "/blob"));
    check(ambiguous.charged === ceiling * 2);
    evidence.push({ case: "duplicate-reference", classification: "ambiguous-provenance", charged: ambiguous.charged });
    await pool.query("DELETE FROM messages WHERE id=$1", [duplicate.id]);

    // Real ON DELETE SET NULL; observation uses a separate read-only transaction.
    await pool.query("DELETE FROM messages WHERE id=$1", [committed.message_id]);
    const tombstone = await snapshot();
    check(tombstone.receipts.length === 1 && tombstone.receipts[0].message_id === null &&
      tombstone.receipts[0].content === null);
    check(tombstone.messages.length === 0 && tombstone.attempts.length === 2);
    check(tombstone.charged === ceiling * 2);
    evidence.push({ case: "tombstone", classification: "logical-receipt-without-storage-reference", charged: tombstone.charged });

    // Restore the fixture message via explicit identity, then relink its receipt.
    // This is test setup, NEVER a permitted recovery/replay operation.
    await pool.query(`INSERT INTO messages (id, room_id, username, type, content)
      VALUES ($1, 'files123', 'Uploader', 'file', $2)`, [committed.message_id, baseline.messages[0].content]);
    await pool.query("UPDATE resume_message_receipts SET message_id=$1 WHERE session_id=$2",
      [committed.message_id, committed.session_id]);
    await pool.query("DELETE FROM room_resume_sessions WHERE id=$1", [committed.session_id]);
    const expired = await snapshot();
    check(expired.receipts.length === 0 && expired.messages.length === 1);
    check(expired.attempts.length === 2 && expired.attempts.some(a => a.storage_key === committed.storage_key));
    check(JSON.parse(expired.messages[0].content).url === "/uploads/" + committed.storage_key + "/blob");
    check(expired.charged === ceiling * 2);
    evidence.push({ case: "session-cascade", classification: "message-reference-without-retry-receipt", charged: expired.charged });
    const inventory = (maxRows = 10) => pool.connect().then(client => inventoryUploadLedger(client,
      { pageSize: 1, maxRows, timeoutMs: 2000 }));
    const full = await inventory();
    check(full.complete && full.accounting === "consistent");
    check(full.attempts.length === 2 && full.observedReservedBytes === "2048");
    check(full.attempts.some(a => a.session_id === committed.session_id));
    check(full.unobserved.join() === "receipts,messages,filesystem" && full.crossStoreStability === "unproven");
    const capped = await inventory(1);
    check(!capped.complete && capped.accounting === "unknown" && capped.reasons.includes("row-limit"));
    check(capped.attempts.length === 1 && capped.lastStorageKey === full.attempts[0].storage_key);
    const exact = await inventory(2);
    check(exact.complete && exact.accounting === "consistent");
    // Hold a fixture-only lock to force a genuine PostgreSQL statement deadline.
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE resume_upload_attempts IN ACCESS EXCLUSIVE MODE");
      const timed = await pool.connect().then(client => inventoryUploadLedger(client,
        { pageSize: 1, maxRows: 10, timeoutMs: 50 }));
      check(!timed.complete && timed.accounting === "unknown" && timed.reasons.includes("deadline"));
      check(timed.attempts.length === 0);
    } finally { await locker.query("ROLLBACK"); locker.release(); }
    await pool.query("UPDATE resume_upload_budget SET reserved_bytes=0");
    const mismatch = await inventory();
    check(mismatch.complete && mismatch.accounting === "inconsistent" && mismatch.reasons.includes("counter-sum-mismatch"));
    await pool.query("DELETE FROM resume_upload_budget");
    const absent = await inventory();
    check(absent.complete && absent.accounting === "inconsistent" && absent.reasons.includes("missing-budget"));
    check(absent.attempts.length === 2);
    await pool.query("INSERT INTO resume_upload_budget VALUES (1, $1, $1)", [ceiling * 2]);
    check((await inventory()).observedReservedBytes === "2048");
    evidence.push({ case: "private-ledger-collector", checks: 13, pagination: "full/capped/exact",
      deadline: "real-lock-wait", mismatch: "detected", missingBudget: "inconsistent", scope: "ledger-only" });
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
