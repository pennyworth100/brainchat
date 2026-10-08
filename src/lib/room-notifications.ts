import type { ChatMessage } from "./room-session";

export function shouldNotifyRoomMessage(
  message: ChatMessage,
  currentUsername: string | null,
  visibilityState: DocumentVisibilityState,
) {
  return visibilityState !== "visible" && Boolean(currentUsername) && message.username !== currentUsername;
}

export function roomDocumentTitle(roomId: string, unreadCount: number) {
  const base = `Dimle · ${roomId}`;
  return unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
}

export function roomNotificationBody(message: ChatMessage) {
  const content = message.type === "message"
    ? message.message || "New message"
    : message.type === "image"
      ? "Sent an image"
      : `Sent a file${message.name ? `: ${message.name}` : ""}`;
  return content.length > 160 ? `${content.slice(0, 159)}…` : content;
}
