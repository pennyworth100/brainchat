# Private reservation socket-loss ownership (3.0.11 draft)

A real loopback PostgreSQL proxy forwarded COMMIT, withheld the backend's
CommandComplete(COMMIT) and ReadyForQuery messages, and then destroyed the TCP
connections. A separate direct observer proved that the budget and attempt
were committed before disconnection. On parent ae6dafa, the real checked-out
PoolClient emitted an unhandled error and terminated the diagnostic process.

pg-pool removes its idle error listener on checkout. Catching query rejection
alone does not handle the client's separate error event. ResumeUploadReservations
now owns that event until release, marks the connection broken, and removes
only its own listener after release restores pool ownership or destroys it.
An observed connection error cannot produce a reservation capability.

Four new regressions cover event failures during BEGIN, INSERT, COMMIT and
a client with no other error listener. Existing SQL test wrappers forward the
real client's event interface instead of hiding it.

The corrected local HTTP diagnostic settles without body iteration, storage
creation, capability or modeled message dispatch. The lost-response outcome is
failed/unknown, with one committed attempt and 32768 reserved bytes retained.
No automatic retry occurs during settlement; the same admission grant rejects
an explicit retry. Fresh processes after a normal owned-DB restart see exactly
the same durable rows. The control budget-denial case retains zero liability.

This remains private, unpublished patch version 3.0.11 relative to main 3.0.10.
No public route activation, deployment, live SQL or production change.
The proxy's bounded connection destruction is a test action, not proof of a
production total deadline for a silent blackhole. Synthetic binding/clock,
loopback trust authentication, normal restart and modeled dispatch remain
explicit limits. Full evidence and reproducible diagnostic are attached to PR20.
