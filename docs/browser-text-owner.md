# Browser text owner (3.0.31)

The text sender captures the logical room owner before its first await and stores
that guard with every uncertain operation. Checks run before sync, after sync,
after ACK and on error. Explicit same-room rejoin (including a changed username),
different-room join, terminal failure and disposal revoke that owner.
Transport-only recovery does not revoke an original receipt, but existing
transport/controller/capability checks still forbid replaying uncertain writes.

The room UI independently captures ownership before sending. Stale success cannot
publish or clear a replacement draft; stale failure cannot append an error or
resync the replacement. The existing single-flight lock stays held until its own
attempt settles, so cleanup cannot release a newer send. This does not cancel or
undo a write already submitted to the server.

## Evidence and scope

Controlled transport ACKs exercise the production room controller and sender:
same/different-room replacement, terminal error, disposal, late success/error,
post-sync pre-emit controls and a transport-only receipt control. The unchanged
3.0.30 baseline had five failures and five passes in the first ten-test matrix:
four stale successes, plus an adversarial repeated-transport-ID uncertain retry.
The four pre-emit controls already passed on the baseline; they are not claimed
as newly discovered packet leaks. Four late-error tests were then added.
Hosted public-session QA retains real HTTP/Socket.IO/PostgreSQL receipt-loss and
exactly-once checks; its single-join session adapter now explicitly checks its
fixed authority. These tests are NOT rendered-browser/device acceptance.

No durable outbox, receipt reconciliation across a new logical session, public
resume credential activation, physical BYTE/INODE authority or release acceptance
is established by this patch. Pending storage remains bounded at 32 and never
silently evicts uncertain writes. Revoked uncertain operations remain held;
manual retries fail closed. Deployment gates on PR #20 remain open.
