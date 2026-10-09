# Private protected text adapter (3.0.10 draft)

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

This remains PRIVATE and unregistered. Send capacity/deadline/rate controls,
image/upload/integration broadcasts, DM guards, UI reconciliation and the full
acceptance matrix must precede coherent public-handler migration. No deployment.
