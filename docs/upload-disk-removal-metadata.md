# Real disk removal: metadata and bounded observation contract

2026-10-09; draft 3.0.11, parent `60b6fd3a3852f5dff0ab4b65dc7bdaa1323d698b`.
Test/documentation only; no production code or dependency change, deployment,
observer wiring, retry, quota activation or deletion outside owned test fixtures.

## Executed boundary

`src/lib/upload-disk-removal.test.ts` uses the real createUploadParser, Express,
loopback HTTP, Busboy and locked Multer 2.4.0 disk storage. A seven-byte multipart
file exceeds the configured six-byte inclusive limit. After the real storage
callback completes and Multer requests cleanup, the test captures a frozen copy
of path/destination/filename, then invokes the real, unmodified disk._removeFile.

| Fixture preparation before disk._removeFile | Real unlink outcome | State before owned teardown |
| --- | --- | --- |
| No namespace change | Success | Empty directory |
| Rename owned file to retained.txt | ENOENT | Exact seven bytes at retained.txt |
| Rename owned file, create directory at original path | EPERM on local macOS; EISDIR or EPERM accepted across CI platforms | Exact seven bytes at retained.txt, empty directory at original path |

These are real OS errors induced by **explicit fixture namespace substitution**,
not a permission-denied regular-file reproduction, spontaneous race, live loss,
or proof that an original regular file remains at its original pathname. No
global fs monkeypatch or replacement unlink adapter is used. The directory case
must not be described merely as an EACCES test. Cleanup in test teardown removes
only the mkdtemp-owned directory after response/callback settlement.

All three cases assert handle/remove/remove-callback/parser counts of one, in
that order. The parser reports LIMIT_FILE_SIZE. This fixture's response is 400;
it does not mount server.ts's production mapping to 413. Both failed unlinks are
present by identity in parserError.storageErrors, with field="file" and the same
mutable file object. **path, destination and filename are already absent on that
object synchronously after _removeFile is entered, before its callback returns.**
The actual OS error separately carries syscall="unlink" and the original path.
The frozen pre-removal snapshot survives. It is internal test evidence, not a
safe public error envelope or a capability for cleanup.

The first test attempt incorrectly expected six stored bytes; it failed before
disk removal. Corrected assertions require all seven bytes actually observed.
Source explains this: multer/lib/make-middleware.js:94–107 passes fileSize+1 to
Busboy for inclusive acceptance, and busboy/lib/types/multipart.js:467–480 pushes
that crossing byte before signaling limit. Rejection at six is **not** a strict
six-byte transient disk ceiling. This is not unlimited overshoot evidence; a
future admission cost must cover the crossing byte plus filesystem allocation,
directory/inode costs and headroom, not just accepted payload length.

## Proposed internal event envelope (not implemented)

Capture identity before invoking storage work; do not derive it from error.file
after removal. A path snapshot alone does not identify a stable inode or fence
namespace substitution. Use a trusted operation identity minted by admission;
the current legacy endpoint does not yet supply that authority.

| Field | Bounded proposed contract |
| --- | --- |
| schema | Constant 1 |
| operationId | Internally minted opaque ID, at most 64 ASCII characters; no user input |
| namespaceId | Audited internal namespace ID, at most 64 ASCII characters |
| phase | Enum: handle, remove, parser |
| outcome | Enum: started, succeeded, failed, unknown |
| errorCode | Allowlist ENOENT, EACCES, EPERM, EISDIR, EIO, ENOSPC, LIMIT_FILE_SIZE, REQUEST_ABORTED, OTHER; map everything else to OTHER |
| sequence | Per-operation safe integer; ordering of observations, not physical durability |

Serialize a fixed shape under 1 KiB; prohibit raw Error, paths, destination,
filename, room/user names, credentials, stacks and file content. IDs belong in
bounded internal event records only, **not metric labels**. Metrics use fixed
phase/outcome/errorCode enumerations only. Handle/parser/removal outcomes remain
distinct: parser failure is not failed deletion; empty storageErrors is not a
universal cleanup-success signal. Missing callbacks remain unknown, not success.
Observer failure must not throw into a storage callback or change its cardinality;
queue length and overflow behavior need an explicit bound before implementation.
An event is not a durable ledger charge, cleanup permission, refund, replay,
writer drain or admission gate. No automatic retry is proposed here.

## Next bounded step

Local verification: 496 application tests + 5 plugin tests PASS (501 total),
TypeScript, production build and diff check PASS; production dependency audit
reports zero vulnerabilities. This does not claim the dev dependency tree is
clean or rerun the separate PostgreSQL integration suite locally. Those checks
remain in CI. The three new cases execute as part of the normal test command.

Review conservative public-parser resource cost from the actual locked source:
accepted payload versus crossing byte, directory/file inode costs, and retained
failure bytes. Define a fail-closed cost contract before selecting runtime wiring.
Do not seed a live ledger, scan for reclaimable files or infer a volume quota.
The shared-volume, all-writer and paired-recovery gates in
[upload-observability-admission.md](upload-observability-admission.md) remain open.
