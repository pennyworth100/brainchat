import type { Socket } from "socket.io";
import type { ResumeBinding, ResumeBindings } from "./resume-bindings";
import { onResumeSocketClose, ownsResumeSocket, type ResumeSocketOwner } from "./resume-socket";

export type ResumeMembership = Readonly<{
  binding: ResumeBinding;
  isCurrent: () => boolean;
  release: () => boolean;
}>;
type Slot = { socket: Socket; lease: ResumeMembership };
export type ResumePresence = Readonly<{
  users: readonly Readonly<{ id: string; username: string }>[];
  count: number;
}>;
const outboundEvents = new Set(["room-info", "chat-history", "room-snapshot", "system-message",
  "user-count", "user-list", "chat-message", "chat-image", "chat-file"]);
export type ResumeOutboundEvent = "room-info" | "chat-history" | "room-snapshot" |
  "system-message" | "user-count" | "user-list" | "chat-message" | "chat-image" | "chat-file";

// PRIVATE logical membership and exact outbound boundary. No public room joins,
// onlineUsers or automatic presence/history. Install AFTER admission, never prepare.
// Share one registry alongside one ResumeBindings instance per server process.
export class ResumeMemberships {
  private readonly sessions = new Map<string, Slot>();
  private readonly sockets = new WeakMap<Socket, Slot>();
  constructor(private readonly bindings: ResumeBindings, private readonly capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid membership capacity");
  }

