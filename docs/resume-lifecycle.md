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

server.ts now uses this composition for ordinary authenticated joins and guarded
history/presence publication; sync uses the same owner and registry. Public resume
is NOT exposed. Shared memberships now replace the old send/upload/DM/broadcast
projection. Upload admission is durable, but credential/grant/persistence/resource
integration, browser resume, snapshot-gap handling and physical-device acceptance
remain unfinished; see [upload admission](legacy-upload-admission.md).
The original loopback lifecycle unit tests use stubbed persistence; the separate
qa-public-session fixture boots the actual server with owned PostgreSQL.
