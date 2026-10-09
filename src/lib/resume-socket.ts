import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { ResumeAdmission } from "./resume-admission";
import { ResumeCapacity } from "./resume-capacity";
import type { ResumeBindings, ResumeBinding } from "./resume-bindings";
import type { ResumeIdentity, ResumeStore } from "./resume-store";

type Options = {
  store: Pick<ResumeStore, "advanceGeneration">;
  bindings: ResumeBindings;
  // No room membership, history, presence or other outbound access here.
  prepare: (identity: ResumeIdentity) => Promise<() => Promise<void>>;
  onCleanupError: (error: unknown) => void;
  capacity?: ResumeCapacity;
  timeoutMs?: number;
};
export type ResumeSocketOwner = Readonly<{
  incarnation: string;
  admit: (request: Parameters<ResumeAdmission["admit"]>[0]) => Promise<ResumeBinding | null>;
  close: () => Promise<void>;
}>;

// Key by the actual server Socket object, NEVER socket.id, handshake or client ID.
// Keep closed owners until the socket is collected: reattachment cannot reopen it.
const owners = new WeakMap<Socket, { options: Options; owner: ResumeSocketOwner }>();
const capacity = new ResumeCapacity(100);

// Server-object identity check; never accept a copied owner or a different socket.
export function ownsResumeSocket(socket: Socket, owner: ResumeSocketOwner): boolean {
  return owners.get(socket)?.owner === owner;
}

// PRIVATE, not registered by server.ts. One module instance in one server process.
// Repeated installation requires the same options object; a competing installer
// fails before creating an admission, listener or incarnation.
export function attachResumeSocket(socket: Socket, options: Options): ResumeSocketOwner {
  const previous = owners.get(socket);
  if (previous) {
    if (previous.options !== options) throw Error("Socket already has a resume owner");
    return previous.owner;
  }
  const { store, bindings, prepare, onCleanupError } = options;
  const incarnation = randomUUID();
  let closed = false;
  let closing: Promise<void> | undefined;
  const admission = new ResumeAdmission(store, bindings, incarnation,
    () => !closed && socket.connected, prepare, {
      capacity: options.capacity ?? capacity, timeoutMs: options.timeoutMs ?? 10_000,
      onLateError: onCleanupError,
    });
  const close = () => {
    closed = true; // synchronous permanent fence, even if CAS/prepare never settles
    socket.off("disconnecting", onDisconnect);
    return closing ??= admission.close();
  };
  const onDisconnect = () => {
    void close().catch(error => {
      // close() retains the original rejected promise for an explicit await.
      try { onCleanupError(error); }
      catch (reportError) { console.error("Resume cleanup error reporter failed", reportError); }
    });
  };
  const owner = Object.freeze({ incarnation, admit: admission.admit.bind(admission), close });
  owners.set(socket, { options, owner });
  // Fence before Socket.IO removes rooms and emits its later disconnect event.
  socket.once("disconnecting", onDisconnect);
  if (!socket.connected) onDisconnect();
  return owner;
}
