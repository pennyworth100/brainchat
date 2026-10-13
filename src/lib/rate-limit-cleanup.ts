const INTERVAL_MS = 300_000;
const EXPIRY_GRACE_MS = 3_600_000;

type Timer = { unref(): unknown };
type Clock = {
  now(): number;
  set(callback: () => void, delay: number): Timer;
  clear(timer: Timer): void;
};
const clock: Clock = {
  now: Date.now,
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

/** Owns only expiry DELETEs; stopping this is NOT a server-wide writer fence. */
export class RateLimitCleanup {
  private timer?: Timer;
  private active?: Promise<void>;
  private stopped = false;
  private completedRuns = 0;
  private failedRuns = 0;

  constructor(
    private readonly database: {
      query(text: string, values: number[]): PromiseLike<unknown>;
    },
    private readonly time: Clock = clock,
  ) {
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = this.time.set(() => {
      this.timer = undefined;
      // Register before calling the driver, including synchronous failure/reentry.
      this.active = Promise.resolve().then(() => this.database.query(
        'DELETE FROM "rate_limits" WHERE expire < $1',
        [this.time.now() - EXPIRY_GRACE_MS],
      )).then(
        () => { this.completedRuns++; },
        () => { this.failedRuns++; },
      ).then(() => {
        this.active = undefined;
        this.schedule();
      });
    }, INTERVAL_MS);
    this.timer.unref();
  }

  /** Permanently close this producer and wait for actual driver settlement.
   * A hung query keeps this pending. No timeout is represented as cancellation.
   * failedRuns is cumulative: a later successful cleanup does not erase failure.
   */
  async stopAndSettle(): Promise<{ completedRuns: number; failedRuns: number }> {
    this.stopped = true;
    if (this.timer) this.time.clear(this.timer);
    this.timer = undefined;
    await this.active;
    return { completedRuns: this.completedRuns, failedRuns: this.failedRuns };
  }
}
