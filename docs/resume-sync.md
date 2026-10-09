# Private guarded sync adapter

`syncResumeSocket` is not registered by `server.ts`. A future server handler must
supply its exact physical socket, owner, immutable binding, shared memberships,
`ResumeHistoryReader` and request-local synchronous ACK. Client data supplies only
roomId/probeOnly, never authority. Wrong-room/copied/stale authority fails before
reading. Full sync uses the transaction-authorized reader and rechecks exact local
membership after the await and immediately before ACK. Presence is recomputed at
handoff. Old ACKs cannot be redirected to successor transports.

One outstanding full read per physical socket, across all callers. Overlapping
requests return false without ACK/read; a stalled read retains this reservation.
After settlement a new explicit sync reads again: there is no authorization or
history cache. Denial/staleness returns false; DB/ACK errors propagate, with no
automatic retry. True means synchronous handoff, not delivery. Caller must catch
errors and define safe, request-local failure/busy responses and rate controls.

Probe returns only `{ok:true}` from current local membership, even during a full
read. It is NOT DB readiness, durable generation or policy validation. Full sync
is not an atomic history/delta snapshot: policy can change after read COMMIT and
messages can arrive between snapshot and network handoff. Coherent public-handler
migration, gap reconciliation, aggregate limits/deadlines and E2E remain open.
