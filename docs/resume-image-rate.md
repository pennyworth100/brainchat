# Private image admission budget (3.0.11 draft)

`consumeResumeImageAttempt` is invoked by the guarded image composition registered
for normal authenticated joins in server.ts. It runs before validation/DB dispatch.

- One process-wide budget indexed by the exact server-owned durable session ID.
  Reconnect/generation/wrapper changes must keep this identity; client identity,
  room, username and clientMessageId must never select/reset the rate bucket.
- 12 attempts and 48 MiB of admitted UTF-8 data-URL bytes (including header) per
  fixed 60-second monotonic window. This is not decoded image size or safe image
  content validation. Strict canonical validation remains the writer's job.
- At most 12 MiB UTF-16 input length before byte scanning; no decoding, regex
  scan, DB query, path, fetch or filesystem write occurs in admission.
- A byte-denied request consumes an attempt, but not bytes. Admitted bytes and
  attempts are never refunded for malformed encoding, retries, policy denial,
  COMMIT failure/uncertainty, disconnect or owner replacement.
- At most 10,000 live session windows. Full state rejects a new session without
  evicting live debt. Fixed insertion-ordered expiry needs no session timers.
  Backwards clocks cannot forgive debt; nonfinite clocks fail closed.
- Process restarts clear budgets; multiple processes have independent budgets.
  This is not distributed/account/IP abuse protection or an upload memory cap.

Image sending now shares the EXISTING text send physical-socket lease
and process capacity, current-owner checks, monotonic deadline and fenced
`chat-image` fanout. Admission must precede canonical decoding/DB dispatch;
overlapping writes must not escape through separate text/image lease sets.
Retain both leases after timeout/disconnect until the actual write settles.
No public resume/rollout before coherent upload lifecycle, DM/UI migration and full
acceptance, including physical QA in an authorized window.
