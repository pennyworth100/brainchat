// Server-owned, process-local attempt budget. NOT distributed abuse protection.
// A stable durable session ID survives reconnect/generation changes; usernames,
// sockets and clientMessageId are deliberately not rate identities.
export class ResumeTextRate {
  private readonly windows = new Map<string, { until: number; used: number }>();
  private lastNow = -Infinity;
  constructor(private readonly points = 120, private readonly durationMs = 60_000,
    private readonly capacity = 10_000, private readonly clock = () => performance.now()) {
    for (const value of [points, durationMs, capacity]) {
      if (!Number.isSafeInteger(value) || value < 1) throw Error("Invalid text rate policy");
    }
  }

  consume(sessionId: string): boolean {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return false;
    const observed = this.clock();
    if (!Number.isFinite(observed)) return false;
    // Never forgive debt on a backwards clock. Production uses monotonic time.
    const now = Math.max(observed, this.lastNow);
    this.lastNow = now;
    // Fixed windows are insertion ordered. Existing windows are never renewed
    // or moved; pruning is amortized, bounded, and needs no per-session timers.
    for (const [key, value] of this.windows) {
      if (value.until > now) break;
      this.windows.delete(key);
    }
    const existing = this.windows.get(sessionId);
    if (existing) {
      if (existing.used >= this.points) return false;
      existing.used++;
      return true;
    }
    // No eviction of live debt to admit an attacker-controlled new session.
    if (this.windows.size >= this.capacity) return false;
    this.windows.set(sessionId, { until: now + this.durationMs, used: 1 });
    return true;
  }
}

// One instance across all callers; no per-wrapper/reset/injected-policy escape.
const textRate = new ResumeTextRate();
export function consumeResumeTextAttempt(sessionId: string): boolean {
  return textRate.consume(sessionId);
}
