# Join lifetime settlement (3.0.11 candidate)

A transport deadline/ACK is not the completion of a database writer.

- `consumeJoinLimits` starts both IP and room charges and waits for both actual
  promises, including when one rejects synchronously or asynchronously. Both
  charges remain one-shot; no replay, rollback or compensation is inferred.
  If both fail, IP-before-room precedence selects the original error object.
- `ResumeSocketOwner.close()` fences synchronously, releases membership
  synchronously and returns the same retained promise on repeat calls. That
  promise now waits for both admission cleanup and actual join issuance /
  publication settlement, not the client-visible timeout race.
- A stuck query keeps close pending. Late issuance can commit a generation-zero
  row after the transport is gone; it must not advance, publish or retry.
  An issuance failure is still delivered through join or the late-error reporter;
  cleanup errors retain close's existing rejection contract. Settlement is not
  proof of successful mutation or absence of a late committed session.

## Evidence

Four new real-Socket.IO regressions fail on the previous implementation: timeout
with late success, timeout with late rejection, physical disconnect during
issuance, and publication still running after admission. They pass with the fix.
Four limiter tests cover either failing sibling, synchronous throw, dual error
precedence and successful one-shot charging.

`scripts/qa-join-settlement.ts` uses an owned random PostgreSQL schema, actual
RateLimiterPostgres/ResumeStore and real Socket.IO. Independent pg_stat_activity
observes locked INSERTs. A missing-table rejection must not hide a sibling's
in-flight charge. After join timeout, close stays pending until an actual INSERT
commits or PostgreSQL cancellation rejects it. The late row is generation zero,
with no CAS, publication or retry. This is an owner/adapter test, not a full
server shutdown acceptance.

## Entrypoint inventory and remaining composition

| Producer | Actual completion requirement |
| --- | --- |
| Startup upload-directory creation, migrations, Next preparation | Finish before listen; prevent overlap with cutover, replicas and external tools. |
| POST /api/rooms | Admission before JSON body parsing; retain limiter consume and room INSERT through handler return. |
| POST /api/send | Retain room lookup, message insert/receipt, activity UPDATE and fanout through handler return. |
| POST /api/upload | Close admission before body/parser; retain rate charge, authentication, parser/storage callbacks, transaction, activity and lease release. HTTP close alone is insufficient. |
| join-room | Both limiter charges, room claim/password checks, actual owner issuance/admission/publication; bounded client timeout is not settlement. |
| sync-room | Actual operation/history query and callback completion, including timeout-owned work. |
| send-message / send-image | Transaction/receipt, fanout and activity after ACK; ACK alone is insufficient. |
| private-message | Both policy checks and post-recipient-ACK validation through handler completion. |
| disconnecting / disconnect | Synchronous fencing plus retained owner close/cleanup and synchronous presence fanout. WeakMap alone does not enumerate all owners. |
| Expiry scheduler / activity writer | Stop expiry scheduling, then settle its actual query; settle activity only after producers can no longer enqueue. |

The initialized-process composition is now implemented and verified by
[server lifecycle settlement](server-lifecycle-settlement.md), including
concurrent HTTP/upload/socket + PostgreSQL drain and cancellation acceptance.
Its private stop API is not a deployed global cutover/signal boundary.
Kernel/filesystem flush, startup/replica/external-writer fencing, physical
byte+inode authority and a current-candidate recovery point remain unproven.
Do not install a partial SIGTERM hook and call it a global fence.
