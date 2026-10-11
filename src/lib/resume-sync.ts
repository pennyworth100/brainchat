import type { Socket } from "socket.io";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeHistoryReader } from "./resume-history";
import type { ResumeMemberships } from "./resume-membership";
import { ownsResumeSocket, onResumeSocketClose, type ResumeSocketOwner } from "./resume-socket";
import { ResumeCapacity } from "./resume-capacity";
import { isValidRoomId } from "./room-id";

type SyncReply = { ok: true } | { history: readonly unknown[]; users: string[] };
// Shared across callers: constructing another wrapper cannot bypass this cap.
const reading = new WeakSet<Socket>();
const capacity = new ResumeCapacity(100);
type SyncLimits = { capacity?: ResumeCapacity; timeoutMs?: number; onLateError?: (error: unknown) => void };

// Used by server.ts normal-session sync. All authority arguments are
// server-owned, never client payloads.
// ack must belong to this physical socket/request and synchronously hand off.
// false means no handoff (including busy/denied/stale/timeout). Early DB and ACK
// errors propagate; abandoned reads report late errors without retry. The public
// handler still needs its error/rate policy.
export async function syncResumeSocket(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships, reader: Pick<ResumeHistoryReader, "read">,
  payload: { roomId?: unknown; probeOnly?: unknown } | null,
  ack: (reply: SyncReply) => void, limits: SyncLimits = {}): Promise<boolean> {
  const roomId = payload?.roomId, probeOnly = payload?.probeOnly === true;
  if (typeof ack !== "function" || typeof roomId !== "string" || !isValidRoomId(roomId)) return false;
  const current = () => socket.connected && ownsResumeSocket(socket, owner) &&
    binding.transportId === owner.incarnation && members.isCurrent(binding, roomId);
  if (!current()) return false;
  if (probeOnly) {
    // Local membership liveness ONLY: no claim of current DB policy/readiness.
    ack({ ok: true }); return true;
  }
  const timeoutMs = limits.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw Error("Invalid sync deadline");
  }
  if (reading.has(socket)) return false;
  const release = (limits.capacity ?? capacity).acquire();
  if (!release) return false;
  reading.add(socket);
  const deadline = performance.now() + timeoutMs;
  const report = limits.onLateError ?? ((error: unknown) => { console.error("Resume sync late error", error); });
  let abandoned = false;
  let handingOff = false;
  let abandon!: () => void;
  const stopped = new Promise<false>(resolve => {
    abandon = () => { abandoned = true; if (!handingOff) resolve(false); };
  });
  const timer = setTimeout(abandon, timeoutMs);
  const unsubscribe = onResumeSocketClose(socket, owner, abandon);
  if (!unsubscribe) abandon();
  const live = () => !abandoned && performance.now() < deadline && current();
  const work = (async () => {
    if (!live()) return false;
    const history = await reader.read(binding);
    if (history === null || !live()) return false;
    // Presence is recomputed after the await, never cached with history.
    const users = members.presence(roomId).users.map(user => user.username);
    if (!live()) return false;
    // A synchronous ACK may reentrantly close its owner. Preserve the actual
    // handoff outcome/error; closing cannot turn an already attempted ACK into
    // a no-handoff result or hide the ACK exception as a late DB failure.
    handingOff = true;
    ack({ history, users });
    return true; // handoff, NOT delivery or an atomic history/delta snapshot
  })().catch(error => {
    if (handingOff || (!abandoned && performance.now() < deadline)) throw error;
    // Observe late rejection exactly once, even if the timer was delayed.
    try { report(error); }
    catch (reportError) { console.error("Resume sync late error reporter failed", reportError); }
    return false;
  }).finally(() => {
    clearTimeout(timer); unsubscribe?.();
    // Timeout/disconnect fences ACK, NOT the actual DB work. Keep both leases
    // until settlement; reconnecting or constructing a wrapper cannot free them.
    reading.delete(socket);
    release();
  });
  return Promise.race([work, stopped]);
}
