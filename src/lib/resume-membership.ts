import type { Socket } from "socket.io";
import type { ResumeBinding, ResumeBindings } from "./resume-bindings";
import { onResumeSocketClose, ownsResumeSocket, type ResumeSocketOwner } from "./resume-socket";

export type ResumeMembership = Readonly<{
  binding: ResumeBinding;
  isCurrent: () => boolean;
  release: () => boolean;
}>;
type Slot = { socket: Socket; lease: ResumeMembership };

// PRIVATE logical membership only. No Socket.IO room joins, onlineUsers,
// history, presence or broadcast access. Install AFTER admission, never prepare.
// Share one registry alongside one ResumeBindings instance per server process.
export class ResumeMemberships {
  private readonly sessions = new Map<string, Slot>();
  private readonly sockets = new WeakMap<Socket, Slot>();
  constructor(private readonly bindings: ResumeBindings, private readonly capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid membership capacity");
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
