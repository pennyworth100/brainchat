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

Next: generation-preserving HTTP admission with bounded streaming, exclusive
file ownership and durable receipt resolution. Explicitly reconcile the desired
HTTP lifetime with the current gate (disconnect currently denies before COMMIT),
then add a file writer and fenced publication. This is not upload acceptance.
