# Private admission/membership composition (3.0.11 draft)

The optional `memberships` dependency of `attachResumeSocket` installs logical
membership after successful admission and before returning its binding. Share one
`ResumeMemberships` with the exact same `ResumeBindings` used by all owners.
Without this option the lower-level owner retains its existing behavior.

Exact accepted retries share one composed promise and install once. Invalid or
conflicting requests are not the reserved admission promise: their null result
does not close an existing valid owner or cancel an in-flight attempt.

A reserved attempt that returns null, rejects, or cannot install membership
permanently closes the owner and physically disconnects its socket. Synchronous
fencing and exact lease release precede physical disconnection; asynchronous
cleanup is not awaited on this response path. Cleanup failures go to the existing
reporter and remain observable through `close()`. No blind CAS retry or cancellation
claim: capacity remains held until underlying work settles, even after timeout.

This is private and unused by `server.ts`. It grants no room/history/presence or
outbound authority. Ordinary joins, broadcast fencing, public resume, UI and full
physical-device acceptance remain unfinished. The loopback lifecycle tests use
stubbed persistence; they are not PostgreSQL integration evidence.
