import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { ResumeBinding } from "./resume-bindings";
import { ResumeOperationGate } from "./resume-operation";

export type ResumeTextMessage = {
  id: number; type: "message"; username: string; message: string; ts: number;
};

// Internal transaction primitive. Call ONLY within gate.run for this binding.
// No global DB, room UPDATE, ACK, broadcast or filesystem effects here.
export async function insertResumeTextMessage(transaction: Pick<PoolClient, "query">,
  binding: ResumeBinding, content: string): Promise<ResumeTextMessage> {
  if (typeof content !== "string" || !content.trim() || content.length > 10_000) {
    throw new Error("Invalid resume message");
  }
  const result = await transaction.query<{
    id: number; username: string; content: string; ts: Date;
  }>(`INSERT INTO messages (room_id, username, type, content, client_message_id, ts)
      VALUES ($1, $2, 'message', $3, NULL, clock_timestamp())
      RETURNING id, username, content, ts`, [binding.roomId, binding.username, content]);
  const row = result.rows[0];
  if (!row || !(row.ts instanceof Date) || !Number.isFinite(row.ts.getTime())) {
    throw new Error("Invalid persisted message receipt");
  }
  return { id: row.id, type: "message", username: row.username, message: row.content, ts: row.ts.getTime() };
}

// Deliberately unused by public handlers until admission/outbound fencing exists.
// One attempt only: an exception from COMMIT MAY mean the row committed. Never
// blindly retry. Session-scoped durable idempotency is a separate required step;
// do not reuse the agent (room, username, clientMessageId) identity namespace.
// A successful receipt is not authorization to broadcast after a later detach.
// touchRoom belongs AFTER commit, never under the gate's room SHARE lock.
export class ResumeMessageWriter {
  constructor(private readonly gate: ResumeOperationGate) {}

  // Explicit retry-safe API. Authorization always precedes receipt lookup.
  // The gate's session row lock serializes same-session keys across processes.
  // Do not auto-retry uncertain COMMIT; an authorized successor may resolve it.
  saveOnce(binding: ResumeBinding, clientMessageId: string, content: string) {
    return this.gate.run(binding, async tx => {
      if (typeof clientMessageId !== "string" || clientMessageId.length < 1 || clientMessageId.length > 128 ||
          /[^A-Za-z0-9_-]/.test(clientMessageId) ||
          typeof content !== "string" || !content.trim() || content.length > 10_000) {
        throw new Error("Invalid resume message identity");
      }
      const hash = createHash("sha256").update(JSON.stringify([
        binding.roomId, binding.username, "message", content,
      ])).digest("hex");
      const prior = await tx.query(`SELECT r.payload_hash, m.id, m.username, m.content, m.ts
        FROM resume_message_receipts r LEFT JOIN messages m ON m.id = r.message_id
        WHERE r.session_id = $1 AND r.client_message_id = $2`, [binding.sessionId, clientMessageId]);
      if (prior.rows.length) {
        const row = prior.rows[0];
        if (row.payload_hash !== hash) throw new Error("Resume message identity conflict");
        // Missing messages remain tombstoned: never recreate deleted content.
        if (!row.id || !(row.ts instanceof Date)) throw new Error("Resume message no longer available");
        return { id: row.id as number, type: "message" as const, username: row.username as string,
          message: row.content as string, ts: row.ts.getTime() };
      }
      const receipt = await insertResumeTextMessage(tx, binding, content);
      await tx.query(`INSERT INTO resume_message_receipts
        (session_id, client_message_id, payload_hash, message_id) VALUES ($1, $2, $3, $4)`,
        [binding.sessionId, clientMessageId, hash, receipt.id]);
      return receipt;
    });
  }

  save(binding: ResumeBinding, content: string) {
    return this.gate.run(binding, tx => insertResumeTextMessage(tx, binding, content));
  }
}
