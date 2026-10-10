# Aborted upload lifecycle — isolated characterization

2026-10-09, draft 3.0.11. No runtime changes, deployment or live upload.

`src/lib/upload-parser-lifecycle.test.ts` invokes the real `createUploadParser`,
Multer **2.4.0**, Busboy, Express, loopback HTTP and disk storage. Each request
declares an incomplete HTTP body and is destroyed by the client only after an
explicit storage gate is entered. Callback gates, not sleeps, order observations.
The four cases run in the normal `npm test` suite and therefore existing CI.

| Gate / storage contract | Observed ordering and result |
| --- | --- |
| Asynchronous destination, before path exists | Parser error callback returns before naming is released. Disk storage then reports `STREAM_DESTROYED`; no file is created and no removal is called. |
| Asynchronous filename, before path exists | Same ordering and result as destination. |
| Production-style disk engine mutates `file.path`; successful handle callback held | Abort enters removal; parser does **not** return until removal callback. Parser then returns while handle callback remains held. Releasing handle callback does not remove twice. |
| Explicit info-only adapter, successful handle callback held | Disk engine writes via a separate file object; Multer pending file has no path. Parser returns while exact file bytes remain. Releasing handle callback enters late removal; bytes remain while removal is held, then disappear after removal completes. Exactly one removal. |

Every case asserts exactly one parser callback, one handle callback, rejected
request and an empty owned directory after the relevant callbacks settle.
The info-only case is **not the production disk storage contract**: it models an
engine returning the path only through callback info. The same installed Multer
late-success branch is exercised with real disk bytes. It must not be presented
as a reproduced production orphan or lost committed upload.

## Consequence and limits

`skipPendingWait` on request failure means parser completion is not a general
storage-callback settlement signal. Known-path initial cleanup waits for removal;
no-path late success cleans up later. Production-style asynchronous naming checks
the destroyed stream before opening a disk sink. These are distinct guarantees.

No common all-writer barrier, physical-I/O drain, descriptor census, power-loss
durability, fsync, live quota or isolated backup consistency is proved. Fixtures
do not involve DB writes or the public upload handler. Late removal failure and
flush-descriptor races are outside these four cases; neither may be treated as
successful cleanup based on parser completion alone.

Local automation must prepend `/opt/homebrew/opt/node@24/bin` and set
`NO_PROXY=127.0.0.1,localhost,::1`; without the latter the injected proxy prevents
the fixture request from reaching loopback and the test times out. The corrected
run completes using event gates, not an extended timeout.
