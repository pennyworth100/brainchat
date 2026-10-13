import { Pool } from "pg";
import { configureCandidateRuntime } from "./src/lib/db/candidate-runtime";
import { productionConfiguration } from "./src/lib/db/production-configuration";
import { verifyProductionDatabaseIdentities } from "./src/lib/db/production-identity";
import type { OwnedStrictUploadConfiguration } from "./src/lib/owned-strict-upload-service";

/** Runtime half of the production controller, NOT an autonomous CLI or a release
 * authorization token. The trusted caller retains its original operator fence
 * across fresh release/capacity checks, this call, and readiness/cutover. No
 * environment flag, saved JSON, migration pool, role reopening or budget change.
 * Actual provider provisioning and FENCED -> ACTIVATING remain caller-owned.
 */
export async function startProductionRuntime(options: Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  ca: string;
  verify: () => Promise<Readonly<{ assertHeld: () => Promise<void> }>>;
  strictUploads?: OwnedStrictUploadConfiguration;
}>) {
  // Capture trusted inputs before any await; a caller cannot replace its gate.
  const { environment, ca, verify, strictUploads } = options;
  if (typeof verify !== "function") throw Error("Live production verifier required");
  const { configs, roles, database } = productionConfiguration(environment, ca);
  configureCandidateRuntime(configs[0]);
  const { pool } = await import("./src/lib/db");
  const maintenance = new Pool(configs[1]);
  let startupEntered = false;
  try {
    const { main } = await import("./server");
    const runtime = await main({ privateBrowserResume: true, strictUploads,
      preinstalledAuthorities: { maintenance, publicationTables: true, verify: async () => {
        // The live controller checks capacity/release/fence first. Independently
        // verify the actual runtime connections before any app filesystem work.
        const lease = await verify();
        if (!lease || typeof lease.assertHeld !== "function") throw Error("Live activation lease required");
        const assertHeld = lease.assertHeld.bind(lease);
        await assertHeld();
        await verifyProductionDatabaseIdentities([pool, maintenance], roles, database);
        await assertHeld();
        startupEntered = true;
      } },
    });
    let stopping: Promise<unknown> | undefined;
    return Object.freeze({ ...runtime, stop(): Promise<unknown> {
      if (stopping) return stopping;
      // The async body fences admission synchronously before returning.
      stopping = (async () => {
        const report = await runtime.lifecycle.stopAndSettle();
        await runtime.settleStrictUploads();
        await new Promise<void>((resolve, reject) => runtime.io.close(error => error ? reject(error) : resolve()));
        await runtime.app.close();
        const closed = await Promise.allSettled([pool.end(), maintenance.end()]);
        if (closed.some(result => result.status === "rejected")) throw Error("Production pool settlement failed");
        return report;
      })();
      return stopping;
    } });
  } catch {
    // A failed lifecycle/ledger settlement must never lose its authority pools.
    // Preflight rejection has not started application work and can close both.
    if (!startupEntered) await Promise.allSettled([pool.end(), maintenance.end()]);
    throw Error("Production runtime startup rejected");
  }
}
