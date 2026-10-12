# Private-message authority — 3.0.11 draft

The real server handler now uses the shared membership registry, not Socket.IO
rooms or onlineUsers. Sender comes from the exact physical owner. Recipient name
must identify exactly one live logical session; ambiguity never fans out or evicts.

Both exact bindings are validated together under room policy and ordered session
locks. A fresh post-lock statement checks generation, transport, revocation,
expiry and room auth version for each endpoint. Reciprocal sends take session
locks in the same order. No lock is retained while awaiting receiver ACK.

Immediately before emission the registry checks both local leases and name
uniqueness again. It never redirects an old candidate to a successor. After ACK,
both durable identities are checked again, followed by both local leases before
the sent event and success response. One pending DM per physical sender bounds
concurrent authorization and ACK work; no automatic retry, broadcast or history.

Failure after possible emission remains DM_UNCONFIRMED, including invalid/late
ACK, replacement, disconnect or revoked policy during ACK. Durable validation
is a committed policy snapshot, not a distributed lock spanning network delivery:
a revocation after the pre-send transaction can race an already authorized send.
The second check prevents that ACK from becoming a confirmed send once revoked.

Public resume remains OFF. HTTP upload authority, browser reconciliation,
resource/expiry maintenance and final release acceptance remain gates.
