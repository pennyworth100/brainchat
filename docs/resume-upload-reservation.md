# Private durable upload reservation (3.0.11 draft)

`ResumeUploadReservations` is a private DB primitive, now composed by
ResumeFileStorage with exact upload admission. NOT wired to HTTP, parser,
publication or any public handler. No deployment is authorized
by this slice. Migration 0008 creates two empty additive tables; an absent singleton
budget denies reservations. Production/staging budgets are NOT provisioned.

A server-generated 256-bit storage attempt key, session/room/logical message
identity and positive byte ceiling (at most 100 MiB) commit atomically with a
conditional singleton counter UPDATE. Row locking serializes competing writers;
the database capacity is authoritative, never a per-instance caller setting.
Each call creates a new attempt, including the same logical message key. No
operation retries automatically. No timer, refund, age deletion or cascade exists.
Provenance survives deletion of sessions/rooms/receipts by design.

Only `reserved` means COMMIT acknowledged. `failed/unknown` includes COMMIT dispatch
or release failure and retains the generated identity for investigation. Never
consume bytes or create files on failed, denied or pending outcomes. A hung call
retains its transaction/checkout: callers must not equate a deadline with rollback.
An acknowledged reservation is accounting, NOT an authentication/storage capability.
Only trusted server code may call this primitive, after bearer preflight/admission.

The private storage constructor now REQUIRES the ledger. Each exact grant may
attempt storage once. Bounded metadata/logical key are captured synchronously,
then the full server admission byte ceiling is reserved, never Content-Length.
Only acknowledged reservation plus a post-await current-grant check allows the
first filesystem open or source read. Session, room, logical key and byte ceiling
must match; storage uses the SAME durable key and enforces that ceiling on actual
chunks. Denied/unknown/thrown/pending outcomes cannot stage, retry or refund.
An acknowledged charge followed by expiry/replacement is retained without files.

Before activation: audit/provision actual volume headroom, metadata/inodes and
legacy writers. One DB budget assumes one audited
storage namespace. Raw request/envelope bytes require separate streaming limits.
No freeing capacity until durable reconciliation proves all references and work
settled. The monotonic ledger currently exhausts permanently by design.
This does not claim physical disk quota, file durability, DB failover recovery or
strict parser acceptance. A future cleanup design must retain provenance until
all receipt/attempt references are proven safe, never simply on session expiry.

The isolated PostgreSQL harness uses the generated migration, 32 competing calls,
real INSERT rollback, a real committed-but-lost ACK, then SIGKILL of a Node worker
after its acknowledged reservation and verification using a fresh DB pool. It is
an application-process crash test, NOT a PostgreSQL server/power-loss test.

The [read-only reconciliation contract](resume-upload-reconciliation.md) records
how missing blobs, unknown paths, tombstones, receipt cascades and conflicting
references must remain explicit. No production collector or reclaim operation
is implemented; an absent receipt never proves a blob is unreferenced.
