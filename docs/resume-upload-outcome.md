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

This is accounting, NOT bounded streaming implementation or durable authorization.
There is no timer-driven stream abort, multipart parser, file writer, HTTP route,
database grant validator or cleanup action here. Callers must bound parser metadata
and buffering, cancel streams safely, and retain leases until all work settles.
Before any message COMMIT a future upload-specific DB gate must revalidate the
captured generation, transport, policy, revocation and expiry under the existing
room/session locks; disconnect alone may be allowed, a successor may not. Do NOT
bypass the existing socket gate or claim this local grant authorizes persistence.

Next: upload-specific durable gate and idempotent receipt, then exclusive file
ownership, bounded streaming and fenced publication. No filesystem operations in
DB callbacks; no cleanup on deadline/unknown COMMIT. This is not upload acceptance.
