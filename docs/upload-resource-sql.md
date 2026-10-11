# Fixed-table resource accounting callback (inactive draft)

`createUploadResourceSqlWork` composes the domain evaluator with the existing
transaction lifecycle. It has **no runtime consumer or storage grant**.
Empty additive migration 0009 is not installed live.
Only use the callback inside `runUploadLedgerTransaction`. A successful callback
means prepared accounting, not committed accounting or permission to write files.

The callback captures a validated policy plus provisioning audit ID and trusted
server operation/writer IDs before awaiting. It locks the single canonical
database/schema/quota-domain row, not a namespace/generation sub-budget; selects
one exact policy under that lock; rechecks all policy inputs, domain generation,
audit and both capacity dimensions; updates both liabilities; inserts the exact
transaction-generated UUID with the full policy snapshot and operation provenance.
All values are parameters. Table identifiers are fixed public tables, not input.
Every bigint balance is selected as text. A callback is single-use even on denial.
No retry, refund, upsert, replay, DDL, filesystem effect or transaction control SQL.
Errors or unexpected affected rows deny and the transaction wrapper rolls back;
dispatched COMMIT uncertainty retains its UUID and both possible liabilities.

## Schema and verification gates

Tables are intentionally not installed live. Additive migration 0009 creates
empty `public.upload_resource_domains`, `upload_resource_policies` and
`upload_resource_attempts`, leaving migration 0008 immutable. Domain primary key:
database_identity/schema_identity/quota_domain; policy primary key additionally
namespace/policy_version/writer_generation; attempt UUID primary key, plus unique
database/schema/domain/operation_id (across writer IDs and generations). Require
foreign keys, nonempty identities, explicit enabled/audit/generation, nonnegative
safe-integer bigint dimensions, positive capacities/charges, capacity envelope
constraints, and nonnull complete JSONB snapshots. No default seed or activation.
No cascade deletion or liability reset. Exact runtime schema/provisioning and
least-privilege role ownership remain unverified. Policy changes and generation
transitions MUST take the same domain lock, preserving liabilities and immutable
attempt snapshots. Domain updates are not proof of a physical writer barrier.

The [schema proof](upload-resource-ledger-schema.md) executes actual migration,
callback, transaction and lease on isolated real PostgreSQL for concurrent
namespaces, capacity rejection, INSERT/UPDATE failure rollback, operation conflict,
generation rollover with a blocked waiter, and ambiguous COMMIT. This uses an
explicit synthetic provider binding, not the real TLS authority. Fake-query tests
only establish sequencing/decoding/parameters, never database atomicity or locks.
Old singleton or vector experiment results are not this implementation's evidence.
Provider TLS/cluster identity, physical fencing and all W01–W16 activation gates
remain mandatory. No live schema, seed, deployment or upload behavior changed.
