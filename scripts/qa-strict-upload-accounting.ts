/** Focused admission/accounting integration; owned TLS fixture only, no storage authority. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { mock } from "node:test";
import { Pool } from "pg";
import { ResumeBindings } from "../src/lib/resume-bindings";
import { ResumeCapacity } from "../src/lib/resume-capacity";
import { ResumeUploadAdmissions } from "../src/lib/resume-upload-admission";
import { createStrictUploadLedgerProvider } from "../src/lib/upload-ledger-provider";
import { bindStrictUploadRoot } from "../src/lib/upload-storage-root";
import { StrictUploadAccounting } from "../src/lib/strict-upload-accounting";

async function main() {
  const fixture = process.env.LEDGER_TLS_FIXTURE || "";
  assert.match(fixture, /^\/(?:private\/)?tmp\/dimle-provider-tls-[a-zA-Z0-9_-]+$/);
  const manifest = JSON.parse(readFileSync(fixture + "/fixture.json", "utf8"));
  assert.equal(manifest.kind, "owned-disposable-tls-v1");
  const ca = readFileSync(fixture + "/server.crt", "utf8");
  const db = new Pool({ host: "127.0.0.1", port: manifest.port, user: "dimle",
    database: "postgres", ssl: { rejectUnauthorized: true, ca } });
  const providers: ReturnType<typeof createStrictUploadLedgerProvider>[] = [];
  const cases: string[] = [];
  let fsCalls = 0;
  try {
    const identity = (await db.query("SELECT system_identifier::text FROM pg_control_system()")).rows[0];
    const ssl = (await db.query("SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
    assert.equal(ssl.ssl, true);
    for (const file of ["0009_upload_resource_ledger.sql", "0010_strict_resource_adapter.sql"]) {
      await db.query(readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8"));
    }
    await db.query("CREATE ROLE accounting_fixture LOGIN");
    await db.query("GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO accounting_fixture");
    await db.query("GRANT USAGE ON SCHEMA public TO accounting_fixture");
    await db.query("GRANT SELECT ON public.upload_resource_domains, public.upload_resource_policies TO accounting_fixture");
    await db.query("GRANT UPDATE(outstanding_bytes,outstanding_objects) ON public.upload_resource_domains TO accounting_fixture");
    await db.query("GRANT INSERT, SELECT(attempt_id) ON public.upload_resource_attempts TO accounting_fixture");
    const provider = createStrictUploadLedgerProvider({ host: "127.0.0.1", port: manifest.port,
      user: "accounting_fixture", password: "", database: "postgres", ca,
      clusterIdentity: "owned-accounting-fixture", systemIdentifier: identity.system_identifier });
    providers.push(provider);
    const policy = { identity: { database: provider.binding.database, schema: "public",
      quotaDomain: "fixture", namespace: "/synthetic-never-opened", policyVersion: "v1", writerGeneration: "g1" },
      adapter: "resume-strict-writer-v1", layout: "provisioned-root-one-directory-one-file-v1",
      allocationModel: "audited-rounded-copies-v1", stableExclusiveNamespace: true,
      allAllocationCostsBounded: true, maxFileBytes: 8, allocationUnitBytes: 4, allocationCopies: 1,
      directoryAndParentBytes: 10, metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 };
    const pin = provider.pin(policy)!; assert.ok(pin);
    const root = bindStrictUploadRoot(pin, policy, { path: policy.identity.namespace, device: "1",
      inode: "2", uid: process.geteuid!(), gid: process.getegid!() })!; assert.ok(root);
    await db.query("INSERT INTO public.upload_resource_domains VALUES ($1,'public','fixture','g1',true,'cut1',10000,0,0,0,1000,0,0,0)", [provider.binding.database]);
    await db.query("INSERT INTO public.upload_resource_policies VALUES ($1,'public','fixture',$2,'v1','g1',$3::jsonb)",
      [provider.binding.database, policy.identity.namespace, JSON.stringify(policy)]);
    const state = async () => ({
      domain: (await db.query("SELECT outstanding_bytes,outstanding_objects FROM public.upload_resource_domains")).rows[0],
      rows: (await db.query("SELECT attempt_id,operation_id,allocated_bytes,objects FROM public.upload_resource_attempts ORDER BY attempt_id")).rows,
    });
    for (const method of ["open", "mkdir", "writeFile"] as const)
      mock.method(fs, method, async () => { fsCalls++; assert.fail("accounting performed filesystem IO"); });

    for (const mode of ["committed", "expire-prepare", "pending-commit", "lost-ack", "aborted-tag"] as const) {
      let now = 0, finish!: () => void, enter!: () => void, commitTag = "";
      const gate = new Promise<void>(r => { finish = r; });
      const entered = new Promise<void>(r => { enter = r; });
      const commands: string[] = [];
      const observed = { ...provider, checkout: async (ownedPin: typeof pin) => {
        const r = await provider.checkout(ownedPin);
        if (r.status !== "acquired") return r;
        const query = r.lease.query.bind(r.lease);
        r.lease.query = async (sql: string, values?: unknown[]) => {
          commands.push(sql);
          if (sql === "COMMIT" && mode === "aborted-tag") await query("SELECT 1/0").catch(() => {});
          const result = await query(sql, values);
          if (sql.startsWith("INSERT") && mode === "expire-prepare") now = 100;
          if (sql === "COMMIT") {
            commitTag = result.command;
            if (mode === "pending-commit") { enter(); await gate; }
            if (mode === "lost-ack") throw Error("controlled lost acknowledgement after real COMMIT");
          }
          return result;
        };
        return r;
      } };
      const bindings = new ResumeBindings();
      const binding = await bindings.activate({ sessionId: mode, roomId: "files123", username: "Guest",
        authVersion: 1, generation: 1, issuedAt: new Date(), expiresAt: new Date(Date.now()+60000) },
        "transport_upload_fixture", async () => {}, () => true);
      assert.ok(binding);
      const admissions = new ResumeUploadAdmissions(bindings, new ResumeCapacity(1), 8, 100, () => now);
      const grant = admissions.admit(binding)!; assert.ok(grant);
      const make = () => new StrictUploadAccounting(admissions, observed, pin, policy, root, { auditId: "cut1", writerId: "fixture" });
      const bridge = make(), before = await state();
      assert.deepEqual(await bridge.reserve({ ...grant }, "copy"), { status: "denied" });
      assert.equal(commands.length, 0);
      let settled = false;
      const pending = bridge.reserve(grant, "message_" + mode.replaceAll("-", "_")).then(r => { settled = true; return r; });
      if (mode === "pending-commit") {
        await entered; now = 100;
        await new Promise(r => setImmediate(r));
        assert.equal(settled, false);
        assert.equal(admissions.admit(binding), null);
        assert.deepEqual(await make().reserve(grant, "retry_pending"), { status: "denied" });
        assert.equal((await state()).rows.length, before.rows.length + 1);
        finish();
      }
      const result = await pending;
      assert.equal(result.status, "settled"); assert.ok(result.status === "settled");
      const after = await state();
      if (mode === "committed") {
        assert.equal(result.outcome.status, "committed"); assert.ok(result.receipt);
        const record = bridge.resolve(grant, result.receipt)!; assert.ok(record);
        const row = after.rows.find(r => r.attempt_id === record.attemptId)!;
        assert.ok(row); assert.equal(row.operation_id, record.operationId);
        assert.equal(record.attemptId, result.outcome.attemptId);
        assert.equal(record.clientMessageId, "message_committed"); assert.equal(record.limit, 8);
        assert.equal(bridge.resolve(grant, { ...result.receipt }), null);
        assert.equal(bridge.resolve({ ...grant }, result.receipt), null);
        assert.equal(make().resolve(grant, result.receipt), null);
      } else assert.equal(result.receipt, null);
      const retained = ["committed", "pending-commit", "lost-ack"].includes(mode);
      if (retained) {
        const row = after.rows.find(r => r.attempt_id === result.outcome.attemptId)!;
        assert.ok(row); assert.equal(after.rows.length, before.rows.length+1);
        assert.equal(BigInt(after.domain.outstanding_bytes)-BigInt(before.domain.outstanding_bytes), BigInt(row.allocated_bytes));
        assert.equal(BigInt(after.domain.outstanding_objects)-BigInt(before.domain.outstanding_objects), BigInt(row.objects));
      } else assert.deepEqual(after, before);
      assert.equal(result.outcome.status, mode === "expire-prepare" ? "not-committed" :
        ["lost-ack", "aborted-tag"].includes(mode) ? "unknown" : "committed");
      if (mode === "aborted-tag") assert.equal(commitTag, "ROLLBACK");
      if (mode === "expire-prepare") { assert.ok(commands.includes("ROLLBACK")); assert.ok(!commands.includes("COMMIT")); }
      else assert.ok(!commands.includes("ROLLBACK"));
      const count = commands.length;
      assert.deepEqual(await make().reserve(grant, "retry"), { status: "denied" });
      assert.equal(commands.length, count); assert.equal(admissions.admit(binding), null);
      admissions.release(grant);
      cases.push(mode);
    }
    assert.equal(fsCalls, 0);
    console.log(JSON.stringify({ status: "PASS", cases, tls: ssl.version, fsCalls,
      bodySourceAPI: false, physicalAuthority: false, final: await state() }));
  } finally { mock.restoreAll(); for (const p of providers) await p.close(); await db.end(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
