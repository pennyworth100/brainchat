# Private locked-domain evaluation (draft 3.0.11)

[Implementation](../src/lib/upload-resource-domain.ts) extracts the fail-closed
capacity decision from the isolated vector experiment, composing the existing
[policy recheck](upload-resource-policy-pin.md). **Pure arithmetic only:** no SQL,
DB checkout, counter mutation, attempt insertion, reservation or storage grant.

The next fixed-table SQL callback must hold the one canonical domain row lock,
require exactly one domain/policy row, and supply its current policy plus domain.
This helper cannot verify the lock, row counts, connection identity, freshness
or physical audit. Its expected audit ID must come from trusted provisioning,
not be copied out of the row or a request. Text equality is not audit evidence.

Required domain columns (proposed; no schema migration in this change):

- Exact `database_identity`, `schema_identity`, `quota_domain`,
  `writer_generation`, boolean `active=true` and matching `audit_id`.
- `capacity_bytes/objects`, `headroom_bytes/objects`,
  `baseline_bytes/objects`, `outstanding_bytes/objects`, all selected as text.
  SQL must explicitly cast bigint to text rather than relying on global pg parsers.

Numbers must be canonical nonnegative decimal strings of at most 16 digits and
at most 9007199254740991. Capacities are positive; explicit zero baseline/headroom
are trusted assertions, never defaults. BigInt calculations reject overflow,
malformed values and overcommitted envelopes. Both dimensions must satisfy:

`charge <= capacity - headroom - baseline - outstanding`

The charge is recomputed from the exact immutable policy pin, not supplied by the
request or a stored aggregate. A changed policy composition with the same total
cost is denied. Null is a denial. The immutable evaluation returns the rechecked
quote, audit identity and canonical decimal outstanding-after values for later
SQL use **inside that same locked transaction**; they must never be retained as
an authority or used to overwrite newer counters after releasing the lock.

Generation rollover and namespace changes retain the same shared liabilities.
There is no refund, baseline refresh or counter reset. Repeated evaluation does
not consume capacity; only a future atomic UPDATE + attempt INSERT can do that.

## Verification and remaining boundary

Unit tests cover exact capacity edges, either-dimension exhaustion, every numeric
field's invalid encoding, safe-integer arithmetic, domain/policy/audit mismatch,
accessors, generation liability retention, shared namespaces and owned snapshots.
Synthetic rows are not real PostgreSQL, concurrency, crash or physical evidence.
Existing vector fixture results do not prove this module's SQL integration.

Local verification: 571 tests (566 application + 5 plugin), including 14 new
domain-evaluation cases; typecheck, production build and diff check PASS.
Production-only dependency audit: zero vulnerabilities. Full private log:
`resource-domain-20261010-checks.json`, SHA-256
`198685d980fe1ea7b83a7cbb101bafb38cc558a7c968d2a3c939be881a5bff21`.

Next: compose fixed-table SQL under the [transaction helper](upload-ledger-transaction.md),
bind its exact generated attempt ID and server-owned operation provenance, and
add empty additive constraints without modifying migration 0008. Verify real
isolated PostgreSQL lock waits, both counters, failed INSERT rollback and lost
COMMIT acknowledgment before any storage integration. No public/runtime import,
live migration, seed, listener change, deployment or physical admission.
