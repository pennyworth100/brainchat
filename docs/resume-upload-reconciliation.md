# Read-only upload reconciliation contract (3.0.11 draft)

Status: private contract, bounded database collector, separate root-entry observer and adversarial fixture
proof, NOT a complete reconciliation collector. No scheduler, public route, cleanup, refund, retry or deployment is
enabled. The ledger remains monotonic. This contract does not grant repair authority.

## Evidence sources and completeness

### Private evidence envelope

`serializeUploadEvidence` captures the ORIGINAL DB, root and supplied-key content
reports independently in a versioned JSON envelope. Sources may be null; duplicates,
tombstones, conflicts, partial results and each source completeness axis remain intact.
No join, collector rerun, aggregate PASS, absence, ownership or repair authority is
created. A completed supplied-key batch never establishes volume coverage.

Each source carries explicit observation ID, namespace, release SHA and start/end;
DB additionally carries database/schema IDs, filesystem sources volume/root IDs and
original limits. All IDs must be opaque non-secret labels, never credentials or paths.
These are CALLER ASSERTIONS, not verified live identities, clock synchronization or
an all-writer barrier. Different source identities remain independent; within a content
source namespace labels must agree. Original collector report types are trusted
in-process data, not a public/untrusted-report validation API. No runtime caller exists.

Serialization snapshots without invoking getters/toJSON, preserves array order and
repeated observations, and rejects instead of truncating: maximum 8 MiB UTF-8 output,
500,000 visited nodes, depth 24, 4,096 UTF-16 units per string, 64 object fields,
100,000 array entries (root 10,000, content 1,000). Non-JSON data/cycles fail closed.
These are capture/serialization bounds, not bounds on earlier collection or hostile
Proxy execution. Reports exceeding them cannot produce a partial 'successful' envelope.
Only the immutable serialized capture is returned; caller mutations cannot rewrite it.
The envelope remains private and potentially sensitive; do not publish actual reports.

### Private root-entry slice

`inventoryUploadRoot` is a separate, unwired observer. Its caller must attest that
the root and ALL ancestors are trusted, stable, server-owned directories; it does
not establish that precondition itself. The root is opened with `O_DIRECTORY |
O_NOFOLLOW`, held throughout the scan and compared via bigint device/inode/mode/
size/link-count/mtime/ctime against path `lstat` before/after enumeration. An observed
change is `unstable`; unchanged checks are NOT a race-free snapshot or defense
against hostile same-uid replacement/ABA. Atime is deliberately not compared.

The scan admits at most 10,000 observations, one extra read to distinguish an
exact cap from truncation, and 30 seconds of I/O admission budget. Directory
bufferSize is 1. Deadline checks surround awaited operations; pending kernel I/O
and handle close cannot be cancelled by this API, so this is NOT a hard wall-time
or hung-filesystem guarantee. Limits are copied before awaiting. Handles are
closed on success/failure; close errors prevent completion.

Only immediate entries receive `lstat`; no child is opened or traversed, no blob
is read/hashed. A kind is a point-in-time observation, not stable child identity.
Unknown names are omitted from the result (storageKey=null), not normalized or
deleted. Symlink/other/unknown/failed entries, duplicates, scan caps, elapsed
deadlines, root changes and I/O errors leave enumeration incomplete with bounded,
non-sensitive reason codes. A missing root is unobserved, never observed empty.
Even `enumerationComplete` proves neither ownership nor absence of references,
blob integrity, capacity or safe reclamation. `blobs=unobserved` and
`crossStoreStability=unproven` always; it is not joined with the DB snapshot.
There is no runtime caller, volume audit, recovery action or public activation.

### Private single-blob metadata slice

