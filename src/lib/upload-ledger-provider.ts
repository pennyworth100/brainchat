/** Private trusted composition ONLY. No runtime consumer or storage authority.
 * Owns its pool, pins policy provenance, and verifies the connected cluster/DB.
 * See docs/upload-ledger-provider.md before composing a transaction service.
 */
import { Pool } from "pg";
import { checkoutUploadLedgerClient } from "./upload-ledger-lease";
import { pinUploadResourcePolicy, type UploadResourcePolicyPin } from "./upload-resource-policy-pin";

export type UploadLedgerConfiguration = Readonly<{
  host: string; port: number; user: string; password: string;
  database: string; clusterIdentity: string; systemIdentifier: string; ca?: string;
}>;
const tables = Object.freeze({
  domains: '"public"."upload_resource_domains"',
  policies: '"public"."upload_resource_policies"',
  attempts: '"public"."upload_resource_attempts"',
});
const identitySql = `SELECT pg_catalog.current_database() AS database,
  system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()`;
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Config is provisioning-owned plain data, never request input. No pool, client,
 * SQL identifier, search_path, TLS downgrade or arbitrary pg options accepted.
 * Construction is inert: pg opens connections only when checkout is requested.
 */
export function createUploadLedgerProvider(config: UploadLedgerConfiguration) {
  // Snapshot every retained primitive before any await; never retain config.
  const { host, port, user, password, database, clusterIdentity, systemIdentifier, ca } = config;
  if (!text(host) || host.includes("/") || !text(user) || !text(database) || !text(clusterIdentity) || typeof password !== "string" ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof systemIdentifier !== "string" || !/^[1-9][0-9]{0,19}$/.test(systemIdentifier) ||
      BigInt(systemIdentifier) > 18446744073709551615n ||
      (ca !== undefined && (typeof ca !== "string" || !ca.length))) {
    throw Error("Invalid trusted upload ledger configuration");
  }
  // Provisioning must supply ONE canonical identity across endpoint aliases.
  // A clone can share system ID: endpoint/TLS and clone/failover provenance remain ops gates.
  const binding = Object.freeze({ database: JSON.stringify([clusterIdentity, database]),
    schema: "public" as const, tables });
  const pool = new Pool({ host, port, user, password: async () => password, database,
    ssl: { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) },
    max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000,
    lock_timeout: 2000, idle_in_transaction_session_timeout: 10000,
    options: "-c search_path=pg_catalog" });
  let closed = false, poisoned = false;
  // pg-pool removes its idle error listener while a client is checked out.
  // Keep a provider-owned lifetime listener so an active connection error also
  // fails closed instead of becoming an unhandled EventEmitter error.
  pool.on("connect", client => { client.on("error", () => { poisoned = true; }); });
  // pg removes the failed idle client. Deny further checkouts; do not log secrets
  // or turn an unhandled EventEmitter error into process termination.
  pool.on("error", () => { poisoned = true; });
  const ownedPins = new WeakSet<UploadResourcePolicyPin>();

  return Object.freeze({
    binding,
    /** Only trusted server policy. Namespace/domain/version/generation must be
     * provisioned by the future service, never selected by an upload request.
     */
    pin(policy: unknown): UploadResourcePolicyPin | null {
      if (closed || poisoned || !policy || typeof policy !== "object") return null;
      const descriptor = Object.getOwnPropertyDescriptor(policy, "identity");
      if (!descriptor || !("value" in descriptor) || !descriptor.value ||
          typeof descriptor.value !== "object") return null;
      const expected: Record<string, unknown> = { database: binding.database, schema: binding.schema };
      for (const key of ["namespace", "quotaDomain", "policyVersion", "writerGeneration"]) {
        const field = Object.getOwnPropertyDescriptor(descriptor.value, key);
        if (!field || !("value" in field)) return null;
        expected[key] = field.value;
      }
      const pin = pinUploadResourcePolicy(policy, expected);
      if (pin) ownedPins.add(pin);
      return pin;
    },
    async checkout(pin: UploadResourcePolicyPin) {
      if (closed || poisoned || !pin || typeof pin !== "object" || !ownedPins.has(pin)) {
        return { status: "failed" as const };
      }
      const result = await checkoutUploadLedgerClient(() => pool.connect(), 5000);
      if (result.status !== "acquired") return result;
      try {
        if (closed || poisoned) throw Error("Provider unavailable");
        const identity = await result.lease.query(identitySql);
        if (closed || poisoned || identity.rowCount !== 1 || identity.rows.length !== 1 ||
            identity.rows[0].database !== database || identity.rows[0].system_identifier !== systemIdentifier) {
          throw Error("Upload ledger connection identity mismatch");
        }
        return { status: "acquired" as const, lease: result.lease, binding, pin };
      } catch {
        // No BEGIN/mutation has run. Failed identity probing never releases an
        // unverified connection for reuse. Exactly one disposal attempt.
        result.lease.finalize(true);
        return { status: "failed" as const };
      }
    },
    /** Shutdown only; pool.end waits for active leases. No forced query release. */
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  });
}
