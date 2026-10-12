import type { Pool, PoolClient } from "pg";

export type SessionCleanupResult = { sessions: number; receipts: number };

/** Private maintenance primitive. No scheduler/public activation.
 * One session and at most 100 receipts per transaction; never cascade a backlog.
 * Row counts are NOT a physical byte/WAL bound. Each SQL statement has a server
 * timeout, not a JavaScript race. Transport loss may keep settlement pending.
 */
export class ResumeSessionCleanup {
  private active?: Promise<SessionCleanupResult>;
  private stopped = false;
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  runOnce(): Promise<SessionCleanupResult> {
    if (this.stopped) return Promise.reject(Error("Session cleanup stopped"));
    if (this.active) return this.active;
    const task = Promise.resolve().then(() => this.execute());
    this.active = task;
    void task.then(() => { this.active = undefined; }, () => { this.active = undefined; });
    return task;
  }

  async stopAndSettle(): Promise<void> {
    this.stopped = true;
    // Rejection remains visible; stopping does not mean a failed transaction passed.
    await this.active;
  }

  private async execute(): Promise<SessionCleanupResult> {
    const client: PoolClient = await this.pool.connect();
    let failed = false;
    let connectionError: Error | undefined;
    const onError = (error: Error) => { connectionError = error; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '500ms'");
      await client.query("SET LOCAL lock_timeout = '100ms'");
      const selected = await client.query<{ id: string }>(`
        SELECT id FROM room_resume_sessions
        WHERE expires_at <= statement_timestamp()
        ORDER BY expires_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      `);
      let receipts = 0, sessions = 0;
      if (selected.rows.length) {
        const id = selected.rows[0].id;
        // Parent FOR UPDATE blocks FK insertion and serializes normal writers.
        // Do not SKIP LOCKED receipts: a timeout must roll back this transaction.
        const removed = await client.query(`
          WITH batch AS MATERIALIZED (
            SELECT session_id, client_message_id FROM resume_message_receipts
            WHERE session_id = $1 ORDER BY client_message_id LIMIT 100 FOR UPDATE
          )
          DELETE FROM resume_message_receipts r USING batch b
          WHERE r.session_id = b.session_id AND r.client_message_id = b.client_message_id
        `, [id]);
        receipts = removed.rowCount ?? 0;
        // Separate statement observes our deletes. Never invoke an unbounded
        // cascade; retained tombstones for every unexpired session are untouched.
        const removedSession = await client.query(`
          DELETE FROM room_resume_sessions s WHERE s.id = $1
            AND s.expires_at <= statement_timestamp()
            AND NOT EXISTS (SELECT 1 FROM resume_message_receipts r WHERE r.session_id = s.id)
        `, [id]);
        sessions = removedSession.rowCount ?? 0;
      }
      await client.query("COMMIT");
      if (connectionError) throw connectionError;
      return { sessions, receipts };
    } catch (error) {
      failed = true;
      // Wait for actual server rollback acknowledgement. No fire-and-forget
      // cancellation/release and no uncertain client returned to the pool.
      try { await client.query("ROLLBACK"); } catch { /* destroy below */ }
      throw error;
    } finally {
      client.removeListener("error", onError);
      client.release(failed || !!connectionError);
    }
  }
}
