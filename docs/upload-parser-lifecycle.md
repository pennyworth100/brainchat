# Aborted upload lifecycle — isolated characterization

2026-10-09, draft 3.0.11. No runtime changes, deployment or live upload.

`src/lib/upload-parser-lifecycle.test.ts` invokes the real `createUploadParser`,
Multer **2.4.0**, Busboy, Express, loopback HTTP and disk storage. Each request
declares an incomplete HTTP body and is destroyed by the client only after an
explicit storage gate is entered. Callback gates, not sleeps, order observations.
The six cases run in the normal `npm test` suite and therefore existing CI.

| Gate / storage contract | Observed ordering and result |
| --- | --- |
| Asynchronous destination, before path exists | Parser error callback returns before naming is released. Disk storage then reports `STREAM_DESTROYED`; no file is created and no removal is called. |
| Asynchronous filename, before path exists | Same ordering and result as destination. |
| Production-style disk engine mutates `file.path`; successful handle callback held | Abort enters removal; parser does **not** return until removal callback. Parser then returns while handle callback remains held. Releasing handle callback does not remove twice. |
| Explicit info-only adapter, successful handle callback held | Disk engine writes via a separate file object; Multer pending file has no path. Parser returns while exact file bytes remain. Releasing handle callback enters late removal; bytes remain while removal is held, then disappear after removal completes. Exactly one removal. |
| Production-style visible path, injected removal error | Initial removal callback reports controlled `EACCES` without unlinking. Parser waits, then returns an abort error whose `storageErrors` contains that exact error, annotated with field and file. Late successful handle callback does not retry removal; exact bytes remain. |
| Explicit info-only adapter, injected late removal error | Parser returns with empty `storageErrors` before late cleanup starts. Removal callback later reports controlled `EACCES` without unlinking; returned error still has empty `storageErrors`, no second parser callback or retry occurs, and exact bytes remain. |

Every case asserts exactly one parser callback, one handle callback and rejected
request. The four successful-cleanup cases assert an empty owned directory after
the relevant callbacks settle; the two removal-failure cases assert exactly one
remaining file with unchanged bytes before test teardown removes its owned fixture.
The info-only case is **not the production disk storage contract**: it models an
engine returning the path only through callback info. The same installed Multer
late-success branch is exercised with real disk bytes. It must not be presented
as a reproduced production orphan or lost committed upload.

## Consequence and limits

`skipPendingWait` on request failure means parser completion is not a general
storage-callback settlement signal. Known-path initial cleanup waits for removal;
no-path late success cleans up later. Production-style asynchronous naming checks
the destroyed stream before opening a disk sink. These are distinct guarantees.

## Removal-error visibility

Failure injection is in the isolated adapter, before any unlink: this is not an
OS permission reproduction or evidence of a live incident. Both cases retain the
actual disk file. Initial cleanup uses Multer's `removeUploadedFiles` error array;
late cleanup uses a callback that ignores its error argument. Thus an empty
`storageErrors` at parser return (or later on the same error object) does not prove
successful cleanup for the alternate info-only contract. The visible-path case
also proves that inclusion in the initial removal set prevents a second attempt
even when the first removal failed. No automatic retry or live reclamation is added.

No common all-writer barrier, physical-I/O drain, descriptor census, power-loss
durability, fsync, live quota or isolated backup consistency is proved. Fixtures
do not involve DB writes or the public upload handler. Flush-descriptor races
remain outside these six cases; parser completion is not a physical cleanup proof.

Local automation must prepend `/opt/homebrew/opt/node@24/bin` and set
`NO_PROXY=127.0.0.1,localhost,::1`; without the latter the injected proxy prevents
the fixture request from reaching loopback and the test times out. The corrected
run completes using event gates, not an extended timeout.
