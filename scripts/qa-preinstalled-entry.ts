// Owned-loopback acceptance invokes the real production runtime composition.
// The IPC gate is fixture-only, NOT production release/fence/capacity authority.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installProcessShutdown } from "../src/lib/process-shutdown";
import { startProductionRuntime } from "../production-runtime";

async function start() {
  const dir = process.env.LEDGER_TLS_FIXTURE!;
  const manifest = JSON.parse(readFileSync(dir + "/fixture.json", "utf8"));
  assert.equal(manifest.kind, "owned-disposable-tls-v1");
  assert.ok(process.send, "fixture requires IPC owner");
  for (const key of ["RUNTIME", "MAINTENANCE"]) {
    const url = new URL(process.env["DIMLE_CANDIDATE_" + key + "_URL"]!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, String(manifest.port));
    assert.equal(url.pathname, "/candidate");
    assert.equal(url.search, "");
  }
  try {
    const runtime = await startProductionRuntime({
      environment: {
        DIMLE_PRODUCTION_RUNTIME_URL: process.env.DIMLE_CANDIDATE_RUNTIME_URL,
        DIMLE_PRODUCTION_MAINTENANCE_URL: process.env.DIMLE_CANDIDATE_MAINTENANCE_URL,
        DATABASE_URL: "invalid://must-not-be-used",
      },
      ca: readFileSync(dir + "/server.crt", "utf8"),
      verify: async () => {
        console.log("Fixture preflight pending");
        const decision = await new Promise(resolve => process.once("message", resolve));
        assert.ok(decision === "verify" || decision === "lose-lease" || decision === "late-gate" ||
          decision === "late-loss", "fixture verification rejected");
        let checks = 0;
        return { assertHeld: async () => {
          // Deliberate fixture lease loss AFTER actual identity checks.
          checks++;
          assert.ok(decision !== "lose-lease" || checks < 2, "fixture lease lost");
          assert.ok(decision !== "late-loss" || checks < 4, "fixture final lease lost");
          if (decision === "late-gate" && checks === 3) {
            console.log("Fixture before-listen pending");
            assert.equal(await new Promise(resolve => process.once("message", resolve)), "continue",
              "fixture before-listen rejected");
          }
        } };
      },
    });
    installProcessShutdown(process, async () => {
      const stopping = runtime.stop();
      assert.equal(runtime.stop(), stopping, "shutdown must retain one promise");
      const report = await stopping;
      process.disconnect?.();
      return report;
    }, event => {
      console.log("Preinstalled fixture shutdown " + event);
      if (event === "failed") process.exitCode = 1;
    });
  } catch {
    process.disconnect?.();
    throw Error("Preinstalled fixture rejected");
  }
}
void start().catch(error => { console.error(error.message); process.exitCode = 1; });
