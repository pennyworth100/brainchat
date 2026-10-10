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
service. No domain lock/policy read, capacity charge or attempt INSERT is
implemented. The [transaction outcome helper](upload-ledger-transaction.md)
now tracks COMMIT dispatch/acknowledgment and finalization, but does not implement
reservation SQL. Callers must not issue arbitrary request SQL.
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
Next extract vector SQL and additive unseeded constraints; keep migration 0008
immutable. All [physical release gates](upload-resource-reservation-mapping.md)
remain blocked and must be independently evidenced.
