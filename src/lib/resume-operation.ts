import type { Pool, PoolClient } from "pg";
import { ResumeBindings, type ResumeBinding } from "./resume-bindings";
import { ResumeUploadAdmissions, type ResumeUploadGrant } from "./resume-upload-admission";

export type OperationResult<T> = { authorized: false } | { authorized: true; value: T };

// Settled attempt only, never a timeout/cancellation result. "not-dispatched"
// says THIS attempt did not send COMMIT, not that an earlier retry did not commit.
export type OperationOutcome<T> = { completed: true; result: OperationResult<T> } |
  { completed: false; commit: "not-dispatched" | "unknown"; error: unknown };

// Persistence gate, now used by public normal-join/sync history reads.
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
    return execute(this.pool, binding, () => this.bindings.isCurrent(binding), work, () => {});
  }

  // Validate both DM endpoints in ONE transaction. Never hold locks while
  // waiting for a network ACK. Call again after ACK, then fence local handoff.
  async authorizePair(sender: ResumeBinding, recipient: ResumeBinding): Promise<boolean> {
    if (sender.roomId !== recipient.roomId) return false;
    const current = () => this.bindings.isCurrent(sender) && this.bindings.isCurrent(recipient);
    const result = await execute(this.pool, sender, current, async () => true, () => {}, recipient);
    return result.authorized && current();
  }

  // Private upload foundation. Keep legacy run's original rejection behavior.
  // Unknown outcomes retain potentially referenced files; a successful ROLLBACK
  // after a failed COMMIT does NOT establish that COMMIT failed. No retries here.
  async runWithOutcome<T>(binding: ResumeBinding,
    work: (transaction: Pick<PoolClient, "query">) => Promise<T>): Promise<OperationOutcome<T>> {
    let commitDispatched = false;
    try {
      const result = await execute(this.pool, binding, () => this.bindings.isCurrent(binding), work, () => { commitDispatched = true; });
      return { completed: true, result };
    } catch (error) {
      return { completed: false, commit: commitDispatched ? "unknown" : "not-dispatched", error };
    }
  }

}

// PRIVATE admitted HTTP lifetime: disconnect alone is allowed; a successor,
// expired/released/copied grant or durable policy change is not. This gate does
// not release the lease: the finalizer must await ALL stream/file/DB settlement.
// No filesystem effects in work; a durable receipt is not publication authority.
export class ResumeUploadOperationGate {
  constructor(private readonly pool: Pick<Pool, "connect">,
    private readonly admissions: ResumeUploadAdmissions) {}

  async runWithOutcome<T>(grant: ResumeUploadGrant,
    work: (transaction: Pick<PoolClient, "query">) => Promise<T>): Promise<OperationOutcome<T>> {
    let commitDispatched = false;
    try {
      const result = await execute(this.pool, grant.binding,
        () => this.admissions.isCurrent(grant), work, () => { commitDispatched = true; });
      return { completed: true, result };
    } catch (error) {
      return { completed: false, commit: commitDispatched ? "unknown" : "not-dispatched", error };
    }
  }
}

// Shared transaction mechanics only; callers supply their DISTINCT authority
// predicate. Never substitute upload lifetime for socket-operation authority.
async function execute<T>(pool: Pick<Pool, "connect">, binding: ResumeBinding,
    isCurrent: () => boolean,
    work: (transaction: Pick<PoolClient, "query">) => Promise<T>,
    beforeCommit: () => void, peer?: ResumeBinding): Promise<OperationResult<T>> {
    if (!isCurrent()) return { authorized: false };
    const client = await pool.connect();
    let destroy = false;
    let connectionError: Error | undefined;
    // pg-pool owns idle errors only. Own checked-out errors through release,
    // including gaps between queries while caller work awaits.
    const onClientError = (error: Error) => { destroy = true; connectionError ??= error; };
    const assertHealthy = () => { if (connectionError) throw connectionError; };
    try {
      client.on("error", onClientError);
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      // Same lock order as generation CAS: room policy, then session.
      await client.query("SELECT id FROM rooms WHERE id = $1 FOR SHARE", [binding.roomId]);
      // Stable order prevents reciprocal DMs from locking A/B and B/A.
      const identities = peer && peer !== binding ? [binding, peer].sort((a, b) =>
        a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) : [binding];
      for (const identity of identities) {
        await client.query("SELECT id FROM room_resume_sessions WHERE id = $1 FOR UPDATE", [identity.sessionId]);
      }
      const valid = async () => {
        // Separate statement AFTER both locks: clock and row values cannot be
        // snapshots taken before a lock wait. Locks remain held through COMMIT.
        for (const identity of identities) {
          const result = await client.query(`
            SELECT s.id FROM room_resume_sessions s JOIN rooms r ON r.id = s.room_id
            WHERE s.id = $1 AND s.room_id = $2 AND s.username = $3
              AND s.auth_version = $4 AND r.auth_version = s.auth_version
              AND s.generation = $5 AND s.last_transport_id = $6
              AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
          `, [identity.sessionId, identity.roomId, identity.username, identity.authVersion,
            identity.generation, identity.transportId]);
          assertHealthy();
          if (result.rowCount !== 1 || !isCurrent()) return false;
        }
        return isCurrent();
      };
      if (!await valid()) {
        await client.query("ROLLBACK");
        return { authorized: false };
      }
      const value = await work({ query: client.query.bind(client) });
      // Roll back writes if caller authority expires while work awaited. This is a
      // pre-COMMIT check, not a promise to cancel a COMMIT already dispatched.
      if (!await valid()) {
        await client.query("ROLLBACK");
        return { authorized: false };
      }
      // Mark BEFORE calling the driver, including synchronous driver failures.
      assertHealthy();
      beforeCommit();
      await client.query("COMMIT");
      assertHealthy();
      return { authorized: true, value };
    } catch (error) {
      destroy = true; // discard uncertain/failed checkout, never return success
      try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      try {
        client.release(destroy);
        assertHealthy();
      } finally {
        // Preserve other owners; pg-pool has resumed ownership or destroyed.
        client.removeListener("error", onClientError);
      }
    }
  }
