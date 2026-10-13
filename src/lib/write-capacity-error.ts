/** A capacity signal is NOT proof that an earlier attempt did not commit.
 * Follow only bounded driver/wrapper causes; never parse SQL or error text.
 * No Retry-After: append-only budgets do not recover merely with time.
 */
export function isWriteCapacityError(error: unknown): boolean {
  const seen = new Set<object>();
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    if (seen.has(error)) return false;
    seen.add(error);
    const candidate = error as { code?: unknown; cause?: unknown };
    if (candidate.code === "53100") return true;
    error = candidate.cause;
  }
  return false;
}

export function writeCapacityReply() {
  return {
    code: "WRITE_CAPACITY_EXHAUSTED",
    error: "Message storage capacity is exhausted. Check room history before retrying; do not retry automatically.",
    outcome: "unknown",
    autoRetry: false,
  } as const;
}
