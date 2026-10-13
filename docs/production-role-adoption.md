# Existing publication role adoption (3.0.41)

`scripts/production/adopt-publication-roles.sql` audits already provisioned roles
without replaying the pristine-role grant installer. Execute it on a real
restricted database-owner login, with session settings `dimle.cutover_runtime`
and `dimle.cutover_maintenance` naming the two existing logins.

The transaction is READ ONLY. It checks exact release migration history, closed
budget, object ownership, role isolation/expiry, foreign database CONNECT and
effective table/column/sequence/function/schema permissions across non-system
schemas. Effective checks include PUBLIC and column grants, grant options and
PostgreSQL 17+ MAINTAIN. Unexpected default ACL grants also fail closed.
It never grants/revokes, creates roles, allocates capacity, migrates or activates.

This is snapshot evidence, **not an activation token**. The advisory lock only
coordinates cooperating migration tools; ACCESS SHARE does not fence all DDL or
history edits. Independently reviewed catalog/owner/ACL lineage, verified TLS,
all-writer and DDL fencing, finite capacity and explicit non-migrating production
composition remain required. PostgreSQL built-in/system privileges are not a
complete host-level security audit. No application startup behavior changes.

The owned PostgreSQL fixture runs a real restricted owner connection, accepts
the reviewed grant plan twice without changing ACL/history/budget, rejects
individual privilege escalations and missing grants, and proves SQL READ ONLY
rejects an attempted budget mutation. CI executes it on PostgreSQL 16 and 18.
