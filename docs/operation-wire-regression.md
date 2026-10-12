# Local operation-gate wire regression

Run from a checkout with dependencies installed and Node 24 on PATH:

```sh
PG_BIN=/path/to/postgresql/bin npm run test:operation-wire
```

Requires Python 3 and PostgreSQL `initdb`/`pg_ctl` (non-root user).
The runner creates its own trust-auth, loopback-only temporary cluster.
It removes inherited PostgreSQL routing variables and DATABASE_URL, sets an
explicit RESUME_TEST_DATABASE_URL plus owned port, and stops/verifies the cluster
in finally, including when the child crashes or fails. Temporary server logs/data
remain under the reported path for diagnosis. Never point this at a managed DB.

Four cases share one fixture: socket and upload authority, each with connection
loss before COMMIT (caller suspended on an explicit latch) or after server COMMIT
(response frames C/Z withheld). An observer verifies actual rollback/lock release
or committed receipt retention. Assertions cover outcome, exactly one broken
checkout release, no success publication, retained admission and removal of the
gate's exact listener identity. No added checkout error listener masks a crash.

No sleeps order the injection; work latches and complete protocol frames do.
The watchdog is only a failure bound. A diagnostic receipt is not message SQL.
This is not public activation, physical power-loss, managed recovery/failover,
a callback cancellation/deadline guarantee, or permission to retry/refund/delete.
The runner is opt-in and is not part of normal npm test or deployment.
CI explicitly runs it in the existing PostgreSQL 16/18 owned-cluster matrix.
