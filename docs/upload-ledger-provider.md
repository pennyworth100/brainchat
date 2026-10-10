# Private upload ledger provider (draft 3.0.11)

[`upload-ledger-provider.ts`](../src/lib/upload-ledger-provider.ts) composes the
[checkout lifecycle](upload-ledger-lease.md) and [policy pin](upload-resource-policy-pin.md)
inside an owned `pg.Pool`. No runtime route imports this factory. No migration,
seed, live connection, storage switch, deployment or listener change is included.

## Implemented boundary

- Trusted composition supplies explicit host, port, user, password, database,
  canonical infrastructure cluster identity and expected PostgreSQL system ID.
  These primitives are copied before awaiting. No supplied pool/client, arbitrary
  pg options, request schema, connection URL or TLS downgrade is accepted.
- Canonical policy database identity is `JSON.stringify([clusterIdentity, database])`;
  infrastructure must assign **one** cluster identity across endpoint aliases.
  Schema is fixed to `public`; tables are fixed, quoted and fully qualified as
  `upload_resource_domains`, `upload_resource_policies`, `upload_resource_attempts`.
  These planned tables need not exist yet: checkout is NOT schema readiness.
- The owned pool has four connections maximum, five-second connection and
  statement timeouts, two-second lock timeout and ten-second idle-in-transaction
  timeout. TLS certificate verification is mandatory, with optional trusted CA.
  Explicit password callback avoids ambient password fallback; `search_path` is
  `pg_catalog`. Future application SQL must use the supplied fixed table names.
- `pin()` accepts server-owned policy only and requires the exact bound database
  and schema. The pin is additionally registered with this provider. A standalone
  pin, another provider's pin, copy or forgery cannot invoke checkout.
- Checkout obtains one lease, then probes `pg_catalog.current_database()` and
  `pg_catalog.pg_control_system()` on that same lease. Exactly one row with exact
  database and textual system ID is required. Probe rejection, malformed result,
  wrong database/cluster or concurrent shutdown denies and attempts destruction
  once. There is no BEGIN, domain query or mutation before this verification.
- Idle pool errors and checked-out connection errors poison new work without an
  unhandled EventEmitter error. A lifetime client listener is needed because
  pg-pool removes its idle listener during checkout. Probe completion rechecks
  poisoned state before returning a lease.
  Shutdown denies new work and calls pool end once; it does not force-release
  pending queries. An already returned lease remains its caller's responsibility.

## Trust and limits (not optional activation gates)

This is a **trusted composition boundary**, not authorization against arbitrary
in-process JavaScript. The factory is exported for private composition, not for
request-selected configuration. TLS plus system ID is a consistency check, not
proof of physical uniqueness: a cloned cluster can retain the system ID, and
endpoint aliases/failover require audited provisioning provenance. The provider
cannot establish that supplied infrastructure identity is honest or uniquely
mapped. No connection URLs, credentials or query errors are logged here.

`pg_control_system()` may require privileges unavailable to the application role.
That fails closed; this change neither grants privileges nor proposes running as
superuser. Before runtime wiring, independently review the least-privilege
identity-attestation mechanism and actual platform support. No production or
staging connection was attempted for these tests.

The five-second helper deadline covers checkout, not the subsequent probe. The
probe uses PostgreSQL statement timeout, **not a wall-clock/network bound**; a
network stall can remain pending and must never cause premature lease return.
The owned pool's connect timeout and limits supplement, but do not prove,
reclamation of late/hung connections. Pool shutdown may wait for active leases.

A registered policy pin can be checked out more than once. It is not a one-shot
grant, policy freshness proof, durable attempt, admission or filesystem authority.
The private lease still exposes general SQL to the trusted transaction
service. The separately composed SQL callback now locks/rechecks the domain and
policy, charges both dimensions and inserts the exact attempt UUID; the provider
alone does none of these. The [transaction outcome helper](upload-ledger-transaction.md)
tracks COMMIT dispatch/acknowledgment and finalization. Callers must not issue
arbitrary request SQL.
There is no inference from provider success to available budget or safe IO.

## Evidence and next bounded step

Fake-driver unit tests cover owned provenance, same-lease identity probing,
wrong-cluster/same-database rejection, malformed/permission failures, failed
disposal, foreign pins, config mutation, shutdown races and idle/active connection
poisoning (including a late successful probe after an active error).
They do **not** prove real TLS, PostgreSQL role privileges, failover, SIGKILL,
pool resource reclamation or physical writer fencing.

The private transaction helper now retains generated attempt identity and
`commitDispatched`; only acknowledged COMMIT plus successful finalization
produces a committed accounting-only outcome. Any dispatched-COMMIT error or
finalization failure remains UNKNOWN, without replay or IO admission. It does
not prove an attempt was INSERTed; durability remains a SQL-composition contract.
Actual 0009/callback/transaction tests are documented in
[the resource schema evidence](upload-resource-ledger-schema.md). Migration 0008
remains immutable. All [physical release gates](upload-resource-reservation-mapping.md)
remain blocked and must be independently evidenced.

### Isolated real TLS composition (2026-10-10)

`scripts/qa-upload-ledger-provider.ts` adds a separate 33-assertion PostgreSQL 18.1
proof using the actual factory-owned pool, pin, lease, transaction and SQL callback.
It is manually opted in, **not** a live deployment or a CI coverage claim.

