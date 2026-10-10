# Shared upload reservation: transaction and schema mapping

Follow-up: the [private policy pin](upload-resource-policy-pin.md) implements
immutable trusted-policy capture and locked-policy quote recomputation only.
Connection authority, application vector SQL, additive constraints and physical
admission remain unimplemented; the fixture below is not promoted to runtime.

2026-10-09; source baseline `553c8af6226de2c936f8230619f77e054ab76ef1`,
draft 3.0.11. **Design mapping only: no migration, budget seed, public wiring,
refund, merge or deployment.** This is the concrete successor to the
[resource quote](upload-resource-cost.md), not a claim of physical admission.

## Current implementation and exact incompatibilities

Permalinks below pin the reviewed source rather than moving branch line numbers.

| Existing boundary | What is reusable | What cannot be inferred / must change |
| --- | --- | --- |
| [Quote type and identity](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/src/lib/upload-resource-quote.ts#L5) | Frozen database/schema/namespace/quotaDomain/policyVersion/writerGeneration and separate logical/allocated/object costs | No capacity, durable attempt, proof of identity or permission to write. Caller assertions are not observations. |
| [Reservation validation](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/src/lib/resume-upload-reservation.ts#L21) | Synchronous input snapshot, fresh server-generated storage key | `reservedBytes` is a positive logical ceiling <=104857600, not allocated bytes. Public L=104857600 yields L+1=104857601 even before rounding/overhead, so feeding this quote into the current API rejects before checkout. |
| [Conditional charge and INSERT](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/src/lib/resume-upload-reservation.ts#L35) | One pinned READ COMMITTED transaction; counter and attempt commit together; competing UPDATE rechecks after lock wait | Singleton id=1, one byte dimension; no bound namespace, physical quota, policy, writer generation, baseline or headroom. Unqualified table names rely on connection search_path. |
| [Migration 0008](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/drizzle/0008_dark_grim_reaper.sql#L1) | Empty additive tables; missing budget denies; provenance has no session/room cascade | Existing rows cannot be retroactively assigned a physical identity or inode cost. Do not reinterpret reserved_bytes or rewrite migration history. |
| [Private storage boundary](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/src/lib/resume-file-storage.ts#L54) | Await reservation, recheck current grant, compare returned identity before first open; one attempt per opaque grant | Checks only session/room/message/byte ceiling/key. Root path is not bound to quote identity. The new result must also bind exact namespace/policy/quota/generation and storage adapter/limits. |
| [Private raw chunk enforcement](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/src/lib/resume-file-storage.ts#L85) | Denies an oversized raw chunk before write | Unlike public Multer, it does NOT write a crossing byte. Do not relabel the current private byte ceiling as a public L+1 bound or silently reduce its configured limit. An adapter-specific audited bound is required. |
| [Public parser entry](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/server.ts#L405) | Authentication/limiter precede uploadMiddleware | No durable shared admission; enforcement must be before the middleware, not the successful handler or cleanup callback. Startup root mkdir is a separate provisioning boundary. |

**Consequences:** increasing the old 100 MiB constraint is not sufficient.
Adding an objects column without a shared quota identity still permits double
allocation across namespaces; adding identity strings without a physical fence
still permits old replicas to write outside the ledger.

## Minimal additive durable model (proposed, NOT executable DDL)

Keep migration 0008 and its counters/provenance unchanged. A new private version
needs these three logical records; names are proposed, not existing tables:

| Record | Key and required fields | Invariant |
| --- | --- | --- |
| `upload_resource_domains` | One authority-owned `domain_id` per canonical physical quota in the pinned database/schema; exact `quota_domain`; current `writer_generation`; explicit disabled/active state; audit/provisioning evidence identity; capacity, headroom, baseline and outstanding **bytes AND objects** | One lock/capacity envelope per actual shared resource. No independently replenished domain rows for namespaces or generations sharing the same capacity. Missing/unverified/disabled denies. |
| `upload_resource_policies` | Domain + namespace + immutable policy version; all quote identity fields, adapter/layout/allocation model, parser/raw write limits and audited cost inputs | Namespace-to-domain binding must be authoritative and unique for the operation. Policy immutable; changing generation/version must not clear domain liabilities. |
| `upload_resource_attempts` | Server-generated attempt/storage key; domain + immutable six-field identity snapshot; session/room/clientMessageId; policy/adapter, maxFileBytes, logicalFileBytes, allocatedBytes, objects; timestamp | Full charge and attempt are atomic. No automatic replay, refund, expiry, cascade or reuse of a successful/unknown attempt. Same logical message may have distinct separately charged attempts. |

All numeric DB values require explicit nonnegative safe-integer bounds compatible
with the quote API (<=9007199254740991); capacities must be positive, object
charges >=2 for the supported layout. Decode PostgreSQL bigint exactly and
validate before Number conversion; no coercion of rounded values. Baseline,
headroom and outstanding must fit capacity independently in each dimension.
No default capacity, headroom, identity or audit evidence; no seed in migration.
A known exhausted/zero-available domain denies rather than inventing headroom.

DB/schema must come from a pinned trusted connection identity and fixed qualified
table selection, not request strings or arbitrary search_path. A database name
alone does not identify a server/cluster or physical volume: the canonical
database identity must distinguish them. Two independent databases cannot safely
use local locks over the same physical quota; require one authoritative ledger
or genuinely enforced disjoint quotas. Otherwise activation is a no-go.

## Disjoint liability convention

For each domain, separately for bytes and objects:

`baseline + outstanding + newCharge + headroom <= capacity`

- **Baseline** is the conservatively audited pre-cut liability under a stable
  all-writer barrier, including legacy/unknown allocations. It is not a live
  statfs reading, an empty-table inference or a sum of payload sizes.
- **Outstanding** means all post-cut admitted liability, including completed
  successful uploads, unknown outcomes, empty directories and reservations that
  never reached IO. It does NOT mean only active requests.
- In this minimal monotonic version there is **no settlement transfer**. Success
  leaves the full charge outstanding; baseline stays fixed. Hence the same
  allocation is not counted again in a refreshed baseline.
- A future settled/outstanding transfer would have to atomically increase one
  bucket and decrease the other for one proven attempt, conserving total charge.
  HTTP completion, a receipt, unlink success, age or disappearance cannot justify
  a reduction. No such transition is included here.

Existing 0008 attempts cannot be copied into both baseline and outstanding.
Unknown provenance/allocation requires denial until a separately reviewed
barrier/paired-audit establishes an explicit cut and complete coverage. Retain
old records unchanged; do not zero them to make room. Conservative overcharging
may stop uploads permanently; that is acceptable for this private first slice.

## Proposed atomic reservation sequence

This is a transaction specification, **not runnable SQL or an implemented API**.

1. Authenticate and acquire the existing exact live in-process admission.
   Capture server-owned operation metadata and policy/quote before awaits. Bound
   pool checkout/transaction work without treating a client deadline as rollback.
   Validate the quote's complete identity and safe integers; a quote is not a grant.
2. Begin READ COMMITTED on one pinned client. Lock the canonical domain row
   `FOR UPDATE`. Require one row, active and backed by current audit/fencing
   authority. All policy changes, capacity edits and generation transitions must
   acquire the same domain lock first; multi-domain operations are outside scope.
3. Under that lock read the immutable namespace policy. Check every identity
   field, current writer generation, adapter/layout and exact configured limits;
   recompute/compare charge with the trusted policy. Check both dimensions on the
   same row. Using validated nonnegative values, require
   `newCharge <= capacity - headroom - baseline - outstanding`
   for bytes **and** objects. No read-then-update outside this transaction.
4. Increment both outstanding counters and insert the full attempt snapshot in
   the same transaction. Require exact affected-row counts. Any insert constraint,
   collision, policy mismatch, capacity failure or pre-COMMIT error rolls back
   both counters and provenance. Never return authority based on UPDATE alone.
5. Only an acknowledged COMMIT and successful client finalization returns a
   reservation result. Retain current conservative not-dispatched/unknown
   outcomes and generated attempt identity. Lost COMMIT ACK, lost checkout or
   release failure never authorize filesystem effects or automatic retry.
6. The storage consumer must then recheck the exact opaque live grant, immutable
   result, current physical writer authority and adapter limits **before first
   open/mkdir/read**. Generation change after reservation leaves its charge
   retained and denies the old writer. A DB generation comparison alone cannot
   revoke an already open FD or prevent an old replica's later write.

Domain generation rollover must retain charges from all previous generations.
It is not a new empty budget. A physical all-writer barrier/isolation mechanism
must prevent stale and external writers, including already issued kernel IO;
an application check immediately before write still has a race. Without that
enforcement the transaction is only DB accounting, not shared-volume admission.

## Required failure/race evidence before storage integration

These are acceptance cases for the proposed implementation, not tests passed now.

| Case | Required result |
| --- | --- |
| Bytes fit, objects exhausted (and vice versa) | Denied; neither counter/attempt changes; zero storage effects |
| Two namespaces share one physical quota, concurrent requests | One shared domain lock/budget; accepted charge never exceeds either dimension |
| Policy/generation change racing a waiting reservation | Re-evaluate locked current policy; old identity denied, no fresh empty domain |
| Two independent DBs point at same quota | Configuration denied unless physical quota partition or single ledger authority proved |
| Missing audit/capacity/headroom/ownership/barrier | Denied even when quote arithmetic succeeds |
| Attempt insert fails after both counter updates | Full rollback; no orphan charge or attempt |
| COMMIT ACK lost, worker SIGKILL, release failure | No IO authority from uncertainty; committed liabilities/provenance retained across restart |
| Successful file save, failed unlink, empty-directory remainder | No counter decrement; no automatic transition to baseline |
| Counter/identity decode overflow or malformed bigint | Denied without lossy conversion or arithmetic wrap |
| Quote/result copied, root/adapter/limits mismatched, grant expires after COMMIT | Zero new storage effects; acknowledged charge retained |
| Old replica/FD or external writer can still allocate | Activation no-go; a green DB concurrency test is insufficient |

Existing [isolated PostgreSQL harness](https://github.com/pennyworth100/brainchat/blob/553c8af6226de2c936f8230619f77e054ab76ef1/scripts/qa-upload-reservation.ts#L27)
already covers the OLD singleton's absent budget, 32 concurrent calls, real INSERT
rollback, committed-but-lost ACK and SIGKILL of an application worker. It does not
cover vector capacity, domain identity, DB server/power loss or physical fencing.
Those guarantees cannot be inherited by documentation or schema similarity.

## Verification and next bounded step

Reviewed source baseline has two successful CI runs:
[push](https://github.com/pennyworth100/brainchat/actions/runs/38020099535),
[PR](https://github.com/pennyworth100/brainchat/actions/runs/38020103424).
The prior 513-test/typecheck/build/production-dependency-audit evidence belongs
to that source baseline, not to a newly implemented shared ledger.

This mapping's checks: all 16 pinned source references across the two changed
documents resolve to existing lines, and local links resolve. Sixteen existing
quote/reservation regressions pass. An executed synthetic-policy boundary probe
returns logicalFileBytes=104857601, allocatedBytes=104869888 and objects=2;
passing either byte value to the OLD reservation API rejects before checkout
(0 DB checkouts, no storage call). These are fixture numbers, not live costs.
The initial ESM eval import failed on the project's CommonJS export mode;
the corrected require-based probe passed. Full probe source/results and checks:
`resource-reservation-mapping-20261009-checks.json` in private supervisor artifacts.
No full build, dependency audit or real PostgreSQL rerun is claimed for this
documentation-only change; the previous baseline results above remain historical.

### Isolated executable transaction experiment (2026-10-10 UTC)

[`qa-upload-resource-vector.ts`](../scripts/qa-upload-resource-vector.ts) now
creates and drops its own random PostgreSQL schema with synthetic domain,
policy and attempt records. It is a **fixture-only implementation experiment**,
not the application reservation API, production DDL or migration. CI runs it
against the existing isolated PostgreSQL service. Missing/disabled domains deny.
Two namespaces share one locked capacity envelope: 32 concurrent calls admit
10 and deny 22, conserving both byte and object counters plus provenance.
Independent exhaustion in either dimension denies without mutation. A real
INSERT constraint failure rolls back both increments; a lost COMMIT ACK returns
unknown while the committed charge and attempt remain present.

The generation race observes the waiting backend's PostgreSQL `Lock` event
before the holder changes generation/policy and commits. The waiting old
generation is denied; a new-generation admission retains all earlier charges.
Wrong policy/database/schema/adapter/audit and unsafe bigint decoding do not
admit. Costs, identities, capacity and audit strings are **synthetic assertions**,
not measured volume geometry, canonical connection authority or fencing evidence.
SQL identifier interpolation is limited to generated schema names and fixed
test-case field names, never request input.

Local evidence for this follow-up: **47 PostgreSQL assertions**, 513 existing
tests (508 application + 5 plugin), typecheck and production build PASS;
production-only dependency audit reports zero vulnerabilities. The final
lock-observation change was rechecked with the fixture and typecheck; no runtime
source changed. Full logs are in private supervisor artifacts
`resource-vector-20261010-checks.json` and `resource-vector-20261010-final.json`.
These assertions are additional integration checks, not 47 new unit tests.

This experiment does not implement trusted quote recomputation, an opaque live
grant, connection authority, safe provisioning, production schema constraints,
pool release-failure handling, worker crash recovery or physical enforcement.
No storage call exists; a `reserved` fixture result is not IO authority. Prior
0008 SIGKILL evidence is not inherited by this vector experiment.

Next: extract a private disabled application primitive with an explicit trusted
connection/policy contract and additive schema constraints, then verify its
quote recomputation, exact input snapshot, checkout/release failure and crash
semantics. Keep migration 0008 immutable. No live migration/seed, consumer switch,
public middleware, physical fence claim, refund or activation.
