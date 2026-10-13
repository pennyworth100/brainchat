import type { Pool } from "pg";
import { migrateDatabase } from "./startup-migrations";

export type MigrationAuthorities = Readonly<{
  migrations: Pool; maintenance: Pool; publicationTables: boolean;
}>;
/** Trusted in-process composition, not an environment skip-migration switch.
 * The verifier must own the release/identity/DDL-fence/capacity checks through
 * activation. Resolving a callback is not itself proof of those prerequisites.
 * No migration credentials/pool are accepted by this runtime-only path. */
export type PreinstalledAuthorities = Readonly<{
  maintenance: Pool; publicationTables: true; verify: () => Promise<void>;
}>;

export async function prepareDatabaseStartup(runtime: Pool,
  migrations?: MigrationAuthorities, preinstalled?: PreinstalledAuthorities) {
  migrations = migrations && { ...migrations };
  preinstalled = preinstalled && { ...preinstalled };
  if (migrations && preinstalled) throw Error("Ambiguous database startup authorities");
  if (preinstalled) {
    if (!preinstalled.maintenance || preinstalled.maintenance === runtime || preinstalled.publicationTables !== true ||
        typeof preinstalled.verify !== "function" || "migrations" in preinstalled)
      throw Error("Preinstalled runtime requires separate maintenance and verification");
    const maintenance = preinstalled.maintenance;
    await preinstalled.verify();
    return { maintenance, publicationTables: true };
  }
  if (migrations && (migrations.migrations === runtime || migrations.maintenance === runtime ||
      migrations.migrations === migrations.maintenance))
    throw Error("Database authorities require three distinct pools");
  await migrateDatabase(migrations?.migrations ?? runtime);
  return { maintenance: migrations?.maintenance ?? runtime,
    publicationTables: migrations?.publicationTables ?? false };
}