`observeUploadBlob` is separate and unwired. Given one strictly canonical 64-hex
storage key, it checks exactly root/key/blob without enumeration or recursion.
The caller's `trustedStableAncestry` attestation covers the blob's ENTIRE ancestry,
including the keyed directory, root and ancestors. Held handles and path checks
are NOT openat-relative resolution and cannot prevent intermediate path substitution
outside that trust precondition. The admission-only deadline applies as above
(1..30,000 ms, copied before awaiting). It lstat-checks each component,
opens/holds no-follow root and keyed directory handles, and opens the regular
blob read-only with NOFOLLOW and NONBLOCK. NONBLOCK prevents a FIFO replacement
at open from hanging; fstat must still confirm regular-file type and identity.
Nonregular/symlink entries and link counts other than one fail closed. A matching
link count is NOT proof of exclusive ownership.

Device/inode/mode/size/link-count/nanosecond mtime/ctime are checked before/after
for all three held objects and paths. Exact stat size/link-count are decimal
strings; no content read, hashing, DB query or mutation occurs. Prior positive
metadata survives a later error, but `complete=false`. Missing/unreadable is
unobserved, never absent/zero size. All closes are awaited; any close failure
prevents completion. Reason codes exclude private paths and exception text.

`unchanged-at-checks` means sequential metadata comparisons only, NOT a snapshot,
hostile same-uid/ABA protection, content integrity, reference absence, ownership,
capacity or safe reclamation. It does not authorize later access. Content stays
unobserved and cross-store stability unproven even when complete. There is no
public caller or live-volume audit. Hashing requires a separate byte/time budget
and before/after identity contract; integration still requires an all-writer barrier.

### Eventual combined report

A report must identify the DB/schema, storage namespace/volume, release, observation
start/end and limits. Never include bearer tokens, credentials or message bodies.
Inventory these independently, not by starting from successful receipt joins:

1. Singleton budget and **all** durable upload attempts (including deleted sessions).
2. All retry receipts with LEFT JOIN messages, preserving NULL-message tombstones.
3. All file messages, including messages whose session/receipt no longer exists.
4. Root entries, attempt directories and blobs, including unattributed entries.

Use one checked-out connection and one REPEATABLE READ READ ONLY transaction for
the DB snapshot. Pool-level BEGIN followed by pool.query is not a connection-affinity
contract. Budget/attempt amounts must be parsed losslessly and compared exactly;
missing budget, invalid rows, duplicate identities or unequal counter/sum are
inconsistent accounting, never available capacity. Empty and unread are different.

DB MVCC is NOT an atomic DB/filesystem snapshot. Without an independently proven
all-writer barrier covering legacy uploads, storage, receipts, retention and admin
mutations, observations are provisional even if both scans finish successfully.
DB/FS errors, interrupted pagination, deadlines, per-entry errors, skipped rows,
unparsed legacy references, unreadable files or scan caps produce explicit
incomplete/uncertain status and reasons; never silently substitute empty lists.
Capture scan counts/cursors and per-entry errors. No negative conclusion from a
partial scan; positive references remain positive evidence.

An eventual collector must bound memory, page size, paths, bytes hashed and elapsed
time. A reached limit ends with incomplete status, not clean. Use a trusted,
stable server-owned root/ancestors; inspect with lstat/no-follow opens, reject
symlinks/nonregular blobs, and verify identity/size before and after bounded hashing.
Do not traverse unknown directories or fetch URLs. Suspicious entries are facts
to report, not paths to normalize or remove. No filesystem writes from the collector.

## Classification (facts may overlap)

The private reference collector now reports `metadataStatus` separately from
canonical URL extraction and scan completeness. `metadataComplete` means every
applicable observed body matches the file writer's bounded canonical metadata
and exact serialization; it is false on partial scans. `declaredSize` and
`declaredSha256` are claims from valid metadata, NOT filesystem measurements.
Name/MIME are validated but not returned; raw content is never returned.
Invalid metadata, extra/duplicate JSON fields, or oversized provenance never
erase a bounded positive URL. Bodies above 4096 UTF-8 bytes are suppressed by SQL
before driver transfer; truncated/unread bodies supply no URL evidence.
Metadata validity does not imply room/session/logical identity agreement,
ownership, integrity, or safe deletion. The private `referenceFacts` slice counts
independent messages, receipts and attempts per observed storage key without
collapsing duplicate references. It reports observed room and receipt
session/clientMessageId conflicts against a unique, untruncated attempt. It never
selects among duplicate attempts or compares truncated provenance. Tombstones
remain in the original receipt inventory; separately charged retry keys stay
distinct. Zero counts are observations, never proof of absence, even on a complete
scan (unknown/unparsed bodies may still contain references).
Conflict counters count per-source observations: one mismatching message seen
independently through both scans contributes two room-conflict observations,
not two distinct messages. Multiple receipts/messages are flagged separately.

