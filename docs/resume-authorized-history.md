# Private transaction-authorized history (3.0.11 draft)

Compose `binding => reader.read(binding)` from `ResumeHistoryReader` with the
existing private join/resume publication callbacks. The reader runs on
`ResumeOperationGate`'s dedicated pool checkout: room SHARE lock, session UPDATE
lock, current DB policy/generation/transport/revocation/expiry check, same-room
newest 100 messages, post-read authorization check, COMMIT, then return rows.
No global DB, room touch, credentials, network effects, cache or retries.

The projection matches `server.ts` history: ascending message IDs, authoritative
row metadata, plain-text messages and parsed image/file payloads; malformed legacy
JSON falls back to text. Invalid timestamps throw. Denial returns `null` (not an
empty history); query or uncertain COMMIT errors throw without releasing results.

Tests cover late detach/expiry/denial, query and commit failure, bounded ordering,
projection, empty history and stale/copied binding rejection. Isolated PostgreSQL
checks cover 105-row truncation, foreign-room isolation, remote generation,
revocation, DB expiry and a real policy-change lock wait.

**Not public resume acceptance.** `server.ts` is deliberately unchanged. Callers
still need exact membership/owner validation at handoff. A DB policy change after
COMMIT is not synchronously fenced at network handoff by this reader. This is not
an atomic history/delta cursor or client acknowledgment protocol; snapshot gaps,
coherent public-handler migration, UI/sessionStorage and full E2E remain open.
