import { MAX_RESUME_IMAGE_DATA_URL_LENGTH } from "./resume-image";

// PRIVATE admission primitive, not yet wired to a public handler. Session IDs
// come from the exact server-owned binding, never a request field. Process-local
// budgets do not provide distributed/account/IP abuse protection.
export class ResumeImageRate {
  private readonly windows = new Map<string, { until: number; attempts: number; bytes: number }>();
  private lastNow = -Infinity;

  constructor(private readonly attempts = 12, private readonly bytes = 48 * 1024 * 1024,
    private readonly durationMs = 60_000, private readonly capacity = 10_000,
    private readonly clock = () => performance.now()) {
    for (const value of [attempts, bytes, durationMs, capacity]) {
      if (!Number.isSafeInteger(value) || value < 1) throw Error("Invalid image rate policy");
    }
  }

  consume(sessionId: string, encodedBytes: number): boolean {
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
        !Number.isSafeInteger(encodedBytes) || encodedBytes < 1) return false;
    const observed = this.clock();
    if (!Number.isFinite(observed)) return false;
    const now = Math.max(observed, this.lastNow);
    if (!Number.isFinite(now + this.durationMs)) return false;
    this.lastNow = now;
    // Fixed insertion-ordered windows: no live-debt eviction or renewal on use.
    for (const [key, value] of this.windows) {
      if (value.until > now) break;
      this.windows.delete(key);
    }
    let window = this.windows.get(sessionId);
    if (!window) {
      if (this.windows.size >= this.capacity) return false;
      window = { until: now + this.durationMs, attempts: 0, bytes: 0 };
      this.windows.set(sessionId, window);
    }
    if (window.attempts >= this.attempts) return false;
    // A byte-denied attempt still consumes an attempt. Do not charge bytes
    // that were not admitted; subtraction avoids addition overflow.
    window.attempts++;
    if (encodedBytes > this.bytes - window.bytes) return false;
    window.bytes += encodedBytes;
    return true;
  }
}

const imageRate = new ResumeImageRate();

// Bound UTF-16 length BEFORE scanning bytes, base64 decoding or DB dispatch.
// Count actual UTF-8 bytes (including header), not decoded image size. Malformed
// bounded strings still cost quota if admitted; canonical validation follows.
// No refund for validation/DB denial, exact-key retry or uncertain COMMIT.
export function consumeResumeImageAttempt(sessionId: string, dataUrl: unknown): boolean {
  if (typeof dataUrl !== "string" || dataUrl.length < 1 ||
      dataUrl.length > MAX_RESUME_IMAGE_DATA_URL_LENGTH) return false;
  return imageRate.consume(sessionId, Buffer.byteLength(dataUrl, "utf8"));
}
