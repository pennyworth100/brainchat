/** Owned TLS PostgreSQL + actual filesystem composition; physical receipts are SYNTHETIC. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeCapacity } from "../src/lib/resume-capacity";
import { ResumeUploadAdmissions } from "../src/lib/resume-upload-admission";
import { createStrictUploadLedgerProvider } from "../src/lib/upload-ledger-provider";
import { bindStrictUploadRoot } from "../src/lib/upload-storage-root";
import { StrictUploadAccounting } from "../src/lib/strict-upload-accounting";
import { StrictFileStorage, type StrictStorageRequest } from "../src/lib/strict-file-storage";
import { StrictMultipartUpload } from "../src/lib/strict-multipart-upload";
import { ResumeFileUpload } from "../src/lib/resume-file-upload";
import { ResumeFileWriter } from "../src/lib/resume-file";
import { ResumeUploadOperationGate } from "../src/lib/resume-operation";

async function main() {
  const fixture = process.env.LEDGER_TLS_FIXTURE || "";
  assert.match(fixture, /^\/(?:private\/)?tmp\/dimle-provider-tls-[a-zA-Z0-9_-]+$/);
  const manifest = JSON.parse(readFileSync(fixture + "/fixture.json", "utf8"));
  assert.equal(manifest.kind, "owned-disposable-tls-v1");
  const ca = readFileSync(fixture + "/server.crt", "utf8");
  const db = new Pool({ host: "127.0.0.1", port: manifest.port, user: "dimle",
    database: "postgres", ssl: { rejectUnauthorized: true, ca } });
  let provider: ReturnType<typeof createStrictUploadLedgerProvider> | undefined;
  const cases: unknown[] = [];
  try {
    const system = (await db.query("SELECT system_identifier::text FROM pg_control_system()")).rows[0];
    const ssl = (await db.query("SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
    assert.equal(ssl.ssl, true);
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    for (const e of journal.entries) await db.query(readFileSync("drizzle/" + e.tag + ".sql", "utf8"));
    await db.query("CREATE ROLE storage_accounting_fixture LOGIN");
    await db.query("GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO storage_accounting_fixture");
    await db.query("GRANT USAGE ON SCHEMA public TO storage_accounting_fixture");
    await db.query("GRANT SELECT ON public.upload_resource_domains, public.upload_resource_policies TO storage_accounting_fixture");
    await db.query("GRANT UPDATE(outstanding_bytes,outstanding_objects) ON public.upload_resource_domains TO storage_accounting_fixture");
    await db.query("GRANT INSERT, SELECT(attempt_id) ON public.upload_resource_attempts TO storage_accounting_fixture");
    provider = createStrictUploadLedgerProvider({ host: "127.0.0.1", port: manifest.port,
      user: "storage_accounting_fixture", password: "", database: "postgres", ca,
      clusterIdentity: "owned-storage-fixture", systemIdentifier: system.system_identifier });
    const rootPath = join(fixture, "uploads"); await fs.mkdir(rootPath, { mode: 0o700 });
    // macOS /tmp inherits wheel; explicitly provision OUR disposable root to
    // the effective writer identity rather than weakening the root guard.
    await fs.chown(rootPath, process.geteuid!(), process.getegid!());
    const st = await fs.stat(rootPath, { bigint: true });
    const policy = { identity: { database: provider.binding.database, schema: "public",
      quotaDomain: "fixture", namespace: rootPath, policyVersion: "v1", writerGeneration: "g1" },
      adapter: "resume-strict-writer-v1", layout: "provisioned-root-one-directory-one-file-v1",
      allocationModel: "audited-rounded-copies-v1", stableExclusiveNamespace: true,
      allAllocationCostsBounded: true, maxFileBytes: 8, allocationUnitBytes: 4, allocationCopies: 1,
      directoryAndParentBytes: 10, metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 };
    const pin = provider.pin(policy)!; assert.ok(pin);
    const root = bindStrictUploadRoot(pin, policy, { path: rootPath, device: st.dev.toString(),
      inode: st.ino.toString(), uid: process.geteuid!(), gid: process.getegid!() })!; assert.ok(root);
    await db.query("INSERT INTO public.upload_resource_domains VALUES ($1,'public','fixture','g1',true,'cut1',10000,0,0,0,1000,0,0,0)", [provider.binding.database]);
    await db.query("INSERT INTO public.upload_resource_policies VALUES ($1,'public','fixture',$2,'v1','g1',$3::jsonb)",
      [provider.binding.database, rootPath, JSON.stringify(policy)]);
    await db.query("INSERT INTO rooms(id) VALUES ('files123')");
    for (const protocol of ["raw", "multipart"] as const) for (const mode of ["committed", "missing", "lost-accounting", "lost-message", "pending-message"] as const) {
      const sessionId = protocol + "-" + mode;
      const beforeFiles = await fs.readdir(rootPath);
      const beforeRows = Number((await db.query("SELECT count(*) FROM upload_resource_attempts")).rows[0].count);
      const bindingStore = new ResumeBindings();
      const identity = { sessionId, roomId: "files123", username: "Guest", authVersion: 1,
        generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60000) };
      const transport = "storage-fixture-transport";
      await db.query("INSERT INTO room_resume_sessions(id,token_hash,room_id,username,auth_version,generation,expires_at,last_transport_id) VALUES($1,$1,'files123','Guest',1,1,$2,$3)",
        [sessionId, identity.expiresAt, transport]);
      const binding = await bindingStore.activate(identity, transport, async () => {}, () => true); assert.ok(binding);
      let now = 0, physicalCalls = 0, bodyReads = 0, finish!: () => void, enter!: () => void;
      const entered = new Promise<void>(r => { enter = r; });
      const pause = new Promise<void>(r => { finish = r; });
      const admissions = new ResumeUploadAdmissions(bindingStore, new ResumeCapacity(1), 8, 100, () => now);
      const grant = admissions.admit(binding)!; assert.ok(grant);
      const observed: ReturnType<typeof createStrictUploadLedgerProvider> = { ...provider, checkout: async (ownedPin: typeof pin) => {
        const r = await provider!.checkout(ownedPin);
        if (r.status !== "acquired") return r;
        const query = r.lease.query.bind(r.lease);
        r.lease.query = async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql === "COMMIT" && mode === "lost-accounting") throw Error("controlled lost accounting ACK");
          return result;
        };
        return r;
      } };
      const accounting = new StrictUploadAccounting(admissions, observed, pin, policy, root, { auditId: "cut1", writerId: "fixture" });
      const permits = new WeakMap<object, StrictStorageRequest>();
      const physical = {
        async authorize(request: StrictStorageRequest) {
          physicalCalls++; const receipt = Object.freeze({ syntheticOnly: true });
          permits.set(receipt, request); return receipt;
        },
        isCurrent(receipt: object, request: StrictStorageRequest) { return permits.get(receipt) === request; },
      };
      const storage = new StrictFileStorage(admissions, accounting, mode === "missing" ? null : physical);
      const writerPool = { connect: async () => {
        const real = await db.connect();
        return { on: real.on.bind(real), removeListener: real.removeListener.bind(real),
          release: real.release.bind(real), query: async (sql: string, values?: unknown[]) => {
            const result = await real.query(sql, values);
            if (sql === "COMMIT" && mode === "lost-message") throw Error("controlled lost message ACK");
            if (sql === "COMMIT" && mode === "pending-message") { enter(); await pause; }
            return result;
          },
        } as unknown as PoolClient;
      } };
      const upload = new ResumeFileUpload(storage, new ResumeFileWriter(new ResumeUploadOperationGate(writerPool, admissions)));
      async function* source() { bodyReads++; yield Buffer.from("abc"); }
      const multipartUpload = new StrictMultipartUpload(storage, new ResumeFileWriter(new ResumeUploadOperationGate(writerPool, admissions)));
      const wire = Buffer.from('--bound\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\nContent-Type: text/plain\r\n\r\nabc\r\n--bound--\r\n');
      async function* multipartSource() { bodyReads++; yield wire; }
      const save = () => protocol === "raw"
        ? upload.saveWithOutcome(grant, "key", { name: "file.txt", mime: "text/plain" }, source())
        : multipartUpload.saveWithOutcome(grant, "key", { chunks: multipartSource(), abort: async () => {} },
          { boundary: "bound", contentLength: wire.length });
      let settled = false;
      const pending = save().then(r => { settled = true; return r; });
      try {
        if (mode === "pending-message") {
          await entered; now = 100;
          assert.equal(settled, false); assert.equal(admissions.admit(binding), null);
          assert.equal(Number((await db.query("SELECT count(*) FROM resume_message_receipts WHERE session_id=$1", [sessionId])).rows[0].count), 1);
          finish();
        }
        const result = await pending;
        const newFiles = (await fs.readdir(rootPath)).filter(x => !beforeFiles.includes(x));
        const afterRows = Number((await db.query("SELECT count(*) FROM upload_resource_attempts")).rows[0].count);
        const messages = (await db.query("SELECT m.content FROM resume_message_receipts r JOIN messages m ON m.id=r.message_id WHERE r.session_id=$1", [sessionId])).rows;
        if (mode === "missing" || mode === "lost-accounting") {
          assert.ok(!result.completed && result.commit === "not-dispatched");
          assert.equal(physicalCalls, 0); assert.equal(bodyReads, 0); assert.equal(newFiles.length, 0);
          assert.equal(messages.length, 0);
        } else {
          assert.equal(newFiles.length, 1); assert.equal(messages.length, 1);
          assert.equal((await fs.readFile(join(rootPath, newFiles[0], "blob"))).toString(), "abc");
          assert.equal(JSON.parse(messages[0].content).url, "/uploads/" + newFiles[0] + "/blob");
          if (mode === "lost-message") assert.ok(!result.completed && result.commit === "unknown");
          else assert.ok(result.completed && result.result.authorized && result.result.value.inserted);
        }
        assert.equal(afterRows - beforeRows, mode === "missing" ? 0 : 1);
        assert.equal(admissions.admit(binding), null);
        assert.deepEqual(await save(),
          { completed: true, result: { authorized: false } });
        cases.push({ protocol, mode, accountingRows: afterRows - beforeRows, files: newFiles.length, receipts: messages.length, bodyReads, physicalCalls });
      } finally { finish(); await pending; admissions.release(grant); }
    }
    assert.equal(Number((await db.query("SELECT count(*) FROM resume_upload_attempts")).rows[0].count), 0);
    const domain = (await db.query("SELECT outstanding_bytes,outstanding_objects FROM upload_resource_domains")).rows[0];
    assert.ok(BigInt(domain.outstanding_bytes) > 0n && BigInt(domain.outstanding_objects) > 0n);
    console.log(JSON.stringify({ status: "PASS", tls: ssl.version, syntheticPhysicalAuthority: true,
      productionAuthority: false, cases, retainedAccounting: domain }));
  } finally { await provider?.close(); await db.end(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
