# Owned rate-limit expiry writer

All four limiters disable `clearExpiredByTimeout`. One `RateLimitCleanup` owns
the shared `rate_limits` DELETE, preserving the dependency's five-minute delay
after completion and `expire < Date.now() - 3600000` threshold (all key prefixes).
No immediate startup DELETE; the timeout is unref'ed; queries never overlap.

`stopAndSettle()` permanently stops new scheduling and waits for an already
registered query. Concurrent calls wait for the same driver settlement. Sync
throws and rejected queries increment cumulative `failedRuns`, never successful
deletion counts. Subsequent success does not erase failures. A hanging query
keeps settlement pending; this does not claim server-side cancellation.

This participant is retained in server startup but is **not yet composed into
shutdown or recovery**. No new SIGTERM handler is installed. HTTP/socket/parser,
limiter consume/block/delete, activity, cleanup, filesystem/kernel IO, migrations
and external/replica writers still require coordinated admission closure and
settlement. The callback/timer fault tests are not live PostgreSQL drain evidence.
`scripts/qa-rate-limit-cleanup.ts` additionally holds the real DELETE on a
PostgreSQL table lock: stop stays pending until release, all four prefixes are
cleaned, boundary/future/NULL expiries survive, and missing-table rejection is
reported as failure. This isolated-schema producer test is not whole-server
drain. There is no new global-fence, recovery RPO, or deployment-readiness claim.
