# Private image persistence (3.0.10 draft)

`ResumeImageWriter` is not wired to public handlers. It stores bounded inline
PNG/JPEG/GIF/WebP data URLs in the existing message schema, with database-owned
ID/timestamp and the exact admitted binding's room/name. MIME is normalized;
base64 must roundtrip exactly (padding, whitespace and invalid bytes fail closed).
The entire URL is at most 12 MiB, matching the legacy upper bound. This validates
encoding, not image bytes, dimensions, decompression cost or decoder safety.

The existing operation gate authorizes before receipt lookup and immediately
before COMMIT. Message plus receipt share one transaction. Text and image use
the SAME durable session/clientMessageId namespace, with type-domain-separated
hashes: cross-type retries conflict, not overwrite or create another message.
Matching retries return inserted:false; deleted messages remain tombstoned.
Persisted image receipts also check room, sender, type, content, ID and timestamp.

An uncertain COMMIT is propagated once, never automatically retried. An authorized
successor can resolve the same key; do not change clientMessageId after failure.
Receipt success is not network delivery or authority to broadcast. No outbox or
exactly-once fanout claim. No upload paths, URL fetch, filesystem side effects or
file cleanup happen in this transaction.

Still required before activation: image attempt/byte budgets and transport caps,
deadline/in-flight capacity, current-owner outbound adapter and UI acknowledgment,
coherent file-upload lifecycle and DM migration, snapshot/delta reconciliation,
full acceptance/physical QA. This does not change the legacy public image handler.
