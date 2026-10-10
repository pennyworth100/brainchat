# Private resource ledger schema (3.0.11 draft)

Migration 0009 adds **empty, unseeded** public resource domains, policies and
attempts. Migration 0008 is unchanged. There is no runtime consumer, live
migration, provisioning, refund, cleanup, storage permission or deployment.

- Canonical domain PK is database/schema/quota-domain, independent of namespace
  and generation. Both byte and object balances are explicit safe-integer
  bigints, with positive capacity and headroom + baseline + outstanding <= capacity.
- Policy PK additionally includes namespace, policy version and writer
  generation. Restrictive domain FK; attempts have a restrictive policy FK.
  Historical policy keys must remain while attempts reference them.
- Attempt UUID PK and unique database/schema/domain/operation ID prevent a
  duplicate operation across namespaces, writers and generations. No upsert.
- Nonempty bounded identity/audit/provenance; positive safe-integer charges;
  complete JSONB policy snapshots include matching identity, fixed adapter/model
  and required safe-integer cost inputs. SQL guards reject absent/NULL fields.
  Exact quote recomputation remains mandatory in the locked callback.
- No liability defaults or seeds. Generation changes preserve outstanding
  liabilities. FKs intentionally do not bind historical attempts to the current
  generation; generation checks happen under the canonical row lock.

This schema is not a hostile-SQL security boundary. Trusted provisioners must use
the canonical domain lock for all policy/domain changes. Audit-ID equality is
not a physical audit; DB generation cannot fence old descriptors or kernel IO.
The application's stricter JS text validator remains mandatory; PostgreSQL
collation/character length and index byte limits are not identical to JS.

## Reproducible isolated evidence

On the **owned** loopback PostgreSQL at port 55439 only:

```sh
RESOURCE_TEST_ADMIN_URL=postgresql://dimle@127.0.0.1:55439/postgres \
  node --import tsx scripts/qa-upload-resource-ledger.ts
```

The script creates one random database, applies actual migration 0009, verifies
all three tables start empty, and drops that database in finally. It exercises
the actual callback, transaction wrapper and lease on real PostgreSQL through an
explicit **synthetic provider seam**; it does not establish TLS/provider identity.

Coverage: two namespaces/one shared domain, 32 concurrent attempts, exact 10
commits/22 denials and both balances; each exhausted dimension; DB UPDATE/INSERT
constraint failures roll back both accounting dimensions and attempt rows;
cross-namespace/cross-generation duplicate operation denial; lost COMMIT ACK
retains exact durable UUID and charges, destroys once, never rolls back/replays;
observed blocked old-generation waiter denies after generation switch; new
generation preserves old liabilities. Constraints include malformed snapshots,
unsafe/fractional/zero costs, negative/out-of-envelope balances and restrictive
deletion. Fixture costs and cut audit are synthetic, not physical observations.

Still gated: real TLS provider composition, physical quotas/all-writer barrier,
live migration lock/size/recovery audit, deployment and Max's production GO.
