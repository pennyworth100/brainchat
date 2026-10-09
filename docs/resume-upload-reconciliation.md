# Read-only upload reconciliation contract (3.0.11 draft)

Status: private contract, bounded **ledger-only** collector and adversarial fixture
proof, NOT a complete reconciliation collector. No scheduler, public route, cleanup, refund, retry or deployment is
enabled. The ledger remains monotonic. This contract does not grant repair authority.

## Evidence sources and completeness

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

Next implementation slice: independent bounded receipt/message snapshots under
the same transaction, followed by filesystem fault injection for permissions,
symlinks, unstable files and concurrent writers. Any later repair requires its
own reviewed protocol, durable all-writer barrier, paired DB/blob recovery proof
and separately authorized execution. Production remains behind Max's release gate.
