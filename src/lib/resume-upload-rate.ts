import { ResumeImageRate } from "./resume-image-rate";

// Fixed-window attempt budgets, not concurrency/byte/disk reservations. Reuse
// the bounded monotonic primitive; one byte stands for one charged attempt.
// No client-provided key, live-debt eviction, refund, or per-wrapper instance.
export class ResumeUploadRate {
  private readonly aggregate: ResumeImageRate;
  private readonly sessions: ResumeImageRate;
  constructor(perSession = 60, aggregate = 1200, durationMs = 60_000,
    capacity = 10_000, clock = () => performance.now()) {
    this.aggregate = new ResumeImageRate(aggregate, aggregate, durationMs, 1, clock);
    this.sessions = new ResumeImageRate(perSession, perSession, durationMs, capacity, clock);
  }
  consumeAggregate(): boolean { return this.aggregate.consume("all", 1); }
  // Caller must derive this ID from exact current physical ownership.
  consumeSession(sessionId: string): boolean { return this.sessions.consume(sessionId, 1); }
}

// Process lifetime, shared across HTTP requests, wrappers and owner generations.
// Not distributed/IP protection; restart clears debt. Never expose a reset hook.
export const resumeUploadRate = new ResumeUploadRate();
