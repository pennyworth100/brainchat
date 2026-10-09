import type { PoolClient, QueryConfig, QueryResult } from "pg";
import { performance } from "node:perf_hooks";
import { isValidRoomId } from "./room-id";

export type LedgerAttempt = {
  storage_key: string; session_id: string; room_id: string;
  client_message_id: string; reserved_bytes: string; created_at: string; oversized: boolean;
};
export type LedgerInventory = {
  scope: "ledger-only"; complete: boolean; reasons: string[];
  accounting: "consistent" | "inconsistent" | "unknown";
  budget: { capacity_bytes: string; reserved_bytes: string } | null;
  attempts: LedgerAttempt[]; observedReservedBytes: string;
  startedAt: string; finishedAt: string; lastStorageKey: string | null;
  unobserved: readonly ["receipts", "messages", "filesystem"];
  crossStoreStability: "unproven";
  limits: { pageSize: number; maxRows: number; timeoutMs: number };
};

// PRIVATE, not wired to a route or scheduler. Consumes an EXCLUSIVE checked-out
// client and destroys it on exit. Caller must bound pool acquisition separately.
// No DML, refund, replay, available-capacity or reclaimability result.
export async function inventoryUploadLedger(client: PoolClient,
  limits: { pageSize: number; maxRows: number; timeoutMs: number }): Promise<LedgerInventory> {
  limits = { ...limits };
  const report: LedgerInventory = { scope: "ledger-only", complete: false, reasons: [],
    accounting: "unknown", budget: null, attempts: [], observedReservedBytes: "0",
    startedAt: new Date().toISOString(), finishedAt: "", lastStorageKey: null,
    unobserved: ["receipts", "messages", "filesystem"], crossStoreStability: "unproven",
    limits: { ...limits } };
  const start = performance.now();
  let sum = BigInt(0), phase = "begin", invalid = false;
  const amount = (value: unknown): bigint => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw Error("invalid amount");
    return BigInt(value);
  };
  try {
    if (!Number.isSafeInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > 1000 ||
        !Number.isSafeInteger(limits.maxRows) || limits.maxRows < 1 || limits.maxRows > 100000 ||
        !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 60000) {
      report.reasons.push("invalid-limits"); return report;
    }
    const query = async (text: string, values?: unknown[]): Promise<QueryResult> => {
      const remaining = Math.floor(limits.timeoutMs - (performance.now() - start));
      if (remaining <= 0) throw Object.assign(Error(), { code: "DEADLINE" });
      const config: QueryConfig & { query_timeout: number } = { text, values, query_timeout: remaining };
      return client.query(config);
    };
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await query("SELECT set_config('statement_timeout', $1, true)", [String(limits.timeoutMs)]);
    phase = "budget";
    const budgets = (await query(`SELECT capacity_bytes::text, reserved_bytes::text
      FROM resume_upload_budget WHERE id=1 LIMIT 2`)).rows;
    if (budgets.length !== 1) { invalid = true; report.reasons.push("missing-budget"); }
    else {
      report.budget = budgets[0];
      try {
        const capacity = amount(budgets[0].capacity_bytes), reserved = amount(budgets[0].reserved_bytes);
        if (capacity <= BigInt(0) || capacity > BigInt("9007199254740991") || reserved > capacity) throw Error();
      } catch { invalid = true; report.reasons.push("invalid-budget"); }
    }
    phase = "attempts";
    // SQL-side text bounds prevent malformed legacy text columns from making
    // a row arbitrarily large. Oversized provenance is explicitly invalid.
    await query(`DECLARE ledger_inventory NO SCROLL CURSOR FOR
      SELECT storage_key, left(session_id,128) AS session_id, left(room_id,128) AS room_id,
        client_message_id, reserved_bytes::text, created_at::text,
        (length(session_id)>128 OR length(room_id)>128) AS oversized
      FROM resume_upload_attempts ORDER BY storage_key`);
    while (true) {
      const count = Math.min(limits.pageSize, limits.maxRows - report.attempts.length + 1);
      const rows = (await query(`FETCH FORWARD ${count} FROM ledger_inventory`)).rows as LedgerAttempt[];
      for (const row of rows) {
        if (report.attempts.length === limits.maxRows) {
          report.reasons.push("row-limit"); return report;
        }
        report.attempts.push(row);
        try {
          const charge = amount(row.reserved_bytes);
          if (charge <= BigInt(0) || charge > BigInt(104857600) || row.oversized ||
              !/^[0-9a-f]{64}$/.test(row.storage_key) || !isValidRoomId(row.room_id) ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.session_id) ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(row.client_message_id) ||
              (report.lastStorageKey !== null && row.storage_key <= report.lastStorageKey)) throw Error();
          sum += charge;
        } catch { invalid = true; if (!report.reasons.includes("invalid-attempt")) report.reasons.push("invalid-attempt"); }
        report.lastStorageKey = row.storage_key;
        report.observedReservedBytes = sum.toString();
      }
      if (rows.length < count) break;
    }
    phase = "finish";
    await query("ROLLBACK");
    report.complete = true;
    report.accounting = invalid || !report.budget || sum !== amount(report.budget.reserved_bytes)
      ? "inconsistent" : "consistent";
    if (report.accounting === "inconsistent" && !invalid) report.reasons.push("counter-sum-mismatch");
  } catch (error) {
    const code = (error as { code?: string }).code;
    report.reasons.push(code === "DEADLINE" || code === "57014" ||
      (error as Error).message === "Query read timeout" ? "deadline" : "db-error:" + phase);
    // Never include driver error text: it can contain connection or query data.
    report.complete = false; report.accounting = "unknown";
  } finally {
    // Destroying an owned connection rolls back incomplete read-only transactions
    // and prevents reuse after a client-side timeout with a query still in flight.
    try { client.release(true); } catch { report.complete = false; report.accounting = "unknown"; report.reasons.push("release-error"); }
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
