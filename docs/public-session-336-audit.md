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
1. Wrong-password retry is now fixed and proven (below). Other explicit pre-issuance refusals (rate limit, unclaimed/missing room, validation) still need the same reviewed non-issuance treatment; generic failures and missing ACK must remain uncertain.
2. Durable join/resume presence notifications need review: server's durable publishJoin deliberately omits the legacy presence broadcast and publishedBinding handling. Verify multi-user online counts/leave and DM after resume before activation.
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
