# Public upload: committed write followed by destructive error cleanup

## Result (2026-10-09)

**Two counterexamples reproduced; not fixed or deployed.** The public upload
handler catches persistence AND post-save errors in one block, then unlinks the
uploaded file without knowing whether a message already references it.

| Injected condition | HTTP | Independently observed DB rows | Blob after cleanup | Emit calls completed |
| --- | --- | --- | --- | --- |
| None (control) | 200 | 1 | Present, exact bytes | 1 |
| Reject before INSERT | 500 | 0 | Absent | 0 |
| Hide INSERT result after real autocommit | 500 | 1 | **Absent** | 0 |
| Throw during emit after successful save | 500 | 1 | **Absent** | 0 |

Every scenario performs exactly one INSERT attempt, with no replay/retry.
An independent pool reads the fixture schema after the response. The harness
awaits intercepted unlink settlement before checking both the referenced path
and all fixture files. Only the successful control's file remains. All generated
rows and files are confined to a random schema and a temporary root and removed
in `finally`.

## Reproduction and scope

```sh
NO_PROXY=127.0.0.1,localhost,::1 RESUME_TEST_DATABASE_URL=<owned-loopback-test-db> \
  node --import tsx scripts/qa-public-upload-outcome.ts
```

The harness parses `server.ts` with the TypeScript AST and executes the actual
`saveMessage`, `touchRoom`, `deserializeMessage`, storage initializer and final
`/api/upload` handler. It refuses missing/duplicate extraction targets. It uses
real Express HTTP, the actual multipart parser, Multer disk storage, Drizzle,
PostgreSQL autocommit and filesystem operations. It does not copy/reimplement
the handler. The query adapter executes the INSERT to completion before hiding
its result from Drizzle in the lost-result scenario. This is deterministic fault
injection, **not actual network ACK loss or PostgreSQL power-loss testing**.

Admission/authentication and the Socket.IO emitter are substituted. The fixture
has the initial rooms/messages schema plus client_message_id, not the full
runtime/migrations. No server startup, live sockets, live volume, listener,
production/staging credentials or live messages are used. Loopback restriction
does not by itself prove database ownership; use only the dedicated QA database.

The initial proof ran against source commit
`e77da7564380b4c833da7036dae977e5369f215d`; server.ts SHA-256:
`de3d93061b4b8379ce8f399189b9594edee7c931b2de0b498b712e88713ac213`.
The script prints both source revision and server/harness hashes for each run.
Production-release source `4520b649a247e18c1bb30732ba11e40dfaede0e1`
contains the same catch/unlink pattern at server.ts:344–354. That is source
exposure evidence, **not a reproduction or data-loss incident on production**.

## Interpretation and next correction

The CI characterization succeeds when it reproduces the existing defect; green
CI is **not a data-preservation acceptance gate**. A correction must deliberately
replace these two expected-loss assertions with preserved-byte invariants.
The public request currently has no durable idempotent upload receipt: returning
500 and advising retry cannot establish that the first write failed.

Choose the smallest correction that never removes bytes on an unknown commit
outcome and separates persistence outcome from post-save publication errors.
Do not add blind retry, refund, replay or orphan reclamation. Retained bytes need
an explicit bounded-storage/admission policy before wider activation; preserving
bytes alone is not a quota/barrier/recovery solution. Audit definite pre-write
failure cleanup separately rather than inferring failure from any thrown error.

Delayed touchRoom, late Multer callbacks, delayed unlink and common all-writer
drain remain separate unproven gates. No global barrier, production repair,
runtime change, dependency update or deployment is introduced by this proof.
