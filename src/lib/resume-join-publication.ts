import type { ResumeBinding } from "./resume-bindings";
import type { ResumeMemberships } from "./resume-membership";

// PRIVATE: compose as attachResumeSocket's publishJoin option. The owner supplies
// single-flight, timeout, permanent failure fencing and issuance capacity. Never
// invoke this directly from a client or replay it after a partial handoff.
export function resumeJoinPublication(members: ResumeMemberships,
  readAuthorizedHistory: (binding: ResumeBinding) => Promise<readonly unknown[] | null>) {
  return async (binding: ResumeBinding, live: () => boolean): Promise<boolean> => {
    const roomId = binding.roomId;
    const current = () => live() && members.isCurrent(binding, roomId);
    if (!current()) return false;
    // Callback owns DB policy validation; null means unauthorized. No raw room
    // read or cached authorization belongs here. Never serialize credentials.
    const history = await readAuthorizedHistory(binding);
    if (!current() || history === null) return false;
    if (!members.send(binding, roomId, "chat-history", history) || !current()) return false;
    members.broadcastExcept(binding, roomId, "system-message", `${binding.username} joined`);
    if (!current()) return false;
    // Compatibility payloads: public user-list remains usernames, not tokens or
    // logical IDs. Recompute between event handoffs; these are not atomic snapshots.
    const users = members.presence(roomId).users.map(user => user.username);
    if (!members.send(binding, roomId, "user-list", users) || !current()) return false;
    members.broadcastExcept(binding, roomId, "user-list", users);
    if (!current()) return false;
    const count = members.presence(roomId).count;
    if (!members.send(binding, roomId, "user-count", count) || !current()) return false;
    members.broadcastExcept(binding, roomId, "user-count", count);
    return current();
  };
}
