import type { Socket } from "socket.io";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeMessageWriter, ResumeTextMessage } from "./resume-message";
import type { ResumeMemberships } from "./resume-membership";
import { ownsResumeSocket, type ResumeSocketOwner } from "./resume-socket";
import { isValidRoomId } from "./room-id";
import { ResumeCapacity } from "./resume-capacity";

// One unresolved write per physical socket, shared by all callers. Capacity is
// process-local, not a distributed rate limit or proof of DB cancellation.
const writing = new WeakSet<Socket>();
const capacity = new ResumeCapacity(100);

export type ResumeSendReply = Readonly<{ clientMessageId: string; message: Readonly<ResumeTextMessage> }>;
export type ResumeSendResult = { committed: false } | {
  committed: null; reason: "deadline"; clientMessageId: string;
} | {
  committed: true; inserted: boolean; receipt: ResumeSendReply;
  ack: "skipped" | "handed-off" | "failed";
  fanout: "skipped" | "attempted" | "failed";
  errors: { stage: "ack" | "fanout"; error: unknown }[];
};

// PRIVATE composition only; server owns every authority argument and the
// request-local synchronous ACK callback. Public registration remains OFF.
// Pre-COMMIT failures propagate (COMMIT may be uncertain); never auto-retry.
// Post-COMMIT handoff failures are data, NOT permission to repeat publication.
// This is not an outbox: crash/stale owner after COMMIT can lose fanout.
export async function sendResumeText(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships,
  writer: Pick<ResumeMessageWriter, "saveOnceWithOutcome">,
  payload: { roomId?: unknown; clientMessageId?: unknown; message?: unknown } | null,
  ack: (reply: ResumeSendReply) => void,
  limits: { capacity?: ResumeCapacity; timeoutMs?: number; onLateError?: (error: unknown) => void } = {}): Promise<ResumeSendResult> {
  const roomId = payload?.roomId, clientMessageId = payload?.clientMessageId, content = payload?.message;
  if (typeof ack !== "function" || typeof roomId !== "string" || !isValidRoomId(roomId) ||
      typeof clientMessageId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientMessageId) ||
      typeof content !== "string" || !content.trim() || content.length > 10_000) return { committed: false };
  const current = () => socket.connected && ownsResumeSocket(socket, owner) &&
    binding.transportId === owner.incarnation && members.isCurrent(binding, roomId);
  if (!current()) return { committed: false };
  const timeoutMs = limits.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw Error("Invalid send deadline");
  }
  if (writing.has(socket)) return { committed: false };
  const release = (limits.capacity ?? capacity).acquire();
  if (!release) return { committed: false };
  writing.add(socket);
  const deadline = performance.now() + timeoutMs;
  const uncertain = Object.freeze({ committed: null, reason: "deadline", clientMessageId } as const);
  let expired = false;
  const overdue = () => expired || performance.now() >= deadline;
  let timer!: ReturnType<typeof setTimeout>;
  const stopped = new Promise<ResumeSendResult>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(uncertain); }, timeoutMs);
  });
  const report = limits.onLateError ?? ((error: unknown) => { console.error("Resume send late error", error); });
  const work = (async (): Promise<ResumeSendResult> => {
    // Immutable scalar snapshot. Client username/session/generation never confer authority.
    const write = await writer.saveOnceWithOutcome(binding, clientMessageId, content);
    // A timeout is NOT rollback/denial. The write may still commit; no late
    // ACK/fanout or automatic retry, even if timer delivery was blocked.
    if (overdue()) return uncertain;
    if (!write.authorized) return { committed: false };
    const receipt = Object.freeze({ clientMessageId, message: Object.freeze({ ...write.value.message }) });
    const result: Extract<ResumeSendResult, { committed: true }> = {
      committed: true, inserted: write.value.inserted, receipt, ack: "skipped", fanout: "skipped", errors: [],
    };
    if (!current()) return result;
    try { ack(receipt); result.ack = "handed-off"; }
    catch (error) { result.ack = "failed"; result.errors.push({ stage: "ack", error }); }
    // ACK can synchronously replace/close the sender. Every recipient is also
    // individually rechecked by broadcastExcept. Existing receipt NEVER fans out.
    if (write.value.inserted && !overdue() && current()) {
      try {
        members.broadcastExcept(binding, roomId, "chat-message", receipt.message);
        result.fanout = "attempted";
      } catch (error) {
        // Some recipients may already have received a packet; do not replay.
        result.fanout = "failed"; result.errors.push({ stage: "fanout", error });
      }
    }
    return result;
  })().catch(error => {
    if (!overdue()) throw error; // even an early COMMIT rejection can be uncertain
    try { report(error); }
    catch (reportError) { console.error("Resume send late error reporter failed", reportError); }
    return uncertain;
  }).finally(() => {
    clearTimeout(timer);
    // Owner loss fences publication, NOT the write. Never release either lease
    // on disconnect/replacement; an unresolved COMMIT may still succeed.
    writing.delete(socket);
    release();
  });
  return Promise.race([work, stopped]);
}
