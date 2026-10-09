# Private resume transport ownership (3.0.10 draft)

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
