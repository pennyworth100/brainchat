# 3.0.36 public original-session integration — candidate audit

Status: **DRAFT / not production-ready**. Max's production cutover authorization remains valid.
Base: PR #46 / fb026bbbf9415901b2e62ef19e0ceac93ca1e0cb.
This change integrates the existing durable protocol into /room; it does not provision production authorities.

## Implemented
- Server-selected no-store protocol capability. Default server remains legacy; isolated publication-authority composition selects durable sessions.
- Public UI persists the original lease before readiness, restores it on reload, requires confirmed publication and live polling, and never password-falls-back from a saved durable owner.
- Exact session-scoped outbox/draft. Credentialless legacy UNKNOWN is not imported, rebound, deleted or replayed.
- Read-only, exact-owner text receipt reconciliation. Newer drafts survive confirmed receipt cleanup.
- Same physical authority supplies text, DM and strict upload operations. Legacy message events cannot bypass the durable publication projection.
- Legacy reconnect and notification behavior retained.

## Local evidence (real built React, Socket.IO, owned PostgreSQL and Chrome)
Eight public scenarios PASS: authenticated join; actual post-COMMIT ACK loss; reload preserving exact session and newer draft with one send; read-only receipt reconciliation; UNKNOWN attachment reload with identical bytes/name/key; capability-downgrade refusal; actual IndexedDB abort before join; foreign owner denied original receipt.
Original session generation 1 -> 2 -> 3; one message send, one message row, one receipt. Attachment request actually returns 503; no successful durable attachment write is claimed.
Five existing legacy rendered-browser scenarios PASS, including real file/image upload and downloaded byte equality, offline/reconnect and draft retention.
1076 application + 5 plugin tests PASS; build/typecheck PASS; production dependency audit: 0 vulnerabilities.
Reports: workspace artifacts/dimle/public336-*-verified.json and public336-audit-2119.json.
Initial extended attachment harness failed because its request counter watched /upload instead of /api/upload. Failure retained in public336-public-browser-final.json. Corrected test additionally awaits actual HTTP503 and passes byte/ID/draft/no-replay checks.

## Material remaining gates — do not activate production
1. Explicit pre-issuance refusals are now covered (below). Generic failures and missing ACK remain uncertain; no reset of a saved owner is authorized.
2. Durable join/resume presence and bidirectional DM after resume are now locally verified (below); managed acceptance still required.
3. Verify this exact public integration on managed Railway. This report is LOCAL evidence, not managed, physical iPhone or Safari acceptance.
4. Strict physical upload/download provider remains unprovisioned. Disabled provider HTTP503 is not a successful attachment path or storage-capacity proof.
5. Production entry needs explicit runtime/migration/maintenance authorities and provider composition, stacked release integration, final CI/audit, and a fresh all-old-writers-fenced paired database/uploads backup plus rollback proof.
After those technical gates PASS, perform the already-authorized production cutover without another GO request.
No production deployment, restart, data mutation, or provider-support message was performed by this patch.

## 2026-10-12 follow-up: wrong-password recovery and CI fixture repair

- Exact physical socket ACK binds protocol, room, username and original join operation ID. Server emits it only in the wrong-password branch before session issuance.
- Only an exact, lease-less join intent can be cleared, under its original IndexedDB revision CAS and strict transaction completion. Issued, stale, mismatched or uncertain owners cannot be discarded. No pending payload is touched.
- Actual built public Chrome/PostgreSQL test: wrong password leaves zero sessions and returns the password form; corrected password produces exactly one session. Dropped rejection ACK retains byte-identical journal after reload, and a corrected password cannot silently replace that uncertain owner.
- Ten real public browser scenarios PASS, retaining the original one-send/one-row/one-receipt lost-message-ACK proof. Thirteen actual IndexedDB scenarios PASS, including deletion transaction abort and stale-revision protection. Fourteen controlled legacy outbox scenarios and five actual legacy rendered scenarios PASS.
- 1077 application + 5 plugin tests, build and typecheck PASS; production dependency audit reports zero vulnerabilities.
- Prior head cbe4b54 CI was NOT green: both verify jobs failed in the controlled legacy outbox fixture, which lacked the new capability endpoint. Fixture now explicitly advertises legacy and proves IndexedDB denial blocks even the authentication send (not only upload). Product downgrade protections were not relaxed.
- Retained initial local failures: ambiguous Wrong password locator; old outbox assertion expected a post-join warning despite the new pre-join storage gate. Corrected assertions pass. Evidence: workspace artifacts/dimle/public336-rejection-{browser-final,journal-verified,outbox-verified,legacy,tests,build,typecheck,audit}.json. New-head CI must be evaluated separately.

