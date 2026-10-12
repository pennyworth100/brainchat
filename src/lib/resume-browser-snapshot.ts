import type { Socket } from "socket.io";
import type { SnapshotRequest } from "./browser-resume-snapshot";
import type { ResumeBinding } from "./resume-bindings";
import type { ResumeHistoryReader } from "./resume-history";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumeSocketOwner } from "./resume-socket";
import { syncResumeSocket } from "./resume-sync";
import { validateBrowserSnapshotRow } from "./browser-resume-snapshot";
import type { ResumePublication } from "./resume-publication";

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

// PRIVATE full-cut transport boundary. Uses the SAME physical-owner, membership,
// expiry and in-flight capacity fences as history sync, but never the newest100
// reader. true means synchronous handoff ONLY, not client ACK or browser READY.
// Empty cuts can be handed off; durable cut settlement is NOT wired here yet.
// Caller must retain this physical request and reconcile the durable journal.
export async function publishBrowserPublicationSnapshot(socket: Socket, owner: ResumeSocketOwner,
  binding: ResumeBinding, members: ResumeMemberships, store: Pick<ResumePublication, "snapshot">,
  request: SnapshotRequest, handoff: (value: unknown) => void): Promise<boolean> {
  if (!request || request.roomId !== binding.roomId || request.sessionId !== binding.sessionId ||
      request.generation !== binding.generation || typeof request.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(request.requestId)) return false;
  const identity = Object.freeze({ roomId: binding.roomId, sessionId: binding.sessionId,
    generation: binding.generation, requestId: request.requestId });
  let deliveryTry: string | undefined;
  return syncResumeSocket(socket, owner, binding, members, { read: async current => {
    const cut = await store.snapshot(current);
    if (cut === null) return null;
    if (cut.cut !== "full-bounded-statement" || cut.roomId !== identity.roomId ||
        cut.sessionId !== identity.sessionId || cut.generation !== identity.generation ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(cut.deliveryTry) ||
        !Array.isArray(cut.messages) || cut.messages.length > 256) throw Error("Invalid publication cut");
    let previous = 0, bytes = 2;
    const history = cut.messages.map((message, index) => {
      if (!(message.ts instanceof Date) || !Number.isFinite(message.ts.getTime())) {
        throw Error("Invalid publication timestamp");
      }
      // Persisted identity wins over JSON content. The shared browser validator
      // strips unknown fields and refuses corrupt/unsupported persisted media.
      const content = message.type === "message" ? { message: message.content } : JSON.parse(message.content);
      if (!content || typeof content !== "object" || Array.isArray(content)) throw Error("Invalid publication content");
      const row = validateBrowserSnapshotRow({ ...content, id: message.id, type: message.type,
        username: message.username, ts: message.ts.getTime() });
      if (row.id <= previous) throw Error("Publication cut must be ascending unique IDs");
      previous = row.id; bytes += Buffer.byteLength(JSON.stringify(row)) + (index ? 1 : 0);
      if (bytes > 1024 * 1024) throw Error("Publication projection byte capacity");
      return row;
    });
    deliveryTry = cut.deliveryTry;
    return Object.freeze(history);
  } }, { roomId: identity.roomId }, reply => {
    if (!("history" in reply) || !deliveryTry) throw Error("Missing publication cut");
    handoff(Object.freeze({ ...identity, cut: "full-bounded-statement", deliveryTry,
      history: reply.history, users: Object.freeze([...reply.users]) }));
  });
}
