# Browser resume migration — 3.0.33 draft, first implementation slice

Not activated or integrated. The public browser continues to use the existing
legacy room-session controller; the server does not publish bearer credentials.
This branch is the single ongoing migration, not a deployable owner-only patch.

Implemented: memory-only shared generation/credential state, exact physical
connection attempt identity, stable CAS operation identity, mandatory sync before
ready, fail-closed lost CAS ACK/denial, and bounded pending text/image/file
operations with unchanged keys across a successfully resumed SAME durable session.
Explicit join discards the old controller owner, never replays its operations.
UI adapters must retain unresolved drafts separately before explicit rejoin.

The controller is a client-side consistency fence, NOT server authorization.
The lease and receipt adapters are trusted application code and MUST validate
authenticated protocol responses. Its receipt shape is an internal normalized
adapter contract, not a newly invented claim about today's wire response:
text/image/file currently do not all expose payload hashes/session identifiers.
Compute immutable canonical payload identities using the existing server
definitions; independently validate actual receipt payload before normalizing.
Never accept an echoed client hash as proof of persistence.

Next steps on THIS branch before integration:
1. Implement private transport adapter and real-server tests: authenticated join
   envelope, resume CAS, full-sync snapshot/gap handling. Unknown CAS must use a
   separately reviewed lookup/reconciliation flow, not blind generation retry.
2. Wire room-session/page and ALL text/image/file producers as one change;
   capability negotiation must fail closed and credential-enabled requests
   must never fall back to legacy. Private message authority also needs review.
3. Add receipt adapters/pending payload storage and actual unknown-ACK replay
   tests for every media type. Current controller is not durable across reload,
   does not retain payload bytes, and does not itself send/replay anything.
4. Extend existing rendered-browser gate and private PostgreSQL/Socket.IO tests.
   Only after PASS consider integration into PR20. Keep credentials disabled
   until physical byte+inode authority, resource admission and acceptance pass.

No server/browser imports, activation, production deployment, database mutation,
or physical storage-authority claim in this slice.

## Verified first slice

Twelve focused controller tests include exact sync-attempt fencing (a generation
number alone can repeat on a new explicit join). The existing isolated PostgreSQL
fixture now invokes qa-browser-resume-core: 33 additional checks use real CAS,
authorized history reads and durable text/image/file DB receipts. It deliberately
withholds successful write ACKs, resumes the same session and verifies retry
returns the SAME message ID with inserted:false and the database's actual payload
hash. A lost generation-CAS ACK is fenced without advancing again.
File checks here are database-only: no filesystem write or byte/inode proof.
This adds no public server or browser imports and does not validate a wire adapter.

## Private inline receipt adapter (same 3.0.33 draft)

The next slice validates the actual text/image ResumeSendReply projection:
request-local clientMessageId plus persisted message ID/type/username/content/time.
It recomputes the server canonical payload identity with browser WebCrypto;
client-echoed hash/session fields do not confer evidence. Exact operation/physical
owner/expiry is rechecked after the asynchronous digest. Differential tests compare
browser image canonicalization with the server. The isolated PostgreSQL fixture
now passes real text/image retry results through this adapter after withheld ACK.
This is payload validation, NOT authenticated transport or Socket.IO acceptance.

File replies currently omit the persisted byte digest, so this adapter explicitly
refuses files instead of inferring byte identity from name/size/MIME/path. A
reviewed authenticated byte-identity response contract is still needed. No public
imports, credential publication, join/resume handler, automatic replay, reload
durability, or activation was added. Keep PR44 draft and unmerged.

## Private actual-owner credential handoff

The private `resume-browser-handshake` adapter now uses the real
`ResumeSocketOwner.join/admit` results and exact `ResumeMemberships` binding.
It rechecks physical ownership and membership after the awaited admission,
switches that owner irreversibly to strict uploads BEFORE credential handoff,
and serializes only the browser lease fields. A foreign/copied owner, stale
binding, closed socket or foreign membership registry cannot publish a lease.
A synchronous handoff exception propagates without restoring legacy authority.

Five regressions exercise real loopback Socket.IO owners, credential snapshotting,
close during CAS, denied CAS without retry, exact field projection and the
browser remaining in syncing (not ready). The PostgreSQL fixture now hands
actual owner-generated join/resume leases across private Socket.IO events:
42 controller checks, 399 total DB checks. Same-session text/image/file DB retry
identity survives withheld write receipts. File proof remains DB-only.
The fixture uses a trusted authenticated-join input, NOT a public password-login
handler; message/history reads and writes are still direct private calls.

No production imports or public event registration. Lookup remains read-only
generation evidence, never membership or permission to automatically steal a CAS
winner. Public authentication/negotiation, snapshot-gap sync, all-producer wiring,
file-byte response authority and reload durability are STILL pending.
Keep this same 3.0.33 PR draft and unmerged.

## Explicit original-CAS transfer (same draft, October 12)

