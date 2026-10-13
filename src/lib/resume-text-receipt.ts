import { createHash } from "node:crypto";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeOperationGate } from "./resume-operation";
import type { ResumeTextMessage } from "./resume-message";

// Read-only resolution, never saveOnce. Absence/denial/deletion is UNKNOWN,
// not evidence that a send did not commit and never permission to retransmit.
export class ResumeTextReceiptReader {
  constructor(private readonly gate: ResumeOperationGate) {}
  async read(binding: ResumeBinding, request: unknown): Promise<ResumeTextMessage | null> {
    if (!request || typeof request !== "object" || Array.isArray(request)) return null;
    const r = request as Record<string, unknown>;
    if (r.roomId !== binding.roomId || r.sessionId !== binding.sessionId || r.type !== "message" ||
        typeof r.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.clientMessageId) ||
        typeof r.message !== "string" || !r.message.trim() || r.message.length > 10000) return null;
    const key = r.clientMessageId, content = r.message;
    const hash = createHash("sha256").update(JSON.stringify([
      binding.roomId, binding.username, "message", content,
    ])).digest("hex");
    const result = await this.gate.run(binding, async tx => {
      const rows = await tx.query(`SELECT r.payload_hash, m.id, m.room_id, m.type, m.username, m.content, m.ts
        FROM resume_message_receipts r LEFT JOIN messages m ON m.id=r.message_id
        WHERE r.session_id=$1 AND r.client_message_id=$2`, [binding.sessionId, key]);
      const row = rows.rows[0];
      if (rows.rows.length !== 1 || !row || row.payload_hash !== hash ||
          !Number.isSafeInteger(row.id) || row.id < 1 || row.room_id !== binding.roomId ||
          row.type !== "message" || row.username !== binding.username || row.content !== content ||
          !(row.ts instanceof Date) || !Number.isFinite(row.ts.getTime())) return null;
      return { id: row.id as number, type: "message" as const, username: binding.username,
        message: content, ts: row.ts.getTime() };
    });
    return result.authorized ? result.value : null;
  }
}
