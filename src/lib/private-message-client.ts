import type { Socket } from "socket.io-client";

// No automatic retries: a lost ACK is ambiguous, not proof of non-delivery.
export async function sendPrivateMessage(socket: Socket, payload: { roomId: string; toUsername: string; message: string }, timeoutMs = 7000): Promise<void> {
  if (!socket.connected) throw new Error("Room is reconnecting. Your message has not been sent.");
  let result;
  try {
    result = await socket.timeout(timeoutMs).emitWithAck("private-message", payload);
  } catch {
    throw new Error("Delivery not confirmed. The recipient may have received this message; check before retrying.");
  }
  if (result?.delivered !== true) {
    throw new Error(typeof result?.error === "string" ? result.error : "Delivery not confirmed. Check before retrying.");
  }
}
