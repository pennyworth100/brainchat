import type { EventEmitter } from "node:events";

/** One initialized process only. Never a platform/DB/filesystem recovery fence.
 * No timeout, forced exit, retry or claim that a failed write rolled back.
 * The platform may still kill a stuck process; that remains an unknown outcome.
 */
export function installProcessShutdown(
  signals: Pick<EventEmitter, "on" | "removeListener">,
  shutdown: () => Promise<unknown>,
  report: (event: "started" | "settled" | "failed", detail?: unknown) => void,
): () => void {
  let started = false;
  const stop = () => {
    if (started) return;
    started = true;
    report("started");
    // Invoke synchronously: close admission before returning from SIGTERM.
    let work: Promise<unknown>;
    try { work = shutdown(); } catch (error) { work = Promise.reject(error); }
    void work.then(result => report("settled", result), error => report("failed", error));
  };
  signals.on("SIGTERM", stop);
  return () => signals.removeListener("SIGTERM", stop);
}
