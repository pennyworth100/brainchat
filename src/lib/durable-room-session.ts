import type { Socket } from "socket.io-client";
import { createRoomSession, type ChatMessage, type RoomCredentials, type RoomSession } from "./room-session";
import { browserLeaseJournal } from "./browser-lease-journal";
import { createBrowserDurableResume } from "./browser-durable-resume";
import { publicOwnerScope, publicOutbox, publicDraft, publicDraftSnapshot } from "./public-outbox";
import type { BrowserLease } from "./browser-resume-controller";

type Callbacks = Parameters<typeof import("./room-session").createRoomSession>[1];
/** Public adapter: no password fallback, buffered sends, automatic CAS or replay.
 * The server must provision the publication protocol before this UI is released. */
export function createDurableRoomSession(socket: Socket, callbacks: Callbacks,
  tab: Storage = sessionStorage, drafts: Storage = localStorage) {
  let credentials: RoomCredentials | null = null, disposed = false, busy = false;
  let physical: object | null = null, scope: string | null = null, original: BrowserLease | null = null;
  let controller: Awaited<ReturnType<typeof createBrowserDurableResume>> | null = null;
  let syncTicket: Awaited<ReturnType<Awaited<ReturnType<typeof createBrowserDurableResume>>["accept"]>> | null = null;
  let users: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const guard = () => {
    if (disposed || !physical || !controller || !socket.connected || !socket.id || !original)
      throw Error("Original session is unavailable. Your saved work is retained.");
    const authority = controller.authority(physical, socket.id);
    if (authority.kind !== "resume" || authority.sessionId !== original.sessionId ||
        authority.roomId !== original.roomId) throw Error("Original session changed");
    return authority;
  };
  const rpc = (event: string, value: unknown, owner: object) => {
    const task = queue.then(() => {
      if (disposed || physical !== owner || !socket.connected) throw Error("Connection changed");
      return socket.volatile.timeout(5000).emitWithAck(event, value);
    });
    queue = task.catch(() => {});
    return task;
  };
  const fail = () => {
    if (physical) controller?.disconnect(physical);
    physical = null;
    if (!disposed && credentials) callbacks.onState("error");
  };
  socket.on("disconnect", fail);
  const publication = (value: unknown, ack: (value: unknown) => void) => {
    try {
      if (!physical || !controller || !syncTicket || typeof ack !== "function") throw Error("Stale publication");
      const result = controller.receivePublication(physical, syncTicket, value);
      callbacks.onSnapshot({ history: [...result.history] as ChatMessage[], users });
      ack(result.ack);
    } catch { fail(); socket.disconnect(); }
  };
  socket.on("publication-batch", publication);
  const connect = async () => {
    if (disposed || busy || !credentials) throw Error("Session is unavailable or busy");
    busy = true;
    let joinNotIssued = false;
    try {
      fail(); socket.disconnect(); callbacks.onState("reconnecting");
      const owner = {}, c = { ...credentials };
      physical = owner;
      const localScope = publicOwnerScope(tab, c.roomId, c.username);
      // Credentialless pre-upgrade work is never imported into a new owner.
      if (await publicOutbox(localScope, "read"))
        throw Error("An older unconfirmed delivery is retained. It cannot be reassigned to a new session.");
      const next = await createBrowserDurableResume("public:" + localScope, async (scope, mutation) => {
        const row = await browserLeaseJournal(scope, mutation);
        if (row && (row.roomId !== c.roomId || row.username !== c.username)) throw Error("Saved owner mismatch");
        return row;
      });
      if (disposed || physical !== owner) throw Error("Connection changed");
      controller = next;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); socket.off("connect", ok); socket.off("connect_error", bad); };
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(Error("Connection failed")); };
        const timer = setTimeout(bad, 5000);
        socket.once("connect", ok); socket.once("connect_error", bad); socket.connect();
      });
      if (disposed || physical !== owner) throw Error("Connection changed");
      callbacks.onState("syncing");
      const phase = next.status().phase;
      let ticket: Parameters<typeof next.accept>[0], response: any;
      if (phase === "empty") {
        ticket = await next.beginJoin(c.roomId, c.username, owner);
        response = await rpc("join-room", { ...c, operationId: ticket.operationId }, owner);
        if (response?.outcome === "join-not-issued") {
          await next.joinNotIssued(ticket, owner, response);
          joinNotIssued = true;
          throw Error(typeof response.error === "string" ? response.error : "Join rejected");
        }
      } else {
        const attempt = phase === "offline" ? await next.beginResume(owner) : await next.beginTransfer(owner);
        ticket = attempt.ticket;
        const { roomId, sessionId, token } = attempt.lease;
        response = await rpc("private-session", { kind: ticket.kind,
          request: { ...ticket, credential: { roomId, sessionId, token } } }, owner);
      }
      if (response?.protocol !== "durable-session-v1" || !response.lease)
        throw Error("Original session was not confirmed. Saved work is retained.");
      const sync = await next.accept(ticket, owner, response.lease);
      original = Object.freeze({ ...response.lease });
      if (original!.roomId !== c.roomId || original!.username !== c.username) throw Error("Saved owner mismatch");
      scope = JSON.stringify(["public-session-v1", localScope, original!.sessionId]);
      // Copy only the initial legacy draft, never pending operations; never erase it.
      if (phase === "empty" && drafts.getItem("dimle:draft:v2:" + scope) === null)
        publicDraft(drafts, scope, publicDraftSnapshot(drafts, localScope).value);
      syncTicket = sync;
      const request = next.publicationSnapshot(owner, sync);
      const completion = request.accept(await rpc("private-snapshot", request.request, owner));
      next.stagePublication(owner, sync, completion);
      const confirmed = next.confirmPublication(owner, sync,
        await rpc("private-snapshot-ack", next.publicationAck(owner, sync), owner));
      next.startPublication(owner, sync, async signal => {
        if (signal.aborted) return false;
        const reply = await rpc("private-publication-poll", request.request, owner);
        return !signal.aborted && reply?.settled === true && reply.roomId === c.roomId &&
          reply.sessionId === sync.sessionId && reply.generation === sync.generation && reply.requestId === sync.requestId;
      });
      for (let attempt = 0; next.status().phase === "syncing" && attempt < 500; attempt++) {
        if (disposed || physical !== owner) throw Error("Connection changed");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      guard();
      users = [...confirmed.users];
      delete credentials!.password; delete credentials!.creationToken;
      callbacks.onSnapshot({ history: [...confirmed.history] as ChatMessage[], users: [...confirmed.users] });
      callbacks.onJoined(); callbacks.onState("ready");
      return socket.id!;
    } catch (error) {
      fail(); socket.disconnect();
      if (!disposed) callbacks.onError(error instanceof Error ? error.message : "Session unavailable", joinNotIssued);
      throw error;
    } finally { busy = false; }
  };
  const health = async () => { guard(); return socket.id!; };
  const timer = setInterval(() => {
    if (disposed || busy || !physical || !original) return;
    try { guard(); } catch { fail(); socket.disconnect(); }
  }, 1000);
  const session: RoomSession & { outboxScope(): string; resolveText(): Promise<boolean> } = {
    join(next: RoomCredentials) {
      if (disposed || busy) return;
      credentials = { ...next };
      void connect().catch(() => {});
    },
    operationGuard(roomId: string) {
      const owner = physical;
      const check = () => {
        if (physical !== owner || guard().roomId !== roomId) throw Error("Original connection changed");
      };
      check(); return check;
    },
    sync: health, checkHealth: health, reconnect: connect,
    uploadAuthority(roomId: string, socketId: string) {
      try { const a = guard(); return a.roomId === roomId && a.socketId === socketId ? a : null; }
      catch { return null; }
    },
    isReady() { try { guard(); return true; } catch { return false; } },
    canRetryText() { return session.isReady(); },
    outboxScope() { guard(); if (!scope) throw Error("Missing original outbox"); return scope; },
    async resolveText() {
      const check = session.operationGuard(credentials!.roomId), currentScope = session.outboxScope();
      const pending = await publicOutbox(currentScope, "read"); check();
      if (!pending || pending.kind !== "text" || typeof pending.payload !== "string") return false;
      const reply = await rpc("private-text-receipt", { roomId: original!.roomId,
        sessionId: original!.sessionId, clientMessageId: pending.clientMessageId,
        type: "message", message: pending.payload }, physical!);
      check();
      const m = reply?.message;
      if (reply?.outcome !== "confirmed" || reply.roomId !== original!.roomId ||
          reply.sessionId !== original!.sessionId || reply.clientMessageId !== pending.clientMessageId ||
          m?.type !== "message" || m.username !== original!.username || m.message !== pending.payload ||
          !Number.isSafeInteger(m.id) || m.id < 1 || !Number.isFinite(m.ts)) return false;
      await publicOutbox(currentScope, "confirm", { ...pending, outcome: "confirmed", confirmedMessageId: m.id }, pending.clientMessageId);
      check(); return true;
    },
    dispose() {
      disposed = true; clearInterval(timer); fail(); socket.disconnect();
      socket.off("disconnect", fail); socket.off("publication-batch", publication);
    },
  };
  return session;
}

