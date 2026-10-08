import type { Pool, PoolClient } from "pg";
import { ResumeBindings, type ResumeBinding } from "./resume-bindings";

export type OperationResult<T> = { authorized: false } | { authorized: true; value: T };

// Private persistence gate; no public/socket handler imports this yet.
// Use a dedicated pool checkout, never a caller-owned/nested transaction.
// Work MUST use this transaction for ALL writes; no network ACK, broadcast,
// filesystem operation, transaction control, or leaked/deferred query promises.
// Publish only after authorized:true. A thrown COMMIT is an uncertain outcome,
// NOT permission to publish/retry: future callers need durable idempotency.
export class ResumeOperationGate {
  constructor(private readonly pool: Pick<Pool, "connect">,
    private readonly bindings: ResumeBindings) {}

  async run<T>(binding: ResumeBinding,
    work: (transaction: Pick<PoolClient, "query">) => Promise<T>): Promise<OperationResult<T>> {
    if (!this.bindings.isCurrent(binding)) return { authorized: false };
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // Same lock order as generation CAS: room policy, then session.
      await client.query("SELECT id FROM rooms WHERE id = $1 FOR SHARE", [binding.roomId]);
      await client.query("SELECT id FROM room_resume_sessions WHERE id = $1 FOR UPDATE", [binding.sessionId]);
      const valid = async () => {
        // Separate statement AFTER both locks: clock and row values cannot be
        // snapshots taken before a lock wait. Locks remain held through COMMIT.
        const result = await client.query(`
          SELECT s.id FROM room_resume_sessions s JOIN rooms r ON r.id = s.room_id
          WHERE s.id = $1 AND s.room_id = $2 AND s.username = $3
            AND s.auth_version = $4 AND r.auth_version = s.auth_version
            AND s.generation = $5 AND s.last_transport_id = $6
            AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
        `, [binding.sessionId, binding.roomId, binding.username, binding.authVersion,
          binding.generation, binding.transportId]);
        return result.rowCount === 1 && this.bindings.isCurrent(binding);
      };
      if (!await valid()) {
        await client.query("ROLLBACK");
        return { authorized: false };
      }
      const value = await work({ query: client.query.bind(client) });
      // Roll back writes if disconnected/expired while work awaited. This is a
      // pre-COMMIT check, not a promise to cancel a COMMIT already dispatched.
      if (!await valid()) {
        await client.query("ROLLBACK");
        return { authorized: false };
      }
      await client.query("COMMIT");
      return { authorized: true, value };
    } catch (error) {
      destroy = true; // discard uncertain/failed checkout, never return success
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}
