import type { ResumeBinding } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";

type HistoryRow = { id: number; type: string; username: string; content: string; ts: Date };

// PRIVATE: compose with publishJoin/publishResume, never a raw socket handler.
// A successful read is not authority for a later handoff: publication must still
// recheck the exact membership/owner. No snapshot/delta gap guarantee is implied.
export class ResumeHistoryReader {
  constructor(private readonly gate: ResumeOperationGate) {}

  async read(binding: ResumeBinding): Promise<readonly unknown[] | null> {
    const result = await this.gate.run(binding, async tx => {
      // Same newest-100, ascending-ID projection as server.ts loadHistory.
      // Never select session credentials, receipts or global/cross-room history.
      const rows = await tx.query<HistoryRow>(`SELECT id, type, username, content, ts
        FROM messages WHERE room_id = $1 ORDER BY id DESC LIMIT 100`, [binding.roomId]);
      return rows.rows.reverse().map(row => {
        if (!(row.ts instanceof Date) || !Number.isFinite(row.ts.getTime())) {
          throw new Error("Invalid persisted history timestamp");
        }
        const metadata = { id: row.id, type: row.type, username: row.username, ts: row.ts.getTime() };
        if (row.type === "message") return { ...metadata, message: row.content };
        try { return { ...JSON.parse(row.content), ...metadata }; }
        catch { return { ...metadata, message: row.content }; }
      });
    });
    // Denied reads cannot publish even if the query completed before expiry or
    // detach. Query/COMMIT errors propagate; no cache, retry or partial result.
    return result.authorized ? result.value : null;
  }
}
