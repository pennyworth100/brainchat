# Offline publication schema installation (3.0.37)

`scripts/production/install-publication-closed.sql` is an explicit **owner-only
cutover installer**, not an application startup migration. No production
installation or activation is implied by its inclusion in the release.

## Preconditions

- Drain and fence **all old writers**, including external producers, existing
  transactions, old replicas and filesystem work. Capture and verify a fresh
  paired off-volume database/uploads backup with a pinned rollback image.
- Confirm the exact target database and TLS identity, owner role, eleven base
  migrations, schema integrity, and absence of these six tables. Use an
  authenticated owner connection with stop-on-error behavior. On any error,
  roll back or close the connection; never continue an aborted transaction.
- This installer supports a pristine eleven-migration database. A database
  already modified by private fixtures requires a separately reviewed adoption
  procedure; it deliberately fails instead of overwriting existing state.

## Guarantees and limits

The transaction acquires the shared migration advisory namespace and locks
rooms, messages and resume sessions against concurrent mutation. The existing
connection isolation is explicitly overridden to READ COMMITTED so backfill
includes writers that settle while the installer waits. Inherited non-owner
default grants cause rollback rather than exposing new tables or functions.
The existing table owner must execute it. It installs six publication/admission tables,
message triggers, and a complete historical publication backfill atomically.
The budget starts CLOSED: max rows/JSON-envelope bytes equal actual used values.
No new message capacity, physical storage quota or candidate allocation is
created. Conflict retries do not spend capacity. Re-running fails without
resetting accounting. A partial-schema conflict rolls back all new objects.

These SQL locks do **not** prove all-writer drain, physical storage settlement
or a paired recovery point. The JSON-byte budget is not PostgreSQL disk/WAL
accounting. The 5-second lock timeout and 30-second statement timeout fail closed;
a larger dataset requires measured, reviewed maintenance settings, not retries
that silently raise limits.

## Still required before production activation

Explicit separate runtime/migrator/maintenance composition; audited role-specific
grants (runtime must never own or modify the budget); an approved finite capacity
policy; real physical upload authority and successful upload/download/crash/
exhaustion acceptance; final release audit and fresh paired recovery proof.
Ordinary `npm start` remains legacy. Do not deploy this release merely because
the installer or CI passes. Max's production authorization is already granted.

## Isolated acceptance

`PG_BIN=/path/to/postgresql/bin python3 scripts/qa-production-publication-fixture.py`
creates a disposable loopback cluster. It tests the real installer against the
eleven migrations, a pending legacy transaction, non-owner execution, partial
schema collision/rollback, CLOSED admission, replay refusal and runtime quota
denial. It never contacts a managed database.
