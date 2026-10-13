import { Pool } from "pg";
import { configureCandidateRuntime } from "./src/lib/db/candidate-runtime";
import { productionConfiguration } from "./src/lib/db/production-configuration";
import { verifyProductionDatabaseIdentities } from "./src/lib/db/production-identity";
import type { OwnedStrictUploadConfiguration } from "./src/lib/owned-strict-upload-service";
import { SettledServerStartupError } from "./src/lib/server-startup-error";

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
  let assertActivationHeld: (() => Promise<void>) | undefined;
  try {
    const { main } = await import("./server");
    const runtime = await main({ privateBrowserResume: true, strictUploads,
      beforeListen: async () => {
        if (!assertActivationHeld) throw Error("Live activation lease required");
        // Next.prepare and strict-provider startup may take arbitrarily long.
        // Reuse the captured lease; NEVER rerun verify to acquire another one.
        await assertActivationHeld();
        await verifyProductionDatabaseIdentities([pool, maintenance], roles, database);
        await assertActivationHeld();
      },
      preinstalledAuthorities: { maintenance, publicationTables: true, verify: async () => {
        // The live controller checks capacity/release/fence first. Independently
        // verify the actual runtime connections before any app filesystem work.
        const lease = await verify();
        if (!lease || typeof lease.assertHeld !== "function") throw Error("Live activation lease required");
        const assertHeld = lease.assertHeld.bind(lease);
        assertActivationHeld = assertHeld;
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
  } catch (error) {
    // A failed lifecycle/ledger settlement must never lose its authority pools.
    // Close only before application work or after an explicit settled rejection.
    if (!startupEntered || error instanceof SettledServerStartupError)
      await Promise.allSettled([pool.end(), maintenance.end()]);
    throw Error("Production runtime startup rejected");
  }
}
