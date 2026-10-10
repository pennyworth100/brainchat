# DB/uploads all-writer coverage audit — 3.0.11 draft

Source audit: 2026-10-09. Audited PR #20 source: `2efac859ab5ce5ac78b4798998f5932cf948f7bf`.
Baseline main: `99d5f0bd3fae431bd5f0eb08ac49bc604685932b` (3.0.10).
Known production remains 3.0.3 / `4520b649a247e18c1bb30732ba11e40dfaede0e1`;
known staging remains 3.0.5 / `882ede7f1de1cfba73882f4acf1c738fe50b353f`.
These are source/release baselines, not a new live runtime-SHA attestation.

**Result: no all-writer barrier exists.** Private resume admission, row locks,
an upload reservation and successful evidence collection do not fence public
uploads or establish an atomic DB/filesystem snapshot. This is an inventory of
repository entry points and identified external actors, NOT proof of complete
live-host coverage. No installation, deployment, migration, live-volume scan,
budget provision, refund, deletion, repair or listener action was performed.

## Coverage matrix

“Public” means wired in the audited server source, not newly deployed.
“Private” means foundation callable by trusted code/tests, not wired by server.ts.
Every row below is **uncovered by a common cross-store maintenance barrier**.
Existing authorization/serialization guards are recorded separately.