## 2026-10-12 follow-up: complete explicit refusals and concurrency fence

- Validation, missing room, unclaimed/claim-lost room, wrong password and authentication rate limits use exact non-issuance ACKs. Generic errors and uncertain issuance never do.
- A negotiated physical socket accepts only one initial join attempt, fenced synchronously before any authentication await. Concurrent/repeated joins return UNKNOWN, so an ongoing successful authentication cannot race a second request's false non-issuance claim. Public retries already reconnect with a fresh physical owner. Legacy clients retain their existing protocol.
- Actual Chrome/PostgreSQL acceptance adds unclaimed-room refusal followed by room readiness and exactly one issued session; real wire validation/missing-room/rate-limit refusals with exact operation binding and zero sessions; concurrent and post-issuance wrong-password requests returning UNKNOWN.
- Thirteen public scenarios preserve the original one-send/one-row/one-receipt, draft and attachment-UNKNOWN recovery proofs. Five legacy scenarios, 1077 application plus 5 plugin tests, build/typecheck and zero-vulnerability production audit are required for this head.
- Exact-head reports and hashes: workspace artifacts/dimle/public336-refusals-*.json. The older shared rejection-{tests,build,typecheck,legacy,audit}.json paths were refreshed during the initial follow-up run; their older manifest hashes are historical and must not be used as proof of this head. The retained browser-final/journal-verified/outbox-verified reports are unchanged.
- Previous head 45bd869 had all six CI checks PASS. Evaluate the new pushed head separately; no managed or production acceptance is claimed.

## 2026-10-12 follow-up: durable presence and resumed direct messages

- Exact current membership publishes presence only after the durable publication cut is acknowledged, for initial join, resume and transfer. The physical owner records its published binding for departure; displaced owners cannot announce a live successor as departed. Repeated snapshot ACKs do not duplicate join notices.
- The public adapter retains live user-list updates across message publication batches, preventing a later message from restoring the initial stale participant list. A fresh physical connection clears that projection; owner/lease and publication authorization remain unchanged.
- Sixteen real public Chrome/PostgreSQL scenarios PASS. New two-user proof covers join/count/participant-list, presence retained after a real message publication, reload retaining the same logical session with generation+1, bidirectional DM recipient ACKs exactly once after resume, and one leave notice plus remaining count after the resumed owner closes.
- Prior actual lost-message-ACK proof remains one send, one original row, one receipt, newer draft retained. Attachment UNKNOWN retains exact bytes/key without replay; actual HTTP503 is still a material blocker, not successful strict storage.
- 1077 application plus 5 plugin tests, build/typecheck, five legacy rendered scenarios and production audit (zero vulnerabilities) PASS. Reports: workspace artifacts/dimle/public336-presence-{tests,build,typecheck,browser-verified,legacy,audit}.json; publication manifest binds report hashes to the pushed head.
- Two initial browser harness failures are retained as presence-browser.json and presence-browser-final.json: participant text also matched a message author; exact DM payload text omitted the nested sender label. Scoped participant controls and payload substring assertions now pass; no product gate was relaxed.
- Previous head 936dccf has six CI checks PASS. New-head CI must be consumed independently. No managed deployment, production mutation, or successful physical attachment provider acceptance is claimed.