`fullIdentity` is always `unobserved`: session authorization/state and full logical
agreement are not established. Receipt-local room/username/hash comparisons are
reported separately below, not promoted to an aggregate identity verdict. Zero detected
conflicts are NOT an agreement verdict. Counts/conflicts on partial scans remain
positive evidence only; original references and completeness flags are retained.
This linear, row-bounded classification uses only the same DB snapshot; it adds
no query, reset, runtime caller, mutation or filesystem observation.

| Observation | Classification / consequence |
| --- | --- |
| One exact message path, matching attempt identity, validated metadata and actual size/digest within its ceiling | Referenced blob observed consistent; not proof of publication, backup or reclaimability |
| Message path references an absent blob/directory | Referenced blob missing; integrity incident, preserve charge and all provenance |
| Path exists but no durable attempt matches | Unattributed path; a 64-hex name is not ownership proof |
| Attempt has no observed path | Reservation with no observed blob; may be pre-open crash or incomplete observation; retain charge |
| Attempt/path exists but no observed message reference | Unreferenced-at-observation candidate, **not** a reclaimable orphan |
| Receipt has NULL message_id | Tombstone; logical identity exists, original path cannot be recovered from this receipt alone |
| Message exists after session/receipt cascade | Live message reference without retry receipt; still referenced |
| Multiple messages reference one key, or room/session/logical key/metadata disagree | Ambiguous/conflicting provenance; keep every reference, never pick a winner |
| Malformed/unknown URL, legacy format, partial scan, concurrent writer or unstable file | Uncertain/incomplete inventory; absence and ownership claims are withheld |

Match canonical local /uploads/<64 lowercase hex>/blob paths exactly. Do not infer
that two attempts for the same logical message are the same storage object:
deduplicated retries may retain their separately charged staged bytes while the
receipt points to the first attempt. Keep physical storage-key provenance distinct
from session/clientMessageId identity. Session expiry, message deletion, elapsed
time, a transport timeout or a not-dispatched later operation prove no refund.

The report must separately expose accounting consistency, DB snapshot completeness,
filesystem scan completeness, cross-store stability and reference/identity conflicts.
A successful SELECT or HTTP 200 cannot collapse those dimensions into PASS.
There is deliberately no delete/refund/replay instruction or reclaimable boolean.

## Evidence and limits

scripts/qa-upload-storage-crash.ts first proves actual application SIGKILL at two
barriers: fsynced bytes before receipt and real receipt COMMIT with lost ACK.
Fresh checked-out read-only snapshots verify surviving charges and provenance.

Its additional harness-owned fixture mutations demonstrate missing referenced
bytes, syntactically valid unknown directories, duplicate references, real
ON DELETE SET NULL tombstones, and session deletion cascading receipts while
messages/attempts survive. Only test setup and teardown mutate the isolated
fixture; the observation transactions are read-only. These assertions demonstrate
why a receipt INNER JOIN or a set of paths is insufficient; they do not claim
implementation or validation of a production collector.

## Implemented slice: private ledger-only inventory

