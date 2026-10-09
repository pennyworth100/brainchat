import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { inventoryUploadDatabase } from "./resume-ledger-inventory";

for (const failure of ["receipt-limit", "message-query"] as const) {
  test(`reference ${failure} cannot claim complete DB observation or leak driver details`, async () => {
    const statements: string[] = [], releases: boolean[] = [];
    let receipts = 0;
    const client = {
      query: async ({ text }: { text: string }) => {
        statements.push(text);
        if (text.includes("FROM resume_upload_budget")) return { rows: [{ capacity_bytes: "100", reserved_bytes: "0" }] };
        if (text.startsWith("FETCH") && text.includes("reference_receipts")) {
          if (failure === "receipt-limit" || receipts++ === 0) return { rows: [{
            session_id: "private-session", client_message_id: "retry", message_id: null, room_id: null,
          }] };
        }
        if (text.startsWith("DECLARE reference_messages")) throw Error("PRIVATE driver SQL data");
        return { rows: [] };
      },
      release: (destroy: boolean) => releases.push(destroy),
    } as unknown as PoolClient;
    const report = await inventoryUploadDatabase(client, { pageSize: 1, maxRows: 1, timeoutMs: 1000 });
    assert.equal(report.complete, false);
    assert.equal(report.accounting, "unknown");
    assert.equal(report.references?.complete, false);
    assert.equal(report.references?.parseComplete, false);
    assert.equal(report.references?.receipts.length, 1);
    assert.equal(report.references?.receipts[0].status, "tombstone");
    assert.deepEqual(report.reasons, [failure === "receipt-limit" ? "row-limit:receipts" : "db-error:references"]);
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
    assert.deepEqual(releases, [true]);
    assert.equal(statements.filter(s => s === "ROLLBACK").length, 1);
    assert.equal(statements.filter(s => s.startsWith("BEGIN")).length, 1);
    if (failure === "receipt-limit") assert.ok(!statements.some(s => s.includes("DECLARE reference_messages")));
  });
}