Disconnect now retains the exact outstanding resume CAS operation and expected
generation. beginTransfer consumes that provenance into a separate frozen ticket
with originalOperationId and a distinct transferOperationId, bound to one new
physical connection. It cannot reuse the lost connection, substitute a fresh CAS
or manufacture an incremented expected generation. Exact calls on the same
in-flight transfer share the ticket. Acceptance requires the original generation
plus two, the same credentials, exact ticket and physical owner, then a separate sync
ticket. A lease ACK alone never makes the controller ready.

The private publishBrowserTransfer handoff invokes actual owner.transfer through
the shared admission path. Exact membership and the irreversible strict-upload
transition precede publication. This is not public event registration.

Lost transfer ACK consumes the single transfer opportunity: pending operations
remain uncertain and neither another transfer nor a blind CAS is allowed. A
transfer ID is never promoted into original provenance. Denial, expired leases,
malformed +1/+3 responses, copied tickets, stale ACKs and stale disconnects are
covered by five new controller regression tests.

The isolated SQL/Socket.IO fixture now drops a CAS ACK after actual owner
admission, sends the +2 transfer lease over the physical socket, verifies
sync-before-ready, and retries retained text/image/file DB operations to their
original message IDs (inserted:false). It also drops the transfer ACK after real
DB success and verifies terminal uncertainty with pending data retained.
These tests use trusted private join input; they are not public password login,
rendered resume UI, reload durability, persisted file-byte proof or an atomic
full-history snapshot/gap protocol. Current bounded history reads are fixture
evidence only, not a complete synchronization design.

Next: define and test full-sync snapshot/gap completion before public activation,
then authenticated persisted file-byte identity, capability negotiation and
coherent page/all-producer/private-message integration. Physical byte/inode
capacity and fresh fenced recovery/exact-image rollout remain release gates.

## Validated bounded snapshot completion (same draft, October 12)

The controller now creates a unique snapshot request after each accepted lease.
Its adapter is bound to the exact physical connection and opaque sync ticket,
with session/generation/room/request identifiers on the private wire envelope.
Install its live callback before sending the request. The server envelope wraps
the existing authorized full-window read and rechecks exact membership after
the await; it never substitutes a local probe or an afterId query.

finishSync requires the exact completion object produced by that adapter after
validating the received envelope. Matching ticket/generation alone, bare handoff
true, probe ACK, copied/foreign completion, replay, disconnect and late completion
cannot make the controller ready. A 10-second deadline is checked synchronously
at validation AND consumption, so a delayed timer does not admit a late ACK.
Malformed data or count/byte overflow closes the adapter, preserving unresolved
operations; completion failure blocks the controller.

History is explicitly the newest 100 rows ordered by ID ascending, NOT complete
offline history and NOT a commit watermark. Up to 100 pre-request/during-request
live events (16 MiB projected UTF-8) merge with a snapshot capped at 32 MiB.
Message ID/type/time, text/image content, local file URL/name/size/MIME and optional
SHA-256 are validated. Exact duplicate live/snapshot rows deduplicate; conflicting
IDs fail closed. Copied immutable projections strip unknown fields. Pending
operation identity/payload ownership is never settled by seeing a history row.

The private PostgreSQL fixture now delivers these envelopes across actual
Socket.IO before READY for join, resume and original-CAS transfer. Unit regressions
cover all media, lower-ID late-commit reconciliation, stale/copied/replayed/invalid
completion, overflow, timeout and pending operation retention.

Still NOT gap-free: a writer can commit without delivering a live event, and a
lower allocated ID can commit after a higher one. Two reads do not create an
atomic cut. Need an evidenced ALL-writer publication/reconciliation boundary,
including commit-success/fanout-failure/restart, before public wiring. This module
does not automatically request subsequent reconciliation or retain payload bytes
across reload. The private ResumeFileWriter receipt now includes the canonical
persisted sha256 on both insert and same-key retry, matching ResumeHistoryReader.
The digest comes from the validated persisted record, not a client echo or the
retry attempt's new storage path. Legacy files may still have no digest; missing
versus present or changed digests for the same ID remain conflicting projections.
No file metadata substitutes for stored bytes.

The actual PostgreSQL/physical Socket.IO boundary fixture now runs the real file
writer and receipt migration. It delivers the same file as a live event while
the authorized snapshot containing it is withheld, then proves exact projection
equality, single-row deduplication and READY only after validated completion.
It also verifies a new-path same-key retry returns the original receipt. Twenty
assertions cover this plus the existing concurrent-media/late-commit boundary.
The supplied digest in this DB fixture is trusted test input, NOT an upload,
download, rendered browser, retained payload or byte-integrity proof. Public
file response wiring and byte validation remain open.

No public activation, schema/dependency/version change, PR20 integration or
production deployment. Same 3.0.33 draft, with physical capacity and recovery gates
unchanged.