`src/lib/resume-ledger-inventory.ts` consumes one exclusively checked-out client
and destroys it on exit. Pool acquisition must be bounded by its private caller.
Ownership transfer explicitly permits rolling back any inherited transaction;
never pass shared connections or pending work that must be preserved. Before
BEGIN, the collector issues ROLLBACK: PostgreSQL otherwise retains a snapshot
already pinned by an earlier REPEATABLE READ READ ONLY transaction. Reset errors
fail closed, without querying the ledger. Real PostgreSQL regressions verify
fresh observation after a concurrent change and rollback (never commit) of
inherited read-write and aborted transactions.
It scans budget and attempts in REPEATABLE READ READ ONLY, with a server cursor,
row/page/time limits, SQL-side provenance text bounds, exact bigint arithmetic,
and explicit partial/error reasons. Invalid rows are retained and not counted as
valid charge. A complete ledger scan can still have inconsistent accounting.
The future integration must attach DB/schema, namespace and release identity;
this slice does not infer deployment identity from connection settings.
It has no application caller or public route. Reports contain private provenance;
do not publish actual production reports to public issues or logs.

The report explicitly marks receipts, messages and filesystem **unobserved**, and
cross-store stability **unproven**. Ledger completeness is never overall inventory
completeness. No capacity, ownership, absence or reclaimability claim is exposed.
The isolated PostgreSQL harness now verifies full/capped/exact-bound pagination,
a real lock-wait deadline, counter mismatch and missing budget, including attempt
provenance after session deletion. These are test-only fixture mutations.

## Implemented slice: private DB reference inventory

`inventoryUploadDatabase` uses that SAME outer-owned fresh transaction, deadline
and release lifecycle. It adds independent receipt LEFT JOIN messages and all
file-message cursor scans. `maxRows` is a separate cap for each of the three
collections (attempts, receipts, messages); `pageSize` is at most 1000. Exact-cap
scans probe for one more row before claiming completion. No reset occurs between
collections. `inventoryUploadLedger` retains its ledger-only behavior.

SQL bounds provenance columns and suppresses message content over **4096 bytes**
before driver transfer or JSON parsing. Reference reports contain only bounded
identifiers, status, canonical storage key and validated declared size/digest,
never raw bodies. They retain
tombstones and every duplicate reference; receipt/session cascades cannot hide
independently scanned file messages. `references.complete` means the DB reference
scan finished; `parseComplete` separately means all observed file references were
parseable canonical local URLs. Neither validates full metadata (name, size,
digest), ownership, room agreement, physical bytes or safe reclamation. Unknown
legacy paths, malformed JSON and oversized records make `parseComplete=false`.
Partial DB scans also leave it false and retain positive observations already seen.
Overall `complete` is DB scan completion ONLY; accounting is ledger arithmetic ONLY.
Filesystem remains unobserved and cross-store stability remains unproven.

Real PostgreSQL tests additionally cover reference tombstones/cascades/duplicates,
a concurrent commit between ledger and reference queries excluded from the pinned
snapshot, malformed metadata, multibyte oversize, pagination caps and a genuine
reference-table lock deadline. No runtime route or activation was added.

Bounded metadata is now classified independently as described above. Real driver
instrumentation verifies an exact 4096-byte body is transferred and a 4097-byte
body is NULL before parsing. Invalid-but-positive references remain in the report.

Receipt observations now include independent session-room, session-username and
canonical file payload-hash comparisons (`match`, `conflict`, `unobserved`).
The existing receipt cursor LEFT JOINs the session in the same pinned snapshot;
SQL bounds comparison inputs and only the hash calculation sees the bounded
message username. No username, session token/hash or raw body leaves the collector.
Missing/oversized inputs and noncanonical metadata leave the relevant comparison
unobserved. A tombstone has no message identity to compare. Comparisons are local
to each receipt, never a winner among duplicate references. Even all matches
prove neither current session authorization nor ownership, filesystem integrity,
uniqueness or full identity; `fullIdentity` remains `unobserved`.

Receipt-local `sessionState` now records expiry (`expired`, `unexpired`,
`unobserved`), revocation (`revoked`, `not-revoked`, `unobserved`) and room auth
version (`match`, `conflict`, `unobserved`) independently. Expiry uses PostgreSQL
`transaction_timestamp()` (transaction-start clock, NOT application wall time or
time of completion); expiry at that clock is expired. The same pinned read-only
snapshot supplies sessions and their own rooms. Nonfinite expiry, absent joins,
oversized session/room identifiers and invalid auth versions leave the affected
facts unobserved. No timestamp, version, credential or token hash is projected.
Tombstones retain session facts despite having no comparable message identity.
Historical references and hashes survive expiry/revocation/policy changes: these
facts neither authorize a new write nor establish original authorization,
current-at-completion validity, attempt/session agreement, ownership or full identity.
The existing independent `identityEvidence` and `fullIdentity` semantics are unchanged.