| ID / entry point | Actual mutation and current guards | Namespace / budget / drain gap |
| --- | --- | --- |
| W01 — startup | [server.ts:41](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L41) configures UPLOAD_DIR; :50 recursively creates it. [server.ts:219](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L219) migrates before HTTP listen. [db/migrate.ts:4](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/db/migrate.ts#L4) is a second CLI entry. | Root defaults to /tmp/dimle-uploads. Restart/new replica/CLI can change filesystem/schema independently of request admission. No maintenance fencing. |
| W02 — public room creation | [POST /api/rooms](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L289) consumes a PostgreSQL rate limit, inserts an unclaimed room; generated IDs/token hashes and conflict handling. | DB rooms; no upload charge. A full-DB drain cannot ignore this writer. |
| W03 — public room claim | [join-room](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L564) authenticates creation token, hashes password, calls [claimRoomPolicy](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/room-policy.ts#L11). Single conditional UPDATE claims room and increments auth_version. | DB policy; CAS and private room-share locks are per-room serialization, not a global barrier. This claim helper is the server.ts delta from main. |
| W04 — public message, image, agent send | [send-message](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L634) checks membership/payload; [send-image](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L657) checks room user/data-URL limits; [POST /api/send](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L479) checks API principal/claimed room and optional clientMessageId. [saveMessage/saveAgentMessage](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L105) insert messages; agent key deduplicates via unique index. | DB messages, including inline image data; no resume receipt/admission/budget. Upload POST also calls saveMessage for file references. These writers can change a DB inventory during FS observation. |
| W05 — asynchronous room activity | [touchRoom](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L98) updates last_active_at; calls at :115/:138 deliberately do not await completion and swallow rejection. | A resolved save/HTTP response is not proof that all related DB writes settled. Must track deferred touch through settlement, not just outer handler completion. |
| W06 — public upload storage | [diskStorage + POST /api/upload](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L348) uses random 8-byte/16-hex directory and sanitized original filename. Socket/room authentication precedes limiter/parser. [parser](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/upload-parser.ts#L7) limits one file/part, zero fields, 100 MiB file ceiling. Multer creates/writes the file. | UPLOAD_DIR/<16hex>/<name>; no resume ledger charge, no singleton-volume budget, no common lease. Recursive mkdir and default createWriteStream are not the private exclusive 64-hex/blob contract. Existing uploads may outlive socket disconnect intentionally. |
| W07 — parser-owned cleanup | Multer disk _removeFile unlinks; make-middleware abort/request-failure/late-callback paths invoke it. Dependency anchors/fingerprints below. | Same public namespace. A barrier must cover parser pending writes, descriptor closure and late cleanup, not only successful handler invocation. Directory creation can leave empty directories. |
| W08 — public file-reference failure cleanup | [server.ts:415](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L415) persists file message, emits and responds in one try; catch at :422 dispatches unawaited unlink(:424). | Same namespace. Catch does not distinguish acknowledged-lost DB commit or a post-save exception. Source establishes a potential reference/blob inconsistency; no incident or fault-injection reproduction is claimed here. Awaiting the request does not drain this unlink. |
| W09 — private session lifecycle | [ResumeStore](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-store.ts#L51) issues sessions only after authenticated join/version check and room SHARE lock; generation CAS at :103; credential+generation revocation at :136. | DB room_resume_sessions affects observation identity/state. Private socket/admission composition calls these; no public resume wiring or common maintenance lease. |
| W10 — private expiry cleanup | [cleanupExpired](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-store.ts#L30) deletes expired sessions, batch 1..100, SKIP LOCKED plus current-time recheck. No live scheduler/caller in server.ts. | Receipt cascade cost is not bounded by the session batch. No blob removal or reservation refund; deletion still changes receipt evidence. |
| W11 — private DB message/receipt writers | [text writer](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-message.ts#L14), [image writer](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-image.ts#L41), [file writer](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-file.ts#L40) use [operation gate](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-operation.ts#L68): dedicated transaction, room SHARE then session UPDATE locks, revalidation before work/COMMIT. saveOnce variants atomically insert message+receipt; low-level text insert and non-idempotent save also exist. | DB messages/receipts; no FS within gate. Binding/upload grant is authority, not maintenance exclusion. Unknown commit stays unknown. Low-level exported transaction primitive relies on caller contract. |
| W12 — private durable reservation | [reserve](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-upload-reservation.ts#L21) conditionally charges singleton budget and inserts independent attempt in one transaction; missing budget denies; random 64-hex key; no automatic retry/refund. | One DB singleton implicitly assumes one audited storage namespace; schema does not encode a volume/namespace ID. No authentication or all-writer lock inside this primitive. Private storage must own admission first. |
| W13 — private bytes and composition | [ResumeFileStorage.stage](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-file-storage.ts#L43) reserves full grant ceiling before source/FS access, validates identity/current grant, exclusively creates 64-hex directory/blob, accounts writes and fsyncs file/directory/root. [ResumeFileUpload](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/resume-file-upload.ts#L8) settles storage before DB writer. | Constructor-injected absolute root; not bound to live UPLOAD_DIR/volume by server. One registry/storage/composition instance per server is a contract, not a durable multi-process registry. No delete/refund; failed/unknown attempts retain files/charge. Deadline denial is not I/O cancellation or settlement. |
| W14 — implicit FK mutations | [schema](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/src/lib/db/schema.ts#L53), migrations 0004/0006: room deletion cascades sessions, session deletion cascades receipts; message deletion SET NULLs receipt.message_id. Existing messages->room FK is NO ACTION. | Include all cascade/tombstone work in drain; a room with messages cannot simply cascade them under current schema. Attempts intentionally have no FK and survive. Expired receipts never establish orphanhood. |
| W15 — dependency-owned rate limits | [server limiter setup](https://github.com/pennyworth100/brainchat/blob/2efac859ab5ce5ac78b4798998f5932cf948f7bf/server.ts#L234) uses rate_limits via shared pool for create/join/upload. rate-limiter-flexible performs UPSERT and default periodic expired-row DELETE (dependency anchors below). | DB rate_limits, not upload references/ledger. Does not by itself falsify a reference-only snapshot, but “all DB writers stopped” is false if its timer still runs. State explicitly whether a future barrier covers full DB or only named evidence tables. |
| W16 — operator/retention/test actors | Migration CLI, SQL console, another replica/old release, volume restore/shell tools and future retention worker cannot be fenced by an in-process resume grant. PR #6 is unmerged design; no owner-delete/retention worker found in audited runtime. QA scripts mutate explicitly supplied isolated fixtures. | External credentials/process/volume ownership are unverified. Do not infer absence of external writers from rg. Stop/deny them with an independently audited operational protocol before claiming cross-store stability. |

## Dependency evidence (installed locked tree, not vendored source)

package.json pins Multer 2.4.0. The audited disk storage uses
createWriteStream at line 73 and _removeFile at line 125 (unlink at 137/139);
flush is opt-in and not set by server.ts. No private-storage fsync/exclusive-open
guarantee should be attributed to this public storage path.

make-middleware.js lines 175–220 handle abort/request-failure cleanup; lines
394–415 include late storage completion cleanup. Draining only the application
callback misses these paths.

RateLimiterPostgres.js lines 64–97 implement expiry deletion/rescheduling,
244–245 default clearExpiredByTimeout to true, and 307–314 UPSERT consumption.
The tableCreated:true setting skips table setup, not consumption or expiry cleanup.

SHA-256 of inspected installed files:

| File | SHA-256 |
| --- | --- |
| node_modules/multer/storage/disk.js | 756e3ca6eefb2824a8a275b10137a3baa6d75c45d65909a6432d8850be089a28 |
| node_modules/multer/lib/make-middleware.js | 75d1113f73af6ba5a3632de12942273f10b939867800fb2955e26ad9ba6eabb9 |
| node_modules/rate-limiter-flexible/lib/RateLimiterPostgres.js | 7e849dff6e22a4a18af36f2cc05d4e45d5b1e12ce9b2636e7ab014e1261e2a5b |

These describe the audited candidate install, not Multer on deployed 3.0.3.

## Boundaries and search evidence

Inspected server.ts, all non-test src sources, SQL migrations, package scripts,
CI, scripts/qa-*, and plugin storage callers. Searched filesystem create/write/
rename/unlink/remove operations and SQL/Drizzle INSERT/UPDATE/DELETE/TRUNCATE/FKs;
read the associated callers and dependency implementations. This is a source
review, not a formal dynamic-call-graph proof.

- server.ts imports room-policy but no resume module. Private resume classes
  remain dormant in that executable; their unit/integration tests are not rollout.
- GET history/sync/download and evidence collectors do not intentionally mutate
  rows/blob contents. Reads can update atime; “read-only” is not “all metadata unchanged”.
- private-message emits only, without DB/uploads persistence.
- plugins/openclaw-dimle/src/cursor-store.js:32–35 creates/writes/renames its local
  agent cursor file, not the application DB/uploads. It is excluded only on that
  configured-path premise; this audit does not attest the agent host's paths.
- qa-reconnect-upload.ts:33–35 requires loopback host; resume harnesses require
  RESUME_TEST_DATABASE_URL, create named isolated schemas and temporary roots.
  Such input names are not proof that supplied credentials/host are isolated.
  CI explicitly provisions local PostgreSQL and a /tmp uploads root.
- [PR #6 retention design](https://github.com/pennyworth100/brainchat/blob/74bfd0e2113c84e03a3520ce911759e6ce2be9ff/docs/design/retention-3.1.0.md)
  is not implementation. Its age-based orphan proposal is NOT adopted by this
  audit: age/reference absence cannot override unknown commits/attempt provenance.

## Concrete uncovered prerequisite and next slice

**First prerequisite: a truthful lifecycle/drain boundary for legacy upload.**
Before implementing any global barrier, establish in an isolated fault-injection
regression what happens when the existing public save commits but returns an
error. Check DB file reference and owned temporary blob independently. Also
retain explicit cases for delayed touchRoom, late Multer cleanup and delayed
unlink: request completion alone cannot mean writer settlement.

The committed-but-unacknowledged public upload regression (W08) is now
[reproduced in isolation](public-upload-outcome.md): a real committed row remains
after catch cleanup removes its blob. Throwing during emit after successful save
produces the same dangling reference. These are injected counterexamples, not
live incidents. The next slice is the smallest correction preserving bytes on
uncertain outcomes and separating post-save publication errors; no blind replay
or deletion is acceptable recovery. Deferred-writer drain remains unproven.

Later barrier work must close admission across public HTTP/socket writers,
private reservation/storage/receipt writers, maintenance/SQL/replicas and startup;
await already-admitted work and deferred effects; bind DB/schema/root/volume to
one namespace; and fail closed if any participant cannot attest settlement.
A per-process boolean, request count, timeout, successful DB transaction or
successful paired scan alone cannot establish that contract.

This document introduces no barrier API/activation, schema/runtime/dependency
change or version bump. Existing 3.0.11 draft remains unmerged. Evidence remains
provisional, with no absence, ownership, reclaimability or backup-PASS conclusion.
