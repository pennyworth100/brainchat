# Operator writer-fence acquisition (3.0.45)

`scripts/production/acquire-writer-fence.mjs` is an operator-only composition primitive, not an application launcher or a production cutover command.

Its reviewed manifest pins database, cluster system identifier, authenticated superuser operator, and three distinct writer role names **and OIDs** (database owner, runtime, maintenance). Caller must supply a dedicated verified-TLS client and retain exclusive host/provider/operator control; the advisory lock serializes participating sessions only.

Transitions: INVENTORY → committed NOLOGIN → exact PID/full-precision backend-start drain → FENCED. Failures before commit change no login flags. Failures after commit and operator disconnect leave the durable NOLOGIN flags closed; there is no automatic LOGIN, rollback-prepared, or activation path. Prepared transactions, replication, subscriptions, nonstandard extensions, role membership and unknown login/backend authority fail closed. No application schema/history/ACL/grant is modified.

An optional fourth, distinct catalog reader is pinned by name/OID and audited before mutation and after draining. It stays LOGIN and its client backends are retained only after that audit. Effective privileges include PUBLIC and column grants; ownership, memberships, TEMP/CREATE, DML/MAINTAIN, sequence mutation, selectable user views/foreign tables and all user-defined routines (including indirect cast/type-I/O entry points) are rejected. PUBLIC large-object/WAL mutators must already have been revoked by reviewed provisioning; this code never edits ACLs. The only built-in UPDATE exception is pg_catalog.pg_settings (session-local settings under normal PostgreSQL permission checks), not arbitrary catalog writes. Trusted built-in catalogs and the exclusive superuser/operator boundary remain prerequisites.

**Not yet deployable:** managed catalog-reader provisioning, FENCED adoption contract, persistent release-bound handoff to ACTIVATING, physical upload authority/capacity, paired backups and rollback still need composition. Uninventoried roles/connections are still rejected; an audited reader does not authorize activation. Normal identity preflight remains unchanged. A FENCED result is not whole-release PASS.

Regression runs against an owned disposable PostgreSQL cluster; no managed credentials or production writes. CI exercises PostgreSQL 16 and 18. Role expiry values in fixtures are relative, never production credentials.
