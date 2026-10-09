# Private logical presence (3.0.10 draft)

The shared ResumeMemberships registry projects presence(roomId) from exact current
memberships, never raw Socket.IO room membership or transport IDs. The frozen
users/count snapshot contains sorted logical session IDs and authenticated
usernames. Equal usernames are not deduplicated: distinct sessions remain distinct.
Replacement preserves the logical ID. Pending successor preparation hides the
fenced predecessor; close, disconnect and absolute expiry remove visibility.

Snapshots are point-in-time data, not authorization. Recompute after asynchronous
work and send through the exact membership boundary. No periodic expiry notices
or atomic snapshot/delta protocol is provided here. This is process-local.

broadcastExcept(sender, roomId, event, payload) requires an exact current sender
membership. Copied, stale, expired, closed or wrong-room bindings send nothing.
Only that exact sender is excluded, not a client-selected ID. Both sender and
recipients are rechecked at each handoff; sender loss stops the remaining fanout.
Already handed-off packets cannot be recalled; failures must not trigger blind
replay. The inert-data/trusted-synchronous-hook constraints of resume-outbound.md
apply. Logical IDs are presentation identifiers, never credentials or DM authority.

Still private and unused by server.ts. Public ordinary join/history/presence must
migrate coherently with resume; existing public user IDs remain socket IDs.
Loopback regression persistence is stubbed, not public resume acceptance.
