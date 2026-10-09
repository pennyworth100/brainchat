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

## Private durable file receipt (not wired)

`ResumeFileWriter` now uses the upload gate and the SAME session/key receipt
namespace as text/image. Authorization precedes lookup. Receipt and message are
atomic; tombstones and mismatched payloads fail without recreating a message.
The logical hash covers room, sender, type, bounded name, size, MIME and SHA-256,
but deliberately excludes the fresh storage attempt key. A retry returns the
original committed URL with `inserted:false`, not the retry's newly chosen path.
Replay validates the stored room/sender/type/id/time, bounded canonical metadata,
digest, and strict server URL format. It never trusts a stored hash alone.

`ResumeStoredFile` is SERVER-INTERNAL metadata, not an opaque storage capability.
Validation does NOT prove file existence, ownership, MIME safety, or digest
provenance. No HTTP input may be passed to this API. Before integration, an
exclusive server-owned storage writer MUST calculate size/SHA-256 from settled
bytes, bind its immutable result to its issued attempt, and produce these fields.
There are no filesystem operations in this primitive or its DB callbacks.
The returned client message omits the internal digest. No schema change is needed.

Settled outcomes and grant ownership are preserved. Neither a prior receipt nor
an uncertain COMMIT permits deletion of either attempt's file. No fanout occurs;
`inserted:false` must never replay a broadcast. An acknowledged DB commit is not
proof of network delivery or attachment durability across storage loss.

## Private exclusive byte storage (not wired)

`ResumeFileStorage` now stages one attempt per exact admission grant under a
trusted, absolute, stable, server-controlled upload root. ALL ancestor directories
must also be trusted; this is not protection against a hostile same-uid process
renaming ancestors. It rejects a symlink root and exclusively creates a random
256-bit attempt directory (0700) and `blob` (0600, O_EXCL/O_NOFOLLOW). User names
never become paths. Existing/colliding paths are never overwritten.

Bounded metadata is copied before filesystem effects. Raw chunks are admitted
before copying/writing, then snapshotted and written serially with short-write
progress checks and grant checks before each write. Size/hash derive from the
actual completed bytes. Successful file fsync/close, directory fsync/close and
root fsync/close precede issuing an immutable, exact registry/grant-bound result.
`resolve` rejects copied/cross-registry results, different/released/denied grants.
This is local filesystem durability policy, not a storage-provider backup proof.

All file closes and iterator finalization are awaited. No files are deleted and
no leases are released, even after failure. The caller must retain the lease
until source/file/DB work settles. A pending source read is not timer-cancelled:
the future bounded HTTP parser must implement safe stream cancellation. This
sink does not bound upstream buffers or metadata parser memory, validate MIME
contents, prove malware safety, or authorize durable DB policy by itself.

`ResumeFileUpload` privately composes storage with the database writer. It captures
the logical key and bounded metadata before filesystem effects; callers supply
bytes, never stored paths/digests. Only the exact grant-bound storage result is
resolved into the DB primitive. One attempt per grant is installed before work
starts. All duplicate calls (including changed keys) await the original settlement
and deny, never repeat dispatch or return another `inserted:true` result.
Rollback/unknown outcomes are not retried; a deliberate retry needs a fresh grant
and byte attempt, with the existing durable receipt preserving the original URL.
No release, unlink or broadcast occurs, including after unexpected writer errors
(conservatively unknown). The original caller remains the settlement/finalizer owner.
Local composition tests use real temporary files and a simulated SQL connection;
they are NOT a real-PostgreSQL composition or HTTP acceptance claim.

The isolated PostgreSQL CI fixture additionally exercises actual stored bytes,
new-path retries preserving the original URL, real committed-but-lost ACKs,
receipt rollback, tombstones, durable successors and policy denial. It retains
all attempts until the fixture-only temporary-root finalizer. CI results must be
verified at the exact commit before claiming these integration checks passed.

Next: cancellation during delayed writes/closes, bounded
multipart/HTTP ownership, then fenced publication and durable reconciliation.
No public handler imports this module. This is not full upload acceptance.

The separate [private reservation ledger](resume-upload-reservation.md) persists
an attempt key and byte ceiling atomically before callers may create files. It is
not yet composed here: storage still chooses its own key. Connecting the SAME
opaque reservation to the storage key/ceiling is a required next gate, not a
completed end-to-end guarantee. No budget was provisioned and no path activated.
