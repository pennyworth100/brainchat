import type { ChatMessage, RoomSession } from "./room-session";

export const MAX_FILE_SIZE = 100 * 1024 * 1024;

export async function uploadRoomFile(
  file: File,
  roomId: string,
  session: Pick<RoomSession, "sync" | "reconnect">,
  request: typeof fetch = fetch
): Promise<{ message: ChatMessage }> {
  if (file.size > MAX_FILE_SIZE) throw new Error("File is too large (maximum 100 MB).");
  let socketId = await session.sync();
  // Only retry a rejected authentication request: it cannot have saved a file.
  // Never retry ambiguous network failures, which might already be committed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await request("/api/upload", {
        method: "POST",
        headers: { "x-room-id": roomId, "x-socket-id": socketId },
        body: form,
        signal: controller.signal,
      });
      if (response.status === 401 && attempt === 0) {
        socketId = await session.reconnect();
        continue;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = response.status === 413 ? "File is too large (maximum 100 MB)."
          : response.status === 429 ? "Too many uploads. Please try again later."
          : `Upload rejected (HTTP ${response.status}).`;
        throw new Error(typeof data.error === "string" ? data.error : fallback);
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
