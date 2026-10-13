// Owned-loopback acceptance entry ONLY, never a production launcher.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { configureCandidateRuntime } from "../src/lib/db/candidate-runtime";
import { installProcessShutdown } from "../src/lib/process-shutdown";
import { productionConfiguration } from "../src/lib/db/production-configuration";
import { verifyProductionDatabaseIdentities } from "../src/lib/db/production-identity";

async function start() {
  const dir = process.env.LEDGER_TLS_FIXTURE!;
  const manifest = JSON.parse(readFileSync(dir + "/fixture.json", "utf8"));
  assert.equal(manifest.kind, "owned-disposable-tls-v1");
  assert.ok(process.send, "fixture requires IPC owner");
  const ca = readFileSync(dir + "/server.crt", "utf8");
  for (const key of ["RUNTIME", "MAINTENANCE"]) {
    const url = new URL(process.env["DIMLE_CANDIDATE_" + key + "_URL"]!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, String(manifest.port));
    assert.equal(url.pathname, "/candidate");
    assert.equal(url.search, "");
  }
  const {configs,roles,database} = productionConfiguration({
    DIMLE_PRODUCTION_RUNTIME_URL: process.env.DIMLE_CANDIDATE_RUNTIME_URL,
    DIMLE_PRODUCTION_MAINTENANCE_URL: process.env.DIMLE_CANDIDATE_MAINTENANCE_URL,
  }, ca);
  configureCandidateRuntime(configs[0]);
  const { pool } = await import("../src/lib/db");
  const maintenance = new Pool(configs[1]);
  let entered = false;
  try {
    const { main } = await import("../server");
    const runtime = await main({ privateBrowserResume: true,
      preinstalledAuthorities: { maintenance, publicationTables: true, verify: async () => {
        console.log("Fixture preflight pending");
        const decision = await new Promise(resolve => process.once("message", resolve));
        assert.equal(decision, "verify", "fixture verification rejected");
        await verifyProductionDatabaseIdentities([pool,maintenance],roles,database);
        for (const [i, p] of [pool, maintenance].entries()) {
          const row = (await p.query(`SELECT current_user,session_user,
            (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
            has_schema_privilege(current_user,'drizzle','USAGE') AS history_access,
            has_schema_privilege(current_user,'public','CREATE') AS ddl`)).rows[0];
          assert.equal(row.current_user, i === 0 ? "candidate_runtime" : "candidate_maintenance");
          assert.equal(row.session_user, row.current_user);
          assert.equal(row.tls, true);
          assert.equal(row.history_access, false);
          assert.equal(row.ddl, false);
        }
        // Only a fixture role/TLS proof, NOT production release/fence/capacity proof.
        entered = true;
      } }
    });
    installProcessShutdown(process, async () => {
      const report = await runtime.lifecycle.stopAndSettle();
      await runtime.settleStrictUploads();
      await new Promise<void>((resolve, reject) => runtime.io.close(e => e ? reject(e) : resolve()));
      await runtime.app.close();
      await Promise.all([pool.end(), maintenance.end()]);
      process.disconnect?.();
      return report;
    }, event => {
      console.log("Preinstalled fixture shutdown " + event);
      if (event === "failed") process.exitCode = 1;
    });
  } catch {
    if (!entered) await Promise.allSettled([pool.end(), maintenance.end()]);
    process.disconnect?.();
    throw Error("Preinstalled fixture rejected");
  }
}
void start().catch(error => { console.error(error.message); process.exitCode = 1; });
