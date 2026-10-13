# Offline publication schema installation (3.0.40)

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

Both offline transactions now require the exact eleven release migration
SHA-256 hashes and timestamps, comparing both directions with `EXCEPT ALL`.
Missing, duplicate or changed history is refused before schema/grant mutation;
a table lock protects the history check until commit. Updating this release
baseline requires deliberate review and real PostgreSQL acceptance. This is
history verification, **not** independent attestation that nobody altered live
schema objects after migration. The production startup composition remains required.

## Independent offline schema fingerprint (3.0.40)

`scripts/production/catalog-fingerprint.py` compares a read-only whole-database
`pg_dump --schema-only --no-owner --no-privileges` fingerprint to an explicitly
supplied release SHA-256. Build the reference independently in an owned disposable
database from the reviewed migrations (and CLOSED installer at the installed
phase). Use the same PostgreSQL server and dump versions and extension baseline.
Never obtain the expected hash by blessing the managed target's current schema.
No universal reference hash is bundled: the PostgreSQL 16 and 18 baselines differ.

Supply the URL only through `DIMLE_CATALOG_DATABASE_URL` and invoke with
`--pg-bin`, `--ca-file`, and `--expected-sha256`. CLI connections require
`verify-full`; query-string connection overrides and missing roots are rejected.
It emits only a hash/byte count on success and a sanitized failure otherwise.
The only normalized dump content is the paired random psql restriction nonce.
Definitions, disabled triggers, RLS, defaults, indexes, functions and unexpected
schemas remain in the comparison. Failed/partial reads cannot become PASS.

This is **not** an ACL/role/ownership or migration-history attestation, data
backup, physical-capacity proof, or an atomic startup gate. Its schema-only
coverage is the definitions exported by pg_dump, not system catalogs or the
internal definitions of extension-owned objects; those require independent
trusted server/extension provenance. It must not be called full catalog proof.
An explicit URL username, port and database are required; libpq receives decoded
connection fields in its environment, never a credential-bearing command line.
GSS encryption fallback is disabled so non-fixture connections require TLS.
Its schema-only
snapshot does not close a check/use race: all DDL authorities must remain fenced
through activation. Explicit production integration, target-specific reference
generation and actual managed comparison are still unfinished. Do not replace
the existing separate role/history checks with this fingerprint.

The owned PostgreSQL fixture now verifies unchanged-history drift for disabled
admission triggers, missing indexes, added columns, changed SECURITY DEFINER,
extra schemas and enabled RLS, with exact restoration and repeated-dump equality.

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

## Fenced catalog reader compatibility (3.0.46)

The optional catalog reader is a fourth isolated principal, not the application
runtime. The operator audits its effective authority before and after durable
NOLOGIN fencing; errors never automatically reopen writers.

The release necessarily contains `admit_message_write()` and
`enqueue_message_publication()`. A blanket ban on user routines incorrectly
rejects this schema. The reader audit permits only zero-argument PL/pgSQL
functions returning PostgreSQL's trigger type, with no effective reader EXECUTE.
The built-in PL/pgSQL handler rejects ordinary invocation before executing the
body; a reader without DML/DDL/ownership cannot cause the write triggers.
Ordinary routines remain forbidden even when EXECUTE is revoked, because
casts/type I/O can invoke them indirectly. C, internal and custom-language
trigger routines are not covered by this exception.

This is an authority check, not a replacement for the independent canonical
catalog and owner/ACL comparison. Do not drop required release triggers to pass
the reader audit or replay the existing grant installer. PUBLIC large-object/WAL
mutation rights must still be removed by separately reviewed provisioning.
The real PostgreSQL fixture uses the exact installer trigger definitions and
verifies denied direct calls, denied DML, non-PL/pgSQL rejection, and schema-only
pg_dump while writer logins remain closed. Managed provisioning, activation,
physical uploads and paired backup remain separate gates.
