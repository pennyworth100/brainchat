import type { PoolClient, QueryConfig, QueryResult } from "pg";
import { performance } from "node:perf_hooks";
import { isValidRoomId } from "./room-id";
import { collectUploadReferences, type ReferenceInventory } from "./resume-reference-inventory";
import { classifyReferenceFacts, type ReferenceFacts } from "./resume-reference-facts";

export type LedgerAttempt = {
  storage_key: string; session_id: string; room_id: string;
  client_message_id: string; reserved_bytes: string; created_at: string; oversized: boolean;
  // Attempt-local snapshot comparison, not receipt agreement or authorization.
  identityEvidence?: { sessionRoom: "match" | "conflict" | "unobserved" };
};
export type LedgerInventory = {
  scope: "ledger-only" | "database-only"; complete: boolean; reasons: string[];
  accounting: "consistent" | "inconsistent" | "unknown";
  budget: { capacity_bytes: string; reserved_bytes: string } | null;
  attempts: LedgerAttempt[]; observedReservedBytes: string;
  startedAt: string; finishedAt: string; lastStorageKey: string | null;
  unobserved: readonly string[];
  references?: ReferenceInventory;
  referenceFacts?: ReferenceFacts;
  crossStoreStability: "unproven";
  limits: { pageSize: number; maxRows: number; timeoutMs: number };
};

// PRIVATE, not wired to a route or scheduler. Consumes an EXCLUSIVE checked-out
// client and destroys it on exit. Caller must bound pool acquisition separately.
// Consumption includes ROLLBACK of any inherited transaction. Never pass a
// connection whose pending work must be preserved or shared with another owner.
// No DML, refund, replay, available-capacity or reclaimability result.
export async function inventoryUploadLedger(client: PoolClient,
  limits: { pageSize: number; maxRows: number; timeoutMs: number }): Promise<LedgerInventory> {
  return inventoryDatabase(client, limits, false);
}

export async function inventoryUploadDatabase(client: PoolClient,
  limits: { pageSize: number; maxRows: number; timeoutMs: number }): Promise<LedgerInventory> {
  return inventoryDatabase(client, limits, true);
}

async function inventoryDatabase(client: PoolClient,
  limits: { pageSize: number; maxRows: number; timeoutMs: number }, references: boolean): Promise<LedgerInventory> {
  limits = { ...limits };
  const report: LedgerInventory = { scope: "ledger-only", complete: false, reasons: [],
    accounting: "unknown", budget: null, attempts: [], observedReservedBytes: "0",
    startedAt: new Date().toISOString(), finishedAt: "", lastStorageKey: null,
    unobserved: ["receipts", "messages", "filesystem"], crossStoreStability: "unproven",
    limits: { ...limits } };
  if (references) {
    report.scope = "database-only";
    report.unobserved = ["filesystem"];
    report.references = { receipts: [], messages: [], complete: false, parseComplete: false, metadataComplete: false, reasons: [] };
  }
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
    // BEGIN inside an existing transaction does not necessarily create a new
    // snapshot. Reset even an aborted or read-only transaction before starting
    // this observation; never commit work inherited from the exclusive owner.
    phase = "reset";
    await query("ROLLBACK");
    phase = "begin";
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
      SELECT a.storage_key, left(a.session_id,128) AS session_id, left(a.room_id,128) AS room_id,
        a.client_message_id, a.reserved_bytes::text, a.created_at::text,
        (length(a.session_id)>128 OR length(a.room_id)>128) AS oversized
        ${references ? `, CASE WHEN length(a.session_id)<=128 AND length(a.room_id)<=128
          AND length(s.id)<=128 AND length(s.room_id)<=128
          THEN a.room_id=s.room_id END AS session_room_match` : ""}
      FROM resume_upload_attempts a
      ${references ? "LEFT JOIN room_resume_sessions s ON s.id=a.session_id" : ""}
      ORDER BY a.storage_key`);
    while (true) {
      const count = Math.min(limits.pageSize, limits.maxRows - report.attempts.length + 1);
      const rows = (await query(`FETCH FORWARD ${count} FROM ledger_inventory`)).rows as (LedgerAttempt & { session_room_match?: boolean | null })[];
      for (const raw of rows) {
        const { session_room_match: sessionRoom, ...row } = raw;
        if (references) row.identityEvidence = { sessionRoom: sessionRoom === true ? "match" : sessionRoom === false ? "conflict" : "unobserved" };
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
    if (report.references) {
      phase = "references";
      await collectUploadReferences(query, limits, report.references);
      report.referenceFacts = classifyReferenceFacts(report.attempts, report.references);
      if (!report.references.complete) {
        report.reasons.push(...report.references.reasons); return report;
      }
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
