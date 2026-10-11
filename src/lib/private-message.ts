import type { Socket } from "socket.io";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumeSocketOwner } from "./resume-socket";
import type { ResumeOperationGate } from "./resume-operation";

export type PrivateMessageResult = { delivered: true } | { error: string };
export const DM_UNCONFIRMED = "Delivery not confirmed. The recipient may have received this message; check before retrying.";

// Names are not identities. Never fan out or evict another session to repair
// an ambiguous name, and never equate writing to a socket with delivery.
export function registerPrivateMessages(
  socket: Socket,
  owner: ResumeSocketOwner,
  members: ResumeMemberships,
  gate: Pick<ResumeOperationGate, "authorizePair">,
  timeoutMs = 5000,
) {
  let inFlight = false;
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
    const sender = members.bindingFor(socket, owner, roomId);
    if (!sender) {
      reply({ error: "Rejoin the room before sending" });
      return;
    }
    const recipients = members.privateCandidates(roomId, toUsername);
    if (recipients.length !== 1) {
      reply({ error: recipients.length ? "More than one session has this name. Wait for reconnection or use unique names." : "User not found or offline" });
      return;
    }
    const recipient = recipients[0];
    const current = () => members.isCurrent(sender, roomId) && members.isCurrent(recipient, roomId);
    if (inFlight) { reply({ error: "Wait for the pending private message" }); return; }
    inFlight = true;
    const ts = Date.now();
    try {
      if (!await gate.authorizePair(sender, recipient) || !current()) {
        reply({ error: "Rejoin the room before sending" });
        return;
      }
      const received = await members.deliverPrivate(sender, recipient,
        { fromUsername: sender.username, message, ts }, timeoutMs) as { received?: unknown } | null;
      if (received?.received !== true) throw new Error("Invalid recipient acknowledgement");
      if (!await gate.authorizePair(sender, recipient) || !current()) throw Error("Private-message authority changed");
      socket.emit("private-message-sent", { toUsername, message, ts });
      reply({ delivered: true });
    } catch {
      reply({ error: DM_UNCONFIRMED });
    } finally {
      inFlight = false;
    }
  });
}
