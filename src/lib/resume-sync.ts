import type { Socket } from "socket.io";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeHistoryReader } from "./resume-history";
import type { ResumeMemberships } from "./resume-membership";
import { ownsResumeSocket, type ResumeSocketOwner } from "./resume-socket";
import { isValidRoomId } from "./room-id";

type SyncReply = { ok: true } | { history: readonly unknown[]; users: string[] };
// Shared across callers: constructing another wrapper cannot bypass this cap.
const reading = new WeakSet<Socket>();

// PRIVATE. All authority arguments are server-owned, never client payloads.
// ack must belong to this physical socket/request and synchronously hand off.
// false means no handoff (including busy/denied/stale); errors propagate without
// ACK or automatic retry. The public handler still needs its error/rate policy.
export async function syncResumeSocket(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships, reader: Pick<ResumeHistoryReader, "read">,
  payload: { roomId?: unknown; probeOnly?: unknown } | null,
  ack: (reply: SyncReply) => void): Promise<boolean> {
  const roomId = payload?.roomId, probeOnly = payload?.probeOnly === true;
  if (typeof ack !== "function" || typeof roomId !== "string" || !isValidRoomId(roomId)) return false;
  const current = () => socket.connected && ownsResumeSocket(socket, owner) &&
    binding.transportId === owner.incarnation && members.isCurrent(binding, roomId);
  if (!current()) return false;
  if (probeOnly) {
    // Local membership liveness ONLY: no claim of current DB policy/readiness.
    ack({ ok: true }); return true;
  }
  if (reading.has(socket)) return false;
  reading.add(socket);
  try {
    const history = await reader.read(binding);
    if (history === null || !current()) return false;
    // Presence is recomputed after the await, never cached with history.
    const users = members.presence(roomId).users.map(user => user.username);
    if (!current()) return false;
    ack({ history, users });
    return true; // handoff, NOT delivery or an atomic history/delta snapshot
  } finally {
    // A stalled read retains its reservation until it really settles.
    reading.delete(socket);
  }
}
