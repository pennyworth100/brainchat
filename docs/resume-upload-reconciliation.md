# Read-only upload reconciliation contract (3.0.11 draft)

Status: private contract, bounded database collector, separate root-entry observer and adversarial fixture
proof, NOT a complete reconciliation collector. No scheduler, public route, cleanup, refund, retry or deployment is
enabled. The ledger remains monotonic. This contract does not grant repair authority.

## Evidence sources and completeness

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
