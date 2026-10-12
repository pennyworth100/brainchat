# Strict resource accounting (inactive draft, 3.0.11)

`createStrictUploadLedgerProvider` → `runStrictUploadLedgerTransaction` →
`createStrictUploadResourceSqlWork` is the explicit strict-writer path.
The existing Multer entry points retain their crossing-byte accounting.
Neither path selects its adapter from a database row or accepts the other
adapter's pin. Provider ownership rejects standalone, copied and foreign pins
before checkout; callback rechecks reject wrong policies before mutation.

Both paths share the transaction lifecycle and fixed SQL implementation:
canonical domain lock, policy recheck, two-dimensional charge, exact attempt
UUID insert, then COMMIT. Strict charge uses L, not Multer L+1. Same domain
means shared outstanding liabilities even across namespaces/adapters.
All trusted provisioners must take that domain lock before changing policy.
Dispatched COMMIT with a lost ACK remains UNKNOWN with its original UUID;
no retry, refund, rollback or filesystem activity is inferred.

Tests cover denial boundaries, immutable inputs, one-shot callbacks, lost ACK,
cross-adapter ownership and actual limited-role PostgreSQL/TLS transactions.
Fixture-only policy provisioning is not live activation.

Migration 0010 explicitly admits both adapter strings in policy and attempt
snapshot CHECKs, preserving every other identity, shape and numeric check.
Migration 0009 remains immutable. ALTER TABLE takes an exclusive table lock;
run via the transactional migrator during the controlled deployment window.
It does not seed, reset liabilities, rewrite snapshots, or grant privileges.
Only isolated fixtures have applied 0010; existing recovery/live schemas have not.

No runtime consumer, seeded live policy, parser integration, reservation grant,
physical allocation bound or deployment approval is established by this module.
Actual volume allocation authority and composed bounded parser/storage/receipt
acceptance remain release gates. Production authorization already exists;
these are technical gates, not another request for GO.
