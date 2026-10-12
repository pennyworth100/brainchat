import type { Socket } from "socket.io-client";
import type { ChatMessage, RoomSession } from "./room-session";

type Session = Pick<RoomSession, "sync" | "isReady" | "canRetryText" | "operationGuard">;
interface PendingText {
  clientMessageId: string;
  roomId: string;
  message: string;
  checkOwner: () => void;
  transport?: string;
  session?: Session;
}

const UNKNOWN = "Delivery is not confirmed. Check room history; this draft cannot be retried after reconnecting.";

/**
 * In-memory operation ownership, not a durable outbox. A normal rejoin creates
 * a different server session: a stable key alone does NOT make that replay safe.
 * Keep unresolved keys even when the editor changes; never evict them silently.
 */
export function createTextSender(
  newKey: () => string = () => crypto.randomUUID(),
  timeoutMs = 10_000,
  maxPending = 32,
) {
  const pending = new Map<string, PendingText>();
  let busy = false;
  return {
    async send(socket: Socket, session: Session, roomId: string, message: string, beforeDispatch: () => void = () => {}): Promise<ChatMessage> {
      if (busy) throw new Error("A message is already being sent.");
      const identity = JSON.stringify([roomId, message]);
      let operation = pending.get(identity);
      if (!operation) {
        if (pending.size >= maxPending) {
          throw new Error("Too many unconfirmed messages. Check room history before sending more.");
        }
        operation = { clientMessageId: newKey(), roomId, message, checkOwner: session.operationGuard(roomId) };
        pending.set(identity, operation);
      }
      busy = true;
      try {
        // Retried uncertain work keeps its ORIGINAL owner, not the current join.
        operation.checkOwner();
        const transport = await session.sync();
        operation.checkOwner();
        if (!socket.connected || socket.id !== transport || !session.isReady()) {
          throw new Error("Room is reconnecting. Your draft is kept.");
        }
        if (operation.transport && (operation.transport !== transport ||
            operation.session !== session || !session.canRetryText())) {
          throw new Error(UNKNOWN);
        }
        // Capture authority BEFORE the first emit. Socket.IO must not buffer
        // this packet and silently flush it into a newly joined session.
        operation.transport = transport;
        operation.session = session;
        const keyedReceipt = session.canRetryText();
        beforeDispatch(); // Conservative boundary: any subsequent failure may have dispatched.
        const result: unknown = await socket.volatile.timeout(timeoutMs).emitWithAck("send-message", {
          roomId: operation.roomId,
          message: operation.message,
          clientMessageId: operation.clientMessageId,
        });
        // A valid receipt is not authority to publish into a replacement room.
        operation.checkOwner();
        const receipt = result as { error?: unknown; clientMessageId?: unknown; message?: ChatMessage } | null;
        if (typeof receipt?.error === "string") throw new Error(receipt.error);
        const saved = receipt?.message;
        if (!saved || !Number.isSafeInteger(saved.id) || saved.id <= 0 ||
            saved.type !== "message" || saved.message !== operation.message ||
            typeof saved.username !== "string" || !Number.isFinite(saved.ts) ||
            (keyedReceipt && receipt?.clientMessageId !== operation.clientMessageId) ||
            (receipt?.clientMessageId !== undefined && receipt.clientMessageId !== operation.clientMessageId)) {
          throw new Error("Delivery receipt could not be verified. Your draft is kept.");
        }
        pending.delete(identity);
        return saved;
      } catch (error) {
        // No emit means no uncertain write. Once emitted, even an error ACK can
        // represent an uncertain COMMIT; retain both the payload and its key.
        if (!operation.transport) pending.delete(identity);
        operation.checkOwner();
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}
