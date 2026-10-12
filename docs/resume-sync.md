# Private guarded sync adapter

`syncResumeSocket` is registered by `server.ts` for ordinary authenticated joins.
The handler supplies its exact physical socket, owner, immutable binding, shared memberships,
`ResumeHistoryReader` and request-local synchronous ACK. Client data supplies only
roomId/probeOnly, never authority. Wrong-room/copied/stale authority fails before
reading. Full sync uses the transaction-authorized reader and rechecks exact local
membership after the await and immediately before ACK. Presence is recomputed at
handoff. Old ACKs cannot be redirected to successor transports.

One outstanding full read per physical socket, across all callers. Overlapping
requests return false without ACK/read; a stalled read retains this reservation.
Full reads also share a process-local capacity of 100 and a 10-second monotonic
deadline. Trusted server configuration can supply a shared `ResumeCapacity`,
deadline and late-error reporter; never construct a capacity per request. Timeout
or exact-owner close returns false without ACK, but retains BOTH reservations
until the actual read settles. Late errors are observed once (reporter failures
are contained), with no late ACK or automatic retry. An event-loop-delayed timer
cannot permit a post-deadline ACK. These limits do not cancel a PostgreSQL query;
a permanently stuck read intentionally keeps capacity occupied. A healthy owner
may explicitly request fresh history after the previous read actually settles.
After settlement a new explicit sync reads again: there is no authorization or
history cache. Denial/staleness returns false; pre-timeout DB errors and ACK errors
propagate (including ACK-triggered owner close), with no
automatic retry. True means synchronous handoff, not delivery. Caller must catch
errors and define safe, request-local failure/busy responses and rate controls.

Probe returns only `{ok:true}` from current local membership, even during a full
read. It is NOT DB readiness, durable generation or policy validation. Full sync
is not an atomic history/delta snapshot: policy can change after read COMMIT and
messages can arrive between snapshot and network handoff. Coherent public-handler
migration of upload/DM and remaining broadcasts, public resume, gap reconciliation, per-client rate
controls and complete E2E remain open. The actual-server fixture covers this
bounded normal-join/sync and guarded text/image integration, not public resume.