DB-mode attempts now carry their own `identityEvidence.sessionRoom` comparison
(`match`, `conflict`, `unobserved`), using a bounded LEFT JOIN in the same pinned
snapshot. Missing/deleted sessions and oversized attempt/session identifiers or
rooms leave it unobserved; positive ledger provenance and accounting remain
independent. Session room is not projected. This is NOT receipt-local identity,
authorization, original ownership or a full identity verdict. Ledger-only mode
does not join sessions or gain this field. Real PostgreSQL regressions cover both
directions of room mismatch, oversized provenance, deletion, and a concurrent
commit observed only by a fresh inventory. No runtime caller or schema changes.

Real PostgreSQL boundary tests cover 128- versus 129-character session IDs and
session-room IDs. Oversized joined provenance leaves all three session-state
facts unobserved while preserving the positive file reference and its independent
message payload hash. A separate fixture lets expiry pass during a pinned scan:
the report retains `unexpired` at transaction start even though the database wall
clock has passed expiry before receipt collection. A fresh scan reports `expired`.
This is deliberately NOT current-at-completion authorization. These tests mutate
only their isolated fixture; no production inspection or repair is performed.

Next implementation slice: filesystem fault injection for permissions,
symlinks, unstable files and concurrent writers. Any later repair requires its
own reviewed protocol, durable all-writer barrier, paired DB/blob recovery proof
and separately authorized execution. Production remains behind Max's release gate.

## Private bounded content observation

`observeUploadBlobContent` has no runtime caller. It opens only root/key/blob,
using the same trusted stable ENTIRE-ancestry precondition as metadata observation
(root and keyed directory included). Held handles and sequential identity checks
are not openat, hostile same-uid/ABA protection or a filesystem snapshot.

Before the first await it copies explicit maxBytes (0..64 MiB), maxReads
(1..4096), maxMs (1..30000), and the ancestry assertion. Stat size above the
byte ceiling is rejected before reading. One reusable buffer of at most 64 KiB,
explicit offsets, and a read-operation ceiling bound memory, bytes and work.
Positive short reads continue within those bounds; premature zero/EOF is
incomplete. It reads precisely the initial stat size, without a one-byte EOF
probe that could exceed the ceiling; post-read stat/identity checks detect growth.
An empty regular file can be hashed with a zero byte budget and no content reads.
Deadlines fence admission and late results, not pending kernel I/O/close latency.
All handles are closed and awaited even on failure. Reads may update filesystem
atime; this is not a forensic no-touch reader.

Only an unchanged-at-checks, fully read, successfully closed observation exposes
SHA-256. Any error, mutation, limit or close failure leaves sha256 null and
complete false; positive size and valid bytes-read counts remain observations.
No raw content, file path or exception detail is returned. The digest is only
measured local bytes under these preconditions, not declared-metadata agreement,
ownership, full identity, durability, current authorization or safe reclamation.
Cross-store stability stays unproven. No DB/FS atomicity is claimed.
No live volume was read; no repair, refund, deletion, replay or activation added.

## Private per-reference content comparison

`compareUploadReferenceContent` is a pure, unwired comparison of one explicitly
paired reference and keyed completed content observation. Its caller must bind
the actual observed root and the DB reference to the same trusted, stable storage
namespace identity (not a room, path or inferred deployment). Exact matching
namespace labels do not establish that external binding. Namespaces are bounded
ASCII identifiers; storage keys are exact lowercase 64-hex strings. A missing or
mismatched namespace/key leaves both comparisons unobserved, not conflicting.

