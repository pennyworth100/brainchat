# Private ledger transaction outcome (draft 3.0.11)

[Implementation](../src/lib/upload-ledger-transaction.ts) composes the
[owned provider](upload-ledger-provider.md) with reviewed, trusted transaction
work. It has **no runtime consumer**, vector SQL, schema migration, budget seed,
reservation grant, filesystem authority, retry or recovery activation.

A server-generated UUID is captured before checkout and retained in every
immutable result. The trusted work receives that exact attempt ID, provider pin,
fixed table binding and a scoped query function. The future vector SQL must
INSERT that ID with both charges in the same transaction. Generating or returning
an ID does **not** make it durable; only an actual committed INSERT does that.

| Event | Result | Disposal |
| --- | --- | --- |
| Checkout denied/failed | not-committed, commitDispatched=false | Provider owns failure cleanup |
| BEGIN fails | not-committed, false | Destroy once |
| Work denied/throws or a query rejects, acknowledged ROLLBACK | not-committed, false | Release once |
| Failed/malformed ROLLBACK | unknown, false | Destroy once |
| COMMIT rejects or returns a non-COMMIT tag | unknown, true | Destroy once |
| COMMIT acknowledged and release succeeds | committed, true | Release once |
| Any finalization fails | unknown | Never retry disposal |

commitDispatched becomes true **before** the driver call. After that call there
is no ROLLBACK, retry or identity replacement: a lost acknowledgment may coexist
with durable charges and provenance. PostgreSQL can return a ROLLBACK command tag
for COMMIT in an aborted transaction; that is not committed. No outcome authorizes
storage effects. Even not-committed is not an automatic replay instruction.

The work callback is private trusted code, not request input or an arbitrary SQL
plugin. It must use only this query function, await every query, avoid transaction
control SQL, and perform no outside effects. This is not a SQL parser or hostile
JavaScript sandbox. The helper does not prove that policy was locked/rechecked,
both counters charged or the attempt inserted: those remain the next SQL step.

The query scope closes after work completes. Rejected queries are observed even
if work catches them. Outstanding queries force denial and are drained before
ROLLBACK/finalization; retained query functions cannot access a returned client.
There is no network/wall-clock timeout on an in-flight query: forced early return
would not cancel PostgreSQL work and would permit unsafe connection reuse.

## Evidence and next step

Fake-driver tests use the real owned-provider/lease composition and cover
provenance rejection, checkout/BEGIN/work/rollback/COMMIT/finalization failures,
lost ACK identity retention, command tags, swallowed failures, unawaited queries
and scope revocation. These tests are **not real PostgreSQL durability, SIGKILL,
network partition or physical-fencing evidence**.

Local verification: 557 tests (552 application + 5 plugin), TypeScript and
production build PASS; production-only dependency audit reports zero
vulnerabilities. Fourteen new transaction cases are included in that total.
Full private supervisor log: `ledger-transaction-20261010-checks.json`.

The [locked-domain evaluator](upload-resource-domain.md) now implements strict
two-dimensional row decoding and exact policy recheck, without querying or
mutating a database. It is not evidence that a domain lock was acquired.

Next add unseeded constraints without changing migration 0008. Then verify the
fixed-table application SQL against real
isolated PostgreSQL, including both capacity dimensions, rollback and ambiguous
commit. Keep all [physical admission gates](upload-resource-reservation-mapping.md)
closed; do not connect this accounting-only result to public middleware or storage.

## Concrete SQL composition

The inactive [fixed-table resource callback](upload-resource-sql.md) now implements
the canonical domain lock, exact policy recheck, both charges and attempt INSERT.
It is not wired to a route and its required empty additive schema is not installed.
