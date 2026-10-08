/** Optional second event argument keeps the legacy string-only client compatible. */
export interface JoinErrorDetails {
  code: "RATE_LIMITED" | "SERVER_ERROR";
  retryAfterMs?: number;
}

export function transientJoinDelay(message: string, details?: JoinErrorDetails): number | null {
  if (details?.code === "RATE_LIMITED" || (!details && message === "Too many attempts. Try again later.")) {
    const delay = details?.retryAfterMs;
    return typeof delay === "number" && Number.isFinite(delay) && delay >= 0
      ? Math.min(2_147_000_000, Math.max(1000, delay)) : 60_000;
  }
  if (details?.code === "SERVER_ERROR" || (!details && message === "Server error")) return 1000;
  return null; // Unknown errors fail closed, including all authorization failures.
}
