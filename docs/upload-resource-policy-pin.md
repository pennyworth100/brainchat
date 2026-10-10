# Private upload policy pin: implemented boundary and authority contract

2026-10-10 UTC; draft 3.0.11. No public wiring, migration, budget seed,
storage-consumer switch, deployment, refund or activation.

## Implemented bounded slice

[`upload-resource-policy-pin.ts`](../src/lib/upload-resource-policy-pin.ts)
captures the exact six-field identity, adapter and every arithmetic policy input
synchronously before checkout/await. It recomputes its quote rather than trusting
a supplied `quote`, `allocatedBytes` or `objects` property. Only the explicitly
named `multer-crossing-byte-v1` adapter is supported; the current private raw
writer has different chunk semantics and is deliberately rejected.

The returned frozen pin is registered in a module-local WeakMap. Copies,
serialization and fabricated objects cannot recheck it. This is **not an
authorization boundary against arbitrary in-process JavaScript**: a trusted
caller can create pins, and any holder may recheck one repeatedly. No expiry,
one-shot admission, durable attempt or IO authority is implied.

`recheckUploadResourcePolicy(pin, lockedPolicy)` snapshots and recomputes current
policy using the pinned identity. It requires equality of *all* cost inputs, not
just equal resulting totals. A generation/namespace/DB/schema/policy/quota change
denies, as does a same-cost change to geometry or overhead composition. Returned
data, policy identity and quote identity are independently owned and frozen;
mutating caller inputs after an await cannot rewrite the captured snapshot.
Own data descriptors avoid executing getters; hostile Proxies are outside this
trusted-data contract. Invalid inputs return null; unexpected JS exceptions must
be caught by the future reservation transaction and never converted to admission.

## Exact trusted connection interface (required; private provider slice implemented)

The future reservation service must be constructed only in the server's trusted
composition root with a **closed, authority-owned connection provider**, not an
arbitrary caller pool. Its contract must supply:

| Provider field / operation | Required invariant |
| --- | --- |
| Canonical ledger database identity | Identifies server/cluster plus database, not just `current_database()`. Established by trusted infrastructure/provisioning; never from a request. |
| Schema and fixed qualified table identifiers | Selected at construction by trusted configuration; no request-controlled schema, interpolation or `search_path` authority. |
| Namespace / quota-domain mapping | One canonical ledger row per shared physical resource across all namespaces and generations. Independent ledgers require enforced disjoint quotas. |
| Bounded `checkout()` | Produces one exclusively leased client for the entire transaction; no queries on another connection. Rejection yields no reservation or body/FS effects. Late checkout completion must release/destroy its client, not restart the operation. |
| Client finalization | Exactly one release/destroy attempt. A failure after dispatched COMMIT is unknown, never a successful reservation; no automatic replay. |
| Policy reader | Reads a complete, immutable-version policy on that client **after** acquiring the canonical domain lock. Uses trusted exact identity, never caller-provided charge. |

Merely accepting an object with these fields would **not verify this contract**.
The private [owned-pool provider](upload-ledger-provider.md) now supplies fixed
connection/policy binding and same-lease cluster/database probing. Actual trusted
infrastructure provisioning evidence, composed transaction lifecycle tests and
additive constraints remain missing. A separate private
[checkout lifecycle mechanism](upload-ledger-lease.md) now tests bounded checkout,
late disposal and exactly-once finalization with a fake driver; it does not
authenticate the connection or implement this provider. The policy-pin helper
neither opens a connection nor claims any was authenticated.
The pin must not be advertised as that missing provider or an opaque storage grant.

## Required transaction placement

1. Authenticate and obtain the exact live operation grant. Load server-owned
   policy, bind its identity to the trusted provider, then pin it before awaiting.
   A request can identify a logical operation, not pick policy/cost/ledger authority.
2. On the exclusively leased client BEGIN READ COMMITTED and lock the canonical
   domain row. Check active state, current generation, audit authority and both
   capacity dimensions. All policy edits/rollovers must first take this same lock.
3. Read authoritative current policy under that lock and recheck the pin. Null
   means rollback before either counter UPDATE or attempt INSERT. Use only the
   returned recomputed quote for the atomic charge and immutable attempt snapshot.
4. Both counters and provenance commit together. Only acknowledged COMMIT plus
   successful finalization may return a **DB reservation**, still not IO authority.
5. Before filesystem work, separately recheck live opaque grant, exact returned
   namespace/root/adapter/limits and physical writer authority. A DB generation
   check cannot revoke existing FDs, issued IO or external writers. Without the
   physical fence and disjoint audited baseline, activation remains blocked.

This module implements only policy capture/recheck from steps 1/3. It does not
assert a lock was held, execute steps 2/4/5, consume a body or touch storage.
The existing fixture-only vector SQL experiment remains separate and synthetic.
No guarantee is inherited from the old singleton reservation's crash tests.

## Evidence and next slice

Nine new regression tests cover recomputation despite forged charge properties,
mutation across await, all six identity dimensions, same-charge policy changes,
every numeric input, unsupported adapters, forged/copied pins, accessors,
overflow and nested immutable snapshots. Tests use synthetic costs, not measured
production geometry. No new PostgreSQL/crash/physical-fence evidence is claimed.

Local verification: 522 tests (517 application + 5 plugin), typecheck, production
build and diff whitespace check PASS; production-only dependency audit reports
zero vulnerabilities. Initial full-suite execution encountered localhost fetch
failures through the ambient proxy; the corrected run set both `NO_PROXY` and
`no_proxy` to `127.0.0.1,localhost,::1` and passed. Complete failed and successful
logs are preserved separately in private supervisor artifacts
`policy-pin-20261010-checks.json` and `policy-pin-20261010-verified.json`.
The latter SHA-256 is
`a7f591929935dff453f551050107f00f8007c470adb26f2053659da720abb03f`.
Explicit source search finds no public/runtime consumer; `server.ts` is unchanged.

Next bounded slice: compose the private owned-pool provider with a transaction
state machine and test the outcome contract
(especially COMMIT uncertainty and finalization failure) before extracting
application vector SQL. Keep migration 0008 immutable, new
constraints additive and unseeded, and the draft disabled. The complete mapping
and physical-release gates remain in
[upload-resource-reservation-mapping.md](upload-resource-reservation-mapping.md).
