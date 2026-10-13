# Offline publication schema installation (3.0.38)

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

Explicit production runtime/migrator/maintenance startup composition; managed
application of the audited offline grants below; an approved finite capacity
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

## Offline role grants (3.0.38)

`grant-publication-roles.sql` is an explicit, single-transaction grant plan. It
must run as the restricted NOINHERIT database owner after the CLOSED installer.
It creates no LOGINs and changes no passwords, database ACLs, role memberships,
capacity budgets, or live application configuration. It does not enable uploads.

Before execution provision two distinct restricted LOGINs, remove their access
to other databases, remove PUBLIC CREATE/TEMP and application-object privileges,
and grant CONNECT only to this target. Set `dimle.cutover_runtime` and
`dimle.cutover_maintenance` on the same authenticated owner session using
parameterized `set_config`; these are role names, never credentials. Identifier
quoting is performed by PostgreSQL, not shell substitution. Use verified TLS and
stop-on-error. Close or roll back the session on any failure.

The plan refuses elevated/inheriting roles, incoming or outgoing membership,
foreign database CONNECT, object ownership, CREATE/TEMP, effective existing table,
column, sequence or application function rights (including PUBLIC), non-owner
application objects, a non-eleven-migration baseline and an open message budget.
Runtime receives only producer/publication DML and sequence USAGE. Maintenance
receives only scoped expiry-cleanup DML and row-lock columns. Neither gets message
DELETE, schema CREATE, quota, physical ledger or receipt-upload authority.
Replay is deliberately rejected; this is not a privilege reconciliation tool.

The existing actual TLS/SCRAM candidate acceptance now consumes BOTH production
SQL files, not fixture-only schema/grants. It verifies dirty column-grant rollback,
replay refusal, quota/message-delete/DDL denial, CLOSED budget preservation, real
room creation and settled shutdown. This remains an isolated test, not managed
production installation, finite-capacity approval or physical upload acceptance.
