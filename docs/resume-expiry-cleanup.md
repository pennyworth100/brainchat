# Expired resume sessions (3.0.11 draft)

`ResumeStore.cleanupExpired(batchSize = 100)` is an internal primitive, not a
scheduler or public endpoint. No live environment invokes it.

- Integer batches of 1–100 session rows; DB time only, ordered by expiry and ID.
- Expiry index and `FOR UPDATE SKIP LOCKED` allow concurrent workers to skip
  busy sessions. A final DB-clock predicate checks expiry again under the lock.
- Only session locks are acquired, with no reverse room-policy lock order.
- Deletion cascades retry receipts, including tombstones, only after session
  expiry. Unexpired receipts survive even revocation or room-policy changes.
- Room messages are retained. A concurrent CAS/gated operation cannot regain
  authority from a deleted session; database errors propagate.

The cap bounds **session rows**, not receipt fan-out, lock duration, disk I/O or
total backlog. A session may own many receipts. Before wiring maintenance,
measure receipt volume, choose statement/lock budgets and cadence, account for
failed/uncertain commits, and audit index migration cost on the actual database.
No unlimited drain loop belongs on a request path. Never remove live receipts
independently: their tombstones prevent recreating deleted messages on retries.

Real PostgreSQL tests cover bounded batches, locked rows skipped, concurrent
workers, CAS waiting on cleanup, post-cleanup gate denial, receipt cascades,
unexpired/revoked tombstone retention, and preserved room history.
