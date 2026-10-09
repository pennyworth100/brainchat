# Private resume text attempt budget (3.0.10 draft)

`sendResumeText` validates payload and exact current physical authority, reserves
write capacity, then consumes a shared process-owned budget **before** DB dispatch.
The key is the authenticated binding's durable session ID, not a client field,
username, transport, generation, or request ID. Reconnect and new call wrappers
cannot reset the budget. Rate rejection releases only its unused capacity lease.

Policy: 120 admitted attempts per session per fixed 60-second window starting at
the first attempt; at most 10,000 live windows. Full state rejects new identities
without evicting live debt. Expired windows are lazily pruned in insertion order;
there are no timers or background tasks. The clock is monotonic. Fixed windows
permit boundary bursts (up to 240 attempts across a boundary), not a rolling limit.

Every dispatched attempt costs a point, including existing receipt lookup,
authorization denial, errors and uncertain commits. No refund on timeout or
disconnect. Invalid/local-stale, socket-busy and capacity-denied requests do not
dispatch or consume budget. An over-limit `committed:false` means no write by
**this invocation**, never proof about a prior attempt with the same request ID.
Keep original ID/content and reconcile uncertain writes; never automatically retry.

This protects this private single-process composition only. New durable sessions,
process restart and separate replicas have separate budgets. It is NOT an IP or
account abuse defense, durable/distributed quota, DB cancellation, or a storage
retention bound. Public handlers remain unmodified; coherent migration and UI
rate-denial behavior still need implementation before staging acceptance.
