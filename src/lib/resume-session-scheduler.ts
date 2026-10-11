import type { SessionCleanupResult } from "./resume-session-cleanup";

type Timer = { unref(): unknown };
type Clock = { set(callback: () => void, delay: number): Timer; clear(timer: Timer): void };
const clock: Clock = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: timer => clearTimeout(timer as NodeJS.Timeout),
};
type Cleanup = { runOnce(): Promise<SessionCleanupResult>; stopAndSettle(): Promise<void> };
export type SessionMaintenanceReport = {
  completedRuns: number; failedRuns: number; sessions: number; receipts: number;
};

/** One bounded transaction per tick, with a nominal 1s timer AFTER settlement.
 * Failures back off to 60s. No interval, overlap, immediate backlog drain or
 * invented cancellation. Counts are rows, never a physical byte/WAL bound.
 */
export class ResumeSessionScheduler {
  private timer?: Timer;
  private active?: Promise<void>;
  private stopping?: Promise<SessionMaintenanceReport>;
  private started = false;
  private stopped = false;
  private failuresInARow = 0;
  private readonly report: SessionMaintenanceReport =
    { completedRuns: 0, failedRuns: 0, sessions: 0, receipts: 0 };

  constructor(private readonly cleanup: Cleanup, private readonly time: Clock = clock) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }
  snapshot(): SessionMaintenanceReport { return { ...this.report }; }

  private schedule(): void {
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failuresInARow, 6));
    this.timer = this.time.set(() => {
      this.timer = undefined;
      if (this.stopped || this.active) return;
      // Retain before calling user/driver code, including synchronous throws.
      this.active = Promise.resolve().then(() => this.cleanup.runOnce()).then(result => {
        this.report.completedRuns++;
        this.report.sessions += result.sessions;
        this.report.receipts += result.receipts;
        this.failuresInARow = 0;
      }, () => {
        this.report.failedRuns++;
        this.failuresInARow++;
      }).then(() => {
        this.active = undefined;
        this.schedule();
      });
    }, delay);
    this.timer.unref();
  }

  stopAndSettle(): Promise<SessionMaintenanceReport> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.timer) this.time.clear(this.timer);
    this.timer = undefined;
    // Wait for the retained run (including rollback/release), then close the
    // primitive. Transport/pool hangs remain pending, not "success by timeout".
    this.stopping = (async () => {
      await this.active;
      await this.cleanup.stopAndSettle();
      return this.snapshot();
    })();
    return this.stopping;
  }
}
