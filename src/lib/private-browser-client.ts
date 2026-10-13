import { io } from "socket.io-client";
import { createBrowserDurableResume } from "./browser-durable-resume";
import type { BrowserLease } from "./browser-resume-controller";
import { publicOutbox, publicDraft, publicDraftSnapshot, reconcilePublicConfirmation, type PendingPublicOperation } from "./public-outbox";

const protocol = "durable-session-v1";
type History = readonly { id: number; type: string; username: string; message?: string }[];
/** PRIVATE text-only candidate. One physical socket per instance, no automatic
 * reconnect/replay/password fallback. Existing public owners are never imported. */
export async function connectPrivateBrowser(scope: string, roomId: string, username: string,
  password: string, history: (rows: History) => void, url?: string) {
  const controller = await createBrowserDurableResume(scope);
  const socket = io(url, { autoConnect: false, reconnection: false, transports: ["websocket"],
    auth: { dimleProtocol: protocol } });
  const physical = {};
  let lease: BrowserLease | null = null, closed = false;
  let sync: Awaited<ReturnType<typeof controller.accept>> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const close = () => { if (closed) return; closed = true; controller.disconnect(physical); socket.disconnect(); };
  const rpc = (event: string, value: unknown): Promise<any> => {
    const task = queue.then(() => {
      if (closed || !socket.connected) throw Error("Connection is not available");
      return socket.timeout(3500).emitWithAck(event, value);
    });
    queue = task.catch(() => {});
    return task;
  };
  socket.on("disconnect", () => { closed = true; controller.disconnect(physical); });
  socket.on("publication-batch", (value, ack) => {
    try {
      if (!sync || closed || typeof ack !== "function") throw Error("Stale publication");
      const result = controller.receivePublication(physical, sync, value);
      history(result.history); ack(result.ack);
    } catch { close(); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(Error("Connection timed out")); }, 5000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("connect_error", () => { clearTimeout(timer); close(); reject(Error("Connection failed")); });
      socket.connect();
    });
    const phase = controller.status().phase;
    let ticket: Parameters<typeof controller.accept>[0], response: any;
    if (phase === "empty") {
      ticket = await controller.beginJoin(roomId, username, physical);
      response = await rpc("join-room", { roomId, username, password });
    } else {
      const original = phase === "offline" ? await controller.beginResume(physical) :
        await controller.beginTransfer(physical);
      ticket = original.ticket;
      const { roomId: room, sessionId, token } = original.lease;
      response = await rpc("private-session", { kind: ticket.kind,
        request: { ...ticket, credential: { roomId: room, sessionId, token } } });
    }
    if (response?.protocol !== protocol || !response.lease) throw Error("Session not confirmed; retained without retry");
    sync = await controller.accept(ticket, physical, response.lease);
    lease = Object.freeze({ ...response.lease });
    const request = controller.publicationSnapshot(physical, sync);
    const completion = request.accept(await rpc("private-snapshot", request.request));
    controller.stagePublication(physical, sync, completion);
    const confirmed = controller.confirmPublication(physical, sync,
      await rpc("private-snapshot-ack", controller.publicationAck(physical, sync)));
    history(confirmed.history);
    const retained = sync;
    controller.startPublication(physical, retained, async signal => {
      if (signal.aborted) return false;
      const reply = await rpc("private-publication-poll", request.request);
      return !signal.aborted && reply?.settled === true && reply.roomId === roomId &&
        reply.sessionId === retained.sessionId && reply.generation === retained.generation &&
        reply.requestId === retained.requestId;
    });
  } catch (error) { close(); throw error; }
  const original = lease!;
  // Exact logical session owns both durable payload and draft across reload.
  const outboxScope = JSON.stringify(["private-text-v1", scope, original.sessionId]);
  const check = () => {
    if (closed || !socket.connected || !socket.id) throw Error("Original connection unavailable");
    const authority = controller.authority(physical, socket.id);
    if (authority.kind !== "resume" || authority.sessionId !== original.sessionId || authority.roomId !== roomId) throw Error("Original session changed");
  };
  let sending = false;
  const validate = (value: any, pending: PendingPublicOperation) => {
    const m = value?.message;
    if (value?.clientMessageId !== pending.clientMessageId || !m || m.type !== "message" ||
        m.username !== username || m.message !== pending.payload || !Number.isSafeInteger(m.id) || m.id < 1 ||
        typeof m.ts !== "number" || !Number.isFinite(m.ts)) throw Error("Delivery remains unknown");
    return m.id as number;
  };
  const confirm = async (pending: PendingPublicOperation, value: unknown) => {
    check();
    const id = validate(value, pending);
    await publicOutbox(outboxScope, "confirm", { ...pending, outcome: "confirmed", confirmedMessageId: id }, pending.clientMessageId);
    check();
    await reconcilePublicConfirmation(outboxScope, localStorage, check);
    return id;
  };
  return {
    close, status: controller.status,
    draft(value?: string) { return publicDraft(localStorage, outboxScope, value); },
    pending: () => publicOutbox(outboxScope, "read"),
    async resolve() {
      check();
      const pending = await reconcilePublicConfirmation(outboxScope, localStorage, check);
      if (!pending) return null;
      if (pending.kind !== "text" || typeof pending.payload !== "string") throw Error("Unsupported saved operation; retained");
      const reply = await rpc("private-text-receipt", { roomId, sessionId: original.sessionId,
        clientMessageId: pending.clientMessageId, type: "message", message: pending.payload });
      check();
      if (reply?.outcome !== "confirmed" || reply.roomId !== roomId || reply.sessionId !== original.sessionId) return null;
      return confirm(pending, reply);
    },
    async send() {
      check();
      if (sending) throw Error("A send is already pending");
      sending = true;
      try {
        const draft = publicDraftSnapshot(localStorage, outboxScope), payload = draft.value.trim();
        if (!payload || payload.length > 10000) throw Error("Invalid message");
        const pending: PendingPublicOperation = { clientMessageId: crypto.randomUUID(), kind: "text",
          payload, draft, outcome: "unknown" };
        await publicOutbox(outboxScope, "reserve", pending);
        // Any failure after reservation retains UNKNOWN. No automatic cleanup,
        // no key replacement, no resend even if disconnect happened before emit.
        check();
        return await confirm(pending, await rpc("send-message",
          { roomId, clientMessageId: pending.clientMessageId, message: payload }));
      } finally { sending = false; }
    },
  };
}
