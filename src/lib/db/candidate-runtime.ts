import type { PoolConfig } from "pg";

// Set by the private entrypoint BEFORE importing server/db; never from a toggle.
let config: PoolConfig | undefined;
let consumed = false;
export function configureCandidateRuntime(value: PoolConfig) {
  if (config || consumed) throw Error("Runtime database already configured");
  config = value;
}
export function consumeRuntimeConfiguration(): PoolConfig {
  consumed = true;
  return config ?? { connectionString: process.env.DATABASE_URL };
}
