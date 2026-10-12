# 3.0.19 — bounded expired-session maintenance primitive

Private, unscheduled primitive. Existing normal joins issue 24-hour sessions.
The old ResumeStore.cleanupExpired remains QA-only; it must not be scheduled.

ResumeSessionCleanup owns a single acquired PG client and serial transaction.
Overlapping runOnce calls coalesce; stopAndSettle closes admission and awaits the
actual driver/commit/rollback/release chain, including pending pool acquisition.
Each run locks at most one expired session, deletes at most 100 of its receipts,
then deletes the session only if no receipt remains. All unexpired receipts,
including revoked-session tombstones, are retained. Parent FOR UPDATE excludes
concurrent FK inserts and session writers. Locked sessions are skipped.

SET LOCAL statement_timeout=500ms and lock_timeout=100ms apply on that same client.
Errors are observable; rollback is awaited and failed clients are destroyed.
A JS timeout is not used as evidence of cancellation. A network blackhole or
pool acquisition can keep settlement pending. COMMIT ambiguity is not success.

This bounds mutation row fanout, NOT physical bytes, WAL, query scan work or
table/index bloat. No live SQL, new migration, scheduler, public route enablement,
upload budget refund or upload-file/ledger deletion. Next: attach a paced owner
to server lifecycle, keep cumulative failure reporting, and test actual shutdown
during cleanup. Physical storage and public upload runtime gates remain open.