  // Fresh immutable logical-session projection. Data, not authorization:
  // recompute after async work. Ordering and IDs survive transport replacement.
  presence(roomId: string): ResumePresence {
    const users = [...this.sessions.values()]
      .filter(slot => slot.lease.binding.roomId === roomId && slot.lease.isCurrent())
      .map(({ lease: { binding } }) => Object.freeze({ id: binding.sessionId, username: binding.username }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return Object.freeze({ users: Object.freeze(users), count: users.length });
  }

  isCurrent(binding: ResumeBinding, roomId: string): boolean {
    const slot = this.sessions.get(binding.sessionId);
    return binding.roomId === roomId && slot?.lease.binding === binding && slot.lease.isCurrent();
  }

  privateCandidates(roomId: string, username: string): readonly ResumeBinding[] {
    return [...this.sessions.values()].filter(slot => slot.lease.binding.roomId === roomId &&
      slot.lease.binding.username === username && slot.lease.isCurrent()).map(slot => slot.lease.binding);
  }

  // Exact recipient only: never redirect an awaited send to a successor.
  async deliverPrivate(sender: ResumeBinding, recipient: ResumeBinding, payload: unknown,
    timeoutMs: number): Promise<unknown> {
    const candidates = this.privateCandidates(sender.roomId, recipient.username);
    const slot = this.sessions.get(recipient.sessionId);
    if (!this.isCurrent(sender, sender.roomId) || !this.isCurrent(recipient, sender.roomId) ||
        candidates.length !== 1 || candidates[0] !== recipient || slot?.lease.binding !== recipient) {
      throw Error("Private-message authority changed");
    }
    return slot.socket.timeout(timeoutMs).emitWithAck("private-message", payload);
  }

  // Server-owned physical lookup, never a binding reconstructed from headers.
  // This does not authenticate an HTTP caller who merely knows socket.id.
  bindingFor(socket: Socket, owner: ResumeSocketOwner, roomId: string): ResumeBinding | null {
    const binding = this.currentBindingFor(socket, owner);
    return binding?.roomId === roomId ? binding : null;
  }

  // Rate scope comes from physical authority even for wrong-room credentials.
  currentBindingFor(socket: Socket, owner: ResumeSocketOwner): ResumeBinding | null {
    const slot = this.sockets.get(socket);
    if (!ownsResumeSocket(socket, owner) || !slot ||
        slot.lease.binding.transportId !== owner.incarnation ||
        !this.isCurrent(slot.lease.binding, slot.lease.binding.roomId)) return null;
    return slot.lease.binding;
  }

  // PRIVATE outbound seam. Call AFTER all async reads/authorization, with inert
  // server-built data. Success means handed to Socket.IO, not received/ACKed.
  // An exact old binding must never redirect delayed history to its successor.
  send(binding: ResumeBinding, roomId: string, event: ResumeOutboundEvent, payload: unknown): boolean {
    const slot = this.sessions.get(binding.sessionId);
    if (!outboundEvents.has(event) || binding.roomId !== roomId ||
        slot?.lease.binding !== binding || !slot.lease.isCurrent()) return false;
    slot.socket.emit(event, payload);
    return true;
  }

  // Snapshot candidates, but revalidate each exact lease at its send boundary.
  // Reentrant close/replacement of another recipient cannot leak a later packet.
  // Do not use Socket.IO rooms: a physically connected stale socket may remain.
  broadcast(roomId: string, event: ResumeOutboundEvent, payload: unknown): number {
    const candidates = [...this.sessions.values()].map(slot => slot.lease.binding);
    let sent = 0;
    for (const binding of candidates) {
      if (this.send(binding, roomId, event, payload)) sent++;
    }
    return sent;
  }

  // Sender-originated fanout, never an arbitrary session-ID exclusion. Invalid
  // or copied senders fail closed. Reentrant sender loss stops remaining sends.
  broadcastExcept(sender: ResumeBinding, roomId: string, event: ResumeOutboundEvent, payload: unknown): number {
    if (!this.isCurrent(sender, roomId)) return 0;
    const candidates = [...this.sessions.values()].map(slot => slot.lease.binding);
    let sent = 0;
    for (const binding of candidates) {
      if (!this.isCurrent(sender, roomId)) break;
      if (binding !== sender && this.send(binding, roomId, event, payload)) sent++;
    }
    return sent;
  }

  install(socket: Socket, owner: ResumeSocketOwner, binding: ResumeBinding): ResumeMembership | null {
    if (!socket.connected || !ownsResumeSocket(socket, owner) || binding.transportId !== owner.incarnation ||
        !this.bindings.isCurrent(binding)) return null;
    const physical = this.sockets.get(socket);
    if (physical) return physical.lease.binding === binding && physical.lease.isCurrent()
      ? physical.lease : null;
    const previous = this.sessions.get(binding.sessionId);
    // Expired but connected sockets can outlive binding tombstones. Bound this
    // registry independently; never evict arbitrary members to admit more work.
    if (!previous && this.sessions.size >= this.capacity) return null;
    let released = false;
    let unsubscribe: (() => void) | null = null;
    const release = () => {
      if (released) return false;
      released = true;
      unsubscribe?.();
      socket.off("disconnecting", release);
      this.bindings.detach(binding); // exact binding; cannot detach a successor
      if (this.sockets.get(socket) === slot) this.sockets.delete(socket);
      if (this.sessions.get(binding.sessionId) !== slot) return false;
      this.sessions.delete(binding.sessionId);
      return true;
    };
    const lease: ResumeMembership = Object.freeze({ binding, release,
      isCurrent: () => !released && socket.connected &&
        this.sessions.get(binding.sessionId) === slot && this.bindings.isCurrent(binding),
    });
    const slot: Slot = { socket, lease };
    unsubscribe = onResumeSocketClose(socket, owner, release);
    if (!unsubscribe) return null;
    // Publish exact successor ownership before synchronous disconnect callbacks.
    this.sessions.set(binding.sessionId, slot);
    this.sockets.set(socket, slot);
    socket.once("disconnecting", release);
    try {
      if (previous) {
        previous.lease.release();
        // Real physical eviction, including all Socket.IO rooms/namespaces.
        previous.socket.disconnect(true);
      }
      // A disconnect callback can reenter, close or supersede this candidate.
      if (!lease.isCurrent()) { release(); return null; }
      return lease;
    } catch (error) {
      release(); // never restore old authority after partial eviction
      throw error;
    }
  }
}
