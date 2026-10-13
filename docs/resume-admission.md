# Private pre-CAS admission seam (3.0.11 draft)

Create one ResumeAdmission for each physical server-owned connection incarnation.
Never create one per request, reuse a transport ID, or mix direct/ordinary join
paths on that connection. The future socket adapter must enforce this ownership.
No public handlers import this seam yet; this is not public resume readiness.

The first valid-token request synchronously reserves one immutable operation
before DB dispatch. Exact retries share the original result, including rejection;
different session/room/token/generation/operation requests never call the DB.
Failure is terminal for that incarnation. Explicit recovery requires a fresh
connection, non-authorizing lookup and a new operation; no blind CAS replay.

Close fences synchronously. It cannot cancel an already-dispatched DB CAS; that
CAS may advance generation even after disconnect. Its late result cannot install
a binding. A successful CAS installs only through the existing binding registry,
rechecking connection and exact authority after asynchronous preparation.

Preparation must not expose room traffic/history/presence. It must return an
exact lease disposer, and clean its own partial work if it throws. A disposer
must not remove successor membership or global room state. Failed/stale leases
are disposed once; cleanup errors fail closed and must be surfaced by the adapter.
close waits for pending work, so DB/adapter deadlines remain an integration need.

This is not socket eviction, an outbound/network authority guard, an admission
rate limiter, a distributed lock or cancellation of a committed DB operation.
Remaining: real per-socket ownership, bounded lifecycle/deadlines, old-socket
eviction, presence/outbound fencing, protected handlers and physical acceptance.
