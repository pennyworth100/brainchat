/** Actual server lifetime + real verified-TLS ledger, no physical authority. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Pool } from "pg";
import type { OwnedStrictUploadConfiguration } from "../src/lib/owned-strict-upload-service";

async function main() {
  const fixture = process.env.LEDGER_TLS_FIXTURE!;
  assert.match(fixture, /^\/(?:private\/)?tmp\/dimle-provider-tls-[a-zA-Z0-9_-]+$/);
  const manifest = JSON.parse(await fs.readFile(fixture + "/fixture.json", "utf8"));
  assert.equal(manifest.kind, "owned-disposable-tls-v1");
  const ca = await fs.readFile(fixture + "/server.crt", "utf8");
  const admin = new Pool({ host: "127.0.0.1", port: manifest.port, user: "dimle", database: "postgres",
    ssl: { rejectUnauthorized: true, ca } });
  Object.assign(process.env, { DATABASE_URL: "postgresql://dimle@127.0.0.1:" + manifest.port +
    "/postgres?sslmode=verify-full&sslrootcert=" + encodeURIComponent(fixture + "/server.crt"),
    NODE_ENV: "production", PORT: "0", UPLOAD_DIR: fixture + "/uploads",
    ALFRED_API_KEY: "", DIMLE_AGENT_API_KEYS_JSON: "" });
  const output: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args) => { output.push(args); };
  let runtime: Awaited<ReturnType<typeof import("../server").main>> | undefined;
  let lease: any, provider: Parameters<OwnedStrictUploadConfiguration["provision"]>[0] | undefined;
  try {
    const system = (await admin.query("SELECT system_identifier::text FROM pg_control_system()")).rows[0].system_identifier;
    await admin.query("CREATE ROLE owned_server_ledger LOGIN");
    await admin.query("GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO owned_server_ledger");
    const { main: start } = await import("../server");
    runtime = await start({ strictUploads: {
      ledger: { host: "127.0.0.1", port: manifest.port, user: "owned_server_ledger", password: "",
        database: "postgres", clusterIdentity: "owned-server", systemIdentifier: system, ca },
      async provision(p) {
        provider = p;
        const policy = { identity: { database: p.binding.database, schema: "public", namespace: "fixture",
          quotaDomain: "volume", policyVersion: "v1", writerGeneration: "g1" },
          adapter: "resume-strict-writer-v1", layout: "provisioned-root-one-directory-one-file-v1",
          allocationModel: "audited-rounded-copies-v1", stableExclusiveNamespace: true,
          allAllocationCostsBounded: true, maxFileBytes: 6, allocationUnitBytes: 4, allocationCopies: 1,
          directoryAndParentBytes: 10, metadataBytes: 11, temporaryBytes: 12, additionalObjects: 3 };
        const checked = await p.checkout(p.pin(policy)!);
        assert.equal(checked.status, "acquired");
        if (checked.status !== "acquired") throw Error("checkout denied");
        lease = checked.lease;
        const tls = (await lease.query("SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()")).rows[0];
        assert.equal(tls.ssl, true); assert.match(tls.version, /^TLSv1\.[23]$/);
        return null; // NO physical authority: strict upload/download remain disabled.
      },
    } });
    const address = runtime.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    assert.equal((await fetch(base)).status, 200);
    let settled = false;
    const stopping = runtime.lifecycle.stopAndSettle();
    void stopping.then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(settled, false);
    assert.equal((await fetch(base + "/api/rooms", { method: "POST" })).status, 503);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='owned_server_ledger'")).rows[0].n, 1);
    assert.equal(lease.finalize(false), "released"); lease = undefined;
    const report = await stopping as { ownerFailures: number };
    assert.equal(report.ownerFailures, 0);
    await runtime.settleStrictUploads();
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='owned_server_ledger'")).rows[0].n, 0);
    assert.equal(provider!.pin({}), null);
    console.log = originalLog;
    originalLog(JSON.stringify({ status: "PASS", actualServer: true, verifiedTls: true,
      retainedLedgerLease: true, admissionAfterStop: 503, ledgerBackendsAfterStop: 0,
      strictPhysicalProvisioning: false }));
  } finally {
    console.log = originalLog;
    lease?.finalize(true);
    if (runtime) {
      await runtime.lifecycle.stopAndSettle();
      await runtime.settleStrictUploads();
      await new Promise<void>(resolve => runtime!.io.close(() => resolve()));
      await runtime.app.close();
    }
    const { pool } = await import("../src/lib/db");
    await pool.end(); await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
