# Shared server producer settlement (3.0.11 candidate)

3.0.14 update: the CLI now connects initialized-process SIGTERM to this drain.
See [process shutdown](process-shutdown.md). The historical composition and
multi-producer proof below remain valid; the former absence of a signal hook
is superseded only for a successfully initialized candidate CLI process.

`main()` now returns the actual server's private `lifecycle`. This is not a
public HTTP control endpoint and installs no SIGTERM hook. CLI startup remains
unchanged; import does not automatically listen. The owned acceptance fixture
imports and starts the same production server, migrations and adapters.

## Actual composition

- POST rooms, send and upload acquire permanent admission **before JSON/body
  parsing**. The complete application chain is retained through limiter SQL,
  authorization, parser/storage, persistence, publication and lease release.
  GET messages also retains its actual queries.
- join-room, sync-room, send-message, send-image and private-message dispatch
  through the same gate. New physical connections are disconnected after close;
  existing ones cannot start another protected handler.
- An enumerable owner registry complements the socket WeakMap. Disconnected
  owners remain until their actual close settles, then are removed. Close
  failures are counted even after an owner leaves the registry.
- Stop closes admission synchronously and permanently, stops expiry scheduling,
  fences every retained owner, and waits for all admitted handlers and actual
  owner cleanup. It waits for expiry and only then settles activity. Repeated
  calls return the same promise. A stuck producer keeps settlement pending.
- Callback/handler failure counts and expiry/activity results are retained.
  Settlement is **not** proof that each mutation succeeded or rolled back.
  An expected aborted upload may contribute a handler failure.

## Parser abort is not storage completion

Multer 2.4's request-failure path calls `abortWithError(err, true)`: it can call
`next(error)` while a storage engine is still naming/writing a file. A later
engine callback can start another `_removeFile` cleanup.

`UploadStorageSettlement` retains both actual engine methods independently,
registering before invocation and releasing only after the engine callback
returns. The parser stage waits for its own result **and** this dynamic set,
including synchronous parser throws. Only then can the upload grant and the
server's admitted-handler lifetime be released. Response finish/close does not
release either. No new cleanup/retry policy is introduced.

A real HTTP/Multer aborted-upload regression deliberately delays engine
completion and its nested removal callback. It proves Multer has already
returned its error while the server must still retain storage and cleanup.

## Acceptance and limits

`python3 scripts/qa-public-session-fixture.py --lifecycle` uses a separate owned
PostgreSQL cluster and actual server.ts HTTP/Socket.IO/disk storage. A PostgreSQL
SHARE table lock allows receipt reads but blocks three independent message
INSERTs (HTTP agent, socket text, upload). Two additional partial multipart
writers are kept open. Drain must reject incomplete JSON requests without
waiting for their bodies; existing socket events must reject before DB work.
Disconnect, SQL unlock and a sibling upload abort cannot settle the remaining
multipart writer. Actual callback/transaction completion and zero retained
handlers/owners are required. The test neither replays nor compensates writes.

This is **one initialized process's application-producer drain**, not a global
recovery/cutover fence. It does not flush kernel writeback, prove fsync/directory
durability, bound physical allocation, stop replicas/external DB writers, fence
startup migrations, establish a fresh RPO, or install a deploy/termination
protocol. The current old production image lacks this API. No live deployment,
signal handler, credential upload activation or recovery capture is authorized
by merely passing this fixture. The already-granted release authorization still
requires all technical gates. Next: integrate a reviewed process/platform
cutover boundary, physical authority and current-candidate recovery acceptance.
