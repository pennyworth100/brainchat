# Private protected text adapter (3.0.11 draft)

`sendResumeText` composes the committed retry writer with exact physical owner,
binding and membership checks before dispatch and after the awaited write.
Room, message and clientMessageId are scalar snapshots; identity comes only from
the authenticated binding and database receipt. Invalid requests do not reach DB.

The request-local ACK receives an immutable receipt. An inserted message may then
fan out to other individually fenced members. Reentrant sender loss stops fanout.
Existing receipts only ACK the current request: they NEVER replay publication.

Pre-commit errors propagate without retry; a COMMIT error can be uncertain.
Post-commit ACK/fanout exceptions become explicit committed-result errors. Partial
fanout stops at the first error, without rolling back, throwing a retry signal or
replaying earlier recipients. Handoff is NOT network delivery. The caller must
observe these errors and reconcile history; this is not a transactional outbox.
Crash or sender loss after COMMIT can leave a stored row without live fanout.

Unresolved writes share one lease per physical socket and a process budget of
100. Busy requests return `committed: false` before DB dispatch; this says only
that THIS invocation did not write, never that a same-key outstanding write did
not commit. The server may inject a shared smaller capacity; client payloads
cannot control it. Disconnect/replacement does not release unresolved leases.
Leases remain held through synchronous publication and release on settlement,
including denial, uncertain COMMIT errors and post-commit handoff failures.
This is concurrency control, NOT a rate limit, cancellation or retry permission.

The server-owned monotonic deadline defaults to 10 seconds. Timeout returns
`{ committed: null, reason: "deadline", clientMessageId }`, NOT a negative ACK:
the caller must preserve the original ID/content and treat the write as pending
or uncertain. It must not automatically retry or mint a replacement ID. This
invocation never hands off late ACK/fanout; history reconciliation is required.
Both leases remain occupied until actual write settlement, even after timeout
and owner loss. Late rejection is observed once through the server-owned error
reporter (default console error), without turning it into an unhandled rejection.
Early errors still propagate and a COMMIT error must also be treated as uncertain.
A synchronous handoff started before deadline preserves its committed outcome;
the deadline is rechecked before subsequent fanout. This is NOT DB cancellation.

This remains PRIVATE and unregistered. Send rate controls,
image/upload/integration broadcasts, DM guards, UI reconciliation and the full
acceptance matrix must precede coherent public-handler migration. No deployment.
