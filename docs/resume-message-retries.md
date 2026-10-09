# Private text-message retry receipts (3.0.10 draft)

No public handler uses this API. This is database idempotency, not exactly-once
network publication. Plain save remains explicitly non-idempotent; retrying
callers must use saveOnce with the same key and exact payload.

- Namespace: immutable server session ID plus 1–128 ASCII alphanumeric, dash or
  underscore clientMessageId. Never username, socket ID, or generation.
- The authorization gate locks room SHARE then session UPDATE. Only after
  current database and exact local binding checks may receipt lookup occur.
  Message and receipt insertion commit together. SHA-256 binds the JSON tuple
  [roomId, username, message type, exact content], bounded to 10,000 UTF-16 units.
  A mismatched payload throws, without changing the original receipt or row.
- COMMIT failure never returns success or retries automatically. An authorized
  successor can use the same session/key/payload to resolve a committed receipt.
  Every lookup still requires current policy, generation, transport and TTL.
- Message deletion SET NULL preserves a tombstone; retries fail rather than
  resurrect content. Receipt FK has an index for deletion. Session deletion
  cascades receipts but leaves room history; room deletion still follows the
  existing message deletion ordering. Do not prune receipts independently while
  their session can authorize. Expiry/revocation denies access immediately;
  physical cleanup is a separate, not yet wired operation.
- No new content copy is retained in receipts, only hash and nullable row ID.
  No independent rolling receipt TTL: absolute session expiry bounds authority.
  Admission/rate limits and cleanup remain required before public exposure.
- Post-commit room touch, socket adapter, outbound fencing, UI sessionStorage,
  upload/DM recovery and full acceptance matrix remain unimplemented.

Migration 0006 is additive. Production still requires the existing audit and
explicit owner authorization; no live database is changed by these tests.
