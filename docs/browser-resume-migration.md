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
