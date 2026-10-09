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
import { inventoryUploadLedger, inventoryUploadDatabase } from "../src/lib/resume-ledger-inventory";

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
    const databaseInventory = (maxRows = 10) => pool.connect().then(client => inventoryUploadDatabase(client,
      { pageSize: 1, maxRows, timeoutMs: 2000 }));
    const initialDb = await databaseInventory();
    check(initialDb.complete && initialDb.references?.complete && initialDb.references.parseComplete);
    check(initialDb.scope === "database-only" && initialDb.unobserved.join() === "filesystem");
    check(initialDb.references?.receipts[0].storageKey === committed.storage_key);
    check(initialDb.references?.messages[0].messageId === committed.message_id);
    check(initialDb.references?.metadataComplete && initialDb.references.messages[0].metadataStatus === "valid");
    const initialFacts = initialDb.referenceFacts?.keys.find(k => k.storageKey === committed.storage_key);
    check(initialFacts?.messages === 1 && initialFacts.receipts === 1 && initialFacts.attempts === 1);
    check(initialFacts?.roomConflicts === 0 && initialFacts.receiptIdentityConflicts === 0);
    check(initialDb.referenceFacts?.fullIdentity === "unobserved");
    // Same canonical URL, conflicting durable provenance: observe, never repair.
    await pool.query("UPDATE resume_upload_attempts SET room_id='other123', client_message_id='other' WHERE storage_key=$1", [committed.storage_key]);
    const conflictDb = await databaseInventory();
    const conflictFacts = conflictDb.referenceFacts?.keys.find(k => k.storageKey === committed.storage_key);
    check(conflictFacts?.roomConflicts === 2 && conflictFacts.receiptIdentityConflicts === 1);
    check(conflictDb.complete && conflictDb.accounting === "consistent"); // arithmetic is not identity
    await pool.query("UPDATE resume_upload_attempts SET room_id=$2, client_message_id=$3 WHERE storage_key=$1",
      [committed.storage_key, committed.room_id, committed.client_message_id]);
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
    const ambiguousDb = await databaseInventory();
    check(ambiguousDb.references?.messages.length === 2 && ambiguousDb.references.receipts.length === 1);
    check(ambiguousDb.references?.messages.every(m => m.storageKey === committed.storage_key));
    const duplicateFacts = ambiguousDb.referenceFacts?.keys.find(k => k.storageKey === committed.storage_key);
    check(duplicateFacts?.multipleMessages && !duplicateFacts.multipleReceipts);
    check(ambiguous.messages.length === 2 && ambiguous.receipts.length === 1);
    check(ambiguous.messages.every(m => JSON.parse(m.content).url === "/uploads/" + committed.storage_key + "/blob"));
    check(ambiguous.charged === ceiling * 2);
    evidence.push({ case: "duplicate-reference", classification: "ambiguous-provenance", charged: ambiguous.charged });
    await pool.query("DELETE FROM messages WHERE id=$1", [duplicate.id]);

    // Real ON DELETE SET NULL; observation uses a separate read-only transaction.
    await pool.query("DELETE FROM messages WHERE id=$1", [committed.message_id]);
    const tombstone = await snapshot();
    const tombstoneDb = await databaseInventory();
    check(tombstoneDb.references?.receipts[0].status === "tombstone" && tombstoneDb.references.receipts[0].messageId === null);
    check(tombstoneDb.references?.messages.length === 0 && tombstoneDb.references.complete);
    check(tombstoneDb.referenceFacts?.keys.find(k => k.storageKey === committed.storage_key)?.receipts === 0);
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
    const expiredDb = await databaseInventory();
    check(expiredDb.references?.receipts.length === 0 && expiredDb.references.messages.length === 1);
    check(expiredDb.references?.messages[0].storageKey === committed.storage_key);
    const expiredFacts = expiredDb.referenceFacts?.keys.find(k => k.storageKey === committed.storage_key);
    check(expiredFacts?.messages === 1 && expiredFacts.receipts === 0 && expiredFacts.attempts === 1);
    // A mutation AFTER the ledger snapshot but BEFORE reference SQL must not
    // appear in the reference inventory. One reset, one pinned DB snapshot.
    const pinnedClient = await pool.connect();
    const originalQuery = pinnedClient.query.bind(pinnedClient);
    let injectedId = 0, resets = 0;
    pinnedClient.query = (async (config: { text: string }) => {
      if (config.text === "ROLLBACK") resets++;
      if (config.text.startsWith("DECLARE reference_receipts")) {
        injectedId = (await pool.query(`INSERT INTO messages (room_id,username,type,content)
          VALUES ('files123','Concurrent','file',$1) RETURNING id`, [baseline.messages[0].content])).rows[0].id;
      }
      return originalQuery(config);
    }) as typeof pinnedClient.query;
    const pinned = await inventoryUploadDatabase(pinnedClient, { pageSize: 1, maxRows: 10, timeoutMs: 2000 });
    check(pinned.complete && pinned.references?.messages.length === 1 && resets === 2);
    check(!pinned.references?.messages.some(m => m.messageId === injectedId));
    check((await databaseInventory()).references?.messages.some(m => m.messageId === injectedId));
    await pool.query("DELETE FROM messages WHERE id=$1", [injectedId]);
    // SQL must suppress oversized bodies BEFORE driver transfer/JSON parsing.
    const invalidIds: number[] = [];
    for (const content of ["PRIVATE malformed payload", JSON.stringify({ url: "/uploads/" + committed.storage_key + "/blob", secret: "界".repeat(2000) })]) {
      invalidIds.push((await pool.query(`INSERT INTO messages (room_id,username,type,content)
        VALUES ('files123','Invalid','file',$1) RETURNING id`, [content])).rows[0].id);
    }
    const invalidDb = await databaseInventory();
    check(invalidDb.complete && invalidDb.references?.complete && !invalidDb.references.parseComplete);
    check(invalidDb.references?.messages.map(m => m.status).join() === "reference,invalid,oversized");
    check(!JSON.stringify(invalidDb).includes("PRIVATE") && !JSON.stringify(invalidDb).includes("界"));
    const referenceCap = await databaseInventory(2);
    check(!referenceCap.complete && !referenceCap.references?.complete && !referenceCap.references?.parseComplete);
    check(referenceCap.reasons.includes("row-limit:messages") && referenceCap.references?.messages.length === 2);
    check(referenceCap.referenceFacts?.keys.find(k => k.storageKey === committed.storage_key)?.messages === 1);
    evidence.push({ case: "observed-reference-facts", checks: 9,
      cases: "independent-counts,room-and-logical-conflict,arithmetic-separation,multiplicity,tombstone,cascade,partial-positive",
      fullIdentity: "unobserved", repairAuthority: false });
    await pool.query("DELETE FROM messages WHERE id=ANY($1::int[])", [invalidIds]);
    // Exercise actual driver payloads at the UTF-8 byte cap, not just the
    // returned report. A positive URL survives invalid metadata/provenance.
    const baseContent = baseline.messages[0].content;
    const exactContent = baseContent + " ".repeat(4096 - Buffer.byteLength(baseContent));
    const boundaryIds: number[] = [];
    for (const content of [exactContent, exactContent + " ",
      JSON.stringify({ ...JSON.parse(baseContent), size: -1 })]) {
      boundaryIds.push((await pool.query(`INSERT INTO messages (room_id,username,type,content)
        VALUES ('files123','Boundary','file',$1) RETURNING id`, [content])).rows[0].id);
    }
    const boundedClient = await pool.connect(), boundedQuery = boundedClient.query.bind(boundedClient);
    let exactTransferred = false, oversizedSuppressed = false;
    boundedClient.query = (async (config: { text: string }) => {
      const result = await boundedQuery(config);
      if (config.text.startsWith("FETCH") && config.text.includes("reference_messages")) {
        for (const row of result.rows) {
          if (row.message_id === boundaryIds[0]) exactTransferred = Buffer.byteLength(row.content) === 4096;
          if (row.message_id === boundaryIds[1]) oversizedSuppressed = row.content === null && row.oversized;
        }
      }
      return result;
    }) as typeof boundedClient.query;
    const bounded = await inventoryUploadDatabase(boundedClient, { pageSize: 1, maxRows: 10, timeoutMs: 2000 });
    check(exactTransferred && oversizedSuppressed);
    check(bounded.complete && !bounded.references?.metadataComplete && !bounded.references?.parseComplete);
    check(bounded.references?.messages.find(m => m.messageId === boundaryIds[0])?.storageKey === committed.storage_key);
    check(bounded.references?.messages.find(m => m.messageId === boundaryIds[1])?.metadataStatus === "unobserved");
    const invalidPositive = bounded.references?.messages.find(m => m.messageId === boundaryIds[2]);
    check(invalidPositive?.storageKey === committed.storage_key && invalidPositive?.metadataStatus === "invalid");
    check(!JSON.stringify(bounded).includes("Boundary") && !JSON.stringify(bounded).includes("safe.txt"));
    await pool.query("DELETE FROM messages WHERE id=ANY($1::int[])", [boundaryIds]);
    evidence.push({ case: "bounded-metadata-classification", checks: 7,
      cases: "valid-declarations,4096-byte-driver-boundary,4097-byte-SQL-suppression,invalid-positive-reference",
      filesystemIntegrity: "unobserved", identityAgreement: "unproven" });
    const messageLocker = await pool.connect();
    try {
      await messageLocker.query("BEGIN");
      await messageLocker.query("LOCK TABLE messages IN ACCESS EXCLUSIVE MODE");
      const blockedRefs = await inventoryUploadDatabase(await pool.connect(), { pageSize: 1, maxRows: 10, timeoutMs: 50 });
      check(!blockedRefs.complete && blockedRefs.reasons.includes("deadline"));
      check(blockedRefs.attempts.length === 2 && !blockedRefs.references?.complete && blockedRefs.accounting === "unknown");
    } finally { await messageLocker.query("ROLLBACK"); messageLocker.release(); }
    evidence.push({ case: "private-db-reference-collector", checks: 20,
      cases: "tombstone,cascade,duplicates,shared-snapshot,malformed,multibyte-oversize,row-cap,real-lock-deadline",
      rawContentExposed: false, crossStoreStability: "unproven" });
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
    // An owned connection can arrive with a previously pinned snapshot. BEGIN
    // with the same isolation level does not replace that snapshot in PostgreSQL.
    const inherited = await pool.connect();
    await inherited.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await inherited.query("SELECT * FROM resume_upload_budget");
    await pool.query("UPDATE resume_upload_budget SET reserved_bytes=0");
    const fresh = await inventoryUploadLedger(inherited, { pageSize: 1, maxRows: 10, timeoutMs: 2000 });
    check(fresh.complete && fresh.budget?.reserved_bytes === "0");
    check(fresh.accounting === "inconsistent" && fresh.reasons.includes("counter-sum-mismatch"));
    await pool.query("UPDATE resume_upload_budget SET reserved_bytes=$1", [ceiling * 2]);
    for (const poisoned of [false, true]) {
      const occupied = await pool.connect();
      await occupied.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE");
      // This caller-owned uncommitted change must be rolled back, never committed.
      await occupied.query("UPDATE resume_upload_budget SET reserved_bytes=0");
      if (poisoned) await assert.rejects(occupied.query("SELECT 1/0"));
      const clean = await inventoryUploadLedger(occupied, { pageSize: 1, maxRows: 10, timeoutMs: 2000 });
      check(clean.complete && clean.accounting === "consistent");
      check(clean.budget?.reserved_bytes === String(ceiling * 2));
      check((await pool.query("SELECT reserved_bytes::text FROM resume_upload_budget")).rows[0].reserved_bytes === String(ceiling * 2));
    }
    evidence.push({ case: "owned-connection-reset", checks: 8, inheritedSnapshot: "fresh",
      readWriteAndAbortedTransactions: "rolled-back-not-committed" });
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
