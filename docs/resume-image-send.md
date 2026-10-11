# Normal-join image send composition (3.0.11)

`sendResumeImage` is registered for normal authenticated joins in server.ts.
Text keeps its existing API and both types now use one generic send core.

- Validate bounded primitive fields and the exact current server-owned physical
  socket/owner/binding before dispatch. Payload session/username never authorize.
- Share the same process-wide 100-write capacity and physical-socket WeakSet with
  text. Injected capacity is for tests; changing it cannot bypass socket exclusion.
- Admit the durable-session image attempt/UTF-8 byte quota before invoking the
  writer (and therefore before its canonical base64 validation or DB work).
  Admitted malformed input, policy denial, retry and uncertain commit keep debt.
- Snapshot scalar fields; publish only the immutable authoritative committed
  receipt. Current owner may ACK an existing receipt, but only a new insert may
  fan out `chat-image`. Recheck owner after synchronous ACK and per recipient.
- A monotonic deadline returns `committed: null` with the original clientMessageId;
  it does not imply rollback. Hold both leases until the actual write settles,
  even after close/timeout. Suppress late ACK/fanout; report late errors once.
- ACK/partial fanout errors remain committed outcomes, never automatic replay.
  There is no outbox: a crash or owner loss after COMMIT can lose live fanout.

Physical Socket.IO fixtures cover cross-type exclusion in both directions,
aggregate capacity, copied/wrong authority, snapshot/receipt identity, ACK-only
retry, late commit/error and retained leases, owner loss, reconnect quota debt,
UTF-8 byte boundary and partial-recipient/ACK failure. Persistence is stubbed in
these composition tests; independent image writer tests and real-PostgreSQL CI
remain the persistence proof, not an end-to-end public resume acceptance claim.

Remaining: upload lifecycle, integration broadcasts, both DM authority guards,
remaining public handler migration, sessionStorage UI, snapshot/delta gap recovery and the
full accepted physical-device contract. PR remains draft; no deployment.