Only a valid reference with a completed, unchanged-at-checks, error-free content
observation can compare. Single-link metadata, canonical exact stat size, safe
bytes-read count within the observer's 64 MiB ceiling, and canonical measured
SHA-256 must agree with that completion contract. Partial positive metadata is
never promoted to match, absence or empty-file evidence. Declared size and digest
are compared independently as match/conflict/unobserved; missing or malformed
declarations are not coerced. No raw content or provenance is copied to output.

Callers retain original references, source identity, scan completeness and all
duplicate observations; each explicit pair remains independent. This function
does not select a winner, join arrays, aggregate a PASS or establish a DB/FS
snapshot. Even two matches do not establish ownership, full logical identity,
current authorization, durability or safe reclamation. Cross-store stability
always stays unproven and full identity unobserved. No runtime integration,
filesystem/DB access, repair, refund, deletion, replay or deployment is added.

## Private total-budget content batch

`observeUploadContentBatch` observes only a caller-supplied array of canonical
keys. It does not enumerate a volume or join/select DB references. Before I/O it
validates the full array (at most 1000 entries), copies keys and contract, and
requires explicit namespace identity, trusted root-to-namespace binding and stable
entire ancestry assertions. Those assertions are caller preconditions, not proof;
the caller must independently bind original DB references to the same namespace.
Original references and their source/scan completeness remain with the caller.

The first conservative slice reserves the FULL per-key byte and read-operation
allowance before each observation, with no refund for unused bytes, missing files,
failed reads or cleanup failures. Reservation totals are NOT measured usage.
The total caps are 64 MiB and 4096 reads; a zero-byte allowance permits empty-file
observations but still reserves the positive per-key operation allowance. If the
next complete reservation cannot fit, no I/O for that key is admitted. Oversized
input arrays fail before copying/collection instead of silently truncating.

Concurrency is one, including awaited cleanup, with one monotonic global deadline
(at most 30 seconds). Every child I/O admission and result is fenced by that clock;
invalid/regressing clocks latch failure. Pending kernel I/O/close may exceed the
deadline and must settle before return. No cancellation or hard latency bound is
claimed. Reads may update atime. All admitted observations, including partial or
failed ones, retain their supplied index and namespace; duplicate keys are never
deduplicated or selected as winners. `allKeysAttempted` only describes this input
list, not successful content verification, volume/DB completeness or aggregate
PASS. Non-admitted keys remain unobserved, not absent. Cross-store stability stays
unproven. No runtime caller, repair, refund, deletion, replay or deployment added.

## Completion boundary for root and metadata observations

Root enumeration and metadata-only observation now reject any observed monotonic
clock regression, including a regression that remains above the initial time.
Their completion check includes awaited cleanup: a close settling at or after the
deadline, or with an invalid/regressing final clock, cannot yield complete evidence.
Earlier positive keys/metadata and unchanged-at-checks facts remain observations,
not an absence verdict. This matches the content observer's completion boundary.

Every close is independently scheduled and settled, including when an injected
adapter throws synchronously. One close failure cannot skip other handles or
expose raw exception details. No retry or claim of successfully closing a failed
handle is made. Pending kernel I/O/close still has no hard wall-time bound and is
not cancelled. No runtime integration or live volume access is added.
# Isolated evidence composition regression

`RESUME_TEST_DATABASE_URL=<isolated database> node --import tsx scripts/qa-upload-evidence.ts`
creates a random schema and temporary upload root, then composes the **original**
database, root and supplied-key content collector reports through the private
evidence serializer. CI runs this fixture independently of public HTTP handlers.
It preserves duplicate receipts, duplicate/conflicting messages, tombstones,
DB-positive unread blobs and root-positive unattributed keys. A fully attempted
input list coexists with incomplete DB/root observations; no aggregate PASS,
absence, ownership or reclamation result is produced. Full serialized captures
are included in the fixture output, with independently captured times, IDs and
limits. Provenance remains caller-asserted and cross-store stability unproven.
The fixture checks DB rows and file bytes/names remain unchanged (read atime is
not asserted unchanged), then removes only its own schema and temporary root.
This proves composition, not live-volume identity, a DB/FS snapshot, a writer
barrier, backup/recovery or permission to activate reconciliation.
