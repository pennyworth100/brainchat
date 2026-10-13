import type { ResumeIdentity } from "./resume-store";

export type ResumeBinding = Readonly<{
  sessionId: string; roomId: string; username: string; authVersion: number;
  generation: number; transportId: string; expiresAt: number;
}>;
type Slot = { binding: ResumeBinding; active: boolean; cancelled: boolean };

// Single-process fencing primitive, shared by public normal join and sync.
// Only pass identities returned by an authenticated DB CAS, never client data.
// This is not DB authorization, a distributed lock, or an async operation guard.
// Future protected handlers must combine it with transactional DB validation;
// checking isCurrent before an await does NOT protect a later side effect.
export class ResumeBindings {
  private readonly slots = new Map<string, Slot>();
  private readonly transports = new Map<string, Slot>();

  private releaseTransport(slot: Slot) {
    if (this.transports.get(slot.binding.transportId) === slot) {
      this.transports.delete(slot.binding.transportId);
    }
  }
  constructor(private readonly capacity = 10_000, private readonly now = Date.now) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid binding capacity");
  }

  // Tombstones retain the generation high-water mark until absolute DB expiry.
  // No eviction of unexpired sessions: overload rejects instead of enabling replay.
  sweep() {
    for (const [id, slot] of this.slots) {
      if (slot.binding.expiresAt <= this.now()) {
        this.releaseTransport(slot);
        this.slots.delete(id);
      }
    }
  }

  async activate(identity: ResumeIdentity, transportId: string,
    prepare: () => Promise<void>, connected: () => boolean): Promise<ResumeBinding | null> {
    const expiresAt = identity.expiresAt.getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() ||
        !Number.isInteger(identity.generation) || identity.generation < 0 ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(transportId)) return null;
    this.sweep();
    // Reserve a server-owned transport for only one pending/active session.
    // A conflict must not fence either session or run preparation.
    const owner = this.transports.get(transportId);
    if (owner && owner.binding.sessionId !== identity.sessionId) return null;
    const previous = this.slots.get(identity.sessionId);
    if (previous) {
      const b = previous.binding;
      // Session policy, room and lifetime are immutable across generations.
      if (b.roomId !== identity.roomId || b.username !== identity.username ||
          b.authVersion !== identity.authVersion || b.expiresAt !== expiresAt ||
          identity.generation < b.generation) return null;
      if (identity.generation === b.generation) {
        if (b.transportId !== transportId || !previous.active || previous.cancelled) return null;
        // Exact active ACK retry: no second prepare or membership installation.
        try {
          if (connected() && this.isCurrent(b)) return b;
        } catch { /* an uncertain transport is never active */ }
        this.detach(b);
        return null;
      }
    } else if (this.slots.size >= this.capacity) return null;

    const binding: ResumeBinding = Object.freeze({
      sessionId: identity.sessionId, roomId: identity.roomId, username: identity.username,
      authVersion: identity.authVersion, generation: identity.generation, transportId, expiresAt,
    });
    const candidate: Slot = { binding, active: false, cancelled: false };
    // Fence old authority BEFORE async preparation. Never roll back the generation
    // on failure. prepare must not publish data or grant privileges; transport
    // membership alone is insufficient. Caller cleans up failed/stale preparation.
    if (previous) this.releaseTransport(previous);
    this.slots.set(binding.sessionId, candidate);
    this.transports.set(transportId, candidate);
    try {
      await prepare();
      if (this.slots.get(binding.sessionId) !== candidate || candidate.cancelled ||
          binding.expiresAt <= this.now() || !connected()) return null;
      candidate.active = true;
      return binding;
    } finally {
      if (!candidate.active) {
        candidate.cancelled = true;
        this.releaseTransport(candidate);
      }
    }
  }

  isCurrent(binding: ResumeBinding): boolean {
    const slot = this.slots.get(binding.sessionId);
    return !!slot && slot.binding === binding && this.transports.get(binding.transportId) === slot &&
      slot.active && !slot.cancelled &&
      binding.expiresAt > this.now();
  }

  // PRIVATE upload admission only. Capture while live; ordinary disconnect may
  // outlive HTTP admission, but even a pending/failed successor fences it.
  // This predicate is NOT database authorization or permission to publish.
  captureUploadGeneration(binding: ResumeBinding): (() => boolean) | null {
    if (!this.isCurrent(binding)) return null;
    return () => this.slots.get(binding.sessionId)?.binding === binding &&
      binding.expiresAt > this.now();
  }

  // Exact object identity prevents copied/client-built bindings from authorizing.
  // A delayed disconnect from an old socket cannot remove its successor.
  detach(binding: ResumeBinding): boolean {
    const slot = this.slots.get(binding.sessionId);
    if (!slot || slot.binding !== binding) return false;
    slot.active = false;
    slot.cancelled = true;
    this.releaseTransport(slot);
    return true;
  }

  // Server-owned unique transport incarnation; also cancels pending preparation.
  disconnect(sessionId: string, transportId: string): boolean {
    const slot = this.slots.get(sessionId);
    if (!slot || slot.binding.transportId !== transportId) return false;
    return this.detach(slot.binding);
  }
}
