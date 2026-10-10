# Private upload ledger checkout lifecycle (draft 3.0.11)

[`upload-ledger-lease.ts`](../src/lib/upload-ledger-lease.ts) implements a bounded
**checkout-only lifecycle mechanism**, not the closed trusted provider required
by [the policy-pin contract](upload-resource-policy-pin.md). No runtime/public
consumer imports it. It does not change the old singleton reservation, vector
fixture SQL, migrations, budget seed, storage writer, deployment or listener.

## Implemented states

| Event | Result / ownership |
| --- | --- |
| Invalid deadline | Failed before invoking checkout; accepted range 1–60,000 integer ms. |
| Checkout throw/rejection before timeout | Failed, no query, no retry. |
| Checkout resolves first | One wrapper exclusively owns the returned client. Timer cleared. |
| Timer fires first | Timeout; no lease escapes and the operation cannot resume. |
| Client arrives after timeout | Exactly one `release(true)` attempt, no query; observer receives destroyed/failed. |
| Checkout rejects after timeout | Rejection consumed; no retry or promotion. |
| Query pending | Overlapping query rejected; release/destroy refused without invoking driver. |
| Query completed or rejected | Caller may finalize; rejection is propagated, not retried or converted to success. |
| Finalization | Finished flag set before one driver release/destroy attempt. Throw returns failed; no second attempt. |
| Query after finalization | Rejected before driver invocation. |

The private class does not expose the raw client or a raw release method. The
trusted caller must not retain/use the client outside this wrapper. Constructors
and exports are **not authorization against arbitrary in-process JavaScript**.
The caller owns transaction sequencing and must mark broken connections for
destruction. Release failure does not prove either release or destruction took
place; a failed attempt is deliberately not retried.

Checkout timeout is an event-loop deadline, not a hard real-time bound or driver
cancellation. A connect that never settles remains pool/driver-owned. It must
also have driver-level connection/pool limits; the helper cannot prove server
resource reclamation. Late disposal observers are diagnostic only. Observer
throws cannot change the timeout outcome or create an unhandled rejection.
Queries/transactions have no new timeout here; a pending query cannot be returned
to the pool merely because its caller stopped waiting.

## Evidence and strict limitations

Eleven deterministic unit cases cover checkout throw/rejection, invalid deadlines,
same-client queries, exactly-once finalization, release throw, late success,
late disposal failure, late rejection, throwing observer, pending-query ownership
and query rejection. Deferred promises control late completion and pending-query
ordering. These are **fake-driver tests**, not real PostgreSQL, connection
authentication, worker SIGKILL, failover or physical-fence evidence.

This helper has no transaction outcome or durable attempt. A COMMIT query is just
a query here: neither its rejection nor successful finalization determines
whether the database committed. The future transaction service must retain
commit-dispatched state and attempt identity, return unknown after a dispatched
COMMIT error or finalization failure, and never auto-replay or grant storage on
unknown. Existing singleton tests do not satisfy the new vector service's proof.

## Next bounded slice / activation still blocked

Build the server-owned closed provider: immutable canonical cluster+database
identity, schema and fixed qualified tables, exclusive pool provenance, and
policy binding. Do not accept a request-selected pool/schema/search_path. Compose
this lifecycle helper with that provider, then test transaction dispatch,
COMMIT uncertainty/finalization failure and no-replay with durable attempt
identity. Only then extract application vector SQL and additive unseeded
constraints. Keep migration 0008 immutable and public wiring disabled.

The full [resource mapping and physical release gates](upload-resource-reservation-mapping.md)
remain required. No DB reservation, opaque grant, filesystem IO authority,
physical writer fence, quota provenance or production promotion is implemented
or authorized by this slice.
