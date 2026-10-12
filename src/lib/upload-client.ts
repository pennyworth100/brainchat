import type { ChatMessage, RoomSession } from "./room-session";
import { uploadAuthorityHeaders } from "./upload-authority";

export const MAX_FILE_SIZE = 100 * 1024 * 1024;

export async function uploadRoomFile(
  file: File,
  roomId: string,
  session: Pick<RoomSession, "sync" | "reconnect" | "uploadAuthority">,
  request: typeof fetch = fetch
): Promise<{ message: ChatMessage }> {
  if (file.size > MAX_FILE_SIZE) throw new Error("File is too large (maximum 100 MB).");
  let socketId = await session.sync();
  const clientMessageId = crypto.randomUUID();
  let authority = session.uploadAuthority(roomId, socketId);
  // Snapshot the mode before any request. A later legacy grant can never
  // downgrade an attempt that began with bearer authority.
  const strict = authority?.kind === "resume";
  // Retry only an explicit server pre-body authentication rejection.
  // Never retry ambiguous network failures, which might already be committed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = uploadAuthorityHeaders(authority, roomId, socketId, clientMessageId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await request("/api/upload", {
        method: "POST",
        headers,
        body: form,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      const body = data && typeof data === "object" ? data : {};
      if (body.code === "UPLOAD_OUTCOME_UNKNOWN") {
        throw new Error("Attachment status is unknown. Check room history before uploading again.");
      }
      if (!strict && response.status === 401 && body.code === "UPLOAD_AUTH_REQUIRED" && attempt === 0) {
        socketId = await session.reconnect();
        authority = session.uploadAuthority(roomId, socketId);
        // A mode change is a new operation, not an implicit credential upgrade.
        if (authority?.kind !== "legacy") throw Error("Upload authority changed. Please retry explicitly.");
        continue;
      }
      if (!response.ok) {
        const fallback = response.status === 413 ? "File is too large (maximum 100 MB)."
          : response.status === 429 ? "Too many uploads. Please try again later."
          : `Upload rejected (HTTP ${response.status}).`;
        throw new Error(typeof body.error === "string" ? body.error : fallback);
      }
      if (strict) {
        const saved = body.message as ChatMessage | undefined;
        if (body.clientMessageId !== clientMessageId || !saved ||
            !Number.isSafeInteger(saved.id) || saved.id <= 0 || saved.type !== "file" ||
            typeof saved.username !== "string" || !Number.isFinite(saved.ts) ||
            saved.name !== file.name || saved.size !== file.size ||
            saved.mime !== (file.type || "application/octet-stream") ||
            typeof saved.url !== "string" || !/^\/uploads\/[a-f0-9]{64}\/blob$/.test(saved.url)) {
          throw Error("Upload receipt could not be verified. Check room history before uploading again.");
        }
      }
      return data;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("Upload timed out. Check the chat before retrying.");
      }
      if (err instanceof TypeError) throw new Error("Network interrupted. Check the chat before retrying.");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Please rejoin the room before uploading.");
}
