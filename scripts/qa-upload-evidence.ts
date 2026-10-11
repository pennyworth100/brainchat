import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { inventoryUploadDatabase } from "../src/lib/resume-ledger-inventory";
import { inventoryUploadRoot } from "../src/lib/resume-root-inventory";
import { observeUploadContentBatch } from "../src/lib/resume-content-batch";
import { serializeUploadEvidence, type UploadEvidenceSources } from "../src/lib/resume-evidence-envelope";

// Fixture composition only: real SQL and temporary files, no application wiring.
async function main() {
  const connectionString = process.env.RESUME_TEST_DATABASE_URL;
  if (!connectionString) throw Error("RESUME_TEST_DATABASE_URL required (isolated DB only)");
  const schema = "evidence_qa_" + randomBytes(8).toString("hex");
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
  const pool = new Pool({ connectionString, options: "-c search_path=" + schema,
    connectionTimeoutMillis: 2000 });
  const root = await mkdtemp(join(tmpdir(), "dimle-evidence-"));
  let created = false, checks = 0;
  const check = (value: unknown) => { assert.ok(value); checks++; };
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true;
    for (const file of ["0000_thin_stardust", "0003_spotty_zombie", "0004_long_nighthawk",
      "0005_free_blazing_skull", "0006_cold_zuras", "0007_motionless_wolfpack", "0008_dark_grim_reaper"]) {
      await pool.query((await readFile("drizzle/" + file + ".sql", "utf8"))
        .replaceAll('"public".', '"' + schema + '".'));
    }
    const key = "a".repeat(64), unattributed = "b".repeat(64), unread = "c".repeat(64);
    const session = randomUUID(), bytes = Buffer.from("isolated evidence bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await pool.query("INSERT INTO rooms (id) VALUES ('files123')");
    await pool.query(`INSERT INTO room_resume_sessions
      (id,token_hash,room_id,username,auth_version,expires_at)
      VALUES ($1,$2,'files123','Fixture',1,now()+interval '1 hour')`, [session, "e".repeat(64)]);
    await pool.query("INSERT INTO resume_upload_budget VALUES (1,2048,2048)");
    for (const k of [key, unread]) await pool.query(`INSERT INTO resume_upload_attempts
      (storage_key,session_id,room_id,client_message_id,reserved_bytes)
      VALUES ($1,$2,'files123','logical',1024)`, [k, session]);
    const body = (size: number) => JSON.stringify({ url: `/uploads/${key}/blob`, name: "fixture.txt",
      size, mime: "text/plain", sha256: digest });
    const ids: number[] = [];
    // Same key in independent message rows, including contradictory metadata.
    for (const size of [bytes.length, bytes.length, bytes.length + 1]) {
      ids.push((await pool.query(`INSERT INTO messages (room_id,username,type,content)
        VALUES ('files123','Fixture','file',$1) RETURNING id`, [body(size)])).rows[0].id);
    }
    const hash = createHash("sha256").update(JSON.stringify([
      "files123", "Fixture", "file", "fixture.txt", bytes.length, "text/plain", digest])).digest("hex");
    // Two receipts referencing one message must not be deduplicated; keep tombstone.
    for (const [clientId, messageId] of [["a", ids[0]], ["b", ids[0]], ["c", null]] as const) {
      await pool.query(`INSERT INTO resume_message_receipts
        (session_id,client_message_id,payload_hash,message_id) VALUES ($1,$2,$3,$4)`,
      [session, clientId, hash, messageId]);
    }
    for (const k of [key, unattributed]) {
      await mkdir(join(root, k)); await writeFile(join(root, k, "blob"), bytes);
    }
    // Unknown entry makes a real root observation incomplete without depending
    // on platform directory ordering. The positive unattributed key survives.
    await writeFile(join(root, "fixture-unrecognized-entry"), "fixture");
    const dbState = async () => Promise.all(["resume_upload_budget", "resume_upload_attempts",
      "resume_message_receipts", "messages", "room_resume_sessions"].map(async table =>
      (await pool.query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows));
    const before = await dbState();
    const db = (maxRows: number) => pool.connect().then(client => inventoryUploadDatabase(client,
      { pageSize: 1, maxRows, timeoutMs: 5000 }));
    const full = await db(10), capped = await db(2);
    check(full.complete && full.references?.complete && full.references.metadataComplete);
    check(full.references?.messages.length === 3 && full.references.receipts.length === 3);
    check(full.references?.receipts.filter(r => r.messageId === ids[0]).length === 2);
    check(full.references?.receipts[2].status === "tombstone");
    check(full.references?.messages[2].declaredSize === bytes.length + 1);
    check(!capped.complete && capped.reasons.includes("row-limit:receipts"));
    check(capped.attempts.length === 2 && capped.references?.receipts.length === 2);
    check(capped.references?.messages.length === 0 && !capped.references.complete);
    const releaseSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const base = { namespaceId: "fixture:uploads", releaseSha };
    const databaseId = (await pool.query("SELECT current_database() AS name")).rows[0].name;
    const rootLimits = { maxEntries: 10, maxMs: 5000, trustedStableAncestry: true };
    const rootStart = new Date().toISOString();
    const rootReport = await inventoryUploadRoot(root, rootLimits);
    const rootEnd = new Date().toISOString();
    check(!rootReport.enumerationComplete && rootReport.reasons.includes("unknown-entry"));
    check(rootReport.entries.some(e => e.storageKey === unattributed && e.kind === "directory"));
    check(rootReport.blobs === "unobserved");
    const limits = { namespaceId: base.namespaceId, trustedRootNamespaceBinding: true, trustedStableAncestry: true,
      maxKeys: 3, maxBytes: 3072, maxReads: 6, maxMs: 5000, perKeyBytes: 1024, perKeyReads: 2 };
    const contentStart = new Date().toISOString();
    const content = await observeUploadContentBatch(root, [key, key, unread], limits);
    const contentEnd = new Date().toISOString();
    check(content.allKeysAttempted && content.observations.length === 3);
    check(content.observations[0].content.complete && content.observations[0].content.sha256 === digest);
    check(content.observations[1].inputIndex === 1 && content.observations[1].storageKey === key);
    check(!content.observations[2].content.complete && content.observations[2].content.sha256 === null);
    check(content.observations[2].content.reasons.includes("io-unobserved"));
    check(content.reservedBytes === 3072 && content.reservedReads === 6);
    check(!content.observations.some(o => o.storageKey === unattributed));
    const captures: unknown[] = [];
    for (const report of [full, capped]) {
      const sources: UploadEvidenceSources = {
        database: { provenance: { ...base, observationId: report === full ? "db-full" : "db-capped",
          databaseId, schemaId: schema,
          startedAt: report.startedAt, finishedAt: report.finishedAt }, report },
        root: { provenance: { ...base, observationId: "root", volumeId: "temp-fixture",
          rootId: root.split("/").at(-1)!, startedAt: rootStart, finishedAt: rootEnd }, limits: rootLimits, report: rootReport },
        content: { provenance: { ...base, observationId: "content", volumeId: "temp-fixture",
          rootId: root.split("/").at(-1)!, startedAt: contentStart, finishedAt: contentEnd }, limits, report: content },
      };
      const result = serializeUploadEvidence(sources); assert.ok(result.ok); checks++;
      const envelope = JSON.parse(result.json);
      captures.push(envelope);
      assert.deepEqual(envelope.sources, sources); checks++;
      check(envelope.sources.database.report.complete === (report === full));
      check(envelope.sources.root.report.enumerationComplete === false && envelope.sources.content.report.allKeysAttempted);
      check(envelope.sources.database.report.attempts.some((a: { storage_key: string }) => a.storage_key === unread));
      check(envelope.authority === "none" && envelope.crossStoreStability === "unproven" && envelope.volumeCoverage === "unproven");
      check(envelope.provenance === "caller-asserted-unverified" && envelope.relationship === "independent-observations");
      for (const field of ["complete", "pass", "absent", "owned", "reclaimable", "repair"]) check(!(field in envelope));
    }
    assert.deepEqual(await dbState(), before); checks++;
    assert.deepEqual((await readdir(root)).sort(), [key, unattributed, "fixture-unrecognized-entry"].sort()); checks++;
    for (const k of [key, unattributed]) { assert.deepEqual(await readFile(join(root, k, "blob")), bytes); checks++; }
    console.log(JSON.stringify({ passed: checks, databaseCaptures: 2, envelopes: 2, captures,
      cases: ["duplicate-receipts", "duplicate-and-conflicting-messages", "tombstone", "db-positive-unread-blob",
        "root-positive-unattributed-key", "duplicate-content-input", "complete-input-list-incomplete-db-and-root"],
      limitations: "Isolated fixture; caller-asserted provenance, no live namespace, atomic DB/FS snapshot, absence, ownership or repair proof" }));
  } finally {
    await pool.end();
    try { if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE'); }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
