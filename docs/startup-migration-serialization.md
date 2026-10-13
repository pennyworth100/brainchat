# Startup migration serialization — unreleased 3.0.11

Both the HTTP server and `npm run db:migrate` now use
`migrateDatabase(pool)`. A dedicated PostgreSQL session takes the
database-local two-integer advisory lock `(1145654604, 1)` **before**
Drizzle creates its migration metadata, reads the last migration, or starts
a migration transaction. Drizzle uses that same session. The session is
destroyed on success or failure, releasing its lock without returning an
uncertain session to the pool. Backend exit releases the lock. Client process
death alone is not proof of backend exit: a backend blocked in SQL may retain
the lock until SQL unblocks and the disconnect is observed.

The server creates its upload root only after successful migrations.
Importing the server or failing/waiting in migrations does not create that
root. HTTP readiness still follows migration completion and Next preparation.
CLI and HTTP startup share the same lock protocol. Do not introduce a second
migration entrypoint that bypasses it.

## Observed failure and acceptance

Before the fix (parent `1a22f29`), two actual server processes were blocked
in pending migration 0010 against a local PostgreSQL database containing
0000–0009. Both had already created their upload roots. Releasing the table
lock allowed both to listen successfully, but produced **two** receipts
for 0010 (12 receipts across 11 migrations). This was an actual duplicate
migration, not just a static-code concern.

`scripts/qa-public-session-fixture.py --startup` owns a disposable cluster,
seeds the exact real first ten migrations through the public Drizzle API,
and starts actual server/CLI processes:

- Concurrent servers: one waits in 0010; the other waits on the advisory
  lock, not a stale migration-history read. Neither upload root exists yet.
  Both eventually start; exactly eleven migration receipts remain.
- `KILL_STARTUP_LEADER=1`: SIGKILL the first process while blocked in 0010.
  Then release the fixture's external table blocker. Once the old backend
  settles/exits, the second acquires the session lock, re-reads migration
  history, completes startup, and leaves exactly one receipt for 0010.
  No administrative backend termination or uncertain-write replay is used.
- `CLI_STARTUP_FOLLOWER=1`: CLI migration waits behind real HTTP startup;
  both complete with one receipt per migration.
- `READONLY_STARTUP=1`: real migration SQL fails on a read-only connection.
  The server exits nonzero without creating its upload root, adding a
  receipt, or retaining its database session.

The fixture inspects PostgreSQL lock waits and migration receipts, not only
exit status or log strings. All owned child processes and the owned cluster
are stopped. The four acceptance cases run in CI after the production build.

## Not a recovery fence

This is a **participating startup/CLI migration mutex**, not a global
cutover/admission fence. It does not fence old production 3.0.3, running
application writers, external SQL/admins, or another program that ignores
the lock. Its lifetime ends after migrations, before upload-root creation,
Next preparation, and HTTP admission. It cannot authorize a paired capture.

It does not prove file/parent-directory fsync, kernel writeback settlement,
physical byte/inode allocation authority, current RPO, PITR, or rollback.
No migration SQL or live platform configuration changed. Existing expanded
schemas and acknowledged writes remain preserved; no old-API replay is
authorized by this change. The draft remains patch 3.0.11 relative to main
3.0.10; it has not been released.

The next cutover step still needs an enforceable boundary covering actual
old/new deployments, replicas, external SQL and volume writers, plus
filesystem/database durability before a fresh paired recovery point.
