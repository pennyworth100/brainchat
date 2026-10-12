# Private resume transport ownership (3.0.11 draft)

The single-process registry reserves each server-owned transport incarnation for
one pending or active session before awaiting preparation. A different session
is rejected before preparation, without cancelling either existing binding or
advancing its local generation fence. No implicit room switch is permitted.

An authenticated higher generation of the same session may replace its binding;
its previous transport reservation is released immediately. An exact active
same-binding ACK retry returns the original binding without preparation.

Failure, disconnect, detach and expiry release only the exact owning slot.
Generation tombstones remain until absolute session expiry. A delayed failure,
completion or old-session disconnect cannot erase a successor reservation, even
when the same transport now belongs to another session. Overload still rejects;
it never evicts an unexpired generation fence.

Transport IDs must be unique server-owned connection incarnations, never a client
claim or a stable browser ID reused across physical connections. The eventual
adapter must also reject use of disconnected incarnations and clean up stale
room membership. Releasing this registry reservation does not leave a Socket.IO
room or authorize a network effect.

This is not admission control before database CAS, a distributed ownership
protocol, a public socket adapter, or a completed resume feature. Database
transaction gates remain mandatory for protected writes. No public wiring or
deployment is included.

Regression evidence covers pending/active cross-session contention, conflict
without fencing either owner, same-transport generation replacement, late
failure/success/disconnect, expiry sweep, exact ACK retry and resource release.
PostgreSQL integration fixtures use independent transport incarnations for
independent sessions, and explicitly reject a conflicting session on an active
transport.

## Private operation outcome observation (3.0.33 draft)

`ResumeStore.operationOutcome` authenticates the bearer against the session,
room, expiry, revocation and current room policy. It returns only a string:

- `own-applied`: the retained last operation matches the original operation ID
  and its generation is exactly the expected generation plus one.
- `superseded`: a different retained operation occupies that exact next generation.
  This describes the requested CAS, not the browser/user who owns the credential.
- `unknown`: no matching live authorization, no retained receipt, a mismatched
  generation or overwritten history. It does not mean the operation failed.

Database failures propagate; the caller must remain uncertain/fail closed.
Reads never extend expiry, mutate generation, return a transport identity, grant
membership or make the browser ready. They are only point-in-time observations;
even `own-applied` may be obsolete before its caller receives it. Operation IDs
must be fresh and preserved for their original attempt, not reused as identity.

There is no public endpoint or browser recovery wiring in this change. A future
recovery transfer needs one atomic predicate over the original operation and
generation, current authorization and expiry; an intervening competitor must
make it fail. Lookup/outcome followed by a blind CAS is forbidden. Full-sync,
exact membership fencing, file-byte identity and public acceptance remain gates.
