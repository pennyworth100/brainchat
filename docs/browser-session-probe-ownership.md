# Browser session probe ownership — 3.0.29

## Confirmed regression and fix

On 3.0.28, four real Socket.IO regressions failed: an in-flight full sync or
health check could resolve successfully after an explicit join, for either
the same room or another room. During disconnect-time ACK cancellation it
could even return the old transport ID. A transport-generation check alone
does not identify the caller's logical room-session owner.

Each explicit join now invalidates the prior owner before disconnecting.
Outstanding probes reject with Room changed; closing the controller rejects
with Room closed, and terminal join failures also settle pending probes.
Late callbacks cannot publish snapshots/capabilities or restart the replacement
transport. Promise cleanup uses identity comparison so old cleanup cannot clear
a new owner's cached probe. Disposal immediately revokes readiness and text
retry authority even if the caller has not yet disconnected the socket.

A transport-only reconnect still belongs to the same controller owner and
continues the existing password-rejoin recovery. This change does NOT convert
that recovery into durable server-session resume or authorize cross-reconnect
operation replay.

## Verification

- Four real Socket.IO regressions: sync/health x same/different room rejoin.
- Adversarial delayed ACKs: stale snapshot and stale error, replacement-probe
  cache identity, no late capability grant or restart.
- Silent probes settle on disposal and terminal failure without an ACK.
- Transport-only reconnect retains the controller owner.
- Disposal revokes ready/text/upload authority without relying on disconnect.
- Existing room recovery, history reconciliation and password failure tests.
- Full application/plugin tests, typecheck, production build, production
  dependency audit and isolated HTTP/Socket.IO/PostgreSQL session fixture.

## Deliberate limits

Public browser credentials remain disabled and upload authority remains legacy.
This is one prerequisite of the coordinated browser migration, not its
completion. It does not provide a send-time lease for work that already
completed before an explicit join, pending upload ownership, cross-reconnect
receipt reconciliation, persistent storage or browser/device acceptance.

The remaining activation gates are the full credential/generation contract
across reconnect/sync/text/image/file, in-memory pending operation ownership,
receipt reconciliation, physical byte AND inode capacity authority, admission/
expiry capacity, exact-image audit and fresh paired recovery at the proven old
writer fence. No live service, listener, migration or deployment is changed.

