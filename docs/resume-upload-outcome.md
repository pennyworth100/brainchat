# Private upload foundation: settled transaction outcomes

Public upload/resume handlers remain unchanged and OFF for this primitive.
`ResumeOperationGate.runWithOutcome` uses the same exact live binding and durable
pre/post-work policy checks as `run`; it does not extend authority beyond socket
disconnect. Existing `run` callers retain their original thrown errors.

- Completed + authorized: COMMIT was acknowledged. Publication still needs an
  exact current owner. A receipt is not proof of delivery.
- Completed + denied: this attempt did not commit.
- Failed + `not-dispatched`: this attempt never sent COMMIT, including checkout,
  BEGIN, callback or rollback errors. Its transaction cannot commit on its own.
- Failed + `unknown`: COMMIT was dispatched. Even a subsequent successful
  ROLLBACK cannot disprove a commit whose acknowledgement was lost. Retain any
  potentially referenced attachment. No automatic retry, unlink or publication.

A hung operation stays pending; disconnect/deadline is not a rollback receipt.
The classification applies ONLY to this attempt. It does not resolve an earlier
attempt using the same durable idempotency key. Future cleanup may delete only
an exclusively owned staged file proven unreferenced by **every** attempt; never
an arbitrary client path or a reused attachment. A process crash requires durable
reconciliation, not guessing based on file age. Filesystem work remains outside
the database callback, which must not control transactions or leak queries.

## Private admission accounting (not wired)

`ResumeUploadAdmissions` captures an exact live server-owned binding in an opaque,
immutable grant. Ordinary socket disconnect does not invalidate this already
admitted HTTP lifetime. Any successor generation, including pending or failed
preparation, fences it permanently. Copied bindings/grants cannot acquire authority.
This does not change `ResumeOperationGate`: that gate still requires a live socket.

One unresolved lease per session per registry and a shared process capacity of
100 bound admission. Instantiate one registry per server. Each raw chunk must be
accounted before forwarding; the cumulative limit is at most 100 MiB, independent
of Content-Length. A monotonic deadline of at most 120 seconds and absolute session
expiry fence subsequent work. Rejection is latched. Deadline, disconnect and
generation replacement do NOT release capacity: only actual settlement allows
the server finalizer to release. A stalled lease consumes capacity and fails closed.

Admission alone is accounting, NOT streaming implementation or durable authorization.
There is no timer-driven stream abort, multipart parser, file writer, HTTP route,
HTTP integration or cleanup action here. Callers must bound parser metadata
and buffering, cancel streams safely, and retain leases until all work settles.
The private `ResumeUploadOperationGate.runWithOutcome` now validates the exact
issued grant before checkout, then its captured session/room/username, generation,
transport, policy, revocation and DB-clock expiry AFTER room FOR SHARE and session
FOR UPDATE locks, both before and after transactional work. Ordinary disconnect
alone is allowed; local pending/failed successors and durable successors deny.
Grant release, latched byte denial and monotonic deadline fence pre-COMMIT work.
The shared transaction mechanics preserve the distinct live-socket predicate of
`ResumeOperationGate`; no existing socket authority was extended.

The upload gate never releases the admission lease. Finalizers must await ALL
stream, file and DB settlement, including a pending COMMIT. A deadline does not
cancel a dispatched COMMIT. Lost ACKs remain unknown; no automatic retry,
publication or unlink follows. This is a database-only result, not a file receipt.

Next: session/key-scoped durable idempotent file receipt, then exclusive file
ownership, bounded streaming and fenced publication. No filesystem operations in
DB callbacks; no cleanup on deadline/unknown COMMIT. This is not upload acceptance.
