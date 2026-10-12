import type { ChatMessage } from "./room-session";
import { canonicalBrowserInline } from "./browser-inline-receipt";

export type SnapshotRequest = Readonly<{ roomId: string; sessionId: string; generation: number; requestId: string }>;
type Row = Readonly<ChatMessage & { sha256?: string }>;
export type SnapshotCompletion = Readonly<{ history: readonly Row[]; users: readonly string[];
  window: "newest-100-id-ascending" }>;
type Limits = { liveCount?: number; liveBytes?: number; snapshotBytes?: number; timeoutMs?: number };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid snapshot object");
  return value as Record<string, unknown>;
};
const username = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 64;
export const validateBrowserSnapshotRow = (value: unknown): Row => {
  const v = object(value);
  if (!Number.isSafeInteger(v.id) || (v.id as number) < 1 || !username(v.username) ||
      !Number.isSafeInteger(v.ts) || (v.ts as number) < 0 || (v.ts as number) > 8_640_000_000_000_000) {
    throw Error("Invalid snapshot message metadata");
  }
  const base = { id: v.id as number, username: v.username, ts: v.ts as number };
  if (v.type === "message") return Object.freeze({ ...base, type: "message",
    message: canonicalBrowserInline("message", v.message as string) });
  if (v.type === "image") return Object.freeze({ ...base, type: "image",
    dataUrl: canonicalBrowserInline("image", v.dataUrl as string) });
  if (v.type !== "file" || typeof v.url !== "string" || v.url.length > 512 ||
      !/^\/uploads\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+|\.[A-Za-z0-9]+)?$/.test(v.url) ||
      typeof v.name !== "string" || !v.name.trim() || v.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(v.name) ||
      !Number.isSafeInteger(v.size) || (v.size as number) < 0 || (v.size as number) > 100 * 1024 * 1024 ||
      typeof v.mime !== "string" || v.mime.length > 127 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v.mime) ||
      (v.sha256 !== undefined && (typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256)))) {
    throw Error("Invalid snapshot file metadata");
  }
  return Object.freeze({ ...base, type: "file", url: v.url, name: v.name, size: v.size as number, mime: v.mime,
    ...(v.sha256 === undefined ? {} : { sha256: v.sha256 as string }) });
};
const row = validateBrowserSnapshotRow;
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** PRIVATE, request-local validation, not authentication or a gap-free cut.
 * Install live buffering BEFORE sending request. Full newest-100 window, never
 * an ID commit watermark. Pending operation payloads belong to the caller and
 * are never settled/removed by this projection. Memory-only; no public wiring.
 */
export function createBrowserSnapshotWindow(request: SnapshotRequest, now = Date.now, limits: Limits = {}) {
  const liveCount = limits.liveCount ?? 100, liveBytes = limits.liveBytes ?? 16 * 1024 * 1024;
  const snapshotBytes = limits.snapshotBytes ?? 32 * 1024 * 1024, timeout = limits.timeoutMs ?? 10_000;
  for (const n of [liveCount, liveBytes, snapshotBytes, timeout]) {
    if (!Number.isSafeInteger(n) || n < 1) throw Error("Invalid snapshot limit");
  }
  const deadline = now() + timeout;
  const captured = Object.freeze({ ...request });
  const buffered = new Map<number, Row>();
  let count = 0, bytes = 0, failed = false, consumed = false;
  let completion: SnapshotCompletion | null = null;
  const cancel = () => { failed = true; completion = null; buffered.clear(); };
  const guard = () => {
    if (failed || consumed || now() >= deadline) { cancel(); throw Error("Snapshot closed or expired"); }
  };
  const merge = (target: Map<number, Row>, message: Row) => {
    const old = target.get(message.id);
    if (old && JSON.stringify(old) !== JSON.stringify(message)) throw Error("Conflicting snapshot message ID");
    target.set(message.id, message);
  };
  const api = Object.freeze({ request: captured,
    receiveLive(value: unknown) {
      guard();
      try {
        if (completion) throw Error("Snapshot already validated");
        const message = row(value);
        count++; bytes += encoded(message);
        if (count > liveCount || bytes > liveBytes) throw Error("Snapshot live buffer overflow");
        merge(buffered, message);
      } catch (error) { cancel(); throw error; }
    },
    accept(value: unknown): SnapshotCompletion {
      guard();
      try {
        if (completion) throw Error("Snapshot completion replay");
        const v = object(value);
        if (v.requestId !== captured.requestId || v.sessionId !== captured.sessionId ||
            v.roomId !== captured.roomId || v.generation !== captured.generation ||
            v.window !== "newest-100-id-ascending" || !Array.isArray(v.history) || v.history.length > 100 ||
            !Array.isArray(v.users) || v.users.length > 1000 || !v.users.every(username)) {
          throw Error("Invalid snapshot completion");
        }
        const merged = new Map<number, Row>();
        let previous = 0, total = encoded(v.users);
        for (const item of v.history) {
          const message = row(item);
          if (message.id <= previous) throw Error("Snapshot window must be ascending unique IDs");
          previous = message.id; total += encoded(message);
          if (total > snapshotBytes) throw Error("Snapshot byte overflow");
          merge(merged, message);
        }
        if (total > snapshotBytes) throw Error("Snapshot byte overflow");
        for (const message of buffered.values()) merge(merged, message);
        completion = Object.freeze({ window: "newest-100-id-ascending",
          history: Object.freeze([...merged.values()].sort((a, b) => a.id - b.id)),
          users: Object.freeze([...new Set(v.users as string[])]) });
        return completion;
      } catch (error) { cancel(); throw error; }
    },
  });
  return { api, cancel, consume(value: unknown): SnapshotCompletion {
    guard();
    if (!completion || value !== completion) { cancel(); throw Error("Unvalidated snapshot completion"); }
    consumed = true; buffered.clear();
    const result = completion; completion = null;
    return result;
  } };
}
