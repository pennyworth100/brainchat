import type { PoolClient } from "pg";
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

  save(binding: ResumeBinding, content: string) {
    return this.gate.run(binding, tx => insertResumeTextMessage(tx, binding, content));
  }
}
