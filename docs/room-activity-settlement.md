# Room activity settlement (3.0.11 draft)

The four message/upload activity-write sites in `server.ts` now await
`RoomActivityWriter.touch()`. A handler no longer returns while its activity SQL
promise is outstanding. Updates remain outside the resume operation room SHARE
lock, avoiding a lock-upgrade deadlock. A rejected activity update remains best
effort: it must not turn an already committed message into a failure/retry claim.
The writer retains a cumulative failure count so settlement does not imply that
all activity updates succeeded. Synchronous driver exceptions are also settled.

`settle()` waits for all currently registered work, rechecking for work admitted
while waiting. It does **not** stop admission. It is not connected to a process
signal or exposed as a production recovery/backup endpoint. No recovery fence is
claimed. Socket receipt handoff can precede activity settlement; handler completion
is the bound, not client ACK order. A permanently unresolved SQL promise keeps
settlement pending; there is no timeout that pretends cancellation or completion.

## Required before global drain

- Stop new HTTP/socket work and account for every already admitted handler,
  multipart/parser callback, upload lease, filesystem cleanup and transaction.
- Replace the four independent `rate-limiter-flexible` expiry timers with one
  owned, non-overlapping scheduler with stop-and-settle. Existing dependency
  cleanup resolves even on SQL failure; do not treat that as successful deletion.
- Only after producers stop, settle activity/background work, close the database
  pool, and establish the external/replica/filesystem boundary required by capture.
- Fault-inject actual HTTP uploads and socket work during drain. Unit tests here
  are delayed/rejected callback tests, not a live server, PostgreSQL or kernel proof.

The draft remains 3.0.11 within PR #20. Production, staging, migrations, listener,
and recovery maintenance configuration are unchanged by this patch.