/** Server-selected rollout, before any password join. A saved durable owner can
 * never be downgraded into an uncredentialed legacy session. */
export function createNegotiatedRoomSession(socket: Socket, callbacks: Callbacks) {
  let active: (RoomSession & { outboxScope?(): string; resolveText?(): Promise<boolean> }) | null = null;
  let credentials: RoomCredentials | null = null, disposed = false, starting = false;
  const current = () => { if (disposed || !active) throw Error("Room is not connected"); return active; };
  return {
    join(next: RoomCredentials) {
      if (disposed || starting) return;
      starting = true; credentials = { ...next }; callbacks.onState("reconnecting");
      void (async () => {
        const response = await fetch("/api/browser-session-mode", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw Error("Could not verify session protocol");
        const mode = (await response.json()).mode;
        if (disposed) return;
        active?.dispose();
        if (mode === "durable-session-v1") {
          socket.io.reconnection(false);
          socket.auth = { dimleProtocol: mode };
          active = createDurableRoomSession(socket, callbacks);
        } else if (mode === "legacy") {
          const scope = publicOwnerScope(sessionStorage, next.roomId, next.username);
          if (await browserLeaseJournal("public:" + scope)) throw Error("Original recovery session is temporarily unavailable. Saved work is retained.");
          if (disposed) return;
          socket.io.reconnection(true);
          socket.auth = {};
          active = createRoomSession(socket, callbacks);
        } else throw Error("Unsupported session protocol");
        if (!disposed) active.join(next);
      })().catch(e => { if (!disposed) { callbacks.onState("error"); callbacks.onError(e.message, false); } })
        .finally(() => { starting = false; });
    },
    operationGuard(roomId: string) { const owner = current(), check = owner.operationGuard(roomId);
      return () => { if (current() !== owner) throw Error("Room changed"); check(); }; },
    sync: async () => current().sync(), checkHealth: async () => current().checkHealth(),
    reconnect: async () => current().reconnect(),
    uploadAuthority: (roomId: string, socketId: string) => current().uploadAuthority(roomId, socketId),
    isReady: () => !disposed && !!active?.isReady(),
    canRetryText: () => !disposed && !!active?.canRetryText(),
    outboxScope() { return current().outboxScope?.() ??
      publicOwnerScope(sessionStorage, credentials!.roomId, credentials!.username); },
    usesDurableProtocol: () => !!active?.outboxScope,
    resolveText: async () => current().resolveText?.() ?? false,
    dispose() { disposed = true; active?.dispose(); socket.disconnect(); },
  } satisfies RoomSession & { outboxScope(): string; resolveText(): Promise<boolean>; usesDurableProtocol(): boolean };
}
