import type { PoolClient } from "pg";

/** Private lifecycle mechanism ONLY. Trusted composition must still establish
 * cluster/database/schema/table authority. This does not authenticate a pool,
 * reserve resources, cancel a dispatched query, or grant filesystem access.
 */
type Client = Pick<PoolClient, "query" | "release">;
export type LeaseFinalization = "released" | "destroyed" | "failed";

export class UploadLedgerLease {
  #client: Client;
  #finished = false;
  #queryPending = false;
  constructor(client: Client) { this.#client = client; }

  async query(sql: string, values?: unknown[]) {
    if (this.#finished) throw Error("Upload ledger lease already finalized");
    if (this.#queryPending) throw Error("Upload ledger query already pending");
    this.#queryPending = true;
    try { return await this.#client.query(sql, values); }
    finally { this.#queryPending = false; }
  }

  /** Caller must await all queries first. Mark finished BEFORE invoking release:
   * if the driver throws, retrying release/destroy is unsafe and forbidden.
   */
  finalize(broken: boolean): LeaseFinalization | "already-finalized" | "query-pending" {
    if (this.#finished) return "already-finalized";
    if (this.#queryPending) return "query-pending";
    this.#finished = true;
    try {
      this.#client.release(broken);
      return broken ? "destroyed" : "released";
    } catch { return "failed"; }
  }
}

export type LedgerCheckout =
  | { status: "acquired"; lease: UploadLedgerLease }
  | { status: "failed" | "timeout" };

/** connect is a server-owned closure, NOT a request pool. Deadline bounds only
 * checkout. A late client is destroyed without queries; the caller stays denied.
 * A late rejection is consumed. The optional observer is diagnostic only and
 * must not retry or grant admission. A hanging connect remains driver-owned;
 * this helper cannot cancel it or prove server/pool resources were reclaimed.
 */
export function checkoutUploadLedgerClient(
  connect: () => Promise<Client>, timeoutMs: number,
  onLateFinalization?: (result: LeaseFinalization) => void,
): Promise<LedgerCheckout> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    return Promise.resolve({ status: "failed" });
  }
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ status: "timeout" });
    }, timeoutMs);
    const failed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "failed" });
    };
    try {
      void connect().then(client => {
        const lease = new UploadLedgerLease(client);
        if (settled) {
          // Fresh lease has never queried or finalized.
          const result = lease.finalize(true) as LeaseFinalization;
          try { onLateFinalization?.(result); } catch { /* diagnostic only */ }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({ status: "acquired", lease });
      }, failed);
    } catch { failed(); }
  });
}
