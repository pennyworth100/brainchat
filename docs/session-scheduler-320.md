# Session maintenance 3.0.20

The server owns ResumeSessionScheduler after successful migrations. It starts
only after listen succeeds. ServerLifecycle stops both the rate-limit producer
and session producer before pool.end; no process deadline is interpreted as a
database rollback. Reports retain cumulative failures, even after recovery.

Each tick runs the 3.0.19 single-session, at-most-100-receipt transaction.
The next timer is set only after commit/rollback and client release, with a full
one-second idle gap. Failed runs back off exponentially to 60 seconds.
Thus one process cannot schedule more than one batch per second; this is an
upper rate bound, NOT a guaranteed throughput or a global multi-replica bound.
Timeouts, locks, pool delay and workload reduce throughput. Sustained expiry
above measured service rate needs admission/backpressure; there is no automatic
unbounded drain. No physical byte, WAL, bloat or inode guarantee is claimed.

Tests cover slow operations, synchronous/asynchronous failure, capped backoff,
cumulative failure retention, duplicate start/stop, and lifecycle settlement.
The owned PostgreSQL fixture additionally exercises the scheduler with real
server cancellation and measures a three-batch 257-receipt backlog.

No deployment, storage authority, public strict-upload activation or recovery
fence is supplied by this patch. Existing release gates remain open.
