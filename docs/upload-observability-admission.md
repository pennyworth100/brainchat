# Upload observability and shared-storage admission — release gate

2026-10-09. Source baseline: draft 3.0.11,
`f36594525c5b82d2b0c3dca67a46ec61b22362ec`. Documentation-only review;
no runtime change, live incident claim, deployment, cleanup or budget activation.
Both CI runs on this baseline passed:
[push](https://github.com/pennyworth100/brainchat/actions/runs/38015645182),
[PR](https://github.com/pennyworth100/brainchat/actions/runs/38015647958).
These results do not close the release gates below.

## Observed error paths

| Condition | Current path / evidence | Missing guarantee |
| --- | --- | --- |
| Initial cleanup fails for a known path | [Six lifecycle fixtures](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/src/lib/upload-parser-lifecycle.test.ts#L140) show parser waits for the injected removal callback, includes the controlled EACCES in storageErrors, retains exact bytes, and does not retry after the held handle callback returns. | This adapter fails **before** calling disk removal. It is not an OS permission test and does not establish which metadata survives a real unlink error. |
| MulterError reaches public error middleware | [server.ts:714](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/server.ts#L714) maps LIMIT_FILE_SIZE to 413, other MulterError codes to 400, with generic JSON; it does not inspect storageErrors or log this branch. | The response intentionally hides internal details, but there is no application-owned structured cleanup-failure signal here. A 400/413 is not proof of reclaimed space. |
| Client abort / non-Multer error | Installed Multer creates ordinary Error("Request aborted") and attaches initial storageErrors through abortWithError; [server.ts:719](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/server.ts#L719) forwards non-Multer errors to Express. | Do **not** claim this aborted fixture exercises the 400/413 branch. Framework/default logging may occur; no structured application signal is defined here, and the disconnected client cannot reliably receive a response. |
| Upload save result rejected/unknown | [server.ts:418](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/server.ts#L418) logs the DB error, retains bytes and returns 500 UPLOAD_OUTCOME_UNKNOWN. [Preservation evidence](public-upload-outcome.md) includes lost INSERT result and no-row failure. | Preservation is required, but this path has no durable public-upload attempt/byte/inode charge or structured storage identity in its log. Reference absence is not authority to delete/refund/retry. |
| Alternate info-only late cleanup fails | [Lifecycle evidence](upload-parser-lifecycle.md) shows empty storageErrors even after the late callback fails. | Not the configured production disk contract; no new alternate-adapter test is needed for this review. Empty storageErrors cannot be promoted to a general cleanup-success assertion. |

### Important identity qualification

The installed locked Multer 2.4.0 `storage/disk.js:125–139` copies file.path
to a local variable, then **deletes destination, filename and path on the file
object before unlink**. `lib/remove-uploaded-files.js:10–14` attaches that same
file object to the removal error afterward. Therefore the injected fixture's
`error.file.path` assertion is not a guarantee for real disk unlink failure.
A real fs error may carry its own path; no observer should depend on either
untrusted error shape or post-removal mutable file metadata as durable identity.

Dependency fingerprints and inspected versions are recorded in
[writer coverage](upload-writer-coverage.md#dependency-evidence-installed-locked-tree-not-vendored-source).
The original finding was source-derived. The subsequent
[real disk removal regression](upload-disk-removal-metadata.md) now confirms
metadata deletion and callback counts using owned namespace substitutions and
real OS unlink errors; it does not reproduce an ordinary-file permission failure.

A future observer must capture a bounded, immutable operation/namespace identity
**before** invoking storage work/removal, record completion/error separately, and
observe parser and storage callbacks independently. Use internal opaque IDs and
allowlisted error codes; do not send filesystem paths, filenames, credentials,
raw error objects or file content to clients or metric labels. Observer failure
must not throw into callbacks or authorize deletion/refund. Monitoring alone
cannot enforce capacity or prove physical writer settlement.

## Why existing limits do not bound the volume

[Public storage](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/server.ts#L349)
creates a random directory before Multer opens/writes the file. Authentication
and [IP/socket consumption](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/server.ts#L393)
precede the parser but do not charge aggregate retained bytes or inodes. A
100 MiB/file ceiling limits one file, not lifetime usage; successful uploads,
uncertain saves, failed removals and empty directories all accumulate resources.

[Private reservation](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/src/lib/resume-upload-reservation.ts#L38)
atomically charges a singleton byte budget and records an attempt.
[Private storage](https://github.com/pennyworth100/brainchat/blob/f36594525c5b82d2b0c3dca67a46ec61b22362ec/src/lib/resume-file-storage.ts#L61)
awaits reservation before source consumption or filesystem work. Neither is wired
to public HTTP upload. The singleton lacks namespace/volume identity and an inode
dimension. Its empty migration is not permission to seed a live budget. A DB byte
counter is not an enforced physical-volume quota.

## Minimum integration boundary before activation

This is a release contract to implement and prove, **not a completed barrier API**.

1. **Bind capacity to audited storage identity.** Identify DB/schema, canonical
   namespace/root, backing volume, deployment/process owners and supported old
   releases. Account conservatively for existing bytes, retained unknown attempts,
   directory/file inode use, allocation overhead and safety headroom. Include other
   consumers of the same physical capacity, or enforce a genuinely isolated quota.
   Unknown ownership/capacity means deny, not infer zero from an empty ledger.
2. **Deny before the first filesystem effect.** For public upload the admission
   integration point is after authentication/limiter and **before uploadMiddleware
   at server.ts:405**, not the successful handler or mkdir callback. Reserve the
   bounded maximum resource cost durably; storage creation/write must require the
   exact granted identity and enforce its limit. Startup mkdir (server.ts:50) also
   needs an explicitly owned provisioning boundary. No application body consumption
   or file/directory creation on denied/unknown reservation; transport buffering is
   a separate bounded concern, not eliminated by this gate.
3. **Cover every participant, not only the new code path.** Use the
   [W01–W16 inventory](upload-writer-coverage.md): public disk/parser cleanup,
   private staging/reservation/receipt composition, startup/provisioning, replicas,
   old versions, maintenance/restore/retention and external operators. Fence actors
   unable to present the contract. DB-only message/activity/limiter writers are not
   upload-volume consumers merely because they write DB; they still participate in
   the separately scoped DB/evidence drain. Include actual co-located DB/log/temp
   consumers in physical headroom if the deployment shares capacity.
4. **Unknown stays charged and denied for further work.** Crash, timeout, aborted
   parser, missing reference, late callback or failed deletion is not a refund.
   Keep attempt provenance and conservative byte/inode liability. No automatic
   replay, age-based orphan deletion or counter reset. A correct admission ledger
   still needs independently enforced physical isolation/headroom.
5. **Prove admission separately from settlement.** First prove denied/missing/
   uncertain/namespace-mismatched authority yields zero storage effects, and
   concurrent legacy/private requests cannot bypass shared accounting. Then cover
   crash/restart, old-replica fencing, retained failure charges and inode exhaustion.
   Request/parser completion and HTTP 200 are not a common writer drain. Stable
   paired DB/filesystem evidence and recovery remain separate release prerequisites;
   a scan/statfs observation alone cannot establish an atomic admission budget.

## Exact next bounded implementation slice

The isolated **real disk removal** metadata slice and proposed bounded internal
event envelope are recorded in [the follow-up](upload-disk-removal-metadata.md).
Next review conservative public-parser resource cost, including the observed
fileSize+1 crossing byte, directory/file inodes and retained failure bytes.
Keep public responses generic and preserve callback counts/byte retention.
This narrows actual uncertainty; it does not authorize retry, cleanup, runtime
wiring, a volume scan, merge, staging activation or production.

PR #20 remains draft/unmerged. Existing production exposure and paired-backup
gates remain open. This follow-up changes tests/documentation only; the draft
product version remains 3.0.11 and server.ts is unchanged.
