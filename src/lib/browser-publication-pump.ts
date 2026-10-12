/** Private, single-flight reconciliation lifetime. Cancellation never implies
 * that an outstanding SQL/network operation has settled. No retry after failure. */
export type PublicationClock = {
  now(): number;
  schedule(callback: () => void, delay: number): unknown;
  cancel(handle: unknown): void;
};
const systemClock: PublicationClock = {
  now: Date.now,
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export function createBrowserPublicationPump(options: {
  expiresAt: number;
  poll(signal: AbortSignal): Promise<boolean>;
  synchronized(): void;
  failed(): void;
  clock?: PublicationClock;
}) {
  const clock = options.clock ?? systemClock;
  const cadence = 1000, deadline = 4000;
  if (!Number.isFinite(options.expiresAt)) throw Error("Invalid publication expiry");
  let closed = false, flight = false, timer: unknown;
  let due = Math.min(clock.now() + deadline, options.expiresAt);
  const abort = new AbortController();
  const cancel = () => {
    if (closed) return;
    closed = true; clock.cancel(timer); abort.abort();
  };
  const fail = () => { if (!closed) { cancel(); options.failed(); } };
  const live = () => {
    if (!closed && (clock.now() >= options.expiresAt || clock.now() >= due)) fail();
    return !closed;
  };
  const run = async () => {
    if (!live()) return;
    if (flight) { fail(); return; }
    flight = true;
    due = Math.min(clock.now() + deadline, options.expiresAt);
    timer = clock.schedule(fail, Math.max(0, due - clock.now()));
    try {
      const settled = await options.poll(abort.signal);
      if (!live()) return;
      if (!settled) { fail(); return; }
      options.synchronized();
      if (!live()) return;
      clock.cancel(timer);
      due = Math.min(clock.now() + cadence + deadline, options.expiresAt);
      timer = clock.schedule(() => { void run(); }, Math.min(cadence, options.expiresAt - clock.now()));
    } catch { fail(); }
    finally { flight = false; }
  };
  // The owner installs the lifetime before any callback or transport effect.
  timer = clock.schedule(() => { void run(); }, 0);
  return Object.freeze({ cancel, live });
}
