import type { Socket } from "socket.io";
import type { ResumeSocketOwner } from "./resume-socket";
import type { ResumeMemberships } from "./resume-membership";
import type { ResumePublication } from "./resume-publication";
import type { ResumeTextReceiptReader } from "./resume-text-receipt";
import type { ServerLifecycle } from "./server-lifecycle";
import { publishBrowserResume, publishBrowserTransfer } from "./resume-browser-handshake";
import { createBrowserPublicationExchange, reconcileBrowserPublication } from "./resume-browser-snapshot";
import type { SnapshotRequest } from "./browser-resume-snapshot";
import { ResumeCapacity } from "./resume-capacity";

export const PRIVATE_BROWSER_PROTOCOL = "durable-session-v1";
export function privateBrowserNegotiated(socket: Socket, enabled: boolean) {
  return enabled && socket.handshake.auth?.dimleProtocol === PRIVATE_BROWSER_PROTOCOL;
}
const capacity = new ResumeCapacity(32);
const installed = new WeakSet<Socket>();

// Candidate-only real wire. No password join here: server.ts authenticates it
// through the existing room policy path. Every resumed operation uses the same
// physical owner as text/image/DM/upload; no new session or generation fallback.
export function registerPrivateBrowserWire(socket: Socket, enabled: boolean,
  owner: ResumeSocketOwner, members: ResumeMemberships, publication: ResumePublication,
  receipts: ResumeTextReceiptReader, lifecycle: ServerLifecycle) {
  if (!privateBrowserNegotiated(socket, enabled)) return false;
  if (installed.has(socket)) throw Error("Private protocol already registered");
  installed.add(socket);
  let busy = false;
  let exchange: ReturnType<typeof createBrowserPublicationExchange> = null;
  let confirmed: SnapshotRequest | null = null;
  const register = (event: string, work: (value: any, ack: (value: unknown) => void) => Promise<void>) => {
    socket.on(event, lifecycle.socket(async (value: unknown, ack: unknown) => {
      if (typeof ack !== "function" || !socket.connected) return;
      const reply = (result: unknown) => { if (socket.connected) ack(result); };
      if (busy) { reply({ outcome: "unknown" }); return; }
      const release = capacity.acquire();
      if (!release) { reply({ outcome: "unknown" }); return; }
      busy = true;
      try { await work(value, reply); }
      catch { reply({ outcome: "unknown" }); } // never leak credentials/driver errors
      finally { busy = false; release(); }
    }, (_value: unknown, ack: unknown) => {
      if (typeof ack === "function") ack({ outcome: "unknown" });
    }, () => {}));
  };
  register("private-session", async (value, ack) => {
    if (!value || (value.kind !== "resume" && value.kind !== "transfer")) {
      ack({ outcome: "unknown" }); return;
    }
    const method = value.kind === "resume" ? publishBrowserResume : publishBrowserTransfer;
    const sent = await method(socket, owner, members, value.request, lease => ack({
      protocol: PRIVATE_BROWSER_PROTOCOL, lease,
    }));
    if (!sent) ack({ outcome: "unknown" });
  });
  register("private-snapshot", async (request, ack) => {
    const binding = members.currentBindingFor(socket, owner);
    // One cut per physical incarnation. Retries only ACK the retained exact set.
    if (!binding || exchange) { ack({ outcome: "unknown" }); return; }
    exchange = createBrowserPublicationExchange(socket, owner, binding, members, publication, request);
    if (!exchange || !await exchange.publish(ack)) ack({ outcome: "unknown" });
  });
  register("private-snapshot-ack", async (reply, ack) => {
    if (!exchange || !await exchange.acknowledge(reply, value => {
      confirmed = exchange!.request;
      ack(value);
    })) ack({ outcome: "unknown" });
  });
  register("private-publication-poll", async (request, ack) => {
    const binding = members.currentBindingFor(socket, owner), c = confirmed;
    if (!binding || !c || !request || request.roomId !== c.roomId || request.sessionId !== c.sessionId ||
        request.generation !== c.generation || request.requestId !== c.requestId) {
      ack({ outcome: "unknown" }); return;
    }
    const settled = await reconcileBrowserPublication(socket, owner, binding, members, publication, c);
    ack({ ...c, settled });
  });
  register("private-text-receipt", async (request, ack) => {
    const binding = members.currentBindingFor(socket, owner);
    if (!binding) { ack({ outcome: "unknown" }); return; }
    const receipt = await receipts.read(binding, request);
    if (members.currentBindingFor(socket, owner) !== binding) return;
    ack(receipt ? { outcome: "confirmed", roomId: binding.roomId, sessionId: binding.sessionId,
      clientMessageId: request.clientMessageId, message: receipt } : { outcome: "unknown" });
  });
  return true;
}
