# Private operation gate: checked-out PostgreSQL socket errors

This extends the reservation fix to the shared transaction mechanics used by
ResumeOperationGate and ResumeUploadOperationGate. Product patch stays 3.0.11
(unpublished PR20, main is 3.0.10). No public route is activated.

## Reproduced failure

At parent 8db847f, an owned loopback PostgreSQL wire proxy forwarded exactly one
COMMIT and withheld the 18-byte CommandComplete/ReadyForQuery response. A direct
observer saw the diagnostic receipt before the proxy destroyed its owned sockets.
The driver rejected the query AND emitted an unhandled checked-out client error,
terminating Node. A pool error handler is insufficient: pg-pool removes its idle
error owner during checkout.

## Ownership and outcome rules

The shared execute function owns client error events through release and removes
only its own listener afterward. It records the first connection error and checks
health after policy validation, immediately before COMMIT, after COMMIT and after
release. Errors before dispatch remain not-dispatched; once COMMIT is called,
failures remain unknown. Unknown is never authorization, retry, refund, file
deletion or proof that rollback undid the commit. Legacy run still rejects.
Caller upload admission is not released by either gate.

Eight unit regressions cover both authority predicates and event delivery during
work, final validation, resolved COMMIT and release. They verify fail-closed
outcomes, dispatch counts, checkout destruction, admission retention and
preservation of other error listeners. Existing SQL wrappers now forward the
real client's event methods instead of hiding them.

The real-wire diagnostic passes for socket and upload gates: one COMMIT, observer
sees a committed receipt while the operation is pending, actual connection loss,
unknown outcome, destroyed checkout and unchanged receipt afterward. Full source
and runner are attached to the corresponding PR20 report.

## Limits

The fault is bounded destruction of owned loopback sockets, not a silent network
blackhole deadline. The database uses local trust authentication and generated
migrations; the authority binding is synthetic and receipt writes are diagnostic,
not message publication. This is not managed failover, backup, power-loss,
filesystem durability, physical quota or public activation acceptance.