- A dedicated loopback PostgreSQL instance on port 55440 uses a one-day fixture
  certificate with SAN `DNS:localhost,IP:127.0.0.1`, mandatory server SSL, and
  `log_statement=all`. Set `LEDGER_TLS_FIXTURE` to its owned
  `/private/tmp/dimle-provider-tls-20261010-<suffix>` directory containing
  `server.crt` and `server.log`, then run
  `node --import tsx scripts/qa-upload-ledger-provider.ts` with Node 24.
  The script creates/drops a random database and nonsuperuser role. The dedicated
  cluster is started/stopped by the fixture owner; never point this at shared PG.
- The provider connects with `rejectUnauthorized:true` and the fixture trust
  anchor. `pg_stat_ssl` reports TLSv1.3; omission of the trust anchor fails closed.
  Foreign pins fail before connection, wrong binding fails at pinning, and a
  wrong system ID fails after the real probe but before BEGIN or mutation.
- PostgreSQL 18.1's default nonsuperuser role **can** execute
  `pg_control_system()` in this fixture. An initial expectation of a default
  denial failed and was corrected. The test records the baseline privilege,
  then revokes PUBLIC EXECUTE **only in its disposable database** to prove the
  actual SQLSTATE 42501/provider-denial path. No privileges/superuser status are
  granted; this is not evidence of a managed-platform permission failure.
- Positive composition uses the already-existing fixture bootstrap role, not
  proof of application-role readiness. Server logs correlate the identity probe
  and BEGIN to the same backend PID, in that order; search_path is pg_catalog.
- One acknowledged real COMMIT persists its exact attempt UUID and 10 bytes /
  2 objects. A second real COMMIT followed by an explicit post-query ACK exception
  returns UNKNOWN, destroys once, issues no ROLLBACK/replay and retains its exact
  durable UUID. Total liabilities remain 20 bytes / 4 objects. This is a controlled
  exception seam, **not** packet loss, SIGKILL or network-fault evidence.

### Reproducible fixture and limited-role composition

The follow-up replaces manual cluster setup with:

```sh
PG_BIN=/path/to/postgresql/bin python3 scripts/qa-upload-ledger-tls-fixture.py
```

Run from a checkout with `npm ci` installed, Python 3, OpenSSL and Node 24 on
PATH, as a non-root user. `PG_BIN` needs `initdb` and `pg_ctl`. The runner creates
a fresh `/tmp/dimle-provider-tls-<random>` directory (resolved to `/private/tmp`
on macOS), private per-run one-day certificate and key, and a new data directory.
It selects an ephemeral loopback port, disables Unix sockets, and allows only
verified TLS over loopback. No existing cluster, credential or configuration is
used. The unique fixture trust anchor verifies the target before database/role
creation. An ephemeral-port race causes startup/verification failure, not fallback.
`fixture.json` supplies the port to the TypeScript test; the old manual invocation
above is historical evidence, not the current setup contract.

The runner stops only its own cluster on normal completion, child failure,
timeout, SIGTERM or Python exception; SIGKILL/host loss cannot guarantee cleanup.
`report.json` and `server.log` remain under the generated directory for inspection.
The test drops its random database and role before cluster shutdown. CI retains
only reports and server logs, never private keys or database files. The separate
`ledger-tls` CI matrix installs PostgreSQL 16 and 18 on separate Ubuntu 24.04
runners and runs this owned fixture with Node 24. Each leg uses its explicit
versioned binary directory and retains a distinct `ledger-tls-pg<major>` artifact.
Fail-fast is disabled so both versions produce independent evidence. Package
minor versions follow the runner's apt repositories; the report records the actual
server version. CI success must be observed, not inferred from local success.

Positive transactions now use the generated nonsuperuser role with no CREATEDB,
CREATEROLE, REPLICATION, BYPASSRLS or superuser attribute. After verifying the
fixture-only permission denial, the fixture owner explicitly grants function
EXECUTE, schema USAGE, SELECT on domains/policies, UPDATE of only the two domain
liability columns, UPDATE of policy_snapshot (required by PostgreSQL FOR SHARE),
and INSERT plus SELECT(attempt_id) on attempts. Six real SQLSTATE 42501 checks
reject changes to generation, deletes, and attempt updates. The role performs
both the acknowledged and UNKNOWN accounting transactions over verified TLS;
the bootstrap role only provisions/inspects the fixture. Local PostgreSQL 18.1:
41 assertions PASS. This is a limited-role composition test, **not** a hostile-SQL
authorization boundary: policy_snapshot remains writable and column grants alone
do not enforce monotonic accounting. It is not proof the managed platform can or
should grant these permissions.

The initial PostgreSQL 16.15 CI fixture passed all 41 assertions with TLSv1.3
and confirmed cluster cleanup (both workflows for commit `02b87c4` succeeded).
Next: consume both PostgreSQL 16/18 matrix reports and verify their server versions,
41 assertions and cleanup independently, without waiving permission review.
Managed-provider support, trusted
endpoint/clone provenance, pool/network failure recovery and physical fencing
remain independent gates. No public consumer, IO authority, live migration,
seed, merge, deployment or listener action follows from this local PASS.
