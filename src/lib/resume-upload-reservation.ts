import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { isValidRoomId } from "./room-id";

export type UploadAttempt = Readonly<{
  storageKey: string; sessionId: string; roomId: string;
  clientMessageId: string; reservedBytes: number;
}>;
export type ReservationOutcome =
  | { status: "reserved"; attempt: UploadAttempt }
  | { status: "denied" }
  | { status: "failed"; commit: "not-dispatched" | "unknown"; attempt: UploadAttempt };

// PRIVATE DB-only primitive. Caller must authenticate and obtain live admission
// first. This is NOT an authorization/storage capability. No caller-selected
// storage key, replay, refund, deletion or timer. Await reserved before ANY body
// consumption or filesystem creation; unknown must never proceed or auto-retry.
export class ResumeUploadReservations {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async reserve(input: Omit<UploadAttempt, "storageKey">): Promise<ReservationOutcome> {
    const attempt = Object.freeze({ sessionId: input.sessionId, roomId: input.roomId,
      clientMessageId: input.clientMessageId, reservedBytes: input.reservedBytes,
      storageKey: randomBytes(32).toString("hex") });
    if (typeof attempt.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attempt.sessionId) ||
        typeof attempt.roomId !== "string" || !isValidRoomId(attempt.roomId) ||
        typeof attempt.clientMessageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(attempt.clientMessageId) ||
        !Number.isSafeInteger(attempt.reservedBytes) || attempt.reservedBytes <= 0 || attempt.reservedBytes > 104857600) {
      throw Error("Invalid upload reservation");
    }
    let client: PoolClient | undefined, commitDispatched = false;
    let broken = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // Concurrent UPDATE rechecks the predicate after the row-lock wait.
      // Counter and provenance commit atomically. Missing budget fails closed.
      const charged = await client.query(`UPDATE resume_upload_budget
        SET reserved_bytes = reserved_bytes + $1
        WHERE id = 1 AND reserved_bytes <= capacity_bytes - $1 RETURNING id`, [attempt.reservedBytes]);
      if (charged.rowCount !== 1) {
        await client.query("ROLLBACK");
        return { status: "denied" };
      }
      await client.query(`INSERT INTO resume_upload_attempts
        (storage_key, session_id, room_id, client_message_id, reserved_bytes)
        VALUES ($1, $2, $3, $4, $5)`, [attempt.storageKey, attempt.sessionId,
        attempt.roomId, attempt.clientMessageId, attempt.reservedBytes]);
      commitDispatched = true;
      await client.query("COMMIT");
      return { status: "reserved", attempt };
    } catch {
      broken = true;
      // Even successful ROLLBACK cannot disprove an acknowledged-lost COMMIT.
      if (client) { try { await client.query("ROLLBACK"); } catch { /* destroy below */ } }
      return { status: "failed", commit: commitDispatched ? "unknown" : "not-dispatched", attempt };
    } finally {
      try { client?.release(broken); } catch {
        return { status: "failed", commit: commitDispatched ? "unknown" : "not-dispatched", attempt };
      }
    }
  }
}
