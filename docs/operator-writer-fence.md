# Operator writer-fence acquisition (3.0.44)

`scripts/production/acquire-writer-fence.mjs` is an operator-only composition primitive, not an application launcher or a production cutover command.

Its reviewed manifest pins database, cluster system identifier, authenticated superuser operator, and three distinct role names **and OIDs** (database owner, runtime, maintenance). Caller must supply a dedicated verified-TLS client and retain exclusive host/provider/operator control; the advisory lock serializes participating sessions only.

Transitions: INVENTORY → committed NOLOGIN → exact PID/full-precision backend-start drain → FENCED. Failures before commit change no login flags. Failures after commit and operator disconnect leave the durable NOLOGIN flags closed; there is no automatic LOGIN, rollback-prepared, or activation path. Prepared transactions, replication, subscriptions, nonstandard extensions, role membership and unknown login/backend authority fail closed. No application schema/history/ACL/grant is modified.

**Not yet deployable:** catalog reader provisioning/privilege audit, FENCED adoption contract, persistent release-bound handoff to ACTIVATING, physical upload authority/capacity, paired backups and rollback still need composition. This primitive currently rejects any additional reader connection/role: do not relax it without the read-only authority contract. Normal identity preflight remains unchanged. A FENCED result is not whole-release PASS.

Regression runs against an owned disposable PostgreSQL cluster; no managed credentials or production writes. CI exercises PostgreSQL 16 and 18. Role expiry values in fixtures are relative, never production credentials.
