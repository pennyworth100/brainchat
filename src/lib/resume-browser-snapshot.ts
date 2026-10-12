import type { Socket } from "socket.io";
import type { SnapshotRequest } from "./browser-resume-snapshot";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeHistoryReader } from "./resume-history";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumeSocketOwner } from "./resume-socket";
import { syncResumeSocket } from "./resume-sync";

// PRIVATE envelope over the existing exact-owner authorized full-window read.
// Caller binds this request/ACK to its authenticated physical socket. No probe,
// afterId, public registration or claim that IDs order commits. true = handoff.
export async function publishBrowserSnapshot(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships, reader: Pick<ResumeHistoryReader, "read">,
  request: SnapshotRequest, handoff: (value: unknown) => void): Promise<boolean> {
  if (!request || request.roomId !== binding.roomId || request.sessionId !== binding.sessionId ||
      request.generation !== binding.generation || typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId)) return false;
  const identity = Object.freeze({ roomId: binding.roomId, sessionId: binding.sessionId,
    generation: binding.generation, requestId: request.requestId });
  return syncResumeSocket(socket, owner, binding, members, reader, { roomId: binding.roomId }, reply => {
    if (!("history" in reply)) throw Error("Snapshot requires full history");
    handoff({ ...identity, window: "newest-100-id-ascending", history: reply.history, users: reply.users });
  });
}
