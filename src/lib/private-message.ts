import type { Server, Socket } from "socket.io";

export type PrivateMessageResult = { delivered: true } | { error: string };
export const DM_UNCONFIRMED = "Delivery not confirmed. The recipient may have received this message; check before retrying.";

// Names are not identities. Never fan out or evict another session to repair
// an ambiguous name, and never equate writing to a socket with delivery.
export function registerPrivateMessages(
  io: Server,
  socket: Socket,
  onlineUsers: Map<string, Map<string, string>>,
  timeoutMs = 5000,
) {
  socket.on("private-message", async (payload: unknown, ack?: (result: PrivateMessageResult) => void) => {
    const data = payload as { roomId?: unknown; toUsername?: unknown; message?: unknown } | null;
    const { roomId, toUsername, message } = data || {};
    const reply = (result: PrivateMessageResult) => {
      if (typeof ack === "function") ack(result);
      else if ("error" in result) socket.emit("private-error", { toUsername, error: result.error });
    };
    if (typeof roomId !== "string" || typeof toUsername !== "string" || !toUsername ||
        toUsername.length > 64 || typeof message !== "string" || !message.trim() || message.length > 10_000) {
      reply({ error: "Invalid private message" });
      return;
    }
    const users = onlineUsers.get(roomId);
    const fromUsername = users?.get(socket.id);
    if (!fromUsername || !socket.rooms.has(roomId)) {
      reply({ error: "Rejoin the room before sending" });
      return;
    }
    const recipients = [...users!.entries()].filter(([, name]) => name === toUsername);
    if (recipients.length !== 1) {
      reply({ error: recipients.length ? "More than one session has this name. Wait for reconnection or use unique names." : "User not found or offline" });
      return;
    }
    const recipient = io.sockets.sockets.get(recipients[0][0]);
    if (!recipient?.connected || !recipient.rooms.has(roomId)) {
      reply({ error: "User not found or offline" });
      return;
    }
    const ts = Date.now();
    try {
      const received = await recipient.timeout(timeoutMs).emitWithAck("private-message", { fromUsername, message, ts });
      if (received?.received !== true) throw new Error("Invalid recipient acknowledgement");
      socket.emit("private-message-sent", { toUsername, message, ts });
      reply({ delivered: true });
    } catch {
      reply({ error: DM_UNCONFIRMED });
    }
  });
}
