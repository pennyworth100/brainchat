# Private admission limits (3.0.10 draft)

No public handler or deployment is enabled. Physical socket owners share a
process-local budget of 100 unresolved admissions and a 10-second admission
deadline. Server composition may supply a shared budget/deadline; never allocate
a new budget per request. This bounds work count, not DB time, bytes, sockets,
active sessions or per-client request rate. Multi-process limits remain separate.

Capacity is reserved synchronously before CAS. Exact retries share the original
promise and permit. Overload is terminal for that incarnation and causes no DB
call or automatic retry. A new physical transport may explicitly recover later.

Timeout resolves admission as null and permanently fences authority. It does NOT
cancel PostgreSQL or prove CAS rollback. Monotonic deadline checks also fence
activation if the timer is delayed by the event loop. Capacity remains held until
underlying CAS/preparation and any late exact-lease disposal actually settle.
Disconnect likewise cannot release an unresolved permit. A permanently hung
operation can therefore exhaust capacity: reject new work, do not grow a queue.

Successful admission cancels the deadline and releases the work permit; active
authority still depends on binding ownership and absolute DB expiry. close may
wait indefinitely for unresolved work. Late errors after a timeout are reported
through the captured error callback; reporter failure is logged. Preparers must
clean partial failure themselves and must never install outbound access.

Tests cover coalescing, saturation before CAS, timeout with a hung CAS/preparer,
disconnect, late cleanup failure, permit retention/release, explicit recovery,
successful authority surviving the admission timer, and invalid configuration.
