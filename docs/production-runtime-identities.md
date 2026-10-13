# Production runtime authority configuration (3.0.43)

`productionConfiguration` consumes only explicit
`DIMLE_PRODUCTION_RUNTIME_URL` and `DIMLE_PRODUCTION_MAINTENANCE_URL` plus a parsed
CA certificate. Both logins must target the same database and be distinct.
Migration configuration, URL driver overrides, malformed encodings and ambiguous
database paths are refused. No fallback to DATABASE_URL, PG* or candidate URLs.
TLS certificate/hostname verification, search_path and finite query/connect
timeouts are pinned. Configuration errors never include URLs or passwords.

`verifyProductionDatabaseIdentities` is a read-only prerequisite for pools built
from this configuration. It checks enforced client TLS, server TLS, authenticated
session/current roles, database, search_path, finite unexpired logins, role
restrictions, inbound/outbound membership, ownership, foreign CONNECT, DDL/history
access and protected budget/ledger table and column access. Driver errors are
replaced by one credential-safe rejection. It does not migrate, grant or activate.

The owned TLS/SCRAM acceptance fixture uses these actual modules on the real
non-migrating server path. It rejects identity/database mismatch, expired/infinite
credentials, inherited/member roles, foreign CONNECT, history access, budget
column grants, plaintext/unverified TLS, untrusted CA and bad credentials.
Verification and startup leave migration history and CLOSED budget unchanged;
runtime works without migration credentials and shuts down without backends.

This is **not a production launcher or durable activation proof**. No production
start command has been added. Snapshot identity checks do not replace independent
catalog/owner/ACL adoption, an actual all-writer and DDL fence held through
activation, finite capacity and physical upload authority. Ordinary npm start
still migrates. Managed runtime, physical upload acceptance, fresh paired backup
and final production cutover remain separate gates; the owned fixture is not
managed-provider evidence.
